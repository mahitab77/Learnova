// src/routes/auth.routes.js
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";

import {
  registerStudent,
  registerTeacher,
  login,
  logout,
  requestPasswordReset,
  verifyPasswordReset,
  registerParentWithChildren,
  me, // ✅ NEW: Added me endpoint
} from "../controllers/auth.controller.js";
import { requireUser } from "../middlewares/auth.js";
import { generateCsrfToken } from "../middlewares/csrf.js";
import {
  loginRateLimit,
  registerRateLimit,
  requestResetRateLimit,
  verifyResetRateLimit,
} from "../middlewares/rateLimit.js";
import { validateRequest } from "../middlewares/requestValidation.js";
import {
  validateAuthLogin,
  validateAuthRegisterParent,
  validateAuthRegisterStudent,
  validateAuthRegisterTeacher,
  validateAuthRequestReset,
  validateAuthVerifyReset,
} from "../validation/highRiskMutations.js";

const router = express.Router();

/**
 * -----------------------------------------------------------------------------
 * Uploads: Teacher videos
 * -----------------------------------------------------------------------------
 * - Stored under /uploads/teacher-videos
 * - Accepts up to 3 video files
 * - Notes:
 *   - We validate both MIME and extension (basic hardening).
 *   - We return clean JSON errors for Multer failures.
 *   - We also do best-effort cleanup of already-uploaded files when an error happens.
 */

//const uploadDir = path.join(process.cwd(), "uploads", "teacher-videos");
//fs.mkdirSync(uploadDir, { recursive: true });

const uploadBaseDir = process.env.VERCEL
  ? "/tmp/uploads"
  : path.resolve("uploads");

const uploadDir = path.join(uploadBaseDir, "teacher-videos");
fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_VIDEO_MIME = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime", // .mov
  "video/x-matroska", // .mkv (sometimes)
]);

const ALLOWED_VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".mkv"]);

function safeBaseName(originalName) {
  const original = String(originalName || "video");
  // Remove path separators, trim weird chars, normalize spaces
  const cleaned = original
    .replace(/[\\/]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "");

  // Keep it from becoming empty
  return cleaned.length ? cleaned : "video";
}

function cleanupUploadedFiles(req) {
  try {
    const files = req?.files;
    if (!Array.isArray(files) || files.length === 0) return;
    for (const f of files) {
      if (f?.path) {
        try {
          fs.unlinkSync(f.path);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = safeBaseName(file.originalname);
    const ext = (path.extname(safe) || ".mp4").toLowerCase();
    const base = path.basename(safe, ext) || "video";
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    files: 3,
    fileSize: 80 * 1024 * 1024, // 80MB each
  },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || "").toLowerCase();
    const ext = String(path.extname(file.originalname || "")).toLowerCase();

    const mimeOk = ALLOWED_VIDEO_MIME.has(mime);
    const extOk = ALLOWED_VIDEO_EXT.has(ext);

    if (!mimeOk || !extOk) {
      const err = new Error("Only video files are allowed (mp4, webm, mov, mkv).");
      // add a stable code so frontend can react
      err.code = "INVALID_FILE_TYPE";
      return cb(err);
    }

    return cb(null, true);
  },
});

/**
 * Wrap multer to surface clean JSON errors instead of generic HTML/errors.
 * Also removes any files already written in this request if upload fails.
 */
const uploadTeacherVideos = (req, res, next) => {
  upload.array("videos", 3)(req, res, (err) => {
    if (!err) return next();

    // If Multer already wrote some files before error, remove them
    cleanupUploadedFiles(req);

    if (err instanceof multer.MulterError) {
      const code = err.code || "MULTER_ERROR";
      return res.status(400).json({
        success: false,
        source: "auth.routes.upload",
        code,
        message:
          code === "LIMIT_FILE_SIZE"
            ? "One of the videos is too large (max 80MB)."
            : code === "LIMIT_FILE_COUNT"
            ? "Too many video files (max 3)."
            : code === "LIMIT_UNEXPECTED_FILE"
            ? "Unexpected file field name. Use videos[]."
            : "File upload error.",
        details: err.message,
      });
    }

    return res.status(400).json({
      success: false,
      source: "auth.routes.upload",
      code: err.code || "UPLOAD_ERROR",
      message: err.message || "Upload failed.",
    });
  });
};

/**
 * Validate multipart teacher payload after Multer parsing.
 * If validation fails after files are written, remove uploaded files.
 */
const validateTeacherRegisterMultipart = (req, res, next) => {
  const result = validateAuthRegisterTeacher({
    body: req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {},
    params: req.params && typeof req.params === "object" ? req.params : {},
    query: req.query && typeof req.query === "object" ? req.query : {},
  });

  const errors = (Array.isArray(result?.errors) ? result.errors : [])
    .filter(Boolean)
    .map((entry) => (typeof entry === "string" ? { field: "body", message: entry } : entry));

  if (errors.length > 0) {
    cleanupUploadedFiles(req);
    return res.status(400).json({
      success: false,
      code: "VALIDATION_ERROR",
      message: "Request validation failed.",
      errors,
    });
  }

  return next();
};

/**
 * -----------------------------------------------------------------------------
 * Auth routes (SESSION-COOKIE BASED)
 * -----------------------------------------------------------------------------
 * ✅ All registration endpoints now auto-login (create session)
 * ✅ Password reset endpoints work within session system but don't auto-login
 * ✅ Frontend must send credentials: "include" for cookies
 * 
 * Behavior matrix:
 * | Endpoint                   | Creates Session | Notes                                |
 * |----------------------------|-----------------|--------------------------------------|
 * | POST /register-student     | ✅ YES          | Auto-login as student                |
 * | POST /register-teacher     | ✅ YES          | Auto-login as teacher (pending)      |
 * | POST /register-parent      | ✅ YES          | Auto-login as parent                 |
 * | POST /login                | ✅ YES          | Standard login                       |
 * | POST /logout               | ❌ NO           | Destroys session                     |
 * | POST /request-reset        | ❌ NO           | Public endpoint                      |
 * | POST /verify-reset         | ❌ NO           | No auto-login (clean security)       |
 * | GET /me                    | ❌ NO           | Returns current session user         |
 */

// ✅ Registration endpoints (all auto-login)
router.post("/register-student", registerRateLimit, validateRequest(validateAuthRegisterStudent), registerStudent);
router.post(
  "/register-teacher",
  registerRateLimit,
  uploadTeacherVideos,
  validateTeacherRegisterMultipart,
  registerTeacher
);
router.post(
  "/register-parent-with-children",
  registerRateLimit,
  validateRequest(validateAuthRegisterParent),
  registerParentWithChildren
);

// ✅ Login/Logout (session management)
router.post("/login", loginRateLimit, validateRequest(validateAuthLogin), login);
router.post("/logout", logout);

// ✅ Password reset (no auto-login)
router.post(
  "/request-reset",
  requestResetRateLimit,
  validateRequest(validateAuthRequestReset),
  requestPasswordReset
);
router.post(
  "/verify-reset",
  verifyResetRateLimit,
  validateRequest(validateAuthVerifyReset),
  verifyPasswordReset
);

// ✅ NEW: Session check endpoint (replaces debug route)
router.get("/me", me);

/**
 * GET /auth/csrf-token
 * Returns (or re-uses) the CSRF token for the current authenticated session.
 * Frontend must call this once after login and cache the result for the session.
 * Unauthenticated callers get 401 from requireUser.
 */
router.get("/csrf-token", requireUser, (req, res) => {
  const token = generateCsrfToken(req);
  return res.json({ success: true, csrfToken: token });
});

export default router;
