// src/app/parent/dashboard/parentDashboardHooks.ts
/**
 * Reusable Hooks for Parent Dashboard (SESSION AUTH VERSION) — UPDATED
 * ----------------------------------------------------------
 * ✅ Uses cookie-based sessions (credentials: "include")
 * ✅ No dev headers (no "x-user-id")
 * ✅ Consistent session-expired handling (401/403 => "NOT_AUTHENTICATED")
 * ✅ No `any`, strict typing, safe error messaging
 *
 * UPDATED:
 * ✅ useParentRequests now normalizes the NEW backend fields:
 *    - current_teacher_name      -> currentTeacherName
 *    - requested_teacher_name    -> requestedTeacherName
 *    - current_teacher_id        -> currentTeacherId
 *    - requested_teacher_id      -> requestedTeacherId
 *
 * Includes:
 * - useParentStudents
 * - useStudentSelections
 * - useParentAssignments
 * - useParentRequests          ✅ updated
 * - useParentSwitchToStudent
 * - useParentSwitchBack
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE, apiFetch as sharedApiFetch, clearCsrfToken } from "@/src/lib/api";
import type { ApiError } from "@/src/lib/api";
import { clearParentCsrfToken } from "@/src/services/parentService";
import type {
  ParentStudent,
  ParentSelection,
  ParentRequest,
  ParentAssignment,
} from "./parentDashboardTypes";

/* ===========================================================================
 * Backend envelope: { success, data, message?, code? }
 * ========================================================================== */
type ApiEnvelope<T> = {
  success: boolean;
  data?: T;
  message?: string;
  code?: string;
};

type UnknownRecord = Record<string, unknown>;
export type ParentAnnouncement = {
  id: number;
  title: string;
  body: string;
  audience: string;
  createdAt: string;
};

export type ParentNotificationItem = {
  id: number;
  type: string;
  title: string;
  body: string;
  relatedType: string | null;
  relatedId: number | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string | null;
};

export type ParentNotifications = {
  unreadCount: number;
  items: ParentNotificationItem[];
};

function isRecord(v: unknown): v is UnknownRecord {
  return typeof v === "object" && v !== null;
}

function getString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function getBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
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

/* ===========================================================================
 * Session-aware fetch helper
 * - credentials: "include" for session cookie
 * - throws Error("NOT_AUTHENTICATED") for 401/403
 * - supports GET/POST with optional JSON body
 * ========================================================================== */
async function fetchJson<T>(args: {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  jsonBody?: unknown;
  signal?: AbortSignal;
}): Promise<T> {
  const { url, method = "GET", jsonBody, signal } = args;

  const headers = new Headers();
  headers.set("Accept", "application/json");

  let body: BodyInit | undefined = undefined;
  if (jsonBody !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(jsonBody);
  }

  try {
    const payload = await sharedApiFetch<unknown>(url, {
      method,
      signal,
      headers,
      body,
    });

    if (isRecord(payload) && "success" in payload) {
      const env = payload as ApiEnvelope<T>;
      const success = getBoolean(env.success);

      if (success === false) {
        throw new Error(getString(env.message) ?? "Request failed.");
      }

      if (env.data === undefined) {
        return undefined as unknown as T;
      }

      return env.data;
    }

    return payload as T;
  } catch (err: unknown) {
    if (isApiError(err) && (err.status === 401 || err.status === 403)) {
      throw new Error("NOT_AUTHENTICATED");
    }

    if (isApiError(err)) {
      throw new Error(err.message);
    }

    throw err instanceof Error
      ? err
      : new Error("Network error. Please try again.");
  }
}

/* ===========================================================================
 * useParentStudents
 * ========================================================================== */
export function useParentStudents() {
  const [students, setStudents] = useState<ParentStudent[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  type ApiRow = {
    link_id: number;
    student_id: number;
    student_name: string;
    system_id: number | null;
    stage_id: number | null;
    grade_level_id: number | null;
    system_name: string | null;
    stage_name: string | null;
    grade_level_name: string | null;
    grade_stage: string | null;
    grade_number: string | number | null;
    relationship: string | null;
    has_own_login: number | boolean | null;
    student_user_id: number | null;
  };

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchJson<ApiRow[]>({
          url: `${API_BASE}/parent/students`,
          method: "GET",
          signal: controller.signal,
        });

        const mapped: ParentStudent[] = data.map((r) => {
          const gradeNumber: string | null =
            r.grade_number === null || r.grade_number === undefined
              ? null
              : String(r.grade_number);

          const studentUserId =
            typeof r.student_user_id === "number" ? r.student_user_id : null;
          const hasOwnLogin =
            r.has_own_login === true || Number(r.has_own_login) === 1;

          return {
            linkId: r.link_id,
            studentId: r.student_id,
            studentName: r.student_name,
            systemId: r.system_id != null ? Number(r.system_id) : null,
            stageId: r.stage_id != null ? Number(r.stage_id) : null,
            gradeLevelId: r.grade_level_id != null ? Number(r.grade_level_id) : null,
            systemName: typeof r.system_name === "string" ? r.system_name : null,
            stageName: typeof r.stage_name === "string" ? r.stage_name : null,
            gradeLevelName: typeof r.grade_level_name === "string" ? r.grade_level_name : null,
            gradeStage: r.grade_stage,
            gradeNumber,
            relationship: r.relationship ?? "",
            hasOwnLogin,
            studentUserId,
          };
        });

        setStudents(mapped);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;

        if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
          setError("NOT_AUTHENTICATED");
          return;
        }

        setError(
          err instanceof Error
            ? err.message
            : "Unknown error while loading students."
        );
      } finally {
        setLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, []);

  return { students, loading, error };
}

/* ===========================================================================
 * useStudentSelections
 * ========================================================================== */
export function useStudentSelections(studentId: number | null) {
  const [rows, setRows] = useState<ParentSelection[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  type ApiRow = {
    id: number;
    subject_id: number;
    subject_name_ar: string;
    subject_name_en: string;
    teacher_id: number | null;
    teacher_name: string | null;
    photo_url: string | null;
  };

  useEffect(() => {
    const controller = new AbortController();

    if (studentId == null) {
      setRows([]);
      setError("Missing student ID");
      setLoading(false);
      return () => controller.abort();
    }

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchJson<ApiRow[]>({
          url: `${API_BASE}/parent/student/${studentId}/selections`,
          method: "GET",
          signal: controller.signal,
        });

        const mapped: ParentSelection[] = data.map((r) => ({
          id: r.id,
          subjectId: r.subject_id,
          subjectNameAr: r.subject_name_ar,
          subjectNameEn: r.subject_name_en,
          teacherId: r.teacher_id,
          teacherName: r.teacher_name,
          photoUrl: r.photo_url,
        }));

        setRows(mapped);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;

        if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
          setError("NOT_AUTHENTICATED");
          return;
        }

        setError(
          err instanceof Error
            ? err.message
            : "Unknown error while loading selections."
        );
      } finally {
        setLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, [studentId]);

  return { rows, loading, error };
}

/* ===========================================================================
 * useParentAssignments
 * ========================================================================== */
export function useParentAssignments() {
  const [assignments, setAssignments] = useState<ParentAssignment[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchJson<ParentAssignment[]>({
          url: `${API_BASE}/parent/assignments`,
          method: "GET",
          signal: controller.signal,
        });

        setAssignments(data);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;

        if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
          setError("NOT_AUTHENTICATED");
          return;
        }

        setError(
          err instanceof Error
            ? err.message
            : "Unknown error while loading assignments."
        );
      } finally {
        setLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, []);

  return { assignments, loading, error };
}

/* ===========================================================================
 * useParentRequests (UPDATED + BACKWARD COMPATIBLE)
 * - Session auth (credentials: include) via fetchJson
 * - Normalizes backend snake_case to frontend camelCase
 * - ✅ Keeps legacy `teacherName` so existing ParentRequest type still compiles
 * - ✅ Adds requested teacher fields for the new UI
 * ========================================================================== */
export function useParentRequests() {
  const [requests, setRequests] = useState<ParentRequest[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Backend row as returned by GET /parent/requests
   * Matches your updated SQL aliases in the controller:
   * - current_teacher_name
   * - requested_teacher_name
   * - plus student/subject fields
   */
  type ApiRow = {
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

    status: string;
    reason: string | null;
    created_at: string;
  };

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchJson<ApiRow[]>({
          url: `${API_BASE}/parent/requests`,
          method: "GET",
          signal: controller.signal,
        });

        const mapped = data.map((r) => {
          const currentTeacherName =
            typeof r.current_teacher_name === "string"
              ? r.current_teacher_name
              : null;

          const requestedTeacherName =
            typeof r.requested_teacher_name === "string"
              ? r.requested_teacher_name
              : null;

          // -------------------------------------------------------------------
          // ✅ Backward compatibility:
          // Your existing ParentRequest type REQUIRES `teacherName`.
          // Historically it meant "the teacher on the request" (which is current).
          // So we map:
          //   teacherName = currentTeacherName
          // -------------------------------------------------------------------
          const teacherName = currentTeacherName;

          return {
            id: r.id,

            studentId: r.student_id,
            studentName: r.student_name,

            subjectId: r.subject_id,
            subjectNameAr: r.subject_name_ar,
            subjectNameEn: r.subject_name_en,

            // ✅ Legacy field required by your current ParentRequest type
            teacherName,

            // ✅ NEW fields (will be used by the updated Requests tab)
            currentTeacherId: r.current_teacher_id,
            currentTeacherName,
            requestedTeacherId: r.requested_teacher_id,
            requestedTeacherName,

            status: r.status,
            reason: r.reason,
            createdAt: r.created_at,
          };
        });

        // mapped already includes legacy `teacherName`,
        // so it satisfies the current ParentRequest type
        setRequests(mapped as ParentRequest[]);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;

        if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
          setError("NOT_AUTHENTICATED");
          return;
        }

        setError(
          err instanceof Error
            ? err.message
            : "Unknown error while loading requests."
        );
      } finally {
        setLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, []);

  return { requests, loading, error };
}

/* ===========================================================================
 * useParentSwitchToStudent
 * ========================================================================== */
type SwitchToStudentData = {
  as: "student";
  student_user_id: number;
  student_id: number;
};

function resetPostSwitchSessionCaches(): void {
  clearCsrfToken();
  clearParentCsrfToken();
  window.dispatchEvent(new Event("auth:changed"));
}

export function useParentSwitchToStudent() {
  const [switching, setSwitching] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSwitched, setLastSwitched] = useState<SwitchToStudentData | null>(
    null
  );

  const switchToStudent = useCallback(async (studentUserId: number) => {
    setSwitching(true);
    setError(null);

    try {
      const data = await fetchJson<SwitchToStudentData>({
        url: `${API_BASE}/parent/switch-to-student`,
        method: "POST",
        jsonBody: { student_user_id: studentUserId },
      });

      resetPostSwitchSessionCaches();
      setLastSwitched(data);
      return { ok: true as const, data };
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setError("NOT_AUTHENTICATED");
        return { ok: false as const, error: "NOT_AUTHENTICATED" };
      }

      const msg =
        err instanceof Error ? err.message : "Could not switch to student.";
      setError(msg);
      return { ok: false as const, error: msg };
    } finally {
      setSwitching(false);
    }
  }, []);

  return useMemo(
    () => ({ switchToStudent, switching, error, lastSwitched }),
    [switchToStudent, switching, error, lastSwitched]
  );
}

/* ===========================================================================
 * useParentSwitchBack
 * ========================================================================== */
type SwitchBackData = { as: "parent" };

export function useParentSwitchBack() {
  const [switchingBack, setSwitchingBack] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const switchBack = useCallback(async () => {
    setSwitchingBack(true);
    setError(null);

    try {
      const data = await fetchJson<SwitchBackData>({
        url: `${API_BASE}/parent/switch-back`,
        method: "POST",
        jsonBody: {},
      });

      resetPostSwitchSessionCaches();
      return { ok: true as const, data };
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setError("NOT_AUTHENTICATED");
        return { ok: false as const, error: "NOT_AUTHENTICATED" };
      }

      const msg =
        err instanceof Error ? err.message : "Could not switch back to parent.";
      setError(msg);
      return { ok: false as const, error: msg };
    } finally {
      setSwitchingBack(false);
    }
  }, []);

  return useMemo(
    () => ({ switchBack, switchingBack, error }),
    [switchBack, switchingBack, error]
  );
}

export function useParentAnnouncements() {
  const [announcements, setAnnouncements] = useState<ParentAnnouncement[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  type ApiRow = {
    id: number;
    title: string;
    body: string;
    audience: string;
    createdAt: string;
  };

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchJson<ApiRow[]>({
          url: `${API_BASE}/parent/announcements`,
          method: "GET",
          signal: controller.signal,
        });

        setAnnouncements(
          data.map((r) => ({
            id: r.id,
            title: r.title,
            body: r.body,
            audience: r.audience,
            createdAt: r.createdAt,
          }))
        );
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;

        if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
          setError("NOT_AUTHENTICATED");
          return;
        }

        setError(
          err instanceof Error
            ? err.message
            : "Unknown error while loading announcements."
        );
      } finally {
        setLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchJson<ApiRow[]>({
        url: `${API_BASE}/parent/announcements`,
        method: "GET",
      });

      setAnnouncements(
        data.map((r) => ({
          id: r.id,
          title: r.title,
          body: r.body,
          audience: r.audience,
          createdAt: r.createdAt,
        }))
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setError("NOT_AUTHENTICATED");
        return;
      }
      setError(err instanceof Error ? err.message : "Could not refresh announcements.");
    } finally {
      setLoading(false);
    }
  }, []);

  return useMemo(
    () => ({ announcements, loading, error, refresh }),
    [announcements, loading, error, refresh]
  );
}
export function useParentNotifications() {
  const [inbox, setInbox] = useState<ParentNotifications>({
    unreadCount: 0,
    items: [],
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  type ApiRow = {
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

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchJson<ApiRow>({
          url: `${API_BASE}/parent/notifications`,
          method: "GET",
          signal,
        });

        setInbox({
          unreadCount: Number.isFinite(data.unreadCount) ? data.unreadCount : 0,
          items: Array.isArray(data.items) ? data.items : [],
        });
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;

        if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
          setError("NOT_AUTHENTICATED");
          return;
        }

        setError(
          err instanceof Error
            ? err.message
            : "Unknown error while loading notifications."
        );
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const refresh = useCallback(async () => {
    await load(undefined);
  }, [load]);

  const markRead = useCallback(async (id: number) => {
    // Optimistic UI: mark read locally first
    setInbox((prev) => {
      const items = prev.items.map((n) =>
        n.id === id ? { ...n, isRead: true, readAt: n.readAt ?? new Date().toISOString() } : n
      );
      const unreadCount = items.reduce((acc, n) => acc + (n.isRead ? 0 : 1), 0);
      return { unreadCount, items };
    });

    try {
      await fetchJson<void>({
        url: `${API_BASE}/parent/notifications/${encodeURIComponent(String(id))}/read`,
        method: "PATCH",
      });
      return { ok: true as const };
    } catch (err: unknown) {
      // Rollback by reloading if needed
      await refresh();

      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setError("NOT_AUTHENTICATED");
        return { ok: false as const, error: "NOT_AUTHENTICATED" };
      }
      return { ok: false as const, error: err instanceof Error ? err.message : "Failed to mark read." };
    }
  }, [refresh]);

  const markAllRead = useCallback(async () => {
    // Optimistic: mark all read
    setInbox((prev) => ({
      unreadCount: 0,
      items: prev.items.map((n) => ({
        ...n,
        isRead: true,
        readAt: n.readAt ?? new Date().toISOString(),
      })),
    }));

    try {
      await fetchJson<void>({
        url: `${API_BASE}/parent/notifications/read-all`,
        method: "PATCH",
      });
      return { ok: true as const };
    } catch (err: unknown) {
      await refresh();

      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setError("NOT_AUTHENTICATED");
        return { ok: false as const, error: "NOT_AUTHENTICATED" };
      }
      return { ok: false as const, error: err instanceof Error ? err.message : "Failed to mark all read." };
    }
  }, [refresh]);

  return useMemo(
    () => ({ inbox, loading, error, refresh, markRead, markAllRead }),
    [inbox, loading, error, refresh, markRead, markAllRead]
  );
}
