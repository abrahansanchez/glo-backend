// server.js
import express from "express";
import http from "http";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

import connectDB from "./config/db.js";
import { attachMediaWebSocketServer } from "./realtime/mediaStreamServer.js";

// ROUTES
import callRoutes from "./routes/callRoutes.js";
import callStreamRoutes from "./routes/callStreamRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import numberRoutes from "./routes/numberRoutes.js";
import cancelRoutes from "./routes/cancelRoutes.js";
import profileRoutes from "./routes/profileRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import aiRoutes from "./routes/aiRoutes.js";
import aiIntentRoutes from "./routes/aiIntentRoutes.js";
import aiConversationRoutes from "./routes/aiConversationRoutes.js";
import smsRoutes from "./routes/smsRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import voiceRoutes from "./routes/voiceRoutes.js";
import availabilityRoutes from "./routes/availabilityRoutes.js";
import appointmentRoutes from "./routes/appointmentRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";

// Connect DB
connectDB();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.send("GLO Backend API Running");
});

// API Routes
app.use("/api/calls", callStreamRoutes);
app.use("/api/calls", callRoutes);
app.use("/api/auth", authRoutes);
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
app.use("/api/appointments", appointmentRoutes);
app.use("/api/analytics", analyticsRoutes);

const server = http.createServer(app);

attachMediaWebSocketServer(server);

const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 GLO Backend running on port ${PORT}`);
});
