import test from 'node:test';
import assert from 'node:assert/strict';
import { createRetellRegistrationTransport } from '../../services/voice/retell/RegistrationTransport.js';

const secret = 'SYNTHETIC_SECRET_NOT_REAL';
const payload = { agent_id: 'agent_en', agent_version: 3, direction: 'inbound', metadata: { glo_registration_attempt: '12345678-1234-1234-1234-123456789abc' } };
const valid = { call_type: 'phone_call', call_id: 'call_synthetic', agent_id: 'agent_en', agent_version: 3, call_status: 'registered' };
function fixture(reply, options = {}) {
  const requests = [];
  const transport = createRetellRegistrationTransport({ enabled: true, apiKey: secret, deadlineMs: 20,
    http: async (url, init) => { requests.push({ url, init }); return reply(init); }, ...options });
  return { transport, requests, run: controls => transport.registerPhoneCall(structuredClone(payload), controls) };
}
test('exact serialized registration method/endpoint/fields and pinned version, safe response projection', async () => {
  const f = fixture(() => new Response(JSON.stringify({ ...valid, transcript: secret, metadata: { secret } }), { status: 201 }));
  assert.deepEqual(await f.run(), { call_id: valid.call_id, agent_id: valid.agent_id, agent_version: 3, call_status: 'registered' });
  assert.equal(f.requests.length, 1);
  const { url, init } = f.requests[0];
  assert.equal(url, 'https://api.retellai.com/v2/register-phone-call'); assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, `Bearer ${secret}`);
  assert.equal(init.body, JSON.stringify(payload));
});
for (const [name, change] of Object.entries({ foreign_agent: { agent_id: 'foreign' }, version: { agent_version: 4 },
  wrong_type: { call_type: 'web_call' }, missing_id: { call_id: null }, status: { call_status: 'ongoing' } }))
  test(`invalid response ${name} rejects with no retry and no arbitrary fields`, async () => {
    const f = fixture(() => new Response(JSON.stringify({ ...valid, ...change, error: secret })));
    await assert.rejects(f.run(), e => e.code === 'RETELL_REGISTRATION_OUTCOME_UNKNOWN' && !String(e).includes(secret));
    assert.equal(f.requests.length, 1);
  });
for (const mode of ['http_error','malformed_json','oversized','network_error','headers_timeout','body_timeout'])
  test(`${mode} is bounded, sanitized and never retried`, async () => {
    const f = fixture(() => {
      if (mode === 'http_error') return new Response(secret, { status: 429 });
      if (mode === 'malformed_json') return new Response(secret);
      if (mode === 'oversized') return new Response('x'.repeat(65537));
      if (mode === 'network_error') throw Error(secret);
      if (mode === 'headers_timeout') return new Promise(() => {});
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }));
    });
    const started = performance.now();
    await assert.rejects(f.run(), e => e.code === 'RETELL_REGISTRATION_OUTCOME_UNKNOWN' && !String(e).includes(secret));
    assert.ok(performance.now() - started < 1000); assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].init.signal.aborted, true);
  });
test('external cancellation and cancellation before dispatch', async () => {
  const f = fixture(() => new Promise(() => {}), { deadlineMs: 1000 });
  const c = new AbortController(); const pending = f.run({ signal: c.signal }); c.abort();
  await assert.rejects(pending); assert.equal(f.requests.length, 1);
  await assert.rejects(f.run({ signal: c.signal })); assert.equal(f.requests.length, 1);
});
test('disabled transport never evaluates credential getter or invokes HTTP', async () => {
  // apiKey is an injected value, never read from the process environment.
  let requests = 0;
  const t = createRetellRegistrationTransport({ http: () => { requests++; } });
  await assert.rejects(t.registerPhoneCall(payload), /RETELL_TRANSPORT_DISABLED/); assert.equal(requests, 0);
});
test('structurally invalid request rejects before dispatch', async () => {
  const f = fixture(() => new Response(JSON.stringify(valid)));
  await assert.rejects(f.transport.registerPhoneCall({ ...payload, businessId: 'foreign' }), /REQUEST_INVALID/);
  assert.equal(f.requests.length, 0);
});
