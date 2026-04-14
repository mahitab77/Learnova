import rateLimit from "express-rate-limit";

function intFromEnv(name, fallback) {
  const parsed = Number.parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createJsonLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) =>
      res.status(429).json({
        success: false,
        code: "RATE_LIMITED",
        message,
      }),
  });
}

export const loginRateLimit = createJsonLimiter({
  windowMs: intFromEnv("AUTH_LOGIN_RATE_WINDOW_MS", 15 * 60 * 1000),
  max: intFromEnv("AUTH_LOGIN_RATE_MAX", 10),
  message: "Too many login attempts. Please wait and try again.",
});

export const requestResetRateLimit = createJsonLimiter({
  windowMs: intFromEnv("AUTH_REQUEST_RESET_RATE_WINDOW_MS", 15 * 60 * 1000),
  max: intFromEnv("AUTH_REQUEST_RESET_RATE_MAX", 5),
  message: "Too many password reset requests. Please wait and try again.",
});

export const verifyResetRateLimit = createJsonLimiter({
  windowMs: intFromEnv("AUTH_VERIFY_RESET_RATE_WINDOW_MS", 15 * 60 * 1000),
  max: intFromEnv("AUTH_VERIFY_RESET_RATE_MAX", 10),
  message: "Too many reset verification attempts. Please wait and try again.",
});

export const registerRateLimit = createJsonLimiter({
  windowMs: intFromEnv("AUTH_REGISTER_RATE_WINDOW_MS", 60 * 60 * 1000),
  max: intFromEnv("AUTH_REGISTER_RATE_MAX", 20),
  message: "Too many registration attempts. Please wait and try again.",
});

export const ratingSubmitRateLimit = createJsonLimiter({
  windowMs: intFromEnv("RATING_SUBMIT_RATE_WINDOW_MS", 15 * 60 * 1000),
  max: intFromEnv("RATING_SUBMIT_RATE_MAX", 20),
  message: "Too many rating submissions. Please wait and try again.",
});
