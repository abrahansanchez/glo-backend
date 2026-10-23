# Corpus and scoring policy

The 242 populated cases were authored before executing the interpreter. `build-corpus.mjs` imports no interpreter. `cases.json` was locked with SHA-256 `9db86975c53c6c30df10665d7fffc5d6d8a1d80cdc6f3bab4e13a61ccdacabd1` before the first evaluation; its labels have not been adjusted to observed behavior. The runner checks this lock before and after evaluation. The hash establishes immutability, not independent human adjudication: these are agent-authored semantic labels and should receive owner review before becoming a release gate.

All fourteen supplied literal phrases appear unchanged with at least three authored paraphrases each. Only the supplied literals have `sourceType: supplied_real_phrase`; paraphrases and dialogues are synthetic. Names are synthetic. Empty owner placeholders (25 single turns, eight dialogues) are separate and excluded from totals. The reference date is Friday 2026-10-23 in America/New_York. The synthetic catalogue and hours are data in each case, not production alias changes.

Each turn has its own expected intent set, slots, effects and clarification outcome. Case-level expectations repeat the final-turn expectation for convenient indexing. `expectedServicesInMentionOrder` means the ordered service request retained after that turn: the primary service followed by additional services, including previously grounded facts. It does not mean only words mentioned in the latest turn. Exact time and search preferences are distinct. Bounds carry inclusive/strict semantics. A legitimate request for a genuinely missing name/date/service/time counts as appropriate clarification; a clear availability question with enough search facts does not.

Ambiguous speaker/noise/uncertain-consent cases carry an explicit `ambiguityReason`. Their 18 turns are excluded from coverage, precision, recall and slot-rate denominators and cannot count as strict passes. They remain in the safety audit. This text-only evaluation does not simulate ASR accuracy or claim to distinguish real background speakers.

## Execution boundary

The harness injects the interpreter into the real VoiceCoordinator and initializeVoiceV2Session. Production reducer, requirement derivation, response planning, consent/playback gates and the V1 availability adapter execute. All external operations are recording fakes: sockets, availability data, booking, SMS, transcript storage and scheduling. Initial response contexts are delivered through the real planner/validator/playback mark path, so confirmation cases do not bypass authority checks. A deterministic fixed clock and slot pool avoid network and calendar variation. Assistant output is a safe synthetic fixture, not model generation. Timers are inert fixture handles; no real provider or database is accessed.

The harness records snapshots after each caller item and application work, before automatically delivering the next assistant response. Duplicate provider item delivery is included. Paused dialogue cases include a response left preparing and subsequent caller speech. The fixture does not model every missing-provider-event ordering; this is an interpreter corpus, not a transport reliability certification.

`evaluateCase(case, {interpreter})` accepts the current interpreter interface; the runner also accepts `--interpreter=<absolute module path>` exporting `interpretTurn` or default. Structured action fields and actual effects are projected into represented intent sets; no second utterance parser is implemented. One BOOK_REQUEST can receive credit for several recognized facts. Missing availability meaning gets no credit merely because a service/date was recognized. Optional structured `interpretation.intents` can describe additional meanings, but real reducer/effect and slot checks still run.

The current interface has no upper-bound representation: its projection is null and upper-bound cases fail. A future candidate introducing a typed bound must extend the evaluation projection openly, freeze that projection before comparison and rerun both candidates; it must not change the semantic labels. Likewise, this harness alone cannot establish performance or correctness of a candidate requiring a different reducer contract.

`bookingAuthorityCreated` records an AUTHORIZE_BOOKING effect queued by the real session, not merely the delivery of a confirmation prompt. Booking/SMS/availability counts are per caller turn, not cumulative. CHECK_AVAILABILITY and SEARCH_AVAILABILITY both contribute to availability effect counts.

## Metrics

Complete-intent coverage requires every expected intent to be represented; partial intent recognition fails. Extra intents are penalized by precision. Strict turn accuracy additionally requires all slot, effect-count and clarification comparisons plus no unsafe result. Case accuracy requires every turn in a case to pass; one failed early turn can cascade into later state failures.

Slots are scored against final state after each turn. Report both all-unambiguous-turn accuracy (which includes retained/null facts) and populated-slot accuracy; high all-turn slot scores must not hide poor daypart or bound recognition. Appropriate clarification is actual clarification among cases requiring it; unnecessary clarification is actual clarification among cases not requiring it. Missing-information hallucination counts a non-null fact where its semantic label requires null.

Unsafe outcomes include non-affirmative/ambiguous authorization or booking/SMS, and unsupported non-null service/additional-service/date/time mutations compared with the expected state and prior grounded state. Incorrect removals and name mistakes still fail slot comparisons but are not automatically classified as unsafe selections. No safety rate should be interpreted as production prevalence: this is a deliberately difficult, non-random corpus.

Failure classifications overlap. `one_action_partial_intent` is an operational diagnosis: a multi-intent turn has some but not all intended meanings under BOOK_REQUEST, a date-search action or SET_/MODIFY_ routing. Its count is evidence for investigating routing/representation; it does not prove architecture alone caused every miss. `not_cleanly_representable` uses author-declared vocabulary gaps. Phrase/extraction, dialogue context, correction, consent and artifact tags are screening groups, not disjoint causal verdicts. UNKNOWN on a non-consent artifact can be safe while still lacking a clean semantic representation; report safety separately.

## Reproduction

From this worktree:

```powershell
node realtime/voice-v2/tests/evaluation/interpreter-corpus/run.mjs
node --test --test-concurrency=1 realtime/voice-v2/tests/evaluation/interpreter-corpus/evaluation-corpus.test.js
node realtime/voice-v2/tests/evaluation/interpreter-corpus/history.mjs
```

The runner always performs three complete passes and stops on any differing result, failure-identity or proposal/effect hash. Do not regenerate or edit the labels to improve the current score. Owner-supplied future cases require a new explicitly versioned label set.
