import {performance} from 'node:perf_hooks';
import {createHash,randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import moment from 'moment-timezone';
const digest=v=>createHash('sha256').update(v).digest('hex');
const fail=reason=>Object.assign(Error(reason),{reasonCode:reason});
const bounded=(s,n=8192)=>typeof s==='string'&&s.length>0&&s.length<=n;
export function eventInterval(event,zone){
 if(event.status==='cancelled'||event.transparency==='transparent')return null;
 if(event.recurrence&&!event.recurringEventId)throw fail('RECURRENCE_NOT_EXPANDED');
 const parse=value=>{if(value?.date){if(!moment.tz.zone(zone))throw fail('EVENT_TIMEZONE_REQUIRED');const d=moment.tz(value.date,'YYYY-MM-DD',true,zone);if(!d.isValid()||d.format('YYYY-MM-DD')!==value.date)throw fail('EVENT_TIME_INVALID');return d.toDate();}
  if(!bounded(value?.dateTime,128))throw fail('EVENT_TIME_INVALID');const d=moment.parseZone(value.dateTime,moment.ISO_8601,true);if(!/(Z|[+-]\d\d:\d\d)$/.test(value.dateTime)||!d.isValid())throw fail('EVENT_TIME_INVALID');return d.toDate();};
 const startAt=parse(event.start),endAt=parse(event.end);if(endAt<=startAt)throw fail('EVENT_TIME_INVALID');return {startAt,endAt};
}
const canonicalTime=value=>value?.dateTime&&Number.isFinite(+new Date(value.dateTime))?new Date(value.dateTime).toISOString():value?.date||null;
export const eventMaterial=event=>({summary:(event.summary||'').normalize('NFC'),start:canonicalTime(event.start),end:canonicalTime(event.end),appointment:event.extendedProperties?.private?.gloAppointment||null,revision:event.extendedProperties?.private?.gloRevision||null});
export class CalendarSync {
 constructor({service,models,callbackUrl,now=()=>new Date()}){Object.assign(this,{service,...models,callbackUrl,now});}
 horizon(){const start=moment.utc(this.now()).startOf('day').subtract(2,'days'),end=start.clone().add(64,'days');return {from:start.toDate(),to:end.toDate()};}
 async sync(sourceId,{scheduled=false}={}){
  if(!this.service.provider.enabled)throw fail('CALENDAR_DISPATCH_DISABLED');const previous=await this.CalendarSource.findById(sourceId).lean();if(previous?.nextPollAt&&+new Date(previous.nextPollAt)>+this.now()&&scheduled)return {status:'COALESCED',lastSyncedAt:previous.lastSyncedAt||null};const lock=randomUUID();
  const source=await this.CalendarSource.findOneAndUpdate({_id:sourceId,status:{$ne:'DISABLED'},...(scheduled?{$and:[{$or:[{nextPollAt:{$exists:false}},{nextPollAt:{$lte:this.now()}}]}]}:{}),$or:[{syncLockUntil:{$exists:false}},{syncLockUntil:{$lte:this.now()}}]},{$set:{syncLock:lock,syncLockUntil:new Date(+this.now()+120000)}},{new:true}).lean();if(!source)throw fail('CALENDAR_SYNC_BUSY');
  const deadline=performance.now()+90000;
  const live=()=>{if(performance.now()>=deadline||+new Date(source.syncLockUntil)<=+this.now())throw fail('CALENDAR_SYNC_DEADLINE');};
  try{
   await this.service.canary.assert(source.businessId,'CALENDAR',{expectedRevision:source.admissionRevision??-1});
   const access=await this.service.accessScope(source.accountId,source.businessId);if(access.calendarIds!==null&&(source.staffCalendarId===null||!access.calendarIds.includes(source.staffCalendarId)))throw fail('FORBIDDEN');
   const connection=await this.CalendarConnection.findOne({_id:source.connectionId,status:'CONNECTED'}).lean();if(!connection)throw fail('CALENDAR_RECONNECT_REQUIRED');
   const token=await this.service.accessToken(connection),{from,to}=this.horizon();const generation=randomUUID();let rows=[],cursor;
   const sameRange=+new Date(source.rangeStart)===+from&&+new Date(source.rangeEnd)===+to;
   if(connection.mode==='busy'||source.accessRole==='freeBusyReader'){
    const result=await this.service.request(connection,'freeBusy',token,source.calendarId,from.toISOString(),to.toISOString()),calendar=result.calendars?.[source.calendarId];
    if(!calendar||calendar.errors?.length||!Array.isArray(calendar.busy)||calendar.busy.length>5000)throw fail('CALENDAR_SOURCE_INCOMPLETE');
    rows=calendar.busy.map((b,i)=>{const interval=eventInterval({start:{dateTime:b.start},end:{dateTime:b.end}},source.calendarTimeZone);return {_id:digest(`${source._id}:${generation}:${i}`),sourceId:source._id,businessId:source.businessId,staffCalendarId:source.staffCalendarId,generation,eventId:String(i),...interval};});
    // Without event identities a freebusy source cannot safely exclude exported copies.
    if(await this.CalendarMapping.findOne({businessId:source.businessId,calendarId:source.calendarId,status:{$ne:'REMOVED'}}).lean())throw fail('FREEBUSY_COPY_IDENTITY_UNVERIFIED');
   }else{
    const map=new Map();let syncToken;
    if(sameRange&&source.cursorEnvelope){syncToken=this.service.vault.open(source.cursorEnvelope,`cursor:${source._id}`).token;for(const row of await this.CalendarBusy.find({sourceId:source._id,generation:source.generation}).limit(5001).lean())map.set(row.eventId,row);if(map.size>5000)throw fail('CALENDAR_SOURCE_LIMIT');}
    const fetchPages=async useCursor=>{
     let pageToken;for(let page=0;page<20;page++){
      const query={singleEvents:true,showDeleted:true,maxResults:250,...(useCursor?{syncToken:useCursor}:{timeMin:from.toISOString(),timeMax:to.toISOString()}),...(pageToken?{pageToken}:{})};
      live();const response=await this.service.request(connection,'events',token,source.calendarId,query);live();if(!Array.isArray(response.items)||response.items.length>250)throw fail('CALENDAR_RESPONSE_INVALID');
      for(const event of response.items){
       if(!bounded(event.id,1024))throw fail('CALENDAR_RESPONSE_INVALID');
       const mapping=await this.CalendarMapping.findOne({businessId:source.businessId,calendarId:source.calendarId,eventId:event.id}).lean();
       if(mapping){const material=eventMaterial(event);if(event.status==='cancelled'||![mapping.exportHash,mapping.pendingHash].includes(digest(JSON.stringify(material)))){await this.CalendarMapping.updateOne({_id:mapping._id},{$set:{status:'DIVERGED',lastError:'EXTERNAL_EDIT_OR_DELETION'}});throw fail('EXTERNAL_DIVERGENCE');}map.delete(event.id);continue;}
       const interval=eventInterval(event,source.calendarTimeZone);if(!interval||+interval.endAt<=+from||+interval.startAt>=+to){map.delete(event.id);continue;}
       const updated=event.updated?new Date(event.updated):new Date(0);if(!Number.isFinite(+updated))throw fail('CALENDAR_RESPONSE_INVALID');const previous=map.get(event.id);if(previous?.updated&&+new Date(previous.updated)>+updated)continue;
       map.set(event.id,{sourceId:source._id,businessId:source.businessId,staffCalendarId:source.staffCalendarId,eventId:event.id,...interval,updated,etag:bounded(event.etag,1024)?event.etag:undefined,...(source.visibility==='details'&&typeof event.summary==='string'?{title:event.summary.slice(0,256)}:{})});
       if(map.size>5000)throw fail('CALENDAR_SOURCE_LIMIT');
      }
      pageToken=response.nextPageToken;if(!pageToken){if(!bounded(response.nextSyncToken))throw fail('CALENDAR_CURSOR_MISSING');cursor=response.nextSyncToken;return;}if(!bounded(pageToken))throw fail('CALENDAR_RESPONSE_INVALID');
     }throw fail('CALENDAR_PAGE_LIMIT');
    };
    try{await fetchPages(syncToken);}catch(e){if(e.httpStatus!==410||!syncToken)throw e;map.clear();await fetchPages(undefined);}
    rows=[...map.values()].map(row=>{const result={...row,_id:digest(`${source._id}:${generation}:${row.eventId}`),generation};if(source.visibility==='busy')delete result.title;return result;});
   }
   live();if(rows.length)await this.CalendarBusy.insertMany(rows,{ordered:true});
   const latestAccess=await this.service.accessScope(source.accountId,source.businessId);if(latestAccess.calendarIds!==null&&(source.staffCalendarId===null||!latestAccess.calendarIds.includes(source.staffCalendarId)))throw fail('FORBIDDEN');
   const session=await this.CalendarSource.db.startSession();let published=false;
   try{await session.withTransaction(async()=>{const admission=await this.service.canary.assert(source.businessId,'CALENDAR',{expectedRevision:source.admissionRevision??-1,session,fence:true});
    if(latestAccess.membershipId){const r=await this.service.Member.collection.updateOne({_id:latestAccess.membershipId,active:true,revision:latestAccess.membershipRevision},{$inc:{accessFence:1}},{session});if(r.matchedCount!==1)throw fail('FORBIDDEN');}
    const current=await this.CalendarConnection.updateOne({_id:connection._id,status:'CONNECTED',revision:connection.revision},{$inc:{usageFence:1}},{session});if(current.matchedCount!==1)throw fail('CALENDAR_RECONNECT_REQUIRED');
    const result=await this.CalendarSource.updateOne({_id:source._id,revision:source.revision,signalRevision:source.signalRevision,syncLock:lock,status:{$ne:'DISABLED'}},{$set:{generation,connectionRevision:connection.revision,rangeStart:from,rangeEnd:to,lastSyncedAt:this.now(),status:'READY',dirty:false,lastError:null,failureCount:0,nextPollAt:new Date(+this.now()+20000),...(cursor?{cursorEnvelope:this.service.vault.seal({token:cursor},`cursor:${source._id}`)}:{})},$unset:{syncLock:1,syncLockUntil:1}},{session});if(result.matchedCount!==1)throw fail('CALENDAR_SOURCE_CHANGED');
    await this.service.Barber.collection.updateOne({_id:new this.service.Barber.base.Types.ObjectId(source.businessId)},{$inc:{bookingConfigurationFence:1}},{session});if(+new Date(admission.expiresAt)<=+this.now())throw fail('CANARY_NOT_ADMITTED');published=true;
   });}finally{await session.endSession();}
   if(published)await this.CalendarBusy.deleteMany({sourceId:source._id,generation:{$ne:generation}});
   return {status:'READY',intervalCount:rows.length,lastSyncedAt:this.now()};
  }catch(error){
   await this.CalendarSource.updateOne({_id:source._id,syncLock:lock},{$set:{status:error.reasonCode==='EXTERNAL_DIVERGENCE'?'DIVERGED':'UNAVAILABLE',dirty:true,failureCount:(source.failureCount||0)+1,nextPollAt:new Date(+this.now()+Math.max(Math.min(300000,30000*2**Math.min(source.failureCount||0,4)),Math.min(3600,error.retryAfterSeconds||0)*1000)),lastError:['EXTERNAL_DIVERGENCE','FORBIDDEN','CALENDAR_RECONNECT_REQUIRED','FREEBUSY_COPY_IDENTITY_UNVERIFIED','CALENDAR_SOURCE_CHANGED'].includes(error.reasonCode)?error.reasonCode:'CALENDAR_SYNC_UNAVAILABLE'},$unset:{syncLock:1,syncLockUntil:1}});throw fail('AVAILABILITY_UNVERIFIED');
  }
 }
 async ensureChannel(sourceId){
  if(!this.service.provider.enabled)throw fail('CALENDAR_DISPATCH_DISABLED');if(!this.callbackUrl)return {status:'POLLING_ONLY'};const source=await this.CalendarSource.findById(sourceId).lean();if(!source||source.status==='DISABLED')throw fail('FORBIDDEN');
  const connection=await this.CalendarConnection.findOne({_id:source.connectionId,status:'CONNECTED'}).lean();if(!connection||connection.mode==='busy')return {status:'POLLING_ONLY'};
  const active=await this.CalendarChannel.findOne({sourceId,status:'ACTIVE',expiresAt:{$gt:new Date(+this.now()+3600000)}}).lean();if(active)return {status:'ACTIVE',expiresAt:active.expiresAt};
  const permitted=await this.service.accessScope(source.accountId,source.businessId);if(permitted.calendarIds!==null&&(source.staffCalendarId===null||!permitted.calendarIds.includes(source.staffCalendarId)))throw fail('FORBIDDEN');
  const token=await this.service.accessToken(connection),id=randomUUID(),secret=randomBytes(32).toString('base64url'),expiresAt=new Date(+this.now()+86400000);
  await this.CalendarChannel.create({_id:id,sourceId,tokenHash:digest(secret),expiresAt,status:'PENDING'});
  try{const response=await this.service.request(connection,'watch',token,source.calendarId,{id,type:'web_hook',address:this.callbackUrl,token:secret,expiration:String(+expiresAt)});if(response.id!==id||!bounded(response.resourceId,1024)||!Number.isFinite(Number(response.expiration))||Number(response.expiration)<=+this.now())throw fail('CALENDAR_CHANNEL_INVALID');
   const expiry=new Date(Math.min(Number(response.expiration),+expiresAt));const access=await this.service.accessScope(source.accountId,source.businessId);if(access.calendarIds!==null&&(source.staffCalendarId===null||!access.calendarIds.includes(source.staffCalendarId)))throw fail('FORBIDDEN');if(!await this.CalendarConnection.findOne({_id:connection._id,status:'CONNECTED',revision:connection.revision}).lean())throw fail('CALENDAR_RECONNECT_REQUIRED');await this.CalendarChannel.updateOne({_id:id,status:'PENDING'},{$set:{status:'ACTIVE',resourceId:response.resourceId,expiresAt:expiry}});
   const old=await this.CalendarChannel.find({sourceId,status:'ACTIVE',_id:{$ne:id}}).lean();for(const c of old){await this.CalendarChannel.updateOne({_id:c._id},{$set:{status:'ENDED'}});try{await this.service.request(connection,'stopChannel',token,{id:c._id,resourceId:c.resourceId});}catch{}}
   return {status:'ACTIVE',expiresAt:expiry};
  }catch{await this.CalendarChannel.updateOne({_id:id},{$set:{status:'ENDED'}});throw fail('CALENDAR_CHANNEL_UNAVAILABLE');}
 }
 async notification(headers){
  const id=headers['x-goog-channel-id'],token=headers['x-goog-channel-token'],resourceId=headers['x-goog-resource-id'];if(!bounded(id,128)||!bounded(token,256)||!bounded(resourceId,1024))return false;
  const channel=await this.CalendarChannel.findOne({_id:id,status:'ACTIVE',resourceId,expiresAt:{$gt:this.now()}}).lean();if(!channel)return false;const supplied=Buffer.from(digest(token),'hex'),expected=Buffer.from(channel.tokenHash,'hex');if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return false;
  await this.CalendarSource.updateOne({_id:channel.sourceId,status:{$ne:'DISABLED'}},{$set:{dirty:true},$inc:{signalRevision:1}});return true;
 }
 async reconcile(limit=20,{stopped=()=>false}={}){const sources=await this.CalendarSource.find({status:{$ne:'DISABLED'},$and:[{$or:[{required:true},{exportEnabled:true}]},{$or:[{nextPollAt:{$exists:false}},{nextPollAt:{$lte:this.now()}}]}]}).sort({lastSyncedAt:1,_id:1}).limit(Math.min(limit,20)).select('_id').lean();const results=[];for(const source of sources){if(stopped())break;try{results.push(await this.sync(source._id,{scheduled:true}));if(!stopped())await this.ensureChannel(source._id);}catch{results.push({status:'UNAVAILABLE'});}}return results;}
}
