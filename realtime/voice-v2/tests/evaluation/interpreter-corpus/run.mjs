import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { evaluateCorpus } from './harness.mjs';
import { scoreCorpus } from './scoring.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const directory=new URL('./',import.meta.url),raw=readFileSync(new URL('cases.json',directory));
const labelHash=sha(raw),locked=readFileSync(new URL('labels.sha256',directory),'utf8').split(' ')[0];
if(labelHash!==locked)throw Error('LABEL_HASH_CHANGED');
const corpus=JSON.parse(raw);
const options={};
const candidate=process.argv.find(a=>a.startsWith('--interpreter='))?.slice('--interpreter='.length);
if(candidate){const module=await import(pathToFileURL(candidate).href);options.interpreter=module.interpretTurn||module.default;if(typeof options.interpreter!=='function')throw Error('INVALID_INTERPRETER_INTERFACE');}
const output=new URL('../../../../../evaluation/voice-v2-interpreter-corpus/',import.meta.url);mkdirSync(output,{recursive:true});
const hashes=[],failureHashes=[],proposalEffectHashes=[];let scored;
for(let run=1;run<=3;run++){
  const results=await evaluateCorpus(corpus,options);const serialized=JSON.stringify(results);
  const score=scoreCorpus(corpus,results);scored=score;
  hashes.push(sha(serialized));
  failureHashes.push(sha(JSON.stringify(score.rows.filter(r=>!r.score.pass).map(r=>[r.id,r.turn]))));
  proposalEffectHashes.push(sha(JSON.stringify(results.map(c=>c.turns.map(t=>({proposal:t.actualProposal,effects:t.actualEffects}))))));
  writeFileSync(new URL(`run-${run}.json`,output),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify({run,resultSha256:hashes.at(-1),failureSha256:failureHashes.at(-1),proposalEffectSha256:proposalEffectHashes.at(-1)}));
  if(run>1&&(hashes.at(-1)!==hashes[0]||failureHashes.at(-1)!==failureHashes[0]||proposalEffectHashes.at(-1)!==proposalEffectHashes[0]))throw Error('NONDETERMINISM_STOP');
}
if(sha(readFileSync(new URL('cases.json',directory)))!==labelHash)throw Error('LABELS_MUTATED');
const counts={populated:corpus.length,singleTurn:corpus.filter(c=>c.turns.length===1).length,multiTurn:corpus.filter(c=>c.turns.length>1).length,
  byLanguage:Object.fromEntries(['en','es'].map(l=>[l,corpus.filter(c=>c.language===l).length])),
  bySourceType:Object.fromEntries(['synthetic','supplied_real_phrase'].map(s=>[s,corpus.filter(c=>c.sourceType===s).length])),
  byCategory:Object.fromEntries([...new Set(corpus.map(c=>c.category))].sort().map(s=>[s,corpus.filter(c=>c.category===s).length])),
  mixedOrMismatch:corpus.filter(c=>c.businessLanguage!==c.language||c.tags.includes('mixed_language')).length,
  noiseOrArtifact:corpus.filter(c=>c.tags.includes('filler_noise')).length};
const report={baseline:'21ec066f939f8820478ce6997398ad9a6b554373',counts,labelSha256:labelHash,
  determinism:{resultHashes:hashes,failureHashes,proposalEffectHashes,identical:true},summary:scored.summary};
writeFileSync(new URL('summary.json',output),JSON.stringify(report,null,2)+'\n');
writeFileSync(new URL('scored-turns.json',output),JSON.stringify(scored.rows,null,2)+'\n');
const clean=v=>String(v).replaceAll('|','\\|').replaceAll('\n',' ');
const json=v=>clean(JSON.stringify(v));
let failures='| Case / turn | Language | Utterance | Expected intents | Actual intents/action | Expected slots | Actual slots | Other failures |\n|---|---|---|---|---|---|---|---|\n';
for(const r of scored.rows.filter(r=>!r.score.pass))failures+=`| ${r.id} / ${r.turn} | ${r.language} | ${clean(r.text)} | ${json(r.expected.expectedIntents)} | ${json(r.actual.actualIntentsRepresented)}; ${r.actual.actualAction} | ${json({services:r.expected.expectedServicesInMentionOrder,date:r.expected.expectedDate,time:r.expected.expectedExactTime,daypart:r.expected.expectedDaypart,lower:r.expected.expectedLowerBound,upper:r.expected.expectedUpperBound,name:r.expected.expectedName,confirmation:r.expected.expectedConfirmation,correction:r.expected.expectedCorrectionTarget})} | ${json({services:r.actual.actualServicesInMentionOrder,date:r.actual.actualDate,time:r.actual.actualExactTime,daypart:r.actual.actualDaypart,lower:r.actual.actualLowerBound,upper:r.actual.actualUpperBound,name:r.actual.actualName,confirmation:r.actual.actualConfirmation,correction:r.actual.actualCorrectionTarget})} | ${json({slots:r.score.slots,effects:r.score.effects,clarification:r.score.clarification,unsafe:r.score.unsafe,ambiguous:r.score.ambiguous})} |\n`;
writeFileSync(new URL('FAILURES.md',output),failures);
let unsafe='| Case / turn | Utterance | Unsafe outcome | Expected → actual |\n|---|---|---|---|\n';
for(const r of scored.rows.filter(r=>r.score.unsafe.length))unsafe+=`| ${r.id} / ${r.turn} | ${clean(r.text)} | ${r.score.unsafe.join(', ')} | ${json({expected:r.expected,actual:{services:r.actual.actualServicesInMentionOrder,date:r.actual.actualDate,time:r.actual.actualExactTime,authority:r.actual.bookingAuthorityCreated,booking:r.actual.bookingEffectCount,sms:r.actual.smsEffectCount}})} |\n`;
writeFileSync(new URL('UNSAFE.md',output),unsafe);
let categories='| Category | Cases | Unambiguous turns | Complete-intent coverage | Strict turn accuracy | Unsafe turns |\n|---|---:|---:|---:|---:|---:|\n';
for(const [category,s]of Object.entries(scored.summary.categories))categories+=`| ${category} | ${counts.byCategory[category]} | ${s.unambiguousTurns} | ${s.completeIntentCoverage.percent??'N/A'}% | ${s.strictTurnAccuracy.percent??'N/A'}% | ${s.unsafeTurnCount} |\n`;
writeFileSync(new URL('CATEGORIES.md',output),categories);
console.log(JSON.stringify({counts,summary:{coverage:scored.summary.completeIntentCoverage,strict:scored.summary.strictTurnAccuracy,
  unsafeTurns:scored.summary.unsafeTurnCount,unsafeCases:scored.summary.unsafeCaseCount,oneActionPartial:scored.summary.oneActionPartialTurns}}));
