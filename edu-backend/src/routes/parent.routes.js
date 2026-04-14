// src/routes/parent.routes.js
import express from "express";
import { requireSessionUser } from "../middlewares/auth.js";
import { validateRequest } from "../middlewares/requestValidation.js";
import { validateParentTeacherChange } from "../validation/highRiskMutations.js";

import {
  ensureParentProfile,
  getMyStudents,
  getStudentSelectionsAsParent,

  // Requests
  createChangeRequest,
  createParentRequest,
  getParentRequests,

  // Assignments
  getParentAssignments,

  // Teacher selection
  getParentTeacherOptions,
  selectParentTeacherOption,
  getParentLessonSessionRating,
  upsertParentLessonSessionRating,

  // Session switch
  switchToStudent,
  switchBackToParent,
    // Announcements + Notifications
  getParentAnnouncements,
  getParentNotifications,
  markParentNotificationRead,
  markAllParentNotificationsRead,

} from "../controllers/parent.controller.js";

const router = express.Router();

/**
 * -----------------------------------------------------------------------------
 * Parent Routes - Auth policy
 * -----------------------------------------------------------------------------
 * Tier B (HIGH RISK): session-only switching
 * Tier A (General): session-only parent operations
 * -----------------------------------------------------------------------------
 */

/* =============================================================================
 * Tier B: REAL/PROD session-only identity switching (HIGH RISK)
 * -----------------------------------------------------------------------------
 * These routes MUST NOT allow x-user-id fallback.
 * Put them FIRST so they never run requireUser (dev header) at all.
 * ============================================================================= */
router.post("/switch-to-student", requireSessionUser, switchToStudent);
router.post("/switch-back", requireSessionUser, switchBackToParent);

/* =============================================================================
 * Tier A: General parent endpoints (session-only)
 * ============================================================================= */
router.use(requireSessionUser);

// DEV/utility: ensure parents row exists
router.post("/ensure-profile", ensureParentProfile);

// Parent ↔ student management
router.get("/students", getMyStudents);

// Student selections (subjects + chosen teachers)
router.get("/student/:studentId/selections", getStudentSelectionsAsParent);

// Legacy change request (backward compatibility)
router.post("/request-change", validateRequest(validateParentTeacherChange), createChangeRequest);

// New requests endpoint (v2 UI)
router.post("/requests", validateRequest(validateParentTeacherChange), createParentRequest);
router.get("/requests", getParentRequests);

// Assignments (homeworks + quizzes merged)
router.get("/assignments", getParentAssignments);

// Teacher options + choose teacher flow
router.get("/teacher-options", getParentTeacherOptions);
router.post("/teacher-options/select", selectParentTeacherOption);
router.get("/lesson-sessions/:sessionId/rating", getParentLessonSessionRating);
router.post("/lesson-sessions/:sessionId/rating", upsertParentLessonSessionRating);

// Announcements (parents)
router.get("/announcements", getParentAnnouncements);

// Notifications (parents inbox)
router.get("/notifications", getParentNotifications);
router.patch("/notifications/:id/read", markParentNotificationRead);
router.patch("/notifications/read-all", markAllParentNotificationsRead);

export default router;
