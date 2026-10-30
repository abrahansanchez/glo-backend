import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import mongoose from 'mongoose';
import express from 'express';
import twilio from 'twilio';
import Registration from '../../models/RetellCallRegistration.js';
import Budget from '../../models/RetellSandboxBudget.js';
import { installRetellSandbox } from '../../services/voice/retell/installSandbox.js';
import { createRetellSandboxBudgetRepository } from '../../services/voice/retell/SandboxBudgetRepository.js';
import { createRetellSandboxHandoff } from '../../services/voice/retell/SandboxHandoff.js';
import { observeSandboxIncoming, handleSandboxFallback, handleSandboxWebhook } from '../../services/voice/retell/SandboxPhoneHooks.js';

const binary = join(homedir(), '.cache', 'mongodb-binaries', 'mongod-x64-win32-8.0.32.exe');
const database = { skip: !existsSync(binary), timeout: 20000 };
const businessId = '507f1f77bcf86cd799439011', otherId = '507f1f77bcf86cd799439012';
const secret = 'SYNTHETIC_ONLY', origin = 'https://synthetic.invalid';
let connection, child, exited, RegistrationModel, BudgetModel, sequence = 0;
before(async () => {
  if (!existsSync(binary)) return;
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const dbpath = await mkdtemp(join(tmpdir(), 'glo-retell-sandbox-'));
  child = spawn(binary, ['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dbpath,'--quiet'], { windowsHide: true, stdio: 'ignore' });
  exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  connection = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/retell_sandbox_offline`, { serverSelectionTimeoutMS: 15000, autoIndex: false }).asPromise();
  RegistrationModel = connection.model('RetellCallRegistration', Registration.schema);
  BudgetModel = connection.model('RetellSandboxBudget', Budget.schema);
});
after(async () => { await connection?.close(); if (child) { child.kill(); await exited; } });
function fixture(overrides = {}) {
  const n = ++sequence, parent = `CA${n.toString(16).padStart(32, '0')}`;
  const childSid = `CA${(n + 10000).toString(16).padStart(32, '0')}`;
  let time = Date.parse('2026-10-30T14:00:00Z');
  const app = express(), requests = [], effects = [];
  const options = { enabled: true, executionEnabled: true, businessId, budgetId: `sandbox_${n.toString().padStart(8, '0')}`,
    RegistrationModel, BudgetModel, now: () => new Date(time), signingKey: secret,
    agentsByBusiness: { [businessId]: { agentId: 'agent_synthetic', agentVersion: 1, language: 'en' } },
    twilioAuth: { authToken: secret, appBaseUrl: origin },
    resolveBusiness: async to => ({ businessId: to === '+15550000002' ? otherId : businessId }),
    provider: { registerPhoneCall: async p => {
      requests.push(p);
      const row = await RegistrationModel.findById(parent).lean(); assert.equal(row.status, 'REGISTERING');
      return { call_id: `call_${n}`, agent_id: p.agent_id, agent_version: p.agent_version, call_status: 'registered' };
    } },
    models: { BarberModel: {}, AppointmentModel: { create: () => effects.push('BOOKING') } }, ...overrides };
  const installed = installRetellSandbox(app, options);
  const req = (path, body) => ({ originalUrl: path, body,
    headers: { 'x-twilio-signature': twilio.getExpectedTwilioSignature(secret, `${origin}${path}`, body) } });
  const incoming = () => installed.handoff.observeIncoming(req('/api/voice/incoming', { CallSid: parent, To: '+15550000001' }), businessId);
  const fallback = (status = 'no-answer', to = '+15550000001') => installed.handoff.fallback(req('/api/voice/dial-fallback', { CallSid: parent, To: to, DialCallStatus: status }));
  const webhook = (kind, edit = {}) => installed.handoff.webhook(req(`/api/voice/retell-sandbox/${kind}`,
    kind === 'complete' ? { CallSid: parent, DialCallStatus: 'completed', ...edit }
      : { ParentCallSid: parent, CallSid: childSid, CallStatus: 'in-progress', ...edit }), kind);
  const start = async () => installed.lifecycle.handleEvent({ event: 'call_started', call: { call_id: `call_${n}`,
    agent_id: 'agent_synthetic', call_status: 'ongoing', metadata: requests[0].metadata } });
  return { ...installed, app, parent, childSid, requests, effects, options, req, incoming, fallback, webhook, start,
    advance: ms => { time += ms; }, now: () => new Date(time), providerId: `call_${n}` };
}

test('default/partial enablement does not construct repositories or alter app routing', () => {
  for (const config of [{}, { enabled: true }, { executionEnabled: true }]) {
    const app = express(); const r = installRetellSandbox(app, config);
    assert.equal(r.enabled, false); assert.equal(app.locals.retellSandbox, undefined);
  }
});
test('source hooks preserve mobile dial and stop before legacy AI; takeover is not enabled', async () => {
  const source = await readFile(new URL('../../controllers/callController.js', import.meta.url), 'utf8');
  assert.ok(source.indexOf('await observeSandboxIncoming(req, barberId)') < source.indexOf('dial.client(barberId)'));
  const fallback = source.slice(source.indexOf('export const handleDialFallback'));
  assert.ok(fallback.indexOf('handleSandboxFallback(req, res)') < fallback.indexOf('getAiStreamTwimlString'));
  assert.match(source, /RETELL_SANDBOX_TAKEOVER_DISABLED/);
  const server = await readFile(new URL('../../server.js', import.meta.url), 'utf8');
  assert.ok(!server.includes('installRetellSandbox('));
});
test('actual Mongo bind-before-bridge; documented timeLimit/timeout/screening; no pre-screen authority', database, async () => {
  const f = fixture(); await f.incoming(); const r = await f.fallback();
  assert.equal(f.requests.length, 1); assert.match(r.twiml, /timeLimit="120"/); assert.match(r.twiml, /timeout="20"/);
  assert.match(r.twiml, /sip:call_\d+@sip.retellai.com/); assert.match(r.twiml, /retell-sandbox\/screen/);
  const row = await f.repository.findByParentCallId(f.parent); assert.equal(row.providerCallId, f.providerId); assert.ok(row.bridgeReservedAt);
  await f.start(); assert.equal(await f.repository.findByProviderCallId(f.providerId), null);
  assert.ok(!(await f.webhook('screen')).twiml.includes('Hangup'));
  assert.ok(await f.repository.findByProviderCallId(f.providerId)); assert.deepEqual(f.effects, []);
});
test('human answer revokes observation without consuming registration budget', database, async () => {
  const f = fixture(); await f.incoming(); const r = await f.fallback('completed');
  assert.match(r.twiml, /Hangup/); assert.equal(f.requests.length, 0);
  assert.equal(await f.budgets.find(f.options.budgetId), null);
  assert.equal((await f.repository.findByParentCallId(f.parent)).status, 'SUPERSEDED');
});
test('non-allowlisted signed call retains existing route and consumes nothing', database, async () => {
  const f = fixture(); assert.equal(await f.fallback('no-answer', '+15550000002'), null);
  assert.equal(f.requests.length, 0); assert.equal(await f.budgets.find(f.options.budgetId), null);
});
test('duplicate/concurrent fallback uses actual Mongo budget once and returns SIP only once', database, async () => {
  const f = fixture(); await f.incoming(); const results = await Promise.all(Array.from({ length: 12 }, () => f.fallback()));
  assert.equal(f.requests.length, 1); assert.equal(results.filter(r => r.twiml.includes('<Sip')).length, 1);
  const restarted = createRetellSandboxBudgetRepository({ Model: BudgetModel });
  const b = await restarted.find(f.options.budgetId); assert.equal(b.status, 'BRIDGE_RESERVED');
  assert.equal(await restarted.claim({ ...b, parentCallSid: `CA${'f'.repeat(32)}` }), null);
  const nextApp = express(); const next = installRetellSandbox(nextApp, f.options);
  assert.ok(!(await next.handoff.fallback(f.req('/api/voice/dial-fallback', { CallSid: f.parent, To: '+15550000001', DialCallStatus: 'no-answer' }))).twiml.includes('<Sip'));
  assert.equal(f.requests.length, 1);
});
test('two different parent calls cannot consume the same experiment budget', database, async () => {
  const f = fixture(); await f.incoming(); await f.fallback();
  const g = fixture({ budgetId: f.options.budgetId }); await g.incoming(); const r = await g.fallback();
  assert.ok(!r.twiml.includes('<Sip')); assert.equal(g.requests.length, 0);
});
test('direct lifecycle registration cannot bypass the experiment budget at provider dispatch', database, async () => {
  const f = fixture(); await f.incoming();
  const result = await f.lifecycle.register({ parentCallSid: f.parent, ownerEpoch: 1 });
  assert.equal(result.registered, false); assert.equal(f.requests.length, 0);
  assert.equal(await f.budgets.find(f.options.budgetId), null);
});
for (const mode of ['expired','superseded','bad signature','missing observation']) test(`${mode} cannot bridge`, database, async () => {
  const f = fixture(); if (mode !== 'missing observation') await f.incoming();
  if (mode === 'expired') f.advance(600001);
  if (mode === 'superseded') await f.lifecycle.supersede({ parentCallSid: f.parent, ownerEpoch: 1 });
  const r = mode === 'bad signature' ? await f.handoff.fallback({ originalUrl: '/api/voice/dial-fallback', headers: {}, body: { CallSid: f.parent, To: '+15550000001', DialCallStatus: 'no-answer' } }) : await f.fallback();
  assert.ok(!r.twiml.includes('<Sip')); assert.equal(f.requests.length, 0);
});
test('supersession during registration cannot expose a SIP bridge', database, async () => {
  const f = fixture(); await f.incoming();
  const original = f.options.provider.registerPhoneCall;
  f.options.provider.registerPhoneCall = async p => { const r = await original(p); await f.lifecycle.supersede({ parentCallSid: f.parent, ownerEpoch: 1 }); return r; };
  const r = await f.fallback(); assert.ok(!r.twiml.includes('<Sip')); assert.equal(f.requests.length, 1);
});
test('provider failure consumes budget permanently, never falls through or retries', database, async () => {
  const f = fixture(); await f.incoming();
  f.options.provider.registerPhoneCall = async () => { f.requests.push('ATTEMPT'); throw Error('SYNTHETIC_SECRET_SENTINEL'); };
  const r = await f.fallback(); assert.ok(!r.twiml.includes('<Sip')); assert.ok(!r.twiml.includes('SYNTHETIC_SECRET'));
  await f.fallback(); assert.equal(f.requests.length, 1); assert.equal((await f.budgets.find(f.options.budgetId)).status, 'ENDED');
});
test('budget persistence failure dispatches zero registrations and takes safe hangup', database, async () => {
  const f = fixture(); await f.incoming(); const failing = Object.create(BudgetModel);
  failing.create = async () => { throw Error('SENTINEL'); };
  const app = express(), next = installRetellSandbox(app, { ...f.options, BudgetModel: failing });
  const r = await next.handoff.fallback(f.req('/api/voice/dial-fallback', { CallSid: f.parent, To: '+15550000001', DialCallStatus: 'no-answer' }));
  assert.ok(!r.twiml.includes('<Sip')); assert.equal(f.requests.length, 0);
});
test('screening denies another child and late/superseded/expired TwiML', database, async () => {
  const f = fixture(); await f.incoming(); await f.fallback();
  assert.ok(!(await f.webhook('screen')).twiml.includes('Hangup'));
  assert.match((await f.webhook('screen', { CallSid: `CA${'e'.repeat(32)}` })).twiml, /Hangup/);
  await f.lifecycle.supersede({ parentCallSid: f.parent, ownerEpoch: 1 });
  assert.match((await f.webhook('screen')).twiml, /Hangup/);
});
test('setup expiry rejects even before the conservative authorization window ends', database, async () => {
  const f = fixture(); await f.incoming(); await f.fallback(); f.advance(30001);
  assert.match((await f.webhook('screen')).twiml, /Hangup/);
});
for (const kind of ['status', 'complete']) test(`${kind} completion revokes and delayed provider start cannot resurrect`, database, async () => {
  const f = fixture(); await f.incoming(); await f.fallback(); await f.webhook('screen'); await f.start();
  assert.ok(await f.repository.findByProviderCallId(f.providerId));
  await f.webhook(kind, kind === 'status' ? { CallStatus: 'completed' } : {});
  assert.equal(await f.repository.findByProviderCallId(f.providerId), null); await f.start();
  assert.equal(await f.repository.findByProviderCallId(f.providerId), null);
});
test('direct time expiry denies tools with no Node timer or callback and never extends on answered/start', database, async () => {
  const f = fixture(); await f.incoming(); await f.fallback(); await f.webhook('screen'); await f.start();
  f.advance(120000); assert.equal(await f.repository.findByProviderCallId(f.providerId), null);
  await f.webhook('status'); await f.start(); assert.equal(await f.repository.findByProviderCallId(f.providerId), null);
});

for (const point of ['reserveBridge', 'screenBridge']) test(`registration ${point} write failure withholds bridge/connection and tools`, database, async () => {
  const f = fixture(); await f.incoming();
  if (point === 'screenBridge') await f.fallback();
  const repository = { ...f.repository, [point]: async () => { throw Error('SECRET_SENTINEL'); } };
  const h = createRetellSandboxHandoff({ ...f.options, repository, budgets: f.budgets, lifecycle: f.lifecycle });
  const r = point === 'reserveBridge'
    ? await h.fallback(f.req('/api/voice/dial-fallback', { CallSid: f.parent, To: '+15550000001', DialCallStatus: 'no-answer' }))
    : await h.webhook(f.req('/api/voice/retell-sandbox/screen', { ParentCallSid: f.parent, CallSid: f.childSid }), 'screen');
  assert.match(r.twiml, /Hangup/); assert.ok(!r.twiml.includes('<Sip')); assert.ok(!r.twiml.includes('SECRET_SENTINEL'));
  if (f.requests.length) { await f.start(); assert.equal(await f.repository.findByProviderCallId(f.providerId), null); }
});
test('SIP bridge failure completion consumes budget and cannot fall into legacy AI', database, async () => {
  const f = fixture(); await f.incoming(); await f.fallback(); await f.webhook('screen'); await f.start();
  await f.webhook('complete', { DialCallStatus: 'failed' });
  assert.equal(await f.repository.findByProviderCallId(f.providerId), null);
  assert.match((await f.fallback()).twiml, /Hangup/); assert.equal(f.requests.length, 1);
});
test('real shared HTTP hooks preserve mobile response and selected fallback never calls legacy owner', database, async t => {
  const f = fixture(); const counters = { mobile: 0, legacy: 0 };
  f.app.use(express.urlencoded({ extended: false }));
  f.app.post('/api/voice/incoming', async (req, res) => {
    await observeSandboxIncoming(req, businessId); counters.mobile++;
    res.type('text/xml').send('<Response><Dial><Client>EXISTING_MOBILE</Client></Dial></Response>');
  });
  f.app.post('/api/voice/dial-fallback', async (req, res) => {
    if (await handleSandboxFallback(req, res)) return;
    counters.legacy++; res.send('EXISTING_ROUTE');
  });
  for (const kind of ['screen','status','complete']) f.app.post(`/api/voice/retell-sandbox/${kind}`, (req, res) => handleSandboxWebhook(req, res, kind));
  const server = http.createServer(f.app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = (path, body, valid = true) => new Promise((resolve, reject) => {
    const signed = f.req(path, body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: {
      'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': valid ? signed.headers['x-twilio-signature'] : 'invalid' } }, res => {
      const parts=[]; res.on('data', p => parts.push(p)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString() }));
    }); req.on('error', reject); req.end(new URLSearchParams(body).toString());
  });
  assert.match((await post('/api/voice/incoming', { CallSid: f.parent, To: '+15550000001' })).text, /EXISTING_MOBILE/);
  const r = await post('/api/voice/dial-fallback', { CallSid: f.parent, To: '+15550000001', DialCallStatus: 'no-answer' });
  assert.match(r.text, /<Sip/); assert.equal(counters.mobile, 1); assert.equal(counters.legacy, 0);
  assert.equal((await post('/api/voice/retell-sandbox/screen', { ParentCallSid: f.parent, CallSid: f.childSid }, false)).status, 403);
  const screen = await post('/api/voice/retell-sandbox/screen', { ParentCallSid: f.parent, CallSid: f.childSid }); assert.ok(!screen.text.includes('Hangup'));
  await f.start(); assert.ok(await f.repository.findByProviderCallId(f.providerId));
  await post('/api/voice/retell-sandbox/status', { ParentCallSid: f.parent, CallSid: f.childSid, CallStatus: 'completed' });
  assert.equal(await f.repository.findByProviderCallId(f.providerId), null);
  assert.equal((await post('/api/voice/dial-fallback', { CallSid: f.parent, To: '+15550000002', DialCallStatus: 'no-answer' })).text, 'EXISTING_ROUTE');
  assert.equal(counters.legacy, 1); assert.deepEqual(f.effects, []);
});
