import { createIdempotentAppointment } from "../../../services/booking/createIdempotentAppointment.js";
import { BookingPort, validateBookingRequest } from "../ports/BookingPort.js";
import { BusinessReason, normalizeBusinessError } from "../ports/PortErrors.js";

export class SharedBookingAdapter extends BookingPort {
  constructor({ createAppointmentFn = createIdempotentAppointment, dependencies } = {}) {
    super();
    this.createAppointmentFn = createAppointmentFn;
    this.dependencies = dependencies;
  }

  async createAppointment(request) {
    try {
      validateBookingRequest(request);
      return await this.createAppointmentFn(request, this.dependencies);
    } catch (error) {
      return Object.freeze({
        success: false,
        appointmentId: null,
        replayed: false,
        reason: normalizeBusinessError(error, BusinessReason.PERSISTENCE_ERROR),
      });
    }
  }
}
