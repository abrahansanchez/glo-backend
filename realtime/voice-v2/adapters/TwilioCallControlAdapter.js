export class TwilioCallControlAdapter {
  #client;

  constructor({ client } = {}) {
    this.#client = client;
  }

  async terminateCall({ callSid, onProgress = () => {} }) {
    if (!callSid) throw new TypeError("call_sid_required");
    if (typeof this.#client?.calls !== "function") {
      return Object.freeze({ success: false, invoked: true, providerSubmissionConfirmed: false, reason: "PROVIDER_UNAVAILABLE" });
    }
    try {
      const call = this.#client.calls(callSid);
      const update = await call.update({ status: "completed" });
      const providerStatus = update?.status || null;
      const providerReportedCompleted = providerStatus === "completed";
      onProgress(Object.freeze({ stage: "PROVIDER_REPORTED", providerStatus, providerReportedCompleted }));
      let verifiedStatus = null;
      let actualCallStatusVerified = false;
      try {
        const verified = typeof call.fetch === "function" ? await call.fetch() : null;
        verifiedStatus = verified?.status || null;
        actualCallStatusVerified = verifiedStatus === "completed";
        onProgress(Object.freeze({ stage: "STATUS_VERIFIED", verifiedStatus, actualCallStatusVerified }));
      } catch (error) {
        return Object.freeze({ success: false, invoked: true, providerSubmissionConfirmed: true, providerStatus, providerReportedCompleted, verifiedStatus, actualCallStatusVerified, reason: error?.code || "STATUS_VERIFICATION_FAILED" });
      }
      return Object.freeze({ success: actualCallStatusVerified, invoked: true, providerSubmissionConfirmed: true, providerStatus, providerReportedCompleted, verifiedStatus, actualCallStatusVerified, reason: actualCallStatusVerified ? null : "CALL_STATUS_UNVERIFIED" });
    } catch (error) {
      return Object.freeze({ success: false, invoked: true, providerSubmissionConfirmed: false, providerStatus: null, providerReportedCompleted: false, verifiedStatus: null, actualCallStatusVerified: false, reason: error?.code || "PROVIDER_ERROR" });
    }
  }
}
