import pool from "../db.js";

const EDIT_WINDOW_DAYS = 7;
const COMMENT_MAX_LENGTH = 1000;
const ELIGIBLE_ATTENDANCE_STATUSES = new Set(["present", "late"]);

function logErr(scope, err) {
  console.error(`[ratingController][${scope}]`, err);
}

function badRequest(res, message) {
  return res.status(400).json({ success: false, message });
}

function unauthorized(res, message = "Unauthorized") {
  return res.status(401).json({ success: false, message });
}

function forbidden(res, message = "Forbidden") {
  return res.status(403).json({ success: false, message });
}

function notFound(res, message = "Not found") {
  return res.status(404).json({ success: false, message });
}

function serverError(res) {
  return res.status(500).json({
    success: false,
    message: "An unexpected server error occurred. Please try again.",
  });
}

function parsePositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeComment(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, COMMENT_MAX_LENGTH) : null;
}

function toResponseDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : String(value);
}

function buildEditableUntil(value) {
  return toResponseDateTime(value);
}

function isWithinEditWindow(sessionOrFlag) {
  if (
    sessionOrFlag &&
    typeof sessionOrFlag === "object" &&
    "within_edit_window" in sessionOrFlag
  ) {
    return Number(sessionOrFlag.within_edit_window) === 1;
  }

  return Number(sessionOrFlag) === 1;
}

function isEligibleAttendanceStatus(value) {
  return ELIGIBLE_ATTENDANCE_STATUSES.has(String(value || "").toLowerCase());
}

function isEligibleSession(sessionRow) {
  if (!sessionRow) return false;
  // Ratings are only allowed for sessions that have been finalized as 'completed'.
  // The attendance-based OR fallback is removed: non-completed sessions (excused
  // 1-on-1s, all group sessions) must not be rateable until a completed status
  // is actually recorded by the finalization path.
  if (String(sessionRow.status || "").toLowerCase() !== "completed") return false;
  return isEligibleAttendanceStatus(sessionRow.attendance_status);
}

function summarizeExistingRating(row) {
  if (!row) return null;
  return {
    stars: Number(row.stars),
    comment: row.comment ?? null,
  };
}

function ratingOwnedByContext(row, context) {
  if (!row || !context) return false;

  if (context.actorParentId) {
    return Number(row.parent_id) === Number(context.actorParentId);
  }

  return (
    (row.parent_id === null || row.parent_id === undefined) &&
    Number(row.student_id) === Number(context.actorStudentId)
  );
}

function canRateForContext(context, existingRating) {
  if (!context?.session) return false;
  if (!isEligibleSession(context.session)) return false;
  if (!isWithinEditWindow(context.session)) return false;
  if (existingRating && !ratingOwnedByContext(existingRating, context)) return false;
  return true;
}

async function lessonSessionExists(conn, sessionId) {
  const [rows] = await conn.query(
    `SELECT 1
     FROM lesson_sessions
     WHERE id = ?
     LIMIT 1`,
    [sessionId]
  );
  return rows.length > 0;
}

async function loadStudentActor(conn, userId) {
  const [rows] = await conn.query(
    `SELECT u.id AS user_id, u.role, u.is_active, s.id AS student_id
     FROM users u
     LEFT JOIN students s ON s.user_id = u.id
     WHERE u.id = ?
     LIMIT 1`,
    [userId]
  );

  const row = rows[0];
  if (!row || Number(row.is_active) !== 1 || row.role !== "student") {
    return null;
  }
  if (!row.student_id) {
    return null;
  }

  return {
    userId: Number(row.user_id),
    studentId: Number(row.student_id),
  };
}

async function loadParentActor(conn, userId) {
  const [rows] = await conn.query(
    `SELECT u.id AS user_id, u.role, u.is_active, p.id AS parent_id
     FROM users u
     LEFT JOIN parents p ON p.user_id = u.id
     WHERE u.id = ?
     LIMIT 1`,
    [userId]
  );

  const row = rows[0];
  if (!row || Number(row.is_active) !== 1 || row.role !== "parent") {
    return null;
  }
  if (!row.parent_id) {
    return null;
  }

  return {
    userId: Number(row.user_id),
    parentId: Number(row.parent_id),
  };
}

async function loadLessonSessionStudentAttendance(conn, { sessionId, studentId }) {
  const [rows] = await conn.query(
    `SELECT attendance_status
     FROM lesson_session_students
     WHERE session_id = ?
       AND student_id = ?
     LIMIT 1`,
    [sessionId, studentId]
  );

  return rows[0]?.attendance_status ?? null;
}

async function loadStudentSessionAccess(
  conn,
  { studentId, sessionId, lock = false }
) {
  const lockClause = lock ? " FOR UPDATE" : "";
  const [rows] = await conn.query(
    `SELECT
       ls.id,
       ls.teacher_id,
       ls.status,
       ls.ends_at,
       t.user_id AS teacher_user_id,
       DATE_ADD(ls.ends_at, INTERVAL ${EDIT_WINDOW_DAYS} DAY) AS editable_until,
       CASE
         WHEN ls.ends_at IS NOT NULL
          AND NOW() <= DATE_ADD(ls.ends_at, INTERVAL ${EDIT_WINDOW_DAYS} DAY)
         THEN 1 ELSE 0
       END AS within_edit_window
     FROM lesson_sessions ls
     INNER JOIN teachers t ON t.id = ls.teacher_id
     LEFT JOIN lesson_session_students lss
       ON lss.session_id = ls.id
      AND lss.student_id = ?
     WHERE ls.id = ?
       AND (ls.student_id = ? OR lss.student_id IS NOT NULL)
     LIMIT 1${lockClause}`,
    [studentId, sessionId, studentId]
  );

  return rows[0] || null;
}

async function loadParentSessionAccess(
  conn,
  { parentId, sessionId, lock = false }
) {
  const lockClause = lock ? " FOR UPDATE" : "";
  const [rows] = await conn.query(
    `SELECT
       ls.id,
       ls.teacher_id,
       ls.status,
       ls.ends_at,
       t.user_id AS teacher_user_id,
       DATE_ADD(ls.ends_at, INTERVAL ${EDIT_WINDOW_DAYS} DAY) AS editable_until,
       CASE
         WHEN ls.ends_at IS NOT NULL
          AND NOW() <= DATE_ADD(ls.ends_at, INTERVAL ${EDIT_WINDOW_DAYS} DAY)
         THEN 1 ELSE 0
       END AS within_edit_window,
       COALESCE(
         (
           SELECT ps.student_id
           FROM parent_students ps
           WHERE ps.parent_id = ?
             AND ps.student_id = ls.student_id
           LIMIT 1
         ),
         (
           SELECT lss.student_id
           FROM lesson_session_students lss
           INNER JOIN parent_students ps
             ON ps.student_id = lss.student_id
           WHERE lss.session_id = ls.id
             AND ps.parent_id = ?
           ORDER BY lss.student_id ASC
           LIMIT 1
         )
       ) AS actor_student_id
     FROM lesson_sessions ls
     INNER JOIN teachers t ON t.id = ls.teacher_id
     WHERE ls.id = ?
     LIMIT 1${lockClause}`,
    [parentId, parentId, sessionId]
  );

  const row = rows[0] || null;
  if (!row || !row.actor_student_id) return null;

  return {
    ...row,
    actor_student_id: Number(row.actor_student_id),
  };
}

async function loadRatingBySession(conn, sessionId, { lock = false } = {}) {
  const lockClause = lock ? " FOR UPDATE" : "";
  const [rows] = await conn.query(
    `SELECT
       id,
       session_id,
       teacher_id,
       student_id,
       parent_id,
       stars,
       comment,
       is_hidden,
       created_at,
       updated_at
     FROM teacher_ratings
     WHERE session_id = ?
     LIMIT 1${lockClause}`,
    [sessionId]
  );

  return rows[0] || null;
}

async function getTeacherRatingSummary(conn, teacherId) {
  const [rows] = await conn.query(
    `SELECT
       ROUND(AVG(stars), 1) AS rating_avg,
       COUNT(*) AS rating_count
     FROM teacher_ratings
     WHERE teacher_id = ?
       AND is_hidden = 0`,
    [teacherId]
  );

  const row = rows[0] || {};
  return {
    ratingAvg:
      row.rating_avg === null || row.rating_avg === undefined
        ? null
        : Number(row.rating_avg),
    ratingCount: Number(row.rating_count || 0),
  };
}

async function acquireSessionRatingLock(conn, sessionId) {
  const lockKey = `teacher_rating_session_${Number(sessionId)}`;
  const [rows] = await conn.query(`SELECT GET_LOCK(?, 5) AS lock_acquired`, [lockKey]);
  const acquired = Number(rows?.[0]?.lock_acquired) === 1;
  return acquired ? lockKey : null;
}

async function releaseSessionRatingLock(conn, lockKey) {
  if (!lockKey) return;
  try {
    await conn.query(`DO RELEASE_LOCK(?)`, [lockKey]);
  } catch (_) {}
}

async function buildStudentContext(conn, userId, sessionId, { lock = false } = {}) {
  const actor = await loadStudentActor(conn, userId);
  if (!actor) return { kind: "actor_missing" };

  const session = await loadStudentSessionAccess(conn, {
    studentId: actor.studentId,
    sessionId,
    lock,
  });

  if (!session) {
    return (await lessonSessionExists(conn, sessionId))
      ? { kind: "forbidden" }
      : { kind: "session_missing" };
  }

  const attendanceStatus = await loadLessonSessionStudentAttendance(conn, {
    sessionId,
    studentId: actor.studentId,
  });

  return {
    kind: "ok",
    actor,
    session: { ...session, attendance_status: attendanceStatus },
    actorStudentId: actor.studentId,
    actorParentId: null,
  };
}

async function buildParentContext(conn, userId, sessionId, { lock = false } = {}) {
  const actor = await loadParentActor(conn, userId);
  if (!actor) return { kind: "actor_missing" };

  const session = await loadParentSessionAccess(conn, {
    parentId: actor.parentId,
    sessionId,
    lock,
  });

  if (!session) {
    return (await lessonSessionExists(conn, sessionId))
      ? { kind: "forbidden" }
      : { kind: "session_missing" };
  }

  const attendanceStatus = await loadLessonSessionStudentAttendance(conn, {
    sessionId,
    studentId: session.actor_student_id,
  });

  return {
    kind: "ok",
    actor,
    session: { ...session, attendance_status: attendanceStatus },
    actorStudentId: session.actor_student_id,
    actorParentId: actor.parentId,
  };
}

function handleContextFailure(res, context, actorLabel) {
  if (context.kind === "actor_missing") {
    return actorLabel === "student"
      ? notFound(res, "Active student profile not found.")
      : notFound(res, "Parent profile not found.");
  }

  if (context.kind === "session_missing") {
    return notFound(res, "Lesson session not found.");
  }

  return forbidden(
    res,
    actorLabel === "student"
      ? "You are not allowed to rate this lesson session."
      : "You are not allowed to rate this child's lesson session."
  );
}

async function getRatingForContext(req, res, actorLabel) {
  const authedUserId = parsePositiveInt(req.user?.id ?? req.session?.user?.id);
  if (!authedUserId) return unauthorized(res);

  const sessionId = parsePositiveInt(req.params?.sessionId);
  if (!sessionId) return badRequest(res, "Invalid sessionId.");

  const conn = await pool.getConnection();
  try {
    const context =
      actorLabel === "student"
        ? await buildStudentContext(conn, authedUserId, sessionId)
        : await buildParentContext(conn, authedUserId, sessionId);

    if (context.kind !== "ok") {
      return handleContextFailure(res, context, actorLabel);
    }

    if (Number(context.session.teacher_user_id) === authedUserId) {
      return forbidden(res, "Teachers cannot rate themselves.");
    }

    const ratingRow = await loadRatingBySession(conn, sessionId);
    const ownedRating = ratingOwnedByContext(ratingRow, context) ? ratingRow : null;

    return res.json({
      success: true,
      data: {
        canRate: canRateForContext(context, ratingRow),
        editableUntil: buildEditableUntil(context.session.editable_until),
        rating: summarizeExistingRating(ownedRating),
      },
    });
  } catch (err) {
    logErr(`${actorLabel}.get`, err);
    return serverError(res);
  } finally {
    conn.release();
  }
}

async function saveRatingForContext(req, res, actorLabel) {
  const authedUserId = parsePositiveInt(req.user?.id ?? req.session?.user?.id);
  if (!authedUserId) return unauthorized(res);

  const sessionId = parsePositiveInt(req.params?.sessionId);
  if (!sessionId) return badRequest(res, "Invalid sessionId.");

  const stars = Number(req.body?.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return badRequest(res, "stars must be an integer between 1 and 5.");
  }

  const comment = normalizeComment(req.body?.comment);

  const conn = await pool.getConnection();
  let txStarted = false;
  let advisoryLockKey = null;

  try {
    advisoryLockKey = await acquireSessionRatingLock(conn, sessionId);
    if (!advisoryLockKey) {
      return res.status(409).json({
        success: false,
        message: "Another rating update is in progress for this session. Please retry.",
      });
    }

    await conn.beginTransaction();
    txStarted = true;

    const context =
      actorLabel === "student"
        ? await buildStudentContext(conn, authedUserId, sessionId, { lock: true })
        : await buildParentContext(conn, authedUserId, sessionId, { lock: true });

    if (context.kind !== "ok") {
      await conn.rollback();
      txStarted = false;
      return handleContextFailure(res, context, actorLabel);
    }

    if (Number(context.session.teacher_user_id) === authedUserId) {
      await conn.rollback();
      txStarted = false;
      return forbidden(res, "Teachers cannot rate themselves.");
    }

    if (!isEligibleSession(context.session)) {
      await conn.rollback();
      txStarted = false;
      return badRequest(
        res,
        "Ratings are only allowed after a completed lesson session with eligible attendance."
      );
    }

    if (!isWithinEditWindow(context.session)) {
      await conn.rollback();
      txStarted = false;
      return badRequest(
        res,
        "Ratings can only be submitted or edited within 7 days of session completion."
      );
    }

    const existingRating = await loadRatingBySession(conn, sessionId, { lock: true });

    if (existingRating && !ratingOwnedByContext(existingRating, context)) {
      await conn.rollback();
      txStarted = false;
      return forbidden(
        res,
        "A rating has already been submitted for this lesson session."
      );
    }

    if (existingRating) {
      await conn.query(
        `UPDATE teacher_ratings
         SET stars = ?,
             comment = ?
         WHERE id = ?`,
        [stars, comment, existingRating.id]
      );
    } else {
      await conn.query(
        `INSERT INTO teacher_ratings
           (session_id, teacher_id, student_id, parent_id, stars, comment, is_hidden)
         VALUES
           (?, ?, ?, ?, ?, ?, 0)`,
        [
          sessionId,
          context.session.teacher_id,
          context.actorStudentId,
          context.actorParentId,
          stars,
          comment,
        ]
      );
    }

    const savedRating = await loadRatingBySession(conn, sessionId);
    const summary = await getTeacherRatingSummary(conn, context.session.teacher_id);

    await conn.commit();
    txStarted = false;

    return res.json({
      success: true,
      message: existingRating
        ? "Rating updated successfully."
        : "Rating submitted successfully.",
      data: {
        rating: summarizeExistingRating(savedRating),
        summary,
      },
    });
  } catch (err) {
    if (txStarted) {
      try {
        await conn.rollback();
      } catch (_) {}
    }

    if (err?.code === "ER_DUP_ENTRY") {
      return badRequest(
        res,
        "A rating has already been submitted for this lesson session."
      );
    }

    logErr(`${actorLabel}.save`, err);
    return serverError(res);
  } finally {
    await releaseSessionRatingLock(conn, advisoryLockKey);
    conn.release();
  }
}

export async function getStudentLessonSessionRating(req, res) {
  return getRatingForContext(req, res, "student");
}

export async function upsertStudentLessonSessionRating(req, res) {
  return saveRatingForContext(req, res, "student");
}

export async function getParentLessonSessionRating(req, res) {
  return getRatingForContext(req, res, "parent");
}

export async function upsertParentLessonSessionRating(req, res) {
  return saveRatingForContext(req, res, "parent");
}
