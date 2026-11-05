import express from 'express';
import {validateTwilioTransportRequest} from '../services/security/twilioTransportAuth.js';
import {protect} from '../middleware/authMiddleware.js';
import {requireActiveSubscription} from '../middleware/subscriptionMiddleware.js';
export function createNotificationWebhooks({policy,dispatcher,accountSid,authToken,appBaseUrl,fromNumber,callbackPath='/api/booking/v1/notifications/status'}){
 const router=express.Router(),parse=express.urlencoded({extended:false,limit:'16kb',parameterLimit:64,inflate:false});
 const authenticate=(req,res,next)=>{if(req.body?.AccountSid!==accountSid||!validateTwilioTransportRequest({authToken,appBaseUrl,requestPath:req.originalUrl,signature:req.get('x-twilio-signature'),params:req.body}).valid)return res.sendStatus(403);next();};
 router.post(callbackPath+'/:id',parse,authenticate,async(req,res)=>{try{return res.sendStatus(await dispatcher.callback(req.params.id,req.body)?204:403);}catch{return res.sendStatus(503);}});
 const parseSms=express.urlencoded({extended:false,inflate:false,verify:(req,_res,body)=>{req.notificationBodyBytes=body.length;}});
 router.post('/api/sms/inbound',parseSms,(req,res,next)=>{if(req.body?.To!==fromNumber)return next('route');if(req.notificationBodyBytes>16384)return res.sendStatus(413);next();},authenticate,async(req,res,next)=>{
  try{
   if(req.body.To!==fromNumber||!/^SM[a-f0-9]{32}$/i.test(req.body.MessageSid||''))return res.sendStatus(403);
   // Only documented messaging compliance keywords; not a voice interpreter.
   const body=String(req.body.Body||'').trim().toUpperCase();
   const type=['STOP','START','HELP'].includes(req.body.OptOutType)?req.body.OptOutType:['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT'].includes(body)?'STOP':['START','UNSTOP','YES'].includes(body)?'START':body==='HELP'?'HELP':null;
   if(type===null)return next('route');
   if(type==='STOP'||type==='START'){
    // Validate the number without retaining it. All retained key generations
    // are checked on dispatch; START never grants appointment consent.
    policy.hash('compliance',req.body.From);
    const phoneHash=policy.globalHash(req.body.From);
    // STOP dominates conflicting late START/STOP callbacks. START requires a
    // fresh explicit owner/customer recovery if an earlier STOP is present:
    // do not resurrect consent from webhook order alone.
    if(type==='STOP')await policy.NotificationOptOut.updateOne({sender:fromNumber,phoneHash},{$set:{keyId:policy.activeKeyId,unsubscribed:true,providerMessageSid:req.body.MessageSid}},{upsert:true});
   }
   return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response/>');
  }catch{return res.sendStatus(503);}
 });
 router.use((e,req,res,next)=>{if(req.path!=='/api/sms/inbound'&&!req.path.startsWith(callbackPath+'/'))return next(e);return res.sendStatus(e.type==='entity.too.large'?413:400);});return router;
}
export function createNotificationPolicyRouter({policy,authenticate=protect,billing=requireActiveSubscription}){
 const router=express.Router();
 router.put('/businesses/:businessId/notification-policy',authenticate,billing,express.json({limit:'2kb',inflate:false}),async(req,res)=>{
  if(String(req.user?._id)!==req.params.businessId)return res.sendStatus(403);
  if(!req.body||Object.keys(req.body).join(',')!=='enabled'||typeof req.body.enabled!=='boolean')return res.status(400).json({reasonCode:'INVALID_ARGUMENTS'});
  try{await policy.canary.assert(req.params.businessId,'NOTIFICATIONS');await policy.ready();const r=await policy.Barber.collection.updateOne({_id:new policy.Barber.base.Types.ObjectId(req.params.businessId)},{$set:{appointmentNotificationPolicyEnabled:req.body.enabled},$inc:{bookingConfigurationFence:1}});return r.matchedCount?res.json({enabled:req.body.enabled,historicalConsentUnchanged:true}):res.sendStatus(404);}catch{return res.status(503).json({reasonCode:'POLICY_UNAVAILABLE'});}
 });return router;
}
