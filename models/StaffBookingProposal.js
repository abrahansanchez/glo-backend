import mongoose from 'mongoose';
const schema=new mongoose.Schema({_id:{type:String,required:true},businessId:{type:mongoose.Schema.Types.ObjectId,required:true},accountId:{type:mongoose.Schema.Types.ObjectId,required:true},kind:{type:String,enum:['CREATE','CANCEL','RESCHEDULE']},result:mongoose.Schema.Types.Mixed,commitToken:String,
 facts:{type:mongoose.Schema.Types.Mixed,required:true},factsHash:{type:String,required:true},expiresAt:{type:Date,required:true},status:{type:String,enum:['PREPARED','BOOKED','COMMITTING','SETTLED','UNKNOWN','FAILED'],required:true},appointmentId:mongoose.Schema.Types.ObjectId},{timestamps:true,strict:'throw',autoCreate:false,autoIndex:false});
schema.index({businessId:1,accountId:1,createdAt:-1});
export default mongoose.models.StaffBookingProposal||mongoose.model('StaffBookingProposal',schema);
