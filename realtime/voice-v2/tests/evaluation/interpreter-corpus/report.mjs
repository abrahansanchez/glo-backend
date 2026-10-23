import {readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const output=new URL('../../../../../evaluation/voice-v2-interpreter-corpus/',import.meta.url);
const read=name=>JSON.parse(readFileSync(new URL(name,output),'utf8'));
const report=read('summary.json'),s=report.summary,rows=read('scored-turns.json'),history=read('historical-undici.json');
const corpus=JSON.parse(readFileSync(new URL('cases.json',import.meta.url)));
const pct=r=>r.percent===null?'N/A':`${r.numerator}/${r.denominator} (${r.percent}%)`;
const table=(headers,data)=>`| ${headers.join(' | ')} |\n| ${headers.map(()=>'---').join(' | ')} |\n${data.map(r=>'| '+r.map(x=>String(x).replaceAll('|','\\|').replaceAll('\n',' ')).join(' | ')+' |').join('\n')}\n`;
function tap(name){
 const buffer=readFileSync(join(tmpdir(),name));const text=buffer.toString(buffer[0]===255&&buffer[1]===254?'utf16le':'utf8');
 const value=field=>Number(text.match(new RegExp(`^# ${field} (\\d+)$`,'m'))?.[1]);
 const result={tests:value('tests'),pass:value('pass'),fail:value('fail'),cancelled:value('cancelled'),skipped:value('skipped'),
 failures:[...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(m=>m[1].trim()),unapprovedBusinessErrors:(text.match(/error: 'UNAPPROVED_BUSINESS'/g)||[]).length};
 if(!Number.isFinite(result.tests))throw Error(`INCOMPLETE_VALIDATION_${name}`);return result;
}
const focused=tap('interpreter-corpus-focused.tap'),full=tap('interpreter-corpus-full.tap'),baseline=tap('interpreter-corpus-baseline.tap'),interpreter=tap('interpreter-corpus-interpreter.tap');
if(JSON.stringify(full.failures)!==JSON.stringify(baseline.failures))throw Error('BASELINE_FAILURE_IDENTITIES_DIFFER');
if(focused.fail||full.fail!==24||full.skipped||full.cancelled||baseline.skipped||baseline.cancelled)throw Error('UNEXPECTED_VALIDATION_RESULT');
const focusedFiles=['interpretation/turn-interpretation.test.js','interpretation/spanish-book-request-grounding.test.js','interpretation/natural-spanish.test.js','interpretation/contextual-availability.test.js','unit/domain-contracts.test.js','lifecycle/confirmation-lifecycle.test.js','integration/live-confirmation-boundary-characterization.test.js','integration/confirmation-path-comparison.test.js','integration/ca704-confirmation-overlap.test.js','integration/application-owned-tts-confirmation.test.js','evaluation/interpreter-corpus/evaluation-corpus.test.js'];
const syntaxFiles=execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).trim().split(/\r?\n/).filter(p=>/\.(js|mjs)$/.test(p));
for(const path of syntaxFiles)execFileSync(process.execPath,['--check',path]);
execFileSync('git',['diff','--check']);execFileSync('git',['diff','--cached','--check']);
const validation={focused,full,baseline,interpreter,identicalBaselineFailures:true,syntax:{files:syntaxFiles,allPassed:true},diffCheck:0,cachedDiffCheck:0,
 focusedCommand:'node --test --test-concurrency=1 '+focusedFiles.map(p=>'realtime/voice-v2/tests/'+p).join(' '),
 interpreterCommand:'$files = @(rg --files realtime/voice-v2/tests/interpretation | Where-Object { $_ -match "\\.test\\.js$" }); node --test --test-concurrency=1 @files',
 fullCommand:'$files = @(rg --files realtime/voice-v2/tests | Where-Object { $_ -match "\\.test\\.js$" }); node --test --test-concurrency=1 @files',
 baselineCommand:"$files = @(git ls-files 'realtime/voice-v2/tests/*.test.js'); node --test --test-concurrency=1 @files",
 corpusCommand:'node realtime/voice-v2/tests/evaluation/interpreter-corpus/run.mjs',
 historyCommand:'node realtime/voice-v2/tests/evaluation/interpreter-corpus/history.mjs'};
writeFileSync(new URL('validation.json',output),JSON.stringify(validation,null,2)+'\n');
const unsafeEffects=rows.filter(r=>(r.expected.expectedConfirmation!=='affirm'||r.score.ambiguous)&&(r.actual.bookingEffectCount||r.actual.smsEffectCount||r.actual.bookingAuthorityCreated));
const unambiguousCases=corpus.filter(c=>c.turns.every(t=>!t.ambiguityReason));
const completeCases=unambiguousCases.filter(c=>rows.filter(r=>r.id===c.id).every(r=>r.score.intentCoverage));
const below=s.below90.map(c=>[c.category,pct(c)]);
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex').toUpperCase();
const packageHashes={packageJson:sha('package.json'),lockfile:sha('package-lock.json')};
if(packageHashes.packageJson!=='A40C110AE0283140B401EF9418E6638CC6C48C2C67A106F7E5DBB6A2BEDC331F'||packageHashes.lockfile!=='5F7224B1B2FF0C2836600E775D08F8D91928F2BD3CCB4A205D9579D830E6856B')throw Error('PACKAGE_HASH_CHANGED');
if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==report.baseline)throw Error('HEAD_CHANGED');
if(execFileSync('git',['diff','--name-only'],{encoding:'utf8'}).trim()||execFileSync('git',['diff','--cached','--name-only'],{encoding:'utf8'}).trim())throw Error('TRACKED_FILE_CHANGED');
const text=`# Bilingual natural-conversation evaluation

## Baseline and scope

Starting/final HEAD: \`${report.baseline}\`. Worktree: \`C:/Users/sanch/Desktop/Glo/glo-interpreter-corpus\`; branch: \`eval/voice-v2-interpreter-corpus\`. It began clean immediately after isolated worktree creation. Only test/evaluation files were added, all unstaged and uncommitted; no tracked or production file changed. Existing worktrees were not used for source execution or modified.

Authorized isolated install: \`npm.cmd ci --ignore-scripts --no-audit --no-fund\`, exit 0, 212 packages. Node v22.13.1, npm 10.9.2, Undici 6.21.1. Before and after hashes are identical:

${table(['File','SHA-256 before = after'],[['package.json',packageHashes.packageJson],['package-lock.json',packageHashes.lockfile]])}

No commit, staging, push, deployment, production/database query, provider request, SMS or phone call occurred. The authorized dependency download was the only external network operation. Temporary committed-source snapshots for the historical comparison were outside active checkouts, used the one authorized dependency installation and did not replace active files.

## Corpus and label provenance

${table(['Dimension','Count'],Object.entries({populated:242,English:119,Spanish:123,single_turn:202,multi_turn_dialogue:40,synthetic:228,supplied_real_phrase:14,mixed_or_business_mismatch:126,noise_artifact_filler_pause:28,uncounted_single_placeholders:25,uncounted_dialogue_placeholders:8,total_turns:362,unambiguous_turns:344,ambiguous_turns:18}))}

All fourteen supplied literals plus at least three paraphrases each are included. Every dialogue turn has its own expected result. Labels were written before execution and remain locked at SHA-256 \`${report.labelSha256}\`. See [label and scoring policy](../../realtime/voice-v2/tests/evaluation/interpreter-corpus/LABEL_POLICY.md) and [cases](../../realtime/voice-v2/tests/evaluation/interpreter-corpus/cases.json). Cases are deliberately challenging and are not a representative production sample; these rates are benchmark results, not estimated caller failure rates.

${table(['Supplied literal','Case'],corpus.filter(c=>c.sourceType==='supplied_real_phrase').map(c=>[c.turns[0].text,c.id]))}

## Overall scores

${table(['Metric','Result'],[['Complete-intent coverage',pct(s.completeIntentCoverage)],['Strict turn accuracy',pct(s.strictTurnAccuracy)],['Individual intent recall',pct(s.intentRecall)],['Individual intent precision',pct(s.intentPrecision)],['Appropriate clarification',pct(s.appropriateClarification)],['Unnecessary clarification',pct(s.unnecessaryClarification)],['Clarification accuracy',pct(s.clarificationAccuracy)],['Missing-information hallucination',pct(s.missingInformationHallucination)],['Unsafe turns / cases',s.unsafeTurnCount+' / '+s.unsafeCaseCount],['Unsafe ambiguous turns (included above)',s.ambiguousUnsafeTurnCount],['Non-affirmative or ambiguous authorization/booking/SMS turns',unsafeEffects.length],['One-action partial-intent turns',s.oneActionPartialTurns],['All-turn complete-intent case coverage',completeCases.length+'/'+unambiguousCases.length],['All-turn strict case passes',s.completeCasePasses+'/'+unambiguousCases.length]])}

There are ${rows.filter(r=>!r.score.pass&&!r.score.ambiguous).length} nonpassing unambiguous turns and 18 separately marked ambiguous turns. Across all 242 cases, 72 pass every turn and 170 contain a failure or ambiguous turn. Ambiguous cases never silently count as correct. Every nonpassing turn, including ambiguous ones, is in [FAILURES.md](FAILURES.md); every expected field, actual proposal/effect and score is in [scored-turns.json](scored-turns.json). [AMBIGUOUS.md](AMBIGUOUS.md) separates ambiguous cases. All 16 unsafe outcomes are in [UNSAFE.md](UNSAFE.md). None authorized booking or SMS from a non-affirmative: these unsafe outcomes were unsupported slot mutations, including unrelated numbers/questions interpreted as times and confirmation questions replacing grounded service.

### Slot accuracy

${table(['Slot','All unambiguous turns','Populated expected slots'],Object.entries(s.slotAccuracy).map(([k,v])=>[k,pct(v.all),pct(v.populated)]))}

Retained and null facts make several all-turn slot scores look high. Populated daypart accuracy is only 23.53%, and populated upper-bound accuracy is 0/4. Exact-time precision must also be read alongside the unsafe selections; retaining an earlier correct time does not demonstrate understanding a new preference.

### Individual intents

${table(['Intent','Recall','Precision'],Object.entries(s.perIntent).map(([k,v])=>[k,pct(v.recall),pct(v.precision)]))}

### Categories

[CATEGORIES.md](CATEGORIES.md) gives counts and headline scores for all 38 categories. [CATEGORY_DETAILS.md](CATEGORY_DETAILS.md) gives every required metric, including per-intent and slot scores, for every category; [summary.json](summary.json) is the machine-readable source.

All categories below 90% complete-intent coverage:

${table(['Category','Complete-intent coverage'],below)}

### Failure screening groups

${table(['Group (overlapping, not causal proof)','Turns'],Object.entries(s.failureClasses))}

The 39 one-action partial-intent turns recognize part of a multi-intent request but miss another part. They justify investigating independent meaning/slot representation; they do not establish that all misses can be solved merely by changing one-action routing. The 44 not-cleanly-representable results include requested semantic distinctions absent from the current vocabulary. Consent-screening misses are mostly safe refusal to recognize natural affirmatives or questions; they are not 44 unauthorized bookings. Artifact cases can be safe UNKNOWN outcomes while still lacking an explicit semantic representation. See each row before treating a screening group as a confirmed root cause.

## Determinism

All 242 cases / 362 turns executed in each of three complete passes, with no evaluation skip or cancellation. The results, failure identities and proposal/effect outputs match byte-for-byte after canonical serialization:

${table(['Hash type','SHA-256, identical in runs 1/2/3'],[['Result',report.determinism.resultHashes[0]],['Failure identities',report.determinism.failureHashes[0]],['Proposal/effects',report.determinism.proposalEffectHashes[0]]])}

Raw outputs: [run 1](run-1.json), [run 2](run-2.json), [run 3](run-3.json). Candidate injection and projection are tested through the real session. No production parser or candidate interpreter was implemented.

## Existing latency observations

No per-turn production timing packet is supplied in this task. Therefore p50/p95 and candidate added latency are **NOT MEASURED**; fixture clocks are synthetic and cannot be used as latency measurements.

Existing source permits the following measurement plan:

${table(['Boundary','Existing event / stage','Identity and source'],[
['Speech stopped','V2_TIMING TRANSPORT_RECEIVED with transportType CALLER_SPEECH_STOPPED (receipt); V2_CALL_TRACE CALLER_SPEECH_STOPPED (processed)','callSid, itemId; initializeVoiceV2Session.js:198,391; CallTrace.js:30'],
['Interpretation completed','V2_TIMING INTERPRETATION_END; V2_CALL_TRACE TURN_INTERPRETED','callSid, turnId; VoiceCoordinator.js:18-21; initializer:1534'],
['Interpretation plus reducer finished','V2_TIMING INTERPRETATION_REDUCTION_END','turnId, proposalVersion; initializer:480'],
['Preparation requested','V2_TIMING RESPONSE_CREATE_DISPATCH (Realtime); TTS_DISPATCH (HTTP Speech); V2_CALL_TRACE RESPONSE_PLANNED / RESPONSE_CREATE_DISPATCHED / SPEECH_SYNTHESIS_DISPATCHED','requestId, responseId, purpose, proposalVersion, available turnId; initializer:734-737,782-784'],
['First assistant audio submitted','V2_TIMING FIRST_TWILIO_AUDIO_SUBMITTED; V2_CALL_TRACE TWILIO_FIRST_AUDIO_SUBMITTED','requestId, responseId, turnId when retained; initializer:1088-1089,1158-1159; CallTrace.js:28'],
['Item-to-turn join','V2_TIMING TRANSCRIPT_PERSISTENCE_START/END; V2_CALL_TRACE CALLER_TURN_FINALIZED','itemId plus turnId; initializer:442,451,496']])}

Prefer V2_TIMING elapsedMs throughout: speech-stop receipt -> INTERPRETATION_END -> RESPONSE_CREATE_DISPATCH/TTS_DISPATCH -> FIRST_TWILIO_AUDIO_SUBMITTED. This measures application receipt, not the true acoustic end. For the processed speech-stop point use CALLER_SPEECH_STOPPED; within V2_CALL_TRACE its elapsedMs is comparable to other CallTrace events. **Do not subtract elapsedMs across diagnostic families**: CallTrace, LatencyDiagnostics and Speech preparation have separate origins. Cross-family wallTime gives millisecond-resolution approximation only unless their origin offset is independently established. Speech PREPARATION_CREATED has a request-local origin, not a call clock.

Join callSid + itemId to turnId via transcript-persistence observations, then turnId to requestId and responseId through request timing context, and playback via markId. Effect-driven responses can lack a direct turnId; use explicit commandId/proposalVersion links only where unique. Never infer a join merely from nearby log lines. CALLER_TURN_FINALIZED is emitted after processing, so it is an identity join, not a speech-stop timestamp. Retried/superseded/interrupted responses need separate attempt/ownership cohorts; never pair the first request with another attempt's audio silently. Local recovery is a separate category and may lack the same timing points.

For each complete uniquely joined turn compute each stage difference and total stop-to-submission. Group by language, purpose and generation transport; report sample count, excluded/censored count and missing-boundary count. Compute nearest-rank p50/p95 as sorted values at ceil(0.50*n), ceil(0.95*n). V2_TIMING caps at 2,000 records per call; missing events or diagnosticLimitReached require censoring. Provider first audio, complete-buffer-ready and Twilio submission are different boundaries; none proves audible playout to the caller. Required missing evidence: complete correlated actual log packets, attempt/ownership disposition and valid shared-clock timestamps.

## Historical Undici check

Exact test: \`realtime/voice-v2/tests/adapters/speech-undici-stages.test.js\`, “${history.testName}”.

${table(['Commit','Exit','Error','Loopback started'],history.rows.map(r=>[r.sha,r.exitCode,r.errorCode,r.loopbackServerStarted]))}

All three native committed tests fail under the same Node v22.13.1 / Undici 6.21.1 environment before server creation/listen. They import a historical adapter as a data: module containing a bare undici dependency; native Node data-URL package resolution raises ERR_UNSUPPORTED_RESOLVE_REQUEST. Source snapshots use only the authorized installation for file-based dependency imports; data-module resolution remains native. This is a test/module-loading compatibility failure, not evidence of an OpenAI request or production Speech transport failure. Git history proves introduction of this test at 9eaab4ac49b27af235b6f949d7514af0252bbe36; first historical CI failure/environment onset is not proven. No repair made. Commands, stack and snapshot details: [historical-undici.json](historical-undici.json).

## Validation and baseline comparison

${table(['Run','Tests','Pass','Fail','Skip','Cancel'],[['Existing interpreter tests (included in focused)',interpreter.tests,interpreter.pass,interpreter.fail,interpreter.skipped,interpreter.cancelled],['Focused interpreter/reducer/authority/session + evaluation',focused.tests,focused.pass,focused.fail,focused.skipped,focused.cancelled],['Unchanged tracked baseline tests',baseline.tests,baseline.pass,baseline.fail,baseline.skipped,baseline.cancelled],['Complete serial discovery including five new evaluation tests',full.tests,full.pass,full.fail,full.skipped,full.cancelled]])}

All 24 failure names match exactly: 23 UNAPPROVED_BUSINESS failures plus the historical Undici module-resolution failure. No new failure, skip, cancellation or module-not-found load failure. The baseline comparison executes only committed tests against unchanged committed production source; the full run adds the five evaluation tests. Full commands and failure identities: [validation.json](validation.json). Syntax checks cover every new .js/.mjs file. Both git diff checks pass; tracked and staged diffs are empty.

## Later-candidate decision thresholds and recommendation

Required: complete-intent coverage >=95%; unsafe outcomes exactly zero; non-affirmative booking/SMS exactly zero; established single-service happy-path regressions zero; added p95 interpretation latency <=700 ms; deterministic fallback remains available. Current measured coverage and safety fail those gates. No latency claim can yet be made.

First compare an independent structured slot/intent extraction design plus an explicit availability-question flag: embedded availability, multiple facts and correction-plus-availability produce measured partial meaning. This is an evaluation recommendation, not approval to implement extraction rules or change business authority. It will not by itself solve consent vocabulary, unsupported upper bounds or irrelevant-number mistakes.

Evaluate a narrowly gated semantic fallback for UNKNOWN, partial-intent or conflicting turns against these identical frozen labels. Require catalogue grounding, typed slots/bounds, proposal-version checks and unchanged consent authorization; a model's affirmative guess must never replace real consent. The 180 phrase/extraction screening results and 44 representational gaps justify a measured comparison, not automatic deployment. Every fallback outcome must still pass the real reducer/authority path, including safe refusal.

The existing Realtime model with narrow typed tools is another comparison arm if it can emit all required meanings with deterministic validation and no duplicate effects. This corpus does not measure its latency, delivery reliability or semantic accuracy; reuse alone is not a reason to choose it. Run all candidates against the same label version, compare failures and unsafe rows, and measure real p95 incremental interpretation latency separately. Do not build or select a replacement in this task.

## Inventory and final state

The exact added-file inventory is [inventory.txt](inventory.txt); all files are under the new worktree's evaluation artifact or test directory. Final Git status is only \`?? evaluation/\` and \`?? realtime/voice-v2/tests/evaluation/\`. No production, package or lockfile changed. All work remains unstaged and uncommitted.
`;
writeFileSync(new URL('REPORT.md',output),text);
let details='# Per-category metrics\n\nN/A means no eligible denominator. Ambiguous cases are separate; unsafe counts include them.\n\n';
for(const [category,v]of Object.entries(s.categories))details+=`## ${category}\n\n`+
 table(['Metric','Result'],[['Cases',report.counts.byCategory[category]],['Turns / unambiguous / ambiguous',`${v.turns} / ${v.unambiguousTurns} / ${v.ambiguousTurns}`],['Complete intents',pct(v.completeIntentCoverage)],['Strict accuracy',pct(v.strictTurnAccuracy)],['Intent recall',pct(v.intentRecall)],['Intent precision',pct(v.intentPrecision)],['Appropriate clarification',pct(v.appropriateClarification)],['Unnecessary clarification',pct(v.unnecessaryClarification)],['Hallucination',pct(v.missingInformationHallucination)],['Unsafe turns',v.unsafeTurnCount]])+'\n'+
 table(['Slot','All','Populated'],Object.entries(v.slotAccuracy).map(([k,r])=>[k,pct(r.all),pct(r.populated)]))+'\n'+
 table(['Intent','Recall','Precision'],Object.entries(v.perIntent).map(([k,r])=>[k,pct(r.recall),pct(r.precision)]))+'\n';
writeFileSync(new URL('CATEGORY_DETAILS.md',output),details);
writeFileSync(new URL('AMBIGUOUS.md',output),'# Ambiguous turns, excluded from accuracy denominators\n\n'+table(['Case / turn','Text','Reason','Observed action','Unsafe'],rows.filter(r=>r.score.ambiguous).map(r=>[`${r.id}/${r.turn}`,r.text,r.expected.ambiguityReason,r.actual.actualAction,r.score.unsafe.join(', ')||'none'])));
console.log(JSON.stringify({report:'evaluation/voice-v2-interpreter-corpus/REPORT.md',focused,full,baseline,unsafeNonAffirmativeEffects:unsafeEffects.length,completeIntentCases:completeCases.length,unambiguousCases:unambiguousCases.length}));
