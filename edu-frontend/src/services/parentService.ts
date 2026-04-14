// src/services/parentService.ts
import { apiFetch as sharedApiFetch, clearCsrfToken, type ApiError } from "@/src/lib/api";
// ============================================================================
// Parent Service (SESSION-COOKIE AUTH) — DROP-IN (NO any)
// ----------------------------------------------------------------------------
// ✅ Cookie-based sessions: credentials: "include" on EVERY request
// ✅ Matches backend routes in src/routes/parent.routes.js
// ✅ Graceful errors: returns { success:false, message } instead of throwing
// ✅ Zero `any` usage (eslint-safe)
// ✅ FIXED: RequestInit.body `null` typing + no-unused-vars warnings
// ============================================================================

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export type ApiResult<T> = {
  success: boolean;
  message?: string;
  code?: string;
  data?: T;
};

export type ParentStudentRow = {
  link_id: number;
  student_id: number;
  student_name: string;
  grade_stage: string | number | null;
  grade_number: string | number | null;
  relationship: string | null;
  has_own_login: number | boolean | null;
  student_user_id: number | null;
};

export type StudentSelectionRow = {
  id: number;
  subject_id: number;
  subject_name_ar: string;
  subject_name_en: string;
  teacher_id: number | null;
  teacher_name: string;
  photo_url: string | null;
};

export type ParentRequestPayload = {
  // backend accepts both camelCase and snake_case
  studentId?: number;
  student_id?: number;

  subjectId?: number;
  subject_id?: number;

  // CURRENT teacher (existing)
  teacherId?: number | null;
  teacher_id?: number | null;
  currentTeacherId?: number | null;

  // ✅ NEW: REQUESTED teacher (what parent wants next)
  requestedTeacherId?: number | null;
  requested_teacher_id?: number | null;
  newTeacherId?: number | null;

  selectionId?: number | null;
  selection_id?: number | null;

  requestType?: string | null;
  type?: string | null;

  reason?: string | null;
  reason_text?: string | null;
};

export type ParentRequestRow = {
  id: number;

  student_id: number;
  student_name: string;

  subject_id: number | null;
  subject_name_ar: string | null;
  subject_name_en: string | null;

  current_teacher_id: number | null;
  current_teacher_name: string | null;

  requested_teacher_id: number | null;
  requested_teacher_name: string | null;

  status: "pending" | "approved" | "rejected" | string;
  reason: string | null;
  created_at: string;
};

export type ParentAssignmentRow = {
  id: number;
  student_id: number;
  student_name: string;
  subject_name_ar: string | null;
  subject_name_en: string | null;
  type: "homework" | "quiz" | string;
  title: string;
  score: number | null;
  max_score: number | null;
  submitted_at: string | null;
  due_at: string | null;
};

export type TeacherOptionRow = {
  teacher_id: number;
  teacher_full_name: string;
  bio: string | null;
  photo_url: string | null;
  demo_video_url: string | null;
  years_experience: number | null;
  rating: number | null;
};

export type SwitchToStudentResponse = {
  as: "student";
  student_user_id: number;
  student_id: number;
};

export type SwitchBackResponse = {
  as: "parent";
};

export type AnnouncementRow = {
  id: number;
  title: string;
  body: string;
  audience: string;
  createdAt: string; // note: backend maps created_at -> createdAt
};

export type ParentNotificationsResponse = {
  unreadCount: number;
  items: Array<{
    id: number;
    type: string;
    title: string;
    body: string;
    relatedType: string | null;
    relatedId: number | null;
    isRead: boolean;
    readAt: string | null;
    createdAt: string | null;
  }>;
};

export type ParentSessionRatingData = {
  canRate: boolean;
  editableUntil: string | null;
  rating: {
    stars: number;
    comment: string | null;
  } | null;
};

export type ParentSaveSessionRatingData = {
  rating: {
    stars: number;
    comment: string | null;
  };
  summary: {
    ratingAvg: number | null;
    ratingCount: number;
  };
};

// ----------------------------------------------------------------------------
// URL base
// ----------------------------------------------------------------------------

const PARENT_BASE = "/parent";

// ---------------------------------------------------------------------------
// CSRF token cache (mirrors lib/api.ts — independent because this service
// may be bundled separately and uses its own fetch helper)
// ---------------------------------------------------------------------------
/** Call on logout to reset the cached token. */
export function clearParentCsrfToken(): void {
  clearCsrfToken();
}

// ----------------------------------------------------------------------------
// Safe JSON + type guards (NO any)
// ----------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

function isRecord(v: unknown): v is UnknownRecord {
  return typeof v === "object" && v !== null;
}

function getString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function getBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Tries to normalize backend responses that look like:
 * { success: boolean, message?: string, code?: string, data?: ... }
 */
function normalizeApiResult<T>(payload: unknown): ApiResult<T> {
  if (!isRecord(payload)) {
    return { success: true, data: payload as T };
  }

  const success = getBoolean(payload.success);
  const message = getString(payload.message);
  const code = getString(payload.code);

  // We only trust `data` as unknown then cast to T at boundary (standard TS pattern)
  const data = payload.data as T | undefined;

  if (typeof success === "boolean") {
    return { success, message, code, data };
  }

  // If no `success` field, still treat as "ok"
  return { success: true, message, code, data };
}

function isApiError(err: unknown): err is ApiError {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status?: unknown }).status === "number" &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
  );
}

// ----------------------------------------------------------------------------
// Fetch helper (session cookies + graceful errors)
// ----------------------------------------------------------------------------

async function apiFetch<T>(
  path: string,
  options: RequestInit & { jsonBody?: unknown } = {}
): Promise<ApiResult<T>> {
  const { jsonBody, ...fetchOpts } = options;

  const headers = new Headers(fetchOpts.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");

  let body: BodyInit | undefined =
    fetchOpts.body === null || fetchOpts.body === undefined ? undefined : fetchOpts.body;

  if (jsonBody !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(jsonBody);
  }

  try {
    const payload = await sharedApiFetch<unknown>(path, {
      ...fetchOpts,
      headers,
      body,
    });

    return normalizeApiResult<T>(payload);
  } catch (err: unknown) {
    if (isApiError(err)) {
      const raw = err.raw;
      const data = isRecord(raw) ? (raw.data as T | undefined) : undefined;
      return {
        success: false,
        message: err.message,
        code: err.code,
        data,
      };
    }

    const message = err instanceof Error ? err.message : "Network error. Please try again.";

    console.error("[parentService] Network/Runtime error:", err);

    return { success: false, message, code: "NETWORK_ERROR" };
  }
}

// ----------------------------------------------------------------------------
// Service
// ----------------------------------------------------------------------------

export const parentService = {
  // --------------------------------------------------------------------------
  // Parent profile / linking
  // --------------------------------------------------------------------------

  ensureParentProfile(input?: { phone?: string; notes?: string }) {
    return apiFetch<{ id: number; user_id: number; phone: string | null; notes: string | null }>(
      `${PARENT_BASE}/ensure-profile`,
      { method: "POST", jsonBody: input ?? {} }
    );
  },

  getMyStudents() {
    return apiFetch<ParentStudentRow[]>(`${PARENT_BASE}/students`);
  },

  getStudentSelectionsAsParent(studentId: number) {
    return apiFetch<StudentSelectionRow[]>(
      `${PARENT_BASE}/student/${encodeURIComponent(String(studentId))}/selections`
    );
  },

  // --------------------------------------------------------------------------
  // Requests
  // --------------------------------------------------------------------------

  createParentRequest(payload: ParentRequestPayload) {
    return apiFetch<{ requestId: number; type: string | null }>(`${PARENT_BASE}/requests`, {
      method: "POST",
      jsonBody: payload,
    });
  },

  getParentRequests() {
    return apiFetch<ParentRequestRow[]>(`${PARENT_BASE}/requests`);
  },

  // --------------------------------------------------------------------------
  // Assignments
  // --------------------------------------------------------------------------

  getParentAssignments() {
    return apiFetch<ParentAssignmentRow[]>(`${PARENT_BASE}/assignments`);
  },

  // --------------------------------------------------------------------------
  // Teacher options
  // --------------------------------------------------------------------------

  getTeacherOptions(params: { studentId: number; subjectId: number }) {
    const qs = new URLSearchParams({
      student_id: String(params.studentId),
      subject_id: String(params.subjectId),
    });

    return apiFetch<TeacherOptionRow[]>(`${PARENT_BASE}/teacher-options?${qs.toString()}`);
  },

  selectTeacherOption(input: {
    studentId: number;
    subjectId: number;
    teacherId: number;
    selectionId?: number | null;
  }) {
    return apiFetch<{
      selectionId: number | null;
      studentId: number;
      subjectId: number;
      teacherId: number;
    }>(`${PARENT_BASE}/teacher-options/select`, {
      method: "POST",
      jsonBody: {
        studentId: input.studentId,
        subjectId: input.subjectId,
        teacherId: input.teacherId,
        selectionId: input.selectionId ?? null,
      },
    });
  },

  // --------------------------------------------------------------------------
  // Session switch (Tier B - session-only)
  // --------------------------------------------------------------------------

  switchToStudent(studentUserId: number) {
    return apiFetch<SwitchToStudentResponse>(`${PARENT_BASE}/switch-to-student`, {
      method: "POST",
      jsonBody: { student_user_id: studentUserId },
    });
  },

  switchBackToParent() {
    return apiFetch<SwitchBackResponse>(`${PARENT_BASE}/switch-back`, {
      method: "POST",
      jsonBody: {},
    });
  },
    // --------------------------------------------------------------------------
  // Announcements + Notifications (Messages tab)
  // --------------------------------------------------------------------------

  getParentAnnouncements() {
    return apiFetch<AnnouncementRow[]>(`${PARENT_BASE}/announcements`);
  },

  getParentNotifications() {
    return apiFetch<ParentNotificationsResponse>(`${PARENT_BASE}/notifications`);
  },

  markNotificationRead(notificationId: number) {
    return apiFetch<void>(
      `${PARENT_BASE}/notifications/${encodeURIComponent(String(notificationId))}/read`,
      { method: "PATCH" }
    );
  },

  markAllNotificationsRead() {
    return apiFetch<void>(`${PARENT_BASE}/notifications/read-all`, {
      method: "PATCH",
    });
  },

  getLessonSessionRating(sessionId: number) {
    return apiFetch<ParentSessionRatingData>(
      `${PARENT_BASE}/lesson-sessions/${encodeURIComponent(String(sessionId))}/rating`
    );
  },

  upsertLessonSessionRating(
    sessionId: number,
    payload: { stars: number; comment: string | null }
  ) {
    return apiFetch<ParentSaveSessionRatingData>(
      `${PARENT_BASE}/lesson-sessions/${encodeURIComponent(String(sessionId))}/rating`,
      {
        method: "POST",
        jsonBody: {
          stars: payload.stars,
          comment: payload.comment,
        },
      }
    );
  },

};

export default parentService;
