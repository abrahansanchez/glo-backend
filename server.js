// server.js
// ⚠️ dotenv MUST load before ANY other imports (ESM requirement)
import "dotenv/config";

import express from "express";
import http from "http";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------
// DATABASE
// ---------------------------------------------------------
import connectDB from "./config/db.js";
connectDB();

// ---------------------------------------------------------
// REALTIME TWILIO MEDIA STREAM SERVER
// ---------------------------------------------------------
import { attachMediaWebSocketServer } from "./realtime/mediaStreamServer.js";

// ---------------------------------------------------------
// ROUTES
// ---------------------------------------------------------

// Twilio inbound call webhook → RETURNS TWIML
import voiceWebhook from "./routes/voiceWebhook.js";

// 🔔 STRIPE WEBHOOK (RAW BODY REQUIRED)
import stripeWebhookRoutes from "./routes/stripeWebhookRoutes.js";

// Twilio stream-status route
import callStreamStatusRoutes from "./routes/callStreamRoutes.js";

// Auth
import authRoutes from "./routes/authRoutes.js";
import profileRoutes from "./routes/profileRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import voiceTokenRoutes from "./routes/voiceTokenRoutes.js";
import twilioClientVoiceRoutes from "./routes/twilioClientVoiceRoutes.js";
import debugRoutes from "./routes/debugRoutes.js";
import debugCallRoutes from "./routes/debugCallRoutes.js";
import qaRoutes from "./routes/qaRoutes.js";

// Phone number lifecycle
import numberRoutes from "./routes/numberRoutes.js";
import cancelRoutes from "./routes/cancelRoutes.js";

// AI
import aiIntentRoutes from "./routes/aiIntentRoutes.js";
import aiConversationRoutes from "./routes/aiConversationRoutes.js";

// SMS
import smsRoutes from "./routes/smsRoutes.js";

// Business logic
import dashboardRoutes from "./routes/dashboardRoutes.js";
import availabilityRoutes from "./routes/availabilityRoutes.js";
import appointmentRoutes from "./routes/appointmentRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";

// Billing
import billingRoutes from "./routes/billingRoutes.js";

// Voicemail CRUD
import voiceRoutes from "./routes/voiceRoutes.js";

// ---------------------------------------------------------
// APP INITIALIZATION
// ---------------------------------------------------------
const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------
// ⚠️ STRIPE WEBHOOK RAW BODY (MUST BE BEFORE express.json)
// ---------------------------------------------------------
app.use(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" })
);

// Mount Stripe webhook router
app.use("/api/stripe", stripeWebhookRoutes);
// ---------------------------------------------------------
// JSON + FORM parsing (AFTER Stripe raw body)
// ---------------------------------------------------------
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: false }));

// ---------------------------------------------------------
// CORS
// ---------------------------------------------------------
app.use(cors());

// ---------------------------------------------------------
// STATIC FILES
// ---------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "/public")));

// ---------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------
app.get("/", (req, res) => {
  res.send("🚀 Glō Backend API Running");
});

// ---------------------------------------------------------
// ROUTES (ORDER MATTERS — DO NOT CHANGE)
// ---------------------------------------------------------

// 1️⃣ Twilio incoming phone call → TwiML
app.use("/voice", voiceWebhook);
app.use("/api/voice", voiceWebhook);

// 2️⃣ Twilio audio stream status callback
app.use("/api/calls", callStreamStatusRoutes);

// 3️⃣ Auth
app.use("/api/auth", authRoutes);

// 💳 Billing / Stripe Checkout
app.use("/api/billing", billingRoutes);

// 4️⃣ Phone number lifecycle
app.use("/api/number", numberRoutes);

// 5️⃣ Cancel subscription
app.use("/api/cancel", cancelRoutes);

// 6️⃣ Profile + Admin
app.use("/api/profile", profileRoutes);
app.use("/api/admin", adminRoutes);

// 7️⃣ AI Logic
app.use("/api/ai", aiIntentRoutes);
app.use("/api/ai", aiConversationRoutes);

// 8️⃣ SMS Inbound/Outbound
app.use("/api/sms", smsRoutes);

// 9️⃣ Dashboard backend
app.use("/api/dashboard", dashboardRoutes);

// 🔟 Availability settings
app.use("/api/barber/availability", availabilityRoutes);

// 1️⃣1️⃣ Appointments
app.use("/api/appointments", appointmentRoutes);

// 1️⃣2️⃣ Analytics
app.use("/api/analytics", analyticsRoutes);

// 1️⃣3️⃣ Voicemail API
app.use("/api/voicemail", voiceRoutes);

app.use("/api/voice", twilioClientVoiceRoutes);
app.use("/api/voice", voiceTokenRoutes);
console.log("[ROUTES] mounting debug call-me");
app.use("/api/debug", debugCallRoutes);

// Debug routes (controlled by explicit env flag)
const enableDebug = process.env.ENABLE_DEBUG_ROUTES === "true";
if (enableDebug) {
  app.use("/api/debug", debugRoutes);
}

const enableQaRoutes = process.env.ENABLE_QA_ROUTES === "true";
if (enableQaRoutes) {
  app.use("/api/qa", qaRoutes);
}


// ---------------------------------------------------------
// ATTACH TWILIO MEDIA STREAM WEBSOCKET SERVER
// ---------------------------------------------------------
attachMediaWebSocketServer(server);

// ---------------------------------------------------------
// SERVER START
// ---------------------------------------------------------
const PORT = process.env.PORT || 5000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Glō Backend running on port ${PORT}`);
  console.log(`🎧 Media Stream WS active at /ws/media`);
});

