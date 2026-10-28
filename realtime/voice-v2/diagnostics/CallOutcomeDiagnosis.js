// Diagnostic-only aggregation. No transcript, raw error, timers, observers or effect callbacks retained.
import { STRUCTURED_BOUNDARIES, STRUCTURED_FAILURE_REASONS } from './StructuredPhoneFailure.js';
const AVAILABILITY=new Set(['CHECK_AVAILABILITY','REQUEST_AVAILABLE_TIMES_FOR_DATE','REQUEST_LATER_TIME']);
const UNRESOLVED=new Set(['UNKNOWN','NO_INFORMATION','CLARIFY']);
const BOUNDARIES=new Set(['PLAN_ACCEPTED','REQUEST_CREATED','REQUEST_BODY_SENT','RESPONSE_HEADERS_RECEIVED','RESPONSE_BODY_COMPLETED','AUDIO_CONVERTED','AUDIO_PREPARED','ASSISTANT_PERSISTED','MEDIA_SUBMITTED','MARK_CREATED','MARK_ACKNOWLEDGED','RECOVERY_STARTED','RECOVERY_MEDIA_SUBMITTED','RECOVERY_MARK_CREATED','RECOVERY_MARK_ACKNOWLEDGED','TERMINATION_REQUESTED']);
const COUNT_FIELDS=['acceptedTurnCount','emptyTranscriptCount','unresolvedInterpretationCount','clarificationCount','availabilityAttemptCount','availabilitySuccessCount','availabilityFailureCount','bookingAttemptCount','bookingSuccessCount','bookingFailureCount','responseFailureCount','deliverySuccessCount','recoveryDeliveryCount','playbackFailureCount'];
const id=v=>typeof v==='string'&&/^[A-Za-z0-9_:./-]{1,128}$/.test(v)?v:null;
export class CallOutcomeDiagnosis {
 #sequence=0;#first=null;#lastFailure=0;#lastDelivery=0;#recovery=false;#closed=false;#limited=false;
 #empty=0;#interpretation=0;#limitReached=false;#transcriptionFailure=0;#items=new Map();
 #currentVersion=null;#caller=false;#provider=false;#counts=Object.fromEntries(COUNT_FIELDS.map(k=>[k,0]));
 #commands=new Map();
 #structuredFailure=null;
 structuredFailure(record){
  try{
   if(this.#closed||this.#structuredFailure||record?.event!=='V2_STRUCTURED_PHONE_FAILURE')return;
   if(!STRUCTURED_BOUNDARIES.includes(record.stage)||!STRUCTURED_BOUNDARIES.includes(record.lastCompletedBoundary)||!STRUCTURED_FAILURE_REASONS.includes(record.reasonCode))return;
   this.#structuredFailure={failed:record.stage,last:record.lastCompletedBoundary,reasonCode:record.reasonCode};
  }catch{/* No diagnostic callback changes aggregation or call behavior. */}
 }
 #increment(key){this.#counts[key]=Math.min(1000000,this.#counts[key]+1);}
 // Keep identities only to a fixed ceiling; never evict and recount a command.
 #command(type,commandId){
  if(typeof commandId!=='string'||!commandId.length||commandId.length>512){this.#limited=true;return null;}
  const key=JSON.stringify([type,commandId]);let command=this.#commands.get(key);
  if(!command){if(this.#commands.size===512){this.#limited=true;return null;}command={};this.#commands.set(key,command);}
  return command;
 }
 #once(command,field,counter){if(!command||command[field])return false;command[field]=true;this.#increment(counter);return true;}
 #failure(category,reason,sequence=this.#sequence,last='UNKNOWN',failed='UNKNOWN'){
  const f={category,reason,sequence,last:BOUNDARIES.has(last)?last:'UNKNOWN',failed:BOUNDARIES.has(failed)?failed:'UNKNOWN'};
  if(!this.#first||sequence<this.#first.sequence)this.#first=f;
  this.#lastFailure=Math.max(this.#lastFailure,sequence);
 }
 observe(entry){
  try{
   if(this.#closed)return;this.#sequence++;
   if(['CALL_STARTED','PROPOSAL_CHANGED','AVAILABILITY_RESULT_APPLIED','SCHEDULING_RESULT_APPLIED'].includes(entry.event)&&Number.isSafeInteger(entry.proposalVersion))this.#currentVersion=entry.proposalVersion;
   if(entry.traceEvent==='CALLER_TRANSCRIPTION_COMPLETED'&&entry.empty){this.#increment('emptyTranscriptCount');this.#empty=this.#sequence;}
   if(entry.traceEvent==='CALLER_TRANSCRIPTION_FAILED')this.#transcriptionFailure=this.#sequence;
   if(entry.event==='TURN_PROCESSING_STARTED')this.#increment('acceptedTurnCount');
   if(entry.event==='TURN_INTERPRETED'){
    if(UNRESOLVED.has(entry.action)){this.#increment('unresolvedInterpretationCount');this.#interpretation||=this.#sequence;}
    else{this.#empty=0;this.#interpretation=0;this.#transcriptionFailure=0;}
   }
   if(entry.event==='RESPONSE_PLANNED'){
    if(entry.purpose==='AMBIGUITY_LIMIT_REACHED')this.#limitReached=true;
   }
   const type=entry.event==='CREATE_APPOINTMENT_QUEUED'?'CREATE_APPOINTMENT':entry.effectType;
   if((entry.event==='EFFECT_QUEUED'||entry.event==='CREATE_APPOINTMENT_QUEUED')&&(AVAILABILITY.has(type)||type==='CREATE_APPOINTMENT')){
    this.#once(this.#command(type,entry.commandId),'attempted',type==='CREATE_APPOINTMENT'?'bookingAttemptCount':'availabilityAttemptCount');
   }
   if(entry.event==='EFFECT_EXECUTED'&&(AVAILABILITY.has(type)||type==='CREATE_APPOINTMENT')){
    const r=entry.result||{},command=this.#command(type,entry.commandId);
    this.#once(command,'attempted',type==='CREATE_APPOINTMENT'?'bookingAttemptCount':'availabilityAttemptCount');
    if(AVAILABILITY.has(type)){
     const ordinary=['UNAVAILABLE','CONFLICT','BUSINESS_CLOSED'].includes(r.reason);
     if(!ordinary&&(r.success===false||r.reason)){
      if(this.#once(command,'failed','availabilityFailureCount')&&entry.proposalVersion===this.#currentVersion)this.#failure('AVAILABILITY',r.reason==='TIMEOUT'?'AVAILABILITY_TIMEOUT':'AVAILABILITY_OPERATION_FAILED');
     }else this.#once(command,'succeeded','availabilitySuccessCount');
    }else if(!r.skipped&&r.success===true&&typeof r.appointmentId==='string'&&r.appointmentId.trim()){
     this.#once(command,'succeeded','bookingSuccessCount');
    }
   }
   // BOOKING_SUCCEEDED is also emitted before reducer application, even for failed effects.
   // Only the executed CREATE_APPOINTMENT result above proves a successful booking.
   if(entry.event==='BOOKING_FAILED'&&this.#once(this.#command('CREATE_APPOINTMENT',entry.commandId),'failed','bookingFailureCount'))this.#failure('BOOKING','BOOKING_OPERATION_FAILED');
   if(entry.event==='EFFECT_QUEUED'&&entry.effectType==='REQUEST_CLARIFICATION')this.#increment('clarificationCount');
   if(entry.event==='SESSION_OPERATION_FAILED')this.#failure('UNKNOWN','SESSION_OPERATION_FAILED');
   if(entry.event==='STRUCTURED_DECISION_FAILED')this.#failure('STRUCTURED_DECISION','STRUCTURED_PHONE_FAILED');
   if(entry.event==='SESSION_TERMINATING'&&['STRUCTURED_PHONE_FAILED','STRUCTURED_MODEL_PROTOCOL_FAILED','STRUCTURED_DECISION_TIMEOUT','STRUCTURED_STALE_EVIDENCE','STRUCTURED_CALL_LIMIT','STRUCTURED_SPEECH_LIMIT','STRUCTURED_EFFECT_REFUSED','STRUCTURED_UNEXPECTED_MODEL_AUDIO'].includes(entry.reason))this.#failure('STRUCTURED_DECISION',entry.reason);
   if(entry.event==='SESSION_TERMINATING'&&entry.reason==='OPENAI_STARTUP_TIMEOUT')this.#failure('PROVIDER_CONNECTION','PROVIDER_STARTUP_TIMEOUT');
   if(entry.event==='TIMEOUT_RECOVERY_PLANNED'&&entry.timeoutType==='AVAILABILITY_TIMEOUT')this.#failure('AVAILABILITY','AVAILABILITY_TIMEOUT');
   if(entry.event==='BOOKING_SETTLEMENT_UNKNOWN')this.#failure('BOOKING','BOOKING_SETTLEMENT_UNKNOWN');
  }catch{/* Observation never changes control flow. */}
 }
 transcription(m){
  try{
   if(this.#closed)return;
   if(!['BUFFER_COMMITTED_OBSERVED','TRANSCRIPTION_COMPLETED_OBSERVED','TRANSCRIPTION_FAILED_OBSERVED'].includes(m.phase))return;
   this.#sequence++;const key=id(m.itemId);if(!key){this.#limited=true;return;}
   let item=this.#items.get(key);if(!item){if(this.#items.size===512){this.#limited=true;return;}item={commit:0,terminal:false};this.#items.set(key,item);}
   if(m.phase==='BUFFER_COMMITTED_OBSERVED'&&!item.commit)item.commit=this.#sequence;
   if(m.phase!=='BUFFER_COMMITTED_OBSERVED')item.terminal=true;
  }catch{/* No provider object retained. */}
 }
 connection(type){
  if(this.#closed)return;this.#sequence++;
  if(['TWILIO_STREAM_STOPPED','TWILIO_CONNECTION_CLOSED'].includes(type)){this.#caller=true;this.#failure('CALLER_DISCONNECTED','CALLER_CONNECTION_CLOSED');}
  if(['OPENAI_CONNECTION_CLOSED','OPENAI_TRANSPORT_ERROR'].includes(type)){this.#provider=true;this.#failure('PROVIDER_CONNECTION','PROVIDER_CONNECTION_LOST');}
  if(type==='TWILIO_TRANSPORT_ERROR')this.#failure('PLAYBACK','TWILIO_TRANSPORT_ERROR');
 }
 delivery(e){
  try{
   if(this.#closed)return;this.#sequence++;
   if(['DELIVERED','RECOVERY_SUCCEEDED'].includes(e.disposition)){
    const recovery=e.disposition==='RECOVERY_SUCCEEDED'||['ERROR_RECOVERY','AMBIGUITY_LIMIT_REACHED'].includes(e.purpose);
    this.#lastDelivery=this.#sequence;this.#recovery=recovery;this.#increment(recovery?'recoveryDeliveryCount':'deliverySuccessCount');return;
   }
   const failures={GENERATION_FAILED:['SPEECH_DELIVERY','SPEECH_GENERATION_FAILED'],BODY_CONSUMPTION_FAILED:['SPEECH_DELIVERY','SPEECH_BODY_FAILED'],AUDIO_PREPARATION_FAILED:['SPEECH_DELIVERY','SPEECH_AUDIO_PREPARATION_FAILED'],RETRY_EXHAUSTED:['SPEECH_DELIVERY','SPEECH_RETRY_EXHAUSTED'],
    MEDIA_SUBMISSION_FAILED:['PLAYBACK','MEDIA_SUBMISSION_FAILED'],MARK_SUBMISSION_FAILED:['PLAYBACK','MARK_SUBMISSION_FAILED'],PLAYBACK_TIMED_OUT:['PLAYBACK','PLAYBACK_ACK_TIMEOUT'],RECOVERY_PLAYBACK_TIMED_OUT:['PLAYBACK','RECOVERY_ACK_TIMEOUT'],RECOVERY_FAILED:['SPEECH_DELIVERY','RECOVERY_DELIVERY_FAILED']};
   const failure=failures[e.disposition];if(!failure)return;
   this.#increment(failure[0]==='PLAYBACK'?'playbackFailureCount':'responseFailureCount');
   this.#failure(...failure,this.#sequence,e.lastSuccessfulBoundary,e.failedBoundary);
  }catch{/* No output or operational callback here. */}
 }
 finalizationFailed(){
  if(this.#closed)return;
  this.#sequence++;this.#failure('UNKNOWN','FINALIZATION_FAILED');
 }
 summary(base,terminal){
  // Transcription/interpretation evidence is provisional until call end; later accepted facts clear it.
  const pending=[...this.#items.values()].filter(i=>i.commit&&!i.terminal).map(i=>i.commit);
  if(!this.#limited&&(this.#empty||this.#transcriptionFailure||pending.length)){
   const seq=Math.min(...[this.#empty,this.#transcriptionFailure,...pending].filter(Boolean));
   this.#failure('TRANSCRIPTION',this.#transcriptionFailure?'TRANSCRIPTION_FAILED':this.#empty?'EMPTY_TRANSCRIPT_AT_END':'TRANSCRIPTION_PENDING_AT_END',seq);
  }else if(this.#interpretation&&this.#limitReached)this.#failure('INTERPRETATION_UNRESOLVED','AMBIGUITY_LIMIT_REACHED',this.#interpretation);
  const booked=terminal?.commandId
   ?this.#commands.get(JSON.stringify(['CREATE_APPOINTMENT',terminal.commandId]))?.succeeded===true
   :this.#counts.bookingSuccessCount>0;
  const businessOutcome=booked?'BOOKED':terminal?.outcome==='BOOKED'?'UNKNOWN':['BOOKING_FAILED','BOOKING_CONFLICT'].includes(terminal?.outcome)?'BOOKING_FAILED':this.#counts.bookingAttemptCount?'UNKNOWN':'NOT_BOOKED';
  const root=this.#first;
  const comm={STRUCTURED_DECISION:'STRUCTURED_DECISION_FAILED',TRANSCRIPTION:'TRANSCRIPTION_UNRESOLVED',INTERPRETATION_UNRESOLVED:'INTERPRETATION_UNRESOLVED',AVAILABILITY:'AVAILABILITY_FAILED',SPEECH_DELIVERY:'SPEECH_DELIVERY_FAILED',PLAYBACK:'PLAYBACK_FAILED',PROVIDER_CONNECTION:'PROVIDER_CONNECTION_FAILED',CALLER_DISCONNECTED:'CALLER_DISCONNECTED'};
  let communicationOutcome=root?(comm[root.category]||'UNKNOWN'):this.#limited||this.#interpretation?'UNKNOWN':this.#lastDelivery?'COMPLETED':'UNKNOWN';
  if(this.#lastDelivery>this.#lastFailure&&!this.#limited&&(root||!this.#interpretation))communicationOutcome=this.#recovery?'RECOVERY_DELIVERED':'COMPLETED';
  // Preserve the original CallTrace schema and values exactly. Only new fields are diagnostic.
  const out={};
  for(const k of ['event','traceEvent','callSid','streamSid','buildSha','sequence','elapsedMs','wallTime','callerSpeechActive','assistantAudioActive','durationMs','finalProposalVersion','finalRequirement','appointmentId','finalOutcome','remainingTimerCount','remainingEffectCount','remainingResponseCount','remainingPlaybackCount','callerTurnCount','assistantResponseCount','callerAudioChunks','callerAudioBytes','firstCallerAudioElapsedMs','lastCallerAudioElapsedMs','firstCallerAudioAt','lastCallerAudioAt','assistantAudioChunks','assistantAudioBytes','firstAssistantAudioElapsedMs','lastAssistantAudioElapsedMs','firstAssistantAudioAt','lastAssistantAudioAt','availabilityEffectCount','bookingEffectCount','smsCommandCount','finalizationCount','transportCloseCount'])if(Object.hasOwn(base,k))out[k]=base[k];
  Object.assign(out,{schemaVersion:1,businessOutcome,communicationOutcome,primaryFailureCategory:root?.category||(this.#limited?'UNKNOWN':'NONE'),primaryFailureReason:root?.reason||(this.#limited?'UNKNOWN':'NONE'),primaryFailureLastSuccessfulBoundary:root?.last||'NONE',primaryFailureBoundary:root?.failed||'NONE',...this.#counts,callerDisconnected:this.#caller,providerDisconnected:this.#provider});
  if(this.#structuredFailure){out.primaryFailureBoundary=this.#structuredFailure.failed;out.primaryFailureLastSuccessfulBoundary=this.#structuredFailure.last;}
  out.primaryFailureReasonCode=this.#structuredFailure?.reasonCode||(root?'UNKNOWN':'NONE');
  this.#closed=true;this.#items.clear();this.#commands.clear();return Object.freeze(out);
 }
}
