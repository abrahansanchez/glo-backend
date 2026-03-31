import twilio from "twilio";
import Barber from "../models/Barber.js";
import {
  clearActiveCall,
  clearActiveCallBySid,
  getActiveCall,
  setActiveCall,
} from "../utils/voice/activeCallStore.js";
import { sendExpoPush } from "../utils/push/expoPush.js";
import {
  isForwardingVerificationSessionActive,
  maybeVerifyForwardingCall,
} from "../services/phoneStrategyService.js";

const VoiceResponse = twilio.twiml.VoiceResponse;

const getBaseHttpsUrl = (req) => {
  const rawBase = process.env.APP_BASE_URL || req.headers.host || "";
  const normalized = rawBase.replace(/(^\w+:|^)\/\//, "").replace(/\/$/, "");
  return `https://${normalized}`;
};

const getMediaWebsocketUrl = (req) => {
  const rawBase = process.env.APP_BASE_URL || req.headers.host || "";
  const normalized = rawBase.replace(/(^\w+:|^)\/\//, "").replace(/\/$/, "");
  return `wss://${normalized}/ws/media`;
};

const buildInitialPrompt = (barberName, options = {}) => {
  const { services = [], businessHours = null, timezone = "America/New_York" } = options;

  let servicesText = "";
  if (services.length > 0) {
    servicesText = "\n\nSERVICES AND PRICING:\n" +
      services.map((s) =>
        `- ${s.name}${s.price ? ": $" + s.price : ""}${s.durationMinutes ? " (" + s.durationMinutes + " min)" : ""}`
      ).join("\n");
  } else {
    servicesText = "\n\nSERVICES: Not configured yet. If asked about services or prices, say you will have the barber follow up with details.";
  }

  let hoursText = "";
  if (businessHours) {
    const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const dayNames = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
    const openDays = days
      .filter((d) => businessHours[d] && !businessHours[d].isClosed)
      .map((d) => `${dayNames[d]} ${businessHours[d].open} to ${businessHours[d].close}`)
      .join(", ");
    hoursText = openDays
      ? `\n\nBUSINESS HOURS (${timezone}):\n${openDays}`
      : "\n\nBUSINESS HOURS: Not configured yet. If asked about hours, say you will have the barber follow up.";
  } else {
    hoursText = "\n\nBUSINESS HOURS: Not configured yet. If asked about hours, say you will have the barber follow up.";
  }

  return (
    `You are Glo, the AI receptionist for ${barberName}.\n` +
    `When you answer:\n` +
    `- Say: "Thanks for calling ${barberName}'s. This is Glo, the AI receptionist. How can I help you today?"\n` +
    `- Be natural and brief (1 sentence + a question).\n` +
    `- NEVER invent dates or times.\n` +
    `- If booking: require BOTH date and time, repeat back EXACTLY, then confirm YES before finalizing.\n` +
    servicesText +
    hoursText
  );
};

export const buildSetupCallPrompt = (barberName, language = "en") => {
  if (language === "es") {
    return (
      `Eres Glō, una recepcionista de IA configurando la cuenta de ${barberName}.\n` +
      `Tu objetivo es recopilar su información de negocio mediante conversación natural y cálida.\n` +
      `Sigue esta secuencia exacta - no te saltes ningún paso:\n\n` +
      `PASO 1 - DÍAS ABIERTO:\n` +
      `Di: "¡Hola ${barberName}! Soy tu recepcionista de IA Glō. Te voy a hacer unas preguntas rápidas para poder manejar tus llamadas de inmediato. ¿Qué días está abierto tu negocio?"\n` +
      `Escucha los días mencionados. Mapea a: mon, tue, wed, thu, fri, sat, sun.\n` +
      `Días NO mencionados = isClosed: true.\n\n` +
      `PASO 2 - HORA DE APERTURA:\n` +
      `Pregunta: "¿A qué hora abres?"\n` +
      `Convierte al formato 24 horas HH:MM. Ejemplo: 9am = 09:00.\n\n` +
      `PASO 3 - HORA DE CIERRE:\n` +
      `Pregunta: "¿Y a qué hora cierras?"\n` +
      `Convierte al formato 24 horas HH:MM.\n\n` +
      `PASO 4 - SERVICIOS Y PRECIOS:\n` +
      `Pregunta: "Dime tus servicios y precios - dímelos naturalmente, como corte 30 dólares."\n` +
      `Extrae cada nombre de servicio y precio. Guarda como array de objetos con name y price.\n\n` +
      `PASO 5 - DURACIÓN DE CITAS:\n` +
      `Pregunta: "¿Cuánto tiempo dura cada cita en promedio?"\n` +
      `Extrae el número de minutos.\n\n` +
      `PASO 6 - CONFIRMAR Y CERRAR:\n` +
      `Di: "¡Perfecto ${barberName}! Ya tengo todo lo que necesito. A partir de ahora voy a contestar tus llamadas, agendar citas y nunca dejar escapar a un cliente. ¡Vamos a ponerte en línea!"\n` +
      `Luego genera SOLO este bloque JSON con etiqueta SETUP_DATA:\n` +
      "```SETUP_DATA\n" +
      `{"days":["mon","tue","wed","thu","fri","sat"],"openTime":"09:00","closeTime":"19:00","services":[{"name":"Corte","price":30},{"name":"Fade","price":35}],"durationMinutes":30}\n` +
      "```\n\n" +
      `REGLAS IMPORTANTES:\n` +
      `- Sé cálido y conversacional. Nunca robótico.\n` +
      `- Si no entiendes una respuesta, pregunta una vez más de otra manera.\n` +
      `- Nunca inventes información. Solo guarda lo que el barbero explícitamente diga.\n` +
      `- Confirma cada respuesta antes de pasar al siguiente paso.\n` +
      `- Mantén las respuestas cortas - una pregunta a la vez.\n` +
      `- El JSON SETUP_DATA debe estar en inglés con claves en inglés aunque la conversación sea en español.\n`
    );
  }

  return (
    `You are Glō, an AI receptionist setting up ${barberName}'s account.\n` +
    `Your goal is to collect their business information through natural warm conversation.\n` +
    `Follow this exact sequence - do not skip steps:\n\n` +
    `STEP 1 - DAYS OPEN:\n` +
    `Say: "Hi ${barberName}! I am your Glō AI receptionist. I am going to ask you a few quick questions so I can start handling your calls right away. What days are you open for business?"\n` +
    `Listen for days mentioned. Map to: mon, tue, wed, thu, fri, sat, sun.\n` +
    `Mark days NOT mentioned as isClosed: true.\n\n` +
    `STEP 2 - OPEN TIME:\n` +
    `Ask: "What time do you open?"\n` +
    `Convert to 24-hour format HH:MM. Example: 9am = 09:00, 9:30am = 09:30.\n\n` +
    `STEP 3 - CLOSE TIME:\n` +
    `Ask: "And what time do you close?"\n` +
    `Convert to 24-hour format HH:MM.\n\n` +
    `STEP 4 - SERVICES AND PRICES:\n` +
    `Ask: "Now tell me your services and prices - just say them naturally, like haircut 30 dollars."\n` +
    `Extract each service name and price. Store as array of objects with name and price.\n\n` +
    `STEP 5 - APPOINTMENT DURATION:\n` +
    `Ask: "How long does each appointment take on average?"\n` +
    `Extract number of minutes.\n\n` +
    `STEP 6 - CONFIRM AND CLOSE:\n` +
    `Say: "Perfect ${barberName}! I now have everything I need. Starting now I will answer your calls, book appointments, and never let a client slip away. Let us get you live!"\n` +
    `Then output ONLY this JSON block with label SETUP_DATA:\n` +
    "```SETUP_DATA\n" +
    `{"days":["mon","tue","wed","thu","fri","sat"],"openTime":"09:00","closeTime":"19:00","services":[{"name":"Haircut","price":30},{"name":"Fade","price":35}],"durationMinutes":30}\n` +
    "```\n\n" +
    `IMPORTANT RULES:\n` +
    `- Be conversational and warm. Never robotic.\n` +
    `- If you cannot understand an answer, ask once more in a different way.\n` +
    `- Never invent information. Only save what the barber explicitly tells you.\n` +
    `- Always confirm what you heard before moving to the next step.\n` +
    `- Keep responses short - one question at a time.\n` +
    `- The SETUP_DATA JSON must always use English keys regardless of conversation language.\n`
  );
};

const buildAiStreamTwiml = ({ req, barberId, initialPrompt }) => {
  const wsUrl = getMediaWebsocketUrl(req);
  const response = new VoiceResponse();
  const connect = response.connect();
  const stream = connect.stream({
    url: wsUrl,
    track: "inbound_track",
  });

  stream.parameter({ name: "barberId", value: String(barberId) });
  stream.parameter({ name: "initialPrompt", value: initialPrompt });
  stream.parameter({ name: "from", value: req.body.From || "" });
  stream.parameter({ name: "to", value: req.body.To || "" });
  stream.parameter({ name: "callSid", value: req.body.CallSid || "" });

  return response;
};

const getAiStreamTwimlString = async ({ req, barberId, barberName }) => {
  let services = [];
  let businessHours = null;
  let timezone = "America/New_York";
  try {
    const barber = await Barber.findById(barberId).select("services availability");
    services = barber?.services || [];
    businessHours = barber?.availability?.businessHours || null;
    timezone = barber?.availability?.timezone || "America/New_York";
  } catch (e) {
    console.error("[PROMPT_BUILD] failed to fetch barber data:", e?.message);
  }

  const initialPrompt = buildInitialPrompt(barberName, { services, businessHours, timezone });
  return buildAiStreamTwiml({ req, barberId, initialPrompt }).toString();
};

export const handleIncomingCall = async (req, res) => {
  try {
    console.log("[INCOMING] Incoming Twilio Call (RAW):", req.body);

    const verificationResult = await maybeVerifyForwardingCall({
      to: req.body.To || req.body.Called || "",
      from: req.body.From || "",
      callSid: req.body.CallSid || "",
    });

    if (verificationResult === true) {
      const twiml = new VoiceResponse();
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    const verificationSessionActive = await isForwardingVerificationSessionActive({
      to: req.body.To || req.body.Called || "",
    });

    if (verificationSessionActive === true) {
      const twiml = new VoiceResponse();
      twiml.hangup();
      return res.type("text/xml").send(twiml.toString());
    }

    const called = req.body.Called || req.body.To;
    const cleanNumber = called ? called.trim() : null;

    console.log("[INCOMING] normalized called number:", cleanNumber);

    const barber = await Barber.findOne({ twilioNumber: cleanNumber });
    console.log("[ROUTING_FIXED]", {
      toNumber: cleanNumber,
      matchedBarber: barber?.name,
    });

    if (!barber) {
      console.log("[INCOMING] no barber found for number:", cleanNumber);
      const twiml = new VoiceResponse();
      twiml.say("Sorry, this number is not assigned.");
      return res.type("text/xml").send(twiml.toString());
    }

    const barberId = barber._id.toString();
    const callSid = req.body.CallSid || "";
    const from = req.body.From || "";
    const to = req.body.To || req.body.Called || "";
    const ringTimeoutSeconds = Number(process.env.RING_TIMEOUT_SECONDS || 12);
    const fallbackUrl = `${getBaseHttpsUrl(req)}/api/voice/dial-fallback`;

    setActiveCall({
      barberId,
      callSid,
      from,
      to,
      createdAt: Date.now(),
    });

    console.log("[INCOMING] matched barberId:", barberId);
    console.log("[INCOMING] dialing client identity:", barberId);
    console.log("[INCOMING] ring timeout:", ringTimeoutSeconds);

    const response = new VoiceResponse();
    const dial = response.dial({
      timeout: ringTimeoutSeconds,
      action: fallbackUrl,
      method: "POST",
    });
    dial.client(barberId);

    const twimlOutput = response.toString();
    console.log("[INCOMING] sending TwiML:\n", twimlOutput);

    return res.type("text/xml").send(twimlOutput);
  } catch (error) {
    console.error("Error in handleIncomingCall:", error);

    const fallback = new VoiceResponse();
    fallback.say("We are experiencing issues. Please try again later.");
    return res.type("text/xml").send(fallback.toString());
  }
};

export const handleDialFallback = async (req, res) => {
  try {
    const dialStatusRaw = req.body.DialCallStatus || "";
    const dialStatus = String(dialStatusRaw).toLowerCase();
    const callSid = req.body.CallSid || "";
    const to = req.body.To || "";
    const from = req.body.From || "";

    console.log("[DIAL_FALLBACK] HIT");
    console.log("[DIAL_FALLBACK] DialCallStatus:", dialStatusRaw);
    console.log("[DIAL_FALLBACK] CallSid:", callSid);
    console.log("[DIAL_FALLBACK] To/From:", { to, from });
    clearActiveCallBySid(callSid);

    const twiml = new VoiceResponse();
    if (dialStatus === "completed") {
      twiml.hangup();
      const twimlOutput = twiml.toString();
      console.log("[DIAL_FALLBACK] completed; hanging up. TwiML:\n", twimlOutput);
      return res.type("text/xml").send(twimlOutput);
    }

    const cleanNumber = to ? String(to).trim() : null;
    const barber = cleanNumber ? await Barber.findOne({ twilioNumber: cleanNumber }) : null;

    if (!barber) {
      twiml.say("Sorry, this number is not assigned.");
      const twimlOutput = twiml.toString();
      console.log("[DIAL_FALLBACK] no barber match; TwiML:\n", twimlOutput);
      return res.type("text/xml").send(twimlOutput);
    }

    const barberId = barber._id.toString();
    clearActiveCall(barberId);

    if (dialStatus === "no-answer") {
      if (!barber.expoPushToken) {
        console.log(`[PUSH_MISSED_CALL] skipped/no-token barberId=${barberId}`);
      } else {
        void (async () => {
          try {
            const pushPromise = sendExpoPush(
              barber.expoPushToken,
              "Missed call",
              `Missed call from ${from || "unknown number"}. AI handled it.`,
              {
                type: "MISSED_CALL",
                callSid,
                from: from || "",
                to: to || "",
                barberId,
              }
            );

            const timeoutPromise = new Promise((resolve) =>
              setTimeout(() => resolve({ ok: false, timeout: true }), 1500)
            );

            const result = await Promise.race([pushPromise, timeoutPromise]);
            if (result?.ok) {
              console.log(`[PUSH_MISSED_CALL] sent barberId=${barberId} callSid=${callSid}`);
            } else if (result?.timeout) {
              console.log(`[PUSH_MISSED_CALL] sent barberId=${barberId} callSid=${callSid} (timed)`);
            } else {
              console.log(`[PUSH_MISSED_CALL] error barberId=${barberId} callSid=${callSid}`);
            }
          } catch (err) {
            console.error(
              `[PUSH_MISSED_CALL] error barberId=${barberId} callSid=${callSid}`,
              err?.message || err
            );
          }
        })();
      }
    }

    const twimlOutput = await getAiStreamTwimlString({
      req,
      barberId,
      barberName: barber.name,
    });

    console.log(
      `[STREAM_META_TWIML] callSid=${req.body.CallSid || ""} from=${req.body.From || ""} to=${req.body.To || ""} barberId=${barberId}`
    );
    console.log("[DIAL_FALLBACK] falling back to AI stream");
    console.log("[DIAL_FALLBACK] TwiML:\n", twimlOutput);

    return res.type("text/xml").send(twimlOutput);
  } catch (error) {
    console.error("Error in handleDialFallback:", error);

    const fallback = new VoiceResponse();
    fallback.say("We are experiencing issues. Please try again later.");
    return res.type("text/xml").send(fallback.toString());
  }
};

export const handleAiTakeover = async (req, res) => {
  try {
    const barberId = req.user?.id || req.user?._id?.toString();
    if (!barberId) {
      return res.status(401).json({ error: "UNAUTHORIZED" });
    }

    const activeCall = getActiveCall(barberId);
    if (!activeCall) {
      return res.status(404).json({ error: "NO_ACTIVE_CALL" });
    }

    const barber = await Barber.findById(barberId).select("name");
    if (!barber) {
      return res.status(404).json({ error: "BARBER_NOT_FOUND" });
    }

    const twiml = await getAiStreamTwimlString({
      req,
      barberId: String(barberId),
      barberName: barber.name,
    });

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      return res.status(500).json({
        error: "TWILIO_CONFIG_MISSING",
        message: "Missing Twilio env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN",
      });
    }

    const client = twilio(accountSid, authToken);
    await client.calls(activeCall.callSid).update({ twiml });

    clearActiveCall(String(barberId));
    console.log(
      `[AI_TAKEOVER] barberId=${String(barberId)} callSid=${activeCall.callSid} redirected-to-ai`
    );

    return res.status(200).json({
      success: true,
      callSid: activeCall.callSid,
      redirectedTo: "ai",
    });
  } catch (error) {
    console.error("[AI_TAKEOVER] error:", error);
    return res.status(500).json({
      error: "AI_TAKEOVER_FAILED",
      message: error.message || "Failed to redirect call to AI.",
    });
  }
};

/*
Manual Test Plan (AI Takeover)
1. Place an inbound call to the Twilio number mapped to a barber.
2. Keep the mobile app open while the call is still ringing the client identity.
3. Trigger POST /api/voice/ai-takeover as that authenticated barber ("Let AI Handle").
4. Confirm AI media stream starts immediately (no waiting for Dial timeout).
5. Confirm server log includes:
   [AI_TAKEOVER] barberId=... callSid=... redirected-to-ai
*/
