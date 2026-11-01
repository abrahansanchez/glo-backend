import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRetellReadOnlyRouter, verifyRetellSignature } from '../../routes/retellReadOnlyRoutes.js';
import { retellReadOnlyAgentTemplate } from '../../services/voice/retell/agentTemplates.js';

const businessId = '507f1f77bcf86cd799439011', otherId = '507f1f77bcf86cd799439012';
const key = 'synthetic-offline-signing-key-not-a-credential';
const initialNow = Date.parse('2026-10-30T14:00:00Z');
function business(id = businessId) {
  return { _id: id, services: [
    { _id: 'service-cut-91', name: 'Haircut', price: 25, durationMinutes: 30 },
    { _id: 'service-beard-92', name: 'Beard Trim', price: 0, durationMinutes: 15 },
  ], availability: { timezone: 'America/New_York', bufferMinutes: 10, blackoutDates: [],
    businessHours: Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map(day => [day,
      { isClosed: day === 'sun', open: '09:00', close: '18:00' }])) } };
}
async function fixture(t, options = {}) {
  let clock = initialNow;
  const b = business(), second = business(otherId), queries = [], lookups = [], audit = [];
  const counters = { appointmentWrites: 0, sms: 0, bindings: 0 };
  const binding = { provider: 'retell', mode: 'READ_ONLY', status: 'ACTIVE', callId: 'call_synthetic_a', businessId,
    agentId: 'agent_synthetic_en', agentVersion: 1, language: 'en', parentCallSid: 'CA_SYNTHETIC', revision: 1,
    expiresAt: new Date(initialNow + 86400000 * 20).toISOString() };
  const appointments = [];
  const config = { enabled: true, allowedBusinessIds: [businessId, otherId], signingKey: key, now: () => new Date(clock), audit: e => audit.push(e),
    callBindings: { findByProviderCallId: async callId => { counters.bindings++; return callId === binding.callId ? binding : null; } },
    businessRepository: { findById: async id => { lookups.push(id); return id === businessId ? b : second; } },
    appointmentRepository: { findConflict: async query => {
      queries.push(query);
      const from = query.$or[0].startAt.$gte, to = query.$or[0].startAt.$lt;
      return appointments.find(a => a.barberId === query.barberId && query.status.$in.includes(a.status)
        && a.startAt < to && a.endAt > from) || null;
    }, create: () => { counters.appointmentWrites++; throw Error('forbidden'); },
    update: () => { counters.appointmentWrites++; throw Error('forbidden'); },
    delete: () => { counters.appointmentWrites++; throw Error('forbidden'); } },
    ...options,
  };
  const app = express();
  app.post('/api/voice/incoming', (_req, res) => res.json({ existingRoute: true }));
  app.use('/api/voice/retell', createRetellReadOnlyRouter(config));
  app.use(express.json());
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const send = (path, raw, signature, contentType = 'application/json') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path,
      headers: { 'content-type': contentType, ...(signature ? { 'x-retell-signature': signature } : {}) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, body: JSON.parse(text) });
      });
    }); req.on('error', reject); req.end(raw);
  });
  const sign = (raw, stamp = clock) => `v=${stamp},d=${createHmac('sha256', key).update(raw).update(String(stamp)).digest('hex')}`;
  const post = (tool, args = {}, override = {}) => {
    const request = { name: tool === 'context' ? 'read_business_context' : 'check_bundle_availability', call: {
      call_id: binding.callId, agent_id: binding.agentId, agent_version: binding.agentVersion, call_status: 'ongoing',
      metadata: { businessId: otherId }, transcript: 'SENTINEL_CALLER_TEXT', access_token: 'SENTINEL_SECRET' }, args,
    };
    override.change?.(request);
    const raw = override.raw ?? Buffer.from(JSON.stringify(request));
    return send(`/api/voice/retell/tools/${tool}`, raw, override.signature === false ? undefined : override.signature ?? sign(raw, override.signatureTime ?? clock), override.contentType);
  };
  const args = async extra => {
    const context = await post('context'); assert.equal(context.status, 200);
    return { serviceIds: ['service-cut-91', 'service-beard-92'], date: '2026-11-03', time: '15:00', businessRevision: context.body.businessRevision, ...extra };
  };
  t.after(() => { assert.equal(counters.appointmentWrites, 0); assert.equal(counters.sms, 0); });
  return { b, second, binding, queries, lookups, counters, audit, appointments, post, send, sign, args,
    now: value => { clock = Date.parse(value); }, config };
}

test('serialized signed context and bundle requests use trusted tenant and preserve ordered facts / zero price', async t => {
  const f = await fixture(t);
  const context = await f.post('context');
  assert.equal(context.body.data.services[1].price, 0);
  assert.equal(context.body.data.timeZone, 'America/New_York');
  assert.equal(context.body.canAuthorize, false);
  const response = await f.post('availability', await f.args());
  assert.equal(response.status, 200); assert.equal(response.body.data.available, true);
  assert.deepEqual(response.body.data.serviceIds, ['service-cut-91', 'service-beard-92']);
  assert.equal(response.body.data.durationMinutes, 45); assert.equal(response.body.data.price, 25);
  assert.equal(response.body.data.reservation, false); assert.equal(response.body.data.canAuthorize, false);
  assert.ok(f.lookups.every(id => id === businessId));
  assert.ok(f.queries.every(q => q.barberId === businessId));
  assert.equal((f.queries[0].$or[0].startAt.$lt - f.queries[0].$or[0].startAt.$gte) / 60000, 65);
  assert.equal(context.text.includes('SENTINEL'), false); assert.equal(JSON.stringify(f.audit).includes('SENTINEL'), false);
});

for (const kind of ['missing', 'wrong', 'old', 'future', 'tampered']) test(`authentication rejects ${kind} without repository access`, async t => {
  const f = await fixture(t);
  let response;
  if (kind === 'missing') response = await f.post('context', {}, { signature: false });
  else if (kind === 'wrong') response = await f.post('context', {}, { signature: `v=${initialNow},d=${'0'.repeat(64)}` });
  else if (kind === 'tampered') response = await f.post('context', {}, { signature: f.sign(Buffer.from('{}')) });
  else response = await f.post('context', {}, { signatureTime: initialNow + (kind === 'old' ? -300001 : 300001) });
  assert.equal(response.status, 401); assert.equal(f.counters.bindings, 0); assert.equal(f.lookups.length, 0);
});

test('signature fixture matches documented raw-body plus timestamp and rejects byte changes', () => {
  const raw = Buffer.from('{ "synthetic": "español" }');
  const signature = `v=${initialNow},d=${createHmac('sha256', key).update(raw).update(String(initialNow)).digest('hex')}`;
  assert.equal(verifyRetellSignature(raw, signature, key, initialNow), true);
  assert.equal(verifyRetellSignature(Buffer.from(raw.toString().replace(' ', '')), signature, key, initialNow), false);
});

for (const field of ['call_id', 'agent_id', 'agent_version', 'call_status']) test(`foreign ${field} rejects before business access`, async t => {
  const f = await fixture(t);
  const r = await f.post('context', {}, { change: request => { request.call[field] = field === 'agent_version' ? 2 : field === 'call_status' ? 'ended' : 'foreign'; } });
  assert.ok([400, 403].includes(r.status)); assert.equal(f.lookups.length, 0);
});

for (const field of ['businessId', 'status', 'mode', 'expiresAt']) test(`server binding ${field} fails closed`, async t => {
  const f = await fixture(t);
  f.binding[field] = field === 'businessId' ? '507f1f77bcf86cd799439099' : field === 'expiresAt' ? new Date(initialNow - 1).toISOString() : 'INVALID';
  const r = await f.post('context'); assert.equal(r.status, 403); assert.equal(f.lookups.length, 0);
});

test('model business IDs and mutation fields/tools are rejected, not used as authority', async t => {
  const f = await fixture(t);
  for (const tool of ['context', 'availability']) {
    const args = tool === 'context' ? {} : await f.args();
    for (const extra of [{ businessId: otherId }, { price: 1 }, { confirmed: true }, { changes: [] }])
      assert.equal((await f.post(tool, { ...args, ...extra })).status, 400);
  }
  assert.equal((await f.post('booking')).status, 404);
  assert.equal((await f.post('cancel')).status, 404);
  assert.equal((await f.post('sms')).status, 404);
});

test('bound second business never reads first business and foreign catalogue ids reject', async t => {
  const f = await fixture(t); f.binding.businessId = otherId;
  f.second.services = [{ _id: 'other-only', name: 'Other synthetic service', price: 40, durationMinutes: 60 }];
  const r = await f.post('context'); assert.deepEqual(r.body.data.services.map(s => s.id), ['other-only']);
  assert.ok(f.lookups.every(id => id === otherId));
  assert.equal((await f.post('availability', { serviceIds: ['service-cut-91'], date: '2026-11-03', time: '15:00', businessRevision: r.body.businessRevision })).body.reasonCode, 'UNKNOWN_SERVICE');
});

test('unavailable combined bundle returns only full-duration verified alternatives and ignores canceled/foreign conflicts', async t => {
  const f = await fixture(t);
  f.appointments.push({ barberId: businessId, status: 'confirmed', startAt: new Date('2026-11-03T20:40:00Z'), endAt: new Date('2026-11-03T21:00:00Z') });
  // At 15:00 EST a 30min cut fits; the 45min bundle plus buffer conflicts.
  const args = await f.args();
  assert.equal((await f.post('availability', { ...args, serviceIds: ['service-cut-91'] })).body.data.available, true);
  const r = await f.post('availability', args);
  assert.equal(r.body.data.available, false); assert.equal(r.body.data.reasonCode, 'UNAVAILABLE');
  assert.equal(r.body.data.alternatives.length, 3);
  assert.ok(f.queries.every(q => q.status.$in.join(',') === 'confirmed,pending'));
  f.appointments[0].status = 'canceled';
  f.appointments.push({ barberId: otherId, status: 'confirmed', startAt: new Date('2026-11-03T20:00:00Z'), endAt: new Date('2026-11-03T21:00:00Z') });
  assert.equal((await f.post('availability', args)).body.data.available, true);
});

for (const variant of ['closed', 'hours', 'blackout', 'past', 'equal', 'timezone']) test(`scheduling rule: ${variant}`, async t => {
  const f = await fixture(t);
  let date = '2026-11-03', time = '15:00';
  if (variant === 'closed') f.b.availability.businessHours.tue.isClosed = true;
  if (variant === 'hours') time = '17:30'; // 45min exceeds close.
  if (variant === 'blackout') f.b.availability.blackoutDates = [{ date: '2026-11-03T17:00:00Z' }];
  if (variant === 'past' || variant === 'equal') { date = '2026-10-30'; time = variant === 'equal' ? '10:00' : '09:30'; }
  if (variant === 'timezone') { f.b.availability.timezone = 'Asia/Tokyo'; f.now('2026-10-30T00:30:00Z'); date = '2026-10-30'; time = '09:00'; }
  const r = await f.post('availability', await f.args({ date, time }));
  assert.equal(r.status, 200); assert.equal(r.body.data.available, false);
  assert.ok(r.body.data.alternatives.every(a => a.date >= date));
});

for (const fact of ['price', 'durationMinutes']) test(`missing ${fact} never gets a default or releasable availability`, async t => {
  const f = await fixture(t); delete f.b.services[0][fact];
  const c = await f.post('context'); assert.equal(c.body.data.services[0][fact], null);
  const r = await f.post('availability', await f.args());
  assert.equal(r.body.status, 'UNSUPPORTED'); assert.equal(r.body.reasonCode, 'MISSING_CATALOGUE_FACTS');
  assert.equal(f.queries.length, 0);
});

test('missing IDs use stable nonpersisted handles; existing IDs/disabled services/order preserved', async t => {
  const f = await fixture(t); delete f.b.services[0]._id; f.b.services.push({ _id: 'disabled', name: 'Disabled', enabled: false });
  const c = await f.post('context'), d = await f.post('context');
  assert.match(c.body.data.services[0].id, /^legacy:/); assert.deepEqual(c.body.data.services, d.body.data.services);
  assert.equal(c.body.data.services[1].id, 'service-beard-92'); assert.equal(c.body.data.services.length, 2);
  assert.equal(f.b.services[0]._id, undefined);
});

test('stale business revision, malformed/duplicate bundles and impossible dates remain rejected', async t => {
  const f = await fixture(t), args = await f.args();
  f.b.services[0].price = 26;
  assert.equal((await f.post('availability', args)).body.reasonCode, 'BUSINESS_CHANGED');
  const current = await f.args();
  assert.equal((await f.post('availability', { ...current, serviceIds: ['service-cut-91', 'service-cut-91'] })).status, 400);
  for (const date of ['2026-11-31', '2026-12-20']) assert.equal((await f.post('availability', { ...current, date })).body.reasonCode, 'INVALID_SLOT');
});

test('binding revoked during read and business changes during conflict lookup withhold response', async t => {
  const f = await fixture(t); const original = f.config.businessRepository.findById;
  f.config.businessRepository.findById = async id => { const b = await original(id); f.binding.revision++; return b; };
  assert.equal((await f.post('context')).status, 403);
  f.config.businessRepository.findById = original;
  const args = await f.args();
  f.config.appointmentRepository.findConflict = async () => { f.b.services[0].price++; return null; };
  assert.equal((await f.post('availability', args)).body.reasonCode, 'BUSINESS_CHANGED');
});

test('request deadline withholds late work and prevents additional repository reads', async t => {
  let resolve;
  const gate = new Promise(r => { resolve = r; });
  let reads = 0;
  const f = await fixture(t, { deadlineMs: 20, businessRepository: { findById: async () => { reads++; await gate; return business(); } } });
  const r = await f.post('context'); assert.equal(r.status, 503); assert.equal(r.body.reasonCode, 'READ_DEADLINE');
  resolve(); await new Promise(r => setTimeout(r, 10)); assert.equal(reads, 1);
});

test('repository exceptions, raw envelopes and privacy sentinels never reach responses/audit', async t => {
  const f = await fixture(t, { businessRepository: { findById: async () => { throw Error('SENTINEL_SECRET authorization Bearer SENTINEL_RAW'); } } });
  const r = await f.post('context'); assert.equal(r.status, 503); assert.equal(r.body.reasonCode, 'READ_UNAVAILABLE');
  assert.equal(r.text.includes('SENTINEL'), false); assert.equal(JSON.stringify(f.audit).includes('SENTINEL'), false);
});

test('disabled-by-default adapter has no dependency access; existing phone route and server wiring unchanged', async t => {
  const f = await fixture(t, { enabled: undefined });
  assert.equal((await f.post('context')).status, 404); assert.equal(f.counters.bindings, 0);
  assert.equal((await f.send('/api/voice/incoming', '{}')).body.existingRoute, true);
  const serverSource = await readFile(new URL('../../server.js', import.meta.url), 'utf8');
  assert.match(serverSource, /await mountRetellStartup\(app\)/);
  assert.ok(serverSource.indexOf('await mountRetellStartup(app)') < serverSource.indexOf('app.use(express.json'));
  for (const path of ['../../routes/retellReadOnlyRoutes.js', '../../services/voice/retell/ReadOnlyBusinessTools.js']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /StructuredPhoneDriver|PhoneModelTransport|FixtureBusiness|sendAppointment|createAppointment|process\.env/);
  }
});

test('EN/ES templates serialize exactly two read-only tool schemas and remain unprovisioned', () => {
  for (const language of ['en', 'es']) {
    const template = JSON.parse(JSON.stringify(retellReadOnlyAgentTemplate(language)));
    assert.equal(template.provisioningStatus, 'UNPROVISIONED'); assert.equal(template.language, language);
    assert.equal(template.tools.length, 2);
    for (const tool of template.tools) {
      assert.equal(tool.parameters.type, 'object'); assert.equal(tool.parameters.additionalProperties, false);
      assert.equal(tool.args_at_root, false); assert.equal(tool.max_retry, 0); assert.match(tool.url, /^https:\/\/retell-tools\.invalid\//);
      assert.equal(Object.hasOwn(tool.parameters.properties, 'businessId'), false);
    }
  }
});

test('Spanish call uses only explicit trusted labels; unknown translations retain canonical names', async t => {
  const f = await fixture(t); f.binding.language = 'es';
  f.b.services[0].localizedLabels = { es: 'corte de pelo' };
  const r = await f.post('context');
  assert.deepEqual(r.body.data.services.map(s => s.label), ['corte de pelo', 'Beard Trim']);
  assert.equal((await f.post('availability', await f.args())).body.data.available, true);
});

test('raw-body boundary rejects malformed JSON, invalid UTF8, parsed bodies and oversized envelopes', async t => {
  const f = await fixture(t);
  for (const raw of [Buffer.from('{'), Buffer.from([0xff]), Buffer.from('x'.repeat(129 * 1024))]) {
    const r = await f.post('context', {}, { raw }); assert.ok([400, 413].includes(r.status));
  }
  assert.equal((await f.post('context', {}, { contentType: 'text/plain' })).status, 401);
  assert.equal(f.lookups.length, 0);
});

test('clock crossing requested slot during the final binding read prevents stale release', async t => {
  const f = await fixture(t), args = await f.args({ date: '2026-10-30', time: '10:30' });
  let reads = 0;
  f.config.callBindings.findByProviderCallId = async () => {
    if (++reads === 2) f.now('2026-10-30T14:31:00Z');
    return f.binding;
  };
  const r = await f.post('availability', args);
  assert.equal(r.status, 409); assert.equal(r.body.reasonCode, 'READ_STALE');
});

test('alternatives changing during discovery are rechecked rather than exported as valid', async t => {
  const f = await fixture(t);
  f.b.availability.businessHours.tue.isClosed = true;
  const original = f.config.appointmentRepository.findConflict;
  let checks = 0;
  f.config.appointmentRepository.findConflict = async query => {
    if (++checks > 3) return { _id: 'synthetic-conflict' };
    return original(query);
  };
  const r = await f.post('availability', await f.args());
  assert.equal(r.body.data.available, false); assert.deepEqual(r.body.data.alternatives, []);
});

test('pending and buffer-only overlaps reject; an exact buffer boundary remains available', async t => {
  const f = await fixture(t), args = await f.args();
  const appointment = { barberId: businessId, status: 'pending', startAt: new Date('2026-11-03T20:54:00Z'), endAt: new Date('2026-11-03T21:10:00Z') };
  f.appointments.push(appointment);
  assert.equal((await f.post('availability', args)).body.data.available, false);
  appointment.startAt = new Date('2026-11-03T20:55:00Z');
  assert.equal((await f.post('availability', args)).body.data.available, true);
});

test('DST nonexistent and ambiguous local times reject without guessing an instant', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('availability', await f.args({ date: '2026-11-01', time: '01:30' }))).body.reasonCode, 'INVALID_SLOT');
  f.now('2027-03-12T14:00:00Z'); f.binding.expiresAt = '2027-03-20T14:00:00Z';
  assert.equal((await f.post('availability', await f.args({ date: '2027-03-14', time: '02:30' }))).body.reasonCode, 'INVALID_SLOT');
});

test('hung repository capacity stays bounded after deadlines; late reads cannot fan out', async t => {
  let resolve, reads = 0;
  const gate = new Promise(r => { resolve = r; });
  const f = await fixture(t, { deadlineMs: 10, businessRepository: { findById: async () => { reads++; await gate; return business(); } } });
  const first = await Promise.all(Array.from({ length: 32 }, () => f.post('context')));
  assert.ok(first.every(r => r.status === 503));
  assert.equal((await f.post('context')).status, 429); assert.equal(reads, 32);
  resolve(); await new Promise(r => setTimeout(r, 10)); assert.equal(reads, 32);
  assert.equal((await f.post('context')).status, 200);
});

for (const defect of ['duplicate id', 'duplicate name', 'missing name', 'missing timezone', 'invalid blackout'])
  test(`unsupported business data: ${defect}`, async t => {
    const f = await fixture(t);
    if (defect === 'duplicate id') f.b.services[1]._id = f.b.services[0]._id;
    if (defect === 'duplicate name') f.b.services[1].name = f.b.services[0].name;
    if (defect === 'missing name') delete f.b.services[0].name;
    if (defect === 'missing timezone') delete f.b.availability.timezone;
    if (defect === 'invalid blackout') f.b.availability.blackoutDates = [{ date: null }];
    const r = await f.post('context'); assert.equal(r.status, 409); assert.equal(f.queries.length, 0);
  });

test('call closure during the final business read cannot release a previously valid result', async t => {
  const f = await fixture(t); let reads = 0;
  f.config.businessRepository.findById = async () => {
    if (++reads === 2) f.binding.status = 'ENDED';
    return f.b;
  };
  const r = await f.post('context'); assert.equal(r.status, 403); assert.equal(r.body.reasonCode, 'CALL_NOT_AUTHORIZED');
});
