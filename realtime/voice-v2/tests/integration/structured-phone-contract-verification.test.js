import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, decide, seedScript } from './structured-phone-harness.js';
import { phoneContracts, PHONE_DECISION_INSTRUCTIONS } from '../../experiments/structured-phone/PhoneContracts.js';

const result = f => JSON.parse(f.models.flatMap(m => m.socket.sent).filter(p => p.item?.type === 'function_call_output').at(-1).item.output).result;
async function seedDelivered(f) {
  await f.turn('Synthetic complete draft');
  const markId = f.twilio.sent.filter(p => p.event === 'mark').at(-1).mark.name;
  await f.ack(markId);
  const playback = f.app.session.playbackRegistry.get(markId);
  const identity = { proposalVersion: f.app.session.proposal.proposalVersion, responseId: playback.responseId, markId,
    responseRegistry: f.app.session.responseRegistry, playbackRegistry: f.app.session.playbackRegistry };
  assert.equal(f.app.session.confirmationAuthority.verifyGrant(identity).authorized, true);
  return identity;
}

for (const language of ['en', 'es']) for (const scope of ['DRAFT', 'EXISTING_APPOINTMENT_EXPLORATION'])
  test(`read-only isolation ${language} ${scope}: active proposal and delivered eligibility survive exploration`, async () => {
    const f = await harness({ language, wire: true, script: m => m.turn === 1 ? seedScript(m) : [decide({ ...m.binding,
      scope, intent: 'QUESTION', questions: ['AVAILABILITY'], changes: [{ kind: 'SET_TIME', time: '16:30' }] })] });
    try {
      const grant = await seedDelivered(f), before = structuredClone(f.app.session.proposal);
      await f.turn(language === 'es' ? '¿Y a las cuatro y media?' : 'What about four thirty?');
      assert.equal(f.executorCalls, 0);
      assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false);
      const preserved = JSON.stringify(f.app.session.proposal) === JSON.stringify(before);
      const authorityPreserved = f.app.session.confirmationAuthority.verifyGrant({ ...grant, proposalVersion: f.app.session.proposal.proposalVersion }).authorized;
      assert.deepEqual({ proposalPreserved: preserved, authorityPreserved }, { proposalPreserved: true, authorityPreserved: true });
    } finally { await f.app.terminate('TEST_DONE'); }
  });

// Independent table oracle, not a call to decisionSemantics. The active proposal
// may change only for clear information in DRAFT scope outside QUESTION.
function expectedMode({ intent, meaning, scope, changed, asked, certainty }) {
  if (intent === 'UNSUPPORTED' || changed && (certainty === 'UNCERTAIN' || meaning === 'AFFIRM')
    || meaning === 'AFFIRM' && intent !== 'CONFIRMATION') return 'CLARIFY';
  if (intent === 'CONFIRMATION' && !changed && !asked) return scope === 'DRAFT' ? 'CONSENT' : 'CLARIFY';
  if (intent === 'QUESTION' && !asked || intent === 'CLARIFY' && !changed && !asked) return 'CLARIFY';
  return 'INFORMATION';
}
test('320 execution cases check expected meaning, active state and authority, not serialization alone', async () => {
  const failures = []; let cases = 0, meaningFailures = 0, stateFailures = 0, authorityFailures = 0;
  for (const intent of ['REQUEST', 'QUESTION', 'CONFIRMATION', 'CLARIFY', 'UNSUPPORTED'])
    for (const certainty of ['KNOWN', 'UNCERTAIN']) for (const scope of ['DRAFT', 'EXISTING_APPOINTMENT_EXPLORATION'])
      for (const meaning of ['AFFIRM', 'DENY', 'UNKNOWN', 'CORRECTION']) for (const changed of [false, true]) for (const asked of [false, true]) {
        const row = { intent, certainty, scope, meaning, changed, asked }, mode = expectedMode(row);
        const f = await harness({ wire: true, script: m => m.turn === 1 ? seedScript(m) : [decide({ ...m.binding,
          intent, changeCertainty: certainty, scope, meaning, changes: changed ? [{ kind: 'SET_TIME', time: '16:30' }] : [], questions: asked ? ['PRICE'] : [] })] });
        try {
          const grant = await seedDelivered(f), before = structuredClone(f.app.session.proposal);
          // Deliberately not an affirmative: model-proposed AFFIRM cannot itself
          // prove caller consent, even with a previously delivered confirmation.
          await f.turn('Synthetic inquiry'); cases++;
          const output = result(f), expectedOutcome = mode === 'INFORMATION' ? 'CONTINUE' : 'CLARIFY';
          const mayMutate = mode === 'INFORMATION' && changed && scope === 'DRAFT' && intent !== 'QUESTION';
          const same = JSON.stringify(before) === JSON.stringify(f.app.session.proposal);
          const meaningWrong = output.decisionOutcome !== expectedOutcome;
          const stateWrong = mayMutate ? f.app.session.proposal.time !== '16:30' : !same;
          const readOnly = mode === 'INFORMATION' && (intent === 'QUESTION' || scope === 'EXISTING_APPOINTMENT_EXPLORATION');
          const authorityWrong = readOnly && !f.app.session.confirmationAuthority.verifyGrant({ ...grant, proposalVersion: f.app.session.proposal.proposalVersion }).authorized;
          meaningFailures += Number(meaningWrong); stateFailures += Number(stateWrong); authorityFailures += Number(authorityWrong);
          if (meaningWrong || stateWrong || authorityWrong) failures.push({ ...row, actualOutcome: output.decisionOutcome, meaningWrong, stateWrong, authorityWrong });
          assert.equal(f.requests.length, 2); assert.equal(f.executorCalls, 0);
          assert.equal(f.emitted.some(e => e.stage === 'WOULD_AUTHORIZE'), false);
        } finally { await f.app.terminate('TEST_DONE'); }
      }
  console.log(JSON.stringify({ cases, meaningFailures, stateFailures, authorityFailures, examples: failures.slice(0, 4) }));
  assert.equal(cases, 320); assert.equal(failures.length, 0, `${failures.length}/320 violate expected meaning/state/authority`);
});

test('complete serialized configuration uses the application contract and an object-root tool', async () => {
  const f = await harness({ wire: true, script: seedScript });
  try {
    await f.turn('Synthetic request');
    const update = f.models[0].socket.sent.find(p => p.type === 'session.update');
    assert.deepEqual(update, { type: 'session.update', session: { type: 'realtime', model: 'gpt-realtime', output_modalities: ['text'],
      max_output_tokens: 512, tools: phoneContracts(['service-cut-91', 'service-beard-72']).tools,
      tool_choice: 'required', instructions: PHONE_DECISION_INSTRUCTIONS } });
    const root = update.session.tools[0].parameters;
    assert.equal(root.type, 'object'); assert.equal(Object.hasOwn(root, 'oneOf'), false); assert.equal(root.additionalProperties, false);
    assert.ok(root.required.includes('changeCertainty')); assert.ok(root.required.includes('scope'));
  } finally { await f.app.terminate('TEST_DONE'); }
});
