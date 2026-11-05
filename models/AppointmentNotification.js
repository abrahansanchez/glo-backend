import {randomUUID} from 'node:crypto';
import mongoose from 'mongoose';
const opts={timestamps:true,strict:'throw',autoCreate:false,autoIndex:false};
const consent=new mongoose.Schema({_id:String,businessId:String,appointmentId:String,admissionRevision:Number,phoneHash:String,keyId:String,purposes:{type:[String],enum:['confirmation','cancellation','reschedule','reminder']},source:{type:String,enum:['BOOKING_EXPLICIT','OWNER_RECORDED']},issuedBy:String,revoked:{type:Boolean,default:false}},opts);consent.index({businessId:1,appointmentId:1,phoneHash:1},{unique:true});
const optout=new mongoose.Schema({_id:{type:String,default:randomUUID},sender:String,phoneHash:String,keyId:String,unsubscribed:Boolean,providerMessageSid:String},opts);optout.index({sender:1,phoneHash:1},{unique:true});
export function notificationModels(connection=mongoose.connection){return {NotificationConsent:connection.models.NotificationConsent||connection.model('NotificationConsent',consent),NotificationOptOut:connection.models.NotificationOptOut||connection.model('NotificationOptOut',optout)};}
