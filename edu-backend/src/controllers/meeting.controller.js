// src/controllers/meeting.controller.js
// ============================================================================
// MEETING CONTROLLER
// ----------------------------------------------------------------------------
// Responsibilities:
//  1. Generate a Zoom Meeting SDK JWT signature for Component View embedding
//  2. Provide a shared helper for any role to fetch session meeting info
// ============================================================================

import crypto from "crypto";
import pool from "../db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function badRequest(res, msg) {
  return res.status(400).json({ success: false, message: msg });
}

function notFound(res, msg = "Not found.") {
  return res.status(404).json({ success: false, message: msg });
}

function forbidden(res) {
  // Deliberate generic message: do not hint whether the session exists or the
  // user simply lacks permission — both look the same to the caller.
  return res.status(403).json({ success: false, message: "Access denied." });
}

function serverError(res) {
  return res.status(500).json({ success: false, message: "Server error." });
}

/**
 * Extract the 11-char YouTube video ID from any supported URL format, or
 * return a bare ID unchanged.
 * Supported: youtu.be/ID, youtube.com/watch?v=ID, youtube.com/embed/ID, shorts/ID
 * Returns null if the value is not recognisable.
 */
export function extractYouTubeId(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  // Try extracting from URL patterns
  const match = s.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/))([A-Za-z0-9_-]{11})/
  );
  if (match) return match[1];

  // Accept a bare 11-character video ID
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;

  return null;
}

// ---------------------------------------------------------------------------
// GET /meeting/sessions/:sessionId/zoom-signature
// ---------------------------------------------------------------------------
// Only participants of the specific lesson session may obtain a signature:
//   - teacher whose teachers.id === lesson_sessions.teacher_id  (host role)
//   - student whose students.id === lesson_sessions.student_id  (attendee)
//   - parent linked via parent_students to that student          (attendee)
//   - admin role (attendee, observer)
// All other authenticated users receive 403.
// Session existence is never confirmed to unauthorized callers (always 403,
// never 404) to prevent session-ID enumeration.
// ---------------------------------------------------------------------------

export async function generateZoomSignature(req, res) {
  const sessionId = parseInt(req.params.sessionId, 10);
  if (!sessionId || sessionId <= 0) return badRequest(res, "Invalid sessionId.");

  const sdkKey    = process.env.ZOOM_SDK_KEY;
  const sdkSecret = process.env.ZOOM_SDK_SECRET;

  if (!sdkKey || !sdkSecret) {
    return res.status(500).json({
      success: false,
      message: "Zoom SDK credentials are not configured on the server.",
    });
  }

  // requireSessionUser guarantees a populated req.user, but be defensive.
  const userId = req.session?.user?.id ?? req.user?.id ?? null;
  if (!userId) {
    return res.status(401).json({ success: false, message: "Authentication required." });
  }
  const userRole = String(req.user?.role || "").toLowerCase();

  try {
    // -----------------------------------------------------------------------
    // 1. Load the session — only columns needed for auth + signature.
    //    On miss: return 403, not 404. Returning 404 would let unauthenticated
    //    callers distinguish "session does not exist" from "access denied",
    //    enabling session-ID enumeration via status-code oracle.
    // -----------------------------------------------------------------------
    const [[session]] = await pool.query(
      `SELECT id, teacher_id, student_id, zoom_meeting_id, zoom_password
       FROM lesson_sessions
       WHERE id = ?
       LIMIT 1`,
      [sessionId]
    );

    if (!session) return forbidden(res);

    // -----------------------------------------------------------------------
    // 2. Participation-based authorization.
    //    Every branch verifies ownership against the DB — session cookie meta
    //    is used only for identity (userId/userRole), not for capability.
    // -----------------------------------------------------------------------
    let authorized = false;
    let isHost     = false;

    if (userRole === "admin") {
      // Admins may observe any session as attendees.
      authorized = true;

    } else if (userRole === "teacher") {
      // Confirm this user's teacher record matches the session owner in DB.
      const [[teacherRow]] = await pool.query(
        `SELECT id
         FROM teachers
         WHERE user_id  = ?
           AND id       = ?
           AND is_active = 1
           AND status    = 'approved'
         LIMIT 1`,
        [userId, session.teacher_id]
      );
      if (teacherRow) {
        authorized = true;
        isHost     = true; // only the owning teacher gets Zoom host role
      }

    } else if (userRole === "student") {
      // lesson_sessions.student_id is students.id; verify the caller owns it.
      const [[studentRow]] = await pool.query(
        `SELECT id
         FROM students
         WHERE user_id = ?
           AND id      = ?
         LIMIT 1`,
        [userId, session.student_id]
      );
      if (studentRow) authorized = true;

    } else if (userRole === "parent") {
      // A parent may join if they are linked to the session's student:
      //   parents.user_id → parents.id → parent_students.parent_id
      //                               → parent_students.student_id == session.student_id
      const [[parentRow]] = await pool.query(
        `SELECT ps.id
         FROM parent_students ps
         JOIN parents p ON p.id = ps.parent_id
         WHERE p.user_id     = ?
           AND ps.student_id = ?
         LIMIT 1`,
        [userId, session.student_id]
      );
      if (parentRow) authorized = true;
    }

    if (!authorized) return forbidden(res);

    // -----------------------------------------------------------------------
    // 3. Post-auth content check — safe to surface to authorized callers.
    // -----------------------------------------------------------------------
    if (!session.zoom_meeting_id) {
      return badRequest(res, "No Zoom meeting is linked to this session.");
    }

    // -----------------------------------------------------------------------
    // 4. Build Zoom Meeting SDK JWT signature (HS256).
    //    role 1 = host (owning teacher only), role 0 = attendee (everyone else)
    // -----------------------------------------------------------------------
    const zoomRole = isHost ? 1 : 0;

    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 60 * 60 * 2; // 2-hour expiry

    const header  = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      sdkKey,
      mn:       session.zoom_meeting_id,
      role:     zoomRole,
      iat,
      exp,
      tokenExp: exp,
    })).toString("base64url");

    const message   = `${header}.${payload}`;
    const signature = crypto
      .createHmac("sha256", sdkSecret)
      .update(message)
      .digest("base64url");

    const token = `${message}.${signature}`;

    return res.json({
      success: true,
      data: {
        signature:     token,
        sdkKey,
        meetingNumber: session.zoom_meeting_id,
        password:      session.zoom_password ?? "",
        role:          zoomRole,
      },
    });
  } catch (err) {
    console.error("generateZoomSignature error:", err);
    return serverError(res);
  }
}
