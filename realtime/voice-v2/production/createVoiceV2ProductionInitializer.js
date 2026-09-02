import WebSocket from "ws";
import twilio from "twilio";
import Barber from "../../../models/Barber.js";
import { resolveBusinessByCalledNumber as resolveBusiness } from "../../../services/business/resolveBusinessByCalledNumber.js";
import { SharedSmsAdapter } from "../adapters/SharedSmsAdapter.js";
import { prepareVoiceV2SessionStart } from "../application/prepareVoiceV2SessionStart.js";
import { initializeVoiceV2Session } from "../initializeVoiceV2Session.js";
import { isValidVoiceV2BusinessId } from "../routing/selectVoiceMediaPath.js";

export function createVoiceV2ProductionInitializer({
  env = process.env,
  resolveBusinessByCalledNumber = resolveBusiness,
  initializeSession = initializeVoiceV2Session,
  WebSocketClass = WebSocket,
  twilioFactory = twilio,
  findBarberById = (barberId) => Barber.findById(barberId).lean(),
  smsServiceDependencies = {},
  emit = (event) => console.log(event),
} = {}) {
  const approvedBusinessId = String(env.VOICE_V2_TEST_BUSINESS_ID || "").trim();

  return function initializeV2Connection({ socket, buildSha }) {
    return new Promise((resolve, reject) => {
      let startupIdentity = null; let settled = false;
      const rejectStart = (reason, details = {}) => {
        if (settled) return; settled = true; cleanup();
        emit({ event: "V2_START_REJECTED", reason, ...details });
        try { socket.close?.(1008, reason); } catch {}
        reject(Object.assign(new Error(reason), { code: reason }));
      };
      const onClose = () => rejectStart("SOCKET_CLOSED_DURING_STARTUP");
      const onError = () => rejectStart("SOCKET_ERROR_DURING_STARTUP");
      const onMessage = async (raw) => {
        let message;
        try { message = JSON.parse(raw?.toString?.() ?? raw); } catch { return rejectStart("MALFORMED_PRE_SESSION_EVENT"); }
        if (message.event === "stop") return rejectStart("STOP_BEFORE_START");
        if (message.event !== "start") {
          emit({ event: "V2_START_REJECTED", reason: message.event === "media" ? "MEDIA_BEFORE_START" : "EVENT_BEFORE_START" });
          return;
        }
        const identity = startIdentity(message);
        if (!identity.valid) return rejectStart(identity.reason);
        if (startupIdentity) {
          if (sameIdentity(startupIdentity, identity)) return;
          return rejectStart("CONFLICTING_START");
        }
        startupIdentity = identity;
        emit({ event: "V2_START_RECEIVED", callSid: identity.callSid, streamSid: identity.streamSid });
        if (env.ENABLE_VOICE_V2_ROUTE !== "true" || !isValidVoiceV2BusinessId(approvedBusinessId)) return rejectStart("MIGRATION_SELECTOR_DISABLED");
        try {
          const dependencies = productionDependencies({ env, WebSocketClass, twilioFactory, findBarberById, smsServiceDependencies });
          const prepared = await prepareVoiceV2SessionStart({
            calledNumber: identity.calledNumber,
            resolveBusinessByCalledNumber,
            emit: (event) => emit(event.event === "BUSINESS_IDENTITY_BOUND"
              ? { ...event, callSid: identity.callSid, streamSid: identity.streamSid, barberId: event.businessId }
              : event),
            createResolvedSession: ({ businessContext }) => {
              if (settled) throw Object.assign(new Error("STARTUP_TERMINATED"), { code: "STARTUP_TERMINATED" });
              if (String(businessContext.businessId) !== approvedBusinessId) throw Object.assign(new Error("UNAPPROVED_BUSINESS"), { code: "UNAPPROVED_BUSINESS" });
              cleanup();
              return initializeSession({
                callSid: identity.callSid, callerNumber: identity.callerNumber, businessContext, buildSha,
                twilioSocket: socket, openaiSocketFactory: dependencies.openaiSocketFactory,
                smsAdapter: dependencies.smsAdapter,
                openaiSession: dependencies.openaiSession,
                emit,
              });
            },
          });
          if (!prepared.started) return rejectStart(prepared.reason);
          settled = true;
          queueMicrotask(() => socket.emit?.("message", raw));
          resolve(prepared.session);
        } catch (error) {
          rejectStart(error?.code || "V2_PRODUCTION_COMPOSITION_FAILED");
        }
      };
      const cleanup = () => {
        socket.off?.("message", onMessage); socket.off?.("close", onClose); socket.off?.("error", onError);
        socket.removeListener?.("message", onMessage); socket.removeListener?.("close", onClose); socket.removeListener?.("error", onError);
      };
      socket.on("message", onMessage); socket.on("close", onClose); socket.on("error", onError);
    });
  };
}

function startIdentity(message) {
  const start = message?.start || {}; const custom = start.customParameters || {};
  const value = { callSid: start.callSid, streamSid: start.streamSid || message.streamSid, calledNumber: custom.to || custom.calledNumber, callerNumber: custom.from || custom.callerNumber };
  if (!value.callSid) return { valid: false, reason: "MISSING_CALL_SID" };
  if (!value.streamSid) return { valid: false, reason: "MISSING_STREAM_SID" };
  if (!value.calledNumber) return { valid: false, reason: "MISSING_CALLED_NUMBER" };
  if (!value.callerNumber) return { valid: false, reason: "MISSING_CALLER_NUMBER" };
  return { ...value, valid: true };
}
function sameIdentity(a, b) { return ["callSid", "streamSid", "calledNumber", "callerNumber"].every((key) => a[key] === b[key]); }

function productionDependencies({ env, WebSocketClass, twilioFactory, findBarberById, smsServiceDependencies }) {
  const required = ["OPENAI_API_KEY", "OPENAI_MODEL", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"];
  for (const name of required) if (!env[name]) throw Object.assign(new Error(`missing_${name}`), { code: "PROVIDER_CONFIG_MISSING" });
  const fromNumber = env.TWILIO_PHONE_NUMBER || env.GLO_ROUTING_NUMBER;
  if (!fromNumber) throw Object.assign(new Error("missing_sms_sender"), { code: "SMS_SENDER_MISSING" });
  const messagingClient = twilioFactory(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  return {
    openaiSocketFactory: () => new WebSocketClass(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(env.OPENAI_MODEL)}`, { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } }),
    openaiSession: { model: env.OPENAI_MODEL, voice: "alloy", input_audio_transcription: { model: "gpt-4o-mini-transcribe" } },
    smsAdapter: new SharedSmsAdapter({ dependencies: { ...smsServiceDependencies, fromNumber, messagingClient, findBarberById } }),
  };
}
