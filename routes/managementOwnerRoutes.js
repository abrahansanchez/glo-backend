import express from 'express';
import {protect} from '../middleware/authMiddleware.js';
import {requireActiveSubscription} from '../middleware/subscriptionMiddleware.js';
export function mountManagementOwnerRoutes(app,{enabled=false,authenticate=protect,billing=requireActiveSubscription}={}){
 if(enabled!==true)return {enabled:false};
 const router=express.Router();
 router.post('/businesses/:businessId/management-grants',authenticate,billing,async(req,res)=>{
  const a=req.body,composition=req.app.locals.appointmentManagement||req.app.locals.retellManagement;
  if(!composition?.enabled)return res.status(404).json({reasonCode:'MANAGEMENT_NOT_ENABLED'});
  if(!a||Object.keys(a).sort().join(',')!=='actions,appointmentId,contactNumber,expectedRevision,revoked'||!/^([a-f0-9]{24})$/.test(a.appointmentId)||typeof a.contactNumber!=='string'||!/^\+[1-9]\d{7,14}$/.test(a.contactNumber)||!Number.isInteger(a.expectedRevision)||a.expectedRevision<0||typeof a.revoked!=='boolean'||!Array.isArray(a.actions))return res.status(400).json({reasonCode:'INVALID_ARGUMENTS'});
  if(String(req.user?._id)!==req.params.businessId)return res.status(403).json({reasonCode:'FORBIDDEN'});
  try{return res.json(await composition.ownerGrant({accountId:String(req.user._id),businessId:req.params.businessId,...a}));}
  catch(e){return res.status(409).json({reasonCode:e.message==='APPOINTMENT_CHANGED'?'APPOINTMENT_CHANGED':'GRANT_UNAVAILABLE'});}
 });
 app.use('/api/booking/v1',router);return {enabled:true};
}
