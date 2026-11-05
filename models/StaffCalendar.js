import mongoose from 'mongoose';
const service = new mongoose.Schema({ serviceId: {type:String,required:true}, price:{type:Number,required:true,min:0}, durationMinutes:{type:Number,required:true,min:1,max:480} },{_id:false});
const schema = new mongoose.Schema({
  businessId:{type:mongoose.Schema.Types.ObjectId,ref:'Barber',required:true},
  label:{type:String,required:true,maxlength:128}, active:{type:Boolean,default:true},
  revision:{type:Number,default:1,min:1}, services:{type:[service],default:[]},
  hours:{type:mongoose.Schema.Types.Mixed,required:true},
  timeOff:{type:[{_id:false,startAt:{type:Date,required:true},endAt:{type:Date,required:true}}],default:[]}
},{timestamps:true,strict:'throw',autoCreate:false,autoIndex:false});
schema.index({businessId:1,active:1,_id:1});
export default mongoose.models.StaffCalendar || mongoose.model('StaffCalendar',schema);
