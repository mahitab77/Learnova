// src/utils/email.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const isProd = process.env.NODE_ENV === "production";

const hasEmailConfig =
  Boolean(process.env.EMAIL_HOST) &&
  Boolean(process.env.EMAIL_PORT) &&
  Boolean(process.env.EMAIL_USER) &&
  Boolean(process.env.EMAIL_PASS) &&
  Boolean(process.env.EMAIL_FROM);

let transporter = null;

if (hasEmailConfig) {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: Number(process.env.EMAIL_PORT) === 465,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
} else {
  const message =
    "EMAIL_* env vars are not fully configured. Email sending is disabled.";
  console.warn(`⚠️ [email] ${message}`);
}

/**
 * Optional helper so routes/controllers can check availability
 */
export function isEmailConfigured() {
  return hasEmailConfig;
}

/**
 * Send OTP email
 */
export async function sendOtpEmail(to, otp, name = "") {
  const subject = "Your OTP code";
  const text = `Hello ${name || ""}, your OTP code is: ${otp}`;

  if (!transporter) {
    if (isProd) {
      throw new Error(
        "Email service is not configured. OTP email cannot be sent."
      );
    }

    console.log("📧 (DEV) OTP email to:", to, "code:", otp);
    return;
  }

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    text,
  });
}