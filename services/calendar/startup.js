import {shopEntitlement} from '../booking/staff/ShopPolicy.js';
export async function mountCalendarStartup(app,{env=process.env,dependencies={}}={}){
 if(env.GLO_GOOGLE_CALENDAR_ENABLED!=='true')return {enabled:false,reasonCode:'NOT_ENABLED'};
 try{
  const [{calendarModels},{TokenVault},{createGoogleTransport},{CalendarService},{CalendarSync},{CalendarExport},{createCalendarRouter},{StaffService},{default:Barber},{default:Appointment},{default:Member},{default:StaffCalendar},{default:Subscription}]=await Promise.all([import('../../models/ExternalCalendar.js'),import('./TokenVault.js'),import('./GoogleTransport.js'),import('./CalendarService.js'),import('./CalendarSync.js'),import('./CalendarExport.js'),import('../../routes/calendarRoutes.js'),import('../booking/staff/StaffService.js'),import('../../models/Barber.js'),import('../../models/Appointment.js'),import('../../models/StaffMembership.js'),import('../../models/StaffCalendar.js'),import('../../models/Subscription.js')]);
  const models=dependencies.models||calendarModels(dependencies.connection||Appointment.db),keysInput=JSON.parse(env.GOOGLE_CALENDAR_TOKEN_KEYS_JSON||'{}'),keys=Object.fromEntries(Object.entries(keysInput).map(([id,value])=>[id,Buffer.from(value,'base64')])),vault=dependencies.vault||new TokenVault({keys,activeKeyId:env.GOOGLE_CALENDAR_TOKEN_ACTIVE_KEY});
  if(dependencies.verifyPrerequisites)await dependencies.verifyPrerequisites();else {const {verifyDeclaredIndexes}=await import('../booking/verifyIndexes.js');await verifyDeclaredIndexes(models,{ttlAllowed:['CalendarOAuthState']});}
  const dispatch=env.GLO_GOOGLE_CALENDAR_DISPATCH_ENABLED==='true';
  const provider=dependencies.provider||createGoogleTransport(dispatch?{enabled:true,http:dependencies.http||globalThis.fetch,clientId:env.GOOGLE_CALENDAR_CLIENT_ID,clientSecret:env.GOOGLE_CALENDAR_CLIENT_SECRET,redirectUri:env.GOOGLE_CALENDAR_REDIRECT_URI}:{enabled:false});
  const staff=new StaffService({BarberModel:Barber,CalendarModel:StaffCalendar,MembershipModel:Member,AppointmentModel:Appointment});
  const service=dependencies.service||new CalendarService({models,Barber,Member,StaffCalendar,provider,vault,accessScope:(account,business)=>staff.scope(account,business),returnUrls:(env.GOOGLE_CALENDAR_RETURN_URLS||'').split(',').map(v=>v.trim()).filter(Boolean)});
  const callbackUrl=env.GOOGLE_CALENDAR_NOTIFICATION_URL;if(callbackUrl){const u=new URL(callbackUrl);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw Error('CALLBACK_INVALID');}
  const sync=new CalendarSync({service,models,callbackUrl,now:service.now}),exporter=new CalendarExport({service,models,Appointment,now:service.now});
  const billing=dependencies.billing||async function(businessId){const s=await Subscription.findOne({barber:businessId}).sort({createdAt:-1}).lean();const b=await Barber.findById(businessId).lean();if(b?.productType==='shop')return shopEntitlement(b,s,env);return !!s&&(['active','trialing'].includes(s.status)||s.status==='past_due'&&+new Date(s.gracePeriodEndsAt)>Date.now());};
  app.use('/api/calendar',createCalendarRouter({service,sync,exporter,billing}));
  let timer,running=false,stopped=false;const tick=async()=>{if(running||stopped)return;running=true;try{await sync.reconcile(20,{stopped:()=>stopped});if(!stopped)await exporter.tick();}catch{}finally{running=false;}};
  if(dispatch&&env.GLO_CALENDAR_WORKER_ENABLED==='true'){// Keep the healthy single-batch cadence below the 30s commit freshness bound.
  // Slow/large batches still fail closed; ticks never overlap.
  timer=setInterval(tick,5000);timer.unref();}
  const result={enabled:true,dispatchEnabled:dispatch,service,sync,exporter,stop:()=>{stopped=true;clearInterval(timer);}};app.locals.googleCalendar=result;return result;
 }catch{return {enabled:false,reasonCode:'CALENDAR_CONFIGURATION_OR_INDEX_PREREQUISITE_MISSING'};}
}
