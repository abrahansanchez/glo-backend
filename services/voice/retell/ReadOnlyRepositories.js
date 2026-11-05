import {publicStaffRepository} from '../../booking/staff/PublicStaffAvailability.js';
import {externalAvailable} from '../../calendar/CalendarBoundary.js';
import Barber from '../../../models/Barber.js';
import Appointment from '../../../models/Appointment.js';

// Existing models, read capabilities only. Constructing this object performs no I/O.
// The HTTP adapter supplies a validated server-bound business ID, never args.businessId.
export function createRetellReadOnlyRepositories({ BarberModel = Barber, AppointmentModel = Appointment,now } = {}) {
  return Object.freeze({
    staffRepository:publicStaffRepository({BarberModel,AppointmentModel,now}),
    businessRepository: Object.freeze({
      findById(businessId) {
        return BarberModel.findById(businessId).select('_id services availability externalCalendarsRequired staffSchedulingEnabled').lean();
      },
    }),
    appointmentRepository: Object.freeze({
      checkExternal:input=>externalAvailable({...input,AppointmentModel}),
      findConflict(query) {
        return AppointmentModel.findOne(query).select('_id').lean();
      },
    }),
  });
}
