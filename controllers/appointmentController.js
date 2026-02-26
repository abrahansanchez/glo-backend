import Appointment from "../models/Appointment.js";

const oneHourMs = 60 * 60 * 1000;

const parseIsoDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const normalizeStatus = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "cancelled") return "canceled";
  if (raw === "confirm") return "confirmed";
  if (raw === "reschedule") return "rescheduled";
  return raw;
};

const normalizeSource = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "ai voice" || raw === "ai") return "ai";
  if (raw === "manual" || raw === "mobile") return "manual";
  return "manual";
};

const rangeFieldQuery = (start, end) => ({
  $or: [
    { startAt: { $gte: start, $lte: end } },
    {
      startAt: { $exists: false },
      date: { $gte: start, $lte: end },
    },
  ],
});

/** ---------------- UPCOMING ---------------- **/
export const getUpcomingAppointments = async (req, res) => {
  try {
    const barberId = req.user?._id;

    if (!barberId) {
      return res.status(401).json({ message: "Unauthorized: No barber on token" });
    }

    const now = new Date();

    const appointments = await Appointment.find({
      barberId,
      status: "confirmed",
      $or: [
        { startAt: { $gte: now } },
        {
          startAt: { $exists: false },
          date: { $gte: now },
        },
      ],
    })
      .sort({ startAt: 1, date: 1 })
      .lean();

    return res.json({ appointments });
  } catch (err) {
    console.error("getUpcomingAppointments error:", err);
    res.status(500).json({ message: "Failed to fetch upcoming appointments" });
  }
};

/** ---------------- PAST ---------------- **/
export const getPastAppointments = async (req, res) => {
  try {
    const barberId = req.user?._id;

    if (!barberId) {
      return res.status(401).json({ message: "Unauthorized: No barber on token" });
    }

    const now = new Date();

    const appointments = await Appointment.find({
      barberId,
      $or: [
        { startAt: { $lt: now } },
        {
          startAt: { $exists: false },
          date: { $lt: now },
        },
      ],
    })
      .sort({ startAt: -1, date: -1 })
      .lean();

    return res.json({ appointments });
  } catch (err) {
    console.error("getPastAppointments error:", err);
    res.status(500).json({ message: "Failed to fetch past appointments" });
  }
};

/** ---------------- CREATE ---------------- **/
export const createAppointment = async (req, res) => {
  try {
    const barberId = req.user?._id;

    if (!barberId) {
      return res.status(401).json({ message: "Unauthorized: No barber on token" });
    }

    const { clientName, clientPhone, date, time, startAt, endAt, service, status, source } = req.body;

    if (!clientName || !clientPhone || (!date && !startAt)) {
      return res.status(400).json({
        message: "clientName, clientPhone, and date/startAt are required",
      });
    }

    const combinedDateTime = date && time ? `${date} ${time}` : null;
    const resolvedStart =
      parseIsoDate(startAt) || parseIsoDate(combinedDateTime) || parseIsoDate(date);
    if (!resolvedStart) {
      return res.status(400).json({ message: "Invalid date/startAt" });
    }

    const resolvedEnd = parseIsoDate(endAt) || new Date(resolvedStart.getTime() + oneHourMs);

    const appt = await Appointment.create({
      barberId,
      clientName,
      clientPhone,
      service,
      date: resolvedStart,
      time: time || "",
      startAt: resolvedStart,
      endAt: resolvedEnd,
      status: status || "confirmed",
      source: source || "manual",
    });

    return res.status(201).json({
      message: "Appointment created",
      appointment: appt,
    });
  } catch (err) {
    console.error("createAppointment error:", err);
    res.status(500).json({ message: "Failed to create appointment" });
  }
};

/** ---------------- UPDATE ---------------- **/
export const updateAppointment = async (req, res) => {
  try {
    const barberId = req.user?._id;
    const apptId = req.params.id;

    if (!barberId) {
      return res.status(401).json({ message: "Unauthorized: No barber on token" });
    }

    const update = { ...req.body };
    if (Object.prototype.hasOwnProperty.call(update, "status")) {
      update.status = normalizeStatus(update.status);
    }
    if (Object.prototype.hasOwnProperty.call(update, "source")) {
      update.source = normalizeSource(update.source);
    }
    if (Object.prototype.hasOwnProperty.call(update, "startAt")) {
      const parsedStart = parseIsoDate(update.startAt);
      if (!parsedStart) {
        return res.status(400).json({ message: "Invalid startAt" });
      }
      update.startAt = parsedStart;
      update.date = parsedStart;
      if (!Object.prototype.hasOwnProperty.call(update, "endAt")) {
        update.endAt = new Date(parsedStart.getTime() + oneHourMs);
      }
    }
    if (Object.prototype.hasOwnProperty.call(update, "endAt")) {
      const parsedEnd = parseIsoDate(update.endAt);
      if (!parsedEnd) {
        return res.status(400).json({ message: "Invalid endAt" });
      }
      update.endAt = parsedEnd;
    }

    const appt = await Appointment.findOneAndUpdate(
      { _id: apptId, barberId },
      update,
      { new: true }
    );

    if (!appt) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    return res.json({
      message: "Appointment updated",
      appointment: appt,
    });
  } catch (err) {
    console.error("updateAppointment error:", err);
    res.status(500).json({ message: "Failed to update appointment" });
  }
};

/** ---------------- DELETE ---------------- **/
export const deleteAppointment = async (req, res) => {
  try {
    const barberId = req.user?._id;
    const apptId = req.params.id;

    if (!barberId) {
      return res.status(401).json({ message: "Unauthorized: No barber on token" });
    }

    const appt = await Appointment.findOneAndDelete({
      _id: apptId,
      barberId,
    });

    if (!appt) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    return res.json({ message: "Appointment deleted" });
  } catch (err) {
    console.error("deleteAppointment error:", err);
    res.status(500).json({ message: "Failed to delete appointment" });
  }
};

/** ---------------- RANGE ---------------- **/
export const getAppointmentsRange = async (req, res) => {
  try {
    const barberId = req.user?._id;
    if (!barberId) {
      return res.status(401).json({ message: "Unauthorized: No barber on token" });
    }

    const start = parseIsoDate(req.query.start);
    const end = parseIsoDate(req.query.end);

    if (!start || !end) {
      return res.status(400).json({ message: "Query params start and end must be valid ISO dates" });
    }
    if (start >= end) {
      return res.status(400).json({ message: "start must be before end" });
    }

    const appointments = await Appointment.find({
      barberId,
      ...rangeFieldQuery(start, end),
    })
      .sort({ startAt: 1, date: 1 })
      .lean();

    console.log(
      `[APPT_RANGE] barberId=${String(barberId)} start=${start.toISOString()} end=${end.toISOString()} count=${appointments.length}`
    );

    return res.json({
      start: start.toISOString(),
      end: end.toISOString(),
      count: appointments.length,
      appointments,
    });
  } catch (err) {
    console.error("getAppointmentsRange error:", err);
    return res.status(500).json({ message: "Failed to fetch appointments by range" });
  }
};
