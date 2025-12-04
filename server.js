// server.js
import express from "express";
import http from "http";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

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

// Twilio stream-status route
import callStreamStatusRoutes from "./routes/callStreamRoutes.js";

// Auth
import authRoutes from "./routes/authRoutes.js";
import profileRoutes from "./routes/profileRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

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

// Voicemail CRUD
import voiceRoutes from "./routes/voiceRoutes.js";

// ---------------------------------------------------------
// APP INITIALIZATION
// ---------------------------------------------------------
const app = express();
const server = http.createServer(app);

// JSON + FORM parsing
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: false }));

// CORS
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
// ROUTES (ORDER MATTERS — DO NOT CHANGE ORDER)
// ---------------------------------------------------------

// 1️⃣ Twilio incoming phone call → TwiML
app.use("/voice", voiceWebhook);

// 2️⃣ Twilio audio stream status callback
app.use("/api/calls", callStreamStatusRoutes);

// 3️⃣ Auth
app.use("/api/auth", authRoutes);

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
