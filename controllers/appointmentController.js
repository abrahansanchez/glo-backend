import Appointment from "../models/Appointment.js";

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
      date: { $gte: now },
      status: "confirmed",
    })
      .sort({ date: 1 })
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
      date: { $lt: now }
    })
      .sort({ date: -1 })
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

    const { clientName, clientPhone, date, time } = req.body;

    if (!clientName || !clientPhone || !date || !time) {
      return res.status(400).json({
        message: "clientName, clientPhone, date, and time are required",
      });
    }

    const appt = await Appointment.create({
      barberId,
      clientName,
      clientPhone,
      date: new Date(date),
      time,
      status: "confirmed",
      source: "manual",
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

    const appt = await Appointment.findOneAndUpdate(
      { _id: apptId, barberId },
      req.body,
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
