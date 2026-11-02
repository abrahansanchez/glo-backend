import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import twilio from 'twilio';
import RegistrationModel from '../../models/RetellCallRegistration.js';
import { createRetellRegistrationRepository } from '../../services/voice/retell/RegistrationRepository.js';
import { createRetellCallRegistration } from '../../services/voice/retell/CallRegistration.js';
import { mountRetellReadOnlyTools } from '../../services/voice/retell/mountReadOnlyTools.js';
import { createRetellRegistrationTransport } from '../../services/voice/retell/RegistrationTransport.js';

const businessId = '507f1f77bcf86cd799439011', other = '507f1f77bcf86cd799439012';
const sid = `CA${'1'.repeat(32)}`, secondSid = `CA${'2'.repeat(32)}`;
const secret = 'SYNTHETIC_TEST_ONLY', sentinel = 'SENTINEL_MUST_NOT_BE_SAVED';
const origin = 'https://synthetic.invalid', clock = Date.parse('2026-10-30T14:00:00Z');

// Model-shaped, atomically evaluated fake database. New repository instances share
// stored rows, not service memory. Mongo integration/index durability is not claimed.
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(q => matches(row, q));
    if (key === '$and') return value.every(q => matches(row, q));
    const actual = row[key];
    if (value && typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).every(([op, v]) => {
      if (op === '$gt') return +new Date(actual) > +new Date(v);
      if (op === '$in') return v.includes(actual);
      if (op === '$nin') return !v.includes(actual);
      if (op === '$exists') return (actual !== undefined) === v;
      throw Error(`UNTESTED_QUERY_OPERATOR_${op}`);
    });
    return actual === value;
  });
}
function fakeModel() {
  const rows = new Map();
  let fail = null;
  const check = operation => { if (fail === operation) throw Error(sentinel); };
  const unique = row => {
    if ([...rows.values()].some(r => r._id !== row._id && (r.attemptId === row.attemptId
      || (row.providerCallId && r.providerCallId === row.providerCallId)))) throw Object.assign(Error(sentinel), { code: 11000 });
  };
  const Model = {
    init: async () => { check('init'); },
    createIndexes: async () => { check('indexes'); },
    create: async row => { check('create'); if (rows.has(row._id)) throw Object.assign(Error(sentinel), { code: 11000 });
      unique(row); rows.set(row._id, structuredClone(row)); return { toObject: () => structuredClone(row) }; },
    findOne: query => ({ lean: async () => { check('find'); return structuredClone([...rows.values()].find(r => matches(r, query)) || null); } }),
    findOneAndUpdate: (query, update, options) => ({ lean: async () => {
      assert.deepEqual(options, { new: true, runValidators: true }); check('update');
      const row = [...rows.values()].find(r => matches(r, query)); if (!row) return null;
      const next = { ...row, ...update.$set, revision: row.revision + update.$inc.revision };
      unique(next); rows.set(row._id, next); return structuredClone(next);
    } }),
  };
  return { Model, rows, fail: operation => { fail = operation; } };
}
function fixture(options = {}) {
  let time = clock;
  const db = fakeModel(), repository = createRetellRegistrationRepository({ Model: db.Model, now: () => new Date(time) });
  const requests = [];
  const provider = { registerPhoneCall: async (payload, controls) => {
    requests.push(structuredClone(payload));
    return options.reply ? options.reply(payload, controls) : {
      call_id: `retell_${requests.length}`, agent_id: payload.agent_id, agent_version: payload.agent_version, call_status: 'registered',
    };
  } };
  const lifecycle = createRetellCallRegistration({ enabled: true, repository, provider,
    agentsByBusiness: { [businessId]: { agentId: 'agent_en', agentVersion: 1, language: 'en' },
      [other]: { agentId: 'agent_es', agentVersion: 2, language: 'es' } },
    twilio: { authToken: secret, appBaseUrl: origin },
    resolveBusiness: async number => ({ businessId: number === '+15550000002' ? other : businessId }),
    now: () => new Date(time), deadlineMs: options.deadlineMs || 1000 });
  const incoming = async (callSid = sid, to = '+15550000001', edit = () => {}) => {
    const params = { CallSid: callSid, To: to, From: '+15550000003' };
    const signature = twilio.getExpectedTwilioSignature(secret, `${origin}/api/voice/incoming`, params);
    edit(params); return lifecycle.observeIncoming({ params, signature });
  };
  const register = owner => lifecycle.register(owner);
  const event = (kind = 'call_started', changes = {}, index = 0) => ({ event: kind,
    call: { call_id: `retell_${index + 1}`, agent_id: requests[index].agent_id, agent_version: requests[index].agent_version,
      call_status: kind === 'call_started' ? 'ongoing' : 'ended', metadata: requests[index].metadata, ...changes } });
  return { db, repository, lifecycle, incoming, register, event, requests, now: () => new Date(time), advance: ms => { time += ms; } };
}

async function httpFixture(t, f, config = {}) {
  const effects = [], reads = [];
  const forbidden = () => { effects.push('MUTATION'); throw Error(sentinel); };
  const catalogue = id => ({ _id: id, services: [{ _id: 'real_shaped_cut', name: 'Haircut', price: 25, durationMinutes: 30 }],
    availability: { timezone: 'America/New_York', bufferMinutes: 0, blackoutDates: [],
      businessHours: Object.fromEntries(['sun','mon','tue','wed','thu','fri','sat'].map(day => [day, { open: '09:00', close: '18:00', isClosed: false }])) } });
  const app = express();
  const state = mountRetellReadOnlyTools(app, { config: { enabled: true, signingKey: secret, allowedBusinessIds: [businessId, other], ...config },
    registration: { repository: f.repository, lifecycle: f.lifecycle }, now: f.now,
    models: { BarberModel: { findById: id => ({ select: () => ({ lean: async () => { reads.push(id); return catalogue(id); } }) }), create: forbidden },
      AppointmentModel: { findOne: q => ({ select: () => ({ lean: async () => { reads.push(q.barberId); return null; } }) }), create: forbidden } } });
  app.use(express.json());
  app.post('/api/voice/incoming', (_req, res) => res.json({ route: 'UNCHANGED' }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  t.after(() => assert.deepEqual(effects, []));
  const post = (path, body, valid = true) => new Promise((resolve, reject) => {
    const raw = Buffer.from(JSON.stringify(body, null, 2)), timestamp = +f.now();
    const signature = `v=${timestamp},d=${createHmac('sha256', secret).update(raw).update(String(timestamp)).digest('hex')}`;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path,
      headers: { 'content-type': 'application/json', 'x-retell-signature': valid ? signature : 'invalid' } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); assert.ok(!text.includes(sentinel));
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    }); req.on('error', reject); req.end(raw);
  });
  const tool = (call, args = {}) => post('/api/voice/retell/tools/context', { name: 'read_business_context', call, args });
  return { post, tool, reads, state };
}

test('durable schema has unique parent/attempt/provider identity, bounded statuses, no expiring deletion', () => {
  assert.equal(RegistrationModel.schema.path('_id').instance, 'String');
  const indexes = RegistrationModel.schema.indexes();
  assert.ok(indexes.some(([keys, options]) => keys.attemptId && options.unique));
  assert.ok(indexes.some(([keys, options]) => keys.providerCallId && options.unique && options.partialFilterExpression));
  assert.ok(indexes.every(([, options]) => options.expireAfterSeconds === undefined));
});

test('verified incoming -> single durable registration -> signed start -> authorized read; fresh repository survives service replacement', async t => {
  const f = fixture(), h = await httpFixture(t, f);
  const owner = await f.incoming(); assert.equal(owner.observed, true);
  assert.equal((await f.register(owner)).registered, true);
  const e = f.event();
  assert.equal((await h.tool(e.call)).status, 403); // returned ID alone is pending, not active
  assert.equal((await h.post('/api/voice/retell/events', e)).status, 204);
  assert.equal((await h.tool(e.call)).status, 200);
  const context = await h.tool(e.call);
  const slot = await h.post('/api/voice/retell/tools/availability', { name: 'check_bundle_availability', call: e.call,
    args: { serviceIds: ['real_shaped_cut'], date: '2026-11-03', time: '15:00', businessRevision: context.body.businessRevision } });
  assert.equal(slot.status, 200); assert.equal(slot.body.data.available, true); assert.equal(slot.body.data.canAuthorize, false);
  const restarted = createRetellRegistrationRepository({ Model: f.db.Model, now: f.now });
  assert.equal((await restarted.findByProviderCallId('retell_1')).businessId, businessId);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(Object.keys(f.requests[0]).sort(), ['agent_id','agent_version','direction','metadata']);
  const stored = [...f.db.rows.values()].map(row => { const copy = { ...row }; assert.equal(copy.trustedCallerNumber, '+15550000003'); delete copy.trustedCallerNumber; return copy; });
  assert.ok(!JSON.stringify(stored).includes('+1555')); // only the approved signed caller field is retained
});

test('two businesses stay isolated; forged business args reject and metadata cannot change scope', async t => {
  const f = fixture(), h = await httpFixture(t, f);
  await f.register(await f.incoming()); await f.register(await f.incoming(secondSid, '+15550000002'));
  for (const index of [0, 1]) {
    const e = f.event('call_started', {}, index); await h.post('/api/voice/retell/events', e);
    assert.equal((await h.tool({ ...e.call, metadata: { businessId: index ? businessId : other } })).status, 200);
    assert.equal(h.reads.at(-1), index ? other : businessId);
    assert.equal((await h.tool(e.call, { businessId: index ? businessId : other })).status, 400);
    assert.equal((await h.tool({ ...e.call, agent_id: index ? 'agent_en' : 'agent_es' })).status, 403);
  }
});

for (const mode of ['unknown','wrong agent','wrong version','expired','ended','superseded','pending']) test(`${mode} cannot authorize tools`, async t => {
  const f = fixture(), h = await httpFixture(t, f); const owner = await f.incoming(); await f.register(owner);
  const e = f.event(); if (mode !== 'pending') await h.post('/api/voice/retell/events', e);
  if (mode === 'unknown') e.call.call_id = 'unknown';
  if (mode === 'wrong agent') e.call.agent_id = 'foreign';
  if (mode === 'wrong version') e.call.agent_version = 99;
  if (mode === 'expired') f.advance(600001);
  if (mode === 'ended') await h.post('/api/voice/retell/events', f.event('call_ended'));
  if (mode === 'superseded') await f.lifecycle.supersede(owner);
  assert.equal((await h.tool(e.call)).status, 403); assert.equal(h.reads.length, 0);
});

test('duplicate/concurrent incoming and registration have one owner and one provider dispatch', async () => {
  const f = fixture(); const owners = await Promise.all(Array.from({ length: 8 }, () => f.incoming()));
  assert.ok(owners.every(o => o.observed && o.ownerEpoch === 1));
  const results = await Promise.all(owners.map(o => f.register(o)));
  assert.equal(results.filter(r => r.registered).length, 1); assert.equal(f.requests.length, 1);
  assert.equal((await f.register(owners[0])).registered, false);
  assert.equal(f.db.rows.size, 1);
});

test('ownership changes during pending provider work prevent late binding and re-registration', async () => {
  let finish;
  const f = fixture({ reply: payload => new Promise(resolve => { finish = () => resolve({ call_id: 'retell_1', agent_id: payload.agent_id, agent_version: payload.agent_version, call_status: 'registered' }); }) });
  const owner = await f.incoming(), pending = f.register(owner);
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  assert.equal(await f.lifecycle.supersede(owner), true); finish();
  assert.equal((await pending).registered, false);
  assert.equal(await f.lifecycle.handleEvent(f.event()), false);
  assert.equal((await f.register({ ...owner, ownerEpoch: 2 })).registered, false);
  assert.equal(f.requests.length, 1); assert.equal(await f.repository.findByProviderCallId('retell_1'), null);
});

test('bad Twilio signature and mismatched incoming parameters never seed authority', async () => {
  const f = fixture();
  assert.equal((await f.incoming(sid, '+15550000001', p => { p.To = '+15550000002'; })).reasonCode, 'UNTRUSTED_INCOMING_CALL');
  assert.equal(f.db.rows.size, 0); assert.equal(f.requests.length, 0);
  assert.equal((await f.register({ parentCallSid: sid, ownerEpoch: 1 })).registered, false);
});

for (const operation of ['init', 'indexes', 'create', 'update']) test(`persistence ${operation} failure cannot dispatch or authorize`, async () => {
  const f = fixture(); if (operation === 'update') await f.incoming(); f.db.fail(operation);
  if (operation !== 'update') assert.equal((await f.incoming()).registered, false);
  assert.equal((await f.register({ parentCallSid: sid, ownerEpoch: 1 })).registered, false);
  assert.equal(f.requests.length, 0);
});

test('binding persistence failure after provider response is not successful or authorized', async () => {
  let f;
  f = fixture({ reply: payload => { f.db.fail('update'); return { call_id: 'retell_1', agent_id: payload.agent_id, agent_version: payload.agent_version, call_status: 'registered' }; } });
  assert.equal((await f.register(await f.incoming())).registered, false); f.db.fail(null);
  assert.equal(await f.repository.findByProviderCallId('retell_1'), null);
  assert.equal((await f.register({ parentCallSid: sid, ownerEpoch: 1 })).registered, false); assert.equal(f.requests.length, 1);
});

for (const mode of ['throw','timeout','invalid response']) test(`provider ${mode} is terminal unknown with no unsafe retry or callback promotion`, async () => {
  let aborted = false, finish;
  const f = fixture({ deadlineMs: 10, reply: (_payload, { signal }) => {
    if (mode === 'throw') throw Error(sentinel);
    if (mode === 'invalid response') return { call_id: 'retell_1', agent_id: 'foreign', agent_version: 1, call_status: 'registered' };
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(resolve => { finish = resolve; });
  } });
  const owner = await f.incoming(); const r = await f.register(owner);
  assert.equal(r.reasonCode, 'REGISTRATION_OUTCOME_UNKNOWN');
  assert.equal((await f.register(owner)).registered, false);
  assert.equal(await f.lifecycle.handleEvent(f.event()), false);
  assert.equal(await f.repository.findByProviderCallId('retell_1'), null);
  assert.equal(f.requests.length, 1); assert.ok(!JSON.stringify(r).includes(sentinel));
  if (mode === 'timeout') { assert.equal(aborted, true); finish({ call_id: 'retell_1', agent_id: 'agent_en', agent_version: 1, call_status: 'registered' }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(await f.repository.findByProviderCallId('retell_1'), null); }
});

test('ended before response wins; duplicate/late starts never reopen terminal state', async () => {
  let f;
  f = fixture({ reply: async payload => {
    await f.lifecycle.handleEvent({ event: 'call_ended', call: { call_id: 'retell_1', agent_id: payload.agent_id,
      agent_version: payload.agent_version, call_status: 'ended', metadata: payload.metadata } });
    return { call_id: 'retell_1', agent_id: payload.agent_id, agent_version: payload.agent_version, call_status: 'registered' };
  } });
  assert.equal((await f.register(await f.incoming())).registered, false);
  assert.equal(await f.lifecycle.handleEvent(f.event()), false);
  assert.equal(f.db.rows.get(sid).status, 'ENDED');
});

test('early start is held until ID persistence; duplicate callbacks do not change revision', async () => {
  let f;
  f = fixture({ reply: async payload => {
    await f.lifecycle.handleEvent({ event: 'call_started', call: { call_id: 'retell_1', agent_id: payload.agent_id,
      agent_version: payload.agent_version, call_status: 'ongoing', metadata: payload.metadata } });
    assert.equal(await f.repository.findByProviderCallId('retell_1'), null);
    return { call_id: 'retell_1', agent_id: payload.agent_id, agent_version: payload.agent_version, call_status: 'registered' };
  } });
  assert.equal((await f.register(await f.incoming())).registered, true);
  assert.ok(await f.repository.findByProviderCallId('retell_1'));
  const revision = f.db.rows.get(sid).revision; await f.lifecycle.handleEvent(f.event());
  assert.equal(f.db.rows.get(sid).revision, revision);
});

test('callbacks reject invalid signatures; foreign attempts and lifecycle payloads never create records or retain sentinels', async t => {
  const f = fixture(), h = await httpFixture(t, f); await f.register(await f.incoming());
  const e = f.event('call_started', { transcript: sentinel, headers: { authorization: sentinel } });
  assert.equal((await h.post('/api/voice/retell/events', e, false)).status, 401);
  for (const change of [{ agent_id: 'foreign' }, { agent_version: 99 }, { metadata: { glo_registration_attempt: '0'.repeat(36) } }])
    await h.post('/api/voice/retell/events', f.event('call_started', change));
  assert.equal(await f.repository.findByProviderCallId('retell_1'), null);
  await h.post('/api/voice/retell/events', e);
  assert.ok(await f.repository.findByProviderCallId('retell_1'));
  assert.ok(!JSON.stringify([...f.db.rows.values()]).includes(sentinel));
  await h.post('/api/voice/retell/events', f.event('call_ended'));
  const revision = f.db.rows.get(sid).revision;
  await h.post('/api/voice/retell/events', f.event('call_ended')); await h.post('/api/voice/retell/events', e);
  assert.equal(f.db.rows.get(sid).revision, revision); assert.equal(await f.repository.findByProviderCallId('retell_1'), null);
});

test('default-disabled service and HTTP composition perform no provider, repository or routing work', async t => {
  const forbidden = () => { throw Error(sentinel); };
  const disabled = createRetellCallRegistration({ repository: { observe: forbidden }, provider: { registerPhoneCall: forbidden } });
  assert.equal((await disabled.observeIncoming()).reasonCode, 'NOT_ENABLED');
  assert.equal((await disabled.register()).reasonCode, 'NOT_ENABLED'); assert.equal(await disabled.handleEvent({}), false);
  const f = fixture(), h = await httpFixture(t, f, { enabled: false });
  assert.equal(h.state.enabled, false); assert.equal((await h.post('/api/voice/retell/events', {})).status, 404);
  assert.equal((await h.post('/api/voice/incoming', {})).body.route, 'UNCHANGED');
  assert.equal(f.requests.length, 0); assert.equal(f.db.rows.size, 0); assert.deepEqual(h.reads, []);
});

test('provider call ID uniqueness prevents a second business from binding an already returned identity', async () => {
  const f = fixture({ reply: p => ({ call_id: 'same_provider_id', agent_id: p.agent_id, agent_version: p.agent_version, call_status: 'registered' }) });
  assert.equal((await f.register(await f.incoming())).registered, true);
  assert.equal((await f.register(await f.incoming(secondSid, '+15550000002'))).registered, false);
  assert.equal(f.db.rows.get(secondSid).status, 'UNKNOWN'); assert.equal(f.requests.length, 2);
  assert.equal(await f.repository.findByProviderCallId('same_provider_id'), null); // first still pending
});

test('changed tenant mapping cannot overwrite the original parent binding; unobserved calls and foreign epochs cannot claim', async () => {
  const f = fixture(); const owner = await f.incoming();
  assert.equal((await f.incoming(sid, '+15550000002')).reasonCode, 'CALL_ALREADY_OWNED');
  assert.equal((await f.register({ parentCallSid: secondSid, ownerEpoch: 1 })).registered, false);
  assert.equal((await f.register({ ...owner, ownerEpoch: 2 })).registered, false);
  assert.equal(f.requests.length, 0); assert.equal(f.db.rows.get(sid).businessId, businessId);
});

test('expired incoming replay and observed owner cannot create a fresh attempt', async () => {
  const f = fixture(); const owner = await f.incoming(); const attempt = f.db.rows.get(sid).attemptId;
  f.advance(600001); assert.equal((await f.incoming()).observed, undefined);
  assert.equal((await f.register(owner)).registered, false);
  assert.equal(f.db.rows.get(sid).attemptId, attempt); assert.equal(f.requests.length, 0);
});

test('callback persistence failure returns a safe retryable HTTP status, not successful activation', async t => {
  const f = fixture(), h = await httpFixture(t, f); await f.register(await f.incoming());
  f.db.fail('update'); assert.equal((await h.post('/api/voice/retell/events', f.event())).status, 503);
  f.db.fail(null); assert.equal(await f.repository.findByProviderCallId('retell_1'), null);
});

test('unknown call with a valid attempt but conflicting provider identity cannot replace a bound call', async () => {
  const f = fixture(); await f.register(await f.incoming());
  assert.equal(await f.lifecycle.handleEvent(f.event('call_started', { call_id: 'foreign_call' })), false);
  assert.equal(await f.lifecycle.handleEvent(f.event('call_ended', { call_id: 'foreign_call' })), false);
  assert.equal(await f.lifecycle.handleEvent(f.event()), true);
  assert.equal((await f.repository.findByProviderCallId('retell_1')).businessId, businessId);
});

for (const status of ['registered', 'not_connected', 'ongoing']) test(`signed terminal event revokes despite ${status} status snapshot`, async t => {
  const f = fixture(), h = await httpFixture(t, f); await f.register(await f.incoming());
  await h.post('/api/voice/retell/events', f.event());
  assert.ok(await f.repository.findByProviderCallId('retell_1'));
  await h.post('/api/voice/retell/events', f.event('call_ended', { call_status: status }));
  assert.equal((await h.tool(f.event().call)).status, 403);
  await h.post('/api/voice/retell/events', f.event());
  assert.equal(await f.repository.findByProviderCallId('retell_1'), null);
});

test('documented minimal callback can omit version/metadata after binding; supplied conflicts still reject', async t => {
  const f = fixture(), h = await httpFixture(t, f); await f.register(await f.incoming());
  const e = f.event(); delete e.call.agent_version; delete e.call.metadata;
  await h.post('/api/voice/retell/events', e); assert.equal((await h.tool(f.event().call)).status, 200);
  const ended = f.event('call_ended'); delete ended.call.agent_version; delete ended.call.metadata;
  await h.post('/api/voice/retell/events', ended); assert.equal((await h.tool(f.event().call)).status, 403);
});

test('early callback without version uses only matching attempt and agent, never another business', async () => {
  let f;
  f = fixture({ reply: async p => {
    assert.equal(await f.lifecycle.handleEvent({ event: 'call_started', call: { call_id: 'retell_1', agent_id: 'foreign', call_status: 'ongoing', metadata: p.metadata } }), false);
    assert.equal(await f.lifecycle.handleEvent({ event: 'call_started', call: { call_id: 'retell_1', agent_id: p.agent_id, call_status: 'ongoing', metadata: p.metadata } }), true);
    assert.equal(await f.repository.findByProviderCallId('retell_1'), null);
    return { call_id: 'retell_1', agent_id: p.agent_id, agent_version: p.agent_version, call_status: 'registered' };
  } });
  assert.equal((await f.register(await f.incoming())).registered, true);
  assert.ok(await f.repository.findByProviderCallId('retell_1'));
});

test('real registration transport with fake HTTP composes with durable binding; invalid response cannot bind or retry', async () => {
  for (const malformed of [false, true]) {
    let calls = 0;
    const transport = createRetellRegistrationTransport({ enabled: true, apiKey: secret, http: async (_url, init) => {
      calls++; const p = JSON.parse(init.body);
      return new Response(JSON.stringify({ call_type: 'phone_call', call_id: 'retell_1', agent_id: p.agent_id,
        agent_version: malformed ? 99 : p.agent_version, call_status: 'registered', transcript: sentinel }));
    } });
    const f = fixture({ reply: (p, controls) => transport.registerPhoneCall(p, controls) });
    const owner = await f.incoming(); assert.equal((await f.register(owner)).registered, !malformed);
    await f.lifecycle.handleEvent(f.event());
    assert.equal(Boolean(await f.repository.findByProviderCallId('retell_1')), !malformed);
    assert.equal((await f.register(owner)).registered, false); assert.equal(calls, 1);
    assert.ok(!JSON.stringify([...f.db.rows.values()]).includes(sentinel));
  }
});
