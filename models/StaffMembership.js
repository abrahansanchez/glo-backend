import mongoose from 'mongoose';
const schema=new mongoose.Schema({businessId:{type:mongoose.Schema.Types.ObjectId,ref:'Barber',required:true},accountId:{type:mongoose.Schema.Types.ObjectId,ref:'Barber',required:true},acceptedInvitationId:String,role:{type:String,enum:['manager','staff'],required:true},calendarIds:{type:[mongoose.Schema.Types.ObjectId],default:[]},active:{type:Boolean,default:true},revision:{type:Number,default:1}},{timestamps:true,strict:'throw',autoCreate:false,autoIndex:false});
schema.index({businessId:1,accountId:1},{unique:true});
export default mongoose.models.StaffMembership || mongoose.model('StaffMembership',schema);
