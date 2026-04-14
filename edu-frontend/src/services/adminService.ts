// src/services/adminService.ts
// ============================================================================
// Admin Service (DROP-IN REPLACEMENT) — Session-first (cookie auth)
// ----------------------------------------------------------------------------
// What this service guarantees:
// ✅ Every request uses the central apiFetch() wrapper (credentials: "include")
// ✅ No Authorization headers / no tokens (session-cookie auth only)
// ✅ Optional DEV impersonation header x-user-id (only when enabled)
// ✅ Consistent response unwrapping for backend shape: { success, message?, data? }
// ✅ No "any" (ESLint strict friendly)
// ✅ Fully commented & organized by domain
//
// Notes:
// - Authentication is established by /auth/login which sets a session cookie.
// - Admin endpoints must be called after login (cookie present).
// - localStorage["edu-user"] in this file is UI-only (optional) and NOT auth.
// ============================================================================

import { apiFetch, clearCsrfToken } from "@/src/lib/api";
import type { JsonValue, ApiFetchOptions } from "@/src/lib/api";

import {
  SubjectAdminRow,
  TeacherAdminRow,
  ParentRequestRow,
  StudentAdminRow,
  ParentAdminRow,
  ParentStudentLinkRow,
  TeacherAssignmentRow,
  TeacherScheduleRow,
  AnnouncementRow,
  AdminOverview,
  AdminSettings,
  AdminLessonSessionRow,
  NotificationApiResponse,
  ModeratorAdminRow,
} from "@/src/app/admin/dashboard/adminTypes";

// ---------------------------------------------------------------------------
// Generic API response type (matches your backend pattern)
// Many endpoints return: { success: true, data: ... } or { success:false, message }
// ---------------------------------------------------------------------------
type ApiResponse<T> = {
  success: boolean;
  message?: string;
  data?: T;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// "edu-user" types (UI display only; not used for auth)
// ---------------------------------------------------------------------------
export type EduUserRole = "admin" | "parent" | "student" | "teacher" | "moderator";

export type EduUser = {
  id: number;
  role: EduUserRole;
  fullName: string;
  email: string;
};
// ============================================================================
// ADMIN NOTIFICATIONS (inbox) types
// ============================================================================

export type AdminNotificationRow = {
  id: number;
  type: string;
  title: string;
  body: string | null;
  relatedType: string | null;
  relatedId: number | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
};

export type AdminNotificationsInbox = {
  unreadCount: number;
  items: AdminNotificationRow[];
};

// ---------------------------------------------------------------------------
// DEV FLAG: enable x-user-id header only when you explicitly turn it on
// Put this in .env.local ONLY for local dev impersonation:
//   NEXT_PUBLIC_DEV_X_USER_ID=1
// ---------------------------------------------------------------------------
const DEV_SEND_X_USER_ID =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_DEV_X_USER_ID === "1";

// ---------------------------------------------------------------------------
// LocalStorage helpers (UI only)
// ---------------------------------------------------------------------------
function setEduUser(user: EduUser): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("edu-user", JSON.stringify(user));
  } catch {
    // ignore
  }
}

function getEduUser(): EduUser | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem("edu-user");
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<EduUser> & { role?: string };

    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.id !== "number") return null;

    const roleStr = typeof parsed.role === "string" ? parsed.role.toLowerCase() : "student";
    const role: EduUserRole = (["admin", "parent", "student", "teacher", "moderator"].includes(roleStr)
      ? roleStr
      : "student") as EduUserRole;

    return {
      id: parsed.id,
      fullName: parsed.fullName ?? "",
      email: parsed.email ?? "",
      role,
    };
  } catch {
    return null;
  }
}

function clearEduUser(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem("edu-user");
  } catch {
    // ignore
  }
}

/**
 * DEV helper:
 * If NEXT_PUBLIC_DEV_X_USER_ID=1, we will send x-user-id using localStorage["edu-user"].id
 * This is ONLY for controlled local dev impersonation.
 */
function getDevUserIdFromLocalStorage(): number | null {
  if (!DEV_SEND_X_USER_ID) return null;
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem("edu-user");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: number };
    return typeof parsed?.id === "number" ? parsed.id : null;
  } catch {
    return null;
  }
}

/**
 * Builds headers for apiFetch.
 * We merge the caller headers + optional dev x-user-id header.
 */
function buildHeaders(options: ApiFetchOptions): HeadersInit | undefined {
  const devUserId = getDevUserIdFromLocalStorage();
  if (devUserId == null) return options.headers;

  // Merge without losing user-provided headers
  return {
    ...(options.headers || {}),
    "x-user-id": String(devUserId),
  };
}

// ---------------------------------------------------------------------------
// Response unwrapping helpers
// ---------------------------------------------------------------------------

/**
 * unwrapData<T>
 * For endpoints that return: { success:true, data: T }
 */
async function unwrapData<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const raw = await apiFetch<unknown>(path, {
    ...options,
    headers: buildHeaders(options),
  });
  if (!isRecord(raw) || raw.success !== true || !("data" in raw)) {
    throw new Error("Invalid API response shape.");
  }
  const res = raw as ApiResponse<T>;
  if (typeof res.data === "undefined") {
    throw new Error("Server error (missing data).");
  }

  return res.data;
}

/**
 * unwrapOk
 * For endpoints that return: { success:true } (no data)
 */
async function unwrapOk(path: string, options: ApiFetchOptions = {}): Promise<void> {
  const raw = await apiFetch<unknown>(path, {
    ...options,
    headers: buildHeaders(options),
  });
  if (!isRecord(raw) || typeof raw.success !== "boolean") {
    throw new Error("Invalid API response shape.");
  }
  const res = raw as ApiResponse<unknown>;
  if (!res.success) {
    throw new Error(res.message || "Server error.");
  }
}

// ---------------------------------------------------------------------------
// AUTH HELPERS
// ---------------------------------------------------------------------------
// We do NOT provide login here: login is done by /auth/login which sets session cookie.
// Here we provide logout + UI helpers.
async function logout(): Promise<void> {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    // ignore: we still clear local UI state below
  } finally {
    clearCsrfToken();
    clearEduUser();
  }
}

// ============================================================================
// SUBJECTS
// ============================================================================
async function getSubjects(): Promise<SubjectAdminRow[]> {
  return unwrapData("/admin/subjects");
}

async function createSubject(input: {
  name_ar: string;
  name_en: string;
  sort_order?: number;
  is_active?: 0 | 1 | boolean;
}): Promise<void> {
  await unwrapOk("/admin/subjects", { method: "POST", json: input });
}

async function updateSubject(
  id: number,
  input: { name_ar?: string; name_en?: string; sort_order?: number; is_active?: 0 | 1 | boolean }
): Promise<void> {
  await unwrapOk(`/admin/subjects/${id}`, { method: "PUT", json: input });
}

async function deleteSubject(id: number): Promise<void> {
  await unwrapOk(`/admin/subjects/${id}`, { method: "DELETE" });
}

// ============================================================================
// TEACHERS
// ============================================================================
async function getTeachers(): Promise<TeacherAdminRow[]> {
  return unwrapData("/admin/teachers");
}

async function createTeacher(input: {
  name: string;
  bio_short?: string | null;
  gender?: string | null;
  photo_url?: string | null;
  is_active?: 0 | 1 | boolean;
}): Promise<void> {
  await unwrapOk("/admin/teachers", { method: "POST", json: input });
}

async function assignTeacherToSubject(input: {
  teacherId: number;
  subjectId: number;
  priority?: number;
}): Promise<void> {
  await unwrapOk(`/admin/teachers/${encodeURIComponent(String(input.teacherId))}/assign`, {
    method: "POST",
    json: { subjectId: input.subjectId, priority: input.priority ?? 0 },
  });
}

async function updateTeacher(
  id: number,
  input: Partial<{
    name: string;
    bio_short: string | null;
    gender: string | null;
    photo_url: string | null;
    is_active: 0 | 1 | boolean;
  }>
): Promise<void> {
  await unwrapOk(`/admin/teachers/${id}`, { method: "PUT", json: input });
}

// ============================================================================
// TEACHER ONBOARDING / APPROVAL
// ============================================================================
async function getPendingTeachers(): Promise<TeacherAdminRow[]> {
  return unwrapData("/admin/teachers/pending");
}

async function approveTeacher(id: number, approval_notes?: string): Promise<void> {
await unwrapOk(`/admin/teachers/${id}/approve`, {
  method: "POST",
  // ✅ Only include approval_notes if it's a real string
  json: approval_notes ? { approval_notes } : {},
});
}

async function rejectTeacher(id: number, approval_notes?: string): Promise<void> {
 await unwrapOk(`/admin/teachers/${id}/reject`, {
  method: "POST",
  json: approval_notes ? { approval_notes } : {},
});

}

async function updateTeacherCapacity(id: number, max_capacity: number): Promise<void> {
  await unwrapOk(`/admin/teachers/${id}/capacity`, { method: "PUT", json: { max_capacity } });
}

// ============================================================================
// STUDENT–TEACHER ASSIGNMENTS
// ============================================================================
async function getTeacherAssignments(): Promise<TeacherAssignmentRow[]> {
  return unwrapData("/admin/teacher-assignments");
}

async function reassignStudentTeacher(input: {
  student_id: number;
  subject_id: number;
  to_teacher_id: number;
}): Promise<void> {
  await unwrapOk("/admin/teacher-assignments/reassign", { method: "POST", json: input });
}

// ============================================================================
// PARENT CHANGE REQUESTS
// ============================================================================
async function getParentRequests(): Promise<ParentRequestRow[]> {
  return unwrapData("/admin/parent-requests");
}

async function approveParentRequest(id: number): Promise<void> {
  await unwrapOk(`/admin/parent-requests/${id}/approve`, { method: "POST", json: {} });
}

async function rejectParentRequest(id: number): Promise<void> {
  await unwrapOk(`/admin/parent-requests/${id}/reject`, { method: "POST", json: {} });
}

// ============================================================================
// USERS: STUDENTS & PARENTS
// ============================================================================
async function getStudents(): Promise<StudentAdminRow[]> {
  return unwrapData("/admin/students");
}

async function getParents(): Promise<ParentAdminRow[]> {
  return unwrapData("/admin/parents");
}

async function toggleUserActive(userId: number, isActive: boolean): Promise<void> {
  await unwrapOk(`/admin/users/${userId}/activate`, {
    method: "PUT",
    json: { is_active: isActive ? 1 : 0 },
  });
}

// ============================================================================
// PARENT ↔ STUDENT LINKS
// ============================================================================
async function getParentStudentLinks(): Promise<ParentStudentLinkRow[]> {
  return unwrapData("/admin/parent-student-links");
}

async function createParentStudentLink(input: {
  parent_id: number;
  student_id: number;
  relationship: "mother" | "father" | "guardian";
}): Promise<void> {
  await unwrapOk("/admin/parent-student-links", { method: "POST", json: input });
}

async function deleteParentStudentLink(id: number): Promise<void> {
  await unwrapOk(`/admin/parent-student-links/${id}`, { method: "DELETE" });
}

// ============================================================================
// TIMETABLE / SCHEDULES
// ============================================================================
async function getTeacherSchedules(): Promise<TeacherScheduleRow[]> {
  return unwrapData("/admin/schedules");
}

async function createTeacherSchedule(input: {
  teacher_id: number;
  weekday: number;
  start_time: string;
  end_time: string;
  is_group?: boolean;
  max_students?: number | null;
}): Promise<void> {
  await unwrapOk("/admin/schedules", {
    method: "POST",
    json: { ...input, is_group: input.is_group ? 1 : 0 },
  });
}
async function updateTeacherSchedule(
  id: number,
  input: Partial<{
    weekday: number;
    start_time: string;
    end_time: string;
    is_group: boolean;
    max_students: number | null;
  }>
): Promise<void> {
  // ✅ Build a JSON-safe payload (no undefined, no unknown)
  const normalized: Record<string, JsonValue> = {};

  if (typeof input.weekday === "number") normalized.weekday = input.weekday;
  if (typeof input.start_time === "string") normalized.start_time = input.start_time;
  if (typeof input.end_time === "string") normalized.end_time = input.end_time;

  if (typeof input.max_students === "number" || input.max_students === null) {
    normalized.max_students = input.max_students;
  }

  if (typeof input.is_group === "boolean") {
    normalized.is_group = input.is_group ? 1 : 0;
  }

  await unwrapOk(`/admin/schedules/${id}`, { method: "PUT", json: normalized });
}

async function deleteTeacherSchedule(id: number): Promise<void> {
  await unwrapOk(`/admin/schedules/${id}`, { method: "DELETE" });
}

// ============================================================================
// ADMIN LESSON SESSIONS
// ============================================================================
async function getAdminLessonSessions(): Promise<AdminLessonSessionRow[]> {
  return unwrapData("/admin/lesson-sessions?limit=100&offset=0");
}

async function getPendingLessonRequests(): Promise<unknown[]> {
  return unwrapData("/admin/lesson-requests/pending?limit=100&offset=0");
}

async function approveLessonRequest(id: number): Promise<void> {
  await unwrapOk(`/admin/lesson-requests/${id}/approve`, {
    method: "POST",
    json: {},
  });
}

async function cancelLessonSession(id: number, reason?: string): Promise<void> {
  await unwrapOk(`/admin/lessons/${id}/cancel`, {
    method: "POST",
    json: { reason: reason ?? null },
  });
}

// ============================================================================
// ANNOUNCEMENTS
// ============================================================================
async function getAnnouncements(): Promise<AnnouncementRow[]> {
  return unwrapData("/admin/announcements?limit=50&offset=0");
}

async function createAnnouncement(input: {
  title: string;
  body: string;
  audience?: "all" | "students" | "parents" | "teachers";
}): Promise<void> {
  await unwrapOk("/admin/announcements", { method: "POST", json: input });
}
// ============================================================================
// ADMIN NOTIFICATIONS
// ============================================================================

async function getAdminNotifications(): Promise<NotificationApiResponse> {
  // unwrapData may return either:
  // - NotificationRow[]
  // - { unreadCount, items }
  return unwrapData<NotificationApiResponse>("/admin/notifications");
}
async function markAdminNotificationRead(id: number): Promise<void> {
  await unwrapOk(`/admin/notifications/${id}/read`, { method: "PATCH" });
}

async function markAllAdminNotificationsRead(): Promise<void> {
  await unwrapOk("/admin/notifications/read-all", { method: "PATCH" });
}

// ============================================================================
// OVERVIEW
// ============================================================================
async function getAdminOverview(): Promise<AdminOverview> {
  return unwrapData("/admin/overview");
}

// ============================================================================
// SETTINGS
// ============================================================================
async function getAdminSettings(): Promise<AdminSettings> {
  return unwrapData("/admin/settings");
}

async function updateAdminSettings(input: Partial<AdminSettings>): Promise<AdminSettings> {
  return unwrapData("/admin/settings", { method: "PUT", json: input });
}

// ============================================================================
// MODERATORS
// ============================================================================
async function getModerators(): Promise<ModeratorAdminRow[]> {
  return unwrapData<ModeratorAdminRow[]>("/admin/moderators");
}

async function createModerator(input: {
  full_name: string;
  email: string;
  password: string;
}): Promise<{ id: number; full_name: string; email: string }> {
  return unwrapData("/admin/moderators", { method: "POST", json: input });
}

// ============================================================================
// Export
// ============================================================================
const adminService = {
  // auth + UI helpers
  logout,
  getEduUser,
  clearEduUser,
  setEduUser,

  // subjects
  getSubjects,
  createSubject,
  updateSubject,
  deleteSubject,

  // teachers
  getTeachers,
  createTeacher,
  assignTeacherToSubject,
  updateTeacher,
  getPendingTeachers,
  approveTeacher,
  rejectTeacher,
  updateTeacherCapacity,

  // assignments
  getTeacherAssignments,
  reassignStudentTeacher,

  // parent requests
  getParentRequests,
  approveParentRequest,
  rejectParentRequest,

  // users
  getStudents,
  getParents,
  toggleUserActive,

  // links
  getParentStudentLinks,
  createParentStudentLink,
  deleteParentStudentLink,

  // schedules
  getTeacherSchedules,
  createTeacherSchedule,
  updateTeacherSchedule,
  deleteTeacherSchedule,

  // lesson sessions / requests
  getAdminLessonSessions,
  getPendingLessonRequests,
  approveLessonRequest,
  cancelLessonSession,

  // announcements
  getAnnouncements,
  createAnnouncement,
    // admin notifications
  getAdminNotifications,
  markAdminNotificationRead,
  markAllAdminNotificationsRead,

  // overview
  getAdminOverview,

  // settings
  getAdminSettings,
  updateAdminSettings,

  // moderators
  getModerators,
  createModerator,
};

export default adminService;
