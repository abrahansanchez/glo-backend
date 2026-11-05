import StaffCalendar from '../../../models/StaffCalendar.js';
import {StaffService} from './StaffService.js';
// Lazily resolve the staff model only after an enabled business requests staff.
// Existing independent/read-only callers do not require the new collection.
export function publicStaffRepository({BarberModel,AppointmentModel,CalendarModel,now=()=>new Date()}){
 let service,Calendar;
 const resolve=()=>{Calendar||=CalendarModel||AppointmentModel.db.models.StaffCalendar||AppointmentModel.db.model('StaffCalendar',StaffCalendar.schema);service||=new StaffService({BarberModel,AppointmentModel,CalendarModel:Calendar,now});};
 return {list:async businessId=>{resolve();await service.canary.assert(businessId,'BOOKING');return Calendar.find({businessId,active:true}).select('label revision services').sort({_id:1}).limit(101).lean();},select:input=>{resolve();return service.selectPublic(input);}};
}
