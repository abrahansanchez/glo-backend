import express from 'express';
import {protect} from '../middleware/authMiddleware.js';
export function bookingFoundationRoutes({service,billing,workspace,authenticate=protect}) {
  const router=express.Router();router.use(authenticate);
  router.use('/businesses/:businessId',async(req,res,next)=>{try{await service.canary.assert(req.params.businessId,'BOOKING');await service.scope(String(req.user._id),req.params.businessId);if(!await billing(req.params.businessId))return res.status(403).json({reasonCode:'BUSINESS_SUBSCRIPTION_REQUIRED'});next();}catch{return res.status(403).json({reasonCode:'FORBIDDEN'});}});
  const run=handler=>async(req,res)=>{try{res.json({data:await handler(req)});}catch(e){const candidate=e.reasonCode||(e.code==='SCHEDULE_CONFLICT'?'SCHEDULE_CONFLICT':e.code==='RECONCILIATION_REQUIRED'?'SETTLEMENT_UNKNOWN':e.code==='INVALID_SLOT'?e.message:undefined);const reasonCode=['CANARY_NOT_ADMITTED','SCHEDULE_CONFLICT','SETTLEMENT_UNKNOWN','NOTIFICATIONS_NOT_ALLOWED','MANAGEMENT_NOT_ALLOWED','STAFF_REVISION_CHANGED','TIMEZONE_REQUIRED','INVALID_INTERVAL','NOT_FOUND','NOT_ELIGIBLE','INVALID_RANGE','INVALID_CURSOR','RANGE_SOURCE_LIMIT','STAFF_SELECTION_REQUIRED','MISSING_CATALOGUE_FACTS','AVAILABILITY_UNVERIFIED','INVALID_ARGUMENTS','INVALID_CONTACT_NUMBER','EXPLICIT_CONFIRMATION_REQUIRED','STALE_OR_FOREIGN_PROPOSAL','PROPOSAL_EXPIRED','BUSINESS_REVISION_CHANGED','IDEMPOTENCY_CONFLICT','FORBIDDEN','INVALID_CALENDAR','INVALID_STAFF_SERVICE','INVALID_HOURS','INVALID_TIME_OFF','STALE_REVISION','SERVICE_NOT_QUALIFIED','STAFF_NOT_ELIGIBLE','PAST_OR_INVALID_SLOT','STAFF_ABSENT','BUSINESS_UNAVAILABLE','STAFF_UNAVAILABLE','UNAVAILABLE'].includes(candidate)?candidate:'REQUEST_FAILED';res.status(['FORBIDDEN','CANARY_NOT_ADMITTED'].includes(reasonCode)?403:409).json({reasonCode});}};
  router.post('/businesses/:businessId/appointments/prepare',run(req=>service.prepare(String(req.user._id),req.params.businessId,req.body)));
  router.post('/businesses/:businessId/appointments/commit',run(req=>service.commit(String(req.user._id),req.params.businessId,req.body)));
  router.post('/businesses/:businessId/memberships',run(req=>service.membership(String(req.user._id),req.params.businessId,req.body)));
  router.get('/businesses/:businessId/calendars',run(req=>service.calendars(String(req.user._id),req.params.businessId)));
  router.post('/businesses/:businessId/calendars',run(req=>service.saveCalendar(String(req.user._id),req.params.businessId,req.body)));
  router.put('/businesses/:businessId/calendars/:calendarId',run(req=>service.saveCalendar(String(req.user._id),req.params.businessId,req.body.calendar,req.params.calendarId,req.body.expectedRevision)));
  router.post('/businesses/:businessId/availability',run(req=>service.select({businessId:req.params.businessId,accountId:String(req.user._id),calendarId:req.body.calendarId,serviceId:req.body.serviceId,startAt:req.body.startAt})));
  if(workspace){
   router.get('/businesses/:businessId/context',run(req=>workspace.context(String(req.user._id),req.params.businessId)));
   router.get('/businesses/:businessId/calendars/range',run(req=>workspace.range(String(req.user._id),req.params.businessId,req.query)));
   router.get('/businesses/:businessId/appointments/:id',run(req=>workspace.details(String(req.user._id),req.params.businessId,req.params.id)));
   router.post('/businesses/:businessId/appointments/:id/actions/prepare',run(req=>workspace.prepare(String(req.user._id),req.params.businessId,req.params.id,req.body)));
   router.post('/businesses/:businessId/actions/commit',run(req=>workspace.commit(String(req.user._id),req.params.businessId,req.body)));
  }
  return router;
}
