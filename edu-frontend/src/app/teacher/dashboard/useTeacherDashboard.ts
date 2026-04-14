// src/app/teacher/dashboard/useTeacherDashboard.ts
"use client";

/**
 * =============================================================================
 * useTeacherDashboard — Teacher Dashboard State Management Hook
 * -----------------------------------------------------------------------------
 * Central hook for managing teacher dashboard state, data fetching, and CRUD operations.
 * Features:
 * ✅ Session-only authentication (no devUserId, uses cookies)
 * ✅ Array-safe state management (prevents .map is not a function errors)
 * ✅ Backend-aligned field names (available_from/available_until, exception_type, etc.)
 * ✅ Integrated notifications and announcements system
 * ✅ Type-safe with shared teacherDashboardTypes
 * ✅ Proper API endpoints for teacher messages (notifications & announcements)
 * ✅ Correctly uses camelCase for messages as per teacherDashboardTypes.ts
 * ✅ No `any` types - fully type-safe
 * ✅ Strict API envelope validation for dashboard calls
 * ✅ FIXED: Announcements normalization for field consistency
 * ✅ FIXED: Crash-proof normalizeTeacherInbox with safe object property access
 * =============================================================================
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, type ApiError } from "@/src/lib/api";
import {
  cairoDateKey as sharedCairoDateKey,
  cairoEndOfDay as sharedCairoEndOfDay,
  cairoStartOfDay as sharedCairoStartOfDay,
} from "@/src/lib/cairoTime";
import type {
  Lang,
  TeacherAnnouncementRow,
  TeacherDashboardTabId,
  TeacherNotificationApiResponse,
  TeacherNotificationInbox,
  TeacherNotificationRow,
  QuizRow,
  SlotOfferingRow as SlotOfferingPayloadRow,
  SlotOfferingsResponseRow,
  GradeCatalogSystem,
  GradeCatalogStage,
  GradeCatalogLevel,
  ScheduleOfferingsMap,
  SlotStatusKind,
} from "./teacherDashboardTypes";
import { teacherTypeUtils } from "./teacherDashboardTypes";
import { teacherDashboardTexts } from "./teacherDashboardTexts";

// -----------------------------------------------------------------------------
// Type Definitions (Aligned with Backend Controller)
// IMPORTANT: These are duplicated from teacherDashboardTypes.ts for completeness
// but the messages types are imported directly from the shared types file
// -----------------------------------------------------------------------------

export type TeacherProfile = {
  id: number;
  user_id: number;
  status: string;
  is_active: number;
  name?: string | null;
  bio_short?: string | null;
  gender?: "male" | "female" | null;
  photo_url?: string | null;
  phone?: string | null;
  nationality?: string | null;
  date_of_birth?: string | null;
  university?: string | null;
  specialization?: string | null;
  current_occupation?: string | null;
  teaching_style?: string | null;
  bio_long?: string | null;
  references_text?: string | null;
  education_system_id?: number | null;
  years_of_experience?: string | null;
  highest_qualification?: string | null;
  hourly_rate?: string | null;
  teaching_philosophy?: string | null;
  achievements?: string | null;
  user_full_name?: string | null;
  user_email?: string | null;
  user_preferred_lang?: string | null;
};

export type TeacherStudentRow = {
  id: number;
  student_id: number;
  subject_id: number;
  teacher_id: number;
  selected_by: string;
  status: string;
  selected_at: string;
  student_name: string;
  student_email: string;
  subject_name_en: string;
  subject_name_ar: string;
};

export type LessonSessionRow = {
  id: number;
  teacher_id: number;
  subject_id: number;
  system_id?: number | null;
  stage_id?: number | null;
  grade_level_id?: number | null;
  schedule_id?: number | null;
  exception_id?: number | null;
  starts_at: string;
  ends_at: string;
  is_group?: number | null;
  max_students?: number | null;
  created_by_user_id?: number | null;
  student_id?: number | null;
  status:
    | "pending"
    | "rejected"
    | "scheduled"
    | "completed"
    | "cancelled"
    | "no_show"
    | "approved"
    | (string & {});
  cancel_reason?: string | null;
  created_at?: string;
  subject_name_en: string;
  subject_name_ar: string;
  students_count: number;
};

export type LessonSessionDetails = {
  session: LessonSessionRow;
  students: Array<{
    id: number;
    student_id: number;
    attendance_status:
      | "scheduled"
      | "present"
      | "absent"
      | "late"
      | "excused"
      | (string & {});
    joined_at: string | null;
    left_at: string | null;
    user_id: number;
    student_name: string;
    student_email: string;
  }>;
};

export type HomeworkRow = {
  id: number;
  teacher_id: number;
  subject_id: number;
  title: string;
  description: string | null;
  due_at: string;
  max_score: number | null;
  attachments_url: string | null;
  is_active: number;
  subject_name_en: string;
  subject_name_ar: string;
};

export type HomeworkSubmissionRow = {
  id: number;
  homework_id: number;
  student_id: number;
  submission_url: string | null;
  submitted_at?: string | null;
  status: string;
  score: number | null;
  feedback: string | null;
  student_name: string;
  student_email: string;
};


export type QuizSubmissionRow = {
  id: number;
  quiz_id: number;
  student_id: number;

  submission_url: string | null;
  submitted_at: string | null;
  status: string;

  score: number | null;
  feedback: string | null;

  answers?: unknown;

  student_name: string;
  student_email: string;
};

export type ScheduleSlotRow = {
  id: number;
  teacher_id: number;
  weekday: number;
  start_time: string;
  end_time: string;
  is_group: number;
  max_students: number | null;
  is_active: number;
};

export type ScheduleExceptionRow = {
  id: number;
  teacher_id: number;
  exception_date: string;
  start_time: string;
  end_time: string;
  exception_type: "unavailable" | "extra_available" | (string & {});
  is_group: number;
  max_students: number | null;
  note: string | null;
  reason: string | null;
  is_active: number;
};

export type TeacherVideoRow = {
  id: number;
  teacher_id: number;
  subject_id: number;
  video_url: string;
  is_primary: number;
  subject_name_en: string | null;
  subject_name_ar: string | null;
};

export type PendingLessonRequestRow = {
  id: number;
  teacher_id: number;
  subject_id: number;
  schedule_id: number | null;
  starts_at: string;
  ends_at: string;
  status: "pending";
  created_by_user_id: number;
  student_id: number | null;
  student_name: string;
  student_email: string | null;
  requester_name: string | null;
  requester_email: string | null;
  subject_name_en: string;
  subject_name_ar: string;
};

export type TeacherSubjectRow = {
  subject_id: number;
  name_en: string | null;
  name_ar: string | null;
};

type GradeCatalogState = {
  systems: GradeCatalogSystem[];
  stages: GradeCatalogStage[];
  levels: GradeCatalogLevel[];
};

const EMPTY_GRADE_CATALOG: GradeCatalogState = {
  systems: [],
  stages: [],
  levels: [],
};

// -----------------------------------------------------------------------------
// Helper Functions
// -----------------------------------------------------------------------------

/**
 * Type guard for Record objects
 */
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

/**
 * Safely gets a property from a Record
 */
function getProp(v: Record<string, unknown>, key: string): unknown {
  return v[key];
}

/**
 * Strictly unwraps canonical API envelopes:
 * - { success: true, data: ... }
 * - { ok: true, data: ... }
 */
function unwrapData<T>(raw: unknown): T {
  if (!isRecord(raw) || !("data" in raw)) {
    throw new Error("Invalid API response shape.");
  }

  const success =
    ("success" in raw && raw.success === true) ||
    ("ok" in raw && raw.ok === true);

  if (!success) {
    const message = typeof raw.message === "string" ? raw.message : "Request failed";
    throw new Error(message);
  }

  return raw.data as T;
}

/**
 * Safely converts unknown to array, returns empty array if invalid
 */
function asArray<T>(raw: unknown): T[] {
  const v = unwrapData<unknown>(raw);
  return Array.isArray(v) ? (v as T[]) : [];
}

/**
 * Safely trims strings, returns empty string for non-strings
 */
function safeTrim(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Canonical backend weekday contract:
 * 1=Monday .. 7=Sunday.
 * During rollout we still tolerate legacy Sunday=0 and normalize it to 7.
 */
function normalizeCanonicalWeekday(value: unknown): number {
  const weekday = Number(value);
  if (!Number.isFinite(weekday)) return 1;
  const normalized = Math.trunc(weekday);
  if (normalized === 0) return 7;
  if (normalized >= 1 && normalized <= 7) return normalized;
  return 1;
}

function normalizeScheduleSlotRows(raw: unknown): ScheduleSlotRow[] {
  return asArray<ScheduleSlotRow>(raw).map((slot) => ({
    ...slot,
    weekday: normalizeCanonicalWeekday(slot.weekday),
  }));
}

function normalizeSlotOfferingRows(raw: unknown): SlotOfferingsResponseRow[] {
  return asArray<SlotOfferingsResponseRow>(raw);
}

function normalizeTeacherSubjectRows(raw: unknown): TeacherSubjectRow[] {
  return asArray<TeacherSubjectRow>(raw);
}

function normalizeGradeCatalog(raw: unknown): GradeCatalogState {
  if (!isRecord(raw)) return EMPTY_GRADE_CATALOG;

  return {
    systems: Array.isArray(raw.systems)
      ? (raw.systems as GradeCatalogSystem[])
      : [],
    stages: Array.isArray(raw.stages)
      ? (raw.stages as GradeCatalogStage[])
      : [],
    levels: Array.isArray(raw.levels)
      ? (raw.levels as GradeCatalogLevel[])
      : [],
  };
}

// ---------------------------------------------------------------------------
// Shared scheduling time contract
// ---------------------------------------------------------------------------
// src/lib/cairoTime.ts is the canonical frontend boundary for parsing and
// formatting naive lesson/session datetimes. Backend storage stays as
// "YYYY-MM-DD HH:MM:SS" Cairo wall-clock values without hardcoding +02:00.
// ---------------------------------------------------------------------------

/** "YYYY-MM-DD" in Cairo time (for form defaults, date keys, etc.). */
function cairoDateKey(d: Date): string {
  return sharedCairoDateKey(d);
}

/** "YYYY-MM-DD 00:00:00" in Cairo time — used as the ?from filter. */
function cairoStartOfDay(d: Date): string {
  return sharedCairoStartOfDay(d);
}

/** "YYYY-MM-DD 23:59:59" in Cairo time — used as the ?to filter. */
function cairoEndOfDay(d: Date): string {
  return sharedCairoEndOfDay(d);
}

/**
 * Returns the start-of-day Cairo datetime for 90 calendar days ago.
 * Used as a default lower bound for the "all sessions" list fetch so the
 * request is never fully unbounded (backend cap is 200 rows; this also
 * restricts by date so active upcoming sessions are always included).
 */
function sessions90DayFrom(): string {
  return cairoStartOfDay(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
}

/**
 * Custom debounce hook for search inputs
 */
function useDebounce<T>(value: T, delayMs: number): T {
  const [v, setV] = useState<T>(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return v;
}

/**
 * Extracts error message from unknown error type
 */
function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

function isApiError(err: unknown): err is ApiError {
  return (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
  );
}

function getTeacherOperationalDeniedMessage(
  err: unknown,
  lang: Lang
): string | null {
  const code = isApiError(err) ? err.code : undefined;

  switch (code) {
    case "TEACHER_NOT_APPROVED":
      return lang === "ar"
        ? "\u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u0639\u0644\u0645 \u0644\u0627 \u064a\u0632\u0627\u0644 \u0642\u064a\u062f \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u0645\u0634\u0631\u0641. \u0633\u062a\u0641\u062a\u062d \u0623\u0642\u0633\u0627\u0645 \u0627\u0644\u062d\u0635\u0635 \u0648\u0627\u0644\u0637\u0644\u0627\u0628 \u0648\u0627\u0644\u0648\u0627\u062c\u0628\u0627\u062a \u0648\u0627\u0644\u0627\u062e\u062a\u0628\u0627\u0631\u0627\u062a \u0648\u0637\u0644\u0628\u0627\u062a \u0627\u0644\u062d\u0635\u0635 \u0628\u0639\u062f \u0627\u0644\u0645\u0648\u0627\u0641\u0642\u0629."
        : "Your teacher account is pending admin approval. Sessions, students, homework, quizzes, and lesson requests will unlock after approval.";
    case "TEACHER_REJECTED":
      return lang === "ar"
        ? "\u062a\u0645 \u0631\u0641\u0636 \u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u0639\u0644\u0645. \u0623\u0642\u0633\u0627\u0645 \u0627\u0644\u062d\u0635\u0635 \u0648\u0627\u0644\u0637\u0644\u0627\u0628 \u0648\u0627\u0644\u0648\u0627\u062c\u0628\u0627\u062a \u0648\u0627\u0644\u0627\u062e\u062a\u0628\u0627\u0631\u0627\u062a \u0648\u0637\u0644\u0628\u0627\u062a \u0627\u0644\u062d\u0635\u0635 \u063a\u064a\u0631 \u0645\u062a\u0627\u062d\u0629."
        : "Your teacher account has been rejected. Sessions, students, homework, quizzes, and lesson requests are unavailable.";
    case "TEACHER_INACTIVE":
      return lang === "ar"
        ? "\u062d\u0633\u0627\u0628 \u0627\u0644\u0645\u0639\u0644\u0645 \u063a\u064a\u0631 \u0646\u0634\u0637. \u0623\u0642\u0633\u0627\u0645 \u0627\u0644\u062d\u0635\u0635 \u0648\u0627\u0644\u0637\u0644\u0627\u0628 \u0648\u0627\u0644\u0648\u0627\u062c\u0628\u0627\u062a \u0648\u0627\u0644\u0627\u062e\u062a\u0628\u0627\u0631\u0627\u062a \u0648\u0637\u0644\u0628\u0627\u062a \u0627\u0644\u062d\u0635\u0635 \u063a\u064a\u0631 \u0645\u062a\u0627\u062d\u0629."
        : "Your teacher account is inactive. Sessions, students, homework, quizzes, and lesson requests are unavailable.";
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// API Helper Functions for Teacher Messages
// -----------------------------------------------------------------------------

/**
 * Teacher-specific API wrapper with strict envelope enforcement.
 */
async function teacherApiFetch<T>(
  url: string,
  options: RequestInit & { jsonBody?: unknown } = {}
): Promise<T> {
  const { jsonBody, ...fetchOptions } = options;

  const headers: HeadersInit = {
    ...(fetchOptions.headers || {}),
    ...(jsonBody ? { "Content-Type": "application/json" } : {}),
  };

  const body = jsonBody ? JSON.stringify(jsonBody) : fetchOptions.body;

  // Fetch raw response and enforce envelope contract
  const res = await apiFetch<unknown>(url, {
    ...fetchOptions,
    headers,
    body,
  });

  return unwrapData<T>(res);
}

/**
 * Ensures a notification row has the correct TeacherNotificationRow shape
 * Backend returns camelCase, we keep it as camelCase
 */
function normalizeNotificationRow(backendRow: unknown): TeacherNotificationRow {
  const r = isRecord(backendRow) ? backendRow : {};

  const id = Number(getProp(r, "id")) || 0;

  const type =
    typeof getProp(r, "type") === "string" ? String(getProp(r, "type")) : "";
  const title =
    typeof getProp(r, "title") === "string" ? String(getProp(r, "title")) : "";

  const bodyRaw = getProp(r, "body");
  const messageRaw = getProp(r, "message");
  const body =
    typeof bodyRaw === "string"
      ? bodyRaw
      : typeof messageRaw === "string"
      ? messageRaw
      : null;

  const relatedTypeRaw =
    getProp(r, "relatedType") ?? getProp(r, "related_type");
  const relatedType =
    typeof relatedTypeRaw === "string" ? relatedTypeRaw : null;

  const relatedIdRaw = getProp(r, "relatedId") ?? getProp(r, "related_id");
  const relatedId =
    typeof relatedIdRaw === "number"
      ? relatedIdRaw
      : Number.isFinite(Number(relatedIdRaw))
      ? Number(relatedIdRaw)
      : null;

  const isReadRaw = getProp(r, "isRead");
  const isReadNormalized = teacherTypeUtils.normalizeIsRead(
    typeof isReadRaw === "boolean" || isReadRaw === 0 || isReadRaw === 1
      ? isReadRaw
      : 0
  );

  const readAtRaw = getProp(r, "readAt") ?? getProp(r, "read_at");
  const readAt = typeof readAtRaw === "string" ? readAtRaw : null;

  const createdAtRaw = getProp(r, "createdAt") ?? getProp(r, "created_at");
  const createdAt = typeof createdAtRaw === "string" ? createdAtRaw : null;

  return {
    id,
    type,
    title,
    body,
    relatedType,
    relatedId,
    isRead: isReadNormalized,
    readAt,
    createdAt,
  };
}

/**
 * ✅ FIXED: Ensures an announcement row has the correct TeacherAnnouncementRow shape
 * Always normalizes backend data to guarantee field consistency
 * Backend returns camelCase, we keep it as camelCase
 */
function normalizeAnnouncementRow(backendRow: unknown): TeacherAnnouncementRow {
  const r = isRecord(backendRow) ? backendRow : {};

  const id = Number(getProp(r, "id")) || 0;

  const titleRaw = getProp(r, "title");
  const title = typeof titleRaw === "string" ? titleRaw : "";

  const bodyRaw = getProp(r, "body");
  const contentRaw = getProp(r, "content");
  const body =
    typeof bodyRaw === "string"
      ? bodyRaw
      : typeof contentRaw === "string"
      ? contentRaw
      : "";

  const audienceRaw = getProp(r, "audience");
  const audience =
    audienceRaw === "all" ||
    audienceRaw === "students" ||
    audienceRaw === "parents" ||
    audienceRaw === "teachers"
      ? audienceRaw
      : "all";

  const createdAtRaw = getProp(r, "createdAt") ?? getProp(r, "created_at");
  const createdAt = typeof createdAtRaw === "string" ? createdAtRaw : null;

  return { id, title, body, audience, createdAt };
}

/**
 * ✅ FIXED: Normalizes teacher notifications API response into inbox format
 * CRASH-PROOF: Safely handles both array and inbox object responses
 * Uses safe property access via getProp to prevent runtime errors
 */
function normalizeTeacherInbox(
  raw: TeacherNotificationApiResponse
): TeacherNotificationInbox {
  // Handle array response (list of notifications)
  if (Array.isArray(raw)) {
    const items = raw.map(normalizeNotificationRow);
    const unreadCount = items.reduce((acc, n) => {
      const isRead = teacherTypeUtils.normalizeIsRead(n.isRead);
      return acc + (isRead ? 0 : 1);
    }, 0);
    return { unreadCount, items };
  }

  // ✅ SAFE OBJECT BRANCH: Handle inbox object response with crash-proof property access
  const obj = isRecord(raw) ? raw : {};
  const rawItems = Array.isArray(getProp(obj, "items"))
    ? (getProp(obj, "items") as unknown[])
    : [];
  const items = rawItems.map(normalizeNotificationRow);

  const unreadCountRaw = getProp(obj, "unreadCount");
  const unreadCount =
    typeof unreadCountRaw === "number"
      ? unreadCountRaw
      : items.reduce((acc, n) => {
          const isRead = teacherTypeUtils.normalizeIsRead(n.isRead);
          return acc + (isRead ? 0 : 1);
        }, 0);

  return { unreadCount, items };
}

// -----------------------------------------------------------------------------
// Hook Types
// -----------------------------------------------------------------------------

export type GradeTarget =
  | {
      kind: "homework";
      submissionId: number;
      currentScore: number | null;
      currentFeedback: string | null;
    }
  | {
      kind: "quiz";
      submissionId: number;
      currentScore: number | null;
      currentFeedback: string | null;
    }
  | null;

// -----------------------------------------------------------------------------
// Main Hook
// -----------------------------------------------------------------------------

export function useTeacherDashboard({ lang }: { lang: Lang }) {
  const offeringsText = teacherDashboardTexts[lang].schedule.offerings;

  // ---------------------------------------------------------------------------
  // Active Tab State
  // ---------------------------------------------------------------------------
  const [activeTab, setActiveTab] = useState<TeacherDashboardTabId>("overview");

  // ---------------------------------------------------------------------------
  // Global State
  // ---------------------------------------------------------------------------
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [softMsg, setSoftMsg] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Core Data States (Always Arrays for Safety)
  // ---------------------------------------------------------------------------
  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const [students, setStudents] = useState<TeacherStudentRow[]>([]);
  const [sessionsToday, setSessionsToday] = useState<LessonSessionRow[]>([]);
  const [sessionsAll, setSessionsAll] = useState<LessonSessionRow[]>([]);
  const [homework, setHomework] = useState<HomeworkRow[]>([]);
  const [quizzes, setQuizzes] = useState<QuizRow[]>([]);
  const [scheduleSlots, setScheduleSlots] = useState<ScheduleSlotRow[]>([]);
  const [slotOfferings, setSlotOfferings] = useState<SlotOfferingsResponseRow[]>(
    []
  );
  const [gradeCatalog, setGradeCatalog] =
    useState<GradeCatalogState>(EMPTY_GRADE_CATALOG);
  const [teacherSubjects, setTeacherSubjects] = useState<TeacherSubjectRow[]>(
    []
  );
  const [exceptions, setExceptions] = useState<ScheduleExceptionRow[]>([]);
  const [videos, setVideos] = useState<TeacherVideoRow[]>([]);
  const [offeringsLoading, setOfferingsLoading] = useState(false);
  const [offeringsSaving, setOfferingsSaving] = useState(false);
  const [offeringsError, setOfferingsError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Lesson Requests State
  // ---------------------------------------------------------------------------
  const [pendingLessonRequests, setPendingLessonRequests] = useState<PendingLessonRequestRow[]>([]);
  const [lessonRequestsLoading, setLessonRequestsLoading] = useState(false);
  const [lessonRequestsError, setLessonRequestsError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // MESSAGES: Notifications State (camelCase as per teacherDashboardTypes.ts)
  // ---------------------------------------------------------------------------
  const [notificationsInbox, setNotificationsInbox] =
    useState<TeacherNotificationInbox>({
      unreadCount: 0,
      items: [],
    });
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState<string | null>(
    null
  );

  // ---------------------------------------------------------------------------
  // MESSAGES: Announcements State (camelCase as per teacherDashboardTypes.ts)
  // ---------------------------------------------------------------------------
  const [announcements, setAnnouncements] = useState<TeacherAnnouncementRow[]>(
    []
  );
  const [announcementsLoading, setAnnouncementsLoading] = useState(false);
  const [announcementsError, setAnnouncementsError] = useState<string | null>(
    null
  );

  // ---------------------------------------------------------------------------
  // Modal States
  // ---------------------------------------------------------------------------
  const [sessionDetailsOpen, setSessionDetailsOpen] = useState(false);
  const [sessionDetailsLoading, setSessionDetailsLoading] = useState(false);
  const [sessionDetails, setSessionDetails] =
    useState<LessonSessionDetails | null>(null);

  const [homeworkModalOpen, setHomeworkModalOpen] = useState(false);
  const [editHomework, setEditHomework] = useState<HomeworkRow | null>(null);

  const [quizModalOpen, setQuizModalOpen] = useState(false);
  const [editQuiz, setEditQuiz] = useState<QuizRow | null>(null);
  const [offeringsModalOpen, setOfferingsModalOpen] = useState(false);
  const [activeOfferingScheduleId, setActiveOfferingScheduleId] = useState<
    number | null
  >(null);
  const [activeOfferingScheduleSlot, setActiveOfferingScheduleSlot] =
    useState<ScheduleSlotRow | null>(null);

  const [submissionsOpen, setSubmissionsOpen] = useState(false);
  const [submissionsTitle, setSubmissionsTitle] = useState("");
  const [homeworkSubmissions, setHomeworkSubmissions] = useState<
    HomeworkSubmissionRow[] | null
  >(null);
  const [quizSubmissions, setQuizSubmissions] = useState<
    QuizSubmissionRow[] | null
  >(null);
  const [submissionsLoading, setSubmissionsLoading] = useState(false);

  const [gradeModalOpen, setGradeModalOpen] = useState(false);
  const [gradeTarget, setGradeTarget] = useState<GradeTarget>(null);

  // ---------------------------------------------------------------------------
  // Form States
  // ---------------------------------------------------------------------------
  // Canonical backend weekday contract: 1=Monday .. 7=Sunday.
  const [slotForm, setSlotForm] = useState<{
    weekday: number;
    start_time: string;
    end_time: string;
    is_group: boolean;
    max_students: string;
    is_active: boolean;
  }>({
    weekday: 1,
    start_time: "16:00",
    end_time: "17:00",
    is_group: false,
    max_students: "2",
    is_active: true,
  });

  const [exForm, setExForm] = useState<{
    exception_date: string;
    start_time: string;
    end_time: string;
    exception_type: "unavailable" | "extra_available";
    is_group: boolean;
    max_students: string;
    note: string;
    reason: string;
    is_active: boolean;
  }>({
    exception_date: cairoDateKey(new Date()), // Cairo date, not UTC date
    start_time: "16:00",
    end_time: "17:00",
    exception_type: "unavailable",
    is_group: false,
    max_students: "2",
    note: "",
    reason: "",
    is_active: true,
  });

  const [videoForm, setVideoForm] = useState<{
    subject_id: string;
    video_url: string;
    make_primary: boolean;
  }>({
    subject_id: "",
    video_url: "",
    make_primary: false,
  });

  const [profileForm, setProfileForm] = useState<{
    name: string;
    bio_short: string;
    phone: string;
    photo_url: string;
  }>({
    name: "",
    bio_short: "",
    phone: "",
    photo_url: "",
  });

  // ---------------------------------------------------------------------------
  // Search States (with debouncing)
  // ---------------------------------------------------------------------------
  const [qStudents, setQStudents] = useState("");
  const [qSessions, setQSessions] = useState("");
  const [qHomework, setQHomework] = useState("");
  const [qQuizzes, setQQuizzes] = useState("");

  const dqStudents = useDebounce(qStudents, 200);
  const dqSessions = useDebounce(qSessions, 200);
  const dqHomework = useDebounce(qHomework, 200);
  const dqQuizzes = useDebounce(qQuizzes, 200);

  // ---------------------------------------------------------------------------
  // Fetch Helpers (Session-Only Authentication)
  // ---------------------------------------------------------------------------

  /**
   * Core fetch wrapper that handles API response unwrapping
   */
  const fetchJson = useCallback(
    async <T>(path: string, init?: RequestInit): Promise<T> => {
      const raw = await apiFetch<unknown>(path, init);
      return unwrapData<T>(raw);
    },
    []
  );

  /**
   * Safe fetch wrapper that catches errors and returns null
   */
  const tryFetchJson = useCallback(
    async <T>(path: string, init?: RequestInit): Promise<T | null> => {
      try {
        return await fetchJson<T>(path, init);
      } catch (e) {
        console.error("[useTeacherDashboard] Optional fetch failed:", path, e);
        return null;
      }
    },
    [fetchJson]
  );

  const promoteTeacherOperationalDenial = useCallback(
    (
      err: unknown,
      options?: {
        fatal?: boolean;
        soft?: boolean;
        setSectionError?: (message: string | null) => void;
      }
    ): string | null => {
      const message = getTeacherOperationalDeniedMessage(err, lang);
      if (!message) return null;

      if (options?.setSectionError) options.setSectionError(message);
      if (options?.fatal ?? true) setFatalError(message);
      if (options?.soft) setSoftMsg(message);
      return message;
    },
    [lang]
  );

  const loadSlotOfferings = useCallback(
    async (scheduleId?: number): Promise<SlotOfferingsResponseRow[]> => {
      setOfferingsLoading(true);
      setOfferingsError(null);

      try {
        const suffix =
          scheduleId && scheduleId > 0
            ? `?schedule_id=${encodeURIComponent(String(scheduleId))}`
            : "";
        const raw = await fetchJson<unknown>(
          `/teacher/schedules/offerings${suffix}`
        );
        const rows = normalizeSlotOfferingRows(raw);

        setSlotOfferings((prev) =>
          scheduleId && scheduleId > 0
            ? [
                ...prev.filter((row) => row.schedule_id !== scheduleId),
                ...rows,
              ]
            : rows
        );

        return rows;
      } catch (err: unknown) {
        setOfferingsError(getErrorMessage(err, offeringsText.loadError));
        return [];
      } finally {
        setOfferingsLoading(false);
      }
    },
    [fetchJson, offeringsText.loadError]
  );

  const loadTeacherSubjects = useCallback(async (): Promise<TeacherSubjectRow[]> => {
    try {
      const raw = await fetchJson<unknown>("/teacher/subjects");
      const rows = normalizeTeacherSubjectRows(raw);
      setTeacherSubjects(rows);
      return rows;
    } catch (err: unknown) {
      setOfferingsError(getErrorMessage(err, offeringsText.loadError));
      setTeacherSubjects([]);
      return [];
    }
  }, [fetchJson, offeringsText.loadError]);

  const loadGradeCatalog = useCallback(async (): Promise<GradeCatalogState> => {
    try {
      const raw = await fetchJson<unknown>("/meta/grade-catalog");
      const catalog = normalizeGradeCatalog(raw);
      setGradeCatalog(catalog);
      return catalog;
    } catch (err: unknown) {
      setOfferingsError(getErrorMessage(err, offeringsText.loadError));
      setGradeCatalog(EMPTY_GRADE_CATALOG);
      return EMPTY_GRADE_CATALOG;
    }
  }, [fetchJson, offeringsText.loadError]);

  // ===========================================================================
  // MESSAGES: Notifications Functions
  // ===========================================================================

  /**
   * Loads teacher notifications from backend
   * Uses teacher-specific API endpoint that returns camelCase in envelope
   */
  const loadNotifications = useCallback(async () => {
    try {
      setNotificationsLoading(true);
      setNotificationsError(null);

      // ✅ Backend endpoint for teacher notifications (returns camelCase in envelope)
      const raw = await teacherApiFetch<TeacherNotificationInbox>(
        "/teacher/notifications"
      );

      // ✅ SAFE NORMALIZATION: Crash-proof inbox normalization
      setNotificationsInbox(normalizeTeacherInbox(raw));
    } catch (err: unknown) {
      setNotificationsError(
        getErrorMessage(
          err,
          lang === "ar"
            ? "فشل تحميل الإشعارات."
            : "Failed to load notifications."
        )
      );
    } finally {
      setNotificationsLoading(false);
    }
  }, [lang]);

  /**
   * Marks a single notification as read (optimistic update)
   * Uses PATCH method for consistency with backend
   */
  const markNotificationRead = useCallback(
    async (id: number) => {
      setNotificationsError(null);

      // Optimistic update - uses camelCase fields as per teacherDashboardTypes.ts
      setNotificationsInbox((prev) => {
        const nextItems: TeacherNotificationRow[] = prev.items.map((n) => {
          if (n.id !== id) return n;

          return {
            ...n,
            isRead: true, // ✅ Uses boolean true (not 1) as per type definition
            readAt: n.readAt ?? new Date().toISOString(),
          };
        });

        const unreadCount = nextItems.reduce((acc, n) => {
          const isRead = teacherTypeUtils.normalizeIsRead(n.isRead);
          return acc + (isRead ? 0 : 1);
        }, 0);

        return { unreadCount, items: nextItems };
      });

      try {
        // ✅ Backend endpoint for marking notification as read
        await teacherApiFetch<unknown>(`/teacher/notifications/${id}/read`, {
          method: "PATCH",
        });
      } catch (err: unknown) {
        // Rollback on error
        setNotificationsError(
          getErrorMessage(
            err,
            lang === "ar"
              ? "فشل تعليم الإشعار كمقروء."
              : "Failed to mark notification read."
          )
        );
        // Refetch to restore correct state
        void loadNotifications();
      }
    },
    [lang, loadNotifications]
  );

  /**
   * Marks all notifications as read (optimistic update)
   * Uses PATCH method for consistency with backend
   */
  const markAllNotificationsRead = useCallback(async () => {
    setNotificationsError(null);

    // Optimistic update - uses camelCase fields as per teacherDashboardTypes.ts
    setNotificationsInbox((prev) => {
      const nextItems: TeacherNotificationRow[] = prev.items.map((n) => ({
        ...n,
        isRead: true, // ✅ Uses boolean true (not 1) as per type definition
        readAt: n.readAt ?? new Date().toISOString(),
      }));

      return { unreadCount: 0, items: nextItems };
    });

    try {
      // ✅ Backend endpoint for marking all notifications as read
      await teacherApiFetch<unknown>("/teacher/notifications/read-all", {
        method: "PATCH",
      });
    } catch (err: unknown) {
      // Rollback on error
      setNotificationsError(
        getErrorMessage(
          err,
          lang === "ar"
            ? "فشل تعليم كل الإشعارات كمقروء."
            : "Failed to mark all notifications read."
        )
      );
      // Refetch to restore correct state
      void loadNotifications();
    }
  }, [lang, loadNotifications]);

  // ===========================================================================
  // MESSAGES: Announcements Functions
  // ===========================================================================

  /**
   * ✅ FIXED: Loads teacher announcements from backend with proper normalization
   * Backend returns camelCase in envelope, we normalize to TeacherAnnouncementRow
   * Ensures createdAt is always properly typed (string | null)
   */
  const loadAnnouncements = useCallback(async () => {
    try {
      setAnnouncementsLoading(true);
      setAnnouncementsError(null);

      // ✅ Backend endpoint for teacher announcements (returns camelCase in envelope)
      const raw = await teacherApiFetch<TeacherAnnouncementRow[]>(
        "/teacher/announcements"
      );

      // ✅ SAFE NORMALIZATION: Always normalize backend data for field consistency
      // This ensures createdAt is properly typed even if backend sends created_at
      setAnnouncements(
        Array.isArray(raw) ? raw.map(normalizeAnnouncementRow) : []
      );
    } catch (err: unknown) {
      setAnnouncementsError(
        getErrorMessage(
          err,
          lang === "ar"
            ? "فشل تحميل الإعلانات."
            : "Failed to load announcements."
        )
      );
    } finally {
      setAnnouncementsLoading(false);
    }
  }, [lang]);

  // ---------------------------------------------------------------------------
  // Lesson Requests: Load / Approve / Reject
  // ---------------------------------------------------------------------------

  const loadLessonRequests = useCallback(async () => {
    setLessonRequestsLoading(true);
    setLessonRequestsError(null);
    try {
      const raw = await fetchJson<unknown>("/teacher/lesson-requests/pending");
      setPendingLessonRequests(asArray<PendingLessonRequestRow>(raw));
    } catch (e: unknown) {
      const deniedMessage = promoteTeacherOperationalDenial(e, {
        setSectionError: setLessonRequestsError,
      });
      if (deniedMessage) {
        setPendingLessonRequests([]);
        return;
      }

      setLessonRequestsError(
        getErrorMessage(
          e,
          lang === "ar" ? "فشل تحميل طلبات الحصص." : "Failed to load lesson requests."
        )
      );
    } finally {
      setLessonRequestsLoading(false);
    }
  }, [fetchJson, lang, promoteTeacherOperationalDenial]);

  const approveLessonRequest = useCallback(
    async (id: number) => {
      try {
        await fetchJson(`/teacher/lesson-requests/${id}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        setSoftMsg(lang === "ar" ? "تمت الموافقة على الطلب." : "Lesson request approved.");
        const [freshReqRaw, freshSessRaw] = await Promise.all([
          tryFetchJson<unknown>("/teacher/lesson-requests/pending"),
          tryFetchJson<unknown>(`/teacher/lesson-sessions?from=${encodeURIComponent(sessions90DayFrom())}`),
        ]);
        setPendingLessonRequests(asArray<PendingLessonRequestRow>(freshReqRaw));
        setSessionsAll(asArray<LessonSessionRow>(freshSessRaw));
      } catch (e: unknown) {
        const deniedMessage = promoteTeacherOperationalDenial(e, {
          fatal: false,
        });
        setSoftMsg(
          deniedMessage ??
            getErrorMessage(
              e,
              lang === "ar" ? "فشل قبول الطلب." : "Failed to approve lesson request."
            )
        );
      }
    },
    [fetchJson, lang, promoteTeacherOperationalDenial, tryFetchJson]
  );

  const rejectLessonRequest = useCallback(
    async (id: number, reason?: string) => {
      try {
        await fetchJson(`/teacher/lesson-requests/${id}/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reason ?? null }),
        });
        setSoftMsg(lang === "ar" ? "تم رفض الطلب." : "Lesson request rejected.");
        const [freshReqRaw, freshSessRaw] = await Promise.all([
          tryFetchJson<unknown>("/teacher/lesson-requests/pending"),
          tryFetchJson<unknown>(
            `/teacher/lesson-sessions?from=${encodeURIComponent(sessions90DayFrom())}`
          ),
        ]);
        setPendingLessonRequests(asArray<PendingLessonRequestRow>(freshReqRaw));
        setSessionsAll(asArray<LessonSessionRow>(freshSessRaw));
      } catch (e: unknown) {
        const deniedMessage = promoteTeacherOperationalDenial(e, {
          fatal: false,
        });
        setSoftMsg(
          deniedMessage ??
            getErrorMessage(
              e,
              lang === "ar" ? "فشل رفض الطلب." : "Failed to reject lesson request."
            )
        );
      }
    },
    [fetchJson, lang, promoteTeacherOperationalDenial, tryFetchJson]
  );

  // ---------------------------------------------------------------------------
  // Cancel a scheduled session (teacher-initiated)
  // ---------------------------------------------------------------------------

  const cancelScheduledSession = useCallback(
    async (sessionId: number, reason?: string) => {
      try {
        await fetchJson(`/teacher/lesson-sessions/${sessionId}/cancel`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reason ?? null }),
        });
        setSoftMsg(lang === "ar" ? "تم إلغاء الحصة." : "Session cancelled.");
        // Refresh sessions list (bounded to last 90 days forward)
        const freshRaw = await tryFetchJson<unknown>(`/teacher/lesson-sessions?from=${encodeURIComponent(sessions90DayFrom())}`);
        setSessionsAll(asArray<LessonSessionRow>(freshRaw));
      } catch (e: unknown) {
        const deniedMessage = promoteTeacherOperationalDenial(e, {
          fatal: false,
        });
        setSoftMsg(
          deniedMessage ??
            getErrorMessage(
              e,
              lang === "ar" ? "فشل إلغاء الحصة." : "Failed to cancel session."
            )
        );
      }
    },
    [fetchJson, lang, promoteTeacherOperationalDenial, tryFetchJson]
  );

  // ---------------------------------------------------------------------------
  // Core Data Loading
  // ---------------------------------------------------------------------------

  /**
   * Loads all dashboard data including messages
   */
  const loadCore = useCallback(async () => {
    setFatalError(null);
    setSoftMsg(null);
    setLoading(true);

    try {
      const now = new Date();
      // Build today's date range in Cairo time so the "today's sessions" filter
      // always matches the Cairo calendar day, regardless of browser timezone.
      const from = cairoStartOfDay(now);
      const to   = cairoEndOfDay(now);

      const [
        p,
        stRaw,
        sessTodayRaw,
        sessAllRaw,
        hwRaw,
        qzRaw,
        schRaw,
        exRaw,
        vdRaw,
      ] = await Promise.all([
        fetchJson<TeacherProfile | null>("/teacher/me"),
        fetchJson<unknown>("/teacher/students"),
        fetchJson<unknown>(
          `/teacher/lesson-sessions?from=${encodeURIComponent(
            from
          )}&to=${encodeURIComponent(to)}`
        ),
        fetchJson<unknown>(`/teacher/lesson-sessions?from=${encodeURIComponent(sessions90DayFrom())}`),
        fetchJson<unknown>("/teacher/homework"),
        fetchJson<unknown>("/teacher/quizzes"),
        fetchJson<unknown>("/teacher/schedules"),
        fetchJson<unknown>("/teacher/schedule-exceptions"),
        fetchJson<unknown>("/teacher/videos"),
      ]);

      setProfile(p);
      setStudents(asArray<TeacherStudentRow>(stRaw));
      setSessionsToday(asArray<LessonSessionRow>(sessTodayRaw));
      setSessionsAll(asArray<LessonSessionRow>(sessAllRaw));
      setHomework(asArray<HomeworkRow>(hwRaw));
      setQuizzes(asArray<QuizRow>(qzRaw));
      setScheduleSlots(normalizeScheduleSlotRows(schRaw));
      setExceptions(asArray<ScheduleExceptionRow>(exRaw));
      setVideos(asArray<TeacherVideoRow>(vdRaw));

      await Promise.all([
        loadSlotOfferings(),
        loadTeacherSubjects(),
        loadGradeCatalog(),
      ]);

      // Load messages and lesson requests as part of initial load
      void loadAnnouncements();
      void loadNotifications();
      void loadLessonRequests();
    } catch (e: unknown) {
      console.error("[useTeacherDashboard] Load failed:", e);
      setFatalError(
        getTeacherOperationalDeniedMessage(e, lang) ??
          (e instanceof Error ? e.message : "Failed to load dashboard")
      );
    } finally {
      setLoading(false);
    }
  }, [
    fetchJson,
    lang,
    loadAnnouncements,
    loadGradeCatalog,
    loadLessonRequests,
    loadNotifications,
    loadSlotOfferings,
    loadTeacherSubjects,
  ]);

  // Initial load on mount
  useEffect(() => {
    void loadCore();
  }, [loadCore]);

  // ---------------------------------------------------------------------------
  // Profile Form Sync
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!profile) return;
    setProfileForm({
      name: safeTrim(profile.name ?? profile.user_full_name ?? ""),
      bio_short: safeTrim(profile.bio_short ?? ""),
      phone: safeTrim(profile.phone ?? ""),
      photo_url: safeTrim(profile.photo_url ?? ""),
    });
  }, [profile]);

  // ---------------------------------------------------------------------------
  // Computed Overview Statistics (Includes Messages)
  // ---------------------------------------------------------------------------
  const overview = useMemo(() => {
    const approvedStudents = students.filter(
      (s) => s.status === "approved"
    ).length;
    const upcoming = sessionsAll.filter(
      (s) =>
        s.status === "scheduled" ||
        s.status === "pending" ||
        s.status === "approved"
    ).length;
    const activeHw = homework.filter((h) => Number(h.is_active) === 1).length;
    const activeQz = quizzes.filter((q) => Number(q.is_active) === 1).length;
    const activeSlots = scheduleSlots.filter(
      (s) => Number(s.is_active) === 1
    ).length;
    const activeExceptions = exceptions.filter(
      (e) => Number(e.is_active) === 1
    ).length;
    const unreadNotifications = notificationsInbox.unreadCount;
    const newAnnouncements = announcements.length;

    return {
      approvedStudents,
      upcoming,
      activeHw,
      activeQz,
      activeSlots,
      activeExceptions,
      unreadNotifications,
      newAnnouncements,
    };
  }, [
    students,
    sessionsAll,
    homework,
    quizzes,
    scheduleSlots,
    exceptions,
    notificationsInbox,
    announcements,
  ]);

  const slotOfferingsMap = useMemo<ScheduleOfferingsMap>(() => {
    return slotOfferings.reduce<ScheduleOfferingsMap>((acc, row) => {
      const scheduleId = Number(row.schedule_id);
      if (!scheduleId) return acc;

      const offering: SlotOfferingPayloadRow = {
        subject_id: Number(row.subject_id),
        system_id: Number(row.system_id),
        stage_id: Number(row.stage_id),
        grade_level_id:
          row.grade_level_id == null ? null : Number(row.grade_level_id),
        is_active: Number(row.offering_is_active ?? 1) === 1 ? 1 : 0,
      };

      if (!acc[scheduleId]) acc[scheduleId] = [];
      acc[scheduleId].push(offering);
      return acc;
    }, {});
  }, [slotOfferings]);

  const teacherSubjectsById = useMemo(
    () => new Map(teacherSubjects.map((subject) => [subject.subject_id, subject])),
    [teacherSubjects]
  );

  const systemsById = useMemo(
    () => new Map(gradeCatalog.systems.map((system) => [system.id, system])),
    [gradeCatalog.systems]
  );

  const stagesById = useMemo(
    () => new Map(gradeCatalog.stages.map((stage) => [stage.id, stage])),
    [gradeCatalog.stages]
  );

  const levelsById = useMemo(
    () => new Map(gradeCatalog.levels.map((level) => [level.id, level])),
    [gradeCatalog.levels]
  );

  const getOfferingsForSlot = useCallback(
    (scheduleId: number): SlotOfferingPayloadRow[] =>
      slotOfferingsMap[scheduleId] ?? [],
    [slotOfferingsMap]
  );

  const getSlotStatus = useCallback(
    (scheduleId: number): SlotStatusKind =>
      getOfferingsForSlot(scheduleId).length > 0 ? "live" : "draft",
    [getOfferingsForSlot]
  );

  const buildOfferingSummary = useCallback(
    (scheduleId: number, preferredLang: Lang = lang): string => {
      const offerings = getOfferingsForSlot(scheduleId);
      const localizedTexts =
        teacherDashboardTexts[preferredLang].schedule.offerings;

      if (!offerings.length) {
        return localizedTexts.empty;
      }

      if (offerings.length > 1) {
        return `${offerings.length} ${localizedTexts.manyOfferingsSuffix}`;
      }

      const offering = offerings[0];
      const subject = teacherSubjectsById.get(offering.subject_id);
      const system = systemsById.get(offering.system_id);
      const stage = stagesById.get(offering.stage_id);
      const level =
        offering.grade_level_id == null
          ? null
          : levelsById.get(offering.grade_level_id);

      const subjectLabel =
        preferredLang === "ar"
          ? subject?.name_ar || subject?.name_en || null
          : subject?.name_en || subject?.name_ar || null;

      const stageLabel =
        preferredLang === "ar"
          ? stage?.nameAr || stage?.nameEn || null
          : stage?.nameEn || stage?.nameAr || null;

      const levelLabel =
        offering.grade_level_id == null
          ? localizedTexts.stageWide
          : preferredLang === "ar"
          ? level?.nameAr || level?.nameEn || null
          : level?.nameEn || level?.nameAr || null;

      const summary = [subjectLabel, system?.name || null, stageLabel, levelLabel]
        .filter((value): value is string => Boolean(value))
        .join(" • ");

      return summary || localizedTexts.oneOffering;
    },
    [
      getOfferingsForSlot,
      lang,
      levelsById,
      stagesById,
      systemsById,
      teacherSubjectsById,
    ]
  );

  // ---------------------------------------------------------------------------
  // Session Management
  // ---------------------------------------------------------------------------

  const openSessionDetails = useCallback(
    async (sessionId: number) => {
      setSessionDetailsOpen(true);
      setSessionDetailsLoading(true);
      setSessionDetails(null);

      try {
        const d = await fetchJson<LessonSessionDetails>(
          `/teacher/lesson-sessions/${sessionId}`
        );
        setSessionDetails(d);
      } catch (e: unknown) {
        const deniedMessage = promoteTeacherOperationalDenial(e, {
          fatal: false,
        });
        setSoftMsg(
          deniedMessage ??
            (lang === "ar"
              ? "تعذر تحميل تفاصيل الحصة."
              : "Could not load session details.")
        );
        return;
      } finally {
        setSessionDetailsLoading(false);
      }
    },
    [fetchJson, lang, promoteTeacherOperationalDenial]
  );

  const closeSessionDetails = useCallback(() => {
    setSessionDetailsOpen(false);
    setSessionDetails(null);
  }, []);

  const updateAttendance = useCallback(
    async (
      sessionId: number,
      studentId: number,
      attendance_status: LessonSessionDetails["students"][number]["attendance_status"]
    ) => {
      try {
        await fetchJson(`/teacher/lesson-sessions/${sessionId}/attendance`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sessionId,
            student_id: studentId,
            attendance_status,
          }),
        });

        setSessionDetails((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            students: prev.students.map((s) =>
              s.student_id === studentId ? { ...s, attendance_status } : s
            ),
          };
        });

        setSoftMsg(lang === "ar" ? "تم تحديث الحضور." : "Attendance updated.");
      } catch (e: unknown) {
        const deniedMessage = promoteTeacherOperationalDenial(e, {
          fatal: false,
        });
        setSoftMsg(
          deniedMessage ??
            (e instanceof Error
              ? e.message
              : lang === "ar"
              ? "فشل تحديث الحضور."
              : "Failed to update attendance.")
        );
      }
    },
    [fetchJson, lang, promoteTeacherOperationalDenial]
  );

  // ---------------------------------------------------------------------------
  // Homework CRUD
  // ---------------------------------------------------------------------------

  const openCreateHomework = useCallback(() => {
    setEditHomework(null);
    setHomeworkModalOpen(true);
  }, []);

  const openEditHomework = useCallback((row: HomeworkRow) => {
    setEditHomework(row);
    setHomeworkModalOpen(true);
  }, []);

  const closeHomeworkModal = useCallback(() => {
    setHomeworkModalOpen(false);
    setEditHomework(null);
  }, []);

  const saveHomework = useCallback(
    async (payload: {
      subject_id: number;
      title: string;
      description: string | null;
      due_at: string;
      max_score: number | null;
      attachments_url: string | null;
      is_active: number;
    }) => {
      try {
        if (editHomework) {
          await fetchJson(`/teacher/homework/${editHomework.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          setSoftMsg(lang === "ar" ? "تم تحديث الواجب." : "Homework updated.");
        } else {
          await fetchJson(`/teacher/homework`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          setSoftMsg(lang === "ar" ? "تم إنشاء الواجب." : "Homework created.");
        }

        setHomeworkModalOpen(false);
        setEditHomework(null);

        const freshRaw = await tryFetchJson<unknown>("/teacher/homework");
        setHomework(asArray<HomeworkRow>(freshRaw));
      } catch (e: unknown) {
        const deniedMessage = promoteTeacherOperationalDenial(e, {
          fatal: false,
        });
        setSoftMsg(
          deniedMessage ??
            (e instanceof Error
              ? e.message
              : lang === "ar"
              ? "فشل حفظ الواجب."
              : "Failed to save homework.")
        );
      }
    },
    [editHomework, fetchJson, lang, promoteTeacherOperationalDenial, tryFetchJson]
  );

  // ---------------------------------------------------------------------------
  // Quiz CRUD
  // ---------------------------------------------------------------------------

  const openCreateQuiz = useCallback(() => {
    setEditQuiz(null);
    setQuizModalOpen(true);
  }, []);

  const openEditQuiz = useCallback((row: QuizRow) => {
    setEditQuiz(row);
    setQuizModalOpen(true);
  }, []);

  const closeQuizModal = useCallback(() => {
    setQuizModalOpen(false);
    setEditQuiz(null);
  }, []);

  const saveQuiz = useCallback(
    async (payload: {
      subject_id: number;
      title: string;
      description: string | null;
      available_from: string;
      available_until: string;
      time_limit_min: number | null;
      max_score: number | null;
      is_active: number;
    }) => {
      try {
        if (editQuiz) {
          await fetchJson(`/teacher/quizzes/${editQuiz.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          setSoftMsg(lang === "ar" ? "تم تحديث الاختبار." : "Quiz updated.");
        } else {
          await fetchJson(`/teacher/quizzes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          setSoftMsg(lang === "ar" ? "تم إنشاء الاختبار." : "Quiz created.");
        }

        setQuizModalOpen(false);
        setEditQuiz(null);

        const freshRaw = await tryFetchJson<unknown>("/teacher/quizzes");
        setQuizzes(asArray<QuizRow>(freshRaw));
      } catch (e: unknown) {
        const deniedMessage = promoteTeacherOperationalDenial(e, {
          fatal: false,
        });
        setSoftMsg(
          deniedMessage ??
            (e instanceof Error
              ? e.message
              : lang === "ar"
              ? "فشل حفظ الاختبار."
              : "Failed to save quiz.")
        );
      }
    },
    [editQuiz, fetchJson, lang, promoteTeacherOperationalDenial, tryFetchJson]
  );

  // ---------------------------------------------------------------------------
  // Submissions & Grading
  // ---------------------------------------------------------------------------

  const openHomeworkSubmissions = useCallback(
    async (row: HomeworkRow) => {
      setSubmissionsOpen(true);
      setSubmissionsTitle(
        lang === "ar"
          ? `تسليمات الواجب: ${row.title}`
          : `Homework submissions: ${row.title}`
      );
      setHomeworkSubmissions(null);
      setQuizSubmissions(null);
      setSubmissionsLoading(true);

      try {
        const raw = await fetchJson<unknown>(
          `/teacher/homework/${row.id}/submissions`
        );
        setHomeworkSubmissions(
          asArray<HomeworkSubmissionRow>(raw).map((s) => ({
            ...s,
            submission_url: s.submission_url ?? null,
            submitted_at: s.submitted_at ?? null,
            feedback: s.feedback ?? null,
          }))
        );
      } catch (e: unknown) {
        const deniedMessage = promoteTeacherOperationalDenial(e, {
          fatal: false,
        });
        setSoftMsg(
          deniedMessage ??
            (lang === "ar"
              ? "تعذر تحميل تسليمات الواجب."
              : "Could not load homework submissions.")
        );
      } finally {
        setSubmissionsLoading(false);
      }
    },
    [fetchJson, lang, promoteTeacherOperationalDenial]
  );

  const openQuizSubmissions = useCallback(
    async (row: QuizRow) => {
      setSubmissionsOpen(true);
      setSubmissionsTitle(
        lang === "ar"
          ? `تسليمات الاختبار: ${row.title}`
          : `Quiz submissions: ${row.title}`
      );
      setHomeworkSubmissions(null);
      setQuizSubmissions(null);
      setSubmissionsLoading(true);

      try {
        const raw = await fetchJson<unknown>(
          `/teacher/quizzes/${row.id}/submissions`
        );
        setQuizSubmissions(
          asArray<QuizSubmissionRow>(raw).map((s) => ({
            ...s,
            submission_url: s.submission_url ?? null,
            submitted_at: s.submitted_at ?? null,
            feedback: s.feedback ?? null,
          }))
        );
      } catch (e: unknown) {
        const deniedMessage = promoteTeacherOperationalDenial(e, {
          fatal: false,
        });
        setSoftMsg(
          deniedMessage ??
            (lang === "ar"
              ? "تعذر تحميل تسليمات الاختبار."
              : "Could not load quiz submissions.")
        );
      } finally {
        setSubmissionsLoading(false);
      }
    },
    [fetchJson, lang, promoteTeacherOperationalDenial]
  );

  const closeSubmissions = useCallback(() => {
    setSubmissionsOpen(false);
    setHomeworkSubmissions(null);
    setQuizSubmissions(null);
  }, []);

  const openGrade = useCallback((x: Exclude<GradeTarget, null>) => {
    setGradeTarget(x);
    setGradeModalOpen(true);
  }, []);

  const closeGrade = useCallback(() => {
    setGradeModalOpen(false);
    setGradeTarget(null);
  }, []);

  const saveGrade = useCallback(
    async (payload: { score: number | null; feedback?: string | null }) => {
      if (!gradeTarget) return;

      try {
        if (gradeTarget.kind === "homework") {
          await fetchJson(
            `/teacher/homework/submissions/${gradeTarget.submissionId}/grade`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                score: payload.score,
                feedback: payload.feedback ?? null,
              }),
            }
          );

          setHomeworkSubmissions((prev) =>
            prev
              ? prev.map((s) =>
                  s.id === gradeTarget.submissionId
                    ? {
                        ...s,
                        score: payload.score ?? null,
                        feedback: payload.feedback ?? null,
                        status: "graded",
                      }
                    : s
                )
              : prev
          );
        } else {
          await fetchJson(
            `/teacher/quizzes/submissions/${gradeTarget.submissionId}/grade`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                score: payload.score,
                feedback: payload.feedback ?? null,
              }),
            }
          );

          setQuizSubmissions((prev) =>
            prev
              ? prev.map((s) =>
                  s.id === gradeTarget.submissionId
                    ? {
                        ...s,
                        score: payload.score ?? null,
                        feedback: payload.feedback ?? null,
                        status: "graded",
                      }
                    : s
                )
              : prev
          );
        }

        setSoftMsg(lang === "ar" ? "تم حفظ التقييم." : "Grade saved.");
        setGradeModalOpen(false);
        setGradeTarget(null);
      } catch (e: unknown) {
        const deniedMessage = promoteTeacherOperationalDenial(e, {
          fatal: false,
          soft: true,
        });
        setSoftMsg(
          deniedMessage ??
            (e instanceof Error
              ? e.message
              : lang === "ar"
              ? "فشل حفظ التقييم."
              : "Failed to save grade.")
        );
      }
    },
    [fetchJson, gradeTarget, lang, promoteTeacherOperationalDenial]
  );

  const openOfferingsModal = useCallback(
    (slot: ScheduleSlotRow) => {
      setOfferingsError(null);
      setOfferingsModalOpen(true);
      setActiveOfferingScheduleId(slot.id);
      setActiveOfferingScheduleSlot(slot);
      void loadSlotOfferings(slot.id);
    },
    [loadSlotOfferings]
  );

  const closeOfferingsModal = useCallback(() => {
    setOfferingsModalOpen(false);
    setActiveOfferingScheduleId(null);
    setActiveOfferingScheduleSlot(null);
    setOfferingsError(null);
  }, []);

  const saveSlotOfferings = useCallback(
    async (scheduleId: number, offerings: SlotOfferingPayloadRow[]) => {
      setOfferingsSaving(true);
      setOfferingsError(null);

      try {
        await fetchJson(`/teacher/schedules/${scheduleId}/offerings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            offerings: offerings.map((offering) => ({
              subject_id: Number(offering.subject_id),
              system_id: Number(offering.system_id),
              stage_id: Number(offering.stage_id),
              grade_level_id:
                offering.grade_level_id == null
                  ? null
                  : Number(offering.grade_level_id),
              is_active: Number(offering.is_active) === 1 ? 1 : 0,
            })),
          }),
        });

        await loadSlotOfferings(scheduleId);
        setSoftMsg(offeringsText.updated);
        closeOfferingsModal();
        return true;
      } catch (err: unknown) {
        const message = getErrorMessage(err, offeringsText.saveError);
        setOfferingsError(message);
        setSoftMsg(message);
        return false;
      } finally {
        setOfferingsSaving(false);
      }
    },
    [
      closeOfferingsModal,
      fetchJson,
      loadSlotOfferings,
      offeringsText.saveError,
      offeringsText.updated,
    ]
  );

  // ---------------------------------------------------------------------------
  // Schedule Slots Management
  // ---------------------------------------------------------------------------

  const createSlot = useCallback(async () => {
    try {
      const weekday = normalizeCanonicalWeekday(slotForm.weekday);
      await fetchJson(`/teacher/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          weekday,
          start_time: slotForm.start_time,
          end_time: slotForm.end_time,
          is_group: slotForm.is_group ? 1 : 0,
          max_students: slotForm.is_group
            ? Number(slotForm.max_students || "2")
            : null,
          is_active: slotForm.is_active ? 1 : 0,
        }),
      });

      const freshRaw = await tryFetchJson<unknown>("/teacher/schedules");
      setScheduleSlots(normalizeScheduleSlotRows(freshRaw));
      setSoftMsg(lang === "ar" ? "تم إنشاء الفترة." : "Slot created.");
    } catch (e: unknown) {
      setSoftMsg(
        e instanceof Error
          ? e.message
          : lang === "ar"
          ? "فشل إنشاء الفترة."
          : "Failed to create slot."
      );
    }
  }, [fetchJson, lang, slotForm, tryFetchJson]);

  const toggleSlotActive = useCallback(
    async (slot: ScheduleSlotRow) => {
      try {
        await fetchJson(`/teacher/schedules/${slot.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            is_active: Number(slot.is_active) === 1 ? 0 : 1,
          }),
        });

        const freshRaw = await tryFetchJson<unknown>("/teacher/schedules");
        setScheduleSlots(normalizeScheduleSlotRows(freshRaw));
      } catch (e: unknown) {
        setSoftMsg(
          e instanceof Error
            ? e.message
            : lang === "ar"
            ? "فشل تحديث الفترة."
            : "Failed to update slot."
        );
      }
    },
    [fetchJson, lang, tryFetchJson]
  );

  const deleteSlot = useCallback(
    async (slot: ScheduleSlotRow) => {
      try {
        await fetchJson(`/teacher/schedules/${slot.id}`, { method: "DELETE" });
        const freshRaw = await tryFetchJson<unknown>("/teacher/schedules");
        setScheduleSlots(normalizeScheduleSlotRows(freshRaw));
        setSlotOfferings((prev) =>
          prev.filter((offering) => offering.schedule_id !== slot.id)
        );
        if (activeOfferingScheduleId === slot.id) {
          closeOfferingsModal();
        }
      } catch (e: unknown) {
        setSoftMsg(
          e instanceof Error
            ? e.message
            : lang === "ar"
            ? "فشل حذف الفترة."
            : "Failed to delete slot."
        );
      }
    },
    [activeOfferingScheduleId, closeOfferingsModal, fetchJson, lang, tryFetchJson]
  );

  // ---------------------------------------------------------------------------
  // Schedule Exceptions Management
  // ---------------------------------------------------------------------------

  const createException = useCallback(async () => {
    try {
      await fetchJson(`/teacher/schedule-exceptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exception_date: exForm.exception_date,
          start_time: exForm.start_time,
          end_time: exForm.end_time,
          exception_type: exForm.exception_type,
          is_group: exForm.is_group ? 1 : 0,
          max_students: exForm.is_group
            ? Number(exForm.max_students || "2")
            : null,
          note: exForm.note.trim() ? exForm.note.trim() : null,
          reason: exForm.reason.trim() ? exForm.reason.trim() : null,
          is_active: exForm.is_active ? 1 : 0,
        }),
      });

      const freshRaw = await tryFetchJson<unknown>(
        "/teacher/schedule-exceptions"
      );
      setExceptions(asArray<ScheduleExceptionRow>(freshRaw));
      setSoftMsg(lang === "ar" ? "تم إنشاء الاستثناء." : "Exception created.");
    } catch (e: unknown) {
      setSoftMsg(
        e instanceof Error
          ? e.message
          : lang === "ar"
          ? "فشل إنشاء الاستثناء."
          : "Failed to create exception."
      );
    }
  }, [exForm, fetchJson, lang, tryFetchJson]);

  const toggleExceptionActive = useCallback(
    async (ex: ScheduleExceptionRow) => {
      try {
        await fetchJson(`/teacher/schedule-exceptions/${ex.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            is_active: Number(ex.is_active) === 1 ? 0 : 1,
          }),
        });

        const freshRaw = await tryFetchJson<unknown>(
          "/teacher/schedule-exceptions"
        );
        setExceptions(asArray<ScheduleExceptionRow>(freshRaw));
      } catch (e: unknown) {
        setSoftMsg(
          e instanceof Error
            ? e.message
            : lang === "ar"
            ? "فشل تحديث الاستثناء."
            : "Failed to update exception."
        );
      }
    },
    [fetchJson, lang, tryFetchJson]
  );

  const deleteException = useCallback(
    async (ex: ScheduleExceptionRow) => {
      try {
        await fetchJson(`/teacher/schedule-exceptions/${ex.id}`, {
          method: "DELETE",
        });
        const freshRaw = await tryFetchJson<unknown>(
          "/teacher/schedule-exceptions"
        );
        setExceptions(asArray<ScheduleExceptionRow>(freshRaw));
      } catch (e: unknown) {
        setSoftMsg(
          e instanceof Error
            ? e.message
            : lang === "ar"
            ? "فشل حذف الاستثناء."
            : "Failed to delete exception."
        );
      }
    },
    [fetchJson, lang, tryFetchJson]
  );

  // ---------------------------------------------------------------------------
  // Video Management
  // ---------------------------------------------------------------------------

  const addVideo = useCallback(async () => {
    try {
      const subjectId = Number(videoForm.subject_id);
      if (!Number.isFinite(subjectId) || subjectId <= 0) {
        setSoftMsg(
          lang === "ar" ? "رقم المادة غير صحيح." : "Invalid subject_id."
        );
        return;
      }
      const url = videoForm.video_url.trim();
      if (!url) {
        setSoftMsg(
          lang === "ar" ? "رابط الفيديو مطلوب." : "Video URL is required."
        );
        return;
      }

      await fetchJson(`/teacher/videos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject_id: subjectId,
          video_url: url,
          is_primary: videoForm.make_primary ? 1 : 0,
        }),
      });

      setVideoForm({ subject_id: "", video_url: "", make_primary: false });
      const freshRaw = await tryFetchJson<unknown>("/teacher/videos");
      setVideos(asArray<TeacherVideoRow>(freshRaw));
      setSoftMsg(lang === "ar" ? "تم إضافة الفيديو." : "Video added.");
    } catch (e: unknown) {
      setSoftMsg(
        e instanceof Error
          ? e.message
          : lang === "ar"
          ? "فشل إضافة الفيديو."
          : "Failed to add video."
      );
    }
  }, [fetchJson, lang, tryFetchJson, videoForm]);

  const setPrimaryVideo = useCallback(
    async (videoId: number) => {
      try {
        await fetchJson(`/teacher/videos/${videoId}/primary`, {
          method: "PATCH",
        });
        const freshRaw = await tryFetchJson<unknown>("/teacher/videos");
        setVideos(asArray<TeacherVideoRow>(freshRaw));
      } catch (e: unknown) {
        setSoftMsg(
          e instanceof Error
            ? e.message
            : lang === "ar"
            ? "فشل تعيين الفيديو الأساسي."
            : "Failed to set primary video."
        );
      }
    },
    [fetchJson, lang, tryFetchJson]
  );

  const deleteVideo = useCallback(
    async (videoId: number) => {
      try {
        await fetchJson(`/teacher/videos/${videoId}`, { method: "DELETE" });
        const freshRaw = await tryFetchJson<unknown>("/teacher/videos");
        setVideos(asArray<TeacherVideoRow>(freshRaw));
      } catch (e: unknown) {
        setSoftMsg(
          e instanceof Error
            ? e.message
            : lang === "ar"
            ? "فشل حذف الفيديو."
            : "Failed to delete video."
        );
      }
    },
    [fetchJson, lang, tryFetchJson]
  );

  // ---------------------------------------------------------------------------
  // Profile Management
  // ---------------------------------------------------------------------------

  const saveProfile = useCallback(async () => {
    try {
      await fetchJson(`/teacher/me`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: profileForm.name.trim() ? profileForm.name.trim() : null,
          bio_short: profileForm.bio_short.trim()
            ? profileForm.bio_short.trim()
            : null,
          phone: profileForm.phone.trim() ? profileForm.phone.trim() : null,
          photo_url: profileForm.photo_url.trim()
            ? profileForm.photo_url.trim()
            : null,
        }),
      });

      setSoftMsg(lang === "ar" ? "تم تحديث الملف الشخصي." : "Profile updated.");
      const fresh = await tryFetchJson<TeacherProfile | null>("/teacher/me");
      if (fresh) setProfile(fresh);
    } catch (e: unknown) {
      setSoftMsg(
        e instanceof Error
          ? e.message
          : lang === "ar"
          ? "فشل تحديث الملف الشخصي."
          : "Failed to update profile."
      );
    }
  }, [fetchJson, lang, profileForm, tryFetchJson]);

  // ---------------------------------------------------------------------------
  // Filtered Data (Search Implementation)
  // ---------------------------------------------------------------------------

  const filteredStudents = useMemo(() => {
    const q = dqStudents.trim().toLowerCase();
    if (!q) return students;
    return students.filter((s) =>
      `${s.student_name} ${s.student_email} ${s.subject_name_en} ${s.subject_name_ar}`
        .toLowerCase()
        .includes(q)
    );
  }, [dqStudents, students]);

  const filteredSessions = useMemo(() => {
    const q = dqSessions.trim().toLowerCase();
    if (!q) return sessionsAll;
    return sessionsAll.filter((s) =>
      `${s.subject_name_en} ${s.subject_name_ar} ${s.status} ${s.starts_at}`
        .toLowerCase()
        .includes(q)
    );
  }, [dqSessions, sessionsAll]);

  const filteredHomework = useMemo(() => {
    const q = dqHomework.trim().toLowerCase();
    if (!q) return homework;
    return homework.filter((h) =>
      `${h.title} ${h.subject_name_en} ${h.subject_name_ar}`
        .toLowerCase()
        .includes(q)
    );
  }, [dqHomework, homework]);

  const filteredQuizzes = useMemo(() => {
    const q = dqQuizzes.trim().toLowerCase();
    if (!q) return quizzes;
    return quizzes.filter((z) =>
      `${z.title} ${z.subject_name_en} ${z.subject_name_ar}`
        .toLowerCase()
        .includes(q)
    );
  }, [dqQuizzes, quizzes]);

  // ---------------------------------------------------------------------------
  // Hook Return Value (Public API)
  // ---------------------------------------------------------------------------
  return {
    // Core state
    loading,
    fatalError,
    softMsg,
    setSoftMsg,

    // Data
    profile,
    students,
    sessionsToday,
    sessionsAll,
    homework,
    quizzes,
    scheduleSlots,
    slotOfferings,
    slotOfferingsMap,
    gradeCatalog,
    teacherSubjects,
    exceptions,
    videos,

    // ========== Lesson Requests ==========
    pendingLessonRequests,
    lessonRequestsLoading,
    lessonRequestsError,
    loadLessonRequests,
    approveLessonRequest,
    rejectLessonRequest,
    cancelScheduledSession,

    // ========== MESSAGES: Notifications (camelCase) ==========
    notificationsInbox,
    notificationsLoading,
    notificationsError,
    loadNotifications,
    markNotificationRead,
    markAllNotificationsRead,

    // ========== MESSAGES: Announcements (camelCase) ==========
    announcements,
    announcementsLoading,
    announcementsError,
    loadAnnouncements,

    // UI state
    activeTab,
    setActiveTab,

    // Overview stats (includes message counts)
    overview,

    // Core loading
    loadCore,
    loadSlotOfferings,
    loadTeacherSubjects,
    loadGradeCatalog,

    // Session management
    sessionDetailsOpen,
    sessionDetailsLoading,
    sessionDetails,
    openSessionDetails,
    closeSessionDetails,
    updateAttendance,

    // Homework management
    homeworkModalOpen,
    editHomework,
    openCreateHomework,
    openEditHomework,
    closeHomeworkModal,
    saveHomework,

    // Quiz management
    quizModalOpen,
    editQuiz,
    openCreateQuiz,
    openEditQuiz,
    closeQuizModal,
    saveQuiz,

    // Submissions & grading
    submissionsOpen,
    submissionsTitle,
    submissionsLoading,
    homeworkSubmissions,
    quizSubmissions,
    openHomeworkSubmissions,
    openQuizSubmissions,
    closeSubmissions,

    gradeModalOpen,
    gradeTarget,
    openGrade,
    closeGrade,
    saveGrade,

    // Schedule management
    slotForm,
    setSlotForm,
    createSlot,
    toggleSlotActive,
    deleteSlot,
    offeringsModalOpen,
    activeOfferingScheduleId,
    activeOfferingScheduleSlot,
    offeringsLoading,
    offeringsSaving,
    offeringsError,
    openOfferingsModal,
    closeOfferingsModal,
    saveSlotOfferings,
    getOfferingsForSlot,
    getSlotStatus,
    buildOfferingSummary,

    // Exception management
    exForm,
    setExForm,
    createException,
    toggleExceptionActive,
    deleteException,

    // Video management
    videoForm,
    setVideoForm,
    addVideo,
    setPrimaryVideo,
    deleteVideo,

    // Profile management
    profileForm,
    setProfileForm,
    saveProfile,

    // Search
    qStudents,
    setQStudents,
    qSessions,
    setQSessions,
    qHomework,
    setQHomework,
    qQuizzes,
    setQQuizzes,

    // Filtered data
    filteredStudents,
    filteredSessions,
    filteredHomework,
    filteredQuizzes,
  };
}
