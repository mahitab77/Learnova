function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isValidEmail(value) {
  if (!hasText(value)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

function toPositiveInt(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function requirePositiveId(value, field, errors) {
  if (toPositiveInt(value) == null) {
    errors.push({ field, message: `${field} must be a positive integer.` });
  }
}

export function validateAuthLogin({ body }) {
  const errors = [];
  if (!hasText(body.email)) errors.push({ field: "email", message: "email is required." });
  if (!hasText(body.password)) errors.push({ field: "password", message: "password is required." });
  return { errors };
}

export function validateAuthRequestReset({ body }) {
  const errors = [];
  if (!hasText(body.email)) errors.push({ field: "email", message: "email is required." });
  return { errors };
}

export function validateAuthVerifyReset({ body }) {
  const errors = [];
  if (!hasText(body.email)) errors.push({ field: "email", message: "email is required." });
  if (!hasText(body.otp)) errors.push({ field: "otp", message: "otp is required." });
  if (!hasText(body.newPassword)) {
    errors.push({ field: "newPassword", message: "newPassword is required." });
  }
  return { errors };
}

export function validateAuthRegisterStudent({ body }) {
  const errors = [];
  if (!hasText(body.fullName)) errors.push({ field: "fullName", message: "fullName is required." });
  if (!hasText(body.email)) errors.push({ field: "email", message: "email is required." });
  else if (!isValidEmail(body.email)) errors.push({ field: "email", message: "email must be valid." });
  if (!hasText(body.password)) errors.push({ field: "password", message: "password is required." });

  requirePositiveId(body.systemId, "systemId", errors);
  requirePositiveId(body.stageId, "stageId", errors);

  if (body.gradeLevelId !== undefined && body.gradeLevelId !== null && body.gradeLevelId !== "") {
    requirePositiveId(body.gradeLevelId, "gradeLevelId", errors);
  }

  if (
    body.preferredLang !== undefined &&
    body.preferredLang !== null &&
    body.preferredLang !== "" &&
    !["en", "ar"].includes(String(body.preferredLang))
  ) {
    errors.push({ field: "preferredLang", message: "preferredLang must be either 'en' or 'ar'." });
  }

  return { errors };
}

export function validateAuthRegisterTeacher({ body }) {
  const errors = [];
  const payload = typeof body.payload === "string" ? (() => {
    try {
      return JSON.parse(body.payload);
    } catch {
      return null;
    }
  })() : body;

  if (!payload || typeof payload !== "object") {
    errors.push({ field: "payload", message: "payload must be a valid object." });
    return { errors };
  }

  if (!hasText(payload.fullName)) errors.push({ field: "fullName", message: "fullName is required." });
  if (!hasText(payload.email)) errors.push({ field: "email", message: "email is required." });
  if (!hasText(payload.password)) errors.push({ field: "password", message: "password is required." });
  return { errors };
}

export function validateAuthRegisterParent({ body }) {
  const errors = [];
  if (!isRecord(body.parent)) {
    errors.push({ field: "parent", message: "parent object is required." });
  } else {
    if (!hasText(body.parent.fullName)) {
      errors.push({ field: "parent.fullName", message: "parent.fullName is required." });
    }
    if (!hasText(body.parent.email)) {
      errors.push({ field: "parent.email", message: "parent.email is required." });
    } else if (!isValidEmail(body.parent.email)) {
      errors.push({ field: "parent.email", message: "parent.email must be valid." });
    }
    if (!hasText(body.parent.password)) {
      errors.push({ field: "parent.password", message: "parent.password is required." });
    }
  }

  if (!Array.isArray(body.children) || body.children.length === 0) {
    errors.push({ field: "children", message: "children must be a non-empty array." });
    return { errors };
  }

  const contactOption = body.contactOption;
  if (
    contactOption !== undefined &&
    contactOption !== null &&
    !["parent", "individual"].includes(String(contactOption))
  ) {
    errors.push({
      field: "contactOption",
      message: "contactOption must be either 'parent' or 'individual'.",
    });
  }
  const requiresIndividualChildCredentials = String(contactOption || "parent") === "individual";

  body.children.forEach((child, idx) => {
    const base = `children[${idx}]`;
    if (!isRecord(child)) {
      errors.push({ field: base, message: `${base} must be an object.` });
      return;
    }

    if (!hasText(child.fullName)) {
      errors.push({ field: `${base}.fullName`, message: `${base}.fullName is required.` });
    }

    requirePositiveId(child.systemId, `${base}.systemId`, errors);
    requirePositiveId(child.stageId, `${base}.stageId`, errors);

    if (child.gradeLevelId !== undefined && child.gradeLevelId !== null && child.gradeLevelId !== "") {
      requirePositiveId(child.gradeLevelId, `${base}.gradeLevelId`, errors);
    }

    if (requiresIndividualChildCredentials) {
      if (!hasText(child.email)) {
        errors.push({ field: `${base}.email`, message: `${base}.email is required.` });
      } else if (!isValidEmail(child.email)) {
        errors.push({ field: `${base}.email`, message: `${base}.email must be valid.` });
      }
      if (!hasText(child.password)) {
        errors.push({ field: `${base}.password`, message: `${base}.password is required.` });
      }
    } else if (child.email !== undefined && child.email !== null && child.email !== "") {
      if (!isValidEmail(child.email)) {
        errors.push({ field: `${base}.email`, message: `${base}.email must be valid.` });
      }
    }

    if (
      child.relationship !== undefined &&
      child.relationship !== null &&
      child.relationship !== "" &&
      !["mother", "father", "guardian"].includes(String(child.relationship))
    ) {
      errors.push({
        field: `${base}.relationship`,
        message: `${base}.relationship must be one of: mother, father, guardian.`,
      });
    }

    if (
      child.gender !== undefined &&
      child.gender !== null &&
      child.gender !== "" &&
      !["male", "female"].includes(String(child.gender))
    ) {
      errors.push({ field: `${base}.gender`, message: `${base}.gender must be either 'male' or 'female'.` });
    }

    if (
      child.preferredLang !== undefined &&
      child.preferredLang !== null &&
      child.preferredLang !== "" &&
      !["en", "ar"].includes(String(child.preferredLang))
    ) {
      errors.push({
        field: `${base}.preferredLang`,
        message: `${base}.preferredLang must be either 'en' or 'ar'.`,
      });
    }

    if (child.subjectIds !== undefined && child.subjectIds !== null) {
      if (!Array.isArray(child.subjectIds)) {
        errors.push({ field: `${base}.subjectIds`, message: `${base}.subjectIds must be an array.` });
      } else {
        child.subjectIds.forEach((subjectId, sIdx) => {
          if (toPositiveInt(subjectId) == null) {
            errors.push({
              field: `${base}.subjectIds[${sIdx}]`,
              message: `${base}.subjectIds[${sIdx}] must be a positive integer.`,
            });
          }
        });
      }
    }
  });

  return { errors };
}

export function validateParentTeacherChange({ body }) {
  const errors = [];
  const studentId = body.student_id ?? body.studentId;
  const subjectId = body.subject_id ?? body.subjectId;
  const currentTeacherId = body.teacher_id ?? body.teacherId ?? body.currentTeacherId;
  const requestedTeacherId = body.requested_teacher_id ?? body.requestedTeacherId ?? body.newTeacherId;

  requirePositiveId(studentId, "studentId", errors);
  requirePositiveId(subjectId, "subjectId", errors);

  if (currentTeacherId != null && toPositiveInt(currentTeacherId) == null) {
    errors.push({ field: "currentTeacherId", message: "currentTeacherId must be a positive integer." });
  }
  if (requestedTeacherId != null && toPositiveInt(requestedTeacherId) == null) {
    errors.push({ field: "requestedTeacherId", message: "requestedTeacherId must be a positive integer." });
  }
  return { errors };
}

export function validateStudentLessonRequest({ body }) {
  const errors = [];
  requirePositiveId(body.teacherId, "teacherId", errors);
  requirePositiveId(body.subjectId, "subjectId", errors);
  requirePositiveId(body.scheduleId, "scheduleId", errors);
  if (!hasText(body.startsAt)) errors.push({ field: "startsAt", message: "startsAt is required." });
  if (!hasText(body.endsAt)) errors.push({ field: "endsAt", message: "endsAt is required." });
  return { errors };
}

export function validateLessonSessionRating({ params, body }) {
  const errors = [];
  requirePositiveId(params.sessionId, "sessionId", errors);

  const stars = Number(body?.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    errors.push({
      field: "stars",
      message: "stars must be an integer between 1 and 5.",
    });
  }

  const comment = body?.comment;
  if (comment !== undefined && comment !== null && typeof comment !== "string") {
    errors.push({
      field: "comment",
      message: "comment must be a string when provided.",
    });
  } else if (typeof comment === "string" && comment.length > 1000) {
    errors.push({
      field: "comment",
      message: "comment must not exceed 1000 characters.",
    });
  }

  return { errors };
}

function validateScheduleShape(body, errors, allowPartial) {
  if (!allowPartial || body.weekday !== undefined) {
    if (toPositiveInt(body.weekday) == null) {
      errors.push({ field: "weekday", message: "weekday must be a positive integer." });
    }
  }

  if (!allowPartial || body.start_time !== undefined || body.startTime !== undefined) {
    const start = body.start_time ?? body.startTime;
    if (!hasText(start)) errors.push({ field: "start_time", message: "start_time is required." });
  }

  if (!allowPartial || body.end_time !== undefined || body.endTime !== undefined) {
    const end = body.end_time ?? body.endTime;
    if (!hasText(end)) errors.push({ field: "end_time", message: "end_time is required." });
  }
}

export function validateTeacherCreateSchedule({ body }) {
  const errors = [];
  validateScheduleShape(body, errors, false);
  return { errors };
}

export function validateTeacherUpdateSchedule({ body, params }) {
  const errors = [];
  requirePositiveId(params.scheduleId ?? body.schedule_id, "scheduleId", errors);
  validateScheduleShape(body, errors, true);
  return { errors };
}

export function validateAdminApproveLesson({ params }) {
  const errors = [];
  requirePositiveId(params.id, "id", errors);
  return { errors };
}

export function validateAdminCancelLesson({ params, body }) {
  const errors = [];
  requirePositiveId(params.id, "id", errors);
  if (body.reason != null && typeof body.reason !== "string") {
    errors.push({ field: "reason", message: "reason must be a string when provided." });
  }
  return { errors };
}

export function validateAdminIdParam({ params }) {
  const errors = [];
  requirePositiveId(params.id, "id", errors);
  return { errors };
}

export function validateAdminTeacherAssign({ params, body }) {
  const errors = [];
  requirePositiveId(params.teacherId, "teacherId", errors);
  requirePositiveId(body.subjectId, "subjectId", errors);
  if (body.priority != null && !Number.isFinite(Number(body.priority))) {
    errors.push({ field: "priority", message: "priority must be a number when provided." });
  }
  return { errors };
}

export function validateAdminUserActivation({ params, body }) {
  const errors = [];
  requirePositiveId(params.id, "id", errors);
  if (body.is_active != null && ![0, 1, true, false].includes(body.is_active)) {
    errors.push({
      field: "is_active",
      message: "is_active must be one of: 0, 1, true, false.",
    });
  }
  return { errors };
}

export function validateAdminCreateParentStudentLink({ body }) {
  const errors = [];
  requirePositiveId(body.parent_id, "parent_id", errors);
  requirePositiveId(body.student_id, "student_id", errors);
  if (
    body.relationship != null &&
    !["mother", "father", "guardian"].includes(String(body.relationship))
  ) {
    errors.push({
      field: "relationship",
      message: "relationship must be one of: mother, father, guardian.",
    });
  }
  return { errors };
}

export function validateAdminReassignTeacher({ body }) {
  const errors = [];
  requirePositiveId(body.student_id, "student_id", errors);
  requirePositiveId(body.subject_id, "subject_id", errors);
  requirePositiveId(body.to_teacher_id, "to_teacher_id", errors);
  return { errors };
}

export function validateAdminCreateSchedule({ body }) {
  const errors = [];
  requirePositiveId(body.teacher_id, "teacher_id", errors);
  requirePositiveId(body.weekday, "weekday", errors);
  if (!hasText(body.start_time)) {
    errors.push({ field: "start_time", message: "start_time is required." });
  }
  if (!hasText(body.end_time)) {
    errors.push({ field: "end_time", message: "end_time is required." });
  }
  return { errors };
}

export function validateAdminUpdateSchedule({ params, body }) {
  const errors = [];
  requirePositiveId(params.id, "id", errors);
  if (
    body.weekday != null &&
    toPositiveInt(body.weekday) == null
  ) {
    errors.push({ field: "weekday", message: "weekday must be a positive integer." });
  }
  if (
    body.start_time != null &&
    !hasText(body.start_time)
  ) {
    errors.push({ field: "start_time", message: "start_time must be a non-empty string." });
  }
  if (
    body.end_time != null &&
    !hasText(body.end_time)
  ) {
    errors.push({ field: "end_time", message: "end_time must be a non-empty string." });
  }
  return { errors };
}
