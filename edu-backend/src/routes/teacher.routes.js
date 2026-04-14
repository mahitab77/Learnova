// src/routes/teacher.routes.js
// ============================================================================
// Teacher Routes (PRODUCTION-READY / SESSION-ONLY) — ESM (DROP-IN)
// ----------------------------------------------------------------------------
// ✅ Session-only auth + teacher role check via requireTeacherSession
// ✅ Keeps your existing endpoints unchanged
// ✅ Default export preserved
// ============================================================================

import { Router } from "express";
import * as teacherController from "../controllers/teacher.controller.js";
import { validateRequest } from "../middlewares/requestValidation.js";
import {
  validateTeacherCreateSchedule,
  validateTeacherUpdateSchedule,
} from "../validation/highRiskMutations.js";

// Strict session-only + role check (combined)
import {
  requireTeacherApproved,
  requireTeacherSession,
} from "../middlewares/teacher.js";

const router = Router();

/**
 * 🔒 Production Security Policy (Teacher)
 * - Requires a real session cookie
 * - Blocks dev header impersonation
 * - Enforces role === "teacher"
 */
router.use(requireTeacherSession);

/**
 * Live teaching operations require a second-level approval check.
 * Setup/profile routes remain session-only so pending teachers can finish setup.
 */
router.use("/lesson-sessions", requireTeacherApproved);
router.use("/lesson-requests", requireTeacherApproved);
router.use("/homework", requireTeacherApproved);
router.use("/quizzes", requireTeacherApproved);
router.use("/students", requireTeacherApproved);
router.use("/schedules", requireTeacherApproved);
router.use("/schedule-exceptions", requireTeacherApproved);

// ============================================================================
// Profile
// ============================================================================
router.get("/me", teacherController.getMyProfile);
router.put("/me", teacherController.updateMyProfile);

// ============================================================================
// Subjects / Grade Levels
// ============================================================================
router.get("/subjects", teacherController.getMySubjects);
router.put("/subjects", teacherController.setMySubjects);

router.get("/grade-levels", teacherController.getMyGradeLevels);
router.put("/grade-levels", teacherController.setMyGradeLevels);

// ============================================================================
// Videos
// ============================================================================
router.get("/videos", teacherController.listMyVideos);
router.post("/videos", teacherController.addMyVideo);
router.patch("/videos/:videoId/primary", teacherController.setPrimaryVideo);
router.delete("/videos/:videoId", teacherController.deleteMyVideo);

// ============================================================================
// Schedules (slots)
// ============================================================================
router.get("/schedules", teacherController.listMySchedules);
router.post("/schedules", validateRequest(validateTeacherCreateSchedule), teacherController.createScheduleSlot);
router.put(
  "/schedules/:scheduleId",
  validateRequest(validateTeacherUpdateSchedule),
  teacherController.updateScheduleSlot
);
router.delete("/schedules/:scheduleId", teacherController.deleteScheduleSlot);

// ============================================================================
// Schedule Offerings
// ============================================================================
router.get("/schedules/offerings", teacherController.listMySlotOfferings);
router.put("/schedules/:scheduleId/offerings", teacherController.setScheduleSlotOfferings);

// ============================================================================
// Schedule Exceptions
// ============================================================================
router.get("/schedule-exceptions", teacherController.listMyScheduleExceptions);
router.post("/schedule-exceptions", teacherController.createScheduleException);
router.put("/schedule-exceptions/:exceptionId", teacherController.updateScheduleException);
router.delete("/schedule-exceptions/:exceptionId", teacherController.deleteScheduleException);

// ============================================================================
// Lesson Sessions
// ============================================================================
router.get("/lesson-sessions", teacherController.listMyLessonSessions);
router.get("/lesson-sessions/:sessionId", teacherController.getLessonSessionDetails);
router.post("/lesson-sessions/:sessionId/cancel", teacherController.cancelMyLessonSession);

router.patch("/lesson-sessions/:sessionId/attendance", teacherController.updateStudentAttendance);

// ============================================================================
// Lesson Requests (Teacher approval flow)
// ============================================================================
router.get("/lesson-requests/pending", teacherController.listMyPendingLessonRequests);
router.post("/lesson-requests/:id/approve", teacherController.approveLessonRequest);
router.post("/lesson-requests/:id/reject", teacherController.rejectLessonRequest);

// ============================================================================
// Homework
// ============================================================================
router.get("/homework", teacherController.listMyHomework);
router.post("/homework", teacherController.createHomework);
router.put("/homework/:homeworkId", teacherController.updateHomework);

router.get("/homework/:homeworkId/submissions", teacherController.listHomeworkSubmissions);
router.patch("/homework/submissions/:submissionId/grade", teacherController.gradeHomeworkSubmission);

// ============================================================================
// Quizzes
// ============================================================================
router.get("/quizzes", teacherController.listMyQuizzes);
router.post("/quizzes", teacherController.createQuiz);
router.put("/quizzes/:quizId", teacherController.updateQuiz);

router.get("/quizzes/:quizId/submissions", teacherController.listQuizSubmissions);
router.patch("/quizzes/submissions/:submissionId/grade", teacherController.gradeQuizSubmission);

// ============================================================================
// Students
// ============================================================================
router.get("/students", teacherController.listMyStudents);
// ============================================================================
// Announcements
// ============================================================================
router.get("/announcements", teacherController.getTeacherAnnouncements);

// ============================================================================
// Notifications
// ============================================================================
router.get("/notifications", teacherController.getTeacherNotifications);
router.patch("/notifications/:id/read", teacherController.markTeacherNotificationRead);
router.patch("/notifications/read-all", teacherController.markAllTeacherNotificationsRead);

export default router;
