# Bilingual natural-conversation evaluation

## Baseline and scope

Starting/final HEAD: `21ec066f939f8820478ce6997398ad9a6b554373`. Worktree: `C:/Users/sanch/Desktop/Glo/glo-interpreter-corpus`; branch: `eval/voice-v2-interpreter-corpus`. It began clean immediately after isolated worktree creation. Only test/evaluation files were added, all unstaged and uncommitted; no tracked or production file changed. Existing worktrees were not used for source execution or modified.

Authorized isolated install: `npm.cmd ci --ignore-scripts --no-audit --no-fund`, exit 0, 212 packages. Node v22.13.1, npm 10.9.2, Undici 6.21.1. Before and after hashes are identical:

| File | SHA-256 before = after |
| --- | --- |
| package.json | A40C110AE0283140B401EF9418E6638CC6C48C2C67A106F7E5DBB6A2BEDC331F |
| package-lock.json | 5F7224B1B2FF0C2836600E775D08F8D91928F2BD3CCB4A205D9579D830E6856B |


No commit, staging, push, deployment, production/database query, provider request, SMS or phone call occurred. The authorized dependency download was the only external network operation. Temporary committed-source snapshots for the historical comparison were outside active checkouts, used the one authorized dependency installation and did not replace active files.

## Corpus and label provenance

| Dimension | Count |
| --- | --- |
| populated | 242 |
| English | 119 |
| Spanish | 123 |
| single_turn | 202 |
| multi_turn_dialogue | 40 |
| synthetic | 228 |
| supplied_real_phrase | 14 |
| mixed_or_business_mismatch | 126 |
| noise_artifact_filler_pause | 28 |
| uncounted_single_placeholders | 25 |
| uncounted_dialogue_placeholders | 8 |
| total_turns | 362 |
| unambiguous_turns | 344 |
| ambiguous_turns | 18 |


All fourteen supplied literals plus at least three paraphrases each are included. Every dialogue turn has its own expected result. Labels were written before execution and remain locked at SHA-256 `9db86975c53c6c30df10665d7fffc5d6d8a1d80cdc6f3bab4e13a61ccdacabd1`. See [label and scoring policy](../../realtime/voice-v2/tests/evaluation/interpreter-corpus/LABEL_POLICY.md) and [cases](../../realtime/voice-v2/tests/evaluation/interpreter-corpus/cases.json). Cases are deliberately challenging and are not a representative production sample; these rates are benchmark results, not estimated caller failure rates.

| Supplied literal | Case |
| --- | --- |
| I need a haircut for tomorrow. What times do you have available in the afternoon? | embedded_availability-en-01 |
| Necesito cortarme el pelo mañana, ¿tienen horarios disponibles? | embedded_availability-es-01 |
| Quiero cortarme el pelo este sábado, ¿tienen disponibilidad? | embedded_availability-es-05 |
| ¿Qué horario tienen disponible el sábado en la mañana? | availability_only-es-01 |
| Hi, I wanna get a haircut and my beard cut. | compound_services-en-01 |
| Hola, quiero hacer cita para un corte de pelo y de barba. | compound_services-es-01 |
| Mejor solamente el corte de pelo; la barba no. | service_correction-es-01 |
| First thing Saturday morning, please. | early_opening-en-01 |
| As early as you open on Saturday. | early_opening-en-05 |
| A primera hora, por favor. | early_opening-es-01 |
| Lo más temprano que tengan el sábado. | early_opening-es-05 |
| Yes | affirmative-en-01 |
| Sí | affirmative-es-01 |
| ¿Tienes tiempo para una pregunta? | unrelated_question-es-01 |


## Overall scores

| Metric | Result |
| --- | --- |
| Complete-intent coverage | 190/344 (55.23%) |
| Strict turn accuracy | 180/344 (52.33%) |
| Individual intent recall | 385/560 (68.75%) |
| Individual intent precision | 385/427 (90.16%) |
| Appropriate clarification | 116/116 (100%) |
| Unnecessary clarification | 100/228 (43.86%) |
| Clarification accuracy | 244/344 (70.93%) |
| Missing-information hallucination | 10/344 (2.91%) |
| Unsafe turns / cases | 16 / 16 |
| Unsafe ambiguous turns (included above) | 2 |
| Non-affirmative or ambiguous authorization/booking/SMS turns | 0 |
| One-action partial-intent turns | 39 |
| All-turn complete-intent case coverage | 82/224 |
| All-turn strict case passes | 72/224 |


There are 164 nonpassing unambiguous turns and 18 separately marked ambiguous turns. Across all 242 cases, 72 pass every turn and 170 contain a failure or ambiguous turn. Ambiguous cases never silently count as correct. Every nonpassing turn, including ambiguous ones, is in [FAILURES.md](FAILURES.md); every expected field, actual proposal/effect and score is in [scored-turns.json](scored-turns.json). [AMBIGUOUS.md](AMBIGUOUS.md) separates ambiguous cases. All 16 unsafe outcomes are in [UNSAFE.md](UNSAFE.md). None authorized booking or SMS from a non-affirmative: these unsafe outcomes were unsupported slot mutations, including unrelated numbers/questions interpreted as times and confirmation questions replacing grounded service.

### Slot accuracy

| Slot | All unambiguous turns | Populated expected slots |
| --- | --- | --- |
| service | 336/344 (97.67%) | 328/336 (97.62%) |
| additionalServices | 339/344 (98.55%) | 12/12 (100%) |
| date | 331/344 (96.22%) | 299/312 (95.83%) |
| exactTime | 332/344 (96.51%) | 202/204 (99.02%) |
| daypart | 318/344 (92.44%) | 8/34 (23.53%) |
| lowerBound | 344/344 (100%) | 6/6 (100%) |
| upperBound | 340/344 (98.84%) | 0/4 (0%) |
| name | 336/344 (97.67%) | 154/162 (95.06%) |
| confirmation | 278/344 (80.81%) | 4/54 (7.41%) |
| correctionTarget | 326/344 (94.77%) | 28/44 (63.64%) |


Retained and null facts make several all-turn slot scores look high. Populated daypart accuracy is only 23.53%, and populated upper-bound accuracy is 0/4. Exact-time precision must also be read alongside the unsafe selections; retaining an earlier correct time does not demonstrate understanding a new preference.

### Individual intents

| Intent | Recall | Precision |
| --- | --- | --- |
| AFFIRM_CONFIRMATION | 2/40 (5%) | 2/2 (100%) |
| BOOK_REQUEST | 48/68 (70.59%) | 48/64 (75%) |
| CORRECT_DATE | 2/6 (33.33%) | 2/2 (100%) |
| CORRECT_NAME | 7/10 (70%) | 7/7 (100%) |
| CORRECT_SERVICE | 10/18 (55.56%) | 10/12 (83.33%) |
| CORRECT_TIME | 9/10 (90%) | 9/9 (100%) |
| DENY_CONFIRMATION | 2/14 (14.29%) | 2/2 (100%) |
| EARLIEST_AVAILABLE | 0/16 (0%) | N/A |
| QUESTION_ABOUT_CONFIRMATION | 0/14 (0%) | N/A |
| REJECT_ALTERNATIVES | 0/6 (0%) | N/A |
| REPEAT_INFORMATION | 6/6 (100%) | 6/18 (33.33%) |
| REQUEST_AVAILABILITY | 34/62 (54.84%) | 34/34 (100%) |
| SELECT_ALTERNATIVE | 10/10 (100%) | 10/12 (83.33%) |
| SET_DATE | 74/82 (90.24%) | 74/74 (100%) |
| SET_NAME | 32/34 (94.12%) | 32/32 (100%) |
| SET_SERVICE | 81/82 (98.78%) | 81/81 (100%) |
| SET_TIME | 68/68 (100%) | 68/78 (87.18%) |
| UNRELATED_INFORMATION | 0/6 (0%) | N/A |
| UNRELATED_QUESTION | 0/8 (0%) | N/A |


### Categories

[CATEGORIES.md](CATEGORIES.md) gives counts and headline scores for all 38 categories. [CATEGORY_DETAILS.md](CATEGORY_DETAILS.md) gives every required metric, including per-intent and slot scores, for every category; [summary.json](summary.json) is the machine-readable source.

All categories below 90% complete-intent coverage:

| Category | Complete-intent coverage |
| --- | --- |
| affirmative | 2/8 (25%) |
| alternative_rejection | 0/6 (0%) |
| availability_only | 5/8 (62.5%) |
| compound_services | 2/8 (25%) |
| confirmation_question | 0/6 (0%) |
| correction_with_availability | 0/6 (0%) |
| date_correction | 2/6 (33.33%) |
| denial | 2/6 (33.33%) |
| dialogue_availability_selection | 8/16 (50%) |
| dialogue_compound_removal | 20/24 (83.33%) |
| dialogue_confirmation_affirm | 0/8 (0%) |
| dialogue_confirmation_deny | 4/8 (50%) |
| dialogue_confirmation_question | 0/8 (0%) |
| dialogue_date_service | 16/20 (80%) |
| dialogue_language_switch | 16/20 (80%) |
| dialogue_name_correction | 8/12 (66.67%) |
| dialogue_paused | 20/24 (83.33%) |
| dialogue_service_date | 16/20 (80%) |
| direct_booking | 4/6 (66.67%) |
| early_opening | 0/16 (0%) |
| embedded_availability | 0/12 (0%) |
| informal_filler | 4/6 (66.67%) |
| multiple_facts | 3/6 (50%) |
| name_correction | 3/6 (50%) |
| non_time_numbers | 0/6 (0%) |
| pause_fragment | 4/6 (66.67%) |
| service_correction | 4/8 (50%) |
| time_bounds | 6/8 (75%) |
| time_correction | 5/6 (83.33%) |
| unrelated_question | 0/8 (0%) |


### Failure screening groups

| Group (overlapping, not causal proof) | Turns |
| --- | --- |
| consent_or_confirmation | 44 |
| context_or_state | 52 |
| correction | 19 |
| not_cleanly_representable | 44 |
| one_action_partial_intent | 39 |
| phrase_or_extraction_coverage | 180 |
| transcription_artifact | 6 |


The 39 one-action partial-intent turns recognize part of a multi-intent request but miss another part. They justify investigating independent meaning/slot representation; they do not establish that all misses can be solved merely by changing one-action routing. The 44 not-cleanly-representable results include requested semantic distinctions absent from the current vocabulary. Consent-screening misses are mostly safe refusal to recognize natural affirmatives or questions; they are not 44 unauthorized bookings. Artifact cases can be safe UNKNOWN outcomes while still lacking an explicit semantic representation. See each row before treating a screening group as a confirmed root cause.

## Determinism

All 242 cases / 362 turns executed in each of three complete passes, with no evaluation skip or cancellation. The results, failure identities and proposal/effect outputs match byte-for-byte after canonical serialization:

| Hash type | SHA-256, identical in runs 1/2/3 |
| --- | --- |
| Result | d46300e76cc61e4dcee714e25a0f6abfb7029a97272f2ed44d0502c99cb3f533 |
| Failure identities | 139061f79dc8d1d5b20ab63565eb938b42b337a339879552724bbb303a590780 |
| Proposal/effects | c682b858ee8fe51e04b3405c4ffd3475886b7b99348851d1b82d58dd0655fc4c |


Raw outputs: [run 1](run-1.json), [run 2](run-2.json), [run 3](run-3.json). Candidate injection and projection are tested through the real session. No production parser or candidate interpreter was implemented.

## Existing latency observations

No per-turn production timing packet is supplied in this task. Therefore p50/p95 and candidate added latency are **NOT MEASURED**; fixture clocks are synthetic and cannot be used as latency measurements.

Existing source permits the following measurement plan:

| Boundary | Existing event / stage | Identity and source |
| --- | --- | --- |
| Speech stopped | V2_TIMING TRANSPORT_RECEIVED with transportType CALLER_SPEECH_STOPPED (receipt); V2_CALL_TRACE CALLER_SPEECH_STOPPED (processed) | callSid, itemId; initializeVoiceV2Session.js:198,391; CallTrace.js:30 |
| Interpretation completed | V2_TIMING INTERPRETATION_END; V2_CALL_TRACE TURN_INTERPRETED | callSid, turnId; VoiceCoordinator.js:18-21; initializer:1534 |
| Interpretation plus reducer finished | V2_TIMING INTERPRETATION_REDUCTION_END | turnId, proposalVersion; initializer:480 |
| Preparation requested | V2_TIMING RESPONSE_CREATE_DISPATCH (Realtime); TTS_DISPATCH (HTTP Speech); V2_CALL_TRACE RESPONSE_PLANNED / RESPONSE_CREATE_DISPATCHED / SPEECH_SYNTHESIS_DISPATCHED | requestId, responseId, purpose, proposalVersion, available turnId; initializer:734-737,782-784 |
| First assistant audio submitted | V2_TIMING FIRST_TWILIO_AUDIO_SUBMITTED; V2_CALL_TRACE TWILIO_FIRST_AUDIO_SUBMITTED | requestId, responseId, turnId when retained; initializer:1088-1089,1158-1159; CallTrace.js:28 |
| Item-to-turn join | V2_TIMING TRANSCRIPT_PERSISTENCE_START/END; V2_CALL_TRACE CALLER_TURN_FINALIZED | itemId plus turnId; initializer:442,451,496 |


Prefer V2_TIMING elapsedMs throughout: speech-stop receipt -> INTERPRETATION_END -> RESPONSE_CREATE_DISPATCH/TTS_DISPATCH -> FIRST_TWILIO_AUDIO_SUBMITTED. This measures application receipt, not the true acoustic end. For the processed speech-stop point use CALLER_SPEECH_STOPPED; within V2_CALL_TRACE its elapsedMs is comparable to other CallTrace events. **Do not subtract elapsedMs across diagnostic families**: CallTrace, LatencyDiagnostics and Speech preparation have separate origins. Cross-family wallTime gives millisecond-resolution approximation only unless their origin offset is independently established. Speech PREPARATION_CREATED has a request-local origin, not a call clock.

Join callSid + itemId to turnId via transcript-persistence observations, then turnId to requestId and responseId through request timing context, and playback via markId. Effect-driven responses can lack a direct turnId; use explicit commandId/proposalVersion links only where unique. Never infer a join merely from nearby log lines. CALLER_TURN_FINALIZED is emitted after processing, so it is an identity join, not a speech-stop timestamp. Retried/superseded/interrupted responses need separate attempt/ownership cohorts; never pair the first request with another attempt's audio silently. Local recovery is a separate category and may lack the same timing points.

For each complete uniquely joined turn compute each stage difference and total stop-to-submission. Group by language, purpose and generation transport; report sample count, excluded/censored count and missing-boundary count. Compute nearest-rank p50/p95 as sorted values at ceil(0.50*n), ceil(0.95*n). V2_TIMING caps at 2,000 records per call; missing events or diagnosticLimitReached require censoring. Provider first audio, complete-buffer-ready and Twilio submission are different boundaries; none proves audible playout to the caller. Required missing evidence: complete correlated actual log packets, attempt/ownership disposition and valid shared-clock timestamps.

## Historical Undici check

Exact test: `realtime/voice-v2/tests/adapters/speech-undici-stages.test.js`, “real pinned fetch/default per-synthesis Agent stages and request/audio match historical HEAD”.

| Commit | Exit | Error | Loopback started |
| --- | --- | --- | --- |
| cf8560b9ea9cea5515d3a9feac314ba78f02fac0 | 1 | ERR_UNSUPPORTED_RESOLVE_REQUEST | false |
| 9eaab4ac49b27af235b6f949d7514af0252bbe36 | 1 | ERR_UNSUPPORTED_RESOLVE_REQUEST | false |
| 21ec066f939f8820478ce6997398ad9a6b554373 | 1 | ERR_UNSUPPORTED_RESOLVE_REQUEST | false |


All three native committed tests fail under the same Node v22.13.1 / Undici 6.21.1 environment before server creation/listen. They import a historical adapter as a data: module containing a bare undici dependency; native Node data-URL package resolution raises ERR_UNSUPPORTED_RESOLVE_REQUEST. Source snapshots use only the authorized installation for file-based dependency imports; data-module resolution remains native. This is a test/module-loading compatibility failure, not evidence of an OpenAI request or production Speech transport failure. Git history proves introduction of this test at 9eaab4ac49b27af235b6f949d7514af0252bbe36; first historical CI failure/environment onset is not proven. No repair made. Commands, stack and snapshot details: [historical-undici.json](historical-undici.json).

## Validation and baseline comparison

| Run | Tests | Pass | Fail | Skip | Cancel |
| --- | --- | --- | --- | --- | --- |
| Existing interpreter tests (included in focused) | 101 | 101 | 0 | 0 | 0 |
| Focused interpreter/reducer/authority/session + evaluation | 164 | 164 | 0 | 0 | 0 |
| Unchanged tracked baseline tests | 1508 | 1484 | 24 | 0 | 0 |
| Complete serial discovery including five new evaluation tests | 1513 | 1489 | 24 | 0 | 0 |


All 24 failure names match exactly: 23 UNAPPROVED_BUSINESS failures plus the historical Undici module-resolution failure. No new failure, skip, cancellation or module-not-found load failure. The baseline comparison executes only committed tests against unchanged committed production source; the full run adds the five evaluation tests. Full commands and failure identities: [validation.json](validation.json). Syntax checks cover every new .js/.mjs file. Both git diff checks pass; tracked and staged diffs are empty.

## Later-candidate decision thresholds and recommendation

Required: complete-intent coverage >=95%; unsafe outcomes exactly zero; non-affirmative booking/SMS exactly zero; established single-service happy-path regressions zero; added p95 interpretation latency <=700 ms; deterministic fallback remains available. Current measured coverage and safety fail those gates. No latency claim can yet be made.

First compare an independent structured slot/intent extraction design plus an explicit availability-question flag: embedded availability, multiple facts and correction-plus-availability produce measured partial meaning. This is an evaluation recommendation, not approval to implement extraction rules or change business authority. It will not by itself solve consent vocabulary, unsupported upper bounds or irrelevant-number mistakes.

Evaluate a narrowly gated semantic fallback for UNKNOWN, partial-intent or conflicting turns against these identical frozen labels. Require catalogue grounding, typed slots/bounds, proposal-version checks and unchanged consent authorization; a model's affirmative guess must never replace real consent. The 180 phrase/extraction screening results and 44 representational gaps justify a measured comparison, not automatic deployment. Every fallback outcome must still pass the real reducer/authority path, including safe refusal.

The existing Realtime model with narrow typed tools is another comparison arm if it can emit all required meanings with deterministic validation and no duplicate effects. This corpus does not measure its latency, delivery reliability or semantic accuracy; reuse alone is not a reason to choose it. Run all candidates against the same label version, compare failures and unsafe rows, and measure real p95 incremental interpretation latency separately. Do not build or select a replacement in this task.

## Inventory and final state

The exact added-file inventory is [inventory.txt](inventory.txt); all files are under the new worktree's evaluation artifact or test directory. Final Git status is only `?? evaluation/` and `?? realtime/voice-v2/tests/evaluation/`. No production, package or lockfile changed. All work remains unstaged and uncommitted.
