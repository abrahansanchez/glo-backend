import test from 'node:test';
import assert from 'node:assert/strict';
import { StructuredPhoneFailure } from '../../diagnostics/StructuredPhoneFailure.js';
import { CallOutcomeDiagnosis } from '../../diagnostics/CallOutcomeDiagnosis.js';
import { StructuredPhoneDriver } from '../../experiments/structured-phone/StructuredPhoneDriver.js';
import { PHONE_LIMITS } from '../../experiments/structured-phone/PhoneContracts.js';
import { PhoneModelTransport } from '../../experiments/structured-phone/PhoneModelTransport.js';
import { FakeSocket } from '../helpers/FakeSocket.js';
import { execFileSync } from 'node:child_process';
import { harness, decide, seedScript, settle } from './structured-phone-harness.js';

const failure = f => f.emitted.filter(e => e.event === 'V2_STRUCTURED_PHONE_FAILURE');
const secret = 'PRIVATE_EXCEPTION sk-PRIVATE_KEY Bearer PRIVATE_AUTH +15559998888 PRIVATE_NAME PRIVATE_TRANSCRIPT';
const cases = [
  ['business', 'BUSINESS_READ', 'readBusiness'], ['catalogue', 'CATALOGUE_VALIDATION', 'readBusiness'],
  ['context', 'CONTEXT_CONSTRUCTION', 'buildDecisionContext'], ['connection', 'DECISION_CONNECTION', 'constructDecisionConnection'],
  ['configuration', 'DECISION_CONFIGURATION', 'receiveProviderError'], ['model', 'MODEL_REQUEST', 'createDecisionRequest'],
  ['json', 'DECISION_VALIDATION', 'parseDecisionJson'], ['schema', 'DECISION_VALIDATION', 'validateDecisionSchema'],
  ['multiple', 'DECISION_VALIDATION', 'validateDecisionSchema'],
  ['mutation', 'DRAFT_MUTATION', 'applyDraftChanges'],
  ['alternative', 'ALTERNATIVE_RESOLUTION', 'resolveAlternative'], ['availability', 'AVAILABILITY', 'checkBundleAvailability'], ['render', 'RENDERING', 'renderApplicationResponse'],
  ['synthesis', 'SYNTHESIS', 'synthesizeSpeech'], ['media', 'MEDIA_SUBMISSION', 'submitTwilioMedia'], ['mark', 'MARK_HANDLING', 'sendPlaybackMark'],
];
for (const [kind, stage, operation] of cases) test(`first structured cause: ${kind}`, async () => {
  const f = await harness({ wire: kind === 'configuration',
    wireConfigurationError: kind === 'configuration' ? { code: 'invalid_function_parameters', type: 'invalid_request_error', param: 'session.tools[0].parameters', message: secret } : null,
    onCreateModel: kind === 'connection' ? () => { throw Error(secret); } : null,
    beforeSpeech: kind === 'synthesis' ? async r => { if (r.input.includes('Synthetic Tester')) throw Error(secret); } : null,
    script: m => {
      if (kind === 'model') throw Error(secret);
      if (kind === 'json') return [{ name: 'submit_turn_decision', raw: '{' }];
      if (kind === 'schema') return [decide({ ...m.binding, arbitrary: secret })];
      if (kind === 'multiple') return [...seedScript(m), ...seedScript(m)];
      if (kind === 'binding') return [decide({ ...m.binding, turnId: 'CA-foreign:turn:1' })];
      if (kind === 'eligibility') return [decide({ ...m.binding, intent: 'UNSUPPORTED' })];
      if (kind === 'alternative' && m.turn === 2) return [decide({ ...m.binding, changes: [{ kind: 'SELECT_ALTERNATIVE', alternativeId: 'foreign' }] })];
      return seedScript(m);
    } });
  try {
    if (kind === 'business') f.availability.read = async () => { throw Error(secret); };
    if (kind === 'catalogue') f.raw.services = [];
    if (kind === 'context') f.availability.label = () => { throw Error(secret); };
    if (kind === 'mutation') f.app.session.replaceProposal = () => { throw Error(secret); };
    if (kind === 'availability') f.availability.check = async () => { throw Error(secret); };
    if (kind === 'render') {
      let labels = 0; const label = f.availability.label.bind(f.availability);
      f.availability.label = (...args) => { if (++labels === 5) throw Error(secret); return label(...args); };
    }
    if (kind === 'media' || kind === 'mark') {
      const send = f.twilio.send.bind(f.twilio);
      f.twilio.send = raw => { if (JSON.parse(raw).event === kind) throw Error(secret); return send(raw); };
    }
    if (kind === 'alternative') { await f.turn('Prime current alternatives'); await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name); }
    const previousRequests = f.requests.length; await f.turn('PRIVATE_TRANSCRIPT'); await settle(f.app);
    assert.equal(failure(f).length, 1);
    const first = structuredClone(failure(f)[0]);
    if (kind === 'business' || kind === 'eligibility') console.log(JSON.stringify({ sample: kind === 'business' ? 'thrown_error' : 'guard_rejection', record: first }));
    assert.equal(first.stage, stage); assert.equal(first.operation, operation); assert.notEqual(first.lastCompletedBoundary, 'UNKNOWN');
    if (kind === 'multiple') { assert.equal(first.guard, 'ONE_DECISION_REQUIRED'); assert.equal(first.configuredLimit, 1); }
    assert.ok(first.trail.length); assert.ok(first.terminationRequestedBy || ['synthesis', 'media', 'mark'].includes(kind));
    assert.equal(first.counters.modelRequestStartedForTurn, !['business', 'catalogue', 'context', 'connection', 'configuration'].includes(kind));
    assert.ok(f.requests.length - previousRequests <= 1); assert.equal(f.executorCalls, 0);
    await f.app.terminate('TEST_DONE'); f.twilio.emit('error', Error(secret)); await settle(f.app);
    assert.equal(failure(f).length, 1); assert.deepEqual(failure(f)[0], first);
    for (const e of f.emitted.filter(e => e.event?.startsWith('V2_STRUCTURED_PHONE_') && ['FAILURE', 'SECONDARY', 'BOUNDARY', 'TERMINATION_REQUESTED'].some(suffix => e.event.endsWith(suffix)))) {
      const json = JSON.stringify(e); assert.ok(Buffer.byteLength(json) <= 4096);
      for (const sentinel of secret.split(' ')) assert.ok(!json.includes(sentinel), sentinel);
    }
    const summary = f.emitted.find(e => e.traceEvent === 'CALL_SUMMARY');
    assert.equal(summary.primaryFailureBoundary, first.stage); assert.equal(summary.primaryFailureLastSuccessfulBoundary, first.lastCompletedBoundary);
    assert.equal(summary.primaryFailureReasonCode, first.reasonCode);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('first failure is immutable, bounded, precedes cleanup, and never retains arbitrary error/provider fields', () => {
  let time = 0; const events = [], d = new StructuredPhoneFailure({ callSid: 'CA-test', emit: e => events.push(e), clock: () => time });
  d.admitted('CA-test:turn:1', 'item_current'); d.decisionStarted();
  for (let i = 0; i < 600; i++) d.done('CONTEXT_CONSTRUCTION', 'buildDecisionContext');
  d.start('BUSINESS_READ', 'readBusiness'); time = 20000; d.deadline('FIRED');
  d.failure(Error(secret), { reasonCode: 'DECISION_DEADLINE_EXPIRED', guard: 'decisionMs', limit: 20000,
    terminationRequestedBy: { function: 'decisionDeadline', reasonCode: 'STRUCTURED_DECISION_TIMEOUT' }, provider: { message: secret, headers: { Authorization: secret } } });
  const first = d.first; d.cancel('CLOSED'); d.start('CLEANUP', 'cleanup'); d.failure(Error('PHONE_MODEL_CONNECTION_CLOSED'));
  assert.deepEqual(d.first, first); assert.equal(events.filter(e => e.event === 'V2_STRUCTURED_PHONE_FAILURE').length, 1);
  assert.equal(first.elapsedDecisionMs, 20000); assert.equal(first.deadlineState, 'FIRED'); assert.equal(first.stage, 'BUSINESS_READ');
  assert.ok(first.trail.length <= 12); assert.ok(!JSON.stringify(events).includes('PRIVATE')); assert.ok(events.every(e => Buffer.byteLength(JSON.stringify(e)) <= 4096));
  console.log(JSON.stringify(first));
});

for (const mode of ['interruption', 'stale', 'retired callback']) test(`expected ${mode} is not a structured system failure`, async () => {
  let release, held = false;
  const f = await harness({ beforeSpeech: mode === 'stale' ? async r => { if (r.input.includes('Synthetic Tester')) f.raw.services[0].price++; } : null,
    script: mode !== 'stale' ? async m => { if (!held) { held = true; await new Promise(resolve => { release = resolve; }); } return seedScript(m); } : seedScript });
  try {
    await f.turn();
    if (mode !== 'stale') { f.input.receive({ type: 'input_audio_buffer.speech_started', item_id: 'item_new', audio_start_ms: 0 }); await settle(f.app); release?.(); }
    if (mode === 'retired callback') { const old = f.models[0]; await f.turn(); old.onFailure(Error(secret)); }
    await settle(f.app); assert.equal(failure(f).length, 0); assert.equal(f.executorCalls, 0);
    assert.ok(f.emitted.some(e => e.event === 'V2_STRUCTURED_PHONE_SECONDARY'));
    if (mode === 'interruption') console.log(JSON.stringify({ sample: 'cancellation_not_failure', record: f.emitted.find(e => e.event === 'V2_STRUCTURED_PHONE_SECONDARY' && e.reasonCode === 'CALLER_SPEECH') }));
  } finally { release?.(); await f.app.terminate('TEST_DONE'); }
});

for (const [field, code, limit] of [['turns', 'TURN_LIMIT', PHONE_LIMITS.turns], ['requests', 'MODEL_REQUEST_LIMIT', PHONE_LIMITS.modelRequests], ['connections', 'CONNECTION_LIMIT', PHONE_LIMITS.decisionConnections]]) test(`actual driver limit diagnostic ${field}`, async () => {
  const f = await harness(); const records = [], terminated = [];
  const diagnostics = new StructuredPhoneFailure({ callSid: 'CA-limit', emit: e => records.push(e) });
  const d = new StructuredPhoneDriver({ session: f.app.session, businessContext: { timeZone: 'America/New_York' }, availability: f.availability,
    createModel: () => ({ ready: Promise.resolve(), close() {}, request() { assert.fail('guard allowed model request'); } }), replace() {}, speak() {},
    terminate: reason => terminated.push(reason), emit() {}, diagnostics }); d[field] = limit;
  try {
    await d.turn({ turnId: 'CA-limit:turn:1', transcript: 'PRIVATE', authority: null });
    const event = records.find(e => e.event === 'V2_STRUCTURED_PHONE_FAILURE'); assert.equal(event.reasonCode, code); assert.equal(event.configuredLimit, limit);
    assert.equal(event.counters.modelRequestStartedForTurn, false); assert.deepEqual(terminated, ['STRUCTURED_PHONE_FAILED']);
  } finally { d.close(); await f.app.terminate('TEST_DONE'); }
});

test('actual 20-second driver deadline can expire in business read before any model request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0; const events = [], terminated = [];
  const d = new StructuredPhoneDriver({ session: { callSid: 'CA-timeout', proposal: { proposalVersion: 1 } }, businessContext: {},
    availability: { read: () => new Promise(() => {}) }, createModel: () => assert.fail('connection before read'),
    terminate: r => terminated.push(r), emit() {}, diagnostics: new StructuredPhoneFailure({ callSid: 'CA-timeout', clock: () => clock, emit: e => events.push(e) }) });
  void d.turn({ turnId: 'CA-timeout:turn:1', transcript: 'PRIVATE' }); clock = 20000; t.mock.timers.tick(20000);
  const event = events.find(e => e.event === 'V2_STRUCTURED_PHONE_FAILURE');
  assert.equal(event.reasonCode, 'DECISION_DEADLINE_EXPIRED'); assert.equal(event.operation, 'readBusiness'); assert.equal(event.deadlineState, 'FIRED');
  assert.equal(event.counters.modelRequestStartedForTurn, false); assert.deepEqual(terminated, ['STRUCTURED_DECISION_TIMEOUT']); d.close();
  console.log(JSON.stringify({ sample: 'timeout', record: event }));
});

test('cleanup without an initiating fault is secondary only', () => {
  const events = [], d = new StructuredPhoneFailure({ callSid: 'CA-clean', emit: e => events.push(e) });
  d.start('CLEANUP', 'cleanup'); d.failure(Error(secret));
  assert.equal(d.first, null); assert.ok(!events.some(e => e.event === 'V2_STRUCTURED_PHONE_FAILURE'));
});

test('model request deadline records the same pending request without a retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await harness(), events = [], terminated = []; let attempts = 0;
  const d = new StructuredPhoneDriver({ session: f.app.session, businessContext: { timeZone: 'America/New_York' }, availability: f.availability,
    createModel: () => ({ ready: Promise.resolve(), close() {}, request() { attempts++; return new Promise(() => {}); } }),
    replace() {}, speak() {}, terminate: reason => terminated.push(reason), emit() {}, diagnostics: new StructuredPhoneFailure({ callSid: 'CA-model-timeout', emit: e => events.push(e) }) });
  try {
    void d.turn({ turnId: 'CA-model-timeout:turn:1', transcript: 'PRIVATE' });
    await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(20000);
    const first = events.find(e => e.event === 'V2_STRUCTURED_PHONE_FAILURE');
    assert.equal(first.stage, 'MODEL_REQUEST'); assert.equal(first.operation, 'createDecisionRequest'); assert.equal(first.counters.modelRequestStartedForTurn, true);
    assert.equal(attempts, 1); assert.deepEqual(terminated, ['STRUCTURED_DECISION_TIMEOUT']);
  } finally { d.close(); await f.app.terminate('TEST_DONE'); }
});

test('decision deadline is cleared after completed work and after retirement without adding a timer owner', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await harness(), events = [], terminated = [];
  const d = new StructuredPhoneDriver({ session: f.app.session, businessContext: { timeZone: 'America/New_York' }, availability: f.availability,
    createModel: () => ({ ready: Promise.resolve(), close() {}, request: async input => ({ calls: [{ name: 'submit_turn_decision', callId: 'call-1', argumentsJson: JSON.stringify(decide({ ...input.context.binding, intent: 'CLARIFY', missingField: 'service' }).args) }] }), toolResult() {} }),
    replace() {}, speak: async () => ({ accepted: true }), terminate: reason => terminated.push(reason), emit() {},
    diagnostics: new StructuredPhoneFailure({ callSid: 'CA-complete', emit: e => events.push(e) }) });
  try {
    await d.turn({ turnId: 'CA-complete:turn:1', transcript: 'PRIVATE' }); t.mock.timers.tick(20000);
    assert.deepEqual(terminated, []); assert.equal(events.some(e => e.event === 'V2_STRUCTURED_PHONE_FAILURE'), false);
    d.interrupt(); t.mock.timers.tick(20000); assert.deepEqual(terminated, []);
  } finally { d.close(); await f.app.terminate('TEST_DONE'); }
});

test('all existing summary fields agree with committed aggregator except the two explicitly enriched boundaries', async () => {
  const source = execFileSync('git', ['show', '970cad63cda8edb776b5ba5fab35ab66eab6850f:realtime/voice-v2/diagnostics/CallOutcomeDiagnosis.js'], { encoding: 'utf8' });
  const Baseline = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).CallOutcomeDiagnosis;
  for (const entries of [[], [{ event: 'STRUCTURED_DECISION_FAILED' }], [{ event: 'SESSION_OPERATION_FAILED' }], [{ traceEvent: 'CALLER_TRANSCRIPTION_COMPLETED', empty: true }]]) {
    const baseline = new Baseline(), current = new CallOutcomeDiagnosis();
    for (const entry of entries) { baseline.observe(entry); current.observe(entry); }
    if (entries[0]?.event === 'STRUCTURED_DECISION_FAILED') current.structuredFailure({ event: 'V2_STRUCTURED_PHONE_FAILURE', stage: 'BUSINESS_READ', lastCompletedBoundary: 'TURN_ADMISSION', reasonCode: 'UNKNOWN' });
    const base = { event: 'V2_CALL_TRACE', traceEvent: 'CALL_SUMMARY', sequence: 91, elapsedMs: 1200, appointmentId: 'retained-id', finalOutcome: 'UNKNOWN', callerTurnCount: 3 };
    const old = baseline.summary(base), now = current.summary(base);
    assert.deepEqual(Object.keys(now).filter(k => k !== 'primaryFailureReasonCode').sort(), Object.keys(old).sort());
    for (const [key, value] of Object.entries(old)) if (!['primaryFailureBoundary', 'primaryFailureLastSuccessfulBoundary'].includes(key)) assert.deepEqual(now[key], value, key);
  }
});

test('existing experimental effect refusal is recorded before its unchanged stop, with zero executor calls', async () => {
  const f = await harness();
  try {
    f.app.session.effectQueue.enqueue({ type: 'CREATE_APPOINTMENT', commandId: 'forbidden', proposalVersion: 1 });
    f.app.processEffects(); await settle(f.app);
    assert.equal(failure(f)[0].guard, 'EXPERIMENTAL_EFFECT_REFUSED'); assert.equal(failure(f)[0].operation, 'rejectExperimentalEffects');
    assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.executorCalls, 0); assert.equal(f.requests.length, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('unexpected intake model audio still follows the existing stop and records no audio payload', async () => {
  const f = await harness({ wire: true });
  try {
    assert.equal(f.app.openai.createResponse({ requestId: 'unexpected-request', response: {} }).accepted, true);
    f.input.receive({ type: 'response.created', response: { id: 'unexpected' } });
    f.input.receive({ type: 'response.audio.delta', response_id: 'unexpected', delta: Buffer.from(secret).toString('base64') });
    await settle(f.app);
    assert.equal(f.app.lifecycle.terminated, true); assert.equal(failure(f)[0].guard, 'UNEXPECTED_MODEL_OUTPUT');
    assert.ok(!JSON.stringify(failure(f)[0]).includes('PRIVATE')); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('call limit preserves its existing termination policy and records first cause before cleanup', async () => {
  const tasks = new Map(), scheduler = { schedule(fn, ms) { tasks.set(ms, fn); return fn; }, cancel(fn) { for (const [k, v] of tasks) if (v === fn) tasks.delete(k); } };
  const f = await harness({ scheduler });
  try {
    tasks.get(PHONE_LIMITS.callMs)(); await settle(f.app); const first = failure(f)[0];
    assert.equal(first.reasonCode, 'CALL_LIMIT'); assert.equal(first.configuredLimit, PHONE_LIMITS.callMs);
    assert.equal(first.counters.modelRequestStartedForTurn, false); assert.equal(f.app.lifecycle.terminated, true);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('summary keeps every unrelated existing field and ignores later structured replacements', () => {
  const base = { event: 'V2_CALL_TRACE', traceEvent: 'CALL_SUMMARY', appointmentId: 'appointment-unchanged', finalOutcome: 'UNKNOWN', finalProposalVersion: 2, availabilityEffectCount: 0 };
  const old = new CallOutcomeDiagnosis().summary(base), d = new CallOutcomeDiagnosis();
  d.structuredFailure({ event: 'V2_STRUCTURED_PHONE_FAILURE', stage: 'BUSINESS_READ', lastCompletedBoundary: 'TURN_ADMISSION', reasonCode: 'UNKNOWN' });
  d.structuredFailure({ event: 'V2_STRUCTURED_PHONE_FAILURE', stage: 'CLEANUP', lastCompletedBoundary: 'CLEANUP', reasonCode: 'PHONE_MODEL_CONNECTION_CLOSED' });
  const current = d.summary(base);
  for (const [key, value] of Object.entries(old)) if (!['primaryFailureBoundary', 'primaryFailureLastSuccessfulBoundary', 'primaryFailureReasonCode'].includes(key)) assert.deepEqual(current[key], value, key);
  assert.equal(current.primaryFailureBoundary, 'BUSINESS_READ'); assert.equal(current.primaryFailureLastSuccessfulBoundary, 'TURN_ADMISSION');
});

test('speech request ceiling records the existing guard without making another model decision', async () => {
  const f = await harness();
  try {
    for (let i = 0; i < PHONE_LIMITS.speechRequests; i++) {
      await f.app.requestResponse({ purpose: 'ASK_SERVICE', proposalVersion: f.app.session.proposal.proposalVersion, language: 'en', critical: true, expectsCallerInput: true,
        speechContract: { applicationOwnedSpeech: true, requiredMessage: 'Which service would you like?' } });
      await settle(f.app);
      if (f.app.lifecycle.terminated) break;
      await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    }
    const first = failure(f)[0]; assert.ok(first); assert.equal(first.reasonCode, 'SPEECH_REQUEST_LIMIT');
    assert.equal(first.guard, 'speechRequests'); assert.equal(first.configuredLimit, 16); assert.equal(first.counters.speechRequests, 17);
    assert.equal(f.requests.length, 0); assert.equal(f.app.lifecycle.terminated, true); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const response of ['failed', 'incomplete', 'empty', 'multiple']) test(`wire first cause before socket cleanup: ${response}`, async () => {
  const events = [], socket = new FakeSocket(), d = new StructuredPhoneFailure({ callSid: 'CA-wire', emit: e => events.push(e) });
  d.admitted('CA-wire:turn:1', 'item_current'); d.decisionStarted(); d.update({ modelRequestStartedForTurn: true });
  const transport = new PhoneModelTransport(socket, [], 'gpt-realtime', () => {}, d.owned(() => true));
  socket.open(); socket.receive({ type: 'session.updated', session: socket.sent[0].session }); await transport.ready;
  const pending = transport.request({ callerText: 'PRIVATE_TRANSCRIPT', context: {} });
  const request = socket.sent.find(p => p.type === 'response.create');
  socket.receive({ type: 'response.created', response: { id: 'resp_1', metadata: request.response.metadata } });
  if (response === 'multiple') {
    // Transport accepts the existing up-to-eight envelope; driver owns the one-function guard.
    socket.receive({ type: 'response.done', response: { id: 'resp_1', status: 'completed', output: [1, 2].map(i => ({ type: 'function_call', call_id: `call-${i}`, name: 'submit_turn_decision', arguments: '{}' })) } });
    assert.equal((await pending).calls.length, 2); assert.equal(events.some(e => e.event === 'V2_STRUCTURED_PHONE_FAILURE'), false); transport.close(); return;
  }
  socket.receive({ type: 'response.done', response: { id: 'resp_1', status: response === 'empty' ? 'completed' : response, output: [] } });
  await assert.rejects(pending); assert.equal(d.first.stage, 'MODEL_RESPONSE'); assert.equal(d.first.operation, 'validateResponseCompletion');
  assert.equal(d.first.guard, response === 'empty' ? 'FUNCTION_CALLS_MISSING' : 'RESPONSE_NOT_COMPLETED');
  const first = events.findIndex(e => e.event === 'V2_STRUCTURED_PHONE_FAILURE'), secondary = events.findIndex(e => e.event === 'V2_STRUCTURED_PHONE_SECONDARY');
  assert.ok(first >= 0 && secondary > first); assert.equal(d.first.outboundContext.currentTranscriptItemId, 'item_current');
  assert.deepEqual(d.first.outboundContext.sourceItemIds, ['item_current']); assert.equal(d.first.outboundContext.submittedCallerItemCount, 1);
});

test('quarantined source items do not enter separate decision context; context is sent in accepted arrival order', async () => {
  const f = await harness({ wire: true, script: m => {
    if (m.turn === 2) return [{ name: 'submit_turn_decision', args: { ...m.binding, arbitrary: secret } }];
    return seedScript(m);
  } });
  try {
    f.input.receive({ type: 'input_audio_buffer.speech_started', item_id: 'item_old', audio_start_ms: 0 });
    f.input.receive({ type: 'input_audio_buffer.speech_started', item_id: 'item_new', audio_start_ms: 50 });
    f.input.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_old', transcript: 'PRIVATE_QUARANTINED' }); await settle(f.app);
    f.input.receive({ type: 'input_audio_buffer.speech_stopped', item_id: 'item_new', audio_end_ms: 100 });
    f.input.receive({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_new', transcript: 'PRIVATE_CURRENT' }); await settle(f.app);
    await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name);
    await f.turn('PRIVATE_FOLLOWUP');
    const first = failure(f)[0]; assert.ok(first); assert.equal(first.outboundContext.quarantinedItemCount, 1);
    assert.equal(first.outboundContext.quarantinedItemsIncluded, false); assert.deepEqual(first.outboundContext.sourceItemIds.slice(0, 1), ['item_new']);
    assert.equal(first.outboundContext.submittedCallerItemCount, 2); assert.equal(first.outboundContext.submittedToolResultCount, 1);
    const userPackets = f.models[0].socket.sent.filter(p => p.item?.role === 'user');
    assert.equal(userPackets.length, 2); assert.ok(!JSON.stringify(userPackets).includes('PRIVATE_QUARANTINED'));
    assert.equal(JSON.parse(userPackets[0].item.content[0].text).callerText, 'PRIVATE_CURRENT');
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('observer faults leave current-contract actions, payloads and hangup reasons unchanged', async () => {
  // Contract semantics intentionally changed; compare observer enabled/disabled against the same current contract.
  const Baseline = StructuredPhoneDriver;
  for (const mode of ['success', 'read failure', 'model failure', 'availability failure', 'invalid JSON', 'handoff failure', 'observer throws']) {
    const run = async (Driver, observe) => {
      const f = await harness(), actions = [];
      const d = new Driver({ session: f.app.session, businessContext: { timeZone: 'America/New_York' }, availability: f.availability,
        createModel: () => { actions.push('connect'); return { ready: Promise.resolve(), close() { actions.push('close'); },
          request(input) { actions.push(['request', structuredClone(input)]); if (mode === 'model failure') throw Error(secret);
            const call = seedScript({ binding: input.context.binding })[0]; return Promise.resolve({ calls: [{ name: call.name, callId: 'call-1', argumentsJson: mode === 'invalid JSON' ? '{' : JSON.stringify(call.args) }] }); },
          toolResult(...args) { actions.push(['toolResult', structuredClone(args)]); } }; },
        replace: (previous, next) => { actions.push('replace'); f.app.session.replaceProposal(previous, next); },
        speak: plan => { actions.push(['speak', structuredClone(plan)]); if (mode === 'handoff failure') throw Error(secret); return Promise.resolve({ accepted: true }); },
        terminate: reason => actions.push(['terminate', reason]), emit() {}, diagnostics: observe ? new StructuredPhoneFailure({ callSid: 'CA-compare', emit: () => { if (mode === 'observer throws') throw Error(secret); } }) : null });
      if (mode === 'read failure') f.availability.read = async () => { throw Error(secret); };
      if (mode === 'availability failure') f.availability.check = async () => { throw Error(secret); };
      try { await d.turn({ turnId: 'CA-compare:turn:1', transcript: 'PRIVATE', authority: null }); return actions; }
      finally { d.close(); await f.app.terminate('TEST_DONE'); }
    };
    const normalize = values => { const ids = new Map(); return JSON.parse(JSON.stringify(values, (key, value) => {
      if (key !== 'alternativeId') return value;
      if (!ids.has(value)) ids.set(value, `opaque-alternative-${ids.size + 1}`); return ids.get(value);
    })); };
    assert.deepEqual(normalize(await run(StructuredPhoneDriver, true)), normalize(await run(Baseline, false)), mode);
  }
});
