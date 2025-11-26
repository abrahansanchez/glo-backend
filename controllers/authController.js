import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Barber from "../models/Barber.js";
import { assignPhoneNumber } from "../utils/assignPhoneNumber.js";

// REGISTER BARBER
export const registerBarber = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    // Check if barber already exists
    const existing = await Barber.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: "Barber already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new barber
    const barber = new Barber({
      name,
      email,
      phone,
      password: hashedPassword,
    });

    await barber.save();
    
    //Automatically assign Twilio number (mock or real)
    try {
      await assignPhoneNumber(barber._id);
      console.log(`Assigned number to new barber: ${barber.email}`);
    } catch (err) {
      console.error("Failed to assign number at signup:", err.message);
    }

    res.status(201).json({ message: "Barber registered successfully" });
  } catch (error) {
    console.error("Register Error:", error);
    res.status(500).json({ message: "Server error during registration" });
  }
};

// LOGIN BARBER
export const loginBarber = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find barber
    const barber = await Barber.findOne({ email });
    if (!barber) {
      return res.status(400).json({ message: "Barber not found" });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, barber.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // Create JWT
    const token = jwt.sign(
      { id: barber._id },
      process.env.JWT_SECRET || "default_secret",
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login successful",
      token,
      barber: {
        id: barber._id,
        name: barber.name,
        email: barber.email,
        phone: barber.phone,
        aiMode: barber.aiMode,
        twilioNumber: barber.twilioNumber,
      },
    });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ message: "Server error during login" });
  }
};
