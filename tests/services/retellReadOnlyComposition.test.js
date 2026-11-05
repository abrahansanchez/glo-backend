import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mountRetellReadOnlyTools } from '../../services/voice/retell/mountReadOnlyTools.js';

const businessId = '507f1f77bcf86cd799439011', otherId = '507f1f77bcf86cd799439012';
const clock = Date.parse('2026-10-30T14:00:00Z'), key = 'SYNTHETIC_NOT_A_REAL_KEY';
async function fixture(t, options = {}) {
  const reads = [], effects = [];
  const forbidden = () => { effects.push('FORBIDDEN'); throw Error('MUTATION_MUST_NOT_RUN'); };
  const business = { _id: businessId, services: [{ _id: 'synthetic_cut', name: 'Haircut', price: 25, durationMinutes: 30 }],
    availability: { timezone: 'America/New_York', bufferMinutes: 0, blackoutDates: [],
      businessHours: Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(day => [day, { isClosed: false, open: '09:00', close: '18:00' }])) } };
  const binding = { provider: 'retell', mode: 'READ_ONLY', status: 'ACTIVE', callId: 'synthetic_call', agentId: 'synthetic_agent',
    agentVersion: 1, businessId, language: 'en', parentCallSid: 'CA_SYNTHETIC', revision: 1, expiresAt: new Date(clock + 60000).toISOString() };
  const models = {
    BarberModel: { findById: id => { reads.push({ model: 'Barber', id }); return {
      select: projection => { assert.equal(projection, '_id services availability externalCalendarsRequired staffSchedulingEnabled'); return { lean: async () => structuredClone(business) }; },
    }; }, create: forbidden, updateOne: forbidden, deleteOne: forbidden },
    AppointmentModel: { findOne: query => { reads.push({ model: 'Appointment', query }); return {
      select: projection => { assert.equal(projection, '_id'); return { lean: async () => null }; },
    }; }, create: forbidden, updateOne: forbidden, deleteOne: forbidden },
  };
  const app = express();
  // This is the same mount function/order used by server.js, without importing its
  // DB connection, dotenv, provider construction or scheduled jobs.
  const state = mountRetellReadOnlyTools(app, { config: { enabled: true, signingKey: key, allowedBusinessIds: [businessId] },
    callBindings: { findByProviderCallId: async id => id === binding.callId ? binding : null }, models, now: () => new Date(clock), ...options });
  app.use(express.json());
  app.post('/api/voice/incoming', (req, res) => res.json({ existing: 'incoming', body: req.body }));
  app.post('/api/voice/ai-takeover', (req, res) => res.json({ existing: 'takeover', body: req.body }));
  app.post('/api/stripe/webhook', (_req, res) => res.json({ existing: 'stripe' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  t.after(() => assert.deepEqual(effects, []));
  const send = (path, body, signature) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path,
      headers: { 'content-type': 'application/json', ...(signature ? { 'x-retell-signature': signature } : {}) } }, res => {
      const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString()) }));
    }); req.on('error', reject); req.end(body);
  });
  const post = (tool, args = {}, edit = () => {}, badSignature = false) => {
    const p = { name: tool === 'context' ? 'read_business_context' : 'check_bundle_availability',
      call: { call_id: binding.callId, agent_id: binding.agentId, agent_version: 1, call_status: 'ongoing', metadata: { businessId: otherId } }, args };
    edit(p);
    // Non-canonical whitespace proves the composed path preserves exact bytes.
    const raw = Buffer.from(JSON.stringify(p, null, 2));
    const signature = `v=${clock},d=${createHmac('sha256', key).update(raw).update(String(clock)).digest('hex')}`;
    return send(`/api/voice/retell/tools/${tool}`, raw, badSignature ? `v=${clock},d=${'0'.repeat(64)}` : signature);
  };
  return { binding, business, models, reads, effects, post, send, state };
}

test('actual composition uses projected existing model reads and preserves signed raw bytes', async t => {
  const f = await fixture(t);
  assert.equal(f.state.enabled, true);
  const c = await f.post('context'); assert.equal(c.status, 200);
  const r = await f.post('availability', { serviceIds: ['synthetic_cut'], date: '2026-11-03', time: '15:00', businessRevision: c.body.businessRevision });
  assert.equal(r.status, 200); assert.equal(r.body.data.available, true); assert.equal(r.body.data.canAuthorize, false);
  assert.ok(f.reads.some(r => r.model === 'Appointment'));
  assert.ok(f.reads.filter(r => r.model === 'Barber').every(r => r.id === businessId));
  assert.ok(f.reads.filter(r => r.model === 'Appointment').every(r => r.query.barberId === businessId));
});

for (const mode of ['default', 'false', 'missing binding', 'missing key', 'invalid allowlist'])
  test(`composed ${mode} stays disabled without affecting existing HTTP routes`, async t => {
    const options = mode === 'default' ? { config: undefined } : mode === 'false' ? { config: { enabled: false } }
      : mode === 'missing binding' ? { callBindings: undefined }
      : { config: { enabled: true, signingKey: mode === 'missing key' ? undefined : key, allowedBusinessIds: mode === 'invalid allowlist' ? ['invalid'] : [businessId] } };
    const f = await fixture(t, options);
    assert.equal(f.state.enabled, false); assert.equal((await f.post('context')).status, 404); assert.equal(f.reads.length, 0);
    for (const path of ['/api/voice/incoming', '/api/voice/ai-takeover', '/api/stripe/webhook']) {
      const r = await f.send(path, '{"synthetic":true}'); assert.equal(r.status, 200);
    }
  });

for (const mode of ['invalid signature', 'unknown call', 'foreign agent', 'foreign args business', 'foreign bound business', 'expired', 'ended'])
  test(`composed ${mode} rejects before model reads/effects`, async t => {
    const f = await fixture(t);
    if (mode === 'foreign bound business') f.binding.businessId = otherId;
    if (mode === 'expired') f.binding.expiresAt = new Date(clock - 1).toISOString();
    if (mode === 'ended') f.binding.status = 'ENDED';
    const r = await f.post('context', mode === 'foreign args business' ? { businessId: otherId } : {}, p => {
      if (mode === 'unknown call') p.call.call_id = 'unknown';
      if (mode === 'foreign agent') p.call.agent_id = 'another_agent';
    }, mode === 'invalid signature');
    assert.ok([400, 401, 403].includes(r.status)); assert.equal(f.reads.length, 0);
  });

test('signed repeat is a fresh authorized read, not replayed availability or authority', async t => {
  const f = await fixture(t);
  const first = await f.post('context'); f.business.services[0].price = 26;
  const next = await f.post('context'); assert.notEqual(next.body.businessRevision, first.body.businessRevision);
  assert.equal(next.body.canAuthorize, false);
  f.binding.status = 'ENDED'; assert.equal((await f.post('context')).status, 403);
});

test('no binding/registration/mutation HTTP bypass is exposed', async t => {
  const f = await fixture(t);
  for (const tool of ['register', 'bindings', 'booking', 'cancel', 'sms']) assert.equal((await f.post(tool)).status, 404);
  const server = await readFile(new URL('../../server.js', import.meta.url), 'utf8');
  assert.match(server, /await mountRetellStartup\(app\);/);
  assert.ok(server.indexOf('await mountRetellStartup(app);') < server.indexOf('app.use(express.json'));
  assert.ok(server.indexOf('app.use("/api/stripe", stripeWebhookRoutes)') < server.indexOf('await mountRetellStartup(app);'));
});
