import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {evaluateCase,representedIntents} from './harness.mjs';
import {scoreTurn} from './scoring.mjs';
const raw=readFileSync(new URL('cases.json',import.meta.url));const corpus=JSON.parse(raw);
const required=['id','language','category','sourceType','referenceDate','timezone','businessLanguage','transcriptionLanguage','serviceCatalogue','businessHours',
  'initialProposal','currentRequirement','lastResponsePurpose','alternatives','turns','expectedIntents','expectedServicesInMentionOrder','expectedDate',
  'expectedExactTime','expectedDaypart','expectedLowerBound','expectedUpperBound','expectedName','expectedConfirmation','expectedCorrectionTarget','expectedEffects','expectedClarification','ambiguityReason'];

test('corpus is populated, independently labeled, hash locked and satisfies all quotas',()=>{
 assert.equal(createHash('sha256').update(raw).digest('hex'),readFileSync(new URL('labels.sha256',import.meta.url),'utf8').split(' ')[0]);
 assert.ok(corpus.length>=160);assert.equal(new Set(corpus.map(c=>c.id)).size,corpus.length);
 for(const language of ['en','es'])assert.ok(corpus.filter(c=>c.language===language).length>=70);
 assert.ok(corpus.filter(c=>c.turns.length===1).length>=120);assert.ok(corpus.filter(c=>c.turns.length>1).length>=40);
 assert.ok(corpus.filter(c=>c.businessLanguage!==c.language||c.tags.includes('mixed_language')).length>=20);
 assert.ok(corpus.filter(c=>c.tags.includes('filler_noise')).length>=20);
 for(const c of corpus){for(const field of required)assert.ok(field in c,`${c.id}/${field}`);for(const t of c.turns){
   assert.ok(t.text.trim());for(const field of required.filter(k=>k.startsWith('expected')||k==='ambiguityReason'))assert.ok(field in t);
   assert.equal(new Set(t.expectedIntents).size,t.expectedIntents.length);
 }}
 const placeholders=JSON.parse(readFileSync(new URL('owner-placeholders.json',import.meta.url)));
 assert.equal(placeholders.filter(c=>c.id.startsWith('owner-single')).length,25);assert.equal(placeholders.filter(c=>c.id.startsWith('owner-dialogue')).length,8);
 assert.ok(placeholders.every(c=>!c.populated&&c.turns.length===0));
});

test('single-action results may represent several facts but cannot get credit for a missing availability intent',()=>{
 const before={service:null,date:null,time:null,name:null};const after={...before,service:'Haircut',date:'2026-10-24'};
 const intents=representedIntents({action:'BOOK_REQUEST',service:'Haircut',date:'2026-10-24'},before,after,[]);
 assert.deepEqual(intents,['BOOK_REQUEST','SET_DATE','SET_SERVICE']);assert.ok(!intents.includes('REQUEST_AVAILABILITY'));
});

test('scoring never counts partial meaning or unsafe non-affirmative effects as a full pass',()=>{
 const expected=corpus.find(c=>c.id==='embedded_availability-en-01').turns[0];
 const before={service:null,date:null,time:null,name:null};
 const actual={actualIntentsRepresented:['BOOK_REQUEST','SET_SERVICE','SET_DATE'],actualAction:'BOOK_REQUEST',actualServicesInMentionOrder:['Haircut'],
  actualProposal:{service:'Haircut',date:expected.expectedDate,time:null},actualDate:expected.expectedDate,actualExactTime:null,actualDaypart:'AFTERNOON',
  actualLowerBound:null,actualUpperBound:null,actualName:null,actualConfirmation:'none',actualCorrectionTarget:null,
  availabilityEffectCount:1,bookingEffectCount:1,smsEffectCount:1,bookingAuthorityCreated:true,actualClarification:false,beforeProposal:before};
 const score=scoreTurn(expected,actual);assert.equal(score.intentCoverage,false);assert.equal(score.pass,false);
 assert.ok(score.unsafe.includes('AUTHORITY_FROM_NON_AFFIRMATIVE'));assert.ok(score.unsafe.includes('BOOKING_OR_SMS_FROM_NON_AFFIRMATIVE'));
});

test('real session accepts an injected current-interface interpreter with no external boundary',async()=>{
 const c=corpus.find(c=>c.id==='missing_information-en-02');let calls=0;
 const result=await evaluateCase(c,{interpreter:async({sourceTurnId})=>{calls++;return{interpretation:{action:'SET_SERVICE',service:'Haircut',sourceTurnId,confidence:'explicit'},languageEvidence:{language:null,confidence:'none'}};}});
 assert.equal(calls,1);assert.equal(result.turns[0].actualProposal.service,'Haircut');assert.equal(result.turns[0].bookingEffectCount,0);
});

test('real session corpus smoke output is deterministic with duplicate delivery inert',async()=>{
 const c=corpus.find(c=>c.id==='dialogue-paused-en-1');const a=await evaluateCase(c),b=await evaluateCase(c);
 assert.deepEqual(a,b);assert.equal(a.turns[2].interpretationCount,0);assert.equal(a.turns[2].bookingEffectCount,0);
});
