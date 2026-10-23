import moment from 'moment-timezone';
import { initializeVoiceV2Session } from '../../../initializeVoiceV2Session.js';
import { VoiceCoordinator } from '../../../VoiceCoordinator.js';
import { interpretTurn } from '../../../interpretation/TurnInterpreter.js';
import { createBookingProposal, deriveBookingRequirement, deriveSlotKey } from '../../../domain/BookingProposal.js';
import { V1AvailabilityAdapter } from '../../../adapters/V1AvailabilityAdapter.js';
import { FakeSocket } from '../../helpers/FakeSocket.js';

const clone=value=>JSON.parse(JSON.stringify(value));
const facts=proposal=>({service:proposal.service,additionalServices:proposal.additionalServices||[],date:proposal.date,time:proposal.time,name:proposal.name});
const compactCommand=c=>Object.fromEntries(['type','service','date','time','requestedDate','afterTime','searchType','searchPreference','proposalVersion']
  .filter(key=>c[key]!==undefined).map(key=>[key,clone(c[key])]));

// No utterance parsing occurs here. Meanings are projected only from the
// candidate's structured action/facts and the real application's effect records.
export function representedIntents(action,before,after,searches,replayed=false) {
  if(replayed||!action)return[];
  const represented=new Set(Array.isArray(action.intents)?action.intents:[]);
  const type=action.action;
  const direct={BOOK_REQUEST:'BOOK_REQUEST',REQUEST_AVAILABLE_TIMES_FOR_DATE:'REQUEST_AVAILABILITY',REQUEST_LATER_TIME:'REQUEST_AVAILABILITY',
    SELECT_ALTERNATIVE:'SELECT_ALTERNATIVE',AFFIRM_CONFIRMATION:'AFFIRM_CONFIRMATION',REJECT_CONFIRMATION:'DENY_CONFIRMATION',
    ABANDON_PROPOSAL:'CANCEL_BOOKING',CANCEL:'CANCEL_BOOKING',NO_INFORMATION:'NO_INFORMATION'};
  if(direct[type])represented.add(direct[type]);
  let repeated=false;
  for(const field of ['service','date','time','name']){
    const supplied=action[field]!==undefined||(type==='SELECT_ALTERNATIVE'&&['date','time'].includes(field)&&after[field]!==before[field]);
    if(!supplied)continue;
    const value=action[field]??after[field];
    const changed=field==='service'?(value!==before.service||JSON.stringify(action.additionalServices||[])!==JSON.stringify(before.additionalServices||[])):value!==before[field];
    if(changed)represented.add(`${before[field]===null?'SET':'CORRECT'}_${field.toUpperCase()}`);
    else if(['BOOK_REQUEST',`SET_${field.toUpperCase()}`,`MODIFY_${field.toUpperCase()}`].includes(type))repeated=true;
  }
  if(repeated&&!['REQUEST_AVAILABLE_TIMES_FOR_DATE','REQUEST_LATER_TIME'].includes(type))represented.add('REPEAT_INFORMATION');
  if(searches.length)represented.add('REQUEST_AVAILABILITY');
  return [...represented].sort();
}

export async function evaluateCase(c,{interpreter=interpretTurn}={}) {
  const socket=new FakeSocket(),twilio=new FakeSocket();socket.readyState=0;
  const effects=[],captures=[],events=[];let delivery=0;const delivered=new Set();let clock=0;
  const barber={availability:{timezone:c.timezone,businessHours:c.businessHours},services:c.serviceCatalogue.map(s=>({name:s.canonical,durationMinutes:30}))};
  const inHours=(date,time)=>{
    const day=moment.tz(date,'YYYY-MM-DD',c.timezone).format('ddd').toLowerCase();const h=c.businessHours[day];
    return !!h&&!h.isClosed&&time>=h.open&&time<h.close;
  };
  // Deterministic external slot fixture: three afternoon choices by default;
  // expanded candidates for real adapter preference filtering. No production IO.
  const availability=new V1AvailabilityAdapter({findBarberByIdFn:async()=>barber,getServiceDurationFn:()=>30,
    checkAvailabilityFn:async request=>inHours(request.date,moment(request.time,'h:mm A').format('HH:mm')),
    findAlternativesFn:async()=>[],getAvailableSlotsFn:async({date,limit,startAfterTime})=>{
      const pool=limit===48||startAfterTime?['09:00','10:00','11:00','14:00','15:00','16:00','17:00']:['14:00','15:00','16:00'];
      const lower=startAfterTime?moment(startAfterTime,'h:mm A').format('HH:mm'):null;
      return pool.filter(time=>inHours(date,time)&&(!lower||time>lower)).slice(0,limit||48)
        .map(time=>({date,time:moment(time,'HH:mm').format('h:mm A')}));
    }});
  const record=async(type,command,operation)=>{
    const entry={type,command:compactCommand({...command,type})};effects.push(entry);
    const value=await operation();entry.result=clone(value);return value;
  };
  const base=c.initialProposal;
  const version=1,slotKey=deriveSlotKey(base);
  const proposal=createBookingProposal({proposalId:c.id,...base,proposalVersion:version,
    availability:{proposalVersion:version,slotKey,status:c.alternatives.length?'unavailable':base.service&&base.date&&base.time?'available':'unknown',
      alternatives:c.alternatives.map(a=>({...a,slotKey:deriveSlotKey({service:base.service,...a})})),
      ...(c.alternatives.length?{schedulingReference:{proposalVersion:version,service:base.service,requestedDate:base.date,searchType:'DATE',afterTime:null}}:{})}});
  const coordinator=new VoiceCoordinator({interpreter:async input=>{
    const result=await interpreter(input);captures.push({turnId:input.sourceTurnId,result:clone(result)});return result;
  }});
  const app=initializeVoiceV2Session({callSid:`CA-eval-${c.id}`,callerNumber:'offline',buildSha:'corpus-evaluation',
    businessContext:{businessId:'synthetic',barberId:'synthetic',timeZone:c.timezone},proposal,coordinator,
    twilioSocket:twilio,openaiSocketFactory:()=>socket,
    openaiSession:{model:'offline-model',voice:'alloy',input_audio_transcription:{model:'gpt-4o-mini-transcribe',language:c.transcriptionLanguage}},
    turnContext:{language:c.businessLanguage,availableServices:c.serviceCatalogue,referenceDate:c.referenceDate},
    scheduler:{schedule:()=>({}),cancel(){}},now:()=>new Date(`${c.referenceDate}T12:00:00Z`),
    timingOptions:{monotonicNow:()=>++clock,wallNow:()=>`${c.referenceDate}T12:00:00.000Z`},
    availabilityAdapter:{checkAvailability:command=>record('CHECK_AVAILABILITY',command,()=>availability.checkAvailability(command)),
      searchAvailableTimes:command=>record('SEARCH_AVAILABILITY',command,()=>availability.searchAvailableTimes(command)),
      getAlternatives:command=>availability.getAlternatives(command)},
    bookingAdapter:{createAppointment:command=>record('CREATE_APPOINTMENT',command,async()=>({success:true,appointmentId:'offline-appointment'}))},
    smsAdapter:{sendAppointmentConfirmation:command=>record('SEND_CONFIRMATION_SMS',command,async()=>({success:true,submitted:false}))},
    transcriptAdapter:{appendTurn:async()=>({success:true}),finalizeCall:async()=>({success:true})},emit:event=>events.push(event)});
  const creates=()=>socket.sent.filter(e=>e.type==='response.create');
  const lastPurpose=()=>creates().at(-1)?.response.metadata.purpose||null;
  const snapshots=[];
  async function settle(){for(let i=0;i<24;i++){await Promise.resolve();await app.ready();}}
  async function acknowledgeConfiguration(){
    for(const update of socket.sent.filter(e=>e.type==='session.update'&&e.event_id&&!delivered.has(e.event_id))){
      delivered.add(update.event_id);socket.receive({type:'session.updated',session:{audio:{input:update.session.audio.input}}});await settle();
    }
  }
  async function complete(){
    const create=creates().at(-1);if(!create||delivered.has(create.response.metadata.v2RequestId)||app.lifecycle.terminated)return;
    const requestId=create.response.metadata.v2RequestId;delivered.add(requestId);
    const contract=JSON.parse(create.response.instructions),purpose=contract.purpose;
    const ordinary={INITIAL_GREETING:'Hello.',ASK_SERVICE:'Which service would you like?',ASK_DATE:'What date would you like?',
      ASK_TIME:'What time would you like?',ASK_NAME:'What name should I use?',CLARIFICATION:'Could you clarify?',
      SCHEDULING_ALTERNATIVES:'Which of the supplied times would you prefer?',OFFER_ALTERNATIVES:'Which of the supplied times would you prefer?',
      NO_AVAILABLE_TIMES:'Please choose another date.',SLOT_UNAVAILABLE:'Please choose another time.',CLARIFY_LATER_REFERENCE:'Which option do you mean?',
      BOOKING_SUCCESS:'Your appointment is booked. Goodbye.',BOOKING_ABANDONED:'Goodbye.',AMBIGUITY_LIMIT_REACHED:'Please call again. Goodbye.',ERROR_RECOVERY:'Please call again. Goodbye.'};
    const transcript=contract.speechContract.requiredMessage||ordinary[purpose]||'Could you clarify?';
    const responseId=`eval-response-${++delivery}`;
    socket.receive({type:'response.created',response:{id:responseId,metadata:create.response.metadata}});
    socket.receive({type:'response.output_audio.delta',response_id:responseId,delta:'AQID'});
    socket.receive({type:'response.output_audio_transcript.done',response_id:responseId,transcript});
    socket.receive({type:'response.done',response:{id:responseId,status:'completed'}});await settle();
    const mark=twilio.sent.filter(e=>e.event==='mark').at(-1);
    if(mark){twilio.receive({event:'mark',streamSid:'eval-stream',mark:mark.mark});await settle();}
  }
  try{
    socket.open();twilio.receive({event:'start',start:{callSid:app.session.callSid,streamSid:'eval-stream'}});
    socket.receive({type:'session.created'});await settle();socket.receive({type:'session.updated'});await settle();await complete();
    // Establish the case's authored response context using the real planner,
    // validator, response registry, playback acknowledgement and consent gate.
    if(c.lastResponsePurpose&&c.lastResponsePurpose!=='INITIAL_GREETING'){
      await app.requestResponse(coordinator.responsePlanner({proposal:app.session.proposal,purpose:c.lastResponsePurpose,language:c.businessLanguage}));
      await settle();await complete();
    }
    for(const turn of c.turns){
      const before=clone(app.session.proposal),effectOffset=effects.length,captureOffset=captures.length,journalOffset=app.session.journal().length;
      if(turn.speechDuringPreparation){socket.receive({type:'input_audio_buffer.speech_started',item_id:turn.itemId});await settle();}
      socket.receive({type:'conversation.item.input_audio_transcription.completed',event_id:`event:${turn.itemId}`,item_id:turn.itemId,transcript:turn.text});await settle();
      if(turn.speechDuringPreparation){socket.receive({type:'input_audio_buffer.speech_stopped',item_id:turn.itemId});await settle();}
      await acknowledgeConfiguration();
      const ownCaptures=captures.slice(captureOffset),action=ownCaptures.at(-1)?.result.interpretation||null;
      const ownEffects=clone(effects.slice(effectOffset));const search=ownEffects.filter(e=>e.type==='SEARCH_AVAILABILITY');
      const journal=app.session.journal().slice(journalOffset),after=clone(app.session.proposal);
      const represented=representedIntents(action,before,after,search,!ownCaptures.length);
      const preference=search.at(-1)?.command.searchPreference||action?.searchPreference||null;
      const clarification=ownCaptures.length>0&&(['UNKNOWN','CLARIFY'].includes(action?.action)
        ||journal.some(e=>e.event==='EFFECT_QUEUED'&&e.effectType==='REQUEST_CLARIFICATION')
        ||(creates().at(-1)?.response.metadata.proposalVersion===String(after.proposalVersion)&&['ASK_SERVICE','ASK_DATE','ASK_TIME','ASK_NAME','CLARIFICATION','CLARIFY_LATER_REFERENCE','CONSENT_REASK'].includes(lastPurpose())));
      const correction=represented.filter(i=>i.startsWith('CORRECT_')).map(i=>i.slice(8).toLowerCase());
      const authorizationCount=journal.filter(e=>e.event==='EFFECT_QUEUED'&&e.effectType==='AUTHORIZE_BOOKING').length;
      const output={actualAction:action?.action||(app.lifecycle.terminated?'NOT_INTERPRETED_TERMINATED':'DUPLICATE_OR_QUARANTINED'),
        actualIntentsRepresented:represented,actualProposal:after,actualRequirement:deriveBookingRequirement(after),actualEffects:ownEffects,
        actualClarification:clarification,bookingAuthorityCreated:authorizationCount>0,
        bookingEffectCount:ownEffects.filter(e=>e.type==='CREATE_APPOINTMENT').length,smsEffectCount:ownEffects.filter(e=>e.type==='SEND_CONFIRMATION_SMS').length,
        availabilityEffectCount:ownEffects.filter(e=>['SEARCH_AVAILABILITY','CHECK_AVAILABILITY'].includes(e.type)).length,
        actualServicesInMentionOrder:after.service?[after.service,...(after.additionalServices||[])]:[],
        actualDate:after.date,actualExactTime:after.time,actualName:after.name,
        actualDaypart:['MORNING','AFTERNOON'].includes(preference?.kind)?preference.kind:null,
        actualLowerBound:preference&&['AFTER','AT_OR_AFTER'].includes(preference.kind)?{time:search.at(-1)?.result.resolvedLowerTime||preference.time,inclusive:preference.kind==='AT_OR_AFTER'}
          :search.at(-1)?.command.searchType==='LATER'?{time:search.at(-1).command.afterTime,inclusive:false}:null,
        actualUpperBound:null,actualCorrectionTarget:correction.length===1?correction[0]:correction.length?correction:null,
        actualConfirmation:action?.action==='AFFIRM_CONFIRMATION'?'affirm':action?.action==='REJECT_CONFIRMATION'?'deny'
          :c.lastResponsePurpose==='PRE_BOOKING_CONFIRMATION'&&['UNKNOWN','CLARIFY'].includes(action?.action)?'unknown':'none',
        actualConversationLanguage:app.session.conversationLanguage.currentLanguage,interpretationCount:ownCaptures.length,
        terminated:app.lifecycle.terminated,beforeProposal:before};
      snapshots.push({itemId:turn.itemId,...output});
      if(!turn.holdResponse)await complete();
    }
    return {id:c.id,turns:snapshots};
  }finally{await app.terminate('EVALUATION_DONE');await settle();}
}

export async function evaluateCorpus(corpus,options={}){
  const results=[];for(const c of corpus)results.push(await evaluateCase(c,options));return results;
}
