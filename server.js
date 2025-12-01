// server.js
import express from "express";
import http from "http";
import dotenv from "dotenv";
import cors from "cors";

// Load ENV FIRST (critical!)
dotenv.config();

import { attachMediaWebSocketServer } from "./realtime/mediaStreamServer.js";
import { getGlobalOpenAI } from "./utils/ai/globalOpenAI.js";
import connectDB from "./config/db.js";

import callRoutes from "./routes/callRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import numberRoutes from "./routes/numberRoutes.js";
import cancelRoutes from "./routes/cancelRoutes.js";
import profileRoutes from "./routes/profileRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import callStreamRoutes from "./routes/callStreamRoutes.js";
import aiRoutes from "./routes/aiRoutes.js";
import aiIntentRoutes from "./routes/aiIntentRoutes.js";
import aiConversationRoutes from "./routes/aiConversationRoutes.js";
import smsRoutes from "./routes/smsRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import voiceRoutes from "./routes/voiceRoutes.js";
import availabilityRoutes from "./routes/availabilityRoutes.js";
import appointment from "./routes/appointmentRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";

// ENV debug AFTER dotenv is loaded
console.log("NGROK_DOMAIN =", process.env.NGROK_DOMAIN);

// Connect DB
connectDB();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());
app.use(express.static("public"));

// Base route
app.get("/", (req, res) => {
  res.send("Glo Backend API Running");
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/calls", callStreamRoutes);
app.use("/api/calls", callRoutes);
app.use("/api/number", numberRoutes);
app.use("/api/cancel", cancelRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/ai", aiIntentRoutes);
app.use("/api/ai", aiConversationRoutes);
app.use("/api/sms", smsRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/voice", voiceRoutes);
app.use("/api/barber/availability", availabilityRoutes);
app.use("/api/appointments", appointment);
app.use("/api/analytics", analyticsRoutes);

// Create HTTP server
const server = http.createServer(app);

// Attach WebSocket media server
attachMediaWebSocketServer(server);

// 🚀 AFTER server is ready = now we pre-connect OpenAI
getGlobalOpenAI();

const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
