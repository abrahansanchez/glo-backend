import {createBusinessCanary} from '../booking/BusinessCanary.js';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {GOOGLE_SCOPES} from './GoogleTransport.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
const fail=reason=>Object.assign(Error(reason),{reasonCode:reason});
const bounded=(s,n=1024)=>typeof s==='string'&&s.length>0&&s.length<=n&&!/[\x00-\x1f]/.test(s);
const safeConnection=c=>({id:c._id,provider:c.provider,mode:c.mode,status:c.status,revision:c.revision,lastError:c.lastError||null});
export class CalendarService {
 constructor({models,Barber,Member,StaffCalendar,provider,vault,accessScope,returnUrls,canary,now=()=>new Date()}){
  if(typeof accessScope!=='function'||!Array.isArray(returnUrls)||!returnUrls.length||returnUrls.some(u=>{try{const p=new URL(u);return p.protocol!=='https:'||p.username||p.password||p.hash;}catch{return true;}}))throw Error('CALENDAR_CONFIGURATION_INVALID');
  this.canary=canary||createBusinessCanary({connection:Barber.db,now});Object.assign(this,{...models,Barber,Member,StaffCalendar,provider,vault,accessScope,returnUrls,now});
 }
 async request(connection,method,...args){
  if(!this.provider.enabled)throw fail('CALENDAR_DISPATCH_DISABLED');await this.canary.assert(connection.businessId,'CALENDAR',{expectedRevision:connection.admissionRevision??-1});
  const minute=Math.floor(+this.now()/60000);
  await this.CalendarConnection.updateOne({_id:connection._id,status:'CONNECTED',revision:connection.revision,requestMinute:{$ne:minute}},{$set:{requestMinute:minute,requestCount:0}});
  const reserved=await this.CalendarConnection.findOneAndUpdate({_id:connection._id,status:'CONNECTED',revision:connection.revision,requestMinute:minute,requestCount:{$lt:60}},{$inc:{requestCount:1}});if(!reserved)throw fail('CALENDAR_RATE_LIMIT');
  return this.provider[method](...args);
 }
 async owned(accountId,businessId,id){await this.canary.assert(businessId,'CALENDAR');await this.accessScope(accountId,businessId);const c=await this.CalendarConnection.findOne({_id:id,accountId,businessId}).lean();if(!c)throw fail('FORBIDDEN');return c;}
 async listConnections(accountId,businessId){await this.canary.assert(businessId,'CALENDAR');await this.accessScope(accountId,businessId);return (await this.CalendarConnection.find({accountId,businessId}).limit(50).lean()).map(safeConnection);}
 async begin(accountId,businessId,{mode,returnUrl,connectionId}){
  const admission=await this.canary.assert(businessId,'CALENDAR');await this.accessScope(accountId,businessId);if(!this.provider.enabled)throw fail('CALENDAR_DISPATCH_DISABLED');if(!GOOGLE_SCOPES[mode]||!this.returnUrls.includes(returnUrl))throw fail('INVALID_OAUTH_REQUEST');
  const previous=connectionId?await this.owned(accountId,businessId,connectionId):null;
  const state=randomBytes(32).toString('base64url'),id=hash(state),verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url'),expiresAt=new Date(+this.now()+600000);
  await this.CalendarOAuthState.create({_id:id,admissionRevision:admission.revision,accountId,businessId,connectionId:connectionId||randomUUID(),connectionRevision:previous?.revision||0,mode,returnUrl,verifierEnvelope:this.vault.seal({verifier},`oauth:${id}`),expiresAt,status:'PENDING'});
  return {authorizationUrl:this.provider.authorizationUrl({state,challenge,mode}),expiresAt};
 }
 tokenFields(token,mode,requireRefresh=true){
  if(!bounded(token.access_token,8192)||requireRefresh&&!bounded(token.refresh_token,8192)||token.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(token.expires_in)||token.expires_in<1||token.expires_in>86400)throw fail('GOOGLE_TOKEN_INVALID');
  const granted=typeof token.scope==='string'?token.scope.split(' '):[];if(requireRefresh&&GOOGLE_SCOPES[mode].some(s=>!granted.includes(s)))throw fail('GOOGLE_SCOPES_UNVERIFIED');
  return {accessToken:token.access_token,...(token.refresh_token?{refreshToken:token.refresh_token}:{}),scopes:granted};
 }
 async rejectCallback(state){if(typeof state==='string'&&/^[A-Za-z0-9_-]{43}$/.test(state))await this.CalendarOAuthState.updateOne({_id:hash(state),status:'PENDING'},{$set:{status:'FAILED'},$unset:{verifierEnvelope:1}});}
 async callback(state,code){
  if(!bounded(state,128)||!/^[A-Za-z0-9_-]{43}$/.test(state)||!bounded(code,4096)||!this.provider.enabled)throw fail('OAUTH_REJECTED');
  const row=await this.CalendarOAuthState.findOneAndUpdate({_id:hash(state),status:'PENDING',expiresAt:{$gt:this.now()}},{$set:{status:'CLAIMED'}},{new:true}).lean();if(!row)throw fail('OAUTH_REJECTED');
  try{
   if(!Number.isInteger(row.connectionRevision)||row.connectionRevision<0)throw fail('OAUTH_REJECTED');
   await this.canary.assert(row.businessId,'CALENDAR',{expectedRevision:row.admissionRevision??-1});await this.accessScope(row.accountId,row.businessId);const {verifier}=this.vault.open(row.verifierEnvelope,`oauth:${row._id}`),response=await this.provider.exchange(code,verifier),tokens=this.tokenFields(response,row.mode);
   await this.canary.assert(row.businessId,'CALENDAR',{expectedRevision:row.admissionRevision??-1});await this.accessScope(row.accountId,row.businessId);if(+new Date(row.expiresAt)<=+this.now())throw fail('OAUTH_REJECTED');
   const connection=await this.CalendarConnection.findOneAndUpdate({_id:row.connectionId,accountId:row.accountId,businessId:row.businessId,revision:row.connectionRevision},{$set:{admissionRevision:row.admissionRevision,provider:'google',mode:row.mode,status:'CONNECTED',tokenEnvelope:this.vault.seal(tokens,`connection:${row.businessId}:${row.connectionId}`),tokenExpiresAt:new Date(+this.now()+response.expires_in*1000),lastError:null},$inc:{revision:1}},{upsert:true,new:true,setDefaultsOnInsert:false,runValidators:true}).lean();
   await this.CalendarSource.updateMany({connectionId:connection._id,required:true},{$set:{dirty:true,status:'PENDING'},$inc:{signalRevision:1}});
   await this.CalendarOAuthState.updateOne({_id:row._id},{$set:{status:'DONE'},$unset:{verifierEnvelope:1}});
   return {returnUrl:row.returnUrl,connection:safeConnection(connection)};
  }catch{await this.CalendarOAuthState.updateOne({_id:row._id},{$set:{status:'FAILED'},$unset:{verifierEnvelope:1}});throw fail('OAUTH_REJECTED');}
 }
 async accessToken(connection){
  await this.canary.assert(connection.businessId,'CALENDAR',{expectedRevision:connection.admissionRevision??-1});
  const current=await this.CalendarConnection.findOne({_id:connection._id,status:'CONNECTED',revision:connection.revision}).lean();if(!current)throw fail('CALENDAR_RECONNECT_REQUIRED');
  const tokens=this.vault.open(current.tokenEnvelope,`connection:${current.businessId}:${current._id}`);
  if(+new Date(current.tokenExpiresAt)>+this.now()+60000)return tokens.accessToken;
  if(!this.provider.enabled)throw fail('CALENDAR_DISPATCH_DISABLED');const lock=randomUUID();
  const owned=await this.CalendarConnection.findOneAndUpdate({_id:current._id,status:'CONNECTED',revision:current.revision,$or:[{tokenLockUntil:{$exists:false}},{tokenLockUntil:{$lte:this.now()}}]},{$set:{tokenLock:lock,tokenLockUntil:new Date(+this.now()+15000)}},{new:true}).lean();if(!owned)throw fail('CALENDAR_TOKEN_BUSY');
  try{const response=await this.request(current,'refresh',tokens.refreshToken),fresh=this.tokenFields(response,current.mode,false);if(fresh.scopes.length&&GOOGLE_SCOPES[current.mode].some(s=>!fresh.scopes.includes(s)))throw fail('GOOGLE_SCOPES_UNVERIFIED');
   const result=await this.CalendarConnection.updateOne({_id:current._id,status:'CONNECTED',revision:current.revision,tokenLock:lock,'tokenEnvelope.iv':current.tokenEnvelope.iv},{$set:{tokenEnvelope:this.vault.seal({...tokens,...fresh,...(!fresh.scopes.length?{scopes:tokens.scopes}:{})},`connection:${current.businessId}:${current._id}`),tokenExpiresAt:new Date(+this.now()+response.expires_in*1000),lastError:null},$unset:{tokenLock:1,tokenLockUntil:1}});if(result.matchedCount!==1)throw fail('CALENDAR_RECONNECT_REQUIRED');return fresh.accessToken;
  }catch(e){await this.CalendarConnection.updateOne({_id:current._id,tokenLock:lock},{$set:{...(e.googleCode==='invalid_grant'||e.reasonCode==='GOOGLE_SCOPES_UNVERIFIED'?{status:'RECONNECT_REQUIRED'}:{}),lastError:'TOKEN_REFRESH_UNAVAILABLE'},$unset:{tokenLock:1,tokenLockUntil:1}});throw fail('CALENDAR_RECONNECT_REQUIRED');}
 }
 async calendars(accountId,businessId,connectionId){
  const c=await this.owned(accountId,businessId,connectionId),token=await this.accessToken(c);if(!this.provider.enabled)throw fail('CALENDAR_DISPATCH_DISABLED');
  const items=[];let pageToken;for(let page=0;page<10;page++){
   const result=await this.request(c,'listCalendars',token,pageToken);if(!Array.isArray(result.items)||result.items.length>100)throw fail('GOOGLE_RESPONSE_INVALID');
   for(const item of result.items)if(bounded(item.id)&&['freeBusyReader','reader','writer','owner'].includes(item.accessRole))items.push({id:item.id,label:bounded(item.summary,256)?item.summary:'Calendar',accessRole:item.accessRole,timeZone:bounded(item.timeZone,128)?item.timeZone:null});
   pageToken=result.nextPageToken;if(!pageToken)return items;if(!bounded(pageToken,8192))throw fail('GOOGLE_RESPONSE_INVALID');
  }throw fail('CALENDAR_PAGE_LIMIT');
 }
 async selections(accountId,businessId,connectionId,input){
  const admission=await this.canary.assert(businessId,'CALENDAR');const scope=await this.accessScope(accountId,businessId),c=await this.owned(accountId,businessId,connectionId);
  if(!Array.isArray(input)||input.length>20||input.some(s=>!s||Object.keys(s).sort().join(',')!=='calendarId,exportEnabled,required,staffCalendarId,visibility'||!bounded(s.calendarId)||typeof s.required!=='boolean'||typeof s.exportEnabled!=='boolean'||!['busy','details'].includes(s.visibility)||s.staffCalendarId!==null&&!/^[a-f0-9]{24}$/.test(s.staffCalendarId)))throw fail('INVALID_CALENDAR_SELECTION');
  const remote=input.length?await this.calendars(accountId,businessId,connectionId):[],seen=new Set();
  for(const s of input){const id=`${s.calendarId}:${s.staffCalendarId}`;if(seen.has(id))throw fail('INVALID_CALENDAR_SELECTION');seen.add(id);const calendar=remote.find(v=>v.id===s.calendarId);if(!calendar||s.exportEnabled&&(c.mode!=='export'||!['writer','owner'].includes(calendar.accessRole))||s.visibility==='details'&&(c.mode==='busy'||calendar.accessRole==='freeBusyReader'))throw fail('CALENDAR_PERMISSION_REQUIRED');if(scope.calendarIds!==null&&(s.staffCalendarId===null||!scope.calendarIds.includes(s.staffCalendarId)))throw fail('FORBIDDEN');if(s.staffCalendarId&&(!this.StaffCalendar||!await this.StaffCalendar.findOne({_id:s.staffCalendarId,businessId,active:true}).select('_id').lean()))throw fail('FORBIDDEN');}
  const session=await this.CalendarSource.db.startSession();
  try{await session.withTransaction(async()=>{
   if(scope.membershipId){const member=await this.Member.collection.updateOne({_id:scope.membershipId,active:true,revision:scope.membershipRevision,calendarIds:{$all:input.map(s=>s.staffCalendarId).filter(Boolean).map(id=>new this.Member.base.Types.ObjectId(id))}},{$inc:{accessFence:1}},{session});if(member.matchedCount!==1)throw fail('FORBIDDEN');}
   await this.canary.assert(businessId,'CALENDAR',{expectedRevision:admission.revision,session,fence:true});
   const current=await this.CalendarConnection.updateOne({_id:c._id,accountId,businessId,status:input.length?'CONNECTED':c.status,revision:c.revision},{$inc:{usageFence:1}},{session});if(current.matchedCount!==1)throw fail('CALENDAR_RECONNECT_REQUIRED');
   const ids=[];for(const s of input){const calendar=remote.find(v=>v.id===s.calendarId);const row=await this.CalendarSource.findOneAndUpdate({connectionId:c._id,calendarId:s.calendarId,staffCalendarId:s.staffCalendarId},{$set:{businessId,accountId,admissionRevision:admission.revision,visibility:s.visibility,required:s.required,exportEnabled:s.exportEnabled,calendarTimeZone:calendar.timeZone,accessRole:calendar.accessRole,status:s.required||s.exportEnabled?'PENDING':'DISABLED',dirty:true},$setOnInsert:{_id:randomUUID()},$unset:{cursorEnvelope:1},$inc:{revision:1,signalRevision:1}},{session,upsert:true,new:true,setDefaultsOnInsert:false}).lean();ids.push(row._id);if(s.visibility==='busy')await this.CalendarBusy.updateMany({sourceId:row._id},{$unset:{title:1}},{session});}
   await this.CalendarSource.updateMany({connectionId:c._id,_id:{$nin:ids}},{$set:{required:false,exportEnabled:false,status:'DISABLED',dirty:true},$inc:{revision:1,signalRevision:1}},{session});
   const required=await this.CalendarSource.countDocuments({businessId,required:true}).session(session);const exports=await this.CalendarSource.countDocuments({businessId,exportEnabled:true}).session(session);await this.Barber.collection.updateOne({_id:new this.Barber.base.Types.ObjectId(businessId)},{$set:{externalCalendarsRequired:required>0,externalCalendarExportConfigured:exports>0},$inc:{bookingConfigurationFence:1}},{session});
  });}finally{await session.endSession();}
  return this.CalendarSource.find({connectionId:c._id}).select('_id staffCalendarId visibility required exportEnabled status revision lastSyncedAt lastError').lean();
 }
 async disconnect(accountId,businessId,id){
  const c=await this.CalendarConnection.findOne({_id:id,accountId,businessId}).lean();if(!c)throw fail('FORBIDDEN');let tokens;try{tokens=this.vault.open(c.tokenEnvelope,`connection:${businessId}:${id}`);}catch{}
  await this.CalendarConnection.updateOne({_id:id,accountId,businessId},{$set:{status:'DISCONNECTED'},$unset:{tokenEnvelope:1,tokenExpiresAt:1},$inc:{revision:1}});
  await this.CalendarSource.updateMany({connectionId:id},{$set:{status:'DISCONNECTED',dirty:true},$inc:{signalRevision:1}});
  const sources=await this.CalendarSource.find({connectionId:id}).select('_id').lean();
  await this.CalendarBusy.deleteMany({sourceId:{$in:sources.map(s=>s._id)}});
  await this.CalendarSource.updateMany({connectionId:id},{$unset:{cursorEnvelope:1}});
  await this.CalendarChannel.updateMany({sourceId:{$in:sources.map(s=>s._id)}},{$set:{status:'ENDED'}});
  let remoteRevocation='NOT_ATTEMPTED';if(this.provider.enabled&&tokens?.refreshToken){try{await this.canary.assert(businessId,'CALENDAR',{expectedRevision:c.admissionRevision??-1});await this.provider.revoke(tokens.refreshToken);remoteRevocation='REQUEST_ACCEPTED';}catch{remoteRevocation='UNKNOWN';}}
  return {status:'DISCONNECTED',remoteRevocation,requiredSourcesRemainBlocking:true};
 }
 async detachSource(accountId,businessId,id){
  if(accountId!==businessId)throw fail('FORBIDDEN');await this.canary.assert(businessId,'CALENDAR');await this.accessScope(accountId,businessId);const session=await this.CalendarSource.db.startSession();
  try{await session.withTransaction(async()=>{const r=await this.CalendarSource.updateOne({_id:id,businessId},{$set:{required:false,exportEnabled:false,status:'DISABLED',dirty:true},$unset:{cursorEnvelope:1},$inc:{revision:1,signalRevision:1}},{session});if(r.matchedCount!==1)throw fail('FORBIDDEN');await this.CalendarBusy.deleteMany({sourceId:id},{session});await this.CalendarChannel.updateMany({sourceId:id},{$set:{status:'ENDED'}},{session});const required=await this.CalendarSource.countDocuments({businessId,required:true}).session(session),exports=await this.CalendarSource.countDocuments({businessId,exportEnabled:true}).session(session);await this.Barber.collection.updateOne({_id:new this.Barber.base.Types.ObjectId(businessId)},{$set:{externalCalendarsRequired:required>0,externalCalendarExportConfigured:exports>0},$inc:{bookingConfigurationFence:1}},{session});});}finally{await session.endSession();}return {status:'DETACHED',credentialsUnchanged:true};
 }
 async rotate(accountId,businessId,id){const c=await this.owned(accountId,businessId,id),tokens=this.vault.open(c.tokenEnvelope,`connection:${businessId}:${id}`);const r=await this.CalendarConnection.updateOne({_id:id,accountId,businessId,revision:c.revision,'tokenEnvelope.iv':c.tokenEnvelope.iv,$or:[{tokenLockUntil:{$exists:false}},{tokenLockUntil:{$lte:this.now()}}]},{$set:{tokenEnvelope:this.vault.seal(tokens,`connection:${businessId}:${id}`)}});if(r.matchedCount!==1)throw fail('CONNECTION_CHANGED');return {status:'REENCRYPTED'};}
}
