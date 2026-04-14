// src/controllers/auth.controller.js
// ============================================================================
// Auth Controller (PRODUCTION-READY / SESSION-COOKIE AUTH) 
// ----------------------------------------------------------------------------

// 1. Schedule time comparison uses seconds (not string compare)
// 2. Cleaned up redundant maxStudents check
// 3. Enforce non-empty subjectIds/gradeLevelIds after cleaning
// 4. Teacher login checks teachers.is_active
// 5. OTP cleanup removes old OTPs for same email
// 6. Consistent role normalization using safeRole()

// ============================================================================

import pool from "../db.js";
import { sendOtpEmail } from "../utils/email.js";
import {
  AcademicScopeValidationError,
  normalizeRegistrationAcademicScope,
} from "../utils/academicScope.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { normalizeIncomingScheduleRow } from "../utils/scheduleContract.js";
import crypto from "crypto";
import fs from "fs";

// Import centralized session configuration
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "../config/session.js";

function hashOtpCode(code) {
  return crypto.createHash("sha256").update(String(code || ""), "utf8").digest("hex");
}

// ----------------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------------
function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function safeRole(role) {
  return String(role || "").toLowerCase();
}

function isEnabledFlag(value) {
  return value === true || Number(value) === 1;
}

async function getStudentDirectLoginPolicy(userId) {
  const [rows] = await pool.query(
    `
    SELECT
      s.id AS student_id,
      COUNT(ps.id) AS parent_link_count,
      MAX(CASE WHEN ps.has_own_login = 1 THEN 1 ELSE 0 END) AS direct_login_enabled,
      MAX(CASE WHEN u.email IS NULL THEN 1 ELSE 0 END) AS has_null_email_identity
    FROM students s
    INNER JOIN users u ON u.id = s.user_id
    LEFT JOIN parent_students ps ON ps.student_id = s.id
    WHERE s.user_id = ?
    GROUP BY s.id
    LIMIT 1
    `,
    [userId]
  );

  if (!rows.length) return null;

  return {
    studentId: rows[0].student_id,
    parentLinkCount: Number(rows[0].parent_link_count) || 0,
    directLoginEnabled: isEnabledFlag(rows[0].direct_login_enabled),
    hasNullEmailIdentity: isEnabledFlag(rows[0].has_null_email_identity),
  };
}

/**
 * Promisify express-session callbacks
 */
function sessionRegenerate(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}
function sessionSave(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}
function sessionDestroy(req) {
  return new Promise((resolve) => {
    req.session.destroy(() => resolve());
  });
}

/**
 * Centralized helper to set login session.
 * Regenerates session and starts with a clean identity-scoped state.
 */
async function setLoginSession(req, { id, full_name, email, role, extra = {} }) {
  if (!req.session) return false;
  
  // Prevent session fixation
  await sessionRegenerate(req);

  // Core user data in session
  req.session.user = {
    id,
    full_name: full_name || "",
    email: email ?? null,
    role: safeRole(role),
  };

  // Fresh metadata per authenticated identity.
  req.session.meta = { ...extra };

  req.session.authenticatedAt = new Date().toISOString();
  await sessionSave(req);

  return true;
}

/**
 * Best-effort file cleanup for uploaded videos
 */
function cleanupUploadedFiles(files) {
  try {
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

/**
 * Timing-safe string compare (for OTP)
 */
function timingSafeEqualStr(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

/**
 * Basic password policy
 */
function validatePassword(password) {
  const p = String(password || "");
  if (p.length < 8) return "Password must be at least 8 characters.";
  return null;
}

/**
 * ✅ FIXED: Convert time string to total seconds for accurate comparison
 * Supports HH:mm and HH:mm:ss formats
 */
function timeToSeconds(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  
  // Remove any whitespace
  const cleanTime = timeStr.trim();
  
  // Handle HH:mm and HH:mm:ss formats
  const parts = cleanTime.split(':');
  if (parts.length < 2 || parts.length > 3) return 0;
  
  const hours = parseInt(parts[0], 10) || 0;
  const minutes = parseInt(parts[1], 10) || 0;
  const seconds = parts.length === 3 ? (parseInt(parts[2], 10) || 0) : 0;
  
  // Validate ranges
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return 0;
  }
  
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Validate a canonical schedule row before persistence.
 */
function validateSchedule(schedule, rawSchedule = schedule) {
  const errors = [];

  if (schedule.weekday == null) {
    errors.push(`Invalid weekday: ${rawSchedule?.weekday}`);
  }

  if (!schedule.start_time) {
    errors.push(`Invalid start_time format: ${rawSchedule?.start_time ?? rawSchedule?.startTime}`);
  }

  if (!schedule.end_time) {
    errors.push(`Invalid end_time format: ${rawSchedule?.end_time ?? rawSchedule?.endTime}`);
  }

  if (schedule.start_time && schedule.end_time) {
    const startSeconds = timeToSeconds(schedule.start_time);
    const endSeconds = timeToSeconds(schedule.end_time);

    if (startSeconds >= endSeconds) {
      errors.push(`end_time (${schedule.end_time}) must be after start_time (${schedule.start_time})`);
    }
  }

  if (Number(schedule.is_group) === 1 && (schedule.max_students == null || Number(schedule.max_students) < 2)) {
    errors.push("Group sessions must have max_students >= 2");
  }

  return errors.length > 0 ? errors : null;
}

// ============================================================================
// SESSION-BASED AUTH ENDPOINTS
// ============================================================================

/* ============================================================================
 * GET /auth/me
 * ========================================================================= */
export const me = async (req, res) => {
  const u = req.session?.user;
  const rawSwitchCtx = req.session?.switch_ctx;
  const switchContext =
    rawSwitchCtx &&
    rawSwitchCtx.mode === "as_student" &&
    Number.isFinite(Number(rawSwitchCtx.parent_user_id)) &&
    Number.isFinite(Number(rawSwitchCtx.student_user_id))
      ? {
          mode: "as_student",
          parentUserId: Number(rawSwitchCtx.parent_user_id),
          studentUserId: Number(rawSwitchCtx.student_user_id),
          switchedAt:
            typeof rawSwitchCtx.switched_at === "string" ? rawSwitchCtx.switched_at : null,
        }
      : null;

  if (!u?.id) {
    return res.status(200).json({
      success: true,
      data: {
        authenticated: false,
        user: null,
        meta: {},
        activeStudentId: null,
        switchContext: null,
      },
    });
  }

  return res.status(200).json({
    success: true,
    data: {
      authenticated: true,
      user: u,
      meta: req.session?.meta || {},
      activeStudentId: req.session?.activeStudentId ?? null,
      switchContext,
    },
  });
};


/* ============================================================================
 * POST /auth/register-student
 * ========================================================================= */
export const registerStudent = async (req, res) => {
  const {
    fullName,
    email,
    password,
    preferredLang,
  } = req.body || {};

  const normalizedFullName = String(fullName || "").trim();
  const cleanEmail = normalizeEmail(email);

  if (!normalizedFullName || !cleanEmail || !password) {
    return res.status(400).json({
      success: false,
      message: "fullName, email and password are required.",
    });
  }

  const pwErr = validatePassword(password);
  if (pwErr) {
    return res.status(400).json({ success: false, message: pwErr });
  }

  const studentLang = preferredLang === "en" ? "en" : "ar";

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const normalizedScope = await normalizeRegistrationAcademicScope(
      req.body || {},
      conn,
      { requireSystemStage: true }
    );

    const [rows] = await conn.query("SELECT id FROM users WHERE email = ? LIMIT 1", [
      cleanEmail,
    ]);
    if (rows.length > 0) {
      await conn.rollback();
      return res.status(409).json({
        success: false,
        message: "Email already registered.",
        code: "EMAIL_ALREADY_EXISTS",
      });
    }

    const passwordHash = await hashPassword(password);

    const [userResult] = await conn.query(
      `
      INSERT INTO users (full_name, email, password_hash, role, preferred_lang, is_active)
      VALUES (?, ?, ?, 'student', ?, 1)
      `,
      [normalizedFullName, cleanEmail, passwordHash, studentLang]
    );

    const userId = userResult.insertId;

    const [studentResult] = await conn.query(
      `
      INSERT INTO students (
        user_id,
        system_id,
        stage_id,
        grade_level_id,
        grade_stage,
        grade_number,
        onboarding_completed
      )
      VALUES (?, ?, ?, ?, ?, ?, 0)
      `,
      [
        userId,
        normalizedScope.systemId,
        normalizedScope.stageId,
        normalizedScope.gradeLevelId,
        normalizedScope.legacyScope.gradeStage,
        normalizedScope.legacyScope.gradeNumber,
      ]
    );
    const studentId = studentResult.insertId;

    await conn.commit();

    // Auto-login
    const sessionOk = await setLoginSession(req, {
      id: userId,
      full_name: normalizedFullName,
      email: cleanEmail,
      role: "student",
    });

    return res.status(201).json({
      success: true,
      message: "Student registered successfully.",
      data: {
        userId,
        studentId,
        fullName: normalizedFullName,
        email: cleanEmail,
        role: "student",
        preferredLang: studentLang,
        academicScope: {
          systemId: normalizedScope.systemId,
          stageId: normalizedScope.stageId,
          gradeLevelId: normalizedScope.gradeLevelId,
        },
        academicScopeSource: normalizedScope.source,
      },
      ...(sessionOk ? {} : { warning: "SESSION_NOT_CONFIGURED" }),
    });
  } catch (err) {
    console.error("registerStudent error:", err);

    if (conn) {
      try {
        await conn.rollback();
      } catch {
        // ignore
      }
    }

    if (err instanceof AcademicScopeValidationError) {
      return res.status(err.status || 400).json({
        success: false,
        message: err.message,
        code: err.code,
        ...(process.env.NODE_ENV === "development" && { details: err.details }),
      });
    }

    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "This email is already registered. Please log in or use a different email.",
        code: "EMAIL_ALREADY_EXISTS",
      });
    }

    return res.status(500).json({ success: false, message: "Internal server error." });
  } finally {
    if (conn) conn.release();
  }
};

/* ============================================================================
 * POST /auth/register-teacher
 * ========================================================================= */
export const registerTeacher = async (req, res) => {
  let payload = null;

  try {
    if (typeof req.body?.payload === "string") payload = JSON.parse(req.body.payload);
    else if (req.body && typeof req.body === "object") payload = req.body;
  } catch {
    return res.status(400).json({ success: false, message: "Invalid JSON payload." });
  }

  const uploadedFiles = Array.isArray(req.files) ? req.files : [];
  const uploadedUrls = uploadedFiles.map((f) => `/uploads/teacher-videos/${f.filename}`);

  const {
    fullName,
    email,
    password,
    preferredLang,

    phone,
    nationality,
    dateOfBirth,
    gender,
    photoUrl,

    yearsOfExperience,
    highestQualification,
    university,
    specialization,
    currentOccupation,

    teachingStyle,
    hourlyRate,
    teachingPhilosophy,
    achievements,
    bio,
    referencesText,

    educationSystemId,
    gradeLevelIds,
    subjectIds,
    schedules,
  } = payload || {};

  // Required validation
  if (!fullName || !email || !password) {
    cleanupUploadedFiles(uploadedFiles);
    return res.status(400).json({ success: false, message: "fullName, email and password are required." });
  }
  
  const pwErr = validatePassword(password);
  if (pwErr) {
    cleanupUploadedFiles(uploadedFiles);
    return res.status(400).json({ success: false, message: pwErr });
  }

  if (!phone || !nationality || !dateOfBirth) {
    cleanupUploadedFiles(uploadedFiles);
    return res.status(400).json({
      success: false,
      message: "phone, nationality, and dateOfBirth are required.",
    });
  }
  
  // Check for null/undefined, not falsy (allows 0 years of experience)
  if (yearsOfExperience == null || !highestQualification) {
    cleanupUploadedFiles(uploadedFiles);
    return res.status(400).json({
      success: false,
      message: "yearsOfExperience and highestQualification are required.",
    });
  }
  
  if (!Array.isArray(subjectIds) || subjectIds.length === 0) {
    cleanupUploadedFiles(uploadedFiles);
    return res.status(400).json({ success: false, message: "At least one subjectId is required." });
  }
  
  if (!Array.isArray(gradeLevelIds) || gradeLevelIds.length === 0) {
    cleanupUploadedFiles(uploadedFiles);
    return res.status(400).json({ success: false, message: "At least one gradeLevelId is required." });
  }
  
  if (!Array.isArray(schedules) || schedules.length === 0) {
    cleanupUploadedFiles(uploadedFiles);
    return res.status(400).json({ success: false, message: "At least one schedule slot is required." });
  }

  // Normalize
  const cleanEmail = normalizeEmail(email);
  const lang = preferredLang === "en" ? "en" : "ar";

  const cleanSubjectIds = subjectIds
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
  
  const cleanGradeLevelIds = gradeLevelIds
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);

  // ✅ FIXED: Validate that we still have valid IDs after cleaning
  if (cleanSubjectIds.length === 0) {
    cleanupUploadedFiles(uploadedFiles);
    return res.status(400).json({ 
      success: false, 
      message: "No valid subject IDs provided. Please check your subject selections." 
    });
  }
  
  if (cleanGradeLevelIds.length === 0) {
    cleanupUploadedFiles(uploadedFiles);
    return res.status(400).json({ 
      success: false, 
      message: "No valid grade level IDs provided. Please check your grade level selections." 
    });
  }

  // Validate schedules
  const scheduleErrors = [];
  const cleanSchedules = [];
  
  for (const s of schedules) {
    const schedule = normalizeIncomingScheduleRow(s);
    const errors = validateSchedule(schedule, s);
    if (errors) {
      scheduleErrors.push(...errors);
    } else {
      cleanSchedules.push(schedule);
    }
  }

  if (scheduleErrors.length > 0) {
    cleanupUploadedFiles(uploadedFiles);
    return res.status(400).json({
      success: false,
      message: "Schedule validation failed",
      errors: scheduleErrors,
    });
  }

  if (cleanSchedules.length === 0) {
    cleanupUploadedFiles(uploadedFiles);
    return res.status(400).json({ success: false, message: "No valid schedules provided." });
  }

  let conn;

  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Unique email check
    const [existing] = await conn.query("SELECT id FROM users WHERE email = ? LIMIT 1", [
      cleanEmail,
    ]);
    if (existing.length > 0) {
      await conn.rollback();
      cleanupUploadedFiles(uploadedFiles);
      return res.status(409).json({ success: false, message: "Email already registered." });
    }

    // Teacher approval gating (Option A)
    const passwordHash = await hashPassword(password);
    const [userResult] = await conn.query(
      `
      INSERT INTO users (full_name, email, password_hash, role, preferred_lang, is_active)
      VALUES (?, ?, ?, 'teacher', ?, 1)
      `,
      [fullName, cleanEmail, passwordHash, lang]
    );
    const userId = userResult.insertId;

    // Create teacher profile with is_active = 1
    const [teacherResult] = await conn.query(
      `
      INSERT INTO teachers (
        user_id, name, bio_short, gender, photo_url, is_active, status,
        years_of_experience, highest_qualification, hourly_rate,
        teaching_philosophy, achievements,
        phone, nationality, date_of_birth, university, specialization, current_occupation,
        teaching_style, bio_long, references_text, education_system_id
      )
      VALUES (
        ?, ?, NULL, ?, ?, 1, 'pending_review',
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      `,
      [
        userId,
        fullName,
        gender || null,
        photoUrl || null,

        String(yearsOfExperience),
        String(highestQualification),
        hourlyRate != null ? String(hourlyRate) : null,

        teachingPhilosophy || null,
        achievements || null,

        String(phone),
        String(nationality),
        dateOfBirth,
        university || null,
        specialization || null,
        currentOccupation || null,

        teachingStyle || null,
        bio || null,
        referencesText || null,
        educationSystemId ? Number(educationSystemId) : null,
      ]
    );
    const teacherId = teacherResult.insertId;

    // teacher_subjects
    {
      const values = cleanSubjectIds.map(() => "(?, ?)").join(", ");
      const params = [];
      cleanSubjectIds.forEach((sid) => params.push(teacherId, sid));
      await conn.query(`INSERT INTO teacher_subjects (teacher_id, subject_id) VALUES ${values}`, params);
    }

    // teacher_grade_levels
    {
      const values = cleanGradeLevelIds.map(() => "(?, ?)").join(", ");
      const params = [];
      cleanGradeLevelIds.forEach((gid) => params.push(teacherId, gid));
      await conn.query(
        `INSERT INTO teacher_grade_levels (teacher_id, grade_level_id) VALUES ${values}`,
        params
      );
    }

    // Teacher schedules require canonical schema including max_students.
    const values = cleanSchedules.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    const params = [];
    cleanSchedules.forEach((s) =>
      params.push(
        teacherId,
        s.weekday,
        s.start_time,
        s.end_time,
        s.is_group,
        s.max_students,
        s.is_active
      )
    );

    await conn.query(
      `
      INSERT INTO teacher_schedules (teacher_id, weekday, start_time, end_time, is_group, max_students, is_active)
      VALUES ${values}
      `,
      params
    );

    // teacher_videos
    if (uploadedUrls.length > 0) {
      const values = uploadedUrls.map(() => "(?, NULL, ?, ?)").join(", ");
      const params = [];
      uploadedUrls.forEach((url, idx) => params.push(teacherId, url, idx === 0 ? 1 : 0));
      await conn.query(
        `
        INSERT INTO teacher_videos (teacher_id, subject_id, video_url, is_primary)
        VALUES ${values}
        `,
        params
      );
    }

    await conn.commit();

    // Auto-login with teacher metadata
    const sessionOk = await setLoginSession(req, {
      id: userId,
      full_name: fullName,
      email: cleanEmail,
      role: "teacher",
      extra: {
        teacher: { teacherId, status: "pending_review" },
      },
    });

    return res.status(201).json({
      success: true,
      message: "Teacher registered successfully. Your account is pending admin approval.",
      data: { 
        userId, 
        teacherId, 
        fullName, 
        email: cleanEmail, 
        role: "teacher", 
        status: "pending_review" 
      },
      ...(sessionOk ? {} : { warning: "SESSION_NOT_CONFIGURED" }),
    });

  } catch (err) {
    console.error("registerTeacher error:", err);

    if (conn) {
      try {
        await conn.rollback();
      } catch {
        // ignore
      }
    }

    cleanupUploadedFiles(uploadedFiles);

    if (err?.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        success: false,
        message: "This email is already registered. Please log in or use a different email.",
        code: "EMAIL_ALREADY_EXISTS",
      });
    }

    return res.status(500).json({ success: false, message: "Internal server error." });
  } finally {
    if (conn) conn.release();
  }
};

/* ============================================================================
 * POST /auth/register-parent-with-children
 * ========================================================================= */
export const registerParentWithChildren = async (req, res) => {
  const { parent, children, contactOption } = req.body || {};

  if (!parent || typeof parent !== "object") {
    return res.status(400).json({ success: false, message: "Parent object is required." });
  }

  const { fullName, email, password, phone, preferredLang, notes } = parent;

  if (!fullName || !email || !password) {
    return res.status(400).json({
      success: false,
      message: "Parent fullName, email and password are required.",
    });
  }

  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ success: false, message: pwErr });

  if (!Array.isArray(children) || children.length === 0) {
    return res.status(400).json({
      success: false,
      message: "At least one child must be provided in children[].",
    });
  }

  const normalizedContactOption = contactOption === "individual" ? "individual" : "parent";

  // Validate children upfront
  for (const [index, child] of children.entries()) {
    if (!child || typeof child !== "object") {
      return res.status(400).json({ success: false, message: `Child at index ${index} is invalid.` });
    }
    if (!child.fullName) {
      return res.status(400).json({ success: false, message: `Child at index ${index} is missing fullName.` });
    }
    if (normalizedContactOption === "individual" && !normalizeEmail(child.email)) {
      return res.status(400).json({
        success: false,
        message: `Child at index ${index} is missing email (individual contact mode).`,
      });
    }
    if (normalizedContactOption === "individual" && !child.password) {
      return res.status(400).json({
        success: false,
        message: `Child at index ${index} is missing password (individual contact mode).`,
      });
    }
    if (normalizedContactOption === "individual") {
      const childPwErr = validatePassword(child.password);
      if (childPwErr) {
        return res.status(400).json({
          success: false,
          message: `Child at index ${index} has an invalid password. ${childPwErr}`,
        });
      }
    }
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const cleanParentEmail = normalizeEmail(email);

    const [existingParentRows] = await conn.query("SELECT id FROM users WHERE email = ? LIMIT 1", [
      cleanParentEmail,
    ]);
    if (existingParentRows.length > 0) {
      await conn.rollback();
      return res.status(409).json({
        success: false,
        message:
          "This parent email is already registered. If you already have an account, please log in instead.",
        field: "email",
        code: "PARENT_EMAIL_EXISTS",
      });
    }

    const parentPasswordHash = await hashPassword(password);
    const parentLang = preferredLang === "en" ? "en" : "ar";

    // Parent user
    const [parentUserResult] = await conn.query(
      `
      INSERT INTO users (full_name, email, password_hash, role, preferred_lang, is_active)
      VALUES (?, ?, ?, 'parent', ?, 1)
      `,
      [fullName, cleanParentEmail, parentPasswordHash, parentLang]
    );
    const parentUserId = parentUserResult.insertId;

    // Parent profile
    const [parentRowResult] = await conn.query(
      `
      INSERT INTO parents (user_id, phone, notes)
      VALUES (?, ?, ?)
      `,
      [parentUserId, phone || null, notes || null]
    );
    const parentId = parentRowResult.insertId;

    const createdChildren = [];

    for (const child of children) {
      const {
        fullName: childName,
        email: childEmail,
        password: childPassword,
        relationship,
        preferredLang: childLang,
        gender,
        subjectIds,
      } = child;

      const normalizedScope = await normalizeRegistrationAcademicScope(
        child,
        conn,
        { requireSystemStage: true }
      );

      const finalChildLang = childLang === "en" ? "en" : parentLang;
      const rel = relationship || "mother";
      const normalizedGender = gender === "male" || gender === "female" ? gender : null;

      const childSubjectIds = Array.isArray(subjectIds)
        ? subjectIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0)
        : [];
      const hasOwnLogin = normalizedContactOption === "individual" ? 1 : 0;

      let childUserId = null;

      if (normalizedContactOption === "individual") {
        const cleanChildEmail = normalizeEmail(childEmail);

        const [existingChildRows] = await conn.query("SELECT id FROM users WHERE email = ? LIMIT 1", [
          cleanChildEmail,
        ]);
        if (existingChildRows.length > 0) {
          await conn.rollback();
          return res.status(409).json({
            success: false,
            message: `Child email is already registered: ${cleanChildEmail}. Please use a different email or choose 'Use parent contacts' instead.`,
            field: "childEmail",
            code: "CHILD_EMAIL_EXISTS",
          });
        }

        const childPasswordHash = await hashPassword(childPassword);

        const [childUserResult] = await conn.query(
          `
          INSERT INTO users (full_name, email, password_hash, role, preferred_lang, is_active)
          VALUES (?, ?, ?, 'student', ?, 1)
          `,
          [childName, cleanChildEmail, childPasswordHash, finalChildLang]
        );

        childUserId = childUserResult.insertId;
      } else {
        // Store a unique random hash so the child row never inherits the
        // parent's password hash while direct login remains disabled.
        const disabledLoginPasswordHash = await hashPassword(crypto.randomBytes(32).toString("hex"));

        const [childUserResult] = await conn.query(
          `
          INSERT INTO users (full_name, email, password_hash, role, preferred_lang, is_active)
          VALUES (?, NULL, ?, 'student', ?, 1)
          `,
          [childName, disabledLoginPasswordHash, finalChildLang]
        );
        childUserId = childUserResult.insertId;
      }

      // Invariant: every student row must be backed by a users row.
      // Both branches above always set childUserId; this assertion makes the
      // invariant explicit so the code is already compatible with a future
      // NOT NULL migration on students.user_id.
      if (!childUserId) {
        throw new Error(
          `INTERNAL: childUserId not resolved for child '${childName}' – cannot create student row without a linked user identity.`
        );
      }

      // Student profile
      const [studentResult] = await conn.query(
        `
        INSERT INTO students (
          user_id,
          system_id,
          stage_id,
          grade_level_id,
          grade_stage,
          grade_number,
          gender,
          onboarding_completed
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
        `,
        [
          childUserId,
          normalizedScope.systemId,
          normalizedScope.stageId,
          normalizedScope.gradeLevelId,
          normalizedScope.legacyScope.gradeStage,
          normalizedScope.legacyScope.gradeNumber,
          normalizedGender,
        ]
      );
      const studentId = studentResult.insertId;

      // Link
      await conn.query(
        `
        INSERT INTO parent_students (parent_id, student_id, relationship, has_own_login)
        VALUES (?, ?, ?, ?)
        `,
        [parentId, studentId, rel, hasOwnLogin]
      );

      // Subjects
      if (childSubjectIds.length > 0) {
        const valuesSql = childSubjectIds.map(() => "(?, ?)").join(", ");
        const params = [];
        childSubjectIds.forEach((sid) => params.push(studentId, sid));
        await conn.query(
          `
          INSERT INTO student_subjects (student_id, subject_id)
          VALUES ${valuesSql}
          `,
          params
        );
      }

      createdChildren.push({
        studentId,
        studentUserId: childUserId,
        fullName: childName,
        email: normalizedContactOption === "individual" ? normalizeEmail(childEmail) : cleanParentEmail,
        hasOwnLogin: hasOwnLogin === 1,
        contactType: normalizedContactOption,
        systemId: normalizedScope.systemId,
        stageId: normalizedScope.stageId,
        gradeLevelId: normalizedScope.gradeLevelId,
        relationship: rel,
        gender: normalizedGender,
        subjectIds: childSubjectIds,
      });
    }

    await conn.commit();

    // Auto-login for parent
    const sessionOk = await setLoginSession(req, {
      id: parentUserId,
      full_name: fullName,
      email: cleanParentEmail,
      role: "parent",
    });

    return res.status(201).json({
      success: true,
      message: "Parent and children registered successfully.",
      data: {
        parentUserId,
        parentId,
        parent: {
          fullName,
          email: cleanParentEmail,
          phone: phone || null,
          preferredLang: parentLang,
        },
        children: createdChildren,
        contactOption: normalizedContactOption,
      },
      ...(sessionOk ? {} : { warning: "SESSION_NOT_CONFIGURED" }),
    });
  } catch (err) {
    console.error("registerParentWithChildren error:", err);

    if (conn) {
      try {
        await conn.rollback();
      } catch {
        // ignore
      }
    }

    let errorMessage = "Internal server error while registering parent and children.";
    let statusCode = 500;
    let errorCode = "UNKNOWN_ERROR";

    if (err instanceof AcademicScopeValidationError) {
      return res.status(err.status || 400).json({
        success: false,
        message: err.message,
        code: err.code,
        ...(process.env.NODE_ENV === "development" && { details: err.details }),
      });
    } else if (err?.code === "ER_DUP_ENTRY") {
      statusCode = 409;
      errorCode = "DB_DUPLICATE_ENTRY";
      errorMessage =
        err?.sqlMessage?.includes("users.email")
          ? "This email is already registered in the system. Please log in instead, or use a different email."
          : "A record with the same unique value already exists (likely an email conflict).";
    } else if (err?.code === "ER_NO_REFERENCED_ROW") {
      errorCode = "DB_FOREIGN_KEY_ERROR";
      errorMessage = "Database constraint error – a referenced record is missing (foreign key).";
    } else if (err?.code === "ER_DATA_TOO_LONG") {
      errorCode = "DB_DATA_TOO_LONG";
      errorMessage = "One of the fields contains data that is too long. Please shorten it and try again.";
    } else if (err?.code === "ER_BAD_NULL_ERROR") {
      errorCode = "DB_BAD_NULL_ERROR";
      errorMessage = "A required database field was empty. Please ensure all required fields are filled.";
    }

    return res.status(statusCode).json({
      success: false,
      message: errorMessage,
      code: errorCode,
      ...(process.env.NODE_ENV === "development" && {
        details: err?.message,
        dbCode: err?.code,
      }),
    });
  } finally {
    if (conn) conn.release();
  }
};

/* ============================================================================
 * POST /auth/login
 * ✅ FIXED: Teacher login now checks teachers.is_active
 * ========================================================================= */
export const login = async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password are required." });
  }

  const cleanEmail = normalizeEmail(email);

  try {
    const [rows] = await pool.query(
      `
      SELECT id, full_name, email, password_hash, role, is_active
      FROM users
      WHERE email = ?
      LIMIT 1
      `,
      [cleanEmail]
    );

    if (!rows.length) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    const user = rows[0];

    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    if (safeRole(user.role) === "student") {
      const directLoginPolicy = await getStudentDirectLoginPolicy(user.id);

      if (
        directLoginPolicy &&
        directLoginPolicy.parentLinkCount > 0 &&
        directLoginPolicy.hasNullEmailIdentity &&
        !directLoginPolicy.directLoginEnabled
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Direct login is disabled for this child account. Please sign in through the parent account.",
          code: "STUDENT_DIRECT_LOGIN_DISABLED",
        });
      }
    }

    if (!user.is_active) {
      return res.status(403).json({
        success: false,
        message: "Your account is inactive. Please contact support.",
      });
    }

    // Teachers must be approved and active
    if (safeRole(user.role) === "teacher") {
      // ✅ FIXED: Check both status and is_active
      const [teacherRows] = await pool.query(
        `SELECT id, status, is_active FROM teachers WHERE user_id = ? LIMIT 1`,
        [user.id]
      );

      if (!teacherRows.length) {
        return res.status(403).json({
          success: false,
          message: "Teacher profile not found. Please contact support.",
        });
      }

      const teacher = teacherRows[0];
      
      // ✅ FIXED: Check teacher.is_active
      if (!teacher.is_active) {
        return res.status(403).json({
          success: false,
          message: "Your teacher account is inactive. Please contact support.",
        });
      }
      
      const status = teacher.status;
      if (status !== "approved") {
        return res.status(403).json({
          success: false,
          message:
            status === "pending_review"
              ? "Your teacher account is pending admin approval."
              : "Your teacher account has been rejected. Please contact support.",
        });
      }

      const teacherId = teacher.id;
      const sessionOk = await setLoginSession(req, {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: "teacher",
        extra: {
          teacher: { teacherId, status: "approved" },
        },
      });

      if (!sessionOk) {
        return res.status(500).json({
          success: false,
          message: "Session middleware is not configured on the server.",
          code: "SESSION_NOT_CONFIGURED",
        });
      }

      return res.json({
        success: true,
        message: "Login successful.",
        data: {
          id: user.id,
          fullName: user.full_name,
          email: user.email,
          role: "teacher",
          teacherId,
          status: "approved",
        },
      });
    }

    // Non-teacher login
    const sessionOk = await setLoginSession(req, {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      role: safeRole(user.role),
    });

    if (!sessionOk) {
      return res.status(500).json({
        success: false,
        message: "Session middleware is not configured on the server.",
        code: "SESSION_NOT_CONFIGURED",
      });
    }

    return res.json({
      success: true,
      message: "Login successful.",
      data: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: safeRole(user.role),
      },
    });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

/* ============================================================================
 * POST /auth/logout
 * ========================================================================= */
export const logout = async (req, res) => {
  try {
    if (!req.session) {
      return res.json({ success: true, message: "Logged out." });
    }

    await sessionDestroy(req);

    // Use centralized cookie configuration
    res.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);

    return res.json({ success: true, message: "Logged out." });
  } catch (err) {
    console.error("logout error:", err);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ============================================================================
// PASSWORD RESET FLOW
// ============================================================================

/* ============================================================================
 * POST /auth/request-reset
 * ✅ FIXED: Clean up old OTPs for same email before generating new one
 * ========================================================================= */
export const requestPasswordReset = async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ success: false, message: "Email is required." });

  const cleanEmail = normalizeEmail(email);

  try {
    const fallbackOtpId = crypto.randomUUID();
    const [rows] = await pool.query(`SELECT id, full_name FROM users WHERE email = ? LIMIT 1`, [
      cleanEmail,
    ]);

    let issuedOtpId = fallbackOtpId;
    if (rows.length) {
      const user = rows[0];
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      issuedOtpId = crypto.randomUUID();
      const otpHash = hashOtpCode(otp);

      // Keep one live reset challenge per email.
      await pool.query(`DELETE FROM password_reset_otps WHERE email = ?`, [cleanEmail]);
      await pool.query(
        `
        INSERT INTO password_reset_otps (otp_id, email, code_hash, user_id, expires_at)
        VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))
        `,
        [issuedOtpId, cleanEmail, otpHash, user.id]
      );

      await sendOtpEmail(cleanEmail, otp, user.full_name);
    }

    // Store reset challenge server-side for this anonymous browser session.
    if (req.session) {
      req.session.passwordResetChallenge = {
        email: cleanEmail,
        otpId: issuedOtpId,
        issuedAt: new Date().toISOString(),
      };
      await sessionSave(req);
    }

    return res.json({
      success: true,
      message: "OTP sent to your email.",
    });
  } catch (err) {
    console.error("requestPasswordReset error:", err);
    return res.status(500).json({ success: false, message: "Could not send OTP." });
  }
};

/* ============================================================================
 * POST /auth/verify-reset
 * ========================================================================= */
export const verifyPasswordReset = async (req, res) => {
  const { email, otp, newPassword, otpId } = req.body || {};
  if (!email || !otp || !newPassword) {
    return res.status(400).json({ 
      success: false, 
      message: "email, otp and newPassword are required." 
    });
  }

  const pwErr = validatePassword(newPassword);
  if (pwErr) return res.status(400).json({ success: false, message: pwErr });

  const cleanEmail = normalizeEmail(email);
  try {
    const sessionChallenge = req.session?.passwordResetChallenge;
    const candidateOtpId =
      typeof otpId === "string" && otpId.trim().length > 0
        ? otpId.trim()
        : typeof sessionChallenge?.otpId === "string"
        ? sessionChallenge.otpId
        : "";

    if (!candidateOtpId) {
      return res.status(400).json({ success: false, message: "OTP not found or expired." });
    }

    const [otpRows] = await pool.query(
      `
      SELECT code_hash, user_id
      FROM password_reset_otps
      WHERE email = ?
        AND otp_id = ?
        AND expires_at > NOW()
      LIMIT 1
      `,
      [cleanEmail, candidateOtpId]
    );

    if (!otpRows.length) {
      return res.status(400).json({ success: false, message: "OTP not found or expired." });
    }

    const storedHash = String(otpRows[0].code_hash || "");
    const incomingHash = hashOtpCode(otp);
    if (!timingSafeEqualStr(storedHash, incomingHash)) {
      return res.status(400).json({ success: false, message: "Invalid OTP." });
    }

    const passwordHash = await hashPassword(newPassword);
    const resetUserId = Number(otpRows[0].user_id);

    await pool.query(
      `
      UPDATE users
      SET password_hash = ?
      WHERE id = ?
      `,
      [passwordHash, resetUserId]
    );

    // Invalidate all reset challenges for this email and trim expired rows.
    await pool.query(`DELETE FROM password_reset_otps WHERE email = ?`, [cleanEmail]);
    await pool.query(`DELETE FROM password_reset_otps WHERE expires_at <= NOW()`);
    if (req.session?.passwordResetChallenge) {
      delete req.session.passwordResetChallenge;
      await sessionSave(req);
    }

    return res.json({
      success: true,
      message: "Password updated successfully."
    });
  } catch (err) {
    console.error("verifyPasswordReset error:", err);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

