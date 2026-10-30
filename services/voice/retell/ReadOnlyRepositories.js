import Barber from '../../../models/Barber.js';
import Appointment from '../../../models/Appointment.js';

// Existing models, read capabilities only. Constructing this object performs no I/O.
// The HTTP adapter supplies a validated server-bound business ID, never args.businessId.
export function createRetellReadOnlyRepositories({ BarberModel = Barber, AppointmentModel = Appointment } = {}) {
  return Object.freeze({
    businessRepository: Object.freeze({
      findById(businessId) {
        return BarberModel.findById(businessId).select('_id services availability').lean();
      },
    }),
    appointmentRepository: Object.freeze({
      findConflict(query) {
        return AppointmentModel.findOne(query).select('_id').lean();
      },
    }),
  });
}
