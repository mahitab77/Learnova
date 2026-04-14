// src/controllers/admin.controller.js
import pool from "../db.js";
import { upsertTeacherSelection } from "../services/teacherSelection.service.js";
import { assertTeacherEligibleForSubjectScope } from "../services/teacherDiscovery.service.js";
import { teacherHasLiveOfferingForScope } from "../utils/academicScope.js";
/* ============================================================================
 * ANNOUNCEMENTS / NOTIFICATIONS (ADMIN)
 * ============================================================================*/ 

function toPositiveInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.trunc(parsed);
  return normalized > 0 ? normalized : null;
}

function getPagination(req, { defaultLimit = 200, maxLimit = 500 } = {}) {
  const requestedLimit = Number.parseInt(String(req.query?.limit ?? ""), 10);
  const requestedOffset = Number.parseInt(String(req.query?.offset ?? ""), 10);

  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, maxLimit)
    : defaultLimit;
  const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0
    ? requestedOffset
    : 0;

  return { limit, offset };
}

 /**
  * 
  * POST /admin/announcements
  */
export const createAnnouncementAdmin = async (req, res) => {
  const adminUser = req.user;
  const { title, body, audience } = req.body || {};

  if (!title || !body) {
    return res.status(400).json({
      success: false,
      message: "title and body are required.",
    });
  }

  const allowedAudiences = ["all", "students", "parents", "teachers"];
  const aud = allowedAudiences.includes(audience) ? audience : "all";

  const safeTitle = String(title).trim().slice(0, 255);
  const safeBody = String(body).trim();

  if (!safeTitle || !safeBody) {
    return res.status(400).json({
      success: false,
      message: "title and body must not be empty.",
    });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 1) Create announcement
    const [result] = await conn.query(
      `
      INSERT INTO announcements
        (title, body, audience, created_by)
      VALUES (?, ?, ?, ?)
      `,
      [safeTitle, safeBody, aud, adminUser?.id || null]
    );

    const announcementId = result.insertId;

    // 2) Fan-out notification rows (per user inbox)
    const userIds = await getAudienceUserIds(conn, aud, false);

    const notificationRows = userIds.map((uid) => ({
      userId: uid,
      type: "announcement",
      title: safeTitle,
      body: safeBody,
      relatedType: "announcement",
      relatedId: announcementId,
      extraData: JSON.stringify({ audience: aud }),
    }));

    await bulkInsertNotificationsSafe(conn, notificationRows);

    await conn.commit();

    return res.status(201).json({
      success: true,
      message: "Announcement created.",
      data: { id: announcementId, deliveredTo: userIds.length },
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    console.error("createAnnouncementAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  } finally {
    if (conn) conn.release();
  }
};

/**
 * GET /admin/announcements
 * - List announcements (for admin history & maybe UI listing).
 */
export const getAnnouncementsAdmin = async (req, res) => {
  try {
    const { limit, offset } = getPagination(req, { defaultLimit: 50, maxLimit: 200 });
    const [rows] = await pool.query(
      `
      SELECT
        id,
        title,
        body,
        audience,
        created_by,
        created_at
      FROM announcements
      ORDER BY created_at DESC
      LIMIT ?
      OFFSET ?
      `
      ,
      [limit, offset]
    );

    return res.json({ success: true, data: rows, pagination: { limit, offset } });
  } catch (err) {
    console.error("getAnnouncementsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/*
 * 1) Announcements are stored in `announcements`.
 * 2) NEW: When admin creates an announcement, we "fan-out" a notification row
 *    into `notifications` for each targeted user.
 * 3) NEW: Admin can also view their own notification inbox (if any).
 */

async function loadNotificationsForUser(userId) {
  // unread count
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

  // latest items
  const [items] = await pool.query(
    `
    SELECT
      id, type, title, body,
      related_type, related_id,
      is_read, read_at, created_at
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

/**
 * Best-effort bulk insert of notifications with fallback if extra_data doesn't exist.
 * We intentionally keep it conservative and chunk inserts to avoid max packet issues.
 */
async function bulkInsertNotificationsSafe(conn, rows) {
  if (!rows.length) return;

  // We'll try with extra_data first.
  const CHUNK = 500;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);

    const values = [];
    const params = [];

    // Build multi-row VALUES (?, ?, ?, ?, ?, ?, 0, NOW(), ?), ...
    for (const row of chunk) {
      values.push("(?, ?, ?, ?, ?, ?, 0, NOW(), ?)");
      params.push(
        row.userId,
        row.type,
        row.title,
        row.body,
        row.relatedType,
        row.relatedId,
        row.extraData
      );
    }

    const sqlWithExtra = `
      INSERT INTO notifications
        (user_id, type, title, body, related_type, related_id, is_read, created_at, extra_data)
      VALUES ${values.join(", ")}
    `;

    try {
      await conn.query(sqlWithExtra, params);
      continue;
    } catch (err) {
      // fallback if extra_data missing
      if (err && (err.code === "ER_BAD_FIELD_ERROR" || err.errno === 1054)) {
        const values2 = [];
        const params2 = [];

        for (const row of chunk) {
          values2.push("(?, ?, ?, ?, ?, ?, 0, NOW())");
          params2.push(
            row.userId,
            row.type,
            row.title,
            row.body,
            row.relatedType,
            row.relatedId
          );
        }

        const sqlNoExtra = `
          INSERT INTO notifications
            (user_id, type, title, body, related_type, related_id, is_read, created_at)
          VALUES ${values2.join(", ")}
        `;

        await conn.query(sqlNoExtra, params2);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Resolve target users by announcement audience.
 * - students: users.role='student' AND is_active=1
 * - parents:  users.role='parent' AND is_active=1
 * - teachers: users.role='teacher' AND users.is_active=1 AND teachers.status='approved' AND teachers.is_active=1
 * - all: students + parents + approved teachers + admins (optional)
 *
 * NOTE: Here we EXCLUDE admins from "all" by default for end-user announcements.
 * If you want admins included, flip includeAdmins=true.
 */
async function getAudienceUserIds(conn, audience, includeAdmins = false) {
  const aud = audience || "all";

  const ids = new Set();

  // Students
  if (aud === "students" || aud === "all") {
    const [rows] = await conn.query(
      `SELECT id FROM users WHERE role='student' AND is_active=1`
    );
    rows.forEach((r) => ids.add(r.id));
  }

  // Parents
  if (aud === "parents" || aud === "all") {
    const [rows] = await conn.query(
      `SELECT id FROM users WHERE role='parent' AND is_active=1`
    );
    rows.forEach((r) => ids.add(r.id));
  }

  // Teachers (approved + active)
  if (aud === "teachers" || aud === "all") {
    const [rows] = await conn.query(
      `
      SELECT u.id
      FROM users u
      JOIN teachers t ON t.user_id = u.id
      WHERE u.role='teacher'
        AND u.is_active=1
        AND t.is_active=1
        AND t.status='approved'
      `
    );
    rows.forEach((r) => ids.add(r.id));
  }

  // Optional: admins
  if (includeAdmins && aud === "all") {
    const [rows] = await conn.query(
      `SELECT id FROM users WHERE role='admin' AND is_active=1`
    );
    rows.forEach((r) => ids.add(r.id));
  }

  return Array.from(ids);
}

/**
 * GET /admin/notifications
 */
export const getAdminNotifications = async (req, res) => {
  try {
    const adminUser = req.user;
    if (!adminUser?.id) {
      return res.status(401).json({ success: false, message: "Not authenticated." });
    }

    const data = await loadNotificationsForUser(adminUser.id);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("getAdminNotifications error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * PATCH /admin/notifications/:id/read
 */
export const markAdminNotificationRead = async (req, res) => {
  try {
    const adminUser = req.user;
    if (!adminUser?.id) {
      return res.status(401).json({ success: false, message: "Not authenticated." });
    }

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
      [id, adminUser.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Notification not found." });
    }

    return res.json({ success: true, message: "Notification marked as read." });
  } catch (err) {
    console.error("markAdminNotificationRead error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * PATCH /admin/notifications/read-all
 */
export const markAllAdminNotificationsRead = async (req, res) => {
  try {
    const adminUser = req.user;
    if (!adminUser?.id) {
      return res.status(401).json({ success: false, message: "Not authenticated." });
    }

    await pool.query(
      `
      UPDATE notifications
      SET is_read = 1, read_at = NOW()
      WHERE user_id = ?
        AND is_read = 0
      `,
      [adminUser.id]
    );

    return res.json({ success: true, message: "All notifications marked as read." });
  } catch (err) {
    console.error("markAllAdminNotificationsRead error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/* ============================================================================
 * SUBJECTS
 * ========================================================================== */
/**
 * GET /admin/subjects
 * - List all subjects for the admin dashboard.
 */
export const getAllSubjectsAdmin = async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name_ar, name_en, is_active, sort_order FROM subjects ORDER BY sort_order, id"
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getAllSubjectsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * POST /admin/subjects
 * - Create a new subject.
 */
export const createSubjectAdmin = async (req, res) => {
  const { name_ar, name_en, is_active = 1, sort_order = 0 } = req.body;
  if (!name_ar || !name_en) {
    return res.status(400).json({
      success: false,
      message: "name_ar and name_en are required.",
    });
  }

  try {
    const [result] = await pool.query(
      `
      INSERT INTO subjects (name_ar, name_en, is_active, sort_order)
      VALUES (?, ?, ?, ?)
      `,
      [name_ar, name_en, is_active ? 1 : 0, sort_order]
    );

    return res.status(201).json({
      success: true,
      message: "Subject created.",
      data: {
        id: result.insertId,
        name_ar,
        name_en,
      },
    });
  } catch (err) {
    console.error("createSubjectAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * PUT /admin/subjects/:id
 * - Update basic subject fields.
 */
export const updateSubjectAdmin = async (req, res) => {
  const { id } = req.params;
  const { name_ar, name_en, is_active, sort_order } = req.body;

  try {
    const [result] = await pool.query(
      `
      UPDATE subjects
      SET
        name_ar = COALESCE(?, name_ar),
        name_en = COALESCE(?, name_en),
        is_active = COALESCE(?, is_active),
        sort_order = COALESCE(?, sort_order)
      WHERE id = ?
      `,
      [name_ar, name_en, is_active, sort_order, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Not found." });
    }

    return res.json({ success: true, message: "Subject updated." });
  } catch (err) {
    console.error("updateSubjectAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * DELETE /admin/subjects/:id
 * - Delete a subject.
 * - NOTE: will fail if there are FK constraints referencing this subject.
 */
export const deleteSubjectAdmin = async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query(
      "UPDATE subjects SET is_active = 0 WHERE id = ?",
      [id]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Not found." });
    }
    return res.json({ success: true, message: "Subject deactivated." });
  } catch (err) {
    console.error("deleteSubjectAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/* ============================================================================
 * TEACHERS
 * ========================================================================== */
/**
 * GET /admin/teachers
 * - List all teachers with their subjects as comma-separated string.
 */
export const getAllTeachersAdmin = async (req, res) => {
  try {
    const { limit, offset } = getPagination(req, { defaultLimit: 200, maxLimit: 500 });
    
    const [rows] = await pool.query(
      `
      SELECT 
        t.id,
        t.name,
        t.bio_short,
        t.gender,
        t.photo_url,
        t.is_active,
        t.created_at,
        GROUP_CONCAT(DISTINCT s.name_en SEPARATOR ', ') as subjects
      FROM teachers t
      LEFT JOIN teacher_subjects ts ON ts.teacher_id = t.id
      LEFT JOIN subjects s ON s.id = ts.subject_id
      GROUP BY t.id
      ORDER BY t.name
      LIMIT ?
      OFFSET ?
      `
      ,
      [limit, offset]
    );

    return res.json({ success: true, data: rows, pagination: { limit, offset } });
  } catch (err) {
    console.error("getAllTeachersAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * POST /admin/teachers
 * - Create a new teacher (basic profile).
 */
export const createTeacherAdmin = async (req, res) => {
  return res.status(400).json({
    success: false,
    code: "TEACHER_IDENTITY_REQUIRED",
    message:
      "Direct teacher profile creation is disabled. Use teacher registration to create linked users+teachers identities.",
  });
};

/**
 * POST /admin/teachers/:teacherId/subjects
 * - Assign a teacher to a subject with priority.
 * - NOTE: actual route path name may differ (e.g. /assign); router controls it.
 */
export const assignTeacherToSubjectAdmin = async (req, res) => {
  const { teacherId } = req.params;
  const { subjectId, priority = 0 } = req.body;

  if (!subjectId) {
    return res
      .status(400)
      .json({ success: false, message: "subjectId is required." });
  }

  try {
    await pool.query(
      `
      INSERT INTO teacher_subjects (teacher_id, subject_id, priority)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE priority = VALUES(priority)
      `,
      [teacherId, subjectId, priority]
    );

    return res.json({
      success: true,
      message: "Teacher assigned to subject.",
    });
  } catch (err) {
    console.error("assignTeacherToSubjectAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * PUT /admin/teachers/:id
 * - Update teacher fields (used primarily for toggling is_active from admin UI).
 * - Body can include any subset of:
 *   { name, bio_short, gender, photo_url, is_active }
 */
export const updateTeacherAdmin = async (req, res) => {
  const { id } = req.params;
  const { name, bio_short, gender, photo_url, is_active } = req.body || {};

  try {
    const [result] = await pool.query(
      `
      UPDATE teachers
      SET
        name       = COALESCE(?, name),
        bio_short  = COALESCE(?, bio_short),
        gender     = COALESCE(?, gender),
        photo_url  = COALESCE(?, photo_url),
        is_active  = COALESCE(?, is_active)
      WHERE id = ?
      `,
      [name, bio_short, gender, photo_url, is_active, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Not found." });
    }

    return res.json({ success: true, message: "Teacher updated." });
  } catch (err) {
    console.error("updateTeacherAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/* ============================================================================
 * PARENT CHANGE REQUESTS
 * ========================================================================== */
/**
 * GET /admin/parent-requests
 * - List parent change requests with parent / student / subject / teacher info.
 */
export const getParentRequestsAdmin = async (req, res) => {
  try {
    const { limit, offset } = getPagination(req, { defaultLimit: 200, maxLimit: 500 });
    const [rows] = await pool.query(
      `
      SELECT 
        pcr.id,
        pcr.status,
        pcr.reason_text,
        pcr.created_at,
        par.id AS parent_id,
        u_parent.full_name AS parent_name,
        s.id AS student_id,
        u_student.full_name AS student_name,
        subj.name_en AS subject_name_en,
        subj.name_ar AS subject_name_ar,
        t.id AS current_teacher_id,
        t.name AS current_teacher_name
      FROM parent_change_requests pcr
      INNER JOIN parents par ON par.id = pcr.parent_id
      INNER JOIN users u_parent ON u_parent.id = par.user_id
      INNER JOIN students s ON s.id = pcr.student_id
      INNER JOIN users u_student ON u_student.id = s.user_id
      INNER JOIN subjects subj ON subj.id = pcr.subject_id
      LEFT JOIN teachers t ON t.id = pcr.current_teacher_id
      ORDER BY pcr.created_at DESC
      LIMIT ?
      OFFSET ?
      `,
      [limit, offset]
    );

    return res.json({ success: true, data: rows, pagination: { limit, offset } });
  } catch (err) {
    console.error("getParentRequestsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * POST /admin/parent-requests/:id/approve
 * - Approve a parent change request.
 * - Optionally accepts newTeacherId to directly update the student selection.
 */
export const approveParentRequestAdmin = async (req, res) => {
  const adminUser = req.user;
  const { id } = req.params;
  const { newTeacherId } = req.body || {};
  const normalizedNewTeacherId =
    newTeacherId == null ? null : toPositiveInt(newTeacherId);
  let conn;
  let txStarted = false;

  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    txStarted = true;

    // 1) load the request
    const [rows] = await conn.query(
      `
      SELECT * FROM parent_change_requests
      WHERE id = ? LIMIT 1
      FOR UPDATE
      `,
      [id]
    );
    if (rows.length === 0) {
      await conn.rollback();
      txStarted = false;
      return res.status(404).json({ success: false, message: "Not found." });
    }

    const reqRow = rows[0];
    if (String(reqRow.status).toLowerCase() !== "pending") {
      await conn.rollback();
      txStarted = false;
      return res.status(409).json({
        success: false,
        code: "REQUEST_NOT_PENDING",
        message: "Only pending requests can be approved.",
      });
    }

    const fallbackTeacherId = toPositiveInt(reqRow.requested_teacher_id);
    const effectiveTeacherId = normalizedNewTeacherId ?? fallbackTeacherId;
    if (!effectiveTeacherId) {
      await conn.rollback();
      txStarted = false;
      return res.status(400).json({
        success: false,
        code: "REQUESTED_TEACHER_REQUIRED",
        message:
          "Approval requires a requested teacher. Provide newTeacherId or ensure request contains requested_teacher_id.",
      });
    }

    const eligibility = await assertTeacherEligibleForSubjectScope(
      effectiveTeacherId,
      reqRow.student_id,
      reqRow.subject_id,
      {
        executor: conn,
        actorType: "student",
      }
    );
    if (!eligibility.ok) {
      await conn.rollback();
      txStarted = false;
      return res.status(eligibility.status).json({
        success: false,
        message: eligibility.message,
      });
    }

    await upsertTeacherSelection(conn, {
      studentId: reqRow.student_id,
      subjectId: reqRow.subject_id,
      teacherId: effectiveTeacherId,
      selectedBy: "admin",
    });

    // 3) mark request as approved
    await conn.query(
      `
      UPDATE parent_change_requests
      SET status = 'approved',
          admin_id = ?,
          processed_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'pending'
      `,
      [adminUser.id, id]
    );

    await conn.commit();
    txStarted = false;

    return res.json({
      success: true,
      message: "Request approved.",
    });
  } catch (err) {
    if (txStarted && conn) {
      try {
        await conn.rollback();
      } catch {}
    }
    console.error("approveParentRequestAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  } finally {
    if (conn) conn.release();
  }
};

/**
 * POST /admin/parent-requests/:id/reject
 * - Reject a parent change request.
 */
export const rejectParentRequestAdmin = async (req, res) => {
  const adminUser = req.user;
  const { id } = req.params;

  try {
    const [rows] = await pool.query(
      "SELECT id, status FROM parent_change_requests WHERE id = ? LIMIT 1",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Not found." });
    }

    if (String(rows[0].status).toLowerCase() !== "pending") {
      return res.status(409).json({
        success: false,
        code: "REQUEST_NOT_PENDING",
        message: "Only pending requests can be rejected.",
      });
    }

    await pool.query(
      `
      UPDATE parent_change_requests
      SET status = 'rejected',
          admin_id = ?,
          processed_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND status = 'pending'
      `,
      [adminUser.id, id]
    );

    return res.json({
      success: true,
      message: "Request rejected.",
    });
  } catch (err) {
    console.error("rejectParentRequestAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/* ============================================================================
 * USERS (Students & Parents)
 * ========================================================================== */
/**
 * GET /admin/students
 * - List student accounts for the admin "Users" tab.
 * - Uses existing tables: students + users.
 */
export const getAdminStudents = async (req, res) => {
  try {
    const { limit, offset } = getPagination(req, { defaultLimit: 200, maxLimit: 1000 });
    const [rows] = await pool.query(
      `
      SELECT
        s.id AS student_id,
        u.id AS user_id,
        u.full_name,
        u.email,
        u.role,
        u.preferred_lang,
        u.is_active,
        u.created_at
      FROM students s
      INNER JOIN users u ON u.id = s.user_id
      ORDER BY u.full_name, s.id
      LIMIT ?
      OFFSET ?
      `,
      [limit, offset]
    );

    return res.json({ success: true, data: rows, pagination: { limit, offset } });
  } catch (err) {
    console.error("getAdminStudents error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * GET /admin/parents
 * - List parent accounts for the admin "Users" tab.
 * - Uses existing tables: parents + users.
 */
export const getAdminParents = async (req, res) => {
  try {
    const { limit, offset } = getPagination(req, { defaultLimit: 200, maxLimit: 1000 });
    const [rows] = await pool.query(
      `
      SELECT
        p.id AS parent_id,
        u.id AS user_id,
        u.full_name,
        u.email,
        u.role,
        u.preferred_lang,
        u.is_active,
        u.created_at
      FROM parents p
      INNER JOIN users u ON u.id = p.user_id
      ORDER BY u.full_name, p.id
      LIMIT ?
      OFFSET ?
      `,
      [limit, offset]
    );

    return res.json({ success: true, data: rows, pagination: { limit, offset } });
  } catch (err) {
    console.error("getAdminParents error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * PUT /admin/users/:id/activate
 * - Activate or deactivate a user account.
 *
 * Usage:
 *   - If body omitted -> default to activate (is_active = 1).
 *   - If body has { is_active: 0|1|true|false } -> use that.
 */
export const activateUserAdmin = async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body || {};

  // Normalize to 0/1
  let newStatus;
  if (typeof is_active === "number") {
    newStatus = is_active ? 1 : 0;
  } else if (typeof is_active === "boolean") {
    newStatus = is_active ? 1 : 0;
  } else {
    newStatus = 1; // default: activate
  }

  let conn;
  let txStarted = false;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    txStarted = true;

    const [[targetUser]] = await conn.query(
      `
      SELECT id, role
      FROM users
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [id]
    );
    if (!targetUser) {
      await conn.rollback();
      txStarted = false;
      return res.status(404).json({ success: false, message: "User not found." });
    }

    const [result] = await conn.query(
      `
      UPDATE users
      SET is_active = ?
      WHERE id = ?
      `,
      [newStatus, id]
    );

    if (result.affectedRows === 0) {
      await conn.rollback();
      txStarted = false;
      return res.status(404).json({ success: false, message: "User not found." });
    }

    if (String(targetUser.role).toLowerCase() === "teacher") {
      await conn.query(
        `
        UPDATE teachers
        SET is_active = ?
        WHERE user_id = ?
        `,
        [newStatus, id]
      );
    }

    await conn.commit();
    txStarted = false;

    return res.json({
      success: true,
      message: newStatus ? "User activated." : "User deactivated.",
    });
  } catch (err) {
    if (txStarted && conn) {
      try {
        await conn.rollback();
      } catch {}
    }
    console.error("activateUserAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  } finally {
    if (conn) conn.release();
  }
};


/* ============================================================================
 * PARENT ↔ STUDENT LINKS
 * ============================================================================
 */

/**
 * GET /admin/parent-student-links
 * - List parent/student links with names and relationship.
 * - Optional query params:
 *   • parentId  -> filter by parent_id
 *   • studentId -> filter by student_id
 */
export const listParentStudentLinksAdmin = async (req, res) => {
  const { parentId, studentId } = req.query;
  const { limit, offset } = getPagination(req, { defaultLimit: 200, maxLimit: 1000 });

  const filters = [];
  const params = [];

  if (parentId) {
    filters.push("ps.parent_id = ?");
    params.push(parentId);
  }
  if (studentId) {
    filters.push("ps.student_id = ?");
    params.push(studentId);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  try {
    const [rows] = await pool.query(
      `
      SELECT
        ps.id,
        ps.parent_id,
        ps.student_id,
        ps.relationship,
        ps.created_at,
        p.user_id             AS parent_user_id,
        up.full_name          AS parent_name,
        s.user_id             AS student_user_id,
        us.full_name          AS student_name
      FROM parent_students ps
      INNER JOIN parents  p  ON p.id  = ps.parent_id
      INNER JOIN users    up ON up.id = p.user_id
      INNER JOIN students s  ON s.id  = ps.student_id
      INNER JOIN users    us ON us.id = s.user_id
      ${where}
      ORDER BY ps.created_at DESC, ps.id DESC
      LIMIT ?
      OFFSET ?
      `,
      [...params, limit, offset]
    );

    return res.json({ success: true, data: rows, pagination: { limit, offset } });
  } catch (err) {
    console.error("listParentStudentLinksAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * POST /admin/parent-student-links
 * - Create a new parent ↔ student link.
 * - Body: { parent_id, student_id, relationship? }
 *   • relationship ∈ ('mother','father','guardian') - defaults to 'mother'
 */
export const createParentStudentLinkAdmin = async (req, res) => {
  const { parent_id, student_id, relationship } = req.body || {};

  if (!parent_id || !student_id) {
    return res.status(400).json({
      success: false,
      message: "parent_id and student_id are required.",
    });
  }

  const rel =
    relationship === "father" || relationship === "guardian"
      ? relationship
      : "mother";

  try {
    // Ensure parent exists
    const [parentRows] = await pool.query(
      "SELECT id FROM parents WHERE id = ? LIMIT 1",
      [parent_id]
    );
    if (parentRows.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Parent not found." });
    }

    // Ensure student exists
    const [studentRows] = await pool.query(
      "SELECT id FROM students WHERE id = ? LIMIT 1",
      [student_id]
    );
    if (studentRows.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "Student not found." });
    }

    // Prevent duplicates (same parent + student)
    const [existing] = await pool.query(
      `
      SELECT id FROM parent_students
      WHERE parent_id = ? AND student_id = ?
      LIMIT 1
      `,
      [parent_id, student_id]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Link already exists for this parent and student.",
      });
    }

    const [result] = await pool.query(
      `
      INSERT INTO parent_students (parent_id, student_id, relationship)
      VALUES (?, ?, ?)
      `,
      [parent_id, student_id, rel]
    );

    return res.status(201).json({
      success: true,
      message: "Parent–student link created.",
      data: {
        id: result.insertId,
        parent_id,
        student_id,
        relationship: rel,
      },
    });
  } catch (err) {
    console.error("createParentStudentLinkAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * DELETE /admin/parent-student-links/:id
 * - Remove a parent ↔ student link.
 */
export const deleteParentStudentLinkAdmin = async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await pool.query(
      "DELETE FROM parent_students WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Link not found.",
      });
    }

    return res.json({
      success: true,
      message: "Parent–student link deleted.",
    });
  } catch (err) {
    console.error("deleteParentStudentLinkAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
/* ============================================================================
 * TEACHER ONBOARDING / APPROVAL
 * ============================================================================
 *
 * Requires extra columns on `teachers`:
 *   - status ENUM('pending_review','approved','rejected') DEFAULT 'approved'
 *   - approval_notes TEXT
 *   - max_capacity INT (used in assignments)
 */

/**
 * GET /admin/teachers/pending
 * - List teachers waiting for admin approval.
 */
export const getPendingTeachersAdmin = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT
        t.id,
        t.name,
        t.bio_short,
        t.gender,
        t.photo_url,
        t.is_active,
        t.status,
        t.max_capacity,
        t.approval_notes,
        t.created_at
      FROM teachers t
      WHERE t.status = 'pending_review'
      ORDER BY t.created_at DESC, t.name
      `
    );

    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getPendingTeachersAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * POST /admin/teachers/:id/approve
 * - Approve a pending teacher.
 * - Also activates the linked user account (users.is_active = 1).
 * - Body: { approval_notes? }
 */
export const approveTeacherAdmin = async (req, res) => {
  const adminUser = req.user; // populated by auth middleware
  const { id } = req.params;
  const { approval_notes } = req.body || {};

  const teacherId = Number(id);
  if (!teacherId) {
    return res.status(400).json({
      success: false,
      message: "Invalid teacher id.",
    });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 1) Load teacher + user_id
    const [rows] = await conn.query(
      `
      SELECT id, user_id, status
      FROM teachers
      WHERE id = ?
      LIMIT 1
      `,
      [teacherId]
    );

    if (rows.length === 0) {
      await conn.rollback();
      return res
        .status(404)
        .json({ success: false, message: "Teacher not found." });
    }

    const teacher = rows[0];
    const userId = teacher.user_id;
    if (String(teacher.status).toLowerCase() !== "pending_review") {
      await conn.rollback();
      return res.status(409).json({
        success: false,
        code: "TEACHER_NOT_PENDING",
        message: "Only pending_review teachers can be approved.",
      });
    }

    // 2) Update teacher row → approved + active + notes
    const [teacherResult] = await conn.query(
      `
      UPDATE teachers
      SET status = 'approved',
          is_active = 1,
          approval_notes = COALESCE(?, approval_notes)
      WHERE id = ?
      `,
      [approval_notes || null, teacherId]
    );

    if (teacherResult.affectedRows === 0) {
      await conn.rollback();
      return res
        .status(400)
        .json({ success: false, message: "Teacher not updated." });
    }

    // 3) Activate linked user account
    const [userResult] = await conn.query(
      `
      UPDATE users
      SET is_active = 1
      WHERE id = ?
      `,
      [userId]
    );

    if (userResult.affectedRows === 0) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: "Linked user not updated.",
      });
    }

    await conn.commit();

    // Optional: you could log adminUser.id here for audit
    return res.json({
      success: true,
      message: "Teacher approved and user account activated.",
      data: {
        teacherId,
        userId,
      },
    });
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch (rollbackErr) {
        console.error("approveTeacherAdmin rollback error:", rollbackErr);
      }
    }
    console.error("approveTeacherAdmin error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Server error." });
  } finally {
    if (conn) {
      conn.release();
    }
  }
};

/**
 * POST /admin/teachers/:id/reject
 * - Reject a pending teacher.
 * - Body: { approval_notes? } (reason)
 */
export const rejectTeacherAdmin = async (req, res) => {
  const adminUser = req.user;
  const { id } = req.params;
  const { approval_notes } = req.body || {};

  let conn;
  let txStarted = false;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(
      `
      SELECT id, user_id, status FROM teachers
      WHERE id = ? LIMIT 1
      `,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Teacher not found." });
    }

    const teacher = rows[0];
    if (String(teacher.status).toLowerCase() !== "pending_review") {
      return res.status(409).json({
        success: false,
        code: "TEACHER_NOT_PENDING",
        message: "Only pending_review teachers can be rejected.",
      });
    }

    await conn.beginTransaction();
    txStarted = true;

    const [result] = await conn.query(
      `
      UPDATE teachers
      SET status = 'rejected',
          is_active = 0,
          approval_notes = COALESCE(?, approval_notes)
      WHERE id = ?
      `,
      [approval_notes || null, id]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ success: false, message: "Teacher not updated." });
    }

    await conn.query(
      `
      UPDATE users
      SET is_active = 0
      WHERE id = ?
      `,
      [teacher.user_id]
    );

    await conn.commit();
    txStarted = false;

    return res.json({
      success: true,
      message: "Teacher rejected.",
    });
  } catch (err) {
    if (txStarted && conn) {
      try {
        await conn.rollback();
      } catch {}
    }
    console.error("rejectTeacherAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  } finally {
    if (conn) conn.release();
  }
};
/* ============================================================================
 * STUDENT–TEACHER ASSIGNMENT / MATCHING
 * ============================================================================
 *
 * Uses:
 *   - teacher_subjects
 *   - subjects
 *   - teachers (with max_capacity)
 *   - student_teacher_selections (already used in approveParentRequestAdmin)
 */

/**
 * GET /admin/teacher-assignments
 * - For each subject, list available teachers with their current load + capacity.
 */
export const getTeacherAssignmentsAdmin = async (req, res) => {
  try {
    const { limit, offset } = getPagination(req, { defaultLimit: 300, maxLimit: 1000 });
    const [rows] = await pool.query(
      `
      SELECT
        subj.id           AS subject_id,
        subj.name_en      AS subject_name_en,
        subj.name_ar      AS subject_name_ar,
        t.id              AS teacher_id,
        t.name            AS teacher_name,
        t.max_capacity    AS max_capacity,
        COALESCE(loads.current_load, 0) AS current_load
      FROM teacher_subjects ts
      INNER JOIN teachers t ON t.id = ts.teacher_id
      INNER JOIN subjects subj ON subj.id = ts.subject_id
      LEFT JOIN (
        SELECT
          sts.teacher_id,
          sts.subject_id,
          COUNT(*) AS current_load
        FROM student_teacher_selections sts
        WHERE sts.status = 'active'
        GROUP BY sts.teacher_id, sts.subject_id
      ) AS loads
        ON loads.teacher_id = t.id
       AND loads.subject_id = subj.id
      WHERE t.is_active = 1
      ORDER BY subj.name_en, t.name
      LIMIT ?
      OFFSET ?
      `,
      [limit, offset]
    );

    return res.json({ success: true, data: rows, pagination: { limit, offset } });
  } catch (err) {
    console.error("getTeacherAssignmentsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * POST /admin/teacher-assignments/reassign
 * - Reassign a student to another teacher for a subject.
 * - Body: { student_id, subject_id, to_teacher_id }
 */
export const reassignStudentTeacherAdmin = async (req, res) => {
  const adminUser = req.user;
  const { student_id, subject_id, to_teacher_id } = req.body || {};
  const studentId = toPositiveInt(student_id);
  const subjectId = toPositiveInt(subject_id);
  const toTeacherId = toPositiveInt(to_teacher_id);

  if (!studentId || !subjectId || !toTeacherId) {
    return res.status(400).json({
      success: false,
      message: "student_id, subject_id and to_teacher_id are required.",
    });
  }

  try {
    const eligibility = await assertTeacherEligibleForSubjectScope(
      toTeacherId,
      studentId,
      subjectId,
      {
        executor: pool,
        actorType: "student",
      }
    );
    if (!eligibility.ok) {
      return res.status(eligibility.status).json({
        success: false,
        message: eligibility.message,
      });
    }

    await upsertTeacherSelection(pool, {
      studentId,
      subjectId,
      teacherId: toTeacherId,
      selectedBy: "admin",
    });

    return res.json({
      success: true,
      message: "Student reassigned to new teacher.",
    });
  } catch (err) {
    console.error("reassignStudentTeacherAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * PUT /admin/teachers/:id/capacity
 * - Update max capacity per teacher (total allowed students, any subject).
 * - Body: { max_capacity }
 */
export const updateTeacherCapacityAdmin = async (req, res) => {
  const { id } = req.params;
  const { max_capacity } = req.body || {};

  if (max_capacity === undefined || max_capacity === null) {
    return res.status(400).json({
      success: false,
      message: "max_capacity is required.",
    });
  }

  try {
    const [result] = await pool.query(
      `
      UPDATE teachers
      SET max_capacity = ?
      WHERE id = ?
      `,
      [max_capacity, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Teacher not found." });
    }

    return res.json({
      success: true,
      message: "Teacher capacity updated.",
    });
  } catch (err) {
    console.error("updateTeacherCapacityAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
/* ============================================================================
 * TIMETABLE / SESSION SCHEDULING
 * ============================================================================
 *
 * Uses `teacher_schedules` table.
 */

/**
 * GET /admin/schedules
 * - List all teacher schedules with basic teacher info.
 */
export const getTeacherSchedulesAdmin = async (req, res) => {
  try {
    const { limit, offset } = getPagination(req, { defaultLimit: 300, maxLimit: 1000 });
    const [rows] = await pool.query(
      `
      SELECT
        sch.id,
        sch.teacher_id,
        t.name        AS teacher_name,
        sch.weekday,
        sch.start_time,
        sch.end_time,
        sch.is_group,
        sch.max_students,
        sch.created_at
      FROM teacher_schedules sch
      INNER JOIN teachers t ON t.id = sch.teacher_id
      ORDER BY t.name, sch.weekday, sch.start_time
      LIMIT ?
      OFFSET ?
      `,
      [limit, offset]
    );

    return res.json({ success: true, data: rows, pagination: { limit, offset } });
  } catch (err) {
    console.error("getTeacherSchedulesAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * POST /admin/schedules
 * - Create a new schedule slot for a teacher.
 * - Body: { teacher_id, weekday, start_time, end_time, is_group?, max_students? }
 */
export const createTeacherScheduleAdmin = async (req, res) => {
  const { teacher_id, weekday, start_time, end_time, is_group, max_students } =
    req.body || {};

  if (!teacher_id || weekday === undefined || !start_time || !end_time) {
    return res.status(400).json({
      success: false,
      message: "teacher_id, weekday, start_time and end_time are required.",
    });
  }

  try {
    const [result] = await pool.query(
      `
      INSERT INTO teacher_schedules
        (teacher_id, weekday, start_time, end_time, is_group, max_students)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        teacher_id,
        weekday,
        start_time,
        end_time,
        is_group ? 1 : 0,
        max_students ?? null,
      ]
    );

    return res.status(201).json({
      success: true,
      message: "Schedule created.",
      data: { id: result.insertId },
    });
  } catch (err) {
    console.error("createTeacherScheduleAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * PUT /admin/schedules/:id
 * - Update an existing schedule slot.
 */
export const updateTeacherScheduleAdmin = async (req, res) => {
  const { id } = req.params;
  const { weekday, start_time, end_time, is_group, max_students } = req.body || {};

  try {
    const [result] = await pool.query(
      `
      UPDATE teacher_schedules
      SET
        weekday      = COALESCE(?, weekday),
        start_time   = COALESCE(?, start_time),
        end_time     = COALESCE(?, end_time),
        is_group     = COALESCE(?, is_group),
        max_students = COALESCE(?, max_students)
      WHERE id = ?
      `,
      [
        weekday,
        start_time,
        end_time,
        typeof is_group === "boolean" ? (is_group ? 1 : 0) : is_group,
        max_students,
        id,
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Schedule not found." });
    }

    return res.json({
      success: true,
      message: "Schedule updated.",
    });
  } catch (err) {
    console.error("updateTeacherScheduleAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * DELETE /admin/schedules/:id
 * - Delete a schedule slot.
 */
export const deleteTeacherScheduleAdmin = async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await pool.query(
      "UPDATE teacher_schedules SET is_active = 0 WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Schedule not found." });
    }

    return res.json({
      success: true,
      message: "Schedule deactivated.",
    });
  } catch (err) {
    console.error("deleteTeacherScheduleAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};


/* ============================================================================
 * ADMIN ANALYTICS OVERVIEW
 * ============================================================================
 */

/**
 * GET /admin/overview
 * - Lightweight KPIs for the admin dashboard.
 *   • active students / parents / teachers
 *   • number of subjects
 *   • pending parent requests
 *   • pending teacher approvals
 */
export const getAdminOverview = async (req, res) => {
  try {
    const [
      [[studentsRow]],
      [[parentsRow]],
      [[teachersRow]],
      [[subjectsRow]],
      [[pendingParentReqRow]],
      [[pendingTeacherRow]],
    ] = await Promise.all([
      pool.query(
        `
        SELECT COUNT(*) AS cnt
        FROM users
        WHERE role = 'student' AND is_active = 1
        `
      ),
      pool.query(
        `
        SELECT COUNT(*) AS cnt
        FROM users
        WHERE role = 'parent' AND is_active = 1
        `
      ),
      pool.query(
        `
        SELECT COUNT(*) AS cnt
        FROM teachers
        WHERE is_active = 1 AND status = 'approved'
        `
      ),
      pool.query(
        `
        SELECT COUNT(*) AS cnt
        FROM subjects
        `
      ),
      pool.query(
        `
        SELECT COUNT(*) AS cnt
        FROM parent_change_requests
        WHERE status = 'pending'
        `
      ),
      pool.query(
        `
        SELECT COUNT(*) AS cnt
        FROM teachers
        WHERE status = 'pending_review'
        `
      ),
    ]);

    return res.json({
      success: true,
      data: {
        activeStudents: studentsRow.cnt || 0,
        activeParents: parentsRow.cnt || 0,
        activeTeachers: teachersRow.cnt || 0,
        subjects: subjectsRow.cnt || 0,
        pendingParentRequests: pendingParentReqRow.cnt || 0,
        pendingTeacherApprovals: pendingTeacherRow.cnt || 0,
      },
    });
  } catch (err) {
    console.error("getAdminOverview error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
/* ============================================================================
 * ADMIN CONFIGURATION / SETTINGS
 * ============================================================================
 *
 * Uses `settings` table with a single row:
 *   config_key   = 'global_settings'
 *   config_json  = JSON string of settings object
 */

const GLOBAL_SETTINGS_KEY = "global_settings";

// Default settings if DB row doesn't exist yet
const DEFAULT_SETTINGS = {
  gradeLevels: [], // e.g. ["Grade 1","Grade 2",...]
  termStartDate: null,
  termEndDate: null,
  defaultLanguage: "ar",
  autoEmailTeachersOnParentChange: false,
};

/**
 * GET /admin/settings
 * - Return global admin settings (merged with defaults).
 */
export const getAdminSettings = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `
      SELECT config_json
      FROM settings
      WHERE config_key = ?
      LIMIT 1
      `,
      [GLOBAL_SETTINGS_KEY]
    );

    let settings = { ...DEFAULT_SETTINGS };

    if (rows.length > 0 && rows[0].config_json) {
      try {
        const parsed = JSON.parse(rows[0].config_json);
        settings = { ...settings, ...parsed };
      } catch (parseErr) {
        console.error("getAdminSettings JSON parse error:", parseErr);
      }
    }

    return res.json({ success: true, data: settings });
  } catch (err) {
    console.error("getAdminSettings error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * PUT /admin/settings
 * - Update global admin settings.
 * - Body: partial settings object:
 *   { gradeLevels?, termStartDate?, termEndDate?, defaultLanguage?, autoEmailTeachersOnParentChange? }
 */
export const updateAdminSettings = async (req, res) => {
  const incoming = req.body || {};

  try {
    // Load existing
    const [rows] = await pool.query(
      `
      SELECT config_json
      FROM settings
      WHERE config_key = ?
      LIMIT 1
      `,
      [GLOBAL_SETTINGS_KEY]
    );

    let current = { ...DEFAULT_SETTINGS };
    if (rows.length > 0 && rows[0].config_json) {
      try {
        const parsed = JSON.parse(rows[0].config_json);
        current = { ...current, ...parsed };
      } catch (parseErr) {
        console.error("updateAdminSettings JSON parse error:", parseErr);
      }
    }

    // Merge
    const merged = { ...current, ...incoming };
    const jsonStr = JSON.stringify(merged);

    // Upsert row
    await pool.query(
      `
      INSERT INTO settings (config_key, config_json)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE config_json = VALUES(config_json)
      `,
      [GLOBAL_SETTINGS_KEY, jsonStr]
    );

    return res.json({
      success: true,
      message: "Settings updated.",
      data: merged,
    });
  } catch (err) {
    console.error("updateAdminSettings error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
// ===========================
// Scheduling (Admin Dashboard)
// ===========================

function adminSqlFail(res, err) {
  const msg = err?.sqlMessage || err?.message || "Database error.";
  if (err?.sqlState === "45000") {
    return res.status(400).json({ success: false, message: msg });
  }
  if (err?.code === "ER_DUP_ENTRY" || err?.errno === 1062) {
    return res.status(409).json({ success: false, message: msg });
  }
  console.error(err);
  return res.status(500).json({ success: false, message: "Unexpected server error." });
}

/**
 * POST /admin/dashboard/sessions
 * Body:
 * {
 *  teacher_id, subject_id, system_id, stage_id, grade_level_id,
 *  starts_at, ends_at,
 *  schedule_id? (nullable),
 *  is_group?, max_students?
 * }
 *
 * Rule:
 * - If schedule_id is NULL => must be covered by an active extra_available exception
 *   and we store exception_id, keep schedule_id NULL.
 * - DB triggers still enforce: no overlaps + availability sanity.
 */
export const adminCreateLessonSession = async (req, res) => {
  // requireAdmin already enforces this, but keep as defense-in-depth
  if (!req.user || String(req.user.role).toLowerCase() !== "admin") {
    return res.status(403).json({ success: false, message: "Admins only." });
  }

  const {
    teacher_id,
    subject_id,
    system_id,
    stage_id,
    grade_level_id = null,
    schedule_id = null,
    starts_at,
    ends_at,
    is_group = 0,
    max_students = null,
  } = req.body || {};

  if (!teacher_id || !subject_id || !system_id || !stage_id || !starts_at || !ends_at) {
    return res.status(400).json({
      success: false,
      message:
        "Missing required fields: teacher_id, subject_id, system_id, stage_id, starts_at, ends_at.",
    });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[futureRow]] = await conn.query(`SELECT (? > NOW()) AS is_future`, [starts_at]);
    if (!Number(futureRow?.is_future)) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: "starts_at must be in the future.",
      });
    }

    const [[teacherRow]] = await conn.query(
      `
      SELECT id
      FROM teachers
      WHERE id = ?
        AND status = 'approved'
        AND is_active = 1
      LIMIT 1
      FOR UPDATE
      `,
      [teacher_id]
    );
    if (!teacherRow) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: "Teacher must be approved and active.",
      });
    }

    const hasOffering = await teacherHasLiveOfferingForScope(
      Number(teacher_id),
      Number(subject_id),
      Number(system_id),
      Number(stage_id),
      grade_level_id == null ? null : Number(grade_level_id),
      conn
    );
    if (!hasOffering) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message:
          "Teacher does not have a live offering for this subject and academic scope.",
      });
    }

    let finalScheduleId = schedule_id || null;
    let finalExceptionId = null;

    // If admin is creating outside weekly schedule, require extra_available exception
    if (!finalScheduleId) {
      const [exRows] = await conn.query(
        `
        SELECT id
        FROM teacher_schedule_exceptions
        WHERE teacher_id = ?
          AND exception_type = 'extra_available'
          AND is_active = 1
          AND exception_date = DATE(?)
          AND start_time <= TIME(?)
          AND end_time >= TIME(?)
        ORDER BY start_time DESC
        LIMIT 1
        `,
        [teacher_id, starts_at, starts_at, ends_at]
      );

      if (!exRows.length) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message:
            "Outside weekly schedule. Create an active extra_available exception covering this time first.",
        });
      }

      finalExceptionId = exRows[0].id;
    } else {
      // Optional safety: ensure schedule belongs to teacher
      const [schRows] = await conn.query(
        `SELECT id FROM teacher_schedules WHERE id = ? AND teacher_id = ? LIMIT 1`,
        [finalScheduleId, teacher_id]
      );
      if (!schRows.length) {
        await conn.rollback();
        return res.status(400).json({
          success: false,
          message: "Invalid schedule_id for this teacher.",
        });
      }
    }

    const [[teacherConflict]] = await conn.query(
      `
      SELECT 1
      FROM lesson_sessions
      WHERE teacher_id = ?
        AND status IN ('pending','scheduled','approved')
        AND starts_at < ?
        AND ends_at   > ?
      LIMIT 1
      `,
      [teacher_id, ends_at, starts_at]
    );
    if (teacherConflict) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: "Teacher has a conflicting lesson at this time.",
      });
    }

    const [r] = await conn.query(
      `
      INSERT INTO lesson_sessions
        (teacher_id, subject_id, system_id, stage_id, grade_level_id,
         schedule_id, starts_at, ends_at, is_group, max_students,
         created_by_user_id, status, exception_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
      `,
      [
        teacher_id,
        subject_id,
        system_id,
        stage_id,
        grade_level_id,
        finalScheduleId,
        starts_at,
        ends_at,
        is_group ? 1 : 0,
        max_students,
        req.user.id,      // NOT NULL
        finalExceptionId, // nullable
      ]
    );

    await conn.commit();

    return res.status(201).json({
      success: true,
      message: "Session created.",
      data: {
        id: r.insertId,
        schedule_id: finalScheduleId,
        exception_id: finalExceptionId,
      },
    });
  } catch (err) {
    if (conn) {
      try {
        await conn.rollback();
      } catch {}
    }
    return adminSqlFail(res, err);
  } finally {
    if (conn) conn.release();
  }
};

/**
 * GET /admin/dashboard/teacher-schedule?teacher_id=7&from=YYYY-MM-DD&to=YYYY-MM-DD
 * Returns: slots + slotScopes + exceptions + sessions
 */
export const adminGetTeacherSchedulePanel = async (req, res) => {
  if (!req.user || String(req.user.role).toLowerCase() !== "admin") {
    return res.status(403).json({ success: false, message: "Admins only." });
  }

  try {
    const teacherId = Number(req.query.teacher_id);
    const { from, to } = req.query;

    if (!teacherId || Number.isNaN(teacherId)) {
      return res.status(400).json({ success: false, message: "teacher_id is required and must be a number." });
    }

    const [slots] = await pool.query(
      `
      SELECT id, weekday, start_time, end_time, is_group, max_students, is_active, created_at, updated_at
      FROM teacher_schedules
      WHERE teacher_id = ?
      ORDER BY weekday, start_time
      `,
      [teacherId]
    );

    const [slotScopes] = await pool.query(
      `
      SELECT
        tss.id, tss.schedule_id,
        tss.subject_id,
        s.name_en AS subject_name_en,
        s.name_ar AS subject_name_ar,
        tss.system_id,
        es.name_en AS system_name_en,
        es.name_ar AS system_name_ar,
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
      ORDER BY tss.schedule_id, tss.system_id, tss.stage_id, tss.grade_level_id, tss.subject_id
      `,
      [teacherId]
    );

    const exParams = [teacherId];
    let exWhere = `WHERE teacher_id = ?`;
    if (from) { exWhere += ` AND exception_date >= ?`; exParams.push(from); }
    if (to)   { exWhere += ` AND exception_date <= ?`; exParams.push(to); }

    const [exceptions] = await pool.query(
      `
      SELECT id, exception_date, start_time, end_time, exception_type,
             is_group, max_students, note, reason, is_active
      FROM teacher_schedule_exceptions
      ${exWhere}
      ORDER BY exception_date, start_time
      `,
      exParams
    );

    const sParams = [teacherId];
    let sWhere = `WHERE teacher_id = ? AND status NOT IN ('cancelled', 'rejected')`;
    if (from) { sWhere += ` AND DATE(starts_at) >= ?`; sParams.push(from); }
    if (to)   { sWhere += ` AND DATE(starts_at) <= ?`; sParams.push(to); }

    const [sessions] = await pool.query(
      `
      SELECT id, starts_at, ends_at, schedule_id, exception_id, status,
             subject_id, system_id, stage_id, grade_level_id, is_group, max_students
      FROM lesson_sessions
      ${sWhere}
      ORDER BY starts_at
      `,
      sParams
    );

    return res.json({
      success: true,
      data: { teacherId, slots, slotScopes, exceptions, sessions },
    });
  } catch (err) {
    return adminSqlFail(res, err);
  }
};
/**
 * GET /admin/lesson-requests/pending
 * - Global view of all pending lesson session requests
 */
export const getPendingLessonRequestsAdmin = async (req, res) => {
  try {
    const { limit, offset } = getPagination(req, { defaultLimit: 200, maxLimit: 500 });
    const [rows] = await pool.query(
      `
      SELECT
        ls.id,
        ls.starts_at,
        ls.ends_at,
        ls.is_group,
        ls.max_students,
        ls.teacher_id,
        t.name        AS teacher_name,
        s.name_en     AS subject_name_en,
        s.name_ar     AS subject_name_ar,
        u.full_name   AS requested_by,
        ls.created_at
      FROM lesson_sessions ls
      JOIN teachers t ON t.id = ls.teacher_id
      JOIN subjects s ON s.id = ls.subject_id
      JOIN users u    ON u.id = ls.created_by_user_id
      WHERE ls.status = 'pending'
      ORDER BY ls.created_at ASC
      LIMIT ?
      OFFSET ?
      `,
      [limit, offset]
    );

    return res.json({ success: true, data: rows, pagination: { limit, offset } });
  } catch (err) {
    console.error("getPendingLessonRequestsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
/**
 * POST /admin/lesson-requests/:id/approve
 * - Force approve a pending lesson request
 */
export const approveLessonRequestAdmin = async (req, res) => {
  const sessionId = Number(req.params.id);

  if (!Number.isInteger(sessionId)) {
    return res.status(400).json({ success: false, message: "Invalid session id." });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Lock session
    const [[session]] = await conn.query(
      `
      SELECT id, teacher_id, starts_at, ends_at, created_by_user_id, student_id, status
      FROM lesson_sessions
      WHERE id = ?
        AND status = 'pending'
      FOR UPDATE
      `,
      [sessionId]
    );

    if (!session) {
      await conn.rollback();
      return res.status(404).json({
        success: false,
        message: "Pending lesson request not found.",
      });
    }

    if (!session.student_id || Number(session.student_id) <= 0) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: "Lesson request has no valid student assigned.",
      });
    }

    // Conflict check
    const [[conflict]] = await conn.query(
      `
      SELECT 1
      FROM lesson_sessions
      WHERE teacher_id = ?
        AND status IN ('pending','scheduled','approved')
        AND id <> ?
        AND starts_at < ?
        AND ends_at   > ?
      LIMIT 1
      `,
      [
        session.teacher_id,
        sessionId,
        session.ends_at,
        session.starts_at,
      ]
    );

    if (conflict) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: "Session conflicts with another booking.",
      });
    }

    const [[studentConflict]] = await conn.query(
      `
      SELECT 1
      FROM lesson_sessions
      WHERE student_id = ?
        AND status IN ('pending','scheduled','approved')
        AND id <> ?
        AND starts_at < ?
        AND ends_at   > ?
      LIMIT 1
      `,
      [session.student_id, sessionId, session.ends_at, session.starts_at]
    );
    if (studentConflict) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: "Student has a conflicting session at this time.",
      });
    }

    const [[futureRow]] = await conn.query(
      `SELECT (? > NOW()) AS is_future`,
      [session.starts_at]
    );
    if (!Number(futureRow?.is_future)) {
      await conn.rollback();
      return res.status(400).json({
        success: false,
        message: "Pending lesson request is no longer in the future.",
      });
    }

    // Approve
    await conn.query(
      `
      UPDATE lesson_sessions
      SET status = 'scheduled',
          updated_by_user_id = ?
      WHERE id = ?
      `,
      [req.user?.id ?? null, sessionId]
    );

    // Enroll student using canonical lesson_sessions.student_id.
    await conn.query(
      `
      INSERT IGNORE INTO lesson_session_students
        (session_id, student_id, attendance_status)
      VALUES (?, ?, 'scheduled')
      `,
      [sessionId, session.student_id]
    );

    await conn.commit();

    return res.json({
      success: true,
      message: "Lesson request approved by admin.",
    });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error("approveLessonRequestAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  } finally {
    if (conn) conn.release();
  }
};
/**
 * POST /admin/lessons/:id/cancel
 * - Cancel a lesson session (pending or scheduled)
 */
export const cancelLessonSessionAdmin = async (req, res) => {
  const sessionId = Number(req.params.id);
  const cancelReasonRaw = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  const cancelReason = cancelReasonRaw ? cancelReasonRaw.slice(0, 255) : null;

  if (!Number.isInteger(sessionId)) {
    return res.status(400).json({ success: false, message: "Invalid session id." });
  }

  try {
    const [result] = await pool.query(
      `
      UPDATE lesson_sessions
      SET status = 'cancelled',
          cancelled_by = 'admin',
          cancel_reason = COALESCE(?, cancel_reason),
          cancelled_at = NOW(),
          updated_by_user_id = ?
      WHERE id = ?
        AND status IN ('pending','scheduled','approved')
      `,
      [cancelReason, req.user?.id ?? null, sessionId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        success: false,
        message: "Session not found or already cancelled.",
      });
    }

    return res.json({
      success: true,
      message: "Lesson session cancelled.",
    });
  } catch (err) {
    console.error("cancelLessonSessionAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
/**
 * GET /admin/lesson-sessions
 * - Read-only list for admin observability
 */
export const getAdminLessonSessionsAdmin = async (req, res) => {
  try {
    const { limit, offset } = getPagination(req, { defaultLimit: 100, maxLimit: 300 });
    const [rows] = await pool.query(
      `
      SELECT
        ls.id,
        ls.starts_at,
        ls.ends_at,
        ls.status,
        ls.is_group,
        ls.max_students,
        ls.created_at,

        ls.teacher_id,
        t.name AS teacher_name,

        ls.subject_id,
        s.name_en AS subject_name_en,
        s.name_ar AS subject_name_ar,

        ls.created_by_user_id,
        u.full_name AS created_by_name,

        (SELECT COUNT(*) FROM lesson_session_students lss WHERE lss.session_id = ls.id) AS students_count
      FROM lesson_sessions ls
      JOIN teachers t ON t.id = ls.teacher_id
      JOIN subjects s ON s.id = ls.subject_id
      LEFT JOIN users u ON u.id = ls.created_by_user_id
      ORDER BY ls.starts_at DESC
      LIMIT ?
      OFFSET ?
      `
      ,
      [limit, offset]
    );

    return res.json({ success: true, data: rows, pagination: { limit, offset } });
  } catch (err) {
    console.error("getAdminLessonSessionsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/* ============================================================================
 * SESSION MEETING INFO (Zoom + YouTube)
 * ============================================================================ */

import { extractYouTubeId } from "./meeting.controller.js";

/**
 * PATCH /admin/lesson-sessions/:id/meeting
 * Set or clear Zoom meeting ID/password and YouTube video ID on a session.
 * Body: { zoom_meeting_id?, zoom_password?, youtube_video_id? }
 * Pass null or empty string to clear a field.
 */
export const updateSessionMeetingAdmin = async (req, res) => {
  const sessionId = parseInt(req.params.id, 10);
  if (!sessionId || sessionId <= 0) {
    return res.status(400).json({ success: false, message: "Invalid session id." });
  }

  const { zoom_meeting_id, zoom_password, youtube_video_id } = req.body || {};

  const zoomId  = zoom_meeting_id  ? String(zoom_meeting_id).trim()  || null : null;
  const zoomPwd = zoom_password    ? String(zoom_password).trim()    || null : null;
  const ytId    = extractYouTubeId(youtube_video_id);

  try {
    const [result] = await pool.query(
      `UPDATE lesson_sessions
       SET zoom_meeting_id   = ?,
           zoom_password     = ?,
           youtube_video_id  = ?
       WHERE id = ?`,
      [zoomId, zoomPwd, ytId, sessionId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Session not found." });
    }

    return res.json({
      success: true,
      message: "Session meeting info updated.",
      data: { zoom_meeting_id: zoomId, zoom_password: zoomPwd, youtube_video_id: ytId },
    });
  } catch (err) {
    console.error("updateSessionMeetingAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/* ============================================================================
 * MODERATOR MANAGEMENT
 * ============================================================================ */

import { hashPassword } from "../utils/password.js";

/**
 * GET /admin/moderators
 * List all moderator accounts.
 */
export const getModeratorsAdmin = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, full_name, email, is_active, created_at
       FROM users
       WHERE role = 'moderator'
       ORDER BY full_name`
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("getModeratorsAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};

/**
 * POST /admin/moderators
 * Create a new moderator account (admin only).
 * Body: { full_name, email, password }
 */
export const createModeratorAdmin = async (req, res) => {
  const { full_name, email, password } = req.body || {};

  if (!full_name || typeof full_name !== "string" || !full_name.trim()) {
    return res.status(400).json({ success: false, message: "full_name is required." });
  }
  if (!email || typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ success: false, message: "email is required." });
  }
  if (!password || typeof password !== "string" || password.length < 6) {
    return res.status(400).json({ success: false, message: "password must be at least 6 characters." });
  }

  const safeName = full_name.trim();
  const safeEmail = email.trim().toLowerCase();

  try {
    // Check email uniqueness
    const [existing] = await pool.query(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [safeEmail]
    );
    if (existing.length) {
      return res.status(409).json({ success: false, message: "Email already in use." });
    }

    const hashedPassword = await hashPassword(password);

    const [result] = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role, is_active)
       VALUES (?, ?, ?, 'moderator', 1)`,
      [safeName, safeEmail, hashedPassword]
    );

    return res.status(201).json({
      success: true,
      message: "Moderator account created.",
      data: { id: result.insertId, full_name: safeName, email: safeEmail },
    });
  } catch (err) {
    console.error("createModeratorAdmin error:", err);
    return res.status(500).json({ success: false, message: "Server error." });
  }
};
