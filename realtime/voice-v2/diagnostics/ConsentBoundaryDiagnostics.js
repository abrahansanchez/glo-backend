const MAX_BOUNDARIES = 32;

// Call-owned observation only. This class owns no timers and makes no
// lifecycle, floor, authority, interpretation, or booking decisions.
export class ConsentBoundaryDiagnostics {
  constructor({ trace, context, preferredLanguage = "en", transcriptionLanguage = null, maxBoundaries = MAX_BOUNDARIES }) {
    this.trace = trace;
    this.context = context;
    this.preferredLanguage = preferredLanguage;
    this.transcriptionLanguage = transcriptionLanguage;
    this.maxBoundaries = maxBoundaries;
    this.windows = [];
    this.activeWindow = null;
    this.items = new Map();
    this.completed = false;
    this.limitReported = false;
    this.confirmationLanguage = null;
    this.bookingSuccessLanguage = null;
  }

  responsePlanned({ purpose, language }) {
    if (purpose === "PRE_BOOKING_CONFIRMATION") this.confirmationLanguage = language || null;
    if (purpose === "BOOKING_SUCCESS") this.bookingSuccessLanguage = language || null;
  }

  playbackAcknowledged(details) {
    if (!details.expectsCallerInput) return;
    if (this.windows.length >= this.maxBoundaries) {
      const oldest = this.windows.shift();
      this.#emitWindow(oldest);
      if (!this.limitReported) {
        this.limitReported = true;
        this.trace.entry("CONSENT_BOUNDARY_DIAGNOSTIC_LIMIT", { maxBoundaries: this.maxBoundaries });
      }
    }
    const snapshot = this.context();
    this.activeWindow = {
      ...safeOwner(details),
      currentRequirement: snapshot.currentRequirement,
      preferredLanguage: snapshot.preferredLanguage,
      configuredTranscriptionLanguage: this.transcriptionLanguage,
      responsePlanLanguage: details.responsePlanLanguage || null,
      responsePurpose: details.responsePurpose || null,
      consentExpected: ["PRE_BOOKING_CONFIRMATION", "CONSENT_REASK"].includes(details.responsePurpose),
      inbound: audioStats(),
      forwarded: audioStats(),
      items: [],
      emitted: false,
    };
    this.windows.push(this.activeWindow);
  }

  inboundAudio(bytes) { recordAudio(this.activeWindow?.inbound, bytes, this.trace.stamp()); }
  forwardedAudio(bytes) { recordAudio(this.activeWindow?.forwarded, bytes, this.trace.stamp()); }

  speechStarted(itemId, details = {}) { const item = this.#item(itemId, details); if (item) item.speechStarted = true; }
  speechStopped(itemId, details = {}) { const item = this.#item(itemId, details); if (item) item.speechStopped = true; }
  committed(itemId, details = {}) { const item = this.#item(itemId, details); if (item) item.committed = true; }
  transcriptionCompleted(itemId, { characterCount = 0, empty = false, ...details } = {}) {
    const item = this.#item(itemId, details); if (!item) return;
    item.transcriptionStatus = "COMPLETED"; item.characterCount = characterCount; item.emptyTranscript = empty;
  }
  transcriptionFailed(itemId, details = {}) { const item = this.#item(itemId, details); if (item) item.transcriptionStatus = "FAILED"; }
  admission(itemId, { status, reason = null, turnId = null } = {}) {
    const item = this.#item(itemId); if (!item) return;
    item.turnAdmission = status; item.turnAdmissionReason = reason; if (turnId) item.turnId = turnId;
  }
  persistence(itemId, { status, affectedSemanticProcessing = false, turnId = null } = {}) {
    const item = this.#item(itemId); if (!item) return;
    item.persistenceStatus = status; item.persistenceAffectedSemanticProcessing = affectedSemanticProcessing; if (turnId) item.turnId = turnId;
  }
  interpretation(itemId, { ran, action = null, turnId = null } = {}) {
    const item = this.#item(itemId); if (!item) return;
    item.interpretationRan = ran === true; item.interpretationAction = action; if (turnId) item.turnId = turnId;
  }
  consent(itemId, { ownerMatched, authorityExisted, authorityDecision = null, reason = null } = {}) {
    const item = this.#item(itemId); if (!item) return;
    item.consentOwnerMatched = ownerMatched; item.consentAuthorityExisted = authorityExisted;
    item.authorityDecision = authorityDecision; item.authorityReason = reason;
  }
  booking(itemId, { queued, reason = null } = {}) {
    const item = this.#item(itemId); if (!item) return;
    item.bookingCommandQueued = queued === true; item.bookingReason = reason;
  }

  complete() {
    if (this.completed) return;
    this.completed = true;
    for (const window of this.windows) this.#emitWindow(window);
    const conversationLanguage = this.context().conversationLanguage;
    const languages = [this.preferredLanguage, this.transcriptionLanguage, conversationLanguage, this.confirmationLanguage, this.bookingSuccessLanguage].filter(Boolean);
    this.trace.entry("LANGUAGE_BOUNDARY", {
      preferredLanguage: this.preferredLanguage,
      transcriptionLanguage: this.transcriptionLanguage,
      conversationLanguage,
      confirmationLanguage: this.confirmationLanguage,
      bookingSuccessLanguage: this.bookingSuccessLanguage,
      consistent: languages.every((value) => value === languages[0]),
    });
  }

  #item(itemId, details = {}) {
    if (!this.activeWindow) return null;
    const key = itemId || `unidentified:${this.windows.indexOf(this.activeWindow)}`;
    let item = this.items.get(key);
    if (!item) {
      item = {
        ...safeOwner(this.activeWindow),
        ...safeOwner(details),
        itemId: itemId || null,
        turnId: null,
        currentRequirement: this.activeWindow.currentRequirement,
        preferredLanguage: this.activeWindow.preferredLanguage,
        configuredTranscriptionLanguage: this.activeWindow.configuredTranscriptionLanguage,
        responsePlanLanguage: this.activeWindow.responsePlanLanguage,
        responsePurpose: this.activeWindow.responsePurpose,
        speechStarted: false,
        speechStopped: false,
        committed: false,
        transcriptionStatus: null,
        conversationItemAssociated: Boolean(itemId),
        characterCount: null,
        emptyTranscript: false,
        turnAdmission: null,
        turnAdmissionReason: null,
        persistenceStatus: null,
        persistenceAffectedSemanticProcessing: null,
        interpretationRan: false,
        interpretationAction: null,
        consentOwnerMatched: null,
        consentAuthorityExisted: null,
        authorityDecision: null,
        authorityReason: null,
        bookingCommandQueued: false,
        bookingReason: null,
        window: this.activeWindow,
      };
      this.items.set(key, item); this.activeWindow.items.push(item);
    }
    return item;
  }

  #emitWindow(window) {
    if (!window || window.emitted) return;
    window.emitted = true;
    if (!window.items.length) window.items.push(this.#synthetic(window));
    for (const item of window.items) this.trace.entry("CONSENT_BOUNDARY", serialize(item, classify(item)));
  }

  #synthetic(window) {
    return {
      ...safeOwner(window), itemId: null, turnId: null,
      currentRequirement: window.currentRequirement,
      preferredLanguage: window.preferredLanguage,
      configuredTranscriptionLanguage: window.configuredTranscriptionLanguage,
      responsePlanLanguage: window.responsePlanLanguage,
      responsePurpose: window.responsePurpose,
      speechStarted: false, speechStopped: false, committed: false,
      transcriptionStatus: null, characterCount: null, emptyTranscript: false,
      conversationItemAssociated: false,
      turnAdmission: null, turnAdmissionReason: null, persistenceStatus: null,
      persistenceAffectedSemanticProcessing: null, interpretationRan: false,
      interpretationAction: null, consentOwnerMatched: null,
      consentAuthorityExisted: null, authorityDecision: null, authorityReason: null,
      bookingCommandQueued: false, bookingReason: null, window,
    };
  }
}

function classify(item) {
  if (item.window.inbound.frames === 0) return "NO_INBOUND_MEDIA";
  if (item.window.forwarded.frames === 0) return "AUDIO_NOT_FORWARDED";
  if (!item.speechStarted) return "VAD_NOT_STARTED";
  if (!item.speechStopped) return "VAD_NOT_STOPPED";
  if (!item.committed) return "AUDIO_NOT_COMMITTED";
  if (item.transcriptionStatus === "FAILED") return "TRANSCRIPTION_FAILED";
  if (item.transcriptionStatus !== "COMPLETED") return "TRANSCRIPTION_MISSING";
  if (item.emptyTranscript) return "EMPTY_TRANSCRIPT";
  if (["STALE", "QUARANTINED", "REJECTED"].includes(item.turnAdmission)) return "TURN_QUARANTINED";
  if (item.persistenceStatus === "FAILED") return "TRANSCRIPT_PERSISTENCE_FAILED";
  if (!item.window.consentExpected) return item.interpretationRan ? "RESOLVED" : "TURN_QUARANTINED";
  if (item.interpretationAction === "AFFIRM_CONFIRMATION" && item.consentOwnerMatched === false) return "CONSENT_OWNER_MISMATCH";
  if (item.authorityDecision === "WITHHELD" && ["NO_CURRENT_CONFIRMATION", "FLOOR_OWNER_MISMATCH", "CONSENT_OWNER_MISMATCH"].includes(item.authorityReason)) return "CONSENT_OWNER_MISMATCH";
  if (item.interpretationAction !== "AFFIRM_CONFIRMATION") return "AFFIRMATIVE_NOT_RECOGNIZED";
  if (!item.bookingCommandQueued) return "BOOKING_COMMAND_NOT_QUEUED";
  return "RESOLVED";
}

function serialize(item, classification) {
  return {
    itemId: item.itemId, turnId: item.turnId,
    floorState: item.floorState, floorOwnerRequestId: item.requestId,
    responseId: item.responseId, markId: item.markId,
    proposalVersion: item.proposalVersion, currentRequirement: item.currentRequirement,
    preferredLanguage: item.preferredLanguage,
    transcriptionLanguage: item.configuredTranscriptionLanguage,
    responsePlanLanguage: item.responsePlanLanguage,
    responsePurpose: item.responsePurpose,
    inboundFrameCount: item.window.inbound.frames,
    inboundByteCount: item.window.inbound.bytes,
    inboundFirstElapsedMs: item.window.inbound.firstElapsedMs,
    inboundLastElapsedMs: item.window.inbound.lastElapsedMs,
    forwardedFrameCount: item.window.forwarded.frames,
    forwardedByteCount: item.window.forwarded.bytes,
    forwardedFirstElapsedMs: item.window.forwarded.firstElapsedMs,
    forwardedLastElapsedMs: item.window.forwarded.lastElapsedMs,
    speechStarted: item.speechStarted, speechStopped: item.speechStopped,
    audioCommitted: item.committed, transcriptionStatus: item.transcriptionStatus,
    conversationItemAssociated: item.conversationItemAssociated,
    transcriptCharacterCount: item.characterCount, emptyTranscript: item.emptyTranscript,
    turnAdmission: item.turnAdmission, turnAdmissionReason: item.turnAdmissionReason,
    persistenceStatus: item.persistenceStatus,
    persistenceAttempted: item.persistenceStatus !== null,
    persistenceAffectedSemanticProcessing: item.persistenceAffectedSemanticProcessing,
    interpretationRan: item.interpretationRan, interpretationAction: item.interpretationAction,
    consentOwnerMatched: item.consentOwnerMatched,
    consentAuthorityExisted: item.consentAuthorityExisted,
    authorityDecision: item.authorityDecision, authorityReason: item.authorityReason,
    bookingCommandQueued: item.bookingCommandQueued, bookingReason: item.bookingReason,
    classification,
  };
}

function safeOwner(value = {}) {
  return {
    floorState: value.floorState || null,
    requestId: value.requestId || value.floorOwnerRequestId || null,
    responseId: value.responseId || null,
    markId: value.markId || null,
    proposalVersion: value.proposalVersion ?? null,
  };
}
function audioStats() { return { frames: 0, bytes: 0, firstElapsedMs: null, lastElapsedMs: null }; }
function recordAudio(stats, bytes, stamp) {
  if (!stats) return;
  stats.frames += 1; stats.bytes += Number.isFinite(bytes) ? bytes : 0;
  if (stats.firstElapsedMs === null) stats.firstElapsedMs = stamp.elapsedMs;
  stats.lastElapsedMs = stamp.elapsedMs;
}
