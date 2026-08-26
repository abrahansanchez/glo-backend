import { sendAppointmentConfirmation } from "../../../services/messaging/sendAppointmentConfirmation.js";
import { SmsPort, validateSmsRequest } from "../ports/SmsPort.js";
import { BusinessReason, normalizeBusinessError } from "../ports/PortErrors.js";

export class SharedSmsAdapter extends SmsPort {
  constructor({ sendConfirmationFn = sendAppointmentConfirmation, dependencies } = {}) {
    super();
    this.sendConfirmationFn = sendConfirmationFn;
    this.dependencies = dependencies;
  }

  async sendAppointmentConfirmation(request) {
    try {
      validateSmsRequest(request);
      return await this.sendConfirmationFn(request, this.dependencies);
    } catch (error) {
      return Object.freeze({ success: false, submitted: false, replayed: false, reason: normalizeBusinessError(error, BusinessReason.PROVIDER_ERROR) });
    }
  }
}
