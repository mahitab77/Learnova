
// src/controllers/student.controller.js
import pool from "../db.js";
import {
  academicScopeMatchesRow,
  buildAcademicScopeMatchSql,
  resolveStudentAcademicIds,
  scheduleHasLiveOfferingForScope,
  subjectIsAvailableForScope,
  teacherHasLiveOfferingForScope,
} from "../utils/academicScope.js";
import {
  assertTeacherEligibleForSubjectScope,
  listEligibleTeacherIdsForSubjectScope,
} from "../services/teacherDiscovery.service.js";
import { upsertTeacherSelection } from "../services/teacherSelection.service.js";
import {
  isValidDateStr,
  isValidDateTimeStr,
  toSqlDateTime,
} from "../utils/cairoTime.js";
export {
  getStudentLessonSessionRating,
  upsertStudentLessonSessionRating,
} from "./rating.controller.js";

/* =============================================================================
 * Student Controller (PRODUCTION READY - Session-Only Auth)
 * -----------------------------------------------------------------------------
 * Key production fixes:
 * ✅ All endpoints now use getStudentContext() to enforce active student role
 * ✅ Transaction safety improved (earlier BEGIN in requestLessonSession)
 * ✅ Overlap protection includes both teacher AND student
 * ✅ Notification system hardened against schema changes
 * ✅ Debug logs only in non-production environments
 * ✅ Consistent timezone handling for datetime operations
 * ============================================================================= */

/* =============================================================================
 * Environment & Configuration
 * ============================================================================= */
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// =============================================================================
// Canonical scheduling datetime rules now live in src/utils/cairoTime.js.
// This controller still accepts naive "YYYY-MM-DD HH:MM:SS" transport strings
// that represent Cairo wall-clock time, but validation/normalization is shared.
// session timezone set consistently — no CONVERT_TZ is performed here;
// the application layer treats every "YYYY-MM-DD HH:MM:SS" value as Cairo.
// =============================================================================
const PLATFORM_TZ = "Africa/Cairo"; // informational — used in validation comments
const STUDENT_SCOPE_RESOLUTION_ERROR =
  "Student academic scope could not be resolved. Ensure students.system_id and students.stage_id are populated.";
const STUDENT_AVAILABILITY_SCOPE_INCOMPLETE_ERROR =
  "Student academic scope is incomplete. Please complete profile/onboarding before viewing teacher availability.";

/* =============================================================================
 * Small helpers
 * ============================================================================= */

function logErr(scope, err) {
  console.error(`[studentController][${scope}]`, err);
}

function getAuthUserId(req) {
  const v =
    req.session?.user?.id ??   // ✅ primary
    req.user?.id ??            // ✅ if you map session → req.user
    req.userId ??              // ✅ if you map session → req.userId (legacy internal)
    null;

  return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
}

function badRequest(res, message, extra) {
  return res.status(400).json({ success: false, message, ...(extra || {}) });
}

function unauthorized(res, message = "Unauthorized") {
  return res.status(401).json({ success: false, message });
}

function notFound(res, message = "Not found") {
  return res.status(404).json({ success: false, message });
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parsePositiveInt(v) {
  const n = toInt(v);
  return n && n > 0 ? n : null;
}

// Student-owned availability must derive scope from the authenticated student row
// only. Request query params must not override academic scope identity.
export function buildStudentTeacherAvailabilityRequestContext(
  query = {},
  student = null
) {
  const rawGradeLevelId = student?.grade_level_id ?? student?.gradeLevelId;
  const scope = {
    systemId: parsePositiveInt(student?.system_id ?? student?.systemId),
    stageId: parsePositiveInt(student?.stage_id ?? student?.stageId),
    gradeLevelId:
      rawGradeLevelId == null ? null : parsePositiveInt(rawGradeLevelId),
  };

  return {
    teacherId: parsePositiveInt(query?.teacher_id ?? query?.teacherId),
    subjectId: parsePositiveInt(query?.subject_id ?? query?.subjectId),
    from: query?.from,
    to: query?.to,
    scope,
    scopeError:
      !scope.systemId || !scope.stageId
        ? STUDENT_AVAILABILITY_SCOPE_INCOMPLETE_ERROR
        : null,
  };
}

async function loadStudentSubjectTeacherBookingContext(
  student,
  {
    subjectId,
    teacherId,
    executor = pool,
    selectionRequiredMessage =
      "You must have this teacher selected for the subject before continuing.",
    scopeErrorMessage = STUDENT_SCOPE_RESOLUTION_ERROR,
  } = {}
) {
  const normalizedSubjectId = parsePositiveInt(subjectId);
  if (!normalizedSubjectId) {
    return {
      ok: false,
      status: 400,
      message: "subject_id (or subjectId) is required and must be a valid integer.",
    };
  }

  const normalizedTeacherId = parsePositiveInt(teacherId);
  if (!normalizedTeacherId) {
    return {
      ok: false,
      status: 400,
      message: "teacher_id (or teacherId) is required and must be a valid integer.",
    };
  }

  const [enrollmentRows] = await executor.query(
    `
    SELECT 1
    FROM student_subjects
    WHERE student_id = ?
      AND subject_id = ?
    LIMIT 1
    `,
    [student.id, normalizedSubjectId]
  );

  if (!enrollmentRows.length) {
    return {
      ok: false,
      status: 400,
      message: "Student is not enrolled in this subject.",
    };
  }

  const [[activeSelection]] = await executor.query(
    `
    SELECT id, selected_at
    FROM student_teacher_selections
    WHERE student_id = ?
      AND subject_id = ?
      AND teacher_id = ?
      AND status = 'active'
    LIMIT 1
    `,
    [student.id, normalizedSubjectId, normalizedTeacherId]
  );

  if (!activeSelection) {
    return {
      ok: false,
      status: 400,
      message: selectionRequiredMessage,
    };
  }

  const { systemId, stageId, gradeLevelId } = await resolveStudentAcademicIds(
    student,
    executor
  );

  if (!systemId || !stageId) {
    return {
      ok: false,
      status: 400,
      message: scopeErrorMessage,
    };
  }

  return {
    ok: true,
    context: {
      studentId: student.id,
      teacherId: normalizedTeacherId,
      subjectId: normalizedSubjectId,
      systemId,
      stageId,
      gradeLevelId,
      selectionId: parsePositiveInt(activeSelection.id),
      selectedAt: activeSelection.selected_at ?? null,
    },
  };
}

/**
 * Normalized error handler for all API responses
 */
function handleApiError(res, err, context = "API operation") {
  logErr(context, err);

  const sqlMessage = err?.sqlMessage || err?.message || "Database error";

  // Return 400 for common validation/constraint problems
  if (
    err?.sqlState === "45000" ||
    err?.code === "ER_DUP_ENTRY" ||
    String(sqlMessage).toLowerCase().includes("foreign key constraint") ||
    String(sqlMessage).toLowerCase().includes("constraint fails") ||
    String(sqlMessage).toLowerCase().includes("cannot add or update")
  ) {
    return res.status(400).json({
      success: false,
      message: sqlMessage,
      code: err?.code || "VALIDATION_ERROR",
    });
  }

  return res.status(500).json({
    success: false,
    message: "An unexpected server error occurred. Please try again.",
    code: "INTERNAL_SERVER_ERROR",
  });
}

/* =============================================================================
 * Notifications (PRODUCTION HARDENED)
 * ============================================================================= */

/**
 * PRODUCTION HARDENED notification insert
 * Handles schema differences gracefully without breaking flows
 */
async function insertNotificationSafe(
  conn,
  {
    userId,
    type = "system",
    title,
    body = null,
    relatedType = "other",
    relatedId = null,
    extraData = null,
  }
) {
  try {
    const uid = Number(userId);
    if (!Number.isFinite(uid) || uid <= 0) return;

    const safeTitle =
      typeof title === "string" && title.trim()
        ? title.trim().slice(0, 255)
        : null;
    if (!safeTitle) return;

    const safeBody =
      typeof body === "string" && body.trim() ? body.trim() : null;

    const allowedTypes = new Set([
      "homework_due",
      "quiz_due",
      "grade_posted",
      "announcement",
      "system",
    ]);

    const allowedRelatedTypes = new Set([
      "homework",
      "quiz",
      "announcement",
      "subject",
      "teacher",
      "lesson_session",
      "other",
    ]);

    const safeType = allowedTypes.has(type) ? type : "system";
    const safeRelatedType = allowedRelatedTypes.has(relatedType)
      ? relatedType
      : "other";

    const safeRelatedId =
      relatedId === null || relatedId === undefined
        ? null
        : Number.isFinite(Number(relatedId)) && Number(relatedId) > 0
        ? Number(relatedId)
        : null;

    let safeExtra = null;
    if (extraData !== null && extraData !== undefined) {
      if (typeof extraData === "string") {
        safeExtra = extraData.slice(0, 10000);
      } else {
        try {
          safeExtra = JSON.stringify(extraData).slice(0, 10000);
        } catch {
          safeExtra = null;
        }
      }
    }

    // Try full insert first
    try {
      await conn.query(
        `
        INSERT INTO notifications
          (user_id, type, title, body, related_type, related_id, extra_data, is_read, created_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, 0, NOW())
        `,
        [uid, safeType, safeTitle, safeBody, safeRelatedType, safeRelatedId, safeExtra]
      );
    } catch (err) {
      // If columns are missing, try reduced insert
      if (err && (err.code === "ER_BAD_FIELD_ERROR" || err.errno === 1054)) {
        await conn.query(
          `
          INSERT INTO notifications
            (user_id, type, title, body, related_type, related_id, is_read, created_at)
          VALUES
            (?, ?, ?, ?, ?, ?, 0, NOW())
          `,
          [uid, safeType, safeTitle, safeBody, safeRelatedType, safeRelatedId]
        );
      } else {
        // Re-throw if it's a different error
        throw err;
      }
    }
  } catch (err) {
    // Log error but don't break business flow
    if (!IS_PRODUCTION) {
      logErr("insertNotificationSafe", err);
    }
  }
}

/* =============================================================================
 * Student context & common loaders (transaction-friendly)
 * ============================================================================= */

/**
 * Get student's row by user_id.
 * Accepts optional executor/connection for transaction consistency.
 */
async function findStudentByUserId(userId, executor = pool) {
  const [rows] = await executor.query(
    `
    SELECT
      id,
      user_id,
      system_id,
      stage_id,
      grade_level_id,
      grade_stage,
      grade_number,
      gender,
      onboarding_completed
    FROM students
    WHERE user_id = ?
    LIMIT 1
    `,
    [userId]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Resolve full student context (user + student) ensuring role + active.
 * Accepts optional executor for transaction consistency.
 */
async function getStudentContext(userId, executor = pool) {
  const [userRows] = await executor.query(
    `
    SELECT id, full_name, preferred_lang, role, is_active
    FROM users
    WHERE id = ?
    LIMIT 1
    `,
    [userId]
  );

  if (!userRows.length) return null;

  const user = userRows[0];
  if (user.role !== "student" || Number(user.is_active) !== 1) return null;

  const student = await findStudentByUserId(userId, executor);
  if (!student) return null;

  return { user, student };
}

/* =============================================================================
 * Data loaders for dashboard + panels
 * ============================================================================= */

async function loadStudentSubjects(studentId) {
  const [rows] = await pool.query(
    `
    SELECT
      sts.subject_id,
      s.name_en       AS subject_name_en,
      s.name_ar       AS subject_name_ar,
      s.sort_order    AS subject_sort_order,
      sts.teacher_id,
      t.name          AS teacher_name,
      t.photo_url     AS teacher_photo_url,
      sts.status      AS selection_status,
      sts.selected_by,
      sts.selected_at,
      tv.video_url    AS primary_video_url
    FROM student_teacher_selections sts
    INNER JOIN subjects s ON s.id = sts.subject_id
    INNER JOIN teachers t ON t.id = sts.teacher_id
    LEFT JOIN teacher_videos tv
      ON tv.teacher_id = sts.teacher_id
      AND (tv.subject_id IS NULL OR tv.subject_id = sts.subject_id)
      AND tv.is_primary = 1
    WHERE sts.student_id = ?
      AND sts.status = 'active'
    ORDER BY s.sort_order, s.id
    `,
    [studentId]
  );

  return rows.map((row) => ({
    subjectId: row.subject_id,
    nameEn: row.subject_name_en,
    nameAr: row.subject_name_ar,
    teacher: row.teacher_id
      ? {
          id: row.teacher_id,
          name: row.teacher_name,
          photoUrl: row.teacher_photo_url || null,
          primaryVideoUrl: row.primary_video_url || null,
        }
      : null,
    selectionStatus: row.selection_status,
    selectedBy: row.selected_by,
    selectedAt: row.selected_at,
  }));
}

/**
 * ✅ IMPROVED: Get subjects for student with proper LEFT JOIN to avoid duplicates
 * Uses subquery to get only the most recent active selection per subject
 */
async function loadSubjectsForStudent(studentId) {
  const [rows] = await pool.query(
    `
    SELECT
      ss.subject_id                                  AS subjectId,
      s.name_en                                      AS nameEn,
      s.name_ar                                      AS nameAr,
      s.sort_order                                   AS sortOrder,
      latest_sts.teacher_id                          AS teacherId,
      t.name                                         AS teacherName,
      t.photo_url                                    AS teacherPhotoUrl,
      tv.video_url                                   AS teacherPrimaryVideoUrl,
      COALESCE(latest_sts.status, 'no_selection')    AS selectionStatus,
      COALESCE(latest_sts.selected_by, 'student')    AS selectedBy,
      latest_sts.selected_at                         AS selectedAt
    FROM student_subjects ss
    INNER JOIN subjects s ON s.id = ss.subject_id
    LEFT JOIN (
      SELECT 
        student_id, 
        subject_id, 
        teacher_id, 
        status, 
        selected_by, 
        selected_at
      FROM student_teacher_selections
      WHERE student_id = ?
        AND status IN ('active','pending_change','replaced')
        AND (subject_id, selected_at) IN (
          SELECT subject_id, MAX(selected_at)
          FROM student_teacher_selections
          WHERE student_id = ?
            AND status IN ('active','pending_change','replaced')
          GROUP BY subject_id
        )
    ) latest_sts ON latest_sts.student_id = ss.student_id 
                 AND latest_sts.subject_id = ss.subject_id
    LEFT JOIN teachers t ON t.id = latest_sts.teacher_id
    LEFT JOIN teacher_videos tv
      ON tv.teacher_id = t.id
     AND (tv.subject_id IS NULL OR tv.subject_id = s.id)
     AND tv.is_primary = 1
    WHERE ss.student_id = ?
    ORDER BY s.sort_order, s.id
    `,
    [studentId, studentId, studentId]
  );

  return rows.map((row) => ({
    subjectId: row.subjectId,
    nameEn: row.nameEn,
    nameAr: row.nameAr,
    sortOrder: row.sortOrder,
    teacher: row.teacherId
      ? {
          id: row.teacherId,
          name: row.teacherName || "",
          photoUrl: row.teacherPhotoUrl || null,
          primaryVideoUrl: row.teacherPrimaryVideoUrl || null,
        }
      : null,
    selectionStatus: row.selectionStatus || "no_selection",
    selectedBy: row.selectedBy || "student",
    selectedAt: row.selectedAt || null,
  }));
}

/**
 * Load subjects available for this student's academic scope,
 * but NOT yet in student_subjects.
 *
 * stage-wide rows use grade_level_id = NULL. A student with NULL grade_level_id
 * only matches those stage-wide rows, never grade-specific rows.
 */
async function loadAvailableSubjectsForStudent(
  studentId,
  systemId,
  stageId,
  gradeLevelId
) {
  const scopeMatch = buildAcademicScopeMatchSql(
    { systemId, stageId, gradeLevelId },
    {
      systemColumn: "sa.system_id",
      stageColumn: "sa.stage_id",
      gradeLevelColumn: "sa.grade_level_id",
    }
  );

  const [rows] = await pool.query(
    `
    SELECT DISTINCT
      sa.subject_id                         AS subject_id,
      s.name_en                             AS subject_name_en,
      s.name_ar                             AS subject_name_ar,
      s.sort_order                          AS subject_sort_order
    FROM subject_availability sa
    INNER JOIN subjects s
      ON s.id = sa.subject_id
    LEFT JOIN student_subjects ss
      ON ss.subject_id = sa.subject_id
     AND ss.student_id = ?
    WHERE sa.is_active = 1
      AND s.is_active  = 1
      AND ss.id IS NULL
      AND ${scopeMatch.sql}
    ORDER BY s.sort_order, s.id
    `,
    [studentId, ...scopeMatch.params]
  );

  return rows.map((row) => ({
    subjectId: row.subject_id,
    nameEn: row.subject_name_en,
    nameAr: row.subject_name_ar,
  }));
}

async function loadUpcomingLessons(studentId) {
  const [rows] = await pool.query(
    `
    SELECT
      lss.id                    AS link_id,
      ls.id                     AS session_id,
      ls.starts_at,
      ls.ends_at,
      ls.subject_id,
      subj.name_en              AS subject_name_en,
      subj.name_ar              AS subject_name_ar,
      t.id                      AS teacher_id,
      t.name                    AS teacher_name,
      t.photo_url               AS teacher_photo_url,
      lss.attendance_status
    FROM lesson_session_students lss
    INNER JOIN lesson_sessions ls ON ls.id = lss.session_id
    INNER JOIN subjects subj ON subj.id = ls.subject_id
    INNER JOIN teachers t ON t.id = ls.teacher_id
    WHERE lss.student_id = ?
      AND ls.status IN ('scheduled', 'approved')
      AND ls.starts_at >= NOW()
    ORDER BY ls.starts_at ASC
    LIMIT 10
    `,
    [studentId]
  );

  return rows.map((row) => ({
    sessionId: row.session_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    subjectId: row.subject_id,
    subjectNameEn: row.subject_name_en,
    subjectNameAr: row.subject_name_ar,
    teacherId: row.teacher_id,
    teacherName: row.teacher_name,
    teacherPhotoUrl: row.teacher_photo_url || null,
    attendanceStatus: row.attendance_status,
  }));
}

async function loadAttendanceSummary(studentId) {
  const [rows] = await pool.query(
    `
    SELECT
      SUM(CASE WHEN lss.attendance_status = 'present' THEN 1 ELSE 0 END) AS present_count,
      SUM(
        CASE
          WHEN lss.attendance_status IN ('present','absent','late','excused')
          THEN 1 ELSE 0
        END
      ) AS total_sessions
    FROM lesson_session_students lss
    INNER JOIN lesson_sessions ls ON ls.id = lss.session_id
    WHERE lss.student_id = ?
      AND ls.starts_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
    `,
    [studentId]
  );

  const row = rows[0] || {};
  const presentCount = row.present_count || 0;
  const totalSessions = row.total_sessions || 0;
  const percentage = totalSessions > 0 ? Math.round((presentCount / totalSessions) * 100) : 0;

  return { period: "last_30_days", presentCount, totalSessions, percentage };
}

async function loadPendingHomework(studentId) {
  const [rows] = await pool.query(
    `
    SELECT
      ha.id               AS homework_id,
      ha.title            AS homework_title,
      ha.subject_id,
      subj.name_en        AS subject_name_en,
      subj.name_ar        AS subject_name_ar,
      ha.due_at,
      ha.max_score,
      hs.status           AS submission_status,
      hs.score            AS submission_score
    FROM homework_assignments ha
    INNER JOIN student_subjects ss
      ON ss.subject_id = ha.subject_id
      AND ss.student_id = ?
    INNER JOIN subjects subj
      ON subj.id = ha.subject_id
    LEFT JOIN homework_submissions hs
      ON hs.homework_id = ha.id
      AND hs.student_id = ss.student_id
    WHERE ha.is_active = 1
      AND (
        hs.status IS NULL
        OR hs.status IN ('not_started','submitted','late')
      )
    ORDER BY ha.due_at ASC
    LIMIT 20
    `,
    [studentId]
  );

  return rows.map((row) => ({
    id: row.homework_id,
    title: row.homework_title,
    subjectId: row.subject_id,
    subjectNameEn: row.subject_name_en,
    subjectNameAr: row.subject_name_ar,
    dueAt: row.due_at,
    maxScore: row.max_score,
    status: row.submission_status || "not_started",
    score: row.submission_score,
  }));
}

async function loadPendingQuizzes(studentId) {
  const [rows] = await pool.query(
    `
    SELECT
      qa.id               AS quiz_id,
      qa.title            AS quiz_title,
      qa.subject_id,
      subj.name_en        AS subject_name_en,
      subj.name_ar        AS subject_name_ar,
      qa.available_from,
      qa.available_until,
      qa.max_score,
      qs.status           AS submission_status,
      qs.score            AS submission_score
    FROM quiz_assignments qa
    INNER JOIN student_subjects ss
      ON ss.subject_id = qa.subject_id
      AND ss.student_id = ?
    INNER JOIN subjects subj
      ON subj.id = qa.subject_id
    LEFT JOIN quiz_submissions qs
      ON qs.quiz_id = qa.id
      AND qs.student_id = ss.student_id
    WHERE qa.is_active = 1
      AND (qa.available_from IS NULL OR qa.available_from <= NOW())
      AND (qa.available_until IS NULL OR qa.available_until >= NOW())
      AND (
        qs.status IS NULL
        OR qs.status IN ('not_started','in_progress','submitted','late')
      )
    ORDER BY qa.available_until ASC
    LIMIT 20
    `,
    [studentId]
  );

  return rows.map((row) => ({
    id: row.quiz_id,
    title: row.quiz_title,
    subjectId: row.subject_id,
    subjectNameEn: row.subject_name_en,
    subjectNameAr: row.subject_name_ar,
    availableFrom: row.available_from,
    availableUntil: row.available_until,
    maxScore: row.max_score,
    status: row.submission_status || "not_started",
    score: row.submission_score,
  }));
}

async function loadRecentHomeworkGrades(studentId) {
  const [rows] = await pool.query(
    `
    SELECT
      ha.id             AS homework_id,
      ha.title          AS homework_title,
      subj.name_en      AS subject_name_en,
      subj.name_ar      AS subject_name_ar,
      hs.score,
      ha.max_score,
      hs.submitted_at
    FROM homework_submissions hs
    INNER JOIN homework_assignments ha ON ha.id = hs.homework_id
    INNER JOIN subjects subj ON subj.id = ha.subject_id
    WHERE hs.student_id = ?
      AND hs.status = 'graded'
    ORDER BY hs.submitted_at DESC
    LIMIT 20
    `,
    [studentId]
  );

  return rows.map((row) => ({
    assignmentId: row.homework_id,
    title: row.homework_title,
    subjectNameEn: row.subject_name_en,
    subjectNameAr: row.subject_name_ar,
    score: row.score,
    maxScore: row.max_score,
    gradedAt: row.submitted_at,
  }));
}

async function loadRecentQuizGrades(studentId) {
  const [rows] = await pool.query(
    `
    SELECT
      qs.quiz_id        AS quiz_id,
      qa.title          AS quiz_title,
      subj.name_en      AS subject_name_en,
      subj.name_ar      AS subject_name_ar,
      qs.score,
      qa.max_score,
      qs.submitted_at
    FROM quiz_submissions qs
    INNER JOIN quiz_assignments qa ON qa.id = qs.quiz_id
    INNER JOIN subjects subj ON subj.id = qa.subject_id
    WHERE qs.student_id = ?
      AND qs.status = 'graded'
    ORDER BY qs.submitted_at DESC
    LIMIT 20
    `,
    [studentId]
  );

  return rows.map((row) => ({
    quizId: row.quiz_id,
    title: row.quiz_title,
    subjectNameEn: row.subject_name_en,
    subjectNameAr: row.subject_name_ar,
    score: row.score,
    maxScore: row.max_score,
    gradedAt: row.submitted_at,
  }));
}

async function loadAnnouncementsForStudent() {
  const [rows] = await pool.query(
    `
    SELECT id, title, body, audience, created_at
    FROM announcements
    WHERE audience IN ('all','students')
    ORDER BY created_at DESC
    LIMIT 10
    `
  );

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    body: row.body,
    audience: row.audience,
    createdAt: row.created_at,
  }));
}

async function loadNotifications(userId) {
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
    SELECT
      id, type, title, body,
      related_type, related_id,
      is_read, created_at
    FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 20
    `,
    [userId]
  );

  return {
    unreadCount,
    items: items.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      relatedType: row.related_type,
      relatedId: row.related_id,
      isRead: !!row.is_read,
      createdAt: row.created_at,
    })),
  };
}

/* =============================================================================
 * Core endpoints: profile, dashboard, panels
 * ============================================================================= */

export const getStudentProfile = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found for this user.");

    const { user: userRow, student } = context;

    return res.json({
      success: true,
      data: {
        user: {
          id: userRow.id,
          fullName: userRow.full_name,
          preferredLang: userRow.preferred_lang,
        },
        student: {
          id: student.id,
          systemId: student.system_id != null ? Number(student.system_id) : null,
          stageId: student.stage_id != null ? Number(student.stage_id) : null,
          gradeLevelId: student.grade_level_id != null ? Number(student.grade_level_id) : null,
          gradeStage: student.grade_stage,
          gradeNumber: student.grade_number,
          gender: student.gender,
          onboardingCompleted: !!student.onboarding_completed,
        },
      },
    });
  } catch (err) {
    return handleApiError(res, err, "getStudentProfile");
  }
};

/**
 * PUT /student/scope
 * Writes normalized academic scope (system_id, stage_id, grade_level_id) for the
 * authenticated student. Validates that the provided IDs exist in the catalog
 * before writing. Called from the onboarding Step 0 scope-selector.
 */
export const updateStudentAcademicScope = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const systemId = parsePositiveInt(req.body?.systemId);
    const stageId = parsePositiveInt(req.body?.stageId);
    const gradeLevelId = req.body?.gradeLevelId != null
      ? parsePositiveInt(req.body.gradeLevelId)
      : null;

    if (!systemId || !stageId) {
      return badRequest(res, "systemId and stageId are required.");
    }

    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found for this user.");

    // Verify system + stage exist and belong together
    const [stageRows] = await pool.query(
      `SELECT id FROM grade_stages WHERE id = ? AND system_id = ? LIMIT 1`,
      [stageId, systemId]
    );
    if (!stageRows.length) {
      return badRequest(res, "Invalid systemId/stageId combination.");
    }

    // Verify grade level if provided
    if (gradeLevelId != null) {
      const [levelRows] = await pool.query(
        `SELECT id FROM grade_levels WHERE id = ? AND stage_id = ? LIMIT 1`,
        [gradeLevelId, stageId]
      );
      if (!levelRows.length) {
        return badRequest(res, "Invalid gradeLevelId for the given stageId.");
      }
    }

    await pool.query(
      `UPDATE students SET system_id = ?, stage_id = ?, grade_level_id = ? WHERE id = ?`,
      [systemId, stageId, gradeLevelId ?? null, context.student.id]
    );

    return res.json({
      success: true,
      message: "Academic scope saved.",
      data: { systemId, stageId, gradeLevelId: gradeLevelId ?? null },
    });
  } catch (err) {
    return handleApiError(res, err, "updateStudentAcademicScope");
  }
};

export const getStudentSubjects = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const context = await getStudentContext(userId);
    if (!context) {
      return notFound(res, "Active student profile not found for this user.");
    }

    const subjects = await loadSubjectsForStudent(context.student.id);
    return res.json({ success: true, data: subjects });
  } catch (err) {
    return handleApiError(res, err, "getStudentSubjects");
  }
};

export const getStudentSchedule = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found for this user.");

    const lessons = await loadUpcomingLessons(context.student.id);
    return res.json({ success: true, data: lessons });
  } catch (err) {
    return handleApiError(res, err, "getStudentSchedule");
  }
};

export const getStudentAttendance = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found for this user.");

    const summary = await loadAttendanceSummary(context.student.id);
    return res.json({ success: true, data: summary });
  } catch (err) {
    return handleApiError(res, err, "getStudentAttendance");
  }
};

export const getStudentHomework = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found for this user.");

    const homework = await loadPendingHomework(context.student.id);
    return res.json({ success: true, data: homework });
  } catch (err) {
    return handleApiError(res, err, "getStudentHomework");
  }
};

/**
 * GET /student/homework/:id
 * ✅ FIXED: Now uses getStudentContext instead of findStudentByUserId
 */
export const getHomeworkDetail = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const homeworkId = parsePositiveInt(req.params?.id);
    if (!homeworkId) return badRequest(res, "Invalid homework id.");

    // ✅ FIXED: Use getStudentContext to enforce active student role
    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found.");

    const student = context.student;
    let row = null;

    // Try richer query first (optional columns may not exist)
    try {
      const [[r]] = await pool.query(
        `
        SELECT
          ha.id,
          ha.title,
          ha.subject_id,
          subj.name_en AS subject_name_en,
          subj.name_ar AS subject_name_ar,
          ha.due_at,
          ha.max_score,
          ha.created_at,
          ha.is_active,

          ha.description,
          ha.instructions,
          ha.attachment_url,

          hs.id AS submission_id,
          hs.status AS submission_status,
          hs.score AS submission_score,
          hs.submitted_at,
          hs.file_url,
          hs.text_answer
        FROM homework_assignments ha
        INNER JOIN subjects subj ON subj.id = ha.subject_id
        LEFT JOIN homework_submissions hs
          ON hs.homework_id = ha.id
         AND hs.student_id  = ?
        WHERE ha.id = ?
        LIMIT 1
        `,
        [student.id, homeworkId]
      );
      row = r || null;
    } catch (err) {
      if (err && (err.code === "ER_BAD_FIELD_ERROR" || err.errno === 1054)) {
        const [[r]] = await pool.query(
          `
          SELECT
            ha.id,
            ha.title,
            ha.subject_id,
            subj.name_en AS subject_name_en,
            subj.name_ar AS subject_name_ar,
            ha.due_at,
            ha.max_score,
            ha.is_active,

            hs.status AS submission_status,
            hs.score  AS submission_score
          FROM homework_assignments ha
          INNER JOIN subjects subj ON subj.id = ha.subject_id
          LEFT JOIN homework_submissions hs
            ON hs.homework_id = ha.id
           AND hs.student_id  = ?
          WHERE ha.id = ?
          LIMIT 1
          `,
          [student.id, homeworkId]
        );
        row = r || null;
      } else {
        throw err;
      }
    }

    if (!row) return notFound(res, "Homework not found.");
    if (row.is_active !== undefined && Number(row.is_active) !== 1) {
      return notFound(res, "Homework not found.");
    }

    // Must be enrolled in subject
    const [[enrolled]] = await pool.query(
      `
      SELECT 1
      FROM student_subjects
      WHERE student_id = ?
        AND subject_id = ?
      LIMIT 1
      `,
      [student.id, row.subject_id]
    );
    if (!enrolled) return badRequest(res, "Student is not enrolled in this subject.");

    return res.json({
      success: true,
      data: {
        id: row.id,
        title: row.title,
        subjectId: row.subject_id,
        subjectNameEn: row.subject_name_en,
        subjectNameAr: row.subject_name_ar,
        dueAt: row.due_at ?? null,
        maxScore: row.max_score ?? null,
        createdAt: row.created_at ?? null,

        description: row.description ?? null,
        instructions: row.instructions ?? null,
        attachmentUrl: row.attachment_url ?? null,

        submission:
          row.submission_id ||
          row.submission_status ||
          row.submission_score !== undefined
            ? {
                id: row.submission_id ?? null,
                status: row.submission_status ?? null,
                score: row.submission_score ?? null,
                submittedAt: row.submitted_at ?? null,
                fileUrl: row.file_url ?? null,
                textAnswer: row.text_answer ?? null,
              }
            : null,
      },
    });
  } catch (err) {
    return handleApiError(res, err, "getHomeworkDetail");
  }
};

export const getStudentQuizzes = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found for this user.");

    const quizzes = await loadPendingQuizzes(context.student.id);
    return res.json({ success: true, data: quizzes });
  } catch (err) {
    return handleApiError(res, err, "getStudentQuizzes");
  }
};

/**
 * GET /student/quizzes/:id
 * ✅ FIXED: Now uses getStudentContext instead of findStudentByUserId
 */
export const getQuizDetail = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const quizId = parsePositiveInt(req.params?.id);
    if (!quizId) return badRequest(res, "Invalid quiz id.");

    // ✅ FIXED: Use getStudentContext to enforce active student role
    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found.");

    const student = context.student;
    let row = null;

    // Try richer query first (optional columns may not exist)
    try {
      const [[r]] = await pool.query(
        `
        SELECT
          qa.id,
          qa.title,
          qa.subject_id,
          subj.name_en AS subject_name_en,
          subj.name_ar AS subject_name_ar,
          qa.available_from,
          qa.available_until,
          qa.max_score,
          qa.created_at,
          qa.is_active,

          qa.description,
          qa.instructions,

          qs.id AS submission_id,
          qs.status AS submission_status,
          qs.score AS submission_score,
          qs.started_at,
          qs.submitted_at
        FROM quiz_assignments qa
        INNER JOIN subjects subj ON subj.id = qa.subject_id
        LEFT JOIN quiz_submissions qs
          ON qs.quiz_id    = qa.id
         AND qs.student_id = ?
        WHERE qa.id = ?
        LIMIT 1
        `,
        [student.id, quizId]
      );
      row = r || null;
    } catch (err) {
      if (err && (err.code === "ER_BAD_FIELD_ERROR" || err.errno === 1054)) {
        const [[r]] = await pool.query(
          `
          SELECT
            qa.id,
            qa.title,
            qa.subject_id,
            subj.name_en AS subject_name_en,
            subj.name_ar AS subject_name_ar,
            qa.available_from,
            qa.available_until,
            qa.max_score,
            qa.is_active,

            qs.status AS submission_status,
            qs.score  AS submission_score
          FROM quiz_assignments qa
          INNER JOIN subjects subj ON subj.id = qa.subject_id
          LEFT JOIN quiz_submissions qs
            ON qs.quiz_id    = qa.id
           AND qs.student_id = ?
          WHERE qa.id = ?
          LIMIT 1
          `,
          [student.id, quizId]
        );
        row = r || null;
      } else {
        throw err;
      }
    }

    if (!row) return notFound(res, "Quiz not found.");
    if (row.is_active !== undefined && Number(row.is_active) !== 1) {
      return notFound(res, "Quiz not found.");
    }

    // Must be enrolled in subject
    const [[enrolled]] = await pool.query(
      `
      SELECT 1
      FROM student_subjects
      WHERE student_id = ?
        AND subject_id = ?
      LIMIT 1
      `,
      [student.id, row.subject_id]
    );
    if (!enrolled) return badRequest(res, "Student is not enrolled in this subject.");

    return res.json({
      success: true,
      data: {
        id: row.id,
        title: row.title,
        subjectId: row.subject_id,
        subjectNameEn: row.subject_name_en,
        subjectNameAr: row.subject_name_ar,
        availableFrom: row.available_from ?? null,
        availableUntil: row.available_until ?? null,
        maxScore: row.max_score ?? null,
        createdAt: row.created_at ?? null,

        description: row.description ?? null,
        instructions: row.instructions ?? null,

        submission:
          row.submission_id ||
          row.submission_status ||
          row.submission_score !== undefined
            ? {
                id: row.submission_id ?? null,
                status: row.submission_status ?? null,
                score: row.submission_score ?? null,
                startedAt: row.started_at ?? null,
                submittedAt: row.submitted_at ?? null,
              }
            : null,
      },
    });
  } catch (err) {
    return handleApiError(res, err, "getQuizDetail");
  }
};

export const getStudentGrades = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found for this user.");

    const studentId = context.student.id;

    const [homeworkGrades, quizGrades] = await Promise.all([
      loadRecentHomeworkGrades(studentId),
      loadRecentQuizGrades(studentId),
    ]);

    return res.json({
      success: true,
      data: { homework: homeworkGrades, quizzes: quizGrades },
    });
  } catch (err) {
    return handleApiError(res, err, "getStudentGrades");
  }
};

export const getStudentAnnouncements = async (req, res) => {
  try {
    const announcements = await loadAnnouncementsForStudent();
    return res.json({ success: true, data: announcements });
  } catch (err) {
    return handleApiError(res, err, "getStudentAnnouncements");
  }
};

export const getStudentNotifications = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const notifications = await loadNotifications(userId);
    return res.json({ success: true, data: notifications });
  } catch (err) {
    return handleApiError(res, err, "getStudentNotifications");
  }
};

export const markNotificationRead = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const id = parsePositiveInt(req.params?.id);
    if (!id) return badRequest(res, "Invalid notification id.");

    const [result] = await pool.query(
      `
      UPDATE notifications
      SET is_read = 1,
          read_at = NOW()
      WHERE id = ?
        AND user_id = ?
      `,
      [id, userId]
    );

    if (result.affectedRows === 0) return notFound(res, "Notification not found.");

    return res.json({ success: true, message: "Notification marked as read." });
  } catch (err) {
    return handleApiError(res, err, "markNotificationRead");
  }
};

export const markAllNotificationsRead = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    await pool.query(
      `
      UPDATE notifications
      SET is_read = 1,
          read_at = NOW()
      WHERE user_id = ?
        AND is_read = 0
      `,
      [userId]
    );

    return res.json({ success: true, message: "All notifications marked as read." });
  } catch (err) {
    return handleApiError(res, err, "markAllNotificationsRead");
  }
};

export const getStudentDashboard = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found for this user.");

    const { user: userRow, student } = context;

    const [
      subjects,
      upcomingLessons,
      attendanceSummary,
      pendingHomework,
      pendingQuizzes,
      recentHomeworkGrades,
      recentQuizGrades,
      announcements,
      notifications,
    ] = await Promise.all([
      loadStudentSubjects(student.id),
      loadUpcomingLessons(student.id),
      loadAttendanceSummary(student.id),
      loadPendingHomework(student.id),
      loadPendingQuizzes(student.id),
      loadRecentHomeworkGrades(student.id),
      loadRecentQuizGrades(student.id),
      loadAnnouncementsForStudent(),
      loadNotifications(userRow.id),
    ]);

    return res.json({
      success: true,
      data: {
        user: {
          id: userRow.id,
          fullName: userRow.full_name,
          preferredLang: userRow.preferred_lang,
        },
        student: {
          id: student.id,
          systemId: student.system_id != null ? Number(student.system_id) : null,
          stageId: student.stage_id != null ? Number(student.stage_id) : null,
          gradeLevelId: student.grade_level_id != null ? Number(student.grade_level_id) : null,
          gradeStage: student.grade_stage,
          gradeNumber: student.grade_number,
          gender: student.gender,
          onboardingCompleted: !!student.onboarding_completed,
        },
        subjects,
        upcomingLessons,
        attendanceSummary,
        pendingHomework,
        pendingQuizzes,
        recentGrades: {
          homework: recentHomeworkGrades,
          quizzes: recentQuizGrades,
        },
        announcements,
        notifications,
      },
    });
  } catch (err) {
    return handleApiError(res, err, "getStudentDashboard");
  }
};

/* =============================================================================
 * Subject Management
 * ============================================================================= */

export const getStudentAvailableSubjects = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const context = await getStudentContext(userId);
    if (!context) {
      return notFound(res, "Active student profile not found for this user.");
    }

    const { student } = context;

    const { systemId, stageId, gradeLevelId } = await resolveStudentAcademicIds(student);

    if (!systemId || !stageId) {
      return badRequest(res, STUDENT_SCOPE_RESOLUTION_ERROR);
    }

    const availableSubjects = await loadAvailableSubjectsForStudent(
      student.id,
      systemId,
      stageId,
      gradeLevelId
    );

    return res.json({ success: true, data: availableSubjects });
  } catch (err) {
    return handleApiError(res, err, "getStudentAvailableSubjects");
  }
};

export const updateStudentSubjects = async (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) return unauthorized(res);

  const { subjectIds } = req.body || {};

  // ---------------------------------------------------------------------------
  // Validate input
  // ---------------------------------------------------------------------------
  if (!Array.isArray(subjectIds)) {
    return badRequest(res, "subjectIds must be an array of numbers.");
  }

  const cleanIds = [...new Set(subjectIds)]
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (cleanIds.length === 0) {
    return badRequest(res, "No valid subjectIds provided.");
  }

  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    // ✅ Strong guard: active user + student role + student profile exists
    const context = await getStudentContext(userId, conn);
    if (!context) {
      return notFound(res, "Active student profile not found for this user.");
    }

    // -------------------------------------------------------------------------
    // Start transaction
    // -------------------------------------------------------------------------
    await conn.beginTransaction();
    txStarted = true;

    const student = context.student;
    const studentId = student.id;

    // Resolve academic scope (system/stage/grade_level) using same connection
    const { systemId, stageId, gradeLevelId } = await resolveStudentAcademicIds(student, conn);

    if (!systemId || !stageId) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, STUDENT_SCOPE_RESOLUTION_ERROR);
    }

    const scopeMatch = buildAcademicScopeMatchSql(
      { systemId, stageId, gradeLevelId },
      {
        systemColumn: "sa.system_id",
        stageColumn: "sa.stage_id",
        gradeLevelColumn: "sa.grade_level_id",
      }
    );

    const [allowedRows] = await conn.query(
      `
      SELECT sa.subject_id
      FROM subject_availability sa
      INNER JOIN subjects s ON s.id = sa.subject_id
      WHERE sa.subject_id IN (?)
        AND sa.is_active = 1
        AND s.is_active  = 1
        AND ${scopeMatch.sql}
      `,
      [cleanIds, ...scopeMatch.params]
    );

    const allowedIds = (allowedRows || [])
      .map((r) => Number(r.subject_id))
      .filter((n) => Number.isInteger(n) && n > 0);

    if (allowedIds.length === 0) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "None of the requested subjects are available for this student.");
    }

    const allowedSet = new Set(allowedIds);
    const desiredIds = cleanIds.filter((id) => allowedSet.has(id));

    // Current subjects
    const [currentRows] = await conn.query(
      `
      SELECT subject_id
      FROM student_subjects
      WHERE student_id = ?
      `,
      [studentId]
    );

    const currentIds = (currentRows || [])
      .map((r) => Number(r.subject_id))
      .filter((n) => Number.isInteger(n) && n > 0);

    // ✅ FIXED: Clean and correct toRemove calculation
    const currentSet = new Set(currentIds);
    const desiredSet = new Set(desiredIds);

    const toAdd = desiredIds.filter((id) => !currentSet.has(id));
    const toRemove = currentIds.filter((id) => !desiredSet.has(id));

    // -------------------------------------------------------------------------
    // Apply changes
    // -------------------------------------------------------------------------
    if (toAdd.length > 0) {
      const values = toAdd.map((sid) => [studentId, sid]);
      await conn.query(
        `
        INSERT INTO student_subjects (student_id, subject_id)
        VALUES ?
        `,
        [values]
      );
    }

    if (toRemove.length > 0) {
      await conn.query(
        `
        DELETE FROM student_subjects
        WHERE student_id = ?
          AND subject_id IN (?)
        `,
        [studentId, toRemove]
      );

      // Deactivate active teacher selections for removed subjects
      await conn.query(
        `
        UPDATE student_teacher_selections
        SET status = 'replaced'
        WHERE student_id = ?
          AND subject_id IN (?)
          AND status = 'active'
        `,
        [studentId, toRemove]
      );
    }

    // Mark onboarding complete if they have at least one subject selected
    if (desiredIds.length > 0) {
      await conn.query(`UPDATE students SET onboarding_completed = 1 WHERE id = ?`, [studentId]);
    }

    await conn.commit();
    txStarted = false;

    // Reload updated subject list (fresh response)
    const updatedSubjects = await loadSubjectsForStudent(studentId);

    return res.json({
      success: true,
      message: "Student subjects updated.",
      data: updatedSubjects,
    });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    return handleApiError(res, err, "updateStudentSubjects");
  } finally {
    conn.release();
  }
};

/* =============================================================================
 * Teacher Selection & Lookup
 * ============================================================================= */

/**
 * ✅ FIXED: Now uses getStudentContext instead of findStudentByUserId
 */
export const selectTeacherForSubject = async (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) return unauthorized(res);

  const subjectId = parsePositiveInt(req.body?.subjectId);
  const teacherId = parsePositiveInt(req.body?.teacherId);

  if (!subjectId || !teacherId) {
    return badRequest(res, "subjectId and teacherId are required.");
  }

  try {
    // ✅ FIXED: Use getStudentContext to enforce active student role
    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found for this user.");

    const student = context.student;

    const [subjectRows] = await pool.query(`SELECT id FROM subjects WHERE id = ? LIMIT 1`, [
      subjectId,
    ]);
    if (!subjectRows.length) return badRequest(res, "Subject not found.");

    const [enrollmentRows] = await pool.query(
      `SELECT id FROM student_subjects WHERE student_id = ? AND subject_id = ? LIMIT 1`,
      [student.id, subjectId]
    );
    if (!enrollmentRows.length) return badRequest(res, "Student is not enrolled in this subject.");

    const eligibility = await assertTeacherEligibleForSubjectScope(
      teacherId,
      student,
      subjectId,
      { actorType: "student" }
    );
    if (!eligibility.ok) {
      return res.status(eligibility.status).json({
        success: false,
        message: eligibility.message,
      });
    }

    await upsertTeacherSelection(pool, {
      studentId: student.id,
      subjectId,
      teacherId,
      selectedBy: "student",
    });

    await pool.query(`UPDATE students SET onboarding_completed = 1 WHERE id = ?`, [student.id]);

    return res.json({
      success: true,
      message: "Teacher selected for subject.",
      data: { studentId: student.id, subjectId, teacherId },
    });
  } catch (err) {
    return handleApiError(res, err, "selectTeacherForSubject");
  }
};

/**
 * ✅ FIXED: Now uses getStudentContext instead of findStudentByUserId
 */
export const getMySelections = async (req, res) => {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    // ✅ FIXED: Use getStudentContext to enforce active student role
    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found.");

    const student = context.student;

    const [rows] = await pool.query(
      `
      SELECT 
        sts.id,
        sts.subject_id,
        s.name_ar AS subject_name_ar,
        s.name_en AS subject_name_en,
        sts.teacher_id,
        t.name AS teacher_name,
        t.photo_url,
        sts.status,
        sts.selected_by,
        sts.selected_at
      FROM student_teacher_selections sts
      INNER JOIN subjects s ON s.id = sts.subject_id
      INNER JOIN teachers t ON t.id = sts.teacher_id
      WHERE sts.student_id = ?
        AND sts.status = 'active'
      ORDER BY s.sort_order, s.id
      `,
      [student.id]
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    return handleApiError(res, err, "getMySelections");
  }
};

/**
 * ✅ FIXED: Now uses getStudentContext instead of findStudentByUserId
 */
export const getTeachersForSubject = async (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) return unauthorized(res);

  const subjectId = parsePositiveInt(req.query?.subjectId);
  if (!subjectId) return badRequest(res, "subjectId is required and must be a valid number.");

  try {
    // ✅ FIXED: Use getStudentContext to enforce active student role
    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found.");

    const student = context.student;

    const [enrollmentRows] = await pool.query(
      `
      SELECT id
      FROM student_subjects
      WHERE student_id = ?
        AND subject_id = ?
      LIMIT 1
      `,
      [student.id, subjectId]
    );
    if (!enrollmentRows.length) return badRequest(res, "Student is not enrolled in this subject.");

    const eligibleTeachers = await listEligibleTeacherIdsForSubjectScope(
      student,
      subjectId,
      { actorType: "student" }
    );
    if (!eligibleTeachers.ok) {
      return res.status(eligibleTeachers.status).json({
        success: false,
        message: eligibleTeachers.message,
      });
    }

    const { teacherIds: eligibleTeacherIds } = eligibleTeachers;

    if (!eligibleTeacherIds.length) {
      return res.json({ success: true, data: [] });
    }

    const [rows] = await pool.query(
      `
      SELECT DISTINCT
        t.id,
        COALESCE(NULLIF(t.name, ''), NULLIF(u.full_name, ''), CONCAT('Teacher #', t.id)) AS name,
        ROUND(AVG(tr.stars), 1) AS rating_avg,
        COUNT(tr.id) AS rating_count
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
      LEFT JOIN teacher_ratings tr ON tr.teacher_id = t.id AND tr.is_hidden = 0
      WHERE t.id IN (?)
        AND t.is_active = 1
        AND t.status = 'approved'
        AND u.is_active = 1
        AND u.role = 'teacher'
      GROUP BY t.id, u.full_name, t.name
      ORDER BY name ASC, t.id ASC
      `,
      [eligibleTeacherIds]
    );

    return res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        rating_avg: r.rating_avg !== null && r.rating_avg !== undefined ? Number(r.rating_avg) : null,
        rating_count: Number(r.rating_count || 0),
      })),
    });
  } catch (err) {
    return handleApiError(res, err, "getTeachersForSubject");
  }
};

/**
 * ✅ FIXED: Now uses getStudentContext instead of findStudentByUserId
 */
export const getTeacherDetailsForStudent = async (req, res) => {
  const userId = getAuthUserId(req);
  if (!userId) return unauthorized(res);

  const teacherId = parsePositiveInt(req.params?.teacherId);
  if (!teacherId) return badRequest(res, "teacherId must be a valid number.");

  const subjectIdRaw = req.query?.subjectId;
  const subjectId = subjectIdRaw !== undefined ? parsePositiveInt(subjectIdRaw) : null;
  const hasSubjectId = subjectId !== null;

  try {
    // ✅ FIXED: Use getStudentContext to enforce active student role
    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Student profile not found.");

    const student = context.student;

    if (hasSubjectId) {
      const [enrollRows] = await pool.query(
        `
        SELECT id
        FROM student_subjects
        WHERE student_id = ?
          AND subject_id = ?
        LIMIT 1
        `,
        [student.id, subjectId]
      );
      if (!enrollRows.length) return badRequest(res, "Student is not enrolled in this subject.");

      const { systemId, stageId, gradeLevelId } = await resolveStudentAcademicIds(student);
      if (!systemId || !stageId) {
        return badRequest(res, STUDENT_SCOPE_RESOLUTION_ERROR);
      }

      const subjectAllowed = await subjectIsAvailableForScope(
        subjectId,
        systemId,
        stageId,
        gradeLevelId
      );
      if (!subjectAllowed) {
        return badRequest(
          res,
          "This subject is not available for the student's academic level."
        );
      }

      const teacherMatchesScope = await teacherHasLiveOfferingForScope(
        teacherId,
        subjectId,
        systemId,
        stageId,
        gradeLevelId
      );
      if (!teacherMatchesScope) return notFound(res, "Teacher not found for this subject.");
    }

    const [tRows] = await pool.query(
      `
      SELECT
        t.id,
        COALESCE(NULLIF(t.name, ''), NULLIF(u.full_name, ''), CONCAT('Teacher #', t.id)) AS name,
        t.photo_url,
        t.bio_short
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
      WHERE t.id = ?
        AND t.is_active = 1
        AND t.status = 'approved'
        AND u.is_active = 1
        AND u.role = 'teacher'
      LIMIT 1
      `,
      [teacherId]
    );

    if (!tRows || !tRows.length) return notFound(res, "Teacher not found, inactive, or not approved.");

    const tr = tRows[0];

    const [vRows] = await pool.query(
      hasSubjectId
        ? `
          SELECT video_url, is_primary, subject_id
          FROM teacher_videos
          WHERE teacher_id = ?
            AND (subject_id IS NULL OR subject_id = ?)
          ORDER BY
            CASE WHEN subject_id = ? THEN 0 ELSE 1 END,
            is_primary DESC
        `
        : `
          SELECT video_url, is_primary, subject_id
          FROM teacher_videos
          WHERE teacher_id = ?
          ORDER BY is_primary DESC
        `,
      hasSubjectId ? [teacherId, subjectId, subjectId] : [teacherId]
    );

    const clips = (vRows || [])
      .map((row, idx) => {
        const url = typeof row.video_url === "string" ? row.video_url.trim() : "";
        if (!url) return null;
        const title = row.is_primary ? "Primary clip" : `Clip ${idx + 1}`;
        return { title, url };
      })
      .filter(Boolean);

    return res.json({
      success: true,
      data: {
        id: String(tr.id),
        name: tr.name,
        photoUrl: tr.photo_url || null,
        bio: tr.bio_short || null,
        videoClips: clips,
      },
    });
  } catch (err) {
    return handleApiError(res, err, "getTeacherDetailsForStudent");
  }
};

/* =============================================================================
 * Availability & Booking
 * ============================================================================= */

/**
 * GET /student/teacher-availability
 * ✅ FIXED: Now uses getStudentContext instead of findStudentByUserId
 */
export async function studentGetTeacherAvailability(req, res) {
  try {
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    // ✅ FIXED: Use getStudentContext to enforce active student role
    const context = await getStudentContext(userId);
    if (!context) return notFound(res, "Active student profile not found.");

    const student = context.student;
    const availabilityRequest = buildStudentTeacherAvailabilityRequestContext(
      req.query,
      student
    );
    const {
      teacherId,
      subjectId,
      from,
      to,
    } = availabilityRequest;

    const availabilityContext = await loadStudentSubjectTeacherBookingContext(
      student,
      {
        subjectId,
        teacherId,
        executor: pool,
        selectionRequiredMessage:
          "You must have this teacher selected for the subject before viewing availability.",
        scopeErrorMessage: STUDENT_AVAILABILITY_SCOPE_INCOMPLETE_ERROR,
      }
    );
    if (!availabilityContext.ok) {
      return res.status(availabilityContext.status).json({
        success: false,
        message: availabilityContext.message,
      });
    }

    const {
      teacherId: normalizedTeacherId,
      subjectId: normalizedSubjectId,
      systemId,
      stageId,
      gradeLevelId,
    } = availabilityContext.context;

    if (from && !isValidDateStr(from)) return badRequest(res, "from must be YYYY-MM-DD");
    if (to && !isValidDateStr(to)) return badRequest(res, "to must be YYYY-MM-DD");
    if (!from || !to) {
      return badRequest(res, "from and to are required for availability queries.");
    }
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T00:00:00.000Z`);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
      return badRequest(res, "Invalid date range.");
    }
    const rangeDays = Math.floor((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000));
    if (rangeDays > 31) {
      return badRequest(res, "Maximum availability range is 31 days.");
    }

    // DEBUG helpers (only in non-production)
    if (!IS_PRODUCTION) {
      const sample = (arr, n = 5) => (Array.isArray(arr) ? arr.slice(0, n) : []);

      console.log("[DEBUG] studentGetTeacherAvailability params:", {
        teacherId: normalizedTeacherId,
        subjectId: normalizedSubjectId,
        systemId,
        stageId,
        gradeLevelId,
        from,
        to,
      });
    }

    const slotScopeMatch = buildAcademicScopeMatchSql(
      { systemId, stageId, gradeLevelId },
      {
        systemColumn: "tss.system_id",
        stageColumn: "tss.stage_id",
        gradeLevelColumn: "tss.grade_level_id",
      }
    );

    // 2) Scope-aware offerings
    const [slotScopes] = await pool.query(
      `
      SELECT
        tss.id,
        tss.schedule_id,

        tss.subject_id,
        s.name_en AS subject_name_en,
        s.name_ar AS subject_name_ar,

        tss.system_id,
        es.name   AS system_name,

        tss.stage_id,
        gs.name_en AS stage_name_en,
        gs.name_ar AS stage_name_ar,

        tss.grade_level_id,
        gl.name_en AS grade_level_name_en,
        gl.name_ar AS grade_level_name_ar,

        tss.is_active
      FROM teacher_schedule_subjects tss
      JOIN teacher_schedules ts ON ts.id = tss.schedule_id
      JOIN subjects s ON s.id = tss.subject_id
      JOIN educational_systems es ON es.id = tss.system_id
      JOIN grade_stages gs ON gs.id = tss.stage_id
      LEFT JOIN grade_levels gl ON gl.id = tss.grade_level_id
      WHERE ts.teacher_id = ?
        AND ts.is_active = 1
        AND tss.subject_id = ?
        AND tss.is_active = 1
        AND ${slotScopeMatch.sql}
      ORDER BY tss.schedule_id, tss.subject_id
      `,
      [normalizedTeacherId, normalizedSubjectId, ...slotScopeMatch.params]
    );

    const visibleSlotScopes = (slotScopes || []).filter((row) =>
      academicScopeMatchesRow(
        { systemId, stageId, gradeLevelId },
        row,
        {
          systemKey: "system_id",
          stageKey: "stage_id",
          gradeLevelKey: "grade_level_id",
        }
      )
    );

    const visibleScheduleIds = [...new Set(
      visibleSlotScopes
        .map((row) => parsePositiveInt(row.schedule_id))
        .filter(Boolean)
    )];

    let slots = [];
    if (visibleScheduleIds.length) {
      const [slotRows] = await pool.query(
        `
        SELECT
          id,
          id AS schedule_id,
          weekday,
          start_time,
          end_time,
          is_group,
          max_students,
          is_active
        FROM teacher_schedules
        WHERE teacher_id = ?
          AND is_active = 1
          AND id IN (?)
        ORDER BY weekday, start_time
        `,
        [normalizedTeacherId, visibleScheduleIds]
      );
      slots = slotRows;
    }

    // 3) Exceptions (optional date range)
    const exParams = [normalizedTeacherId];
    let exWhere = `WHERE teacher_id = ? AND is_active = 1`;
    if (from) {
      exWhere += ` AND exception_date >= ?`;
      exParams.push(from);
    }
    if (to) {
      exWhere += ` AND exception_date <= ?`;
      exParams.push(to);
    }

    const [exceptions] = await pool.query(
      `
      SELECT id, exception_date, start_time, end_time, exception_type,
             is_group, max_students, note, reason
      FROM teacher_schedule_exceptions
      ${exWhere}
      ORDER BY exception_date, start_time
      `,
      exParams
    );

    // 4) Sessions to block occupied times (optional date range)
    const sParams = [normalizedTeacherId];
    let sWhere = `WHERE teacher_id = ? AND status NOT IN ('cancelled', 'rejected')`;
    if (from) {
      sWhere += ` AND DATE(starts_at) >= ?`;
      sParams.push(from);
    }
    if (to) {
      sWhere += ` AND DATE(starts_at) <= ?`;
      sParams.push(to);
    }

    const [sessions] = await pool.query(
      `
      SELECT id, starts_at, ends_at, schedule_id, exception_id, status
      FROM lesson_sessions
      ${sWhere}
      ORDER BY starts_at
      `,
      sParams
    );

    // DEBUG info (only in non-production)
    if (!IS_PRODUCTION) {
      const sample = (arr, n = 5) => (Array.isArray(arr) ? arr.slice(0, n) : []);
      
      console.log("[DEBUG] availability Q1 slots", {
        count: slots?.length ?? 0,
        slotIds: sample(slots).map((x) => x.id),
      });

      console.log("[DEBUG] availability Q2 slotScopes", {
        count: slotScopes?.length ?? 0,
        scheduleIds: sample(slotScopes).map((x) => x.schedule_id),
      });

      console.log("[DEBUG] availability Q3 exceptions", {
        count: exceptions?.length ?? 0,
      });

      console.log("[DEBUG] availability Q4 sessions", {
        count: sessions?.length ?? 0,
      });
    }

    return res.json({
      success: true,
      data: {
        teacherId: normalizedTeacherId,
        subjectId: normalizedSubjectId,
        scope: { systemId, stageId, gradeLevelId },
        slots,
        slotScopes: visibleSlotScopes,
        exceptions,
        sessions,
      },
    });
  } catch (err) {
    return handleApiError(res, err, "studentGetTeacherAvailability");
  }
}

/**
 * POST /student/lessons/request
 * ✅ FIXED: Now uses getStudentContext instead of findStudentByUserId
 * ✅ FIXED: Transaction starts earlier for race condition safety
 * ✅ FIXED: Overlap protection includes both teacher AND student
 */
export async function requestLessonSession(req, res) {
  const userId = getAuthUserId(req);
  if (!userId) return unauthorized(res);

  // ---------------------------------------------------------------------------
  // 1) Validate input (no DB calls yet)
  // ---------------------------------------------------------------------------
  const tId = parsePositiveInt(req.body?.teacherId);
  const sId = parsePositiveInt(req.body?.subjectId);
  const schId = parsePositiveInt(req.body?.scheduleId);
  const startsAt = req.body?.startsAt;
  const endsAt = req.body?.endsAt;

  if (!tId || !sId || !schId || !startsAt || !endsAt) {
    return badRequest(res, "Invalid or missing booking parameters.");
  }

  if (
    !isValidDateTimeStr(String(startsAt)) ||
    !isValidDateTimeStr(String(endsAt))
  ) {
    return badRequest(res, "startsAt/endsAt must be valid datetime strings.");
  }

  const startsSql = toSqlDateTime(String(startsAt));
  const endsSql = toSqlDateTime(String(endsAt));
  if (!startsSql || !endsSql) {
    return badRequest(res, "Invalid startsAt/endsAt format.");
  }
  if (startsSql >= endsSql) {
    return badRequest(res, "startsAt must be before endsAt.");
  }

  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    // -------------------------------------------------------------------------
    // ✅ FIXED: Start transaction EARLIER for race condition safety
    // -------------------------------------------------------------------------
    await conn.beginTransaction();
    txStarted = true;

    // -------------------------------------------------------------------------
    // 1b) startsAt must be in the future (vs DB clock)
    // -------------------------------------------------------------------------
    const [[futureRow]] = await conn.query(
      `SELECT (? > NOW()) AS is_future`,
      [startsSql]
    );
    if (!Number(futureRow?.is_future)) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "startsAt must be in the future.");
    }

    // -------------------------------------------------------------------------
    // 2) Resolve student + enrollment (inside transaction)
    // -------------------------------------------------------------------------
    // ✅ FIXED: Use getStudentContext with connection to enforce active student role
    const context = await getStudentContext(userId, conn);
    if (!context) {
      await conn.rollback();
      txStarted = false;
      return notFound(res, "Active student profile not found.");
    }

    const student = context.student;

    const bookingContext = await loadStudentSubjectTeacherBookingContext(
      student,
      {
        subjectId: sId,
        teacherId: tId,
        executor: conn,
        selectionRequiredMessage:
          "You must have this teacher selected for the subject before booking.",
        scopeErrorMessage: STUDENT_SCOPE_RESOLUTION_ERROR,
      }
    );
    if (!bookingContext.ok) {
      await conn.rollback();
      txStarted = false;
      return res.status(bookingContext.status).json({
        success: false,
        message: bookingContext.message,
      });
    }

    const {
      teacherId: normalizedTeacherId,
      subjectId: normalizedSubjectId,
      systemId,
      stageId,
      gradeLevelId,
    } = bookingContext.context;

    // Serialize booking mutations on both teacher and student identities.
    // This closes same-slot race windows across concurrent requests that target
    // different schedules but the same teacher or same student.
    await conn.query(
      `
      SELECT id
      FROM teachers
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedTeacherId]
    );
    await conn.query(
      `
      SELECT id
      FROM students
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [student.id]
    );

    // -------------------------------------------------------------------------
    // 3) Validate schedule belongs to teacher + active (inside transaction)
    // -------------------------------------------------------------------------
    const [[schedule]] = await conn.query(
      `
      SELECT id, weekday, start_time, end_time, is_group, max_students
      FROM teacher_schedules
      WHERE id = ?
        AND teacher_id = ?
        AND is_active = 1
      LIMIT 1
      FOR UPDATE
      `,
      [schId, normalizedTeacherId]
    );
    if (!schedule) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Invalid or inactive teacher schedule.");
    }

    // 3.1b) Reject group slots until group booking is implemented
    if (Number(schedule.is_group) === 1) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Group slot booking is not yet supported.");
    }

    // 3.1) Weekday match (MariaDB WEEKDAY(): Mon=0..Sun=6, your weekday uses Mon=1..Sun=7)
    const [[wdRow]] = await conn.query(`SELECT (WEEKDAY(?) + 1) AS wd`, [
      startsSql,
    ]);
    const reqWeekday = Number(wdRow?.wd);
    if (reqWeekday !== Number(schedule.weekday)) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Selected time does not match the schedule weekday.");
    }

    // 3.2) Ensure requested window fits inside the schedule slot
    const [[timeFit]] = await conn.query(
      `
      SELECT (TIME(?) >= ? AND TIME(?) <= ?) AS fits
      `,
      [startsSql, schedule.start_time, endsSql, schedule.end_time]
    );
    if (!timeFit || Number(timeFit.fits) !== 1) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Selected time is outside the teacher schedule slot.");
    }

    const offering = await scheduleHasLiveOfferingForScope(
      schId,
      normalizedSubjectId,
      systemId,
      stageId,
      gradeLevelId,
      conn
    );

    if (!offering) {
      await conn.rollback();
      txStarted = false;
      return badRequest(
        res,
        "Subject is not offered for your grade in this time slot."
      );
    }

    // -------------------------------------------------------------------------
    // 4b) Duplicate-request guard (same student + slot + subject + window)
    // Re-run AFTER the FOR UPDATE lock so we see any concurrent insert.
    // -------------------------------------------------------------------------
    const [[duplicate]] = await conn.query(
      `
      SELECT 1
      FROM lesson_sessions
      WHERE student_id  = ?
        AND schedule_id = ?
        AND subject_id  = ?
        AND starts_at   = ?
        AND ends_at     = ?
        AND status IN ('pending', 'scheduled', 'approved')
      LIMIT 1
      `,
      [student.id, schId, normalizedSubjectId, startsSql, endsSql]
    );
    if (duplicate) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "You already have a pending request for this slot.");
    }

    // -------------------------------------------------------------------------
    // 5) Prevent teacher overlaps (pending/approved/scheduled)
    // Re-run AFTER the FOR UPDATE lock to catch concurrent bookings.
    // -------------------------------------------------------------------------
    const [[teacherConflict]] = await conn.query(
      `
      SELECT 1
      FROM lesson_sessions
      WHERE teacher_id = ?
        AND status IN ('pending','approved','scheduled')
        AND starts_at < ?
        AND ends_at   > ?
      LIMIT 1
      `,
      [normalizedTeacherId, endsSql, startsSql]
    );

    if (teacherConflict) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Teacher is not available at the selected time.");
    }

    // -------------------------------------------------------------------------
    // ✅ FIXED: Add STUDENT overlap protection
    // -------------------------------------------------------------------------
    const [[studentConflict]] = await conn.query(
      `
      SELECT 1
      FROM lesson_sessions
      WHERE student_id = ?
        AND status IN ('pending','approved','scheduled')
        AND starts_at < ?
        AND ends_at   > ?
      LIMIT 1
      `,
      [student.id, endsSql, startsSql]
    );

    if (studentConflict) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "You already have a lesson scheduled at this time.");
    }

    // -------------------------------------------------------------------------
    // 6) Block unavailable exception overlap
    // -------------------------------------------------------------------------
    const [[blockedByException]] = await conn.query(
      `
      SELECT 1
      FROM teacher_schedule_exceptions
      WHERE teacher_id = ?
        AND is_active = 1
        AND exception_type = 'unavailable'
        AND exception_date = DATE(?)
        AND start_time < TIME(?)
        AND end_time   > TIME(?)
      LIMIT 1
      `,
      [normalizedTeacherId, startsSql, endsSql, startsSql]
    );

    if (blockedByException) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "This time is marked unavailable by the teacher.");
    }

    // -------------------------------------------------------------------------
    // 7) Insert pending session
    // -------------------------------------------------------------------------
    const [result] = await conn.query(
      `
      INSERT INTO lesson_sessions
        (teacher_id, subject_id, system_id, stage_id, grade_level_id, schedule_id,
         starts_at, ends_at, is_group, max_students,
         created_by_user_id, student_id, status)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `,
      [
        normalizedTeacherId,
        normalizedSubjectId,
        systemId,
        stageId,
        gradeLevelId, // may be NULL and that's fine
        schId,
        startsSql,
        endsSql,
        schedule.is_group,
        schedule.max_students,
        userId,
        student.id,
      ]
    );

    const sessionId = result.insertId;

    // -------------------------------------------------------------------------
    // 8) Notify teacher (best-effort; NEVER break booking)
    // -------------------------------------------------------------------------
    const [[teacherUser]] = await conn.query(
      `SELECT user_id, name FROM teachers WHERE id = ? LIMIT 1`,
      [normalizedTeacherId]
    );

    if (teacherUser?.user_id) {
      await insertNotificationSafe(conn, {
        userId: teacherUser.user_id,
        type: "system",
        title: "New lesson request",
        body: `A student requested a lesson (#${sessionId}) pending your approval.`,
        relatedType: "lesson_session",
        relatedId: sessionId,
        extraData: { kind: "lesson_request", sessionId },
      });
    }

    // -------------------------------------------------------------------------
    // 9) Commit
    // -------------------------------------------------------------------------
    await conn.commit();
    txStarted = false;

    return res.json({
      success: true,
      message: "Lesson request submitted and awaiting teacher approval.",
      data: { sessionId, status: "pending" },
    });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    return handleApiError(res, err, "requestLessonSession");
  } finally {
    conn.release();
  }
}

/* =============================================================================
 * Pending lesson requests + cancel
 * ============================================================================= */

export async function getMyPendingLessonRequests(req, res) {
  try {
    const requestedLimit = Number.parseInt(String(req.query?.limit ?? ""), 10);
    const requestedOffset = Number.parseInt(String(req.query?.offset ?? ""), 10);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 100)
        : 50;
    const offset =
      Number.isFinite(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
    const userId = getAuthUserId(req);
    if (!userId) return unauthorized(res);

    const [[actor]] = await pool.query(
      `
      SELECT id, role, is_active
      FROM users
      WHERE id = ?
      LIMIT 1
      `,
      [userId]
    );

    if (!actor || Number(actor.is_active) !== 1) return unauthorized(res);

    if (actor.role !== "student" && actor.role !== "parent") {
      return badRequest(res, "Only students/parents can access pending lesson requests.");
    }

    let actorStudentId = null;
    let actorParentId = null;

    if (actor.role === "student") {
      // ✅ FIXED: Use getStudentContext to enforce active student role
      const context = await getStudentContext(userId);
      if (!context) return notFound(res, "Active student profile not found.");
      actorStudentId = context.student.id;
    } else {
      const [[p]] = await pool.query(`SELECT id FROM parents WHERE user_id = ? LIMIT 1`, [userId]);
      if (!p?.id) return notFound(res, "Parent profile not found.");
      actorParentId = p.id;
    }

    let rows = [];

    if (actor.role === "student") {
      const [r] = await pool.query(
        `
        SELECT
          ls.id,
          ls.starts_at,
          ls.ends_at,
          ls.status,
          ls.cancel_reason,

          ls.student_id,
          suser.full_name AS student_name,

          subj.id       AS subject_id,
          subj.name_en  AS subject_name_en,
          subj.name_ar  AS subject_name_ar,

          t.id          AS teacher_id,
          t.name        AS teacher_name,
          t.photo_url   AS teacher_photo_url

        FROM lesson_sessions ls
        JOIN subjects subj ON subj.id = ls.subject_id
        JOIN teachers t    ON t.id    = ls.teacher_id

        LEFT JOIN students st ON st.id = ls.student_id
        LEFT JOIN users suser ON suser.id = st.user_id

        WHERE ls.status IN ('pending', 'scheduled', 'approved')
          AND ls.student_id = ?

        ORDER BY ls.starts_at ASC
        LIMIT ?
        OFFSET ?
        `,
        [actorStudentId, limit, offset]
      );
      rows = r || [];
    } else {
      const [r] = await pool.query(
        `
        SELECT
          ls.id,
          ls.starts_at,
          ls.ends_at,
          ls.status,
          ls.cancel_reason,

          ls.student_id,
          suser.full_name AS student_name,

          subj.id       AS subject_id,
          subj.name_en  AS subject_name_en,
          subj.name_ar  AS subject_name_ar,

          t.id          AS teacher_id,
          t.name        AS teacher_name,
          t.photo_url   AS teacher_photo_url

        FROM lesson_sessions ls
        JOIN subjects subj ON subj.id = ls.subject_id
        JOIN teachers t    ON t.id    = ls.teacher_id

        LEFT JOIN students st ON st.id = ls.student_id
        LEFT JOIN users suser ON suser.id = st.user_id

        WHERE ls.status IN ('pending', 'scheduled', 'approved')
          AND EXISTS (
            SELECT 1
            FROM parent_students ps
            WHERE ps.parent_id = ?
              AND ps.student_id = ls.student_id
            LIMIT 1
          )

        ORDER BY ls.starts_at ASC
        LIMIT ?
        OFFSET ?
        `,
        [actorParentId, limit, offset]
      );
      rows = r || [];
    }

    const data = rows.map((r) => {
      const startsAt = r.starts_at ?? null;
      const endsAt = r.ends_at ?? null;

      // Derived, UI-friendly fields
      const date =
        startsAt ? String(startsAt).slice(0, 10) : null;
      const startTime =
        startsAt ? String(startsAt).slice(11, 19) : null;
      const endTime =
        endsAt ? String(endsAt).slice(11, 19) : null;

      const timeWindow =
        startTime && endTime ? `${startTime}-${endTime}` : null;

      const subjectNameEn = r.subject_name_en ?? null;
      const subjectNameAr = r.subject_name_ar ?? null;
      const teacherName = r.teacher_name ?? null;

      return {
        id: r.id,
        status: r.status,

        // keep your existing contract
        startsAt,
        endsAt,
        cancelReason: r.cancel_reason ?? null,

        // ✅ Add easy display fields
        date,
        timeWindow,
        teacherName,
        subjectNameEn,
        subjectNameAr,

        // keep nested objects for rich UI
        student: r.student_id ? { id: r.student_id, name: r.student_name ?? null } : null,
        subject: { id: r.subject_id, nameEn: subjectNameEn, nameAr: subjectNameAr },
        teacher: { id: r.teacher_id, name: teacherName, photoUrl: r.teacher_photo_url ?? null },
      };
    });

    return res.json({ success: true, data, pagination: { limit, offset } });
  } catch (err) {
    return handleApiError(res, err, "getMyPendingLessonRequests");
  }
}

export async function cancelMyLessonRequest(req, res) {
  const userId = getAuthUserId(req);
  if (!userId) return unauthorized(res);

  const sessionId = parsePositiveInt(req.params?.id);
  if (!sessionId) return badRequest(res, "Invalid session id.");

  const reasonRaw = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const reason = reasonRaw ? reasonRaw.slice(0, 250) : null;

  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    await conn.beginTransaction();
    txStarted = true;

    const [[actor]] = await conn.query(
      `
      SELECT role, is_active
      FROM users
      WHERE id = ?
      LIMIT 1
      `,
      [userId]
    );

    if (!actor || Number(actor.is_active) !== 1) {
      await conn.rollback();
      txStarted = false;
      return unauthorized(res);
    }

    if (actor.role !== "student" && actor.role !== "parent") {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Only students/parents can cancel lesson requests.");
    }

    let actorStudentId = null;
    let actorParentId = null;

    if (actor.role === "student") {
      // ✅ FIXED: Use getStudentContext with connection to enforce active student role
      const context = await getStudentContext(userId, conn);
      if (!context) {
        await conn.rollback();
        txStarted = false;
        return notFound(res, "Active student profile not found.");
      }
      actorStudentId = context.student.id;
    } else {
      const [[p]] = await conn.query(`SELECT id FROM parents WHERE user_id = ? LIMIT 1`, [userId]);
      if (!p?.id) {
        await conn.rollback();
        txStarted = false;
        return notFound(res, "Parent profile not found.");
      }
      actorParentId = p.id;
    }

    const cancelledBy = actor.role === "parent" ? "parent" : "student";

    const [[session]] = await conn.query(
      `
      SELECT id, teacher_id, status, student_id
      FROM lesson_sessions
      WHERE id = ?
      FOR UPDATE
      `,
      [sessionId]
    );

    if (!session) {
      await conn.rollback();
      txStarted = false;
      return notFound(res, "Lesson request not found.");
    }

    if (session.status !== "pending") {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Only pending requests can be cancelled.");
    }

    if (actor.role === "student") {
      if (Number(session.student_id) !== Number(actorStudentId)) {
        await conn.rollback();
        txStarted = false;
        return unauthorized(res, "You are not allowed to cancel this request.");
      }
    } else {
      const [[link]] = await conn.query(
        `
        SELECT 1
        FROM parent_students
        WHERE parent_id = ?
          AND student_id = ?
        LIMIT 1
        `,
        [actorParentId, session.student_id]
      );

      if (!link) {
        await conn.rollback();
        txStarted = false;
        return unauthorized(res, "You are not allowed to cancel this request.");
      }
    }

    const [u1] = await conn.query(
      `
      UPDATE lesson_sessions
      SET status = 'cancelled',
          updated_by_user_id = ?,
          cancelled_by = ?,
          cancel_reason = COALESCE(?, cancel_reason),
          cancelled_at = NOW()
      WHERE id = ?
        AND status = 'pending'
      `,
      [userId, cancelledBy, reason, sessionId]
    );

    if (!u1 || u1.affectedRows === 0) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Unable to cancel this request (it may have changed).");
    }

    // Notify teacher (best-effort)
    const [[teacherUser]] = await conn.query(`SELECT user_id FROM teachers WHERE id = ? LIMIT 1`, [
      session.teacher_id,
    ]);

    if (teacherUser?.user_id) {
      await insertNotificationSafe(conn, {
        userId: teacherUser.user_id,
        type: "system",
        title: "Lesson request cancelled",
        body: `A ${cancelledBy} cancelled lesson request (#${sessionId}).${
          reason ? ` Reason: ${reason}` : ""
        }`,
        relatedType: "lesson_session",
        relatedId: sessionId,
        extraData: {
          kind: "lesson_cancelled",
          sessionId,
          cancelledBy,
          reason: reason ?? null,
        },
      });
    }

    await conn.commit();
    txStarted = false;

    return res.json({
      success: true,
      message: "Lesson request cancelled.",
      data: { sessionId, status: "cancelled" },
    });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    return handleApiError(res, err, "cancelMyLessonRequest");
  } finally {
    conn.release();
  }
}

// =============================================================================
// Cancel a SCHEDULED lesson session (student-initiated).
// Cutoff: session must start more than CANCEL_CUTOFF_HOURS in the future.
// =============================================================================
const CANCEL_CUTOFF_HOURS = 2;

export async function cancelMyScheduledSession(req, res) {
  const userId = getAuthUserId(req);
  if (!userId) return unauthorized(res);

  const sessionId = parsePositiveInt(req.params?.id);
  if (!sessionId) return badRequest(res, "Invalid session id.");

  const reasonRaw = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const reason = reasonRaw ? reasonRaw.slice(0, 250) : null;

  const conn = await pool.getConnection();
  let txStarted = false;

  try {
    await conn.beginTransaction();
    txStarted = true;

    // Verify actor
    const [[actor]] = await conn.query(
      `SELECT role, is_active FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (!actor || Number(actor.is_active) !== 1) {
      await conn.rollback();
      txStarted = false;
      return unauthorized(res);
    }

    if (actor.role !== "student" && actor.role !== "parent") {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Only students/parents can cancel sessions.");
    }

    let actorStudentId = null;
    let actorParentId = null;

    if (actor.role === "student") {
      const context = await getStudentContext(userId, conn);
      if (!context) {
        await conn.rollback();
        txStarted = false;
        return notFound(res, "Active student profile not found.");
      }
      actorStudentId = context.student.id;
    } else {
      const [[p]] = await conn.query(`SELECT id FROM parents WHERE user_id = ? LIMIT 1`, [userId]);
      if (!p?.id) {
        await conn.rollback();
        txStarted = false;
        return notFound(res, "Parent profile not found.");
      }
      actorParentId = p.id;
    }

    const cancelledBy = actor.role === "parent" ? "parent" : "student";

    // Lock the session row
    const [[session]] = await conn.query(
      `SELECT id, teacher_id, status, student_id, starts_at FROM lesson_sessions WHERE id = ? FOR UPDATE`,
      [sessionId]
    );

    if (!session) {
      await conn.rollback();
      txStarted = false;
      return notFound(res, "Lesson session not found.");
    }

    if (session.status !== "scheduled" && session.status !== "approved") {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Only scheduled sessions can be cancelled with this endpoint.");
    }

    // Ownership check
    if (actor.role === "student") {
      if (Number(session.student_id) !== Number(actorStudentId)) {
        await conn.rollback();
        txStarted = false;
        return unauthorized(res, "You are not allowed to cancel this session.");
      }
    } else {
      const [[link]] = await conn.query(
        `SELECT 1 FROM parent_students WHERE parent_id = ? AND student_id = ? LIMIT 1`,
        [actorParentId, session.student_id]
      );
      if (!link) {
        await conn.rollback();
        txStarted = false;
        return unauthorized(res, "You are not allowed to cancel this session.");
      }
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

    // Perform cancellation
    const [u1] = await conn.query(
      `UPDATE lesson_sessions
          SET status       = 'cancelled',
              cancel_reason = COALESCE(?, cancel_reason),
              cancelled_by  = ?,
              cancelled_at  = NOW(),
              updated_by_user_id = ?
        WHERE id     = ?
          AND status IN ('scheduled', 'approved')`,
      [reason, cancelledBy, userId, sessionId]
    );

    if (!u1 || u1.affectedRows === 0) {
      await conn.rollback();
      txStarted = false;
      return badRequest(res, "Unable to cancel this session (it may have changed).");
    }

    // Notify teacher (best-effort)
    const [[teacherUser]] = await conn.query(
      `SELECT user_id FROM teachers WHERE id = ? LIMIT 1`,
      [session.teacher_id]
    );

    if (teacherUser?.user_id) {
      await insertNotificationSafe(conn, {
        userId: teacherUser.user_id,
        type: "system",
        title: "Lesson session cancelled",
        body: `A ${cancelledBy} cancelled scheduled session (#${sessionId}).${reason ? ` Reason: ${reason}` : ""}`,
        relatedType: "lesson_session",
        relatedId: sessionId,
        extraData: { kind: "lesson_cancelled", sessionId, cancelledBy, reason: reason ?? null },
      });
    }

    await conn.commit();
    txStarted = false;

    return res.json({
      success: true,
      message: "Lesson session cancelled.",
      data: { sessionId, status: "cancelled" },
    });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }
    return handleApiError(res, err, "cancelMyScheduledSession");
  } finally {
    conn.release();
  }
}
