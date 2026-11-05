import {shopEntitlement} from './ShopPolicy.js';
export async function mountBookingFoundation(app,{env=process.env,dependencies={}}={}) {
  if(env.GLO_STAFF_SCHEDULING_ENABLED!=='true'&&env.GLO_BOOKING_API_ENABLED!=='true')return {enabled:false};
  const [{default:BarberModel},{default:CalendarModel},{default:MembershipModel},{default:AppointmentModel},{StaffService},{bookingFoundationRoutes},{default:SubscriptionModel},{default:ProposalModel}]=await Promise.all([import('../../../models/Barber.js'),import('../../../models/StaffCalendar.js'),import('../../../models/StaffMembership.js'),import('../../../models/Appointment.js'),import('./StaffService.js'),import('../../../routes/bookingFoundationRoutes.js'),import('../../../models/Subscription.js'),import('../../../models/StaffBookingProposal.js')]);
  try {
    if(dependencies.verifyPrerequisites)await dependencies.verifyPrerequisites();
    else {const {verifyDeclaredIndexes}=await import('../verifyIndexes.js');await verifyDeclaredIndexes({CalendarModel,MembershipModel,ProposalModel});}
  }catch{return {enabled:false,reasonCode:'STAFF_INDEX_PREREQUISITES_MISSING'};}
  try{
  const service=dependencies.service||new StaffService({BarberModel,CalendarModel,MembershipModel,AppointmentModel,ProposalModel,invitationsRequired:env.GLO_STAFF_INVITATIONS_ENABLED==='true'||env.GLO_WORKSPACE_API_ENABLED==='true',delegation:app.locals?.appointmentManagement?.delegation||app.locals?.retellManagement?.delegation,notifications:app.locals?.notificationPolicy});
  const billing=dependencies.billing||(async(businessId)=>{const s=await SubscriptionModel.findOne({barber:businessId}).sort({createdAt:-1}).lean();const b=await BarberModel.findById(businessId).lean();if(b?.productType==='shop')return shopEntitlement(b,s,env);return !!s&&(['active','trialing'].includes(s.status)||s.status==='past_due'&&+new Date(s.gracePeriodEndsAt)>Date.now());});
  let workspace;if(env.GLO_BOOKING_API_ENABLED==='true'){const {AppointmentWorkspace}=await import('./AppointmentWorkspace.js');workspace=new AppointmentWorkspace({staff:service,cursorKey:env.GLO_BOOKING_CURSOR_KEY,features:{ownerGrants:env.GLO_APPOINTMENT_MANAGEMENT_ENABLED==='true'&&app.locals?.appointmentManagement?.enabled===true,googleCalendar:app.locals?.googleCalendar?.enabled===true,notificationPolicy:!!app.locals?.notificationPolicy}});}
  app.use('/api/booking/v1',bookingFoundationRoutes({service,billing,workspace}));return {enabled:true};
  }catch{return {enabled:false,reasonCode:'BOOKING_CONFIGURATION_INVALID'};}
}
