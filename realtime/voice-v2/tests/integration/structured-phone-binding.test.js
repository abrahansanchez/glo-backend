import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, decide, settle, business } from './structured-phone-harness.js';
import { OpenAISpeechAdapter } from '../../adapters/OpenAISpeechAdapter.js';
import { createBookingProposal } from '../../domain/BookingProposal.js';
import { StructuredPhoneFailure } from '../../diagnostics/StructuredPhoneFailure.js';

const output = f => f.models.flatMap(m => m.socket.sent).filter(p => p.item?.type === 'function_call_output').map(p => JSON.parse(p.item.output));
async function ack(f) { await f.ack(f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name); }

test('current correlated old-turn echo recovers during unchanged-version Spanish clarification journey', async () => {
  const bindings = [];
  const raw = business(); raw.services[0].name = 'Haircut';
  const f = await harness({ raw, language: 'es', wire: true, script: m => {
    bindings.push(structuredClone(m.binding));
    if (m.turn < 3) return [decide({ ...m.binding, intent: 'CLARIFY', missingField: 'service' })];
    return [decide({ ...(m.turn === 3 ? bindings[1] : m.binding), changes: [{ kind: 'SET_SERVICE', serviceId: 'service-cut-91' }] })];
  } });
  try {
    for (const text of ['Quiero una cita.', 'Un servicio, por favor.']) { await f.turn(text); await ack(f); }
    const before = structuredClone(f.app.session.proposal), spoken = f.speech.length;
    await f.turn('Corte de pelo.');
    assert.equal(f.requests.length, 3); assert.equal(f.models.length, 1); assert.deepEqual(bindings.slice(0, 3).map(b => b.proposalVersion), [1, 1, 1]);
    assert.deepEqual(f.app.session.proposal, before); assert.equal(f.speech.length, spoken + 1, 'current unusable output needs an owned recovery, not indefinite silence');
    assert.equal(output(f).at(-1).result.interpretationStatus, 'REJECTED'); assert.equal(output(f).at(-1).result.decisionOutcome, 'CLARIFY');
    assert.match(f.speech.at(-1).input, /repetir|aclarar/); assert.equal(f.app.lifecycle.terminated, false);
    await ack(f); await f.turn('Corte de pelo.');
    assert.equal(f.app.session.proposal.service, 'Haircut'); assert.match(f.speech.at(-1).input, /fecha/);
    assert.equal(f.requests.length, 4); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('each serialized reused-connection request explicitly scopes the current binding and keeps history ordered', async () => {
  const f = await harness({ wire: true, script: m => [decide({ ...m.binding, intent: 'CLARIFY', missingField: 'service' })] });
  try {
    for (let i = 0; i < 3; i++) { await f.turn('Synthetic clarification'); await ack(f); }
    const packets = f.models[0].socket.sent;
    const requests = packets.filter(p => p.type === 'response.create'); assert.equal(requests.length, 3);
    for (let i = 0; i < requests.length; i++) {
      const index = packets.indexOf(requests[i]), message = packets[index - 1];
      assert.equal(message.item.type, 'message');
      const data = JSON.parse(message.item.content[0].text);
      const scope = JSON.parse(requests[i].response.instructions);
      assert.deepEqual(scope.currentBinding, data.applicationContext.binding);
      assert.equal(scope.currentBinding.turnId, `CA-phone:turn:${i + 1}`); assert.equal(scope.currentBinding.proposalVersion, 1);
      assert.equal(requests[i].response.metadata.phoneRequestId, `phone-${i + 1}`);
      if (i) assert.ok(packets.slice(0, index - 1).some(p => p.item?.type === 'function_call_output'));
    }
    assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('binding diagnostics expose field names and equality flags without returned values', async () => {
  const sentinel = 'PRIVATE_BINDING_SENTINEL';
  const f = await harness({ wire: true, script: m => [decide({ ...m.binding, turnId: sentinel, businessRevision: sentinel })] });
  try {
    await f.turn('Synthetic caller text');
    const diagnostics = f.emitted.filter(e => e.event === 'V2_STRUCTURED_PHONE_BINDING'); assert.ok(diagnostics.length);
    const rejected = diagnostics.find(e => e.mismatchedFields?.length); assert.deepEqual(rejected.mismatchedFields, ['turnId', 'businessRevision']);
    assert.equal(rejected.generationCurrent, true); assert.equal(rejected.requestContextCurrent, true); assert.equal(rejected.responseCorrelated, true);
    assert.equal(rejected.disposition, 'CURRENT_REQUEST_REJECTED');
    assert.ok(!JSON.stringify(diagnostics).includes(sentinel));
    assert.equal(f.emitted.some(e => e.event === 'V2_STRUCTURED_PHONE_SECONDARY' && e.reasonCode === 'STALE_WORK'), false);
    assert.equal(f.app.session.proposal.service, null); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const field of ['turnId', 'proposalVersion', 'businessRevision', 'serviceIds', 'language'])
  test(`current mismatched ${field} never applies actions or consent and permits a fresh next turn`, async () => {
    const f = await harness({ wire: true, script: m => [decide({ ...m.binding,
      ...(m.turn === 1 ? { [field]: ({ turnId: 'FOREIGN_PRIVATE_TURN', proposalVersion: m.binding.proposalVersion + 1,
        businessRevision: 'FOREIGN_PRIVATE_REVISION', serviceIds: ['service-cut-91'], language: 'es' })[field] } : {}),
      changes: [{ kind: 'SET_SERVICE', serviceId: 'service-cut-91' }], intent: 'CONFIRMATION', meaning: 'CORRECTION' })] });
    try {
      const before = structuredClone(f.app.session.proposal); await f.turn('Synthetic correction');
      assert.deepEqual(f.app.session.proposal, before); assert.equal(output(f).at(-1).result.decisionOutcome, 'CLARIFY');
      const record = f.emitted.find(e => e.event === 'V2_STRUCTURED_PHONE_BINDING' && e.mismatchedFields.length);
      assert.deepEqual(record.mismatchedFields, [field]); assert.equal(record.requestContextCurrent, true); assert.equal(record.responseCorrelated, true);
      assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false);
      await ack(f); await f.turn('A haircut.'); assert.equal(f.requests.length, 2); assert.equal(f.app.session.proposal.service, 'Precision Cut');
      assert.equal(f.executorCalls, 0); assert.equal(f.app.lifecycle.terminated, false);
    } finally { await f.app.terminate('TEST_DONE'); }
  });

test('current generation with application state changed after dispatch is distinguished from bad echoed context', async () => {
  let release, submitted;
  const f = await harness({ wire: true, script: m => { submitted = structuredClone(m.binding); return new Promise(resolve => { release = resolve; }); } });
  try {
    await f.turn('Synthetic delayed decision'); const old = f.app.session.proposal;
    const next = createBookingProposal({ proposalId: old.proposalId, proposalVersion: old.proposalVersion + 1 });
    f.app.session.replaceProposal(old, next);
    release([decide({ ...submitted, changes: [{ kind: 'SET_SERVICE', serviceId: 'service-cut-91' }] })]); await settle(f.app);
    const record = f.emitted.find(e => e.event === 'V2_STRUCTURED_PHONE_BINDING' && e.mismatchedFields.length);
    assert.equal(record.generationCurrent, true); assert.equal(record.requestContextCurrent, false); assert.equal(record.responseCorrelated, true);
    const version = record.fields.find(f => f.field === 'proposalVersion'); assert.equal(version.equalsRequest, true); assert.equal(version.equalsCurrent, false);
    assert.deepEqual(f.app.session.proposal, next); assert.equal(output(f).at(-1).result.decisionOutcome, 'CLARIFY');
    assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('connection replacement quarantines a delayed obsolete response and preserves the current continuation', async () => {
  let release, oldBinding, calls = 0;
  const f = await harness({ wire: true, script: m => {
    calls++;
    if (calls === 1) return [decide({ ...m.binding, intent: 'CLARIFY', missingField: 'service' })];
    if (calls === 2) { oldBinding = structuredClone(m.binding); return new Promise(resolve => { release = resolve; }); }
    return [decide({ ...m.binding, changes: [{ kind: 'SET_SERVICE', serviceId: 'service-cut-91' }] })];
  } });
  try {
    await f.turn('Initial request'); await ack(f); await f.turn('Delayed request');
    f.input.receive({ type: 'input_audio_buffer.speech_started', item_id: 'replacement' });
    f.input.receive({ type: 'input_audio_buffer.speech_stopped', item_id: 'replacement' }); await settle(f.app);
    await f.turn('A haircut.'); assert.equal(f.models.length, 2); assert.equal(f.requests.length, 3);
    const before = structuredClone(f.app.session.proposal), audio = structuredClone(f.twilio.sent);
    release([decide({ ...oldBinding, changes: [{ kind: 'SET_SERVICE', serviceId: 'service-beard-72' }] })]); await settle(f.app);
    assert.deepEqual(f.app.session.proposal, before); assert.deepEqual(f.twilio.sent, audio); assert.equal(before.service, 'Precision Cut');
    assert.equal(f.emitted.some(e => e.event === 'V2_STRUCTURED_PHONE_FAILURE'), false); assert.equal(f.executorCalls, 0);
    assert.equal(f.models[0].closed, true);
  } finally { await f.app.terminate('TEST_DONE'); }
});

for (const phase of ['created', 'done']) test(`foreign response ${phase} remains a terminal correlation/protocol failure`, async () => {
  let release;
  const f = await harness({ wire: true, script: () => new Promise(resolve => { release = resolve; }) });
  try {
    const before = structuredClone(f.app.session.proposal); await f.turn('Synthetic pending request'); const socket = f.models[0].socket;
    socket.receive({ type: 'response.created', response: { id: 'resp-current', metadata: { phoneRequestId: phase === 'created' ? 'phone-foreign' : 'phone-1' } } });
    if (phase === 'done') socket.receive({ type: 'response.done', response: { id: 'resp-foreign', status: 'completed', output: [] } });
    await settle(f.app); assert.equal(f.app.lifecycle.terminated, true); assert.deepEqual(f.app.session.proposal, before);
    assert.equal(f.requests.length, 1); assert.equal(f.speech.length, 0); assert.equal(f.executorCalls, 0);
    assert.equal(f.emitted.filter(e => e.event === 'V2_STRUCTURED_PHONE_FAILURE').length, 1);
  } finally { release?.([]); await f.app.terminate('TEST_DONE'); }
});

function wav() {
  const b = Buffer.alloc(1964); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(1920, 40); return b;
}
test('streamed binding recovery cannot deliver late audio after interruption or affect replacement speech', async () => {
  let controller, canceled = false, speechCalls = 0;
  const adapter = new OpenAISpeechAdapter({ apiKey: 'SYNTHETIC_ONLY', fetchFn: async () => {
    if (++speechCalls === 2) return new Response(new ReadableStream({ start(c) { controller = c; }, cancel() { canceled = true; } }));
    const bytes = wav(), chunks = [bytes.subarray(0, 13), bytes.subarray(13, 1004), bytes.subarray(1004)];
    return new Response(new ReadableStream({ pull(c) { if (chunks.length) c.enqueue(chunks.shift()); else c.close(); } }));
  } });
  const f = await harness({ wire: true, injectedSpeechAdapter: adapter, script: m => [decide({ ...m.binding,
    ...(m.turn === 1 ? { turnId: 'OLD_PRIVATE_TURN' } : {}), changes: [{ kind: 'SET_SERVICE', serviceId: 'service-cut-91' }] })] });
  try {
    await f.turn('Synthetic first request'); assert.equal(f.twilio.sent.some(p => p.event === 'media'), false);
    f.input.receive({ type: 'input_audio_buffer.speech_started', item_id: 'interrupt' });
    f.input.receive({ type: 'input_audio_buffer.speech_stopped', item_id: 'interrupt' }); await settle(f.app);
    await f.turn('A haircut.'); assert.equal(canceled, true); assert.throws(() => controller.enqueue(wav()));
    assert.equal(f.app.session.proposal.service, 'Precision Cut'); assert.equal(f.requests.length, 2);
    const marks = f.twilio.sent.filter(p => p.event === 'mark'); assert.equal(marks.length, 1); await f.ack(marks[0].mark.name);
    assert.equal(f.app.session.journal().some(e => e.event === 'CONFIRMATION_AUTHORITY_GRANTED'), false); assert.equal(f.executorCalls, 0);
  } finally { await f.app.terminate('TEST_DONE'); }
});

test('binding observer is bounded and ignores hostile field names and values', () => {
  const emitted = [], d = new StructuredPhoneFailure({ callSid: 'CA-private', emit: e => emitted.push(e) });
  for (let i = 0; i < 200; i++) d.bindingComparison({ fields: [{ field: 'SECRET_FIELD', equalsCurrent: 'SECRET_VALUE' }], boundary: 'SECRET_BOUNDARY', responseCorrelated: 'SECRET_VALUE', generationCurrent: true });
  assert.equal(emitted.length, 128); assert.ok(!JSON.stringify(emitted).includes('SECRET'));
  assert.ok(emitted.every(e => Buffer.byteLength(JSON.stringify(e)) <= 4000));
});
