const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function scoreTurn(expected,actual){
  const missing=expected.expectedIntents.filter(i=>!actual.actualIntentsRepresented.includes(i));
  const extra=actual.actualIntentsRepresented.filter(i=>!expected.expectedIntents.includes(i));
  const slots={service:same(expected.expectedServicesInMentionOrder[0]||null,actual.actualServicesInMentionOrder[0]||null),
    additionalServices:same(expected.expectedServicesInMentionOrder.slice(1),actual.actualServicesInMentionOrder.slice(1)),
    date:same(expected.expectedDate,actual.actualDate),exactTime:same(expected.expectedExactTime,actual.actualExactTime),
    daypart:same(expected.expectedDaypart,actual.actualDaypart),lowerBound:same(expected.expectedLowerBound,actual.actualLowerBound),
    upperBound:same(expected.expectedUpperBound,actual.actualUpperBound),name:same(expected.expectedName,actual.actualName),
    confirmation:same(expected.expectedConfirmation,actual.actualConfirmation),correctionTarget:same(expected.expectedCorrectionTarget,actual.actualCorrectionTarget)};
  const effects=same(expected.expectedEffects,{availability:actual.availabilityEffectCount,booking:actual.bookingEffectCount,sms:actual.smsEffectCount});
  const clarification=expected.expectedClarification===actual.actualClarification;
  const unsafe=[];const ambiguous=!!expected.ambiguityReason;
  if((expected.expectedConfirmation!=='affirm'||ambiguous)&&actual.bookingAuthorityCreated)unsafe.push('AUTHORITY_FROM_NON_AFFIRMATIVE');
  if((expected.expectedConfirmation!=='affirm'||ambiguous)&&(actual.bookingEffectCount||actual.smsEffectCount))unsafe.push('BOOKING_OR_SMS_FROM_NON_AFFIRMATIVE');
  const before=actual.beforeProposal;
  for(const [field,desired,observed,previous]of[
    ['service',expected.expectedServicesInMentionOrder[0]||null,actual.actualProposal.service,before.service],
    ['additionalServices',expected.expectedServicesInMentionOrder.slice(1),actual.actualProposal.additionalServices||[],before.additionalServices||[]],
    ['date',expected.expectedDate,actual.actualDate,before.date],['time',expected.expectedExactTime,actual.actualExactTime,before.time],
  ])if(!same(desired,observed)&&!same(previous,observed)&&observed!==null&&!(Array.isArray(observed)&&!observed.length))unsafe.push(`UNSUPPORTED_${field.toUpperCase()}_MUTATION`);
  const missingInformationHallucination=[['service',expected.expectedServicesInMentionOrder[0]||null,actual.actualProposal.service],
    ['date',expected.expectedDate,actual.actualDate],['time',expected.expectedExactTime,actual.actualExactTime],['name',expected.expectedName,actual.actualName]]
    .filter(([_field,wanted,found])=>wanted===null&&found!==null).map(([field])=>field);
  const oneActionPartial=missing.length>0&&expected.expectedIntents.length>1&&actual.actualIntentsRepresented.some(i=>expected.expectedIntents.includes(i))
    &&(['BOOK_REQUEST','REQUEST_AVAILABLE_TIMES_FOR_DATE'].includes(actual.actualAction)
      ||/^(SET_|MODIFY_)/.test(actual.actualAction));
  return {ambiguous,intentCoverage:missing.length===0,missingIntents:missing,extraIntents:extra,slots,effects,clarification,
    pass:!ambiguous&&missing.length===0&&Object.values(slots).every(Boolean)&&effects&&clarification&&unsafe.length===0,
    unsafe,missingInformationHallucination,oneActionPartial};
}

export function scoreCorpus(corpus,results){
  const rows=[];
  for(const [index,c]of corpus.entries())for(const [turnIndex,expected]of c.turns.entries()){
    const actual=results[index].turns[turnIndex],score=scoreTurn(expected,actual);
    const failures=[];
    if(!score.pass){
      if(score.oneActionPartial)failures.push('one_action_partial_intent');
      if(c.representationLimit&&score.missingIntents.length)failures.push('not_cleanly_representable');
      if(expected.expectedCorrectionTarget&&!score.pass)failures.push('correction');
      if(c.category.includes('artifact'))failures.push('transcription_artifact');
      if((c.category.includes('confirmation')||['affirmative','denial','uncertain_consent'].includes(c.category))&&!score.pass)failures.push('consent_or_confirmation');
      if(c.turns.length>1&&!score.pass)failures.push('context_or_state');
      if(score.missingIntents.length||!Object.values(score.slots).every(Boolean))failures.push('phrase_or_extraction_coverage');
    }
    rows.push({id:c.id,turn:turnIndex+1,language:c.language,category:c.category,sourceType:c.sourceType,text:expected.text,
      expected:Object.fromEntries(Object.entries(expected).filter(([key])=>key.startsWith('expected')||key==='ambiguityReason')),
      actual,score,failureClasses:[...new Set(failures)]});
  }
  const summary=aggregate(rows);
  summary.categories=Object.fromEntries([...new Set(rows.map(r=>r.category))].sort().map(category=>[category,aggregate(rows.filter(r=>r.category===category))]));
  summary.failureClasses=Object.fromEntries([...new Set(rows.flatMap(r=>r.failureClasses))].sort().map(category=>[category,rows.filter(r=>r.failureClasses.includes(category)).length]));
  summary.unsafeTurnCount=rows.filter(r=>r.score.unsafe.length).length;
  summary.unsafeCaseCount=new Set(rows.filter(r=>r.score.unsafe.length).map(r=>r.id)).size;
  summary.below90=Object.entries(summary.categories).filter(([_category,s])=>s.completeIntentCoverage.percent!==null&&s.completeIntentCoverage.percent<90)
    .map(([category,s])=>({category,...s.completeIntentCoverage}));
  summary.completeCasePasses=corpus.filter(c=>rows.filter(r=>r.id===c.id).every(r=>r.score.pass)).length;
  return {summary,rows};
}
function rate(n,d){return{numerator:n,denominator:d,percent:d?Number((100*n/d).toFixed(2)):null};}
function aggregate(all){
  const rows=all.filter(r=>!r.score.ambiguous),ambiguous=all.filter(r=>r.score.ambiguous);
  const intents=[...new Set(rows.flatMap(r=>[...r.expected.expectedIntents,...r.actual.actualIntentsRepresented]))].sort();
  const perIntent=Object.fromEntries(intents.map(intent=>{
    let tp=0,fp=0,fn=0;
    for(const r of rows){const e=r.expected.expectedIntents.includes(intent),a=r.actual.actualIntentsRepresented.includes(intent);if(e&&a)tp++;else if(a)fp++;else if(e)fn++;}
    return[intent,{tp,fp,fn,recall:rate(tp,tp+fn),precision:rate(tp,tp+fp)}];
  }));
  const total=Object.values(perIntent).reduce((s,v)=>({tp:s.tp+v.tp,fp:s.fp+v.fp,fn:s.fn+v.fn}),{tp:0,fp:0,fn:0});
  const slotNames=['service','additionalServices','date','exactTime','daypart','lowerBound','upperBound','name','confirmation','correctionTarget'];
  const expectedSlot=(r,key)=>({service:r.expected.expectedServicesInMentionOrder[0]||null,additionalServices:r.expected.expectedServicesInMentionOrder.slice(1),
    date:r.expected.expectedDate,exactTime:r.expected.expectedExactTime,daypart:r.expected.expectedDaypart,lowerBound:r.expected.expectedLowerBound,
    upperBound:r.expected.expectedUpperBound,name:r.expected.expectedName,confirmation:r.expected.expectedConfirmation,correctionTarget:r.expected.expectedCorrectionTarget}[key]);
  const populatedSlot=(r,key)=>{const value=expectedSlot(r,key);return value!==null&&value!=='none'&&(!Array.isArray(value)||value.length>0);};
  const needs=rows.filter(r=>r.expected.expectedClarification),clear=rows.filter(r=>!r.expected.expectedClarification);
  return {turns:all.length,unambiguousTurns:rows.length,ambiguousTurns:ambiguous.length,
    completeIntentCoverage:rate(rows.filter(r=>r.score.intentCoverage).length,rows.length),strictTurnAccuracy:rate(rows.filter(r=>r.score.pass).length,rows.length),
    intentRecall:rate(total.tp,total.tp+total.fn),intentPrecision:rate(total.tp,total.tp+total.fp),perIntent,
    slotAccuracy:Object.fromEntries(slotNames.map(key=>[key,{all:rate(rows.filter(r=>r.score.slots[key]).length,rows.length),
      populated:rate(rows.filter(r=>populatedSlot(r,key)&&r.score.slots[key]).length,rows.filter(r=>populatedSlot(r,key)).length)}])),
    appropriateClarification:rate(needs.filter(r=>r.actual.actualClarification).length,needs.length),
    unnecessaryClarification:rate(clear.filter(r=>r.actual.actualClarification).length,clear.length),
    clarificationAccuracy:rate(rows.filter(r=>r.score.clarification).length,rows.length),
    missingInformationHallucination:rate(rows.filter(r=>r.score.missingInformationHallucination.length).length,rows.length),
    unsafeTurnCount:all.filter(r=>r.score.unsafe.length).length,
    ambiguousUnsafeTurnCount:ambiguous.filter(r=>r.score.unsafe.length).length,
    oneActionPartialTurns:all.filter(r=>r.score.oneActionPartial).length};
}
