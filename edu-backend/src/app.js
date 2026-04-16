// src/app.js
/**
 * Learnova Backend - Production-Ready Express App
 * -----------------------------------------------------------------------------
 * What this file does:
 *  1) Loads env + computes runtime flags (dev/prod + cross-site cookies)
 *  2) Configures CORS correctly for cookie-based sessions (credentials: true)
 *  3) Enables robust body parsing (JSON + URL-encoded)
 *  4) Sets up express-session using ONE source of truth: src/config/session.js
 *  5) Mounts all routes with consistent base paths
 *  6) Serves uploads statically
 *  7) Adds safe 404 + error handlers for clean debugging and production stability
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import session from "express-session";

// Routes
import authRoutes from "./routes/auth.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import subjectRoutes from "./routes/subject.routes.js";
import teacherRoutes from "./routes/teacher.routes.js";
import studentRoutes from "./routes/student.routes.js";
import parentRoutes from "./routes/parent.routes.js";
import metaRoutes from "./routes/meta.routes.js";
import moderatorRoutes from "./routes/moderator.routes.js";
import meetingRoutes from "./routes/meeting.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import { checkCriticalSchemaInvariants, checkDbReadiness } from "./db.js";

// Centralized session config
import { SESSION_CONFIG } from "./config/session.js";
import { requireCsrf } from "./middlewares/csrf.js";
import {
  errorResponseTraceMiddleware,
  requestIdMiddleware,
  requestScopedLogger,
  toStructuredError,
} from "./utils/observability.js";

dotenv.config();

const app = express();

/* -------------------------------------------------------------------------- */
/* Environment flags                                                          */
/* -------------------------------------------------------------------------- */
const NODE_ENV = process.env.NODE_ENV || "development";
const isProd = NODE_ENV === "production";

if (isProd) {
  app.set("trust proxy", 1);
}

/* -------------------------------------------------------------------------- */
/* CORS                                                                       */
/* -------------------------------------------------------------------------- */
const FRONTEND_ORIGINS = (process.env.FRONTEND_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!FRONTEND_ORIGINS.length) {
  console.warn("[app] WARNING: FRONTEND_ORIGINS is empty. CORS may block requests.");
}

app.use(
  cors({
    origin: FRONTEND_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Accept",
      "Authorization",
      "X-Requested-With",
      "X-CSRF-Token",
    ],
  })
);

/* -------------------------------------------------------------------------- */
/* Body parsing                                                               */
/* -------------------------------------------------------------------------- */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(requestIdMiddleware);
app.use(requestScopedLogger);
app.use(errorResponseTraceMiddleware);

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */
app.use(session(SESSION_CONFIG));

app.use((req, _res, next) => {
  if (!req.user) {
    const u = req.session?.user || null;
    if (u?.id) {
      req.user = {
        id: u.id,
        full_name: u.full_name || "",
        fullName: u.full_name || "",
        email: u.email ?? null,
        role: typeof u.role === "string" ? u.role.toLowerCase() : u.role,
      };
    } else {
      req.user = null;
    }
  }

  req.switchCtx = req.session?.switch_ctx || null;
  next();
});

/* -------------------------------------------------------------------------- */
/* CSRF protection                                                            */
/* -------------------------------------------------------------------------- */
app.use(requireCsrf);

/* -------------------------------------------------------------------------- */
/* Health / readiness / root                                                  */
/* -------------------------------------------------------------------------- */
app.get("/health", (_req, res) => {
  return res.json({
    status: "ok",
    message: "Backend is running",
    env: NODE_ENV,
    time: new Date().toISOString(),
  });
});

app.get("/ready", async (_req, res) => {
  const dbReady = await checkDbReadiness();
  if (!dbReady) {
    return res.status(503).json({
      status: "not_ready",
      checks: { db: "down" },
      time: new Date().toISOString(),
    });
  }

  const schemaInvariantsReady = await checkCriticalSchemaInvariants();
  if (!schemaInvariantsReady) {
    return res.status(503).json({
      status: "not_ready",
      checks: {
        db: "up",
        schema_invariants: "missing",
      },
      time: new Date().toISOString(),
    });
  }

  return res.json({
    status: "ready",
    checks: {
      db: "up",
      schema_invariants: "ok",
    },
    time: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  return res.status(200).json({
    success: true,
    message: "Learnova backend is running",
  });
});

/* -------------------------------------------------------------------------- */
/* Routes                                                                     */
/* -------------------------------------------------------------------------- */
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.use("/subjects", subjectRoutes);
app.use("/teacher", teacherRoutes);
app.use("/student", studentRoutes);
app.use("/parent", parentRoutes);
app.use("/meta", metaRoutes);
app.use("/moderator", moderatorRoutes);
app.use("/meeting", meetingRoutes);
app.use("/payment", paymentRoutes);

/* -------------------------------------------------------------------------- */
/* Static files                                                               */
/* -------------------------------------------------------------------------- */
const staticUploadsDir = process.env.VERCEL
  ? "/tmp/uploads"
  : path.resolve("uploads");

app.use("/uploads", express.static(staticUploadsDir));

/* -------------------------------------------------------------------------- */
/* 404 handler                                                                */
/* -------------------------------------------------------------------------- */
app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "Route not found.",
    method: req.method,
    path: req.path,
  });
});

/* -------------------------------------------------------------------------- */
/* Error handler                                                              */
/* -------------------------------------------------------------------------- */
app.use((err, req, res, _next) => {
  const error = toStructuredError(err);

  if (req?.log?.error) {
    req.log.error("app.unhandled_error", { error });
  } else {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "app.unhandled_error",
        requestId: req?.requestId ?? null,
        method: req?.method,
        path: req?.path,
        error,
      })
    );
  }

  return res.status(500).json({
    success: false,
    message: "Internal server error.",
    ...(NODE_ENV !== "production" && { details: String(err?.message || err) }),
  });
});

export default app;