import {createHash} from 'node:crypto';
import {calendarModels} from '../../models/ExternalCalendar.js';
export async function enqueueCalendarWork({business,appointment,session,AppointmentModel,removed=false}){
 if(!business.externalCalendarExportConfigured&&!appointment.calendarExportManaged)return;
 const M=calendarModels(AppointmentModel.db),businessId=String(appointment.barberId),appointmentId=String(appointment._id);
 let admissionRevision;let mapping=await M.CalendarMapping.findOne({businessId,appointmentId}).session(session).lean(),sourceId=mapping?.sourceId;
 if(!sourceId){let source=await M.CalendarSource.findOne({businessId,exportEnabled:true,staffCalendarId:appointment.staffCalendarId?String(appointment.staffCalendarId):null}).session(session).lean();if(!source&&appointment.staffCalendarId)source=await M.CalendarSource.findOne({businessId,exportEnabled:true,staffCalendarId:null}).session(session).lean();sourceId=source?._id;admissionRevision=source?.admissionRevision;}
 if(!sourceId)return;if(admissionRevision===undefined){const s=await M.CalendarSource.findById(sourceId).session(session).lean();admissionRevision=s?.admissionRevision;}
 const kind=removed||!['confirmed','pending'].includes(appointment.status)?'REMOVE':'UPSERT',appointmentRevision=(appointment.scheduleRevision||0)+(removed?1:0),id=createHash('sha256').update(`${businessId}:${appointmentId}:${appointmentRevision}:${kind}:${sourceId}`).digest('hex');
 await M.CalendarWork.updateOne({_id:id},{$setOnInsert:{_id:id,businessId,admissionRevision,appointmentId,appointmentRevision,sourceId,kind,status:'PENDING',attempts:0}},{upsert:true,session});
}
