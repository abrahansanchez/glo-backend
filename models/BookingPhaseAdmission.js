import mongoose from 'mongoose';
const schema=new mongoose.Schema({_id:{type:String,required:true,match:/^[a-f0-9]{24}$/},enabled:{type:Boolean,default:false},revision:{type:Number,required:true,min:1},capabilities:{type:[String],enum:['BOOKING','MANAGEMENT','CALENDAR','NOTIFICATIONS'],default:[]},expiresAt:{type:Date,required:true},changedBy:{type:String,maxlength:128},accessFence:{type:Number,default:0}},{timestamps:true,strict:'throw',autoCreate:false,autoIndex:false});
// Durable, server-owned tenant configuration. No HTTP owner/model writer. No TTL.
export function admissionModel(connection=mongoose.connection){return connection.models.BookingPhaseAdmission||connection.model('BookingPhaseAdmission',schema);}
