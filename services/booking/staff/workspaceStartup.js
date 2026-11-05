import {protect} from '../../../middleware/authMiddleware.js';
export async function mountWorkspaceStartup(app,{env=process.env,dependencies={}}={}){
 if(env.GLO_WORKSPACE_API_ENABLED!=='true')return {enabled:false};
 try{
  const [{default:Barber},{default:Appointment},{default:Calendar},{default:Member},{default:Subscription},{default:Assignment},{StaffService},{WorkspaceService},{workspaceRoutes,invitationPage},{invitationModels},{verifyDeclaredIndexes}]=await Promise.all([import('../../../models/Barber.js'),import('../../../models/Appointment.js'),import('../../../models/StaffCalendar.js'),import('../../../models/StaffMembership.js'),import('../../../models/Subscription.js'),import('../../../models/PhoneNumberAssignment.js'),import('./StaffService.js'),import('./WorkspaceService.js'),import('../../../routes/workspaceRoutes.js'),import('../../../models/StaffInvitation.js'),import('../verifyIndexes.js')]);
  const staff=dependencies.staff||new StaffService({BarberModel:Barber,AppointmentModel:Appointment,CalendarModel:Calendar,MembershipModel:Member,invitationsRequired:true});
  const workspace=dependencies.workspace||new WorkspaceService({staff,Subscription,Assignment,env});let invitations,invitationState='DISABLED';
  if(env.GLO_STAFF_INVITATIONS_ENABLED==='true'){try{
   const models=dependencies.models||invitationModels(Barber.db);if(dependencies.verifyPrerequisites)await dependencies.verifyPrerequisites();else await verifyDeclaredIndexes({...models,Membership:staff.MembershipModel,Calendar:staff.CalendarModel},{ttlAllowed:['StaffInvitationRate']});
   const [{InvitationService},{TokenVault},{createVerifyTransport},{createHandoffMessaging},{createNotificationWebhooks},{NotificationDispatcher}]=await Promise.all([import('./InvitationService.js'),import('../../calendar/TokenVault.js'),import('../management/VerifyTransport.js'),import('../management/createHandoffMessaging.js'),import('../../../routes/appointmentNotificationRoutes.js'),import('../../messaging/NotificationDispatcher.js')]);
   const keys=Object.fromEntries(Object.entries(JSON.parse(env.STAFF_INVITATION_TOKEN_KEYS_JSON||'{}')).map(([k,v])=>[k,Buffer.from(v,'base64')]));const origin=new URL(env.APP_BASE_URL).origin;
   const dispatch=env.GLO_STAFF_INVITATION_DISPATCH_ENABLED==='true';const messaging=dependencies.messaging||createHandoffMessaging({env:{...env,RETELL_VERIFICATION_LINK_DISPATCH_ENABLED:dispatch?'true':'false'},origin,accountSid:dispatch?env.TWILIO_ACCOUNT_SID:undefined,authToken:dispatch?env.TWILIO_AUTH_TOKEN:undefined,http:dependencies.http||globalThis.fetch,callbackPath:'/api/booking/v1/invitations/delivery-status'});
   const verify=dependencies.verify||createVerifyTransport(dispatch?{enabled:true,http:dependencies.verifyHttp||globalThis.fetch,accountSid:env.TWILIO_ACCOUNT_SID,authToken:env.TWILIO_AUTH_TOKEN,serviceSid:env.RETELL_VERIFY_SERVICE_SID}:{enabled:false});
   invitations=new InvitationService({staff,models,policy:messaging.policy,transport:messaging.transport,verify,vault:dependencies.vault||new TokenVault({keys,activeKeyId:env.STAFF_INVITATION_TOKEN_ACTIVE_KEY}),key:env.STAFF_INVITATION_HASH_KEY,origin,mobileReturn:env.STAFF_INVITATION_MOBILE_RETURN_URL,now:staff.now});
   app.use('/staff/invitation',invitationPage({mobileReturn:invitations.mobileReturn}));
   if(dispatch)app.use(createNotificationWebhooks({policy:messaging.policy,dispatcher:new NotificationDispatcher({policy:messaging.policy}),accountSid:messaging.transport.accountSid,authToken:env.TWILIO_AUTH_TOKEN,appBaseUrl:origin,fromNumber:messaging.transport.fromNumber,callbackPath:'/api/booking/v1/invitations/delivery-status'}));
   invitationState='READY';
  }catch{invitations=undefined;invitationState='CONFIGURATION_OR_INDEX_REQUIRED';}}
  app.use('/api/booking/v1',workspaceRoutes({workspace,invitations,invitationState,authenticate:dependencies.authenticate||protect}));return {enabled:true,workspace,invitations,invitationState};
 }catch{return {enabled:false,reasonCode:'WORKSPACE_CONFIGURATION_OR_INDEX_REQUIRED'};}
}
