import { createIdempotentAppointment, reconcileIdempotentAppointment } from "../../../services/booking/createIdempotentAppointment.js";
import { BookingPort, validateBookingRequest } from "../ports/BookingPort.js";
import { BusinessReason, normalizeBusinessError } from "../ports/PortErrors.js";

export class SharedBookingAdapter extends BookingPort {
  constructor({ createAppointmentFn = createIdempotentAppointment, reconcileAppointmentFn = reconcileIdempotentAppointment, dependencies } = {}) {
    super();
    this.createAppointmentFn = createAppointmentFn;
    this.reconcileAppointmentFn = reconcileAppointmentFn;
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

  async reconcileAppointment(request) {
    try {
      validateBookingRequest(request);
      return await this.reconcileAppointmentFn(request, this.dependencies);
    } catch {
      return Object.freeze({ settled: false, success: false, appointmentId: null, replayed: false, reason: BusinessReason.SETTLEMENT_UNKNOWN });
    }
  }
}
