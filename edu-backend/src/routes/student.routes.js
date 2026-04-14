// src/routes/student.routes.js
// ============================================================================
// Student Routes (PRODUCTION-READY / SESSION-ONLY)
// ============================================================================

import { Router } from "express";
import { requireStudentSession } from "../middlewares/student.js";
import { validateRequest } from "../middlewares/requestValidation.js";
import { ratingSubmitRateLimit } from "../middlewares/rateLimit.js";
import {
  validateLessonSessionRating,
  validateStudentLessonRequest,
} from "../validation/highRiskMutations.js";

import {
  getStudentDashboard,
  getStudentProfile,
  updateStudentAcademicScope,
  getStudentSubjects,
  getStudentSchedule,
  getStudentAttendance,
  getStudentHomework,
  getStudentQuizzes,
  getStudentGrades,
  getStudentAnnouncements,
  getStudentNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  selectTeacherForSubject,
  getMySelections,
  getStudentAvailableSubjects,
  updateStudentSubjects,
  getTeachersForSubject,
  getTeacherDetailsForStudent,
  studentGetTeacherAvailability,
  requestLessonSession,
  getMyPendingLessonRequests,
  cancelMyLessonRequest,
  cancelMyScheduledSession,
  getStudentLessonSessionRating,
  upsertStudentLessonSessionRating,
  getHomeworkDetail,
  getQuizDetail,
} from "../controllers/student.controller.js";

const router = Router();

/**
 * Session-only auth + student role check (combined middleware)
 * - Requires a real session cookie
 * - Blocks dev header impersonation
 */
router.use(requireStudentSession);

/* =============================================================================
 * Aggregated dashboard data
 * ============================================================================= */
router.get("/dashboard", getStudentDashboard);

/* =============================================================================
 * Profile
 * ============================================================================= */
router.get("/profile", getStudentProfile);
router.put("/scope", updateStudentAcademicScope);

/* =============================================================================
 * Subjects + teacher selections
 * ============================================================================= */
router.get("/subjects", getStudentSubjects);
router.get("/subjects/available", getStudentAvailableSubjects);
router.post("/subjects", updateStudentSubjects);

router.post("/select-teacher", selectTeacherForSubject);
router.get("/selections", getMySelections);

/* =============================================================================
 * Schedule & attendance
 * ============================================================================= */
router.get("/schedule", getStudentSchedule);
router.get("/attendance", getStudentAttendance);

/* =============================================================================
 * Homework / quizzes / grades
 * ============================================================================= */
router.get("/homework", getStudentHomework);
router.get("/homework/:id", getHomeworkDetail);

router.get("/quizzes", getStudentQuizzes);
router.get("/quizzes/:id", getQuizDetail);

router.get("/grades", getStudentGrades);

/* =============================================================================
 * Announcements
 * ============================================================================= */
router.get("/announcements", getStudentAnnouncements);

/* =============================================================================
 * Notifications
 * ============================================================================= */
router.get("/notifications", getStudentNotifications);
router.patch("/notifications/:id/read", markNotificationRead);
router.patch("/notifications/read-all", markAllNotificationsRead);

/* =============================================================================
 * Teachers
 * ============================================================================= */
router.get("/teachers", getTeachersForSubject);
router.get("/teachers/:teacherId", getTeacherDetailsForStudent);

/* =============================================================================
 * Teacher availability (schedule sharing)
 * ============================================================================= */
router.get("/teacher-availability", studentGetTeacherAvailability);

/* =============================================================================
 * Lesson requests
 * ============================================================================= */
router.post("/lessons/request", validateRequest(validateStudentLessonRequest), requestLessonSession);
router.post("/lessons/requests", validateRequest(validateStudentLessonRequest), requestLessonSession); // backward-compat alias
router.get("/lessons/requests/pending", getMyPendingLessonRequests);
router.post("/lessons/requests/:id/cancel", cancelMyLessonRequest);
router.post("/lessons/sessions/:id/cancel", cancelMyScheduledSession);
router.get("/lesson-sessions/:sessionId/rating", getStudentLessonSessionRating);
router.post(
  "/lesson-sessions/:sessionId/rating",
  ratingSubmitRateLimit,
  validateRequest(validateLessonSessionRating),
  upsertStudentLessonSessionRating
);

/* =============================================================================
 * Backward-compat aliases
 * ============================================================================= */
router.post("/dashboard/requestLessonSession", validateRequest(validateStudentLessonRequest), requestLessonSession);
router.get("/dashboard/getMyPendingLessonRequests", getMyPendingLessonRequests);
router.post("/dashboard/cancelMyLessonRequest/:id", cancelMyLessonRequest);

export default router;
