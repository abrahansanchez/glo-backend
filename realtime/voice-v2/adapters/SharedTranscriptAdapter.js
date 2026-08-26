import { appendTranscriptTurn, finalizeTranscript } from "../../../services/transcripts/transcriptPersistence.js";
import { TranscriptPort, validateAppendTurnRequest, validateFinalizeCallRequest } from "../ports/TranscriptPort.js";
import { BusinessReason, normalizeBusinessError } from "../ports/PortErrors.js";

export class SharedTranscriptAdapter extends TranscriptPort {
  constructor({ appendTurnFn = appendTranscriptTurn, finalizeCallFn = finalizeTranscript, dependencies } = {}) {
    super();
    this.appendTurnFn = appendTurnFn;
    this.finalizeCallFn = finalizeCallFn;
    this.dependencies = dependencies;
  }

  async appendTurn(request) {
    try {
      validateAppendTurnRequest(request);
      return await this.appendTurnFn(request, this.dependencies);
    } catch (error) {
      return Object.freeze({ success: false, replayed: false, reason: normalizeBusinessError(error, BusinessReason.PERSISTENCE_ERROR) });
    }
  }

  async finalizeCall(request) {
    try {
      validateFinalizeCallRequest(request);
      return await this.finalizeCallFn(request, this.dependencies);
    } catch (error) {
      return Object.freeze({ success: false, replayed: false, reason: normalizeBusinessError(error, BusinessReason.PERSISTENCE_ERROR) });
    }
  }
}
