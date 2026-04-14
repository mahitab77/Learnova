// ============================================================================
// Teacher Controller - SESSION-ONLY VERSION
// ----------------------------------------------------------------------------
// Changes made:
// ✅ 1. Session-only authentication: getAuthUserId() now only reads from req.session
// ✅ 2. Session role validation: requireTeacherContext() checks session role first
// ✅ 3. Removed all backdoor identity sources (req.user, req.userId, x-user-id)
// ✅ 4. Maintained all existing functionality
// ✅ 5. Enhanced security with early session validation
//
// For routes using this controller, you MUST apply:
// router.use(requireSession, requireTeacherRole);
// 
// Where requireSession and requireTeacherRole are middleware functions that
// check for valid session and teacher role respectively.
// ============================================================================

import pool from "../db.js";
import {
  normalizeBooleanTinyInt as normalizeScheduleBooleanTinyInt,
  normalizeTimeToHHMMSS as normalizeScheduleTimeToHHMMSS,
  normalizeWeekdayTo1to7 as normalizeScheduleWeekdayTo1to7,
} from "../utils/scheduleContract.js";
import {
  isValidDateStr,
  isValidDateTimeStr,
  toSqlDateTime,
} from "../utils/cairoTime.js";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------
const VARCHAR_255 = 255;

// We normalize weekdays to 1..7 (Mon..Sun) because student booking uses:
//   SELECT (WEEKDAY(?) + 1) AS wd  -> 1..7
const WEEKDAY_MIN = 1;
const WEEKDAY_MAX = 7;

// Platform timezone: Africa/Cairo (EET, UTC+2, no DST since 2011).
// All datetime parameters received from the frontend (?from / ?to / form fields)
// are assumed to be naive Cairo local times ("YYYY-MM-DD HH:MM:SS").
// Do NOT apply CONVERT_TZ — the DB timezone session must match this assumption.
// When producing ?from / ?to for "today's sessions", the frontend must compute
// Cairo start-of-day / end-of-day (see useTeacherDashboard cairoStartOfDay).
const PLATFORM_TZ = "Africa/Cairo"; // informational
const ATTENDANCE_STATUSES = new Set([
  "scheduled",
  "present",
  "absent",
  "late",
  "excused",
]);
// lesson_sessions.status lifecycle:
//   pending   → student/parent creates a booking request; awaiting teacher approval
//   scheduled → teacher (or admin) approves the pending request (current write path)
//   completed / no_show → teacher marks a terminal attendance outcome
//   cancelled → teacher or admin cancels a scheduled/pending session
//   rejected  → teacher declines a pending request
//
// 'approved' is a legacy alias for 'scheduled' that no current write path produces.
// It is retained in read/filter guards only for backwards compatibility with any
// pre-existing DB rows. All operations that are valid for 'scheduled' are equally
// valid for 'approved'.
const FUTURE_SESSION_STATUSES = new Set(["scheduled", "approved"]);
const ATTENDANCE_MUTABLE_SESSION_STATUSES = FUTURE_SESSION_STATUSES;

// ----------------------------------------------------------------------------
// Whitelist for entityExists to prevent SQL injection
// ----------------------------------------------------------------------------
const ALLOWED_TABLES = new Set([
  "subjects",
  "educational_systems",
  "grade_stages",
  "grade_levels",
  "users",
  "teachers",
  "students",
  "teacher_schedules",
  "teacher_schedule_exceptions",
  "lesson_sessions",
  "lesson_session_students",
  "homework_assignments",
  "homework_submissions",
  "quiz_assignments",
  "quiz_submissions",
  "teacher_subjects",
  "teacher_grade_levels",
  "teacher_videos",
  "teacher_schedule_subjects",
  "student_teacher_selections",
]);

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
function logErr(scope, err) {
  console.error(`[teacherController][${scope}]`, err);
}

/**
 * ✅ SESSION-ONLY AUTHENTICATION
 * Reads user ID ONLY from session - no more backdoors via headers or req.user
 */
function getAuthUserId(req) {
  const id = req.session?.user?.id; // ✅ single source of truth
  return Number.isFinite(Number(id)) && Number(id) > 0 ? Number(id) : null;
}

function badRequest(res, message, extra) {
  return res.status(400).json({ ok: false, error: message, ...(extra || {}) });
}

function unauthorized(res, message = "Unauthorized") {
  return res.status(401).json({ ok: false, error: message });
}

function forbidden(res, message = "Forbidden") {
  return res.status(403).json({ ok: false, error: message });
}

function notFound(res, message = "Not found") {
  return res.status(404).json({ ok: false, error: message });
}

function serverError(res, message = "Server error") {
  return res.status(500).json({ ok: false, error: message });
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toBoolTinyInt(v) {
  if (v === true || v === 1 || v === "1") return 1;
  if (v === false || v === 0 || v === "0") return 0;
  return null;
}

function normalizeLessonSessionStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function deriveTerminalSessionStatusFromAttendance(attendanceStatus) {
  switch (String(attendanceStatus || "").trim().toLowerCase()) {
    case "present":
    case "late":
      return "completed";
    case "absent":
      return "no_show";
    default:
      return null;
  }
}

function canFinalizeAttendanceForSession(session) {
  return Number(session?.is_group) !== 1 && Number(session?.students_count || 0) <= 1;
}

function clampVarchar255(label, value) {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > VARCHAR_255) {
    return { __too_long__: true, label, max: VARCHAR_255 };
  }
  return trimmed;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj ?? {}, key);
}

function normalizeNullableScheduleInt(value, fallbackValue = null) {
  if (value === undefined) return fallbackValue;
  if (value == null || value === "") return null;
  return toInt(value);
}

function buildCanonicalScheduleSlot(input, fallback = {}) {
  const weekdayInput = hasOwn(input, "weekday") && input.weekday != null ? input.weekday : fallback.weekday;

  const startTimeInput =
    hasOwn(input, "start_time") && input.start_time != null
      ? input.start_time
      : hasOwn(input, "startTime") && input.startTime != null
      ? input.startTime
      : fallback.start_time;

  const endTimeInput =
    hasOwn(input, "end_time") && input.end_time != null
      ? input.end_time
      : hasOwn(input, "endTime") && input.endTime != null
      ? input.endTime
      : fallback.end_time;

  const isGroupInput =
    hasOwn(input, "is_group") && input.is_group != null
      ? input.is_group
      : hasOwn(input, "isGroup") && input.isGroup != null
      ? input.isGroup
      : fallback.is_group;

  const maxStudentsInput = hasOwn(input, "max_students")
    ? input.max_students
    : hasOwn(input, "maxStudents")
    ? input.maxStudents
    : undefined;

  const isActiveInput =
    hasOwn(input, "is_active") && input.is_active != null
      ? input.is_active
      : hasOwn(input, "isActive") && input.isActive != null
      ? input.isActive
      : fallback.is_active;

  return {
    weekday: normalizeScheduleWeekdayTo1to7(weekdayInput),
    start_time: normalizeScheduleTimeToHHMMSS(startTimeInput),
    end_time: normalizeScheduleTimeToHHMMSS(endTimeInput),
    is_group: normalizeScheduleBooleanTinyInt(isGroupInput, fallback.is_group ?? 0),
    max_students: normalizeNullableScheduleInt(maxStudentsInput, fallback.max_students ?? null),
    is_active: normalizeScheduleBooleanTinyInt(isActiveInput, fallback.is_active ?? 1),
  };
}

function uniqKeyOffering(o) {
  const gl = o.grade_level_id == null ? "null" : String(o.grade_level_id);
  return `${o.subject_id}|${o.system_id}|${o.stage_id}|${gl}`;
}

// ----------------------------------------------------------------------------
// Teacher context with SESSION VALIDATION
// ----------------------------------------------------------------------------
async function requireTeacherContext(conn, req, res) {
  const userId = getAuthUserId(req);
  if (!userId) return { ok: false, response: unauthorized(res) };

  // ✅ CHECK SESSION ROLE FIRST - ensures consistency with session data
  const sessionRole = req.session?.user?.role;
  if (sessionRole !== "teacher") {
    return { ok: false, response: forbidden(res, "Forbidden - session role mismatch") };
  }

  const [uRows] = await conn.query(
    `SELECT id, role, is_active, full_name
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [userId]
  );

  const user = uRows?.[0];
  if (!user) return { ok: false, response: unauthorized(res, "User not found") };
  if (Number(user.is_active) !== 1) return { ok: false, response: forbidden(res, "User is inactive") };
  if (user.role !== "teacher") return { ok: false, response: forbidden(res, "User is not a teacher") };

  const [tRows] = await conn.query(
    `SELECT id, user_id, status, is_active
     FROM teachers
     WHERE user_id = ?
     LIMIT 1`,
    [userId]
  );

  const teacher = tRows?.[0];
  if (!teacher) {
    return { ok: false, response: forbidden(res, "Teacher profile not found") };
  }

  if (Number(teacher.is_active) !== 1) return { ok: false, response: forbidden(res, "Teacher profile is inactive") };
  if (teacher.status === "rejected") return { ok: false, response: forbidden(res, "Teacher profile is rejected") };

  return { ok: true, userId, teacherId: teacher.id, teacherStatus: teacher.status };
}

/**
 * Best-effort notification insert.
 * - Uses extra_data if column exists
 * - Falls back to insert without extra_data if the column doesn't exist
 *
 * NOTE: We keep a conservative column-set that works on most schemas.
 */
async function insertNotificationSafe(conn, { userId, title, body, relatedType, relatedId, extraData }) {
  const safeRelatedType = typeof relatedType === "string" ? relatedType : "other";
  const safeExtra = extraData != null ? JSON.stringify(extraData) : JSON.stringify({});

  try {
    await conn.query(
      `
      INSERT INTO notifications
        (user_id, type, title, body, related_type, related_id, is_read, created_at, extra_data)
      VALUES
        (?, 'system', ?, ?, ?, ?, 0, NOW(), ?)
      `,
      [userId, title, body, safeRelatedType, relatedId, safeExtra]
    );
    return;
  } catch (err) {
    // If extra_data column doesn't exist, retry without it
    if (err && (err.code === "ER_BAD_FIELD_ERROR" || err.errno === 1054)) {
      await conn.query(
        `
        INSERT INTO notifications
          (user_id, type, title, body, related_type, related_id, is_read, created_at)
        VALUES
          (?, 'system', ?, ?, ?, ?, 0, NOW())
        `,
        [userId, title, body, safeRelatedType, relatedId]
      );
      return;
    }
    throw err;
  }
}

// ----------------------------------------------------------------------------
// Schedule overlap
// ----------------------------------------------------------------------------
async function hasScheduleOverlap(conn, teacherId, weekday1to7, startTime, endTime, excludeScheduleId = null) {
  const params = [teacherId, weekday1to7, endTime, startTime];

  let sql = `
    SELECT id
    FROM teacher_schedules
    WHERE teacher_id = ?
      AND weekday = ?
      AND is_active = 1
      AND start_time < ?
      AND end_time > ?
  `;

  if (excludeScheduleId != null) {
    sql += ` AND id <> ?`;
    params.push(excludeScheduleId);
  }

  sql += ` LIMIT 1`;

  const [rows] = await conn.query(sql, params);
  return rows.length > 0;
}

// ----------------------------------------------------------------------------
// FK validation helpers (for schedule offerings) - SECURED
// ----------------------------------------------------------------------------
async function entityExists(conn, table, id) {
  if (!ALLOWED_TABLES.has(table)) {
    console.warn(`[SECURITY] Blocked entityExists query for non-whitelisted table: ${table}`);
    return false;
  }
  const [rows] = await conn.query(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`, [id]);
  return rows.length > 0;
}

async function stageBelongsToSystem(conn, stageId, systemId) {
  const [rows] = await conn.query(
    `SELECT id FROM grade_stages WHERE id = ? AND system_id = ? LIMIT 1`,
    [stageId, systemId]
  );
  return rows.length > 0;
}

async function gradeLevelBelongsToStage(conn, gradeLevelId, stageId) {
  const [rows] = await conn.query(
    `SELECT id FROM grade_levels WHERE id = ? AND stage_id = ? LIMIT 1`,
    [gradeLevelId, stageId]
  );
  return rows.length > 0;
}

async function validateOfferingRowFKs(conn, row) {
  const { subject_id, system_id, stage_id, grade_level_id } = row;

  if (!(await entityExists(conn, "subjects", subject_id))) {
    return { ok: false, message: `Invalid subject_id (${subject_id})` };
  }
  if (!(await entityExists(conn, "educational_systems", system_id))) {
    return { ok: false, message: `Invalid system_id (${system_id})` };
  }
  if (!(await entityExists(conn, "grade_stages", stage_id))) {
    return { ok: false, message: `Invalid stage_id (${stage_id})` };
  }
  if (!(await stageBelongsToSystem(conn, stage_id, system_id))) {
    return { ok: false, message: `stage_id (${stage_id}) does not belong to system_id (${system_id})` };
  }

  if (grade_level_id != null) {
    if (!(await entityExists(conn, "grade_levels", grade_level_id))) {
      return { ok: false, message: `Invalid grade_level_id (${grade_level_id})` };
    }
    if (!(await gradeLevelBelongsToStage(conn, grade_level_id, stage_id))) {
      return { ok: false, message: `grade_level_id (${grade_level_id}) does not belong to stage_id (${stage_id})` };
    }
  }

  return { ok: true };
}

// ============================================================================
// LESSON REQUESTS (Teacher approval flow)
// ============================================================================

/**
 * GET /teacher/lesson-requests/pending
 * Pending lesson requests must use lesson_sessions.student_id for student identity.
 */
export async function listMyPendingLessonRequests(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const [rows] = await conn.query(
      `
      SELECT
        ls.id,
        ls.teacher_id,
        ls.subject_id,
        ls.schedule_id,
        ls.starts_at,
        ls.ends_at,
        ls.status,
        ls.created_by_user_id,
        ls.student_id,

        -- Student identity via lesson_sessions.student_id -> students -> users
        COALESCE(su.full_name, 'Unknown student') AS student_name,
        su.email AS student_email,

        -- Requester identity via created_by_user_id (could be parent/admin/student)
        ru.full_name AS requester_name,
        ru.email     AS requester_email,

        s.name_en AS subject_name_en,
        s.name_ar AS subject_name_ar
      FROM lesson_sessions ls
      LEFT JOIN students st ON st.id = ls.student_id
      LEFT JOIN users su    ON su.id = st.user_id
      JOIN users ru         ON ru.id = ls.created_by_user_id
      JOIN subjects s       ON s.id = ls.subject_id
      WHERE ls.teacher_id = ?
        AND ls.status = 'pending'
      ORDER BY ls.starts_at ASC, ls.id ASC
      `,
      [ctx.teacherId]
    );

    return res.json({ ok: true, data: rows });
  } catch (err) {
    logErr("listMyPendingLessonRequests", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

/**
 * POST /teacher/lesson-requests/:id/approve
 * Approve flow must NOT derive student from created_by_user_id.
 * Uses lesson_sessions.student_id.
 */
export async function approveLessonRequest(req, res) {
  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const sessionId = toInt(req.params?.id ?? req.body?.id ?? req.body?.session_id);
    if (!sessionId || sessionId <= 0) return badRequest(res, "Valid session id is required");

    await conn.beginTransaction();
    txStarted = true;

    // Lock the session
    const [sRows] = await conn.query(
      `
      SELECT id, teacher_id, subject_id, starts_at, ends_at, created_by_user_id, student_id, status
      FROM lesson_sessions
      WHERE id = ? AND teacher_id = ?
      FOR UPDATE
      `,
      [sessionId, ctx.teacherId]
    );

    const session = sRows?.[0];
    if (!session) {
      await conn.rollback();
      txStarted = false;
      return notFound(res, "Lesson request not found");
    }
    if (session.status !== "pending") {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Only pending lesson requests can be approved");
    }

    if (!session.student_id || Number(session.student_id) <= 0) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Lesson request has no valid student assigned");
    }

    // Conflict check using DB times
    const [conflictRows] = await conn.query(
      `
      SELECT 1
      FROM lesson_sessions
      WHERE teacher_id = ?
        AND id <> ?
        AND status IN ('pending','scheduled','approved')
        AND starts_at < ?
        AND ends_at   > ?
      LIMIT 1
      `,
      [ctx.teacherId, sessionId, session.ends_at, session.starts_at]
    );

    if (conflictRows.length) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Cannot approve: time slot is no longer available (conflict detected)");
    }

    // Approve -> scheduled and stamp the acting teacher user
    await conn.query(
      `
      UPDATE lesson_sessions
      SET status = 'scheduled',
          updated_by_user_id = ?
      WHERE id = ? AND teacher_id = ?
      `,
      [ctx.userId, sessionId, ctx.teacherId]
    );

    // Insert attendee row using session.student_id
    await conn.query(
      `
      INSERT IGNORE INTO lesson_session_students
        (session_id, student_id, attendance_status)
      VALUES
        (?, ?, 'scheduled')
      `,
      [sessionId, session.student_id]
    );

    // Notify requester (created_by_user_id)
    await insertNotificationSafe(conn, {
      userId: session.created_by_user_id,
      title: "Lesson approved",
      body: `Your lesson request (#${sessionId}) has been approved and scheduled.`,
      relatedType: "lesson_session",
      relatedId: sessionId,
      extraData: { kind: "lesson_request", status: "scheduled", sessionId },
    });

    await conn.commit();
    txStarted = false;

    return res.json({ ok: true, message: "Lesson request approved", data: { sessionId } });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    logErr("approveLessonRequest", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

/**
 * POST /teacher/lesson-requests/:id/reject
 * Reject flow writes canonical rejected status while preserving schema-backed audit metadata.
 */
export async function rejectLessonRequest(req, res) {
  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const sessionId = toInt(req.params?.id ?? req.body?.id ?? req.body?.session_id);
    if (!sessionId || sessionId <= 0) return badRequest(res, "Valid session id is required");

    const rejectionReason = typeof req.body?.reason === "string" ? req.body.reason.trim() : null;

    await conn.beginTransaction();
    txStarted = true;

    const [sRows] = await conn.query(
      `
      SELECT id, teacher_id, created_by_user_id, status, student_id
      FROM lesson_sessions
      WHERE id = ? AND teacher_id = ?
      FOR UPDATE
      `,
      [sessionId, ctx.teacherId]
    );

    const session = sRows?.[0];
    if (!session) {
      await conn.rollback();
      txStarted = false;
      return notFound(res, "Lesson request not found");
    }
    if (session.status !== "pending") {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Only pending lesson requests can be rejected");
    }

    await conn.query(
      `
      UPDATE lesson_sessions
      SET status = 'rejected',
          cancelled_by = 'teacher',
          cancel_reason = ?,
          updated_by_user_id = ?
      WHERE id = ? AND teacher_id = ?
      `,
      [rejectionReason || "teacher_rejected", ctx.userId, sessionId, ctx.teacherId]
    );

    // Notify requester
    await insertNotificationSafe(conn, {
      userId: session.created_by_user_id,
      title: "Lesson rejected",
      body: `Your lesson request (#${sessionId}) was rejected by the teacher.${
        rejectionReason ? ` Reason: ${rejectionReason}` : ""
      }`,
      relatedType: "lesson_session",
      relatedId: sessionId,
      extraData: { kind: "lesson_request", status: "rejected", sessionId, reason: rejectionReason || null },
    });

    await conn.commit();
    txStarted = false;

    return res.json({
      ok: true,
      message: "Lesson request rejected",
      data: {
        sessionId,
        status: "rejected",
        reason: rejectionReason,
        cancelled_by: "teacher",
        cancel_reason: rejectionReason || "teacher_rejected",
      },
    });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    logErr("rejectLessonRequest", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

// ============================================================================
// PROFILE
// ============================================================================

export async function getMyProfile(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const [rows] = await conn.query(
      `SELECT
         t.id,
         t.user_id,
         t.name,
         t.bio_short,
         t.gender,
         t.photo_url,
         t.max_capacity,
         t.phone,
         t.nationality,
         t.date_of_birth,
         t.university,
         t.specialization,
         t.current_occupation,
         t.teaching_style,
         t.bio_long,
         t.references_text,
         t.education_system_id,
         t.years_of_experience,
         t.highest_qualification,
         t.hourly_rate,
         t.teaching_philosophy,
         t.achievements,
         t.status,
         t.is_active,
         t.created_at,
         u.full_name AS user_full_name,
         u.email AS user_email,
         u.preferred_lang AS user_preferred_lang
       FROM teachers t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = ?
       LIMIT 1`,
      [ctx.teacherId]
    );

    return res.json({ ok: true, data: rows[0] || null });
  } catch (err) {
    logErr("getMyProfile", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function updateMyProfile(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const b = req.body || {};
    const allowed = {
      name: typeof b.name === "string" ? b.name.trim() : null,
      bio_short: typeof b.bio_short === "string" ? b.bio_short.trim() : null,
      gender: b.gender === "male" || b.gender === "female" ? b.gender : null,
      photo_url: typeof b.photo_url === "string" ? b.photo_url.trim() : null,
      max_capacity: b.max_capacity == null ? null : toInt(b.max_capacity),
      phone: typeof b.phone === "string" ? b.phone.trim() : null,
      nationality: typeof b.nationality === "string" ? b.nationality.trim() : null,
      date_of_birth:
        b.date_of_birth == null
          ? null
          : isValidDateStr(b.date_of_birth)
          ? b.date_of_birth
          : "__INVALID__",
      university: typeof b.university === "string" ? b.university.trim() : null,
      specialization: typeof b.specialization === "string" ? b.specialization.trim() : null,
      current_occupation: typeof b.current_occupation === "string" ? b.current_occupation.trim() : null,
      teaching_style: typeof b.teaching_style === "string" ? b.teaching_style.trim() : null,
      bio_long: typeof b.bio_long === "string" ? b.bio_long.trim() : null,
      references_text: typeof b.references_text === "string" ? b.references_text.trim() : null,
      education_system_id: b.education_system_id == null ? null : toInt(b.education_system_id),
      years_of_experience: typeof b.years_of_experience === "string" ? b.years_of_experience.trim() : null,
      highest_qualification: typeof b.highest_qualification === "string" ? b.highest_qualification.trim() : null,
      hourly_rate: typeof b.hourly_rate === "string" ? b.hourly_rate.trim() : null,
      teaching_philosophy: typeof b.teaching_philosophy === "string" ? b.teaching_philosophy.trim() : null,
      achievements: typeof b.achievements === "string" ? b.achievements.trim() : null,
    };

    if (allowed.date_of_birth === "__INVALID__") {
      return badRequest(res, "Invalid date_of_birth. Expected YYYY-MM-DD");
    }
    if (allowed.max_capacity != null && allowed.max_capacity < 0) {
      return badRequest(res, "max_capacity cannot be negative");
    }
    if (allowed.education_system_id != null && allowed.education_system_id <= 0) {
      return badRequest(res, "education_system_id must be a positive integer");
    }

    const [curRows] = await conn.query(`SELECT name FROM teachers WHERE id = ? LIMIT 1`, [ctx.teacherId]);
    const currentName = curRows?.[0]?.name || "Teacher";
    const finalName = allowed.name && allowed.name.length ? allowed.name : currentName;

    await conn.query(
      `UPDATE teachers
       SET
         name = ?,
         bio_short = ?,
         gender = ?,
         photo_url = ?,
         max_capacity = ?,
         phone = ?,
         nationality = ?,
         date_of_birth = ?,
         university = ?,
         specialization = ?,
         current_occupation = ?,
         teaching_style = ?,
         bio_long = ?,
         references_text = ?,
         education_system_id = ?,
         years_of_experience = ?,
         highest_qualification = ?,
         hourly_rate = ?,
         teaching_philosophy = ?,
         achievements = ?
       WHERE id = ?`,
      [
        finalName,
        allowed.bio_short,
        allowed.gender,
        allowed.photo_url,
        allowed.max_capacity,
        allowed.phone,
        allowed.nationality,
        allowed.date_of_birth,
        allowed.university,
        allowed.specialization,
        allowed.current_occupation,
        allowed.teaching_style,
        allowed.bio_long,
        allowed.references_text,
        allowed.education_system_id,
        allowed.years_of_experience,
        allowed.highest_qualification,
        allowed.hourly_rate,
        allowed.teaching_philosophy,
        allowed.achievements,
        ctx.teacherId,
      ]
    );

    return res.json({ ok: true, message: "Profile updated" });
  } catch (err) {
    logErr("updateMyProfile", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

// ============================================================================
// SUBJECTS
// ============================================================================

export async function getMySubjects(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const [rows] = await conn.query(
      `SELECT ts.subject_id, s.name_en, s.name_ar
       FROM teacher_subjects ts
       JOIN subjects s ON s.id = ts.subject_id
       WHERE ts.teacher_id = ?
       ORDER BY s.sort_order ASC, s.id ASC`,
      [ctx.teacherId]
    );

    return res.json({ ok: true, data: rows });
  } catch (err) {
    logErr("getMySubjects", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function setMySubjects(req, res) {
  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const subjectIds = Array.isArray(req.body?.subject_ids)
      ? req.body.subject_ids.map(toInt).filter((n) => n && n > 0)
      : null;

    if (!subjectIds) return badRequest(res, "subject_ids must be an array of positive integers");
    const unique = Array.from(new Set(subjectIds));

    await conn.beginTransaction();
    txStarted = true;

    await conn.query(`DELETE FROM teacher_subjects WHERE teacher_id = ?`, [ctx.teacherId]);

    if (unique.length) {
      const values = unique.map((sid) => [ctx.teacherId, sid]);
      await conn.query(`INSERT INTO teacher_subjects (teacher_id, subject_id) VALUES ?`, [values]);
    }

    await conn.commit();
    txStarted = false;

    return res.json({ ok: true, message: "Subjects updated" });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    logErr("setMySubjects", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

// ============================================================================
// GRADE LEVELS
// ============================================================================

export async function getMyGradeLevels(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const [rows] = await conn.query(
      `SELECT
         tgl.grade_level_id,
         gl.name_en, gl.name_ar, gl.code,
         gs.id AS stage_id, gs.name_en AS stage_name_en, gs.name_ar AS stage_name_ar,
         es.id AS system_id, es.name AS system_name, es.code AS system_code
       FROM teacher_grade_levels tgl
       JOIN grade_levels gl ON gl.id = tgl.grade_level_id
       JOIN grade_stages gs ON gs.id = gl.stage_id
       JOIN educational_systems es ON es.id = gs.system_id
       WHERE tgl.teacher_id = ?
       ORDER BY es.sort_order ASC, gs.sort_order ASC, gl.sort_order ASC, gl.id ASC`,
      [ctx.teacherId]
    );

    return res.json({ ok: true, data: rows });
  } catch (err) {
    logErr("getMyGradeLevels", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function setMyGradeLevels(req, res) {
  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const gradeLevelIds = Array.isArray(req.body?.grade_level_ids)
      ? req.body.grade_level_ids.map(toInt).filter((n) => n && n > 0)
      : null;

    if (!gradeLevelIds) return badRequest(res, "grade_level_ids must be an array of positive integers");
    const unique = Array.from(new Set(gradeLevelIds));

    await conn.beginTransaction();
    txStarted = true;

    await conn.query(`DELETE FROM teacher_grade_levels WHERE teacher_id = ?`, [ctx.teacherId]);

    if (unique.length) {
      const values = unique.map((gid) => [ctx.teacherId, gid]);
      await conn.query(`INSERT INTO teacher_grade_levels (teacher_id, grade_level_id) VALUES ?`, [values]);
    }

    await conn.commit();
    txStarted = false;

    return res.json({ ok: true, message: "Grade levels updated" });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    logErr("setMyGradeLevels", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

// ============================================================================
// VIDEOS
// ============================================================================

export async function listMyVideos(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const [rows] = await conn.query(
      `SELECT tv.id, tv.teacher_id, tv.subject_id, tv.video_url, tv.is_primary, tv.created_at,
              s.name_en AS subject_name_en, s.name_ar AS subject_name_ar
       FROM teacher_videos tv
       LEFT JOIN subjects s ON s.id = tv.subject_id
       WHERE tv.teacher_id = ?
       ORDER BY tv.is_primary DESC, tv.created_at DESC, tv.id DESC`,
      [ctx.teacherId]
    );

    return res.json({ ok: true, data: rows });
  } catch (err) {
    logErr("listMyVideos", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function addMyVideo(req, res) {
  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const subjectId = toInt(req.body?.subject_id);
    const videoUrl = typeof req.body?.video_url === "string" ? req.body.video_url.trim() : "";

    if (!subjectId || subjectId <= 0) return badRequest(res, "subject_id is required");
    if (!videoUrl) return badRequest(res, "video_url is required");

    const [countRows] = await conn.query(`SELECT COUNT(*) AS c FROM teacher_videos WHERE teacher_id = ?`, [ctx.teacherId]);
    const existingCount = Number(countRows?.[0]?.c || 0);

    const clientIsPrimary = toBoolTinyInt(req.body?.is_primary);
    const shouldBePrimary = existingCount === 0 ? 1 : clientIsPrimary === 1 ? 1 : 0;

    await conn.beginTransaction();
    txStarted = true;

    if (shouldBePrimary === 1) {
      await conn.query(`UPDATE teacher_videos SET is_primary = 0 WHERE teacher_id = ?`, [ctx.teacherId]);
    }

    const [ins] = await conn.query(
      `INSERT INTO teacher_videos (teacher_id, subject_id, video_url, is_primary)
       VALUES (?, ?, ?, ?)`,
      [ctx.teacherId, subjectId, videoUrl, shouldBePrimary]
    );

    await conn.commit();
    txStarted = false;

    return res.json({
      ok: true,
      message: "Video added",
      id: ins.insertId,
      is_primary: shouldBePrimary,
      became_primary_reason: existingCount === 0 ? "first_video" : shouldBePrimary === 1 ? "explicit_request" : "default_non_primary",
    });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    logErr("addMyVideo", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function setPrimaryVideo(req, res) {
  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const videoId = toInt(req.params?.videoId ?? req.body?.video_id);
    if (!videoId || videoId <= 0) return badRequest(res, "videoId is required");

    const [rows] = await conn.query(`SELECT id FROM teacher_videos WHERE id = ? AND teacher_id = ? LIMIT 1`, [
      videoId,
      ctx.teacherId,
    ]);
    if (!rows.length) return notFound(res, "Video not found");

    await conn.beginTransaction();
    txStarted = true;

    await conn.query(`UPDATE teacher_videos SET is_primary = 0 WHERE teacher_id = ?`, [ctx.teacherId]);
    await conn.query(`UPDATE teacher_videos SET is_primary = 1 WHERE id = ? AND teacher_id = ?`, [videoId, ctx.teacherId]);

    await conn.commit();
    txStarted = false;

    return res.json({ ok: true, message: "Primary video updated" });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    logErr("setPrimaryVideo", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function deleteMyVideo(req, res) {
  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const videoId = toInt(req.params?.videoId ?? req.body?.video_id);
    if (!videoId || videoId <= 0) return badRequest(res, "videoId is required");

    const [cur] = await conn.query(`SELECT id, is_primary FROM teacher_videos WHERE id = ? AND teacher_id = ? LIMIT 1`, [
      videoId,
      ctx.teacherId,
    ]);
    const current = cur?.[0];
    if (!current) return notFound(res, "Video not found");

    await conn.beginTransaction();
    txStarted = true;

    const [del] = await conn.query(`DELETE FROM teacher_videos WHERE id = ? AND teacher_id = ?`, [videoId, ctx.teacherId]);
    if (!del.affectedRows) {
      await conn.rollback();
      txStarted = false;
      return notFound(res, "Video not found");
    }

    // If deleting primary, promote newest remaining video to primary
    if (Number(current.is_primary) === 1) {
      const [rem] = await conn.query(
        `SELECT id
         FROM teacher_videos
         WHERE teacher_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [ctx.teacherId]
      );

      const next = rem?.[0];
      if (next?.id) {
        await conn.query(`UPDATE teacher_videos SET is_primary = 1 WHERE id = ? AND teacher_id = ?`, [next.id, ctx.teacherId]);
      }
    }

    await conn.commit();
    txStarted = false;

    return res.json({ ok: true, message: "Video deleted" });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    logErr("deleteMyVideo", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

// ============================================================================
// SCHEDULES
// ============================================================================

export async function listMySchedules(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const [rows] = await conn.query(
      `SELECT id, teacher_id, weekday, start_time, end_time, is_group, max_students, is_active, created_at, updated_at
       FROM teacher_schedules
       WHERE teacher_id = ?
       ORDER BY weekday ASC, start_time ASC, end_time ASC, id ASC`,
      [ctx.teacherId]
    );

    return res.json({ ok: true, data: rows });
  } catch (err) {
    logErr("listMySchedules", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function createScheduleSlot(req, res) {
  const conn = await pool.getConnection();
  let txStarted = false;
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const schedule = buildCanonicalScheduleSlot(req.body ?? {});

    if (schedule.weekday == null || schedule.weekday < WEEKDAY_MIN || schedule.weekday > WEEKDAY_MAX) {
      return badRequest(res, "weekday must be 0..6 or 1..7 (will be stored as 1..7)");
    }
    if (!schedule.start_time || !schedule.end_time) return badRequest(res, "start_time and end_time must be valid time strings");
    if (schedule.start_time >= schedule.end_time) return badRequest(res, "start_time must be before end_time");
    if (Number(schedule.is_group) === 1 && (schedule.max_students == null || schedule.max_students < 2)) {
      return badRequest(res, "max_students must be >= 2 for group slots");
    }

    await conn.beginTransaction();
    txStarted = true;

    // Serialize overlap-sensitive writes for this teacher+weekday.
    await conn.query(
      `SELECT id
       FROM teacher_schedules
       WHERE teacher_id = ?
         AND weekday = ?
         AND is_active = 1
       FOR UPDATE`,
      [ctx.teacherId, schedule.weekday]
    );

    const overlap = await hasScheduleOverlap(
      conn,
      ctx.teacherId,
      schedule.weekday,
      schedule.start_time,
      schedule.end_time,
      null
    );
    if (overlap) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Schedule slot overlaps another active slot on the same weekday");
    }

    const [ins] = await conn.query(
      `INSERT INTO teacher_schedules
       (teacher_id, weekday, start_time, end_time, is_group, max_students, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx.teacherId,
        schedule.weekday,
        schedule.start_time,
        schedule.end_time,
        schedule.is_group,
        schedule.max_students,
        schedule.is_active,
      ]
    );

    await conn.commit();
    txStarted = false;

    return res.json({ ok: true, message: "Schedule slot created", id: ins.insertId, stored_weekday: schedule.weekday });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    logErr("createScheduleSlot", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function updateScheduleSlot(req, res) {
  const conn = await pool.getConnection();
  let txStarted = false;
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const scheduleId = toInt(req.params?.scheduleId ?? req.body?.schedule_id);
    if (!scheduleId || scheduleId <= 0) return badRequest(res, "scheduleId is required");

    await conn.beginTransaction();
    txStarted = true;

    const [curRows] = await conn.query(
      `SELECT id, weekday, start_time, end_time, is_group, max_students, is_active
       FROM teacher_schedules
       WHERE id = ? AND teacher_id = ?
       FOR UPDATE
       LIMIT 1`,
      [scheduleId, ctx.teacherId]
    );
    const current = curRows?.[0];
    if (!current) {
      await conn.rollback();
      txStarted = false;
      return notFound(res, "Schedule slot not found");
    }

    const schedule = buildCanonicalScheduleSlot(req.body ?? {}, {
      weekday: Number(current.weekday),
      start_time: current.start_time,
      end_time: current.end_time,
      is_group: current.is_group,
      max_students: current.max_students,
      is_active: current.is_active,
    });

    if (schedule.weekday == null || schedule.weekday < WEEKDAY_MIN || schedule.weekday > WEEKDAY_MAX) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "weekday must be 0..6 or 1..7 (will be stored as 1..7)");
    }
    if (!schedule.start_time || !schedule.end_time) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "start_time/end_time must be valid time strings");
    }
    if (schedule.start_time >= schedule.end_time) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "start_time must be before end_time");
    }
    if (Number(schedule.is_group) === 1 && (schedule.max_students == null || schedule.max_students < 2)) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "max_students must be >= 2 for group slots");
    }

    // Serialize overlap-sensitive writes for the relevant weekday set.
    await conn.query(
      `SELECT id
       FROM teacher_schedules
       WHERE teacher_id = ?
         AND is_active = 1
         AND weekday IN (?, ?)
       FOR UPDATE`,
      [ctx.teacherId, Number(current.weekday), schedule.weekday]
    );

    if (Number(schedule.is_active) === 1) {
      const overlap = await hasScheduleOverlap(
        conn,
        ctx.teacherId,
        schedule.weekday,
        schedule.start_time,
        schedule.end_time,
        scheduleId
      );
      if (overlap) {
        await conn.rollback();
        txStarted = false;
        return badRequest(res, "Schedule slot overlaps another active slot on the same weekday");
      }
    }

    await conn.query(
      `UPDATE teacher_schedules
       SET weekday = ?, start_time = ?, end_time = ?, is_group = ?, max_students = ?, is_active = ?
       WHERE id = ? AND teacher_id = ?`,
      [
        schedule.weekday,
        schedule.start_time,
        schedule.end_time,
        schedule.is_group,
        schedule.max_students,
        schedule.is_active,
        scheduleId,
        ctx.teacherId,
      ]
    );

    await conn.commit();
    txStarted = false;

    return res.json({ ok: true, message: "Schedule slot updated", stored_weekday: schedule.weekday });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    logErr("updateScheduleSlot", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function deleteScheduleSlot(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const scheduleId = toInt(req.params?.scheduleId ?? req.body?.schedule_id);
    if (!scheduleId || scheduleId <= 0) return badRequest(res, "scheduleId is required");

    const [del] = await conn.query(`DELETE FROM teacher_schedules WHERE id = ? AND teacher_id = ?`, [
      scheduleId,
      ctx.teacherId,
    ]);
    if (!del.affectedRows) return notFound(res, "Schedule slot not found");

    return res.json({ ok: true, message: "Schedule slot deleted" });
  } catch (err) {
    logErr("deleteScheduleSlot", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

// ============================================================================
// OFFERINGS (teacher_schedule_subjects)
// ============================================================================

export async function listMySlotOfferings(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const scheduleId = req.query?.schedule_id != null ? toInt(req.query.schedule_id) : null;

    let sql = `
      SELECT
        teacher_id,
        schedule_id,
        weekday,
        start_time,
        end_time,
        schedule_is_active,
        is_group,
        max_students,
        offering_id,
        subject_id,
        system_id,
        stage_id,
        grade_level_id,
        offering_is_active
      FROM v_teacher_slot_offerings
      WHERE teacher_id = ?
    `;
    const params = [ctx.teacherId];

    if (scheduleId && scheduleId > 0) {
      sql += ` AND schedule_id = ?`;
      params.push(scheduleId);
    }

    sql += ` ORDER BY weekday ASC, start_time ASC, offering_id ASC`;

    const [rows] = await conn.query(sql, params);
    return res.json({ ok: true, data: rows });
  } catch (err) {
    logErr("listMySlotOfferings", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function setScheduleSlotOfferings(req, res) {
  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const scheduleId = toInt(req.params?.scheduleId ?? req.body?.schedule_id);
    if (!scheduleId || scheduleId <= 0) return badRequest(res, "scheduleId is required");

    const [sRows] = await conn.query(`SELECT id FROM teacher_schedules WHERE id = ? AND teacher_id = ? LIMIT 1`, [
      scheduleId,
      ctx.teacherId,
    ]);
    if (!sRows.length) return notFound(res, "Schedule slot not found");

    const offerings = Array.isArray(req.body?.offerings) ? req.body.offerings : null;
    if (!offerings) return badRequest(res, "offerings must be an array");

    const cleaned = [];
    for (const o of offerings) {
      const subjectId = toInt(o?.subject_id);
      const systemId = toInt(o?.system_id);
      const stageId = toInt(o?.stage_id);
      const gradeLevelId = o?.grade_level_id == null ? null : toInt(o.grade_level_id);
      const isActive = toBoolTinyInt(o?.is_active) ?? 1;

      if (!subjectId || subjectId <= 0) return badRequest(res, "Each offering requires subject_id");
      if (!systemId || systemId <= 0) return badRequest(res, "Each offering requires system_id");
      if (!stageId || stageId <= 0) return badRequest(res, "Each offering requires stage_id");
      if (gradeLevelId != null && gradeLevelId <= 0) return badRequest(res, "grade_level_id must be a positive integer or null");

      cleaned.push({
        subject_id: subjectId,
        system_id: systemId,
        stage_id: stageId,
        grade_level_id: gradeLevelId,
        is_active: isActive,
      });
    }

    // De-duplicate by (subject/system/stage/gradeLevel)
    const map = new Map();
    for (const o of cleaned) map.set(uniqKeyOffering(o), o);
    const unique = Array.from(map.values());

    // Batched FK validation — 4 queries total regardless of how many offerings
    // were submitted (replaces the previous per-row N+1 loop).
    if (unique.length) {
      const subjectIds  = [...new Set(unique.map((o) => o.subject_id))];
      const systemIds   = [...new Set(unique.map((o) => o.system_id))];
      const stageIds    = [...new Set(unique.map((o) => o.stage_id))];
      const glIds       = [...new Set(unique.map((o) => o.grade_level_id).filter((id) => id != null))];

      const [[subjectRows], [systemRows], [stageRows]] = await Promise.all([
        conn.query(`SELECT id FROM subjects WHERE id IN (?)`, [subjectIds]),
        conn.query(`SELECT id FROM educational_systems WHERE id IN (?)`, [systemIds]),
        // Fetch system_id so we can validate stage → system membership in memory
        conn.query(`SELECT id, system_id FROM grade_stages WHERE id IN (?)`, [stageIds]),
      ]);

      // grade_levels only queried when there is at least one non-null grade_level_id
      const glRows = glIds.length
        ? (await conn.query(`SELECT id, stage_id FROM grade_levels WHERE id IN (?)`, [glIds]))[0]
        : [];

      const validSubjects = new Set(subjectRows.map((r) => r.id));
      const validSystems  = new Set(systemRows.map((r) => r.id));
      // stageMap: stageId → system_id (proves existence + parent link in one look-up)
      const stageMap      = new Map(stageRows.map((r) => [r.id, r.system_id]));
      // glMap: grade_level_id → stage_id
      const glMap         = new Map(glRows.map((r) => [r.id, r.stage_id]));

      for (const row of unique) {
        if (!validSubjects.has(row.subject_id))
          return badRequest(res, `Invalid subject_id (${row.subject_id})`, { row });
        if (!validSystems.has(row.system_id))
          return badRequest(res, `Invalid system_id (${row.system_id})`, { row });
        if (!stageMap.has(row.stage_id))
          return badRequest(res, `Invalid stage_id (${row.stage_id})`, { row });
        if (stageMap.get(row.stage_id) !== row.system_id)
          return badRequest(res, `stage_id (${row.stage_id}) does not belong to system_id (${row.system_id})`, { row });
        if (row.grade_level_id != null) {
          if (!glMap.has(row.grade_level_id))
            return badRequest(res, `Invalid grade_level_id (${row.grade_level_id})`, { row });
          if (glMap.get(row.grade_level_id) !== row.stage_id)
            return badRequest(res, `grade_level_id (${row.grade_level_id}) does not belong to stage_id (${row.stage_id})`, { row });
        }
      }
    }

    await conn.beginTransaction();
    txStarted = true;

    await conn.query(`DELETE FROM teacher_schedule_subjects WHERE schedule_id = ?`, [scheduleId]);

    if (unique.length) {
      const values = unique.map((o) => [scheduleId, o.subject_id, o.system_id, o.stage_id, o.grade_level_id, o.is_active]);

      await conn.query(
        `INSERT INTO teacher_schedule_subjects
         (schedule_id, subject_id, system_id, stage_id, grade_level_id, is_active)
         VALUES ?`,
        [values]
      );
    }

    await conn.commit();
    txStarted = false;

    return res.json({ ok: true, message: "Offerings updated" });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }

    if (err && (err.code === "ER_NO_REFERENCED_ROW_2" || err.errno === 1452)) {
      return badRequest(res, "Invalid offering references (FK constraint failed). Please refresh lists and try again.");
    }

    logErr("setScheduleSlotOfferings", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

// ============================================================================
// EXCEPTIONS
// ============================================================================

export async function listMyScheduleExceptions(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const [rows] = await conn.query(
      `SELECT
         id, teacher_id,
         exception_date, start_time, end_time,
         exception_type, is_group, max_students,
         note, created_by_user_id, reason,
         is_active, created_at, updated_at
       FROM teacher_schedule_exceptions
       WHERE teacher_id = ?
       ORDER BY exception_date DESC, start_time ASC, id DESC`,
      [ctx.teacherId]
    );

    return res.json({ ok: true, data: rows });
  } catch (err) {
    logErr("listMyScheduleExceptions", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function createScheduleException(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const exceptionDate = req.body?.exception_date;
    const startTime = normalizeScheduleTimeToHHMMSS(req.body?.start_time);
    const endTime = normalizeScheduleTimeToHHMMSS(req.body?.end_time);
    const exceptionType = req.body?.exception_type;
    const isGroup = toBoolTinyInt(req.body?.is_group) ?? 0;
    const maxStudents = req.body?.max_students == null ? null : toInt(req.body?.max_students);

    const noteVal = clampVarchar255("note", req.body?.note);
    if (noteVal && noteVal.__too_long__) return badRequest(res, `note must be at most ${noteVal.max} characters`);
    const reasonVal = clampVarchar255("reason", req.body?.reason);
    if (reasonVal && reasonVal.__too_long__) return badRequest(res, `reason must be at most ${reasonVal.max} characters`);

    const note = typeof noteVal === "string" ? noteVal : null;
    const reason = typeof reasonVal === "string" ? reasonVal : null;

    const isActive = toBoolTinyInt(req.body?.is_active) ?? 1;

    if (!isValidDateStr(exceptionDate)) return badRequest(res, "exception_date must be YYYY-MM-DD");
    if (!startTime || !endTime) return badRequest(res, "start_time and end_time must be valid time strings");
    if (startTime >= endTime) return badRequest(res, "start_time must be before end_time");
    if (exceptionType !== "unavailable" && exceptionType !== "extra_available") {
      return badRequest(res, "exception_type must be 'unavailable' or 'extra_available'");
    }
    if (isGroup === 1 && (maxStudents == null || maxStudents < 2)) {
      return badRequest(res, "max_students must be >= 2 for group exceptions");
    }

    const userId = getAuthUserId(req);

    const [ins] = await conn.query(
      `INSERT INTO teacher_schedule_exceptions
       (teacher_id, exception_date, start_time, end_time, exception_type, is_group, max_students, note, created_by_user_id, reason, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ctx.teacherId, exceptionDate, startTime, endTime, exceptionType, isGroup, maxStudents, note, userId, reason, isActive]
    );

    return res.json({ ok: true, message: "Schedule exception created", id: ins.insertId });
  } catch (err) {
    logErr("createScheduleException", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function updateScheduleException(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const exceptionId = toInt(req.params?.exceptionId ?? req.body?.exception_id);
    if (!exceptionId || exceptionId <= 0) return badRequest(res, "exceptionId is required");

    const [curRows] = await conn.query(
      `SELECT *
       FROM teacher_schedule_exceptions
       WHERE id = ? AND teacher_id = ?
       LIMIT 1`,
      [exceptionId, ctx.teacherId]
    );
    const current = curRows?.[0];
    if (!current) return notFound(res, "Exception not found");

    const exceptionDate = req.body?.exception_date == null ? current.exception_date : req.body.exception_date;
    const startTime = req.body?.start_time == null ? current.start_time : normalizeScheduleTimeToHHMMSS(req.body.start_time);
    const endTime = req.body?.end_time == null ? current.end_time : normalizeScheduleTimeToHHMMSS(req.body.end_time);
    const exceptionType = req.body?.exception_type == null ? current.exception_type : req.body.exception_type;
    const isGroup = req.body?.is_group == null ? current.is_group : toBoolTinyInt(req.body.is_group) ?? current.is_group;
    const maxStudents =
      req.body?.max_students === undefined ? current.max_students : req.body.max_students == null ? null : toInt(req.body.max_students);

    let note = current.note;
    if (req.body?.note !== undefined) {
      const noteVal = clampVarchar255("note", req.body?.note);
      if (noteVal && noteVal.__too_long__) return badRequest(res, `note must be at most ${noteVal.max} characters`);
      note = typeof noteVal === "string" ? noteVal : null;
    }

    let reason = current.reason;
    if (req.body?.reason !== undefined) {
      const reasonVal = clampVarchar255("reason", req.body?.reason);
      if (reasonVal && reasonVal.__too_long__) return badRequest(res, `reason must be at most ${reasonVal.max} characters`);
      reason = typeof reasonVal === "string" ? reasonVal : null;
    }

    const isActive = req.body?.is_active == null ? current.is_active : toBoolTinyInt(req.body.is_active) ?? current.is_active;

    if (!isValidDateStr(exceptionDate)) return badRequest(res, "exception_date must be YYYY-MM-DD");
    if (!startTime || !endTime) return badRequest(res, "start_time/end_time must be valid time strings");
    if (startTime >= endTime) return badRequest(res, "start_time must be before end_time");
    if (exceptionType !== "unavailable" && exceptionType !== "extra_available") {
      return badRequest(res, "exception_type must be 'unavailable' or 'extra_available'");
    }
    if (Number(isGroup) === 1 && (maxStudents == null || maxStudents < 2)) {
      return badRequest(res, "max_students must be >= 2 for group exceptions");
    }

    await conn.query(
      `UPDATE teacher_schedule_exceptions
       SET exception_date = ?, start_time = ?, end_time = ?, exception_type = ?,
           is_group = ?, max_students = ?, note = ?, reason = ?, is_active = ?
       WHERE id = ? AND teacher_id = ?`,
      [exceptionDate, startTime, endTime, exceptionType, isGroup, maxStudents, note, reason, isActive, exceptionId, ctx.teacherId]
    );

    return res.json({ ok: true, message: "Exception updated" });
  } catch (err) {
    logErr("updateScheduleException", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function deleteScheduleException(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const exceptionId = toInt(req.params?.exceptionId ?? req.body?.exception_id);
    if (!exceptionId || exceptionId <= 0) return badRequest(res, "exceptionId is required");

    const [del] = await conn.query(`DELETE FROM teacher_schedule_exceptions WHERE id = ? AND teacher_id = ?`, [
      exceptionId,
      ctx.teacherId,
    ]);
    if (!del.affectedRows) return notFound(res, "Exception not found");

    return res.json({ ok: true, message: "Exception deleted" });
  } catch (err) {
    logErr("deleteScheduleException", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

// ============================================================================
// LESSON SESSIONS (Teacher list + details + attendance)
// ============================================================================

export async function listMyLessonSessions(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const status = typeof req.query?.status === "string" ? req.query.status : null;
    const from = typeof req.query?.from === "string" ? req.query.from : null;
    const to = typeof req.query?.to === "string" ? req.query.to : null;

    // Optional ?limit (default 200, max 500) — prevents unbounded scans.
    const LS_DEFAULT_LIMIT = 200;
    const LS_MAX_LIMIT     = 500;
    const rawLsLimit = req.query?.limit != null ? Math.trunc(Number(req.query.limit)) : LS_DEFAULT_LIMIT;
    const lsLimit = Number.isFinite(rawLsLimit) && rawLsLimit > 0 && rawLsLimit <= LS_MAX_LIMIT
      ? rawLsLimit
      : LS_DEFAULT_LIMIT;

    const validStatuses = new Set(["pending", "scheduled", "completed", "cancelled", "no_show", "approved", "rejected"]);
    if (status && !validStatuses.has(status)) return badRequest(res, "Invalid status filter");

    let sql = `
      SELECT
        ls.id,
        ls.teacher_id,
        ls.subject_id,
        ls.system_id,
        ls.stage_id,
        ls.grade_level_id,
        ls.schedule_id,
        ls.starts_at,
        ls.ends_at,
        ls.is_group,
        ls.max_students,
        ls.created_by_user_id,
        ls.student_id,
        ls.status,
        ls.cancel_reason,
        ls.created_at,
        ls.exception_id,
        s.name_en AS subject_name_en,
        s.name_ar AS subject_name_ar,
        COALESCE(lsc.cnt, 0) AS students_count
      FROM lesson_sessions ls
      JOIN subjects s ON s.id = ls.subject_id
      LEFT JOIN (
        SELECT session_id, COUNT(*) AS cnt
        FROM lesson_session_students
        GROUP BY session_id
      ) lsc ON lsc.session_id = ls.id
      WHERE ls.teacher_id = ?
    `;
    const params = [ctx.teacherId];

    if (status) {
      sql += ` AND ls.status = ?`;
      params.push(status);
    }
    if (from) {
      if (!isValidDateTimeStr(from)) return badRequest(res, "from must be a datetime string");
      sql += ` AND ls.starts_at >= ?`;
      params.push(toSqlDateTime(from));
    }
    if (to) {
      if (!isValidDateTimeStr(to)) return badRequest(res, "to must be a datetime string");
      sql += ` AND ls.starts_at <= ?`;
      params.push(toSqlDateTime(to));
    }

    sql += ` ORDER BY ls.starts_at DESC, ls.id DESC LIMIT ?`;
    params.push(lsLimit);

    const [rows] = await conn.query(sql, params);
    return res.json({ ok: true, data: rows });
  } catch (err) {
    logErr("listMyLessonSessions", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function getLessonSessionDetails(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const sessionId = toInt(req.params?.sessionId ?? req.query?.session_id);
    if (!sessionId || sessionId <= 0) return badRequest(res, "sessionId is required");

    const [sRows] = await conn.query(
      `SELECT
         ls.*,
         s.name_en AS subject_name_en,
         s.name_ar AS subject_name_ar
       FROM lesson_sessions ls
       JOIN subjects s ON s.id = ls.subject_id
       WHERE ls.id = ? AND ls.teacher_id = ?
       LIMIT 1`,
      [sessionId, ctx.teacherId]
    );

    const session = sRows?.[0];
    if (!session) return notFound(res, "Session not found");

    const [students] = await conn.query(
      `SELECT
         lss.id,
         lss.student_id,
         lss.attendance_status,
         lss.joined_at,
         lss.left_at,
         st.user_id,
         u.full_name AS student_name,
         u.email AS student_email
       FROM lesson_session_students lss
       JOIN students st ON st.id = lss.student_id
       JOIN users u ON u.id = st.user_id
       WHERE lss.session_id = ?
       ORDER BY u.full_name ASC, lss.id ASC`,
      [sessionId]
    );

    return res.json({ ok: true, data: { session, students } });
  } catch (err) {
    logErr("getLessonSessionDetails", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function updateStudentAttendance(req, res) {
  const conn = await pool.getConnection();
  let txStarted = false;
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const sessionId = toInt(req.body?.session_id ?? req.params?.sessionId);
    const studentId = toInt(req.body?.student_id ?? req.params?.studentId);
    const attendanceStatus = String(req.body?.attendance_status || "").trim().toLowerCase();

    if (!sessionId || sessionId <= 0) return badRequest(res, "session_id is required");
    if (!studentId || studentId <= 0) return badRequest(res, "student_id is required");
    if (!ATTENDANCE_STATUSES.has(attendanceStatus)) {
      return badRequest(res, "Invalid attendance_status");
    }

    await conn.beginTransaction();
    txStarted = true;

    const [sessionRows] = await conn.query(
      `
      SELECT
        ls.id,
        ls.teacher_id,
        ls.status,
        ls.starts_at,
        ls.ends_at,
        ls.is_group,
        (
          SELECT COUNT(*)
          FROM lesson_session_students lssc
          WHERE lssc.session_id = ls.id
        ) AS students_count,
        (NOW() >= ls.starts_at) AS has_started,
        (NOW() >= ls.ends_at) AS has_ended
      FROM lesson_sessions ls
      WHERE ls.id = ?
        AND ls.teacher_id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [sessionId, ctx.teacherId]
    );

    const session = sessionRows?.[0];
    if (!session) {
      await conn.rollback();
      txStarted = false;
      return notFound(res, "Session not found");
    }

    const currentSessionStatus = normalizeLessonSessionStatus(session.status);
    const [attendanceRows] = await conn.query(
      `
      SELECT attendance_status
      FROM lesson_session_students
      WHERE session_id = ?
        AND student_id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [sessionId, studentId]
    );

    const attendanceRow = attendanceRows?.[0];
    if (!attendanceRow) {
      await conn.rollback();
      txStarted = false;
      return notFound(res, "Student not found in this session");
    }

    const currentAttendanceStatus = String(attendanceRow.attendance_status || "")
      .trim()
      .toLowerCase();
    const hasStarted = Number(session.has_started) === 1;
    const hasEnded = Number(session.has_ended) === 1;
    const canFinalizeSession = hasEnded && canFinalizeAttendanceForSession(session);
    const requestedTerminalStatus = canFinalizeSession
      ? deriveTerminalSessionStatusFromAttendance(attendanceStatus)
      : null;

    if (currentSessionStatus === "cancelled" || currentSessionStatus === "rejected") {
      await conn.rollback();
      txStarted = false;
      return badRequest(
        res,
        "Attendance cannot be updated for cancelled or rejected lesson sessions."
      );
    }

    if (currentSessionStatus === "completed" || currentSessionStatus === "no_show") {
      if (currentAttendanceStatus === attendanceStatus) {
        await conn.rollback();
        txStarted = false;
        return res.json({ ok: true, message: "Attendance updated" });
      }

      if (!requestedTerminalStatus || requestedTerminalStatus !== currentSessionStatus) {
        await conn.rollback();
        txStarted = false;
        return badRequest(res, "Attendance cannot change a finalized lesson session.");
      }
    } else if (!ATTENDANCE_MUTABLE_SESSION_STATUSES.has(currentSessionStatus)) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Attendance can only be updated for scheduled or approved lesson sessions.");
    }

    if (!hasStarted) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Attendance can only be updated after the session starts.");
    }

    const [upd] = await conn.query(
      `UPDATE lesson_session_students
       SET attendance_status = ?
       WHERE session_id = ? AND student_id = ?`,
      [attendanceStatus, sessionId, studentId]
    );

    if (!upd.affectedRows) {
      await conn.rollback();
      txStarted = false;
      return notFound(res, "Student not found in this session");
    }

    if (
      requestedTerminalStatus &&
      ATTENDANCE_MUTABLE_SESSION_STATUSES.has(currentSessionStatus)
    ) {
      await conn.query(
        `
        UPDATE lesson_sessions
        SET status = ?,
            updated_by_user_id = ?
        WHERE id = ?
          AND teacher_id = ?
          AND status IN ('scheduled', 'approved')
        `,
        [requestedTerminalStatus, ctx.userId, sessionId, ctx.teacherId]
      );
    }

    await conn.commit();
    txStarted = false;
    return res.json({ ok: true, message: "Attendance updated" });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    logErr("updateStudentAttendance", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

// ============================================================================
// HOMEWORK
// ============================================================================

export async function createHomework(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const subjectId = toInt(req.body?.subject_id);
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const description = typeof req.body?.description === "string" ? req.body.description.trim() : null;
    const dueAt = req.body?.due_at;
    const maxScore = req.body?.max_score == null ? null : toInt(req.body?.max_score);
    const attachmentsUrl = typeof req.body?.attachments_url === "string" ? req.body.attachments_url.trim() : null;
    const isActive = toBoolTinyInt(req.body?.is_active) ?? 1;

    if (!subjectId || subjectId <= 0) return badRequest(res, "subject_id is required");
    if (!title) return badRequest(res, "title is required");
    if (!dueAt || !isValidDateTimeStr(dueAt)) return badRequest(res, "due_at must be a datetime string");
    if (maxScore != null && maxScore <= 0) return badRequest(res, "max_score must be positive if provided");

    const [ins] = await conn.query(
      `INSERT INTO homework_assignments
       (teacher_id, subject_id, title, description, due_at, max_score, attachments_url, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [ctx.teacherId, subjectId, title, description, toSqlDateTime(dueAt), maxScore, attachmentsUrl, isActive]
    );

    return res.json({ ok: true, message: "Homework created", id: ins.insertId });
  } catch (err) {
    logErr("createHomework", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function listMyHomework(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    // Optional ?limit (default 100, max 200) — prevents unbounded scans.
    const HW_DEFAULT_LIMIT = 100;
    const HW_MAX_LIMIT     = 200;
    const rawHwLimit = req.query?.limit != null ? Math.trunc(Number(req.query.limit)) : HW_DEFAULT_LIMIT;
    const hwLimit = Number.isFinite(rawHwLimit) && rawHwLimit > 0 && rawHwLimit <= HW_MAX_LIMIT
      ? rawHwLimit
      : HW_DEFAULT_LIMIT;

    const [rows] = await conn.query(
      `SELECT ha.*, s.name_en AS subject_name_en, s.name_ar AS subject_name_ar
       FROM homework_assignments ha
       JOIN subjects s ON s.id = ha.subject_id
       WHERE ha.teacher_id = ?
       ORDER BY ha.created_at DESC, ha.id DESC
       LIMIT ?`,
      [ctx.teacherId, hwLimit]
    );

    return res.json({ ok: true, data: rows });
  } catch (err) {
    logErr("listMyHomework", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function updateHomework(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const homeworkId = toInt(req.params?.homeworkId ?? req.body?.homework_id);
    if (!homeworkId || homeworkId <= 0) return badRequest(res, "homeworkId is required");

    const [curRows] = await conn.query(`SELECT * FROM homework_assignments WHERE id = ? AND teacher_id = ? LIMIT 1`, [
      homeworkId,
      ctx.teacherId,
    ]);
    const current = curRows?.[0];
    if (!current) return notFound(res, "Homework not found");

    const subjectId = req.body?.subject_id == null ? current.subject_id : toInt(req.body.subject_id);
    const title = req.body?.title == null ? current.title : String(req.body.title).trim();
    const description =
      req.body?.description === undefined ? current.description : typeof req.body.description === "string" ? req.body.description.trim() : null;
    const dueAt = req.body?.due_at == null ? current.due_at : req.body.due_at;
    const maxScore = req.body?.max_score === undefined ? current.max_score : req.body.max_score == null ? null : toInt(req.body.max_score);
    const attachmentsUrl =
      req.body?.attachments_url === undefined
        ? current.attachments_url
        : typeof req.body.attachments_url === "string"
        ? req.body.attachments_url.trim()
        : null;
    const isActive = req.body?.is_active == null ? current.is_active : toBoolTinyInt(req.body.is_active) ?? current.is_active;

    if (!subjectId || subjectId <= 0) return badRequest(res, "subject_id must be positive");
    if (!title) return badRequest(res, "title cannot be empty");
    if (!dueAt || !isValidDateTimeStr(dueAt)) return badRequest(res, "due_at must be a datetime string");
    if (maxScore != null && maxScore <= 0) return badRequest(res, "max_score must be positive if provided");

    await conn.query(
      `UPDATE homework_assignments
       SET subject_id = ?, title = ?, description = ?, due_at = ?, max_score = ?, attachments_url = ?, is_active = ?
       WHERE id = ? AND teacher_id = ?`,
      [subjectId, title, description, toSqlDateTime(dueAt), maxScore, attachmentsUrl, isActive, homeworkId, ctx.teacherId]
    );

    return res.json({ ok: true, message: "Homework updated" });
  } catch (err) {
    logErr("updateHomework", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function listHomeworkSubmissions(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const homeworkId = toInt(req.query?.homework_id ?? req.params?.homeworkId);
    if (!homeworkId || homeworkId <= 0) return badRequest(res, "homework_id is required");

    const [own] = await conn.query(`SELECT id FROM homework_assignments WHERE id = ? AND teacher_id = ? LIMIT 1`, [
      homeworkId,
      ctx.teacherId,
    ]);
    if (!own.length) return notFound(res, "Homework not found");

    const [rows] = await conn.query(
      `SELECT
         hs.*,
         u.full_name AS student_name,
         u.email AS student_email
       FROM homework_submissions hs
       JOIN students st ON st.id = hs.student_id
       JOIN users u ON u.id = st.user_id
       WHERE hs.homework_id = ?
       ORDER BY hs.created_at DESC, hs.id DESC`,
      [homeworkId]
    );

    return res.json({ ok: true, data: rows });
  } catch (err) {
    logErr("listHomeworkSubmissions", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function gradeHomeworkSubmission(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const submissionId = toInt(req.params?.submissionId ?? req.body?.submission_id);
    const score = req.body?.score == null ? null : Number(req.body.score);
    const feedback = typeof req.body?.feedback === "string" ? req.body.feedback.trim() : null;

    if (!submissionId || submissionId <= 0) return badRequest(res, "submissionId is required");
    if (score != null && !Number.isFinite(score)) return badRequest(res, "score must be a number");

    const [rows] = await conn.query(
      `SELECT hs.id
       FROM homework_submissions hs
       JOIN homework_assignments ha ON ha.id = hs.homework_id
       WHERE hs.id = ? AND ha.teacher_id = ?
       LIMIT 1`,
      [submissionId, ctx.teacherId]
    );
    if (!rows.length) return notFound(res, "Submission not found");

    await conn.query(
      `UPDATE homework_submissions
       SET score = ?, feedback = ?, status = 'graded'
       WHERE id = ?`,
      [score, feedback, submissionId]
    );

    return res.json({ ok: true, message: "Submission graded" });
  } catch (err) {
    logErr("gradeHomeworkSubmission", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

// ============================================================================
// QUIZZES
// ============================================================================

export async function createQuiz(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const subjectId = toInt(req.body?.subject_id);
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const description = typeof req.body?.description === "string" ? req.body.description.trim() : null;
    const availableFrom = req.body?.available_from;
    const availableUntil = req.body?.available_until;
    const timeLimitMin = req.body?.time_limit_min == null ? null : toInt(req.body?.time_limit_min);
    const maxScore = req.body?.max_score == null ? null : toInt(req.body?.max_score);
    const isActive = toBoolTinyInt(req.body?.is_active) ?? 1;

    if (!subjectId || subjectId <= 0) return badRequest(res, "subject_id is required");
    if (!title) return badRequest(res, "title is required");
    if (!availableFrom || !isValidDateTimeStr(availableFrom)) return badRequest(res, "available_from must be a datetime string");
    if (!availableUntil || !isValidDateTimeStr(availableUntil)) return badRequest(res, "available_until must be a datetime string");

    const fromSql = toSqlDateTime(availableFrom);
    const untilSql = toSqlDateTime(availableUntil);
    if (!fromSql || !untilSql) return badRequest(res, "available_from/available_until datetime format invalid");
    if (fromSql >= untilSql) return badRequest(res, "available_from must be before available_until");

    if (timeLimitMin != null && timeLimitMin <= 0) return badRequest(res, "time_limit_min must be positive if provided");
    if (maxScore != null && maxScore <= 0) return badRequest(res, "max_score must be positive if provided");

    const [ins] = await conn.query(
      `INSERT INTO quiz_assignments
       (teacher_id, subject_id, title, description, available_from, available_until, time_limit_min, max_score, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ctx.teacherId, subjectId, title, description, fromSql, untilSql, timeLimitMin, maxScore, isActive]
    );

    return res.json({ ok: true, message: "Quiz created", id: ins.insertId });
  } catch (err) {
    logErr("createQuiz", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function listMyQuizzes(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    // Optional ?limit (default 100, max 200) — prevents unbounded scans.
    const QZ_DEFAULT_LIMIT = 100;
    const QZ_MAX_LIMIT     = 200;
    const rawQzLimit = req.query?.limit != null ? Math.trunc(Number(req.query.limit)) : QZ_DEFAULT_LIMIT;
    const qzLimit = Number.isFinite(rawQzLimit) && rawQzLimit > 0 && rawQzLimit <= QZ_MAX_LIMIT
      ? rawQzLimit
      : QZ_DEFAULT_LIMIT;

    const [rows] = await conn.query(
      `SELECT qa.*, s.name_en AS subject_name_en, s.name_ar AS subject_name_ar
       FROM quiz_assignments qa
       JOIN subjects s ON s.id = qa.subject_id
       WHERE qa.teacher_id = ?
       ORDER BY qa.created_at DESC, qa.id DESC
       LIMIT ?`,
      [ctx.teacherId, qzLimit]
    );

    return res.json({ ok: true, data: rows });
  } catch (err) {
    logErr("listMyQuizzes", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function updateQuiz(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const quizId = toInt(req.params?.quizId ?? req.body?.quiz_id);
    if (!quizId || quizId <= 0) return badRequest(res, "quizId is required");

    const [curRows] = await conn.query(`SELECT * FROM quiz_assignments WHERE id = ? AND teacher_id = ? LIMIT 1`, [
      quizId,
      ctx.teacherId,
    ]);
    const current = curRows?.[0];
    if (!current) return notFound(res, "Quiz not found");

    const subjectId = req.body?.subject_id == null ? current.subject_id : toInt(req.body.subject_id);
    const title = req.body?.title == null ? current.title : String(req.body.title).trim();
    const description =
      req.body?.description === undefined ? current.description : typeof req.body.description === "string" ? req.body.description.trim() : null;
    const availableFrom = req.body?.available_from == null ? current.available_from : req.body.available_from;
    const availableUntil = req.body?.available_until == null ? current.available_until : req.body.available_until;
    const timeLimitMin =
      req.body?.time_limit_min === undefined ? current.time_limit_min : req.body.time_limit_min == null ? null : toInt(req.body.time_limit_min);
    const maxScore = req.body?.max_score === undefined ? current.max_score : req.body.max_score == null ? null : toInt(req.body.max_score);
    const isActive = req.body?.is_active == null ? current.is_active : toBoolTinyInt(req.body.is_active) ?? current.is_active;

    if (!subjectId || subjectId <= 0) return badRequest(res, "subject_id must be positive");
    if (!title) return badRequest(res, "title cannot be empty");
    if (!availableFrom || !isValidDateTimeStr(availableFrom)) return badRequest(res, "available_from must be a datetime string");
    if (!availableUntil || !isValidDateTimeStr(availableUntil)) return badRequest(res, "available_until must be a datetime string");

    const fromSql = toSqlDateTime(availableFrom);
    const untilSql = toSqlDateTime(availableUntil);
    if (!fromSql || !untilSql) return badRequest(res, "available_from/available_until datetime format invalid");
    if (fromSql >= untilSql) return badRequest(res, "available_from must be before available_until");

    if (timeLimitMin != null && timeLimitMin <= 0) return badRequest(res, "time_limit_min must be positive if provided");
    if (maxScore != null && maxScore <= 0) return badRequest(res, "max_score must be positive if provided");

    await conn.query(
      `UPDATE quiz_assignments
       SET subject_id = ?, title = ?, description = ?, available_from = ?, available_until = ?, time_limit_min = ?, max_score = ?, is_active = ?
       WHERE id = ? AND teacher_id = ?`,
      [subjectId, title, description, fromSql, untilSql, timeLimitMin, maxScore, isActive, quizId, ctx.teacherId]
    );

    return res.json({ ok: true, message: "Quiz updated" });
  } catch (err) {
    logErr("updateQuiz", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function listQuizSubmissions(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const quizId = toInt(req.query?.quiz_id ?? req.params?.quizId);
    if (!quizId || quizId <= 0) return badRequest(res, "quiz_id is required");

    const [own] = await conn.query(`SELECT id FROM quiz_assignments WHERE id = ? AND teacher_id = ? LIMIT 1`, [
      quizId,
      ctx.teacherId,
    ]);
    if (!own.length) return notFound(res, "Quiz not found");

    const [rows] = await conn.query(
      `SELECT
         qs.*,
         u.full_name AS student_name,
         u.email AS student_email
       FROM quiz_submissions qs
       JOIN students st ON st.id = qs.student_id
       JOIN users u ON u.id = st.user_id
       WHERE qs.quiz_id = ?
       ORDER BY qs.created_at DESC, qs.id DESC`,
      [quizId]
    );

    const parsed = rows.map((r) => {
      let answers = null;
      if (typeof r.answers_json === "string" && r.answers_json.trim()) {
        try {
          answers = JSON.parse(r.answers_json);
        } catch (_) {
          answers = null;
        }
      }
      return { ...r, answers };
    });

    return res.json({ ok: true, data: parsed });
  } catch (err) {
    logErr("listQuizSubmissions", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export async function gradeQuizSubmission(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const submissionId = toInt(req.params?.submissionId ?? req.body?.submission_id);
    const score = req.body?.score == null ? null : Number(req.body.score);

    if (!submissionId || submissionId <= 0) return badRequest(res, "submissionId is required");
    if (score != null && !Number.isFinite(score)) return badRequest(res, "score must be a number");

    const [rows] = await conn.query(
      `SELECT qs.id
       FROM quiz_submissions qs
       JOIN quiz_assignments qa ON qa.id = qs.quiz_id
       WHERE qs.id = ? AND qa.teacher_id = ?
       LIMIT 1`,
      [submissionId, ctx.teacherId]
    );
    if (!rows.length) return notFound(res, "Submission not found");

    await conn.query(`UPDATE quiz_submissions SET score = ?, status = 'graded' WHERE id = ?`, [score, submissionId]);

    return res.json({ ok: true, message: "Quiz submission graded" });
  } catch (err) {
    logErr("gradeQuizSubmission", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

// ============================================================================
// Students (student_teacher_selections)
// ============================================================================

export async function listMyStudents(req, res) {
  const conn = await pool.getConnection();
  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const status = typeof req.query?.status === "string" ? req.query.status : null;

    // Optional ?limit (default 200, max 500) — prevents unbounded scans.
    const ST_DEFAULT_LIMIT = 200;
    const ST_MAX_LIMIT     = 500;
    const rawStLimit = req.query?.limit != null ? Math.trunc(Number(req.query.limit)) : ST_DEFAULT_LIMIT;
    const stLimit = Number.isFinite(rawStLimit) && rawStLimit > 0 && rawStLimit <= ST_MAX_LIMIT
      ? rawStLimit
      : ST_DEFAULT_LIMIT;

    let sql = `
      SELECT
        sts.id,
        sts.student_id,
        sts.subject_id,
        sts.teacher_id,
        sts.selected_by,
        sts.status,
        sts.selected_at,
        u.full_name AS student_name,
        u.email AS student_email,
        s.name_en AS subject_name_en,
        s.name_ar AS subject_name_ar
      FROM student_teacher_selections sts
      JOIN students st ON st.id = sts.student_id
      JOIN users u ON u.id = st.user_id
      JOIN subjects s ON s.id = sts.subject_id
      WHERE sts.teacher_id = ?
    `;
    const params = [ctx.teacherId];

    if (status) {
      sql += ` AND sts.status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY sts.selected_at DESC, sts.id DESC LIMIT ?`;
    params.push(stLimit);

    const [rows] = await conn.query(sql, params);
    return res.json({ ok: true, data: rows });
  } catch (err) {
    logErr("listMyStudents", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

async function loadAnnouncementsForAudience(audience) {
  const [rows] = await pool.query(
    `
    SELECT id, title, body, audience, created_at
    FROM announcements
    WHERE audience IN ('all', ?)
    ORDER BY created_at DESC
    LIMIT 50
    `,
    [audience]
  );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    audience: r.audience,
    createdAt: r.created_at,
  }));
}

async function loadNotificationsForUser(userId) {
  const [countRows] = await pool.query(
    `
    SELECT COUNT(*) AS unread_count
    FROM notifications
    WHERE user_id = ?
      AND is_read = 0
    `,
    [userId]
  );
  const unreadCount = countRows?.[0]?.unread_count || 0;

  const [items] = await pool.query(
    `
    SELECT id, type, title, body, related_type, related_id, is_read, read_at, created_at
    FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 50
    `,
    [userId]
  );

  return {
    unreadCount,
    items: items.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      relatedType: r.related_type,
      relatedId: r.related_id,
      isRead: !!r.is_read,
      readAt: r.read_at ?? null,
      createdAt: r.created_at ?? null,
    })),
  };
}

export const getTeacherAnnouncements = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const data = await loadAnnouncementsForAudience("teachers");
    return res.json({ success: true, data });
  } catch (err) {
    return internalError(res, err, "getTeacherAnnouncements");
  }
};

export const getTeacherNotifications = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const data = await loadNotificationsForUser(userId);
    return res.json({ success: true, data });
  } catch (err) {
    return internalError(res, err, "getTeacherNotifications");
  }
};

export const markTeacherNotificationRead = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const id = Number(req.params?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ success: false, message: "Invalid notification id." });
    }

    const [result] = await pool.query(
      `
      UPDATE notifications
      SET is_read = 1, read_at = NOW()
      WHERE id = ?
        AND user_id = ?
      `,
      [id, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Notification not found." });
    }

    return res.json({ success: true, message: "Notification marked as read." });
  } catch (err) {
    return internalError(res, err, "markTeacherNotificationRead");
  }
};

// =============================================================================
// Cancel a SCHEDULED lesson session (teacher-initiated).
// Cutoff: session must start more than CANCEL_CUTOFF_HOURS in the future.
// =============================================================================
const CANCEL_CUTOFF_HOURS = 2;

export async function cancelMyLessonSession(req, res) {
  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    const ctx = await requireTeacherContext(conn, req, res);
    if (!ctx.ok) return;

    const sessionId = toInt(req.params?.sessionId ?? req.params?.id ?? req.body?.session_id);
    if (!sessionId || sessionId <= 0) return badRequest(res, "Valid sessionId is required.");

    const reasonRaw = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const reason = reasonRaw ? reasonRaw.slice(0, 250) : null;

    await conn.beginTransaction();
    txStarted = true;

    // Lock the session row
    const [[session]] = await conn.query(
      `SELECT id, teacher_id, status, student_id, starts_at, created_by_user_id
         FROM lesson_sessions
        WHERE id = ? AND teacher_id = ?
        FOR UPDATE`,
      [sessionId, ctx.teacherId]
    );

    if (!session) {
      await conn.rollback();
      txStarted = false;
      return notFound(res, "Lesson session not found.");
    }

    if (!FUTURE_SESSION_STATUSES.has(session.status)) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Only scheduled sessions can be cancelled.");
    }

    // Cutoff check: must be > CANCEL_CUTOFF_HOURS hours in the future (DB-side)
    const [[timeCheck]] = await conn.query(
      `SELECT (? > DATE_ADD(NOW(), INTERVAL ? HOUR)) AS is_eligible`,
      [session.starts_at, CANCEL_CUTOFF_HOURS]
    );

    if (!timeCheck?.is_eligible) {
      await conn.rollback();
      txStarted = false;
      return badRequest(
        res,
        `Cancellation is only allowed more than ${CANCEL_CUTOFF_HOURS} hours before the session starts.`
      );
    }

    // Perform cancellation using schema-backed cancellation fields only.
    const [u1] = await conn.query(
      `UPDATE lesson_sessions
          SET status        = 'cancelled',
              cancel_reason  = COALESCE(?, cancel_reason),
              cancelled_by   = 'teacher',
              cancelled_at   = NOW(),
              updated_by_user_id = ?
        WHERE id     = ?
          AND teacher_id = ?
          AND status IN ('scheduled', 'approved')`,
      [reason, ctx.userId, sessionId, ctx.teacherId]
    );

    if (!u1 || u1.affectedRows === 0) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Unable to cancel this session (it may have changed).");
    }

    // Notify the student (best-effort, via created_by_user_id)
    if (session.created_by_user_id) {
      await insertNotificationSafe(conn, {
        userId: session.created_by_user_id,
        title: "Lesson session cancelled by teacher",
        body: `Your scheduled session (#${sessionId}) has been cancelled by the teacher.${reason ? ` Reason: ${reason}` : ""}`,
        relatedType: "lesson_session",
        relatedId: sessionId,
        extraData: { kind: "lesson_cancelled", sessionId, cancelledBy: "teacher", reason: reason ?? null },
      });
    }

    await conn.commit();
    txStarted = false;

    return res.json({ ok: true, message: "Session cancelled.", data: { sessionId, status: "cancelled" } });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    logErr("cancelMyLessonSession", err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

export const markAllTeacherNotificationsRead = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    await pool.query(
      `
      UPDATE notifications
      SET is_read = 1, read_at = NOW()
      WHERE user_id = ?
        AND is_read = 0
      `,
      [userId]
    );

    return res.json({ success: true, message: "All notifications marked as read." });
  } catch (err) {
    return internalError(res, err, "markAllTeacherNotificationsRead");
  }
};
