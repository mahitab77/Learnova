// src/controllers/parent.controller.js
import pool from "../db.js";
import {
  assertTeacherEligibleForSubjectScope,
  listEligibleTeacherIdsForSubjectScope,
} from "../services/teacherDiscovery.service.js";
import { upsertTeacherSelection } from "../services/teacherSelection.service.js";
export {
  getParentLessonSessionRating,
  upsertParentLessonSessionRating,
} from "./rating.controller.js";

const CHILD_SCOPE_RESOLUTION_ERROR =
  "Child academic scope could not be resolved. Ensure students.system_id and students.stage_id are populated.";

function isEnabledFlag(value) {
  return value === true || Number(value) === 1;
}

function getPagination(req, { defaultLimit = 50, maxLimit = 200 } = {}) {
  const requestedLimit = Number.parseInt(String(req.query?.limit ?? ""), 10);
  const requestedOffset = Number.parseInt(String(req.query?.offset ?? ""), 10);
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, maxLimit)
      : defaultLimit;
  const offset =
    Number.isFinite(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
  return { limit, offset };
}

/* =============================================================================
 * Helper functions
 * =============================================================================
 */

/**
 * Find a parent profile row by the underlying users.id
 * @param {number} userId - ID from `users` table
 * @returns {Promise<object|null>}
 */
async function findParentByUserId(userId) {
  const [rows] = await pool.query(
    "SELECT id, user_id, phone, notes FROM parents WHERE user_id = ? LIMIT 1",
    [userId]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Find a student row by its id
 * @param {number} studentId - ID from `students` table
 * @returns {Promise<object|null>}
 */
async function findStudentById(studentId) {
  const [rows] = await pool.query(
    `
    SELECT
      id,
      user_id,
      system_id,
      stage_id,
      grade_level_id
    FROM students
    WHERE id = ?
    LIMIT 1
    `,
    [studentId]
  );
  return rows.length ? rows[0] : null;
}

async function findActiveTeacherSelectionForStudentSubject(studentId, subjectId) {
  const [rows] = await pool.query(
    `
    SELECT id, teacher_id
    FROM student_teacher_selections
    WHERE student_id = ?
      AND subject_id = ?
      AND status = 'active'
    LIMIT 1
    `,
    [studentId, subjectId]
  );

  return rows.length ? rows[0] : null;
}

async function findActiveTeacherSelectionById(selectionId, studentId, subjectId) {
  const [rows] = await pool.query(
    `
    SELECT id, teacher_id
    FROM student_teacher_selections
    WHERE id = ?
      AND student_id = ?
      AND subject_id = ?
      AND status = 'active'
    LIMIT 1
    `,
    [selectionId, studentId, subjectId]
  );

  return rows.length ? rows[0] : null;
}

async function studentHasSelectedSubject(studentId, subjectId) {
  const [rows] = await pool.query(
    `
    SELECT id
    FROM student_subjects
    WHERE student_id = ? AND subject_id = ?
    LIMIT 1
    `,
    [studentId, subjectId]
  );

  return rows.length > 0;
}

/**
 * Shared live-offering eligibility guard.
 *
 * Resolves the child's academic scope and confirms that the given teacher has
 * at least one live slot offering for that (subject, scope) combination.
 * This is the single source of truth used by both write paths
 * (selectParentTeacherOption, createParentRequest) and must stay aligned with
 * the read path (getParentTeacherOptions).
 *
 * @param {number} teacherId
 * @param {object} student  - row from `students` with normalized scope fields
 * @param {number} subjectId
 * @returns {Promise<{ ok: true } | { ok: false, status: number, message: string }>}
 */
async function assertTeacherEligibleForChild(teacherId, student, subjectId) {
  return assertTeacherEligibleForSubjectScope(
    teacherId,
    student,
    subjectId,
    {
      executor: pool,
      actorType: "child",
      messages: {
        scopeResolution: CHILD_SCOPE_RESOLUTION_ERROR,
      },
    }
  );
}

async function listEligibleTeacherIdsForChild(student, subjectId) {
  return listEligibleTeacherIdsForSubjectScope(student, subjectId, {
    executor: pool,
    actorType: "child",
    messages: {
      scopeResolution: CHILD_SCOPE_RESOLUTION_ERROR,
    },
  });
}

async function loadParentTeacherFlowContext({
  authedUserId,
  studentId,
  subjectId,
}) {
  const parent = await findParentByUserId(authedUserId);
  if (!parent) {
    return {
      ok: false,
      status: 403,
      message: "Parent profile not found for this user.",
    };
  }

  const [linkRows] = await pool.query(
    `
    SELECT id
    FROM parent_students
    WHERE parent_id = ? AND student_id = ?
    LIMIT 1
    `,
    [parent.id, studentId]
  );

  if (linkRows.length === 0) {
    return {
      ok: false,
      status: 403,
      message: "This student is not linked to the current parent user.",
    };
  }

  const student = await findStudentById(studentId);
  if (!student) {
    return {
      ok: false,
      status: 404,
      message: "Student not found.",
    };
  }

  const hasSelectedSubject = await studentHasSelectedSubject(studentId, subjectId);
  if (!hasSelectedSubject) {
    return {
      ok: false,
      status: 400,
      message:
        "This subject is not selected for the student. Please add the subject first.",
    };
  }

  const currentSelection = await findActiveTeacherSelectionForStudentSubject(
    studentId,
    subjectId
  );

  return {
    ok: true,
    parent,
    student,
    currentSelection,
  };
}

async function prepareParentTeacherChangeRequest({
  authedUserId,
  studentId,
  subjectId,
  currentTeacherId = null,
  requestedTeacherId = null,
  selectionId = null,
}) {
  const flowContext = await loadParentTeacherFlowContext({
    authedUserId,
    studentId,
    subjectId,
  });

  if (!flowContext.ok) {
    return flowContext;
  }

  const { parent, student, currentSelection } = flowContext;

  if (selectionId != null) {
    const selectionRow = await findActiveTeacherSelectionById(
      selectionId,
      studentId,
      subjectId
    );

    if (!selectionRow) {
      return {
        ok: false,
        status: 400,
        message:
          "The provided selection_id does not belong to this student's active teacher selection for the subject.",
      };
    }

    if (
      currentSelection?.id &&
      Number(currentSelection.id) !== Number(selectionRow.id)
    ) {
      return {
        ok: false,
        status: 409,
        message:
          "The current teacher selection changed before this request was submitted. Please refresh and try again.",
      };
    }
  }

  if (!currentSelection?.teacher_id) {
    return {
      ok: false,
      status: 400,
      message:
        "No current teacher exists for this subject. Please use the direct teacher selection flow instead.",
    };
  }

  const actualCurrentTeacherId = Number(currentSelection.teacher_id);

  if (
    currentTeacherId != null &&
    Number(currentTeacherId) !== actualCurrentTeacherId
  ) {
    return {
      ok: false,
      status: 409,
      message:
        "The current teacher changed before this request was submitted. Please refresh and try again.",
    };
  }

  if (requestedTeacherId == null) {
    return {
      ok: false,
      status: 400,
      message:
        "A requested replacement teacher is required when a current teacher already exists.",
    };
  }

  if (requestedTeacherId === actualCurrentTeacherId) {
    return {
      ok: false,
      status: 400,
      message: "Requested teacher must be different from the current teacher.",
    };
  }

  const eligibility = await assertTeacherEligibleForChild(
    requestedTeacherId,
    student,
    subjectId
  );

  if (!eligibility.ok) {
    return eligibility;
  }

  return {
    ok: true,
    parent,
    currentTeacherId: actualCurrentTeacherId,
    requestedTeacherId,
  };
}

async function insertParentTeacherChangeRequest({
  parentId,
  studentId,
  subjectId,
  currentTeacherId,
  requestedTeacherId,
  reason,
}) {
  const [insert] = await pool.query(
    `
    INSERT INTO parent_change_requests
      (parent_id, student_id, subject_id, current_teacher_id, requested_teacher_id, reason_text, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `,
    [
      parentId,
      studentId,
      subjectId,
      currentTeacherId,
      requestedTeacherId,
      reason,
    ]
  );

  return insert.insertId;
}

/**
 * Ensure current user is authenticated and has parent/admin role.
 * Returns { user, errorResponse } - if errorResponse is non-null, caller must return it.
 */
function requireParentOrAdmin(req, res) {
  const user = req.user;

  if (!user || !user.id) {
    return {
      user: null,
      errorResponse: res.status(401).json({
        success: false,
        message: "Not authenticated. Please log in again.",
      }),
    };
  }

  if (user.role !== "parent" && user.role !== "admin") {
    return {
      user: null,
      errorResponse: res.status(403).json({
        success: false,
        message:
          "Only parent or admin users are allowed to perform this action.",
      }),
    };
  }

  return { user, errorResponse: null };
}
function requireParent(req, res) {
  const user = req.user;

  if (!user || !user.id) {
    return {
      user: null,
      errorResponse: res.status(401).json({
        success: false,
        message: "Not authenticated. Please log in again.",
      }),
    };
  }

  if (user.role !== "parent") {
    return {
      user: null,
      errorResponse: res.status(403).json({
        success: false,
        message: "Only parent users are allowed to perform this action.",
      }),
    };
  }

  return { user, errorResponse: null };
}

export const getMyStudents = async (req, res) => {
  const user = req.user;

  try {
    const { user: authedUser, errorResponse } = requireParentOrAdmin(req, res);
    if (!authedUser) return errorResponse;

    console.log("getMyStudents called", {
      authedUserId: authedUser.id,
      authedUserRole: authedUser.role,
    });

    // 1) Find parent profile for this user
    const parent = await findParentByUserId(authedUser.id);

    console.log("Resolved parent profile", {
      parentUserId: authedUser.id,
      parentRow: parent,
    });

    if (!parent) {
      return res.json({
        success: true,
        data: [],
        message: "No parent profile or linked students found for this user.",
      });
    }

    // 2) Load linked students with the EXACT aliases your TS expects
    const [rows] = await pool.query(
      `
      SELECT
        ps.id AS link_id,
        s.id AS student_id,
        u.full_name AS student_name,
        s.system_id,
        s.stage_id,
        s.grade_level_id,
        es.name         AS system_name,
        gs.name_en      AS stage_name,
        gl.name_en      AS grade_level_name,
        s.grade_stage,
        s.grade_number,
        ps.relationship,
        CASE WHEN ps.has_own_login = 1 THEN 1 ELSE 0 END AS has_own_login,
        s.user_id AS student_user_id
      FROM parent_students ps
      INNER JOIN students s ON s.id = ps.student_id
      INNER JOIN users u ON u.id = s.user_id
      LEFT JOIN educational_systems es ON es.id = s.system_id
      LEFT JOIN grade_stages gs ON gs.id = s.stage_id
      LEFT JOIN grade_levels gl ON gl.id = s.grade_level_id
      WHERE ps.parent_id = ?
      ORDER BY student_name
      `,
      [parent.id]
    );

    console.log("getMyStudents result", {
      parentId: parent.id,
      rows,
    });

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getMyStudents error:", {
      error: err,
      userId: user?.id,
    });

    return res.status(500).json({
      success: false,
      message:
        "Could not load students for this parent. Please try again later.",
    });
  }
};


/* =============================================================================
 * POST /parent/ensure-profile  -> ensureParentProfile
 * -----------------------------------------------------------------------------
 * DEV / utility endpoint:
 *  - Make sure the logged-in parent actually has a row in `parents`.
 *  - If it exists, returns it.
 *  - If not, creates it with optional phone / notes.
 * =============================================================================
 */
export const ensureParentProfile = async (req, res) => {
  const user = req.user;
  const { phone, notes } = req.body || {};

  try {
    const { user: authedUser, errorResponse } = requireParentOrAdmin(req, res);
    if (!authedUser) return errorResponse;

    const existing = await findParentByUserId(authedUser.id);
    if (existing) {
      return res.json({
        success: true,
        message: "Parent profile already exists.",
        data: existing,
      });
    }

    const [result] = await pool.query(
      "INSERT INTO parents (user_id, phone, notes) VALUES (?, ?, ?)",
      [authedUser.id, phone || null, notes || null]
    );

    return res.status(201).json({
      success: true,
      message: "Parent profile created successfully.",
      data: {
        id: result.insertId,
        user_id: authedUser.id,
        phone: phone || null,
        notes: notes || null,
      },
    });
  } catch (err) {
    console.error("ensureParentProfile error:", {
      error: err,
      userId: user?.id,
    });
    return res.status(500).json({
      success: false,
      message: "Could not ensure parent profile. Please try again later.",
    });
  }
};

/* =============================================================================
 * GET /parent/student/:studentId/selections  -> getStudentSelectionsAsParent
 * -----------------------------------------------------------------------------
 *  - Returns subjects chosen for this student (student_subjects + subjects).
 *  - If a teacher has been selected (student_teacher_selections),
 *    includes teacher_id, teacher_name.
 * =============================================================================
 */
export const getStudentSelectionsAsParent = async (req, res) => {
  const user = req.user;
  const { studentId } = req.params;

  try {
    const { user: authedUser, errorResponse } = requireParentOrAdmin(req, res);
    if (!authedUser) return errorResponse;

    if (!studentId) {
      return res.status(400).json({
        success: false,
        message: "studentId parameter is required.",
      });
    }

    const numericStudentId = Number(studentId);
    if (Number.isNaN(numericStudentId) || numericStudentId <= 0) {
      return res.status(400).json({
        success: false,
        message: "studentId parameter must be a valid positive number.",
      });
    }

    // 1) Ensure this user has a parent profile
    const parent = await findParentByUserId(authedUser.id);
    if (!parent) {
      return res.status(403).json({
        success: false,
        message: "Parent profile not found for this user.",
      });
    }

    // 2) Ensure this student is linked to this parent
    const [linkRows] = await pool.query(
      `
      SELECT id
      FROM parent_students
      WHERE parent_id = ? AND student_id = ?
      LIMIT 1
      `,
      [parent.id, numericStudentId]
    );
    if (linkRows.length === 0) {
      return res.status(403).json({
        success: false,
        message: "This student is not linked to the current parent user.",
      });
    }

    // 3) Load subject selections + (optional) chosen teacher
    const [rows] = await pool.query(
      `
      SELECT
        COALESCE(sts.id, ss.id) AS id,
        ss.subject_id,
        subj.name_ar     AS subject_name_ar,
        subj.name_en     AS subject_name_en,
        sts.teacher_id   AS teacher_id,
        COALESCE(t.name, '') AS teacher_name,
        NULL AS photo_url
      FROM student_subjects ss
      INNER JOIN subjects subj ON subj.id = ss.subject_id
      LEFT JOIN student_teacher_selections sts
        ON sts.student_id = ss.student_id
       AND sts.subject_id = ss.subject_id
      LEFT JOIN teachers t ON t.id = sts.teacher_id
      WHERE ss.student_id = ?
      ORDER BY subj.name_en, subj.id
      `,
      [numericStudentId]
    );

    return res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    console.error("getStudentSelectionsAsParent error:", {
      error: err,
      userId: user?.id,
      studentId,
    });
    return res.status(500).json({
      success: false,
      message:
        "Could not load subject selections for this student. Please try again later.",
    });
  }
};

export const getParentStudentsSelections = async (req, res) => {
  const user = req.user;

  try {
    const { user: authedUser, errorResponse } = requireParentOrAdmin(req, res);
    if (!authedUser) return errorResponse;

    const parent = await findParentByUserId(authedUser.id);
    if (!parent) {
      return res.json({ success: true, data: {} });
    }

    const rawStudentIds = String(req.query?.student_ids ?? "")
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((id) => Number.isFinite(id) && id > 0);

    const uniqueStudentIds = [...new Set(rawStudentIds)];
    if (!uniqueStudentIds.length) {
      return res.status(400).json({
        success: false,
        message: "student_ids query parameter is required.",
      });
    }

    const [linkedRows] = await pool.query(
      `
      SELECT student_id
      FROM parent_students
      WHERE parent_id = ?
        AND student_id IN (?)
      `,
      [parent.id, uniqueStudentIds]
    );

    const linkedIds = [...new Set(linkedRows.map((row) => Number(row.student_id)).filter(Boolean))];
    if (!linkedIds.length) {
      return res.json({ success: true, data: {} });
    }

    const [rows] = await pool.query(
      `
      SELECT
        ss.student_id,
        COALESCE(sts.id, ss.id) AS id,
        ss.subject_id,
        subj.name_ar AS subject_name_ar,
        subj.name_en AS subject_name_en,
        sts.teacher_id AS teacher_id,
        COALESCE(t.name, '') AS teacher_name,
        NULL AS photo_url
      FROM student_subjects ss
      INNER JOIN subjects subj ON subj.id = ss.subject_id
      LEFT JOIN student_teacher_selections sts
        ON sts.student_id = ss.student_id
       AND sts.subject_id = ss.subject_id
      LEFT JOIN teachers t ON t.id = sts.teacher_id
      WHERE ss.student_id IN (?)
      ORDER BY ss.student_id, subj.name_en, subj.id
      `,
      [linkedIds]
    );

    const grouped = {};
    for (const row of rows) {
      const sid = Number(row.student_id);
      if (!grouped[sid]) grouped[sid] = [];
      grouped[sid].push({
        id: row.id,
        subject_id: row.subject_id,
        subject_name_ar: row.subject_name_ar,
        subject_name_en: row.subject_name_en,
        teacher_id: row.teacher_id,
        teacher_name: row.teacher_name,
        photo_url: row.photo_url,
      });
    }

    return res.json({ success: true, data: grouped });
  } catch (err) {
    console.error("getParentStudentsSelections error:", {
      error: err,
      userId: user?.id,
    });
    return res.status(500).json({
      success: false,
      message: "Could not load student selections. Please try again later.",
    });
  }
};

/* =============================================================================
 * NEW: POST /parent/requests  -> createParentRequest
 * -----------------------------------------------------------------------------
 * Used by the new Parent Dashboard UI (session-cookie auth).
 *
 * Accepts BOTH snake_case and camelCase:
 *  - student_id / studentId              (required)
 *  - subject_id / subjectId              (required)
 *  - teacher_id / teacherId / currentTeacherId         (optional)  -> CURRENT teacher
 *  - requested_teacher_id / requestedTeacherId / newTeacherId      (optional)  -> REQUESTED teacher
 *  - selection_id / selectionId          (optional)  -> student_teacher_selections.id (if provided)
 *  - type / requestType                  (optional)  -> e.g. "change_teacher"
 *  - reason / reason_text                (optional)
 *
 * Writes to:
 *   parent_change_requests(parent_id, student_id, subject_id,
 *     current_teacher_id, requested_teacher_id, reason_text, status)
 * Status always starts as 'pending'.
 * =============================================================================
 */
export const createParentRequest = async (req, res) => {
  const user = req.user;
  const body = req.body || {};

  // ---------------------------------------------------------------------------
  // 1) Auth guard (session-only)
  // ---------------------------------------------------------------------------
  try {
    const { user: authedUser, errorResponse } = requireParentOrAdmin(req, res);
    if (!authedUser) return errorResponse;

    // -------------------------------------------------------------------------
    // 2) Parse inputs (accept snake_case + camelCase aliases)
    // -------------------------------------------------------------------------
    const studentIdRaw = body.student_id ?? body.studentId;
    const subjectIdRaw = body.subject_id ?? body.subjectId;

    // CURRENT teacher (what they have now)
    const currentTeacherIdRaw =
      body.teacher_id ?? body.teacherId ?? body.currentTeacherId ?? null;

    // REQUESTED teacher (what they want next)  OK new column support
    const requestedTeacherIdRaw =
      body.requested_teacher_id ?? body.requestedTeacherId ?? body.newTeacherId ?? null;

    // Optional selection row id (only valid if it is from student_teacher_selections)
    const selectionIdRaw = body.selection_id ?? body.selectionId ?? null;

    const requestTypeRaw = body.type ?? body.requestType ?? null;
    const reasonRaw = body.reason ?? body.reason_text ?? null;

    // -------------------------------------------------------------------------
    // 3) Validate required ids
    // -------------------------------------------------------------------------
    if (studentIdRaw == null || subjectIdRaw == null) {
      return res.status(400).json({
        success: false,
        message: "student_id and subject_id are required to create a request.",
      });
    }

    const numericStudentId = Number(studentIdRaw);
    const numericSubjectId = Number(subjectIdRaw);

    if (
      !Number.isFinite(numericStudentId) ||
      numericStudentId <= 0 ||
      !Number.isFinite(numericSubjectId) ||
      numericSubjectId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "student_id and subject_id must be valid positive numbers.",
      });
    }

    // current teacher (optional)
    const numericCurrentTeacherId =
      currentTeacherIdRaw != null ? Number(currentTeacherIdRaw) : null;

    if (
      numericCurrentTeacherId != null &&
      (!Number.isFinite(numericCurrentTeacherId) || numericCurrentTeacherId <= 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "teacher_id (current teacher) must be a valid positive number when provided.",
      });
    }

    // requested teacher (optional) OK new
    const numericRequestedTeacherId =
      requestedTeacherIdRaw != null ? Number(requestedTeacherIdRaw) : null;

    if (
      numericRequestedTeacherId != null &&
      (!Number.isFinite(numericRequestedTeacherId) || numericRequestedTeacherId <= 0)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "requested_teacher_id must be a valid positive number when provided.",
      });
    }

    // Prevent nonsense: requesting the same teacher they already have
    if (
      numericCurrentTeacherId != null &&
      numericRequestedTeacherId != null &&
      numericCurrentTeacherId === numericRequestedTeacherId
    ) {
      return res.status(400).json({
        success: false,
        message: "Requested teacher must be different from the current teacher.",
      });
    }

    // Clean reason text
    const reason =
      typeof reasonRaw === "string" ? reasonRaw.trim().slice(0, 1000) : null;

    // Normalize request type
    const requestType =
      typeof requestTypeRaw === "string" ? requestTypeRaw.trim().slice(0, 50) : null;

    // 6) Optional: validate selection_id belongs to this student (if provided)
    // IMPORTANT: selection_id must be from student_teacher_selections (NOT student_subjects)
    // -------------------------------------------------------------------------
    let numericSelectionId = null;
    if (selectionIdRaw != null) {
      numericSelectionId = Number(selectionIdRaw);
      if (Number.isFinite(numericSelectionId) && numericSelectionId > 0) {
        // validated later against the student + subject + active selection state
      } else {
        return res.status(400).json({
          success: false,
          message: "selection_id must be a valid positive number when provided.",
        });
      }
    }

    const preparedRequest = await prepareParentTeacherChangeRequest({
      authedUserId: authedUser.id,
      studentId: numericStudentId,
      subjectId: numericSubjectId,
      currentTeacherId: numericCurrentTeacherId,
      requestedTeacherId: numericRequestedTeacherId,
      selectionId: numericSelectionId,
    });

    if (!preparedRequest.ok) {
      return res.status(preparedRequest.status).json({
        success: false,
        message: preparedRequest.message,
      });
    }

    // -------------------------------------------------------------------------
    // 8) Insert the request (NOW includes requested_teacher_id OK)
    // -------------------------------------------------------------------------
    const requestId = await insertParentTeacherChangeRequest({
      parentId: preparedRequest.parent.id,
      studentId: numericStudentId,
      subjectId: numericSubjectId,
      currentTeacherId: preparedRequest.currentTeacherId,
      requestedTeacherId: preparedRequest.requestedTeacherId,
      reason: reason || null,
    });

    return res.status(201).json({
      success: true,
      message: "Request submitted successfully.",
      data: {
        requestId,
        type: requestType,
      },
    });
  } catch (err) {
    console.error("createParentRequest error:", {
      error: err,
      userId: user?.id,
      body: req.body,
    });
    return res.status(500).json({
      success: false,
      message: "Could not submit the request. Please try again later.",
    });
  }
};

/* =============================================================================
 * (LEGACY) POST /parent/request-change  -> createChangeRequest
 * -----------------------------------------------------------------------------
 * Backwards compatible endpoint.
 * Body: { studentId, subjectId, currentTeacherId?, reason?, requestedTeacherId? }
 *
 * OK Updated to also support requested_teacher_id and write it to DB.
 * =============================================================================
 */
export const createChangeRequest = async (req, res) => {
  const user = req.user;
  const body = req.body || {};

  // Accept both legacy + new keys:
  const studentIdRaw = body.studentId ?? body.student_id ?? null;
  const subjectIdRaw = body.subjectId ?? body.subject_id ?? null;

  // "currentTeacherId" in legacy payload
  const currentTeacherIdRaw =
    body.currentTeacherId ?? body.teacherId ?? body.teacher_id ?? null;

  // NEW: requested teacher (optional)
  const requestedTeacherIdRaw =
    body.requestedTeacherId ?? body.requested_teacher_id ?? body.newTeacherId ?? null;

  const reasonRaw = body.reason ?? body.reason_text ?? null;

  try {
    const { user: authedUser, errorResponse } = requireParentOrAdmin(req, res);
    if (!authedUser) return errorResponse;

    if (studentIdRaw == null || subjectIdRaw == null) {
      return res.status(400).json({
        success: false,
        message: "studentId and subjectId are required.",
      });
    }

    const numericStudentId = Number(studentIdRaw);
    const numericSubjectId = Number(subjectIdRaw);

    if (
      !Number.isFinite(numericStudentId) ||
      numericStudentId <= 0 ||
      !Number.isFinite(numericSubjectId) ||
      numericSubjectId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "studentId and subjectId must be valid positive numbers.",
      });
    }

    const numericCurrentTeacherId =
      currentTeacherIdRaw != null ? Number(currentTeacherIdRaw) : null;

    if (
      numericCurrentTeacherId != null &&
      (!Number.isFinite(numericCurrentTeacherId) || numericCurrentTeacherId <= 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "currentTeacherId must be a valid positive number when provided.",
      });
    }

    const numericRequestedTeacherId =
      requestedTeacherIdRaw != null ? Number(requestedTeacherIdRaw) : null;

    if (
      numericRequestedTeacherId != null &&
      (!Number.isFinite(numericRequestedTeacherId) || numericRequestedTeacherId <= 0)
    ) {
      return res.status(400).json({
        success: false,
        message: "requestedTeacherId must be a valid positive number when provided.",
      });
    }

    if (
      numericCurrentTeacherId != null &&
      numericRequestedTeacherId != null &&
      numericCurrentTeacherId === numericRequestedTeacherId
    ) {
      return res.status(400).json({
        success: false,
        message: "Requested teacher must be different from the current teacher.",
      });
    }

    const preparedRequest = await prepareParentTeacherChangeRequest({
      authedUserId: authedUser.id,
      studentId: numericStudentId,
      subjectId: numericSubjectId,
      currentTeacherId: numericCurrentTeacherId,
      requestedTeacherId: numericRequestedTeacherId,
    });

    if (!preparedRequest.ok) {
      return res.status(preparedRequest.status).json({
        success: false,
        message: preparedRequest.message,
      });
    }

    const reason =
      typeof reasonRaw === "string" ? reasonRaw.trim().slice(0, 1000) : null;

    const requestId = await insertParentTeacherChangeRequest({
      parentId: preparedRequest.parent.id,
      studentId: numericStudentId,
      subjectId: numericSubjectId,
      currentTeacherId: preparedRequest.currentTeacherId,
      requestedTeacherId: preparedRequest.requestedTeacherId,
      reason: reason || null,
    });

    return res.status(201).json({
      success: true,
      message: "Change request submitted successfully.",
      data: {
        requestId,
      },
    });
  } catch (err) {
    console.error("createChangeRequest error:", {
      error: err,
      userId: user?.id,
      body,
    });
    return res.status(500).json({
      success: false,
      message: "Could not submit the change request. Please try again later.",
    });
  }
};

/* =============================================================================
 * NEW: GET /parent/requests  -> getParentRequests
 * -----------------------------------------------------------------------------
 * Returns all change-requests created by the logged-in parent (session auth).
 *
 * OK Session-cookie auth (no x-user-id)
 * OK Includes BOTH current + requested teacher names (new column support)
 * OK Safe when parent profile doesn't exist (returns empty list)
 * OK Clean aliases that match your frontend naming convention
 * =============================================================================
 */
export const getParentRequests = async (req, res) => {
  const user = req.user;

  try {
    // -------------------------------------------------------------------------
    // 1) Auth guard: must be parent or admin (session-based)
    // -------------------------------------------------------------------------
    const { user: authedUser, errorResponse } = requireParentOrAdmin(req, res);
    if (!authedUser) return errorResponse;

    // -------------------------------------------------------------------------
    // 2) Resolve parent profile
    // -------------------------------------------------------------------------
    const parent = await findParentByUserId(authedUser.id);
    if (!parent) {
      // Not an error: parent simply has no profile yet
      return res.json({
        success: true,
        data: [],
        message: "No parent profile or requests found for this user.",
      });
    }

    // -------------------------------------------------------------------------
    // 3) Load parent requests
    //
    // We now join teachers twice:
    //  - ct = current teacher at the time of request
    //  - rt = requested new teacher (newly added column)
    //
    // We return both names so UI can show:
    //   Current: X  -> Requested: Y
    // -------------------------------------------------------------------------
    const { limit, offset } = getPagination(req, { defaultLimit: 50, maxLimit: 200 });
    const [rows] = await pool.query(
      `
      SELECT
        r.id,
        r.student_id,
        COALESCE(su.full_name, CONCAT('Student #', s.id)) AS student_name,

        r.subject_id,
        subj.name_ar AS subject_name_ar,
        subj.name_en AS subject_name_en,

        r.current_teacher_id,
        ct.name AS current_teacher_name,

        r.requested_teacher_id,
        rt.name AS requested_teacher_name,

        r.status,
        r.reason_text AS reason,
        r.created_at
      FROM parent_change_requests r
      INNER JOIN students s ON s.id = r.student_id
      LEFT JOIN users su ON su.id = s.user_id
      LEFT JOIN subjects subj ON subj.id = r.subject_id

      LEFT JOIN teachers ct ON ct.id = r.current_teacher_id
      LEFT JOIN teachers rt ON rt.id = r.requested_teacher_id

      WHERE r.parent_id = ?
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT ?
      OFFSET ?
      `,
      [parent.id, limit, offset]
    );

    // -------------------------------------------------------------------------
    // 4) Return payload (envelope consistent with your other endpoints)
    // -------------------------------------------------------------------------
    return res.json({
      success: true,
      data: rows,
      pagination: { limit, offset },
    });
  } catch (err) {
    console.error("getParentRequests error:", {
      error: err,
      userId: user?.id,
    });

    return res.status(500).json({
      success: false,
      message: "Could not load parent requests. Please try again later.",
    });
  }
};


/* =============================================================================
 * NEW: GET /parent/assignments  -> getParentAssignments
 * -----------------------------------------------------------------------------
 * Returns homework & quiz scores for all children of this parent.
 * Merges homework_submissions + quiz_submissions.
 * =============================================================================
 */
export const getParentAssignments = async (req, res) => {
  const user = req.user;

  try {
    const { user: authedUser, errorResponse } = requireParentOrAdmin(req, res);
    if (!authedUser) return errorResponse;

    const parent = await findParentByUserId(authedUser.id);
    if (!parent) {
      return res.json({
        success: true,
        data: [],
        message: "No parent profile or linked students found for this user.",
      });
    }

    const { limit, offset } = getPagination(req, { defaultLimit: 50, maxLimit: 200 });
    // 1) Get child student_ids for this parent
    const [links] = await pool.query(
      `
      SELECT student_id
      FROM parent_students
      WHERE parent_id = ?
      `,
      [parent.id]
    );

    if (!links.length) {
      return res.json({
        success: true,
        data: [],
        message: "No linked students found for this parent.",
      });
    }

    const studentIds = links.map((r) => r.student_id);

    // 2) HOMEWORKS
    const [homeworkRows] = await pool.query(
      `
      SELECT
        hs.id AS id,
        hs.student_id,
        COALESCE(su.full_name, CONCAT('Student #', st.id)) AS student_name,
        subj.name_ar AS subject_name_ar,
        subj.name_en AS subject_name_en,
        'homework' AS type,
        ha.title,
        hs.score,
        ha.max_score,
        hs.submitted_at,
        ha.due_at AS due_at
      FROM homework_submissions hs
      INNER JOIN homework_assignments ha ON ha.id = hs.homework_id
      INNER JOIN students st ON st.id = hs.student_id
      LEFT JOIN users su ON su.id = st.user_id
      LEFT JOIN subjects subj ON subj.id = ha.subject_id
      WHERE hs.student_id IN (?)
      `,
      [studentIds]
    );

    // 3) QUIZZES  (uses available_until as "due_at")
    const [quizRows] = await pool.query(
      `
      SELECT
        qs.id AS id,
        qs.student_id,
        COALESCE(su.full_name, CONCAT('Student #', st.id)) AS student_name,
        subj.name_ar AS subject_name_ar,
        subj.name_en AS subject_name_en,
        'quiz' AS type,
        qa.title,
        qs.score,
        qa.max_score,
        qs.submitted_at,
        qa.available_until AS due_at
      FROM quiz_submissions qs
      INNER JOIN quiz_assignments qa ON qa.id = qs.quiz_id
      INNER JOIN students st ON st.id = qs.student_id
      LEFT JOIN users su ON su.id = st.user_id
      LEFT JOIN subjects subj ON subj.id = qa.subject_id
      WHERE qs.student_id IN (?)
      `,
      [studentIds]
    );

    // 4) Merge + sort by due_at/submitted_at DESC (latest first)
    const all = [...homeworkRows, ...quizRows].sort((a, b) => {
      const aTs = new Date(
        a.due_at || a.submitted_at || "1970-01-01"
      ).getTime();
      const bTs = new Date(
        b.due_at || b.submitted_at || "1970-01-01"
      ).getTime();
      return bTs - aTs;
    });

    const paged = all.slice(offset, offset + limit);
    return res.json({
      success: true,
      data: paged,
      pagination: { limit, offset, total: all.length },
    });
  } catch (err) {
    console.error("getParentAssignments error:", {
      error: err,
      userId: user?.id,
    });
    return res.status(500).json({
      success: false,
      message:
        "Could not load assignments and scores. Please try again later.",
    });
  }
};

/* =============================================================================
 * NEW: GET /parent/teacher-options  -> getParentTeacherOptions
 * -----------------------------------------------------------------------------
 * For "Choose teacher" flow.
 * Query params: ?student_id=...&subject_id=...
 * =============================================================================
 */
export const getParentTeacherOptions = async (req, res) => {
  const user = req.user;
  const { student_id, subject_id } = req.query || {};

  try {
    const { user: authedUser, errorResponse } = requireParentOrAdmin(req, res);
    if (!authedUser) return errorResponse;

    if (student_id == null || subject_id == null) {
      return res.status(400).json({
        success: false,
        message: "student_id and subject_id are required.",
      });
    }

    const numericStudentId = Number(student_id);
    const numericSubjectId = Number(subject_id);

    if (
      Number.isNaN(numericStudentId) ||
      numericStudentId <= 0 ||
      Number.isNaN(numericSubjectId) ||
      numericSubjectId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "student_id and subject_id must be valid positive numbers.",
      });
    }

    const parent = await findParentByUserId(authedUser.id);
    if (!parent) {
      return res.status(403).json({
        success: false,
        message: "Parent profile not found for this user.",
      });
    }

    // Ensure this student is linked to this parent
    const [linkRows] = await pool.query(
      `
      SELECT id
      FROM parent_students
      WHERE parent_id = ? AND student_id = ?
      LIMIT 1
      `,
      [parent.id, numericStudentId]
    );
    if (linkRows.length === 0) {
      return res.status(403).json({
        success: false,
        message: "This student is not linked to the current parent user.",
      });
    }

    // Ensure student exists so we can resolve the child's academic scope
    const student = await findStudentById(numericStudentId);
    if (!student) {
      return res.status(404).json({
        success: false,
        message: "Student not found.",
      });
    }

    const eligibleTeachers = await listEligibleTeacherIdsForChild(
      student,
      numericSubjectId
    );
    if (!eligibleTeachers.ok) {
      return res.status(eligibleTeachers.status).json({
        success: false,
        message: eligibleTeachers.message,
      });
    }

    const { teacherIds: eligibleTeacherIds } = eligibleTeachers;
    const currentSelection = await findActiveTeacherSelectionForStudentSubject(
      numericStudentId,
      numericSubjectId
    );
    const currentTeacherId = currentSelection?.teacher_id
      ? Number(currentSelection.teacher_id)
      : null;
    const filteredTeacherIds =
      currentTeacherId != null
        ? eligibleTeacherIds.filter((teacherId) => Number(teacherId) !== currentTeacherId)
        : eligibleTeacherIds;

    if (!filteredTeacherIds.length) {
      return res.json({
        success: true,
        data: [],
      });
    }

    const [rows] = await pool.query(
      `
      SELECT
        t.id AS teacher_id,
        COALESCE(NULLIF(t.name, ''), NULLIF(u.full_name, ''), CONCAT('Teacher #', t.id)) AS teacher_full_name,
        NULLIF(t.bio_short, '') AS bio,
        NULLIF(t.photo_url, '') AS photo_url,
        (
          SELECT tv.video_url
          FROM teacher_videos tv
          WHERE tv.teacher_id = t.id
            AND tv.is_primary = 1
            AND (tv.subject_id IS NULL OR tv.subject_id = ?)
          ORDER BY
            CASE
              WHEN tv.subject_id = ? THEN 0
              WHEN tv.subject_id IS NULL THEN 1
              ELSE 2
            END,
            tv.id ASC
          LIMIT 1
        ) AS demo_video_url,
        NULLIF(t.years_of_experience, '') AS years_experience,
        rating_stats.rating AS rating,
        COALESCE(rating_stats.rating_count, 0) AS rating_count
      FROM teachers t
      INNER JOIN users u ON u.id = t.user_id
      LEFT JOIN (
        SELECT
          teacher_id,
          ROUND(AVG(stars), 1) AS rating,
          COUNT(*) AS rating_count
        FROM teacher_ratings
        WHERE is_hidden = 0
        GROUP BY teacher_id
      ) rating_stats ON rating_stats.teacher_id = t.id
      WHERE t.id IN (?)
        AND t.is_active = 1
        AND t.status = 'approved'
        AND u.is_active = 1
        AND u.role = 'teacher'
      ORDER BY teacher_full_name
      `,
      [
        numericSubjectId,
        numericSubjectId,
        filteredTeacherIds,
      ]
    );

    return res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    console.error("getParentTeacherOptions error:", {
      error: err,
      userId: user?.id,
      query: req.query,
    });
    return res.status(500).json({
      success: false,
      message:
        "Could not load teacher options for this subject. Please try again later.",
    });
  }
};

/* =============================================================================
 * NEW: POST /parent/teacher-options/select  -> selectParentTeacherOption
 * -----------------------------------------------------------------------------
 * Save the chosen teacher for a given (student, subject).
 * Body: { student_id / studentId, subject_id / subjectId, teacher_id / teacherId }
 * =============================================================================
 */
export const selectParentTeacherOption = async (req, res) => {
  const user = req.user;
  const body = req.body || {};

  const studentId = body.student_id ?? body.studentId;
  const subjectId = body.subject_id ?? body.subjectId;
  const teacherId = body.teacher_id ?? body.teacherId;

  try {
    const { user: authedUser, errorResponse } = requireParentOrAdmin(req, res);
    if (!authedUser) return errorResponse;

    if (studentId == null || subjectId == null || teacherId == null) {
      return res.status(400).json({
        success: false,
        message:
          "student_id, subject_id and teacher_id are required to save a selection.",
      });
    }

    const numericStudentId = Number(studentId);
    const numericSubjectId = Number(subjectId);
    const numericTeacherId = Number(teacherId);

    if (
      Number.isNaN(numericStudentId) ||
      numericStudentId <= 0 ||
      Number.isNaN(numericSubjectId) ||
      numericSubjectId <= 0 ||
      Number.isNaN(numericTeacherId) ||
      numericTeacherId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message:
          "student_id, subject_id and teacher_id must be valid positive numbers.",
      });
    }

    const flowContext = await loadParentTeacherFlowContext({
      authedUserId: authedUser.id,
      studentId: numericStudentId,
      subjectId: numericSubjectId,
    });

    if (!flowContext.ok) {
      return res.status(flowContext.status).json({
        success: false,
        message: flowContext.message,
      });
    }

    const { student, currentSelection } = flowContext;

    // Enforce live-offering eligibility - same gate as getParentTeacherOptions.
    // A teacher must have an active live slot for this subject+child academic
    // scope; a bare teacher_subjects row is not sufficient.
    const eligibility = await assertTeacherEligibleForChild(
      numericTeacherId,
      student,
      numericSubjectId
    );
    if (!eligibility.ok) {
      return res.status(eligibility.status).json({
        success: false,
        message: eligibility.message,
      });
    }

    if (
      currentSelection?.teacher_id &&
      Number(currentSelection.teacher_id) !== numericTeacherId
    ) {
      return res.status(400).json({
        success: false,
        message:
          "This subject already has a current teacher. Please use the change-request flow instead of direct selection.",
      });
    }

    const selectionRow = await upsertTeacherSelection(pool, {
      studentId: numericStudentId,
      subjectId: numericSubjectId,
      teacherId: numericTeacherId,
      selectedBy: "parent",
    });

    return res.json({
      success: true,
      message: "Teacher selection saved successfully.",
      data: {
        selectionId: selectionRow.id,
        studentId: numericStudentId,
        subjectId: numericSubjectId,
        teacherId: numericTeacherId,
      },
    });
  } catch (err) {
    console.error("selectParentTeacherOption error:", {
      error: err,
      userId: user?.id,
      body,
    });
    return res.status(500).json({
      success: false,
      message:
        "Could not save the teacher selection. Please try again later.",
    });
  }
};
/* =============================================================================
 *  switchToStudent + switchBackToParent
 * -----------------------------------------------------------------------------
 * OK Works with your session-cookie auth
 * OK Safe session rotation (regenerate) to reduce fixation risk
 * OK Strong validation + clear error codes
 * OK Does NOT override inactive accounts unless profile-only (email IS NULL)
 * OK Stores parent snapshot + switch context for reliable switch-back
 * OK Robust: works even if req.user was attached by global middleware OR auth middleware
 *
 * Requirements (you already have):
 * - Route must be protected by requireSessionUser (session-only) OK recommended
 * - pool imported at top of controller file
 * =============================================================================
 */

// -----------------------------------------------------------------------------
// POST /parent/switch-to-student
// Body: { student_user_id } OR { studentUserId }
// -----------------------------------------------------------------------------
export const switchToStudent = async (req, res) => {
  const body = req.body || {};
  const studentUserIdRaw = body.student_user_id ?? body.studentUserId;

  try {
    // OK Robust: support either req.user (from auth middleware) OR req.session.user (global attach)
    const user = req.user || req.session?.user || null;

    // 0) Auth + role checks
    if (!user?.id) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated. Please log in again.",
        code: "NOT_AUTHENTICATED",
      });
    }
    if (String(user.role).toLowerCase() !== "parent") {
      return res.status(403).json({
        success: false,
        message: "Only parent users are allowed to perform this action.",
        code: "ROLE_FORBIDDEN",
      });
    }

    // 1) Validate input
    const studentUserId = Number(studentUserIdRaw);
    if (!Number.isFinite(studentUserId) || studentUserId <= 0) {
      return res.status(400).json({
        success: false,
        message: "student_user_id must be a valid positive number.",
        code: "INVALID_STUDENT_USER_ID",
      });
    }

    // 2) Ensure session is present
    if (!req.session) {
      return res.status(500).json({
        success: false,
        message: "Session is not configured on the server.",
        code: "SESSION_NOT_CONFIGURED",
      });
    }

    // 3) Prevent stacking switches (safer; avoids confusing nested contexts)
    if (req.session.switch_ctx?.mode === "as_student") {
      return res.status(400).json({
        success: false,
        message: "Already switched to a student session. Switch back first.",
        code: "ALREADY_SWITCHED",
      });
    }

    // 4) Resolve parent profile (parents.user_id -> parents.id)
    const [pRows] = await pool.query(
      "SELECT id FROM parents WHERE user_id = ? LIMIT 1",
      [user.id]
    );

    if (!pRows.length) {
      return res.status(403).json({
        success: false,
        message: "Parent profile not found for this user.",
        code: "PARENT_PROFILE_NOT_FOUND",
      });
    }
    const parentId = pRows[0].id;

    // 5) Verify the student belongs to this parent (via students.user_id)
    const [linkRows] = await pool.query(
      `
      SELECT
        s.id     AS student_id,
        CASE WHEN ps.has_own_login = 1 THEN 1 ELSE 0 END AS has_own_login,
        s.user_id AS student_user_id
      FROM parent_students ps
      INNER JOIN students s ON s.id = ps.student_id
      WHERE ps.parent_id = ?
        AND s.user_id = ?
      LIMIT 1
      `,
      [parentId, studentUserId]
    );

    if (!linkRows.length) {
      return res.status(403).json({
        success: false,
        message: "This student is not linked to the current parent user.",
        code: "STUDENT_NOT_LINKED",
      });
    }

    // 6) Load the student user row (must be role=student)
    const [uRows] = await pool.query(
      "SELECT id, full_name, email, role, is_active FROM users WHERE id = ? LIMIT 1",
      [studentUserId]
    );

    if (!uRows.length || String(uRows[0].role).toLowerCase() !== "student") {
      return res.status(404).json({
        success: false,
        message: "Student user not found.",
        code: "STUDENT_USER_NOT_FOUND",
      });
    }

    const studentUser = uRows[0];

    // 7) Enforce canonical account-state policy:
    //    Inactive child accounts are not switchable and must never be reactivated
    //    implicitly by identity switching.
    if (!studentUser.is_active) {
      return res.status(403).json({
        success: false,
        message:
          "This student account is inactive. Please contact support or switch to a different student.",
        code: "STUDENT_INACTIVE",
      });
    }

    // 8) Rotate session id (prevents session fixation)
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });

    // 9) Save parent snapshot (used later to restore)
    //    Keep it minimal and safe (no secrets).
    req.session.parent_user = {
      id: user.id,
      role: "parent",
      full_name: user.full_name || user.fullName || "",
      email: user.email ?? null,
    };

    // 10) Store switch context for UI + audits
    req.session.switch_ctx = {
      mode: "as_student",
      parent_user_id: user.id,
      student_user_id: studentUserId,
      switched_at: new Date().toISOString(),
    };

    // 11) Switch identity to student
    req.session.user = {
      id: studentUser.id,
      role: "student",
      full_name: studentUser.full_name || "",
      email: studentUser.email ?? null,
      act: { by: user.id, role: "parent" }, // optional audit marker
    };

    // 12) Persist session
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    return res.json({
      success: true,
      message: "Switched to student session successfully.",
      data: {
        as: "student",
        student_user_id: studentUserId,
        student_id: linkRows[0].student_id,
      },
    });
  } catch (err) {
    console.error("switchToStudent error:", { message: err?.message, err });
    return res.status(500).json({
      success: false,
      message: "Could not switch to student session. Please try again later.",
      code: "SWITCH_TO_STUDENT_FAILED",
    });
  }
};

// -----------------------------------------------------------------------------
// POST /parent/switch-back
// Restores parent identity from req.session.parent_user and clears switch_ctx
// -----------------------------------------------------------------------------
export const switchBackToParent = async (req, res) => {
  try {
    if (!req.session) {
      return res.status(500).json({
        success: false,
        message: "Session is not configured on the server.",
        code: "SESSION_NOT_CONFIGURED",
      });
    }

    // 1) Must have an active switch context + parent snapshot
    if (req.session.switch_ctx?.mode !== "as_student" || !req.session.parent_user) {
      return res.status(400).json({
        success: false,
        message: "No saved parent session found to switch back to.",
        code: "NO_SWITCH_CONTEXT",
      });
    }

    const parentUser = req.session.parent_user;

    // 2) Snapshot sanity checks (prevents weird/corrupt session states)
    if (String(parentUser.role).toLowerCase() !== "parent") {
      return res.status(400).json({
        success: false,
        message: "Saved parent session is invalid.",
        code: "INVALID_PARENT_SNAPSHOT",
      });
    }

    if (!parentUser?.id || !Number.isFinite(Number(parentUser.id))) {
      return res.status(400).json({
        success: false,
        message: "Saved parent session is invalid.",
        code: "INVALID_PARENT_SNAPSHOT",
      });
    }

    // OK NEW: Ensure snapshot matches the switch context parent_user_id
    if (Number(parentUser.id) !== Number(req.session.switch_ctx.parent_user_id)) {
      return res.status(400).json({
        success: false,
        message: "Saved parent session does not match switch context.",
        code: "PARENT_SNAPSHOT_MISMATCH",
      });
    }

    // 3) Re-validate parent identity against current DB state before restore.
    const [parentUserRows] = await pool.query(
      `
      SELECT id, role, is_active
      FROM users
      WHERE id = ?
      LIMIT 1
      `,
      [parentUser.id]
    );

    const clearSwitchSnapshot = async () => {
      delete req.session.parent_user;
      delete req.session.switch_ctx;
      await new Promise((resolve) => {
        req.session.save(() => resolve());
      });
    };

    if (!parentUserRows.length) {
      await clearSwitchSnapshot();
      return res.status(401).json({
        success: false,
        message: "Parent account could not be restored because it no longer exists.",
        code: "PARENT_RESTORE_INVALID",
      });
    }

    const dbParentUser = parentUserRows[0];
    if (String(dbParentUser.role || "").toLowerCase() !== "parent" || !dbParentUser.is_active) {
      await clearSwitchSnapshot();
      return res.status(403).json({
        success: false,
        message: "Parent account is not active or no longer eligible for restore.",
        code: "PARENT_ACCOUNT_INACTIVE",
      });
    }

    const [parentProfileRows] = await pool.query(
      `
      SELECT id
      FROM parents
      WHERE user_id = ?
      LIMIT 1
      `,
      [parentUser.id]
    );
    if (!parentProfileRows.length) {
      await clearSwitchSnapshot();
      return res.status(403).json({
        success: false,
        message: "Parent profile is missing and cannot be restored.",
        code: "PARENT_RESTORE_INVALID",
      });
    }

    // 4) Rotate session id again when switching identities (best practice)
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });

    // 5) Restore parent identity and clear switch data
    req.session.user = {
      id: dbParentUser.id,
      role: "parent",
      full_name: parentUser.full_name || "",
      email: parentUser.email ?? null,
    };

    delete req.session.parent_user;
    delete req.session.switch_ctx;

    // 6) Persist session
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    return res.json({
      success: true,
      message: "Switched back to parent session successfully.",
      data: { as: "parent" },
    });
  } catch (err) {
    console.error("switchBackToParent error:", { message: err?.message, err });
    return res.status(500).json({
      success: false,
      message: "Could not switch back. Please try again later.",
      code: "SWITCH_BACK_FAILED",
    });
  }
};
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

export const getParentAnnouncements = async (req, res) => {
  try {
    const { user: authedUser, errorResponse } = requireParent(req, res);
    if (!authedUser) return errorResponse;

    const data = await loadAnnouncementsForAudience("parents");
    return res.json({ success: true, data });
  } catch (err) {
    console.error("getParentAnnouncements error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

export const getParentNotifications = async (req, res) => {
  try {
    const { user: authedUser, errorResponse } = requireParent(req, res);
    if (!authedUser) return errorResponse;

    const data = await loadNotificationsForUser(authedUser.id);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("getParentNotifications error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

export const markParentNotificationRead = async (req, res) => {
  try {
    const { user: authedUser, errorResponse } = requireParent(req, res);
    if (!authedUser) return errorResponse;

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
      [id, authedUser.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Notification not found." });
    }

    return res.json({ success: true, message: "Notification marked as read." });
  } catch (err) {
    console.error("markParentNotificationRead error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

export const markAllParentNotificationsRead = async (req, res) => {
  try {
    const { user: authedUser, errorResponse } = requireParent(req, res);
    if (!authedUser) return errorResponse;

    await pool.query(
      `
      UPDATE notifications
      SET is_read = 1, read_at = NOW()
      WHERE user_id = ?
        AND is_read = 0
      `,
      [authedUser.id]
    );

    return res.json({ success: true, message: "All notifications marked as read." });
  } catch (err) {
    console.error("markAllParentNotificationsRead error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
