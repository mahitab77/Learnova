// src/app/student/dashboard/page.tsx
"use client";

/**
 * Student Dashboard — page.tsx
 * -----------------------------------------------------------------------------
 * ✅ ALL BUILD BLOCKERS RESOLVED (carried over from previous build):
 *
 * 1. ✅ API_BASE export fixed in src/lib/api.ts
 * 2. ✅ availabilitySubjects moved above dependent callbacks (TS2448/TS2454)
 * 3. ✅ allowedScheduleIds dead code removed from buildBookableSlots()
 * 4. ✅ Unused router import removed
 * 5. ✅ Unused user variable removed from useSession()
 * 6. ✅ loadPendingLessonRequests moved above requestLesson to fix hoisting issue
 *
 * ✅ PREVIOUS REQUIRED FIXES (carried over):
 * 1. ✅ Backward arrow for parent navigation (with improved fallback)
 * 2. ✅ Auth handling in getTeacherAvailability() aligned with apiFetch
 * 3. ✅ Improved scheduleId selection logic in buildBookableSlots()
 * 4. ✅ toIsoForBackend() made more robust
 * 5. ✅ Subject select now has placeholder option
 *
 * ✅ ESLint fixes (carried over):
 * 1. ✅ Removed all `any` type usage with proper TypeScript types
 *
 * ✅ NEW FIXES APPLIED IN THIS VERSION:
 *
 * Fix A — Close/reset modal state on auth failure
 *   A1. openTeacherRating: on NOT_AUTHENTICATED, reset ratingState, ratingTarget,
 *       and ratingData BEFORE setting globalError. Previously the modal/loading
 *       state was left hanging when the session expired mid-open.
 *   A2. saveTeacherRating: on NOT_AUTHENTICATED, call setRatingSaving(false)
 *       BEFORE setting globalError. Previously ratingSaving stayed true forever
 *       when auth failed during a save attempt.
 *
 * Fix B — Move rating action from Overview tab to Attendance tab
 *   B1. Overview → upcomingLessons list: replaced the outer <div> wrapper
 *       (which contained both the badge AND the conditional rate/rated button)
 *       with just the bare badge <span>. Rating no longer appears in Overview.
 *   B2. Attendance → lessons list: wrapped the bare badge <span> in a
 *       <div className="flex items-center gap-2"> and appended the same
 *       conditional rate/rated button block that was removed from Overview.
 *       Rating now lives exclusively in the Attendance tab, which is the
 *       correct conceptual home because eligibility is based on attendanceStatus.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";

import { useSearchParams, useRouter } from "next/navigation";
import {
  apiFetch as sharedApiFetch,
  clearCsrfToken,
} from "@/src/lib/api";
import type { ApiError } from "@/src/lib/api";
import {
  addCairoDays as sharedAddCairoDays,
  cairoDateKey,
  cairoDateKeyFromValue as sharedToLocalDateKey,
  cairoWeekdayMon1Sun7FromDateKey,
  formatCairoDateOnly as sharedFormatDateOnly,
  formatCairoDateTime as sharedFormatDateTime,
  formatCairoDayHeader as sharedFormatDayHeader,
  formatCairoTimeOnly as sharedFormatTimeOnly,
  parseCairoNaive,
  startOfCairoWeekMonday as sharedStartOfWeekMonday,
} from "@/src/lib/cairoTime";
import { useSession } from "@/src/hooks/useSession";
import { clearParentCsrfToken } from "@/src/services/parentService";

import { texts } from "./studentTexts";
import TeacherRatingModal from "./components/TeacherRatingModal";
import type {
  ApiResponse,
  Lang,
  ActiveTab,
  LoadState,
  StudentLangTexts,
  StudentDashboardData,
  DashboardSubject,
  DashboardLesson,
  AttendanceData,
  HomeworkItem,
  HomeworkDetail,
  QuizItem,
  QuizDetail,
  GradesData,
  Announcement,
  NotificationsData,
  NotificationItem,
  StudentProfileData,
  PendingLessonRequest,
  AvailabilityResponse,
  BookableSlot,
  WeeklySlot,
  SlotScope,
  TeacherAvailabilityException,
  SessionRatingData,
  SaveSessionRatingData,
} from "./studentTypes";

// =============================================================================
// Shared scheduling time contract
// =============================================================================
// src/lib/cairoTime.ts is the canonical frontend boundary for parsing and
// formatting naive lesson/session datetimes. Backend storage stays as
// "YYYY-MM-DD HH:MM:SS" Cairo wall-clock values; this page does not hardcode
// a fixed UTC offset anymore.
// Every date helper below must honour this — never rely on the browser locale.
// =============================================================================

// =============================================================================
// Small helpers (formatting / grouping)
// =============================================================================

function toIsoForBackend(value: string): string {
  const v = value.trim().replace(" ", "T");
  // If it's "YYYY-MM-DDTHH:MM" add ":00"
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return `${v}:00`;
  return v;
}

/** YYYY-MM-DD in Cairo time for any Date (replaces browser-local getDate). */
function dateToLocalKey(d: Date): string {
  return cairoDateKey(d);
}

function toLocalDateKey(value: string): string {
  return sharedToLocalDateKey(value);
}

function addDays(date: Date, days: number): Date {
  return sharedAddCairoDays(date, days);
}

/**
 * Extract a YYYY-MM-DD Cairo date key from a backend datetime string.
 * Backend strings are naive Cairo datetimes — the date portion is correct as-is.
 */


/**
 * Returns a Date representing midnight Cairo on the Monday of the week that
 * contains `date`.  Uses the Cairo date to determine the weekday so that
 * users in other timezones see the correct Cairo week.
 */
function startOfWeekMonday(date: Date): Date {
  return sharedStartOfWeekMonday(date);
  /*
  const dow = noon.getDay(); // 0=Sun … 6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  const mondayNoon = addDays(noon, diff);
  const mondayKey = cairoDateKey(mondayNoon);
  return new Date(`${mondayKey}T00:00:00+02:00`);
  */
}

/**
 * Format a time value as HH:MM in Cairo time.
 * Accepts:
 *  - naked Cairo datetime: "YYYY-MM-DD HH:MM:SS"
 *  - ISO with T: "YYYY-MM-DDTHH:MM"
 *  - pure time range: "HH:MM-HH:MM"
 *  - pure time: "HH:MM" or "HH:MM:SS"
 */
function formatTimeOnly(value: string | null | undefined, lang: Lang): string {
  return sharedFormatTimeOnly(value, lang === "ar" ? "ar-EG" : "en-GB");
  /*
  if (!value) return "";
  const v = value.trim();
  if (!v) return "";

  // Time range "HH:MM:SS-HH:MM:SS" — strip seconds and return as-is (already Cairo)
  const isRange = /^\d{2}:\d{2}(:\d{2})?-\d{2}:\d{2}(:\d{2})?$/.test(v);
  if (isRange) {
    const [a, b] = v.split("-");
    return `${a.slice(0, 5)} - ${b.slice(0, 5)}`;
  }

  const looksLikeDateTime = /^\d{4}-\d{2}-\d{2}/.test(v) || v.includes("T");

  let d: Date;
  if (looksLikeDateTime) {
    // Naive Cairo datetime from backend — anchor to Cairo offset
    d = parseCairoNaive(v);
  } else {
    // Pure time string — treat as a Cairo wall-clock time on an arbitrary date
    const timeOnly = /^\d{2}:\d{2}$/.test(v) ? `${v}:00` : v;
    d = new Date(`1970-01-01T${timeOnly}+02:00`);
  }

  if (Number.isNaN(d.getTime())) return "";

  return d.toLocaleTimeString(lang === "ar" ? "ar-EG" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: PLATFORM_TZ,
  });
  */
}

/** Format a "YYYY-MM-DD" Cairo date key as a long human-readable label. */
function formatDayHeader(dateKey: string, lang: Lang): string {
  return sharedFormatDayHeader(dateKey, lang === "ar" ? "ar-EG" : "en-GB");
  /*
  const d = new Date(`${dateKey}T12:00:00+02:00`); // noon Cairo — safe from any edge
  return d.toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: PLATFORM_TZ,
  });
  */
}

/** Returns "Today" / "Tomorrow" relative to the current Cairo date. */
function relativeDayLabel(dateKey: string, lang: Lang): string | null {
  const now = new Date();
  const todayKey = cairoDateKey(now);
  const tomorrowKey = cairoDateKey(addDays(now, 1));
  if (dateKey === todayKey) return lang === "ar" ? "اليوم" : "Today";
  if (dateKey === tomorrowKey) return lang === "ar" ? "غدًا" : "Tomorrow";
  return null;
}

/** Format a date value as a short date in Cairo time. */
function formatDateOnly(value: string | null, lang: Lang): string {
  return sharedFormatDateOnly(value, lang === "ar" ? "ar-EG" : "en-GB");
  /*
  if (!value) return "";
  const v = String(value).trim();
  if (!v) return "";
  const d = parseCairoNaive(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: PLATFORM_TZ,
  });
  */
}

/** Format a datetime value as weekday + time in Cairo time. */
function formatDateTime(value: string | null, lang: Lang): string {
  return sharedFormatDateTime(value, lang === "ar" ? "ar-EG" : "en-GB");
  /*
  if (!value) return "";
  const v = String(value).trim();
  if (!v) return "";
  const d = parseCairoNaive(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(lang === "ar" ? "ar-EG" : "en-GB", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: PLATFORM_TZ,
  });
  */
}

function teacherInitials(name: string) {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  const initials = parts.map((p) => p.charAt(0).toUpperCase()).join("");
  return initials || "T";
}

function lessonTitle(lesson: DashboardLesson, lang: Lang) {
  return lang === "ar"
    ? lesson.subjectNameAr || lesson.subjectNameEn || ""
    : lesson.subjectNameEn || lesson.subjectNameAr || "";
}

function sortByStartAsc(a: DashboardLesson, b: DashboardLesson) {
  return (
    parseCairoNaive(a.startsAt).getTime() -
    parseCairoNaive(b.startsAt).getTime()
  );
}

function groupLessonsByDay(lessons: DashboardLesson[], lang: Lang) {
  const map = new Map<string, DashboardLesson[]>();
  for (const l of lessons) {
    const key = toLocalDateKey(l.startsAt);
    const arr = map.get(key) ?? [];
    arr.push(l);
    map.set(key, arr);
  }
  const keys = Array.from(map.keys()).sort((a, b) => a.localeCompare(b));
  return keys.map((k) => ({
    dateKey: k,
    title: formatDayHeader(k, lang),
    rel: relativeDayLabel(k, lang),
    lessons: (map.get(k) ?? []).sort(sortByStartAsc),
  }));
}

function attendanceBadge(
  status: string,
  lang: Lang,
): { label: string; className: string } {
  switch (status) {
    case "scheduled":
      return {
        label: lang === "ar" ? "مجدول" : "Scheduled",
        className: "bg-sky-100 text-sky-700",
      };
    case "present":
      return {
        label: lang === "ar" ? "حاضر" : "Present",
        className: "bg-emerald-100 text-emerald-700",
      };
    case "absent":
      return {
        label: lang === "ar" ? "غائب" : "Absent",
        className: "bg-red-100 text-red-700",
      };
    case "late":
      return {
        label: lang === "ar" ? "متأخر" : "Late",
        className: "bg-amber-100 text-amber-700",
      };
    case "excused":
      return {
        label: lang === "ar" ? "بعذر" : "Excused",
        className: "bg-slate-100 text-slate-700",
      };
    case "cancelled":
    case "canceled":
      return {
        label: lang === "ar" ? "ملغي" : "Cancelled",
        className: "bg-slate-200 text-slate-700",
      };
    default:
      return {
        label: status || (lang === "ar" ? "غير معروف" : "Unknown"),
        className: "bg-slate-100 text-slate-700",
      };
  }
}

function lessonRequestBadge(
  status: PendingLessonRequest["status"],
  lang: Lang,
): { label: string; className: string } {
  switch (status) {
    case "pending":
      return {
        label: lang === "ar" ? "بانتظار الموافقة" : "Pending",
        className: "bg-amber-100 text-amber-700",
      };
    case "approved":
      return {
        label: lang === "ar" ? "موافق عليها" : "Approved",
        className: "bg-emerald-100 text-emerald-700",
      };
    case "rejected":
      return {
        label: lang === "ar" ? "مرفوضة" : "Rejected",
        className: "bg-red-100 text-red-700",
      };
    default:
      return {
        label: lang === "ar" ? "ملغاة" : "Cancelled",
        className: "bg-slate-100 text-slate-700",
      };
  }
}

/**
 * A lesson is rateable when the student was present or late.
 * The backend requires session status='completed', which is only set for
 * present/late attendance. Excused does not finalize the session to 'completed',
 * so the Rate button must not be shown for excused sessions.
 * "absent" and "scheduled" are always excluded.
 */
function canRateLesson(lesson: DashboardLesson): boolean {
  const status = String(lesson.attendanceStatus || "").toLowerCase();
  return status === "present" || status === "late";
}

// =============================================================================
// Teacher Availability Service Functions
// =============================================================================

function normalizeAvailabilityExceptionType(
  value: unknown,
): TeacherAvailabilityException["exception_type"] {
  return value === "unavailable" ? "unavailable" : "extra_available";
}

/**
 * Canonical backend weekday contract:
 * 1=Monday .. 7=Sunday.
 * Legacy Sunday=0 is normalized per row during the migration window.
 */
function normalizeAvailabilityWeekday(value: unknown): number | null {
  const weekday = Number(value);
  if (!Number.isFinite(weekday)) return null;

  const normalized = Math.trunc(weekday);
  if (normalized === 0) return 7;
  if (normalized >= 1 && normalized <= 7) return normalized;
  return null;
}

function normalizeAvailabilityResponse(
  raw: AvailabilityResponse,
): AvailabilityResponse {
  return {
    ...raw,
    slots: Array.isArray(raw.slots)
      ? raw.slots.flatMap((slot) => {
          const weekday = normalizeAvailabilityWeekday(slot.weekday);
          if (weekday == null) return [];
          return [{ ...slot, weekday }];
        })
      : [],
    exceptions: Array.isArray(raw.exceptions)
      ? raw.exceptions.map((ex) => ({
          ...ex,
          // Backward-compat boundary shim: legacy "available" is treated as the
          // canonical additive "extra_available" value.
          exception_type: normalizeAvailabilityExceptionType(ex.exception_type),
        }))
      : [],
  };
}

/**
 * Fetches teacher availability from the backend using session auth.
 */
async function getTeacherAvailability(params: {
  teacherId: number;
  subjectId: number;
  from?: string;
  to?: string;
  signal?: AbortSignal;
}): Promise<AvailabilityResponse> {
  const qs = new URLSearchParams();
  qs.set("teacherId", String(params.teacherId));
  qs.set("subjectId", String(params.subjectId));
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);

  const data = await apiFetch<AvailabilityResponse>({
    endpoint: `/student/teacher-availability?${qs.toString()}`,
    signal: params.signal,
  });

  return normalizeAvailabilityResponse(data);
}

function availabilityCacheKey(teacherId: number, subjectId: number): string {
  return `${teacherId}:${subjectId}`;
}

/**
 * Utility to check if two date ranges overlap.
 */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * Parse a naive Cairo SQL datetime string to a proper Date (UTC-correct).
 * Alias for parseCairoNaive for use inside buildBookableSlots.
 */
function parseSqlDT(s: string): Date {
  return parseCairoNaive(s);
}

// Extended interface for weekly slots that might carry a schedule_id field
interface WeeklySlotWithSchedule extends WeeklySlot {
  schedule_id?: number;
}

/**
 * Generate bookable slots for the next N days for a given subject.
 */
function buildBookableSlots(
  api: AvailabilityResponse,
  subjectId: number,
  daysAhead = 14,
): BookableSlot[] {
  const weekly = api.slots.filter((s) => s.is_active === 1);
  if (!weekly.length) return [];

  const busy = api.sessions
    .filter((s) => s.status !== "cancelled")
    .map((s) => ({
      start: parseSqlDT(s.starts_at),
      end: parseSqlDT(s.ends_at),
    }));

  const exByDate = new Map<string, TeacherAvailabilityException[]>();
  for (const ex of api.exceptions || []) {
    const d = ex.exception_date;
    if (!exByDate.has(d)) exByDate.set(d, []);
    exByDate.get(d)!.push(ex);
  }

  const now = new Date();
  const out: BookableSlot[] = [];

  for (let i = 0; i < daysAhead; i++) {
    const d = addDays(now, i);
    const ymd = dateToLocalKey(d);

    const cairoDow = cairoWeekdayMon1Sun7FromDateKey(ymd);
    if (cairoDow == null) continue;

    const todaysWeekly = weekly.filter((w) => w.weekday === cairoDow);
    if (!todaysWeekly.length) continue;

    for (const w of todaysWeekly) {
      const start = `${ymd} ${w.start_time}`;
      const end = `${ymd} ${w.end_time}`;

      const startDate = parseSqlDT(start);
      const endDate = parseSqlDT(end);

      if (endDate <= now) continue;

      const exList = exByDate.get(ymd) || [];
      const blockedByException = exList.some((ex) => {
        if (ex.exception_type !== "unavailable") return false;
        const exStart = parseSqlDT(`${ymd} ${ex.start_time}`);
        const exEnd = parseSqlDT(`${ymd} ${ex.end_time}`);
        return overlaps(startDate, endDate, exStart, exEnd);
      });
      if (blockedByException) continue;

      const blockedBySession = busy.some((b) =>
        overlaps(startDate, endDate, b.start, b.end),
      );
      if (blockedBySession) continue;

      const weeklySlot = w as WeeklySlotWithSchedule;
      const scheduleId = Number(weeklySlot.schedule_id);
      if (!Number.isFinite(scheduleId) || scheduleId <= 0) continue;

      const exactScopeMatch = api.slotScopes.find(
        (x: SlotScope) =>
          Number(x.subject_id) === subjectId &&
          Number(x.schedule_id) === scheduleId &&
          Number(x.is_active) === 1,
      );
      if (!exactScopeMatch) continue;

      out.push({
        scheduleId,
        subjectId,
        date: ymd,
        startsAt: start,
        endsAt: end,
        isGroup: Number(w.is_group) === 1,
        maxStudents: Number(w.max_students) || 1,
      });
    }
  }

  return out;
}

// =============================================================================
// Runtime-safe parsing helpers
// =============================================================================

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function asNumber(v: unknown, fallback: number | null = null): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function asBool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
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

function normalizeProfileResponse(raw: unknown): StudentProfileData {
  const empty: StudentProfileData = {
    user: { id: 0, fullName: "", email: "", preferredLang: null },
    student: {
      id: 0,
      systemId: null,
      stageId: null,
      gradeLevelId: null,
      gradeStage: null,
      gradeNumber: null,
      gender: null,
      onboardingCompleted: false,
    },
    parents: [],
  };

  if (!isRecord(raw)) return empty;

  const userRaw = isRecord(raw.user) ? raw.user : null;
  const studentRaw = isRecord(raw.student) ? raw.student : null;
  const parentsRaw = asArray(raw.parents).filter(isRecord);

  return {
    user: {
      id: asNumber(userRaw?.id, 0) ?? 0,
      fullName: asString(userRaw?.fullName, ""),
      email: asString(userRaw?.email, ""),
      preferredLang:
        typeof userRaw?.preferredLang === "string"
          ? userRaw.preferredLang
          : null,
    },
    student: {
      id: asNumber(studentRaw?.id, 0) ?? 0,
      systemId: asNumber(studentRaw?.systemId, null),
      stageId: asNumber(studentRaw?.stageId, null),
      gradeLevelId: asNumber(studentRaw?.gradeLevelId, null),
      gradeStage:
        typeof studentRaw?.gradeStage === "string"
          ? studentRaw.gradeStage
          : null,
      gradeNumber: asNumber(studentRaw?.gradeNumber, null),
      gender:
        studentRaw?.gender === "male" || studentRaw?.gender === "female"
          ? studentRaw.gender
          : null,
      onboardingCompleted: asBool(studentRaw?.onboardingCompleted, false),
    },
    parents: parentsRaw.map((p) => ({
      parentId: asNumber(p.parentId, 0) ?? 0,
      fullName: asString(p.fullName, ""),
      relationship:
        p.relationship === "mother" ||
        p.relationship === "father" ||
        p.relationship === "guardian"
          ? p.relationship
          : "guardian",
    })),
  };
}

// =============================================================================
// Centralized fetch wrapper
// =============================================================================

async function apiFetch<T>(args: {
  endpoint: string;
  signal?: AbortSignal;
  method?: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<T> {
  const { endpoint, signal, method = "GET", body, headers } = args;

  try {
    const json = await sharedApiFetch<unknown>(endpoint, {
      method,
      signal,
      headers: {
        ...(method === "POST" || method === "PATCH" || method === "PUT"
          ? { "Content-Type": "application/json" }
          : {}),
        ...(headers ?? {}),
      },
      body:
        method === "POST" || method === "PATCH" || method === "PUT"
          ? JSON.stringify(body ?? {})
          : undefined,
    });

    if (!isRecord(json) || json.success !== true || !("data" in json)) {
      throw new Error("Invalid API response shape.");
    }

    const api = json as ApiResponse<unknown>;
    return api.data as T;
  } catch (err) {
    if (isApiError(err) && (err.status === 401 || err.status === 403)) {
      throw new Error("NOT_AUTHENTICATED");
    }

    if (isApiError(err)) {
      throw new Error(err.message);
    }

    throw err instanceof Error ? err : new Error("Request failed.");
  }
}

// =============================================================================
// Schedule Panel Component
// =============================================================================

function SchedulePanel(props: {
  lang: Lang;
  t: StudentLangTexts;
  schedule: DashboardLesson[] | null;
  state: LoadState;
  onRefresh: () => void;
}) {
  const { lang, t, schedule, state, onRefresh } = props;
  const [view, setView] = useState<"upcoming" | "week">("upcoming");

  const lessons = useMemo(() => schedule ?? [], [schedule]);
  const upcomingGrouped = useMemo(
    () => groupLessonsByDay(lessons, lang),
    [lessons, lang],
  );

  const weekStart = useMemo(() => startOfWeekMonday(new Date()), []);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
  const weekDayKeys = useMemo(
    () => weekDays.map((d) => dateToLocalKey(d)),
    [weekDays],
  );

  const weekMap = useMemo(() => {
    const map = new Map<string, DashboardLesson[]>();
    for (const k of weekDayKeys) map.set(k, []);
    for (const l of lessons) {
      const key = toLocalDateKey(l.startsAt);
      if (map.has(key)) map.get(key)!.push(l);
    }
    for (const k of weekDayKeys) map.get(k)!.sort(sortByStartAsc);
    return map;
  }, [lessons, weekDayKeys]);

  const totalThisWeek = useMemo(() => {
    return weekDayKeys.reduce(
      (sum, k) => sum + (weekMap.get(k)?.length ?? 0),
      0,
    );
  }, [weekDayKeys, weekMap]);

  return (
    <section className="rounded-3xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-100">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            {t.tabs.schedule}
          </h2>
          <p className="mt-1 text-[11px] text-slate-500">
            {lang === "ar"
              ? "عرض جدولك كقائمة أو كأسبوع."
              : "View your schedule as a list or a full week."}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-full bg-slate-100 p-1 text-[11px]">
            <button
              type="button"
              onClick={() => setView("upcoming")}
              className={`rounded-full px-3 py-1 font-medium transition ${
                view === "upcoming"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {lang === "ar" ? "قائمة" : "List"}
            </button>
            <button
              type="button"
              onClick={() => setView("week")}
              className={`rounded-full px-3 py-1 font-medium transition ${
                view === "week"
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {lang === "ar" ? "أسبوع" : "Week"}
            </button>
          </div>

          <button
            type="button"
            onClick={onRefresh}
            className="rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
            disabled={state.loading}
          >
            {state.loading
              ? lang === "ar"
                ? "…جاري"
                : "…Loading"
              : lang === "ar"
                ? "تحديث"
                : "Refresh"}
          </button>
        </div>
      </div>

      {state.error && <p className="text-xs text-red-600">{state.error}</p>}

      {!state.loading && lessons.length === 0 && !state.error && (
        <p className="text-xs text-slate-500">{t.sections.noLessons}</p>
      )}

      {lessons.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-600">
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">
            {lang === "ar"
              ? `هذا الأسبوع: ${totalThisWeek} حصة`
              : `This week: ${totalThisWeek} lessons`}
          </span>
          <span className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-700">
            {lang === "ar" ? "التوقيت: القاهرة" : "Cairo time"}
          </span>
        </div>
      )}

      {view === "upcoming" && lessons.length > 0 && (
        <div className="space-y-4">
          {upcomingGrouped.map((day) => (
            <div key={day.dateKey} className="rounded-2xl bg-slate-50/70 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="text-xs font-semibold text-slate-900">
                    {day.title}
                  </div>
                  {day.rel && (
                    <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-medium text-slate-700 ring-1 ring-slate-200">
                      {day.rel}
                    </span>
                  )}
                </div>
                <span className="text-[10px] text-slate-500">
                  {lang === "ar"
                    ? `${day.lessons.length} حصة`
                    : `${day.lessons.length} lessons`}
                </span>
              </div>

              <div className="space-y-2">
                {day.lessons.map((lesson) => {
                  const badge = attendanceBadge(lesson.attendanceStatus, lang);
                  return (
                    <div
                      key={lesson.sessionId}
                      className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 shadow-sm ring-1 ring-slate-100"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <div className="shrink-0 rounded-lg bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700">
                          {formatTimeOnly(lesson.startsAt, lang)} –{" "}
                          {formatTimeOnly(lesson.endsAt, lang)}
                        </div>

                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold text-slate-900">
                            {lessonTitle(lesson, lang)}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                            <div className="flex items-center gap-2">
                              {lesson.teacherPhotoUrl ? (
                                <Image
                                  src={lesson.teacherPhotoUrl}
                                  alt={lesson.teacherName}
                                  width={20}
                                  height={20}
                                  className="h-5 w-5 rounded-full object-cover ring-1 ring-slate-200"
                                />
                              ) : (
                                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-700">
                                  {teacherInitials(lesson.teacherName)}
                                </div>
                              )}
                              <span className="truncate">
                                {lesson.teacherName}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>

                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.className}`}
                      >
                        {badge.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === "week" && lessons.length > 0 && (
        <div className="overflow-x-auto pb-2">
          <div className="grid min-w-[820px] grid-cols-7 gap-3">
            {weekDayKeys.map((key) => {
              const dayTitle = formatDayHeader(key, lang);
              const rel = relativeDayLabel(key, lang);
              const dayLessons = weekMap.get(key) ?? [];

              return (
                <div
                  key={key}
                  className="rounded-2xl bg-slate-50/70 p-3 ring-1 ring-slate-100"
                >
                  <div className="mb-2">
                    <div className="text-[11px] font-semibold text-slate-900">
                      {dayTitle}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500">
                      <span>{rel ?? ""}</span>
                      <span>{dayLessons.length}</span>
                    </div>
                  </div>

                  {dayLessons.length === 0 ? (
                    <div className="rounded-xl bg-white px-2 py-2 text-[10px] text-slate-400 ring-1 ring-slate-100">
                      {lang === "ar" ? "لا توجد حصص" : "No lessons"}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {dayLessons.map((lesson) => {
                        const badge = attendanceBadge(
                          lesson.attendanceStatus,
                          lang,
                        );
                        return (
                          <div
                            key={lesson.sessionId}
                            className="rounded-xl bg-white px-2 py-2 ring-1 ring-slate-100"
                          >
                            <div className="text-[10px] font-semibold text-emerald-700">
                              {formatTimeOnly(lesson.startsAt, lang)} –{" "}
                              {formatTimeOnly(lesson.endsAt, lang)}
                            </div>
                            <div className="mt-0.5 truncate text-[11px] font-semibold text-slate-900">
                              {lessonTitle(lesson, lang)}
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-2">
                              <div className="truncate text-[10px] text-slate-500">
                                {lesson.teacherName}
                              </div>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.className}`}
                              >
                                {badge.label}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

// =============================================================================
// Main Component
// =============================================================================

function StudentDashboardPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const langParam = searchParams.get("lang");
  const lang: Lang = langParam === "ar" ? "ar" : "en";

  const onBackToParent = useCallback(async () => {
    try {
      await apiFetch<unknown>({
        endpoint: "/parent/switch-back",
        method: "POST",
        body: {},
      });
      clearCsrfToken();
      clearParentCsrfToken();
      window.dispatchEvent(new Event("auth:changed"));
      router.replace(`/parent/dashboard?lang=${lang}&tab=children`);
      router.refresh();
    } catch (err) {
      console.log("Failed to switch back to parent:", err);
      router.back();
    }
  }, [router, lang]);

  const t: StudentLangTexts = texts[lang];
  const direction = lang === "ar" ? "rtl" : "ltr";

  const fromParam = searchParams.get("from");
  const {
    loading: sessionLoading,
    authenticated,
    switchContext,
  } = useSession();
  const openedFromParent =
    switchContext?.mode === "as_student" || fromParam === "parent";

  const notLoggedInError = !authenticated ? t.notLoggedIn : null;

  // ---------------------------------------------------------------------------
  // Mounted ref — ignore late async resolves after unmount
  // ---------------------------------------------------------------------------
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // AbortController manager
  // ---------------------------------------------------------------------------
  const controllersRef = useRef<Record<string, AbortController | null>>({});
  const startRequest = useCallback((key: string) => {
    controllersRef.current[key]?.abort();
    const controller = new AbortController();
    controllersRef.current[key] = controller;
    return controller.signal;
  }, []);

  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const key of Object.keys(controllers)) {
        controllers[key]?.abort();
        controllers[key] = null;
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------------------
  const [activeTab, setActiveTab] = useState<ActiveTab>("overview");
  const [globalError, setGlobalError] = useState<string | null>(null);

  const [overviewData, setOverviewData] = useState<StudentDashboardData | null>(null);
  const [overviewState, setOverviewState] = useState<LoadState>({ loading: false, error: null });

  const [subjects, setSubjects] = useState<DashboardSubject[] | null>(null);
  const [subjectsState, setSubjectsState] = useState<LoadState>({ loading: false, error: null });

  const [schedule, setSchedule] = useState<DashboardLesson[] | null>(null);
  const [scheduleState, setScheduleState] = useState<LoadState>({ loading: false, error: null });

  const [attendanceData, setAttendanceData] = useState<AttendanceData | null>(null);
  const [attendanceState, setAttendanceState] = useState<LoadState>({ loading: false, error: null });

  const [homeworkList, setHomeworkList] = useState<HomeworkItem[] | null>(null);
  const [homeworkState, setHomeworkState] = useState<LoadState>({ loading: false, error: null });
  const [selectedHomework, setSelectedHomework] = useState<HomeworkDetail | null>(null);
  const [homeworkDetailState, setHomeworkDetailState] = useState<LoadState>({ loading: false, error: null });

  const [quizList, setQuizList] = useState<QuizItem[] | null>(null);
  const [quizState, setQuizState] = useState<LoadState>({ loading: false, error: null });
  const [selectedQuiz, setSelectedQuiz] = useState<QuizDetail | null>(null);
  const [quizDetailState, setQuizDetailState] = useState<LoadState>({ loading: false, error: null });

  const [gradesData, setGradesData] = useState<GradesData | null>(null);
  const [gradesState, setGradesState] = useState<LoadState>({ loading: false, error: null });

  const [announcements, setAnnouncements] = useState<Announcement[] | null>(null);
  const [announcementsState, setAnnouncementsState] = useState<LoadState>({ loading: false, error: null });

  const [notificationsData, setNotificationsData] = useState<NotificationsData | null>(null);
  const [notificationsState, setNotificationsState] = useState<LoadState>({ loading: false, error: null });

  const [profileData, setProfileData] = useState<StudentProfileData | null>(null);
  const [profileState, setProfileState] = useState<LoadState>({ loading: false, error: null });

  const [pendingRequests, setPendingRequests] = useState<PendingLessonRequest[] | null>(null);
  const [lessonReqState, setLessonReqState] = useState<LoadState>({ loading: false, error: null });

  const [selectedAvailabilitySubjectId, setSelectedAvailabilitySubjectId] = useState<number | null>(null);
  const [availabilityState, setAvailabilityState] = useState<LoadState>({ loading: false, error: null });
  const [availabilityRaw, setAvailabilityRaw] = useState<AvailabilityResponse | null>(null);
  const availabilityCacheRef = useRef<Map<string, AvailabilityResponse>>(new Map());

  const [confirmRequest, setConfirmRequest] = useState<{ show: boolean; slot: BookableSlot | null }>({
    show: false,
    slot: null,
  });

  // Rating modal state
  const [ratingTarget, setRatingTarget] = useState<DashboardLesson | null>(null);
  const [ratingData, setRatingData] = useState<SessionRatingData | null>(null);
  const [ratingState, setRatingState] = useState<LoadState>({ loading: false, error: null });
  const [ratingSaving, setRatingSaving] = useState<boolean>(false);
  // Local cache of session IDs the user has rated this session.
  // NOTE: this is intentionally local-only for v1. Sessions rated in a previous
  // browser session will show "Rate teacher" until the user opens the modal,
  // at which point the backend confirms the existing rating and we add the id here.
  const [ratedSessionIds, setRatedSessionIds] = useState<number[]>([]);

  // ---------------------------------------------------------------------------
  // Derived values — MUST be above any callback that depends on them
  // ---------------------------------------------------------------------------
  const availabilitySubjects = useMemo(() => {
    return subjects ?? overviewData?.subjects ?? [];
  }, [subjects, overviewData]);

  const selectedAvailabilityInfo = useMemo(() => {
    const subj = availabilitySubjects.find(
      (s) => s.subjectId === selectedAvailabilitySubjectId,
    );
    if (!subj) return null;
    const subjectName =
      (lang === "ar"
        ? subj.nameAr || subj.nameEn
        : subj.nameEn || subj.nameAr) ?? (lang === "ar" ? "المادة" : "Subject");
    const teacherName = subj.teacher?.name ?? (lang === "ar" ? "المدرس" : "Teacher");
    return { subjectName, teacherName };
  }, [availabilitySubjects, selectedAvailabilitySubjectId, lang]);

  const pendingOnlyRequests = useMemo(
    () => (pendingRequests ?? []).filter((r) => r.status === "pending"),
    [pendingRequests],
  );
  const pendingRequestsCount = pendingOnlyRequests.length;

  const CANCEL_CUTOFF_MS = 2 * 60 * 60 * 1000;
  const scheduledRequests = useMemo(
    () => (pendingRequests ?? []).filter((r) => r.status === "scheduled"),
    [pendingRequests],
  );

  const isCancelEligible = (r: PendingLessonRequest) => {
    if (!r.startsAt) return false;
    const start = parseCairoNaive(String(r.startsAt));
    return start.getTime() - Date.now() > CANCEL_CUTOFF_MS;
  };

  const cancelScheduledSession = useCallback(
    async (id: number) => {
      try {
        setLessonReqState({ loading: true, error: null });
        const signal = startRequest(`cancelScheduled:${id}`);
        await apiFetch<unknown>({
          endpoint: `/student/lessons/sessions/${id}/cancel`,
          method: "POST",
          body: {},
          signal,
        });
        if (!mountedRef.current) return;
        setPendingRequests((prev) => prev ? prev.filter((r) => r.id !== id) : prev);
        setLessonReqState({ loading: false, error: null });
      } catch (err) {
        if (!mountedRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLessonReqState({
          loading: false,
          error: err instanceof Error ? err.message : t.error,
        });
      }
    },
    [startRequest, t.error],
  );

  const subjectsCount = availabilitySubjects.length;
  const pendingHomeworkCount = overviewData?.pendingHomework?.length ?? 0;
  const pendingQuizzesCount = overviewData?.pendingQuizzes?.length ?? 0;
  const totalPending = pendingHomeworkCount + pendingQuizzesCount;
  const attendancePercentage = overviewData?.attendanceSummary?.percentage ?? 0;
  const nextLesson: DashboardLesson | undefined = overviewData?.upcomingLessons?.[0];

  const scheduleLessonsMemo = useMemo(() => schedule ?? [], [schedule]);
  const totalThisWeek = useMemo(() => {
    const ws = startOfWeekMonday(new Date());
    const keys = Array.from({ length: 7 }, (_, i) => dateToLocalKey(addDays(ws, i)));
    const counts = new Map<string, number>();
    for (const k of keys) counts.set(k, 0);
    for (const l of scheduleLessonsMemo) {
      const key = toLocalDateKey(l.startsAt);
      if (counts.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return keys.reduce((sum, k) => sum + (counts.get(k) ?? 0), 0);
  }, [scheduleLessonsMemo]);

  const withLang = useCallback(
    (path: string) => {
      const qs = new URLSearchParams();
      if (lang === "ar") qs.set("lang", "ar");
      if (openedFromParent) qs.set("from", "parent");
      const sep = path.includes("?") ? "&" : "?";
      const query = qs.toString();
      return query ? `${path}${sep}${query}` : path;
    },
    [lang, openedFromParent],
  );
  const onboardingHref = useMemo(() => withLang("/student/onboarding"), [withLang]);

  const bookableSlots = useMemo(() => {
    if (!availabilityRaw || !selectedAvailabilitySubjectId) return [];
    try {
      return buildBookableSlots(availabilityRaw, selectedAvailabilitySubjectId);
    } catch (err) {
      console.error("Failed to build bookable slots:", err);
      return [];
    }
  }, [availabilityRaw, selectedAvailabilitySubjectId]);

  // ---------------------------------------------------------------------------
  // Data loaders — depend on derived values above
  // ---------------------------------------------------------------------------

  const loadOverview = useCallback(async () => {
    if (overviewState.loading || overviewData) return;
    try {
      setOverviewState({ loading: true, error: null });
      const signal = startRequest("overview");
      const data = await apiFetch<StudentDashboardData>({
        endpoint: "/student/dashboard",
        signal,
      });
      if (!mountedRef.current) return;
      setOverviewData(data);
      setOverviewState({ loading: false, error: null });
      setGlobalError(null);
      if (!subjects && Array.isArray(data.subjects) && data.subjects.length > 0) {
        setSubjects(data.subjects);
        setSubjectsState({ loading: false, error: null });
      }
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setGlobalError(t.notLoggedIn);
        return;
      }
      const msg = err instanceof Error ? err.message : t.error;
      setOverviewState({ loading: false, error: msg });
      setGlobalError(msg);
    }
  }, [overviewState.loading, overviewData, startRequest, t.error, t.notLoggedIn, subjects]);

  const loadSubjects = useCallback(async (): Promise<DashboardSubject[] | null> => {
    if (subjectsState.loading || subjects) return subjects;
    try {
      setSubjectsState({ loading: true, error: null });
      const signal = startRequest("subjects");
      const data = await apiFetch<DashboardSubject[]>({
        endpoint: "/student/subjects",
        signal,
      });
      if (!mountedRef.current) return null;
      setSubjects(data);
      setSubjectsState({ loading: false, error: null });
      return data;
    } catch (err) {
      if (!mountedRef.current) return null;
      if (err instanceof DOMException && err.name === "AbortError") return null;
      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setGlobalError(t.notLoggedIn);
        return null;
      }
      const msg = err instanceof Error ? err.message : t.error;
      setSubjectsState({ loading: false, error: msg });
      return null;
    }
  }, [subjectsState.loading, subjects, startRequest, t.error, t.notLoggedIn]);

  const loadSchedule = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!opts?.force && (scheduleState.loading || schedule)) return;
      if (opts?.force && scheduleState.loading) return;
      try {
        setScheduleState({ loading: true, error: null });
        const signal = startRequest("schedule");
        const data = await apiFetch<DashboardLesson[]>({
          endpoint: "/student/schedule",
          signal,
        });
        if (!mountedRef.current) return;
        setSchedule(data);
        setScheduleState({ loading: false, error: null });
      } catch (err) {
        if (!mountedRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
          setGlobalError(t.notLoggedIn);
          return;
        }
        const msg = err instanceof Error ? err.message : t.error;
        setScheduleState({ loading: false, error: msg });
      }
    },
    [scheduleState.loading, schedule, startRequest, t.error, t.notLoggedIn],
  );

  // Declared before requestLesson because requestLesson calls it
  const loadPendingLessonRequests = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!opts?.force && pendingRequests) return;
      try {
        const signal = startRequest("pendingLessonRequests");
        const data = await apiFetch<PendingLessonRequest[]>({
          endpoint: "/student/lessons/requests/pending",
          signal,
        });
        if (!mountedRef.current) return;
        setPendingRequests(data);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Non-fatal — session expiration handled by other loaders
      }
    },
    [pendingRequests, startRequest],
  );

  const requestLesson = useCallback(
    async (slot: BookableSlot) => {
      const teacherId =
        availabilitySubjects.find((s) => s.subjectId === slot.subjectId)
          ?.teacher?.id ?? null;

      if (
        !teacherId ||
        teacherId <= 0 ||
        !slot.scheduleId ||
        !slot.subjectId ||
        !slot.startsAt ||
        !slot.endsAt
      ) {
        setLessonReqState({
          loading: false,
          error:
            lang === "ar"
              ? "بيانات الحجز غير مكتملة. الرجاء إعادة اختيار الموعد."
              : "Booking data is incomplete. Please re-select the time slot.",
        });
        return;
      }

      try {
        setLessonReqState({ loading: true, error: null });
        const signal = startRequest("requestLesson");
        const payload = {
          teacherId,
          subjectId: slot.subjectId,
          scheduleId: slot.scheduleId,
          startsAt: toIsoForBackend(slot.startsAt),
          endsAt: toIsoForBackend(slot.endsAt),
        };
        await apiFetch<unknown>({
          endpoint: "/student/lessons/request",
          method: "POST",
          body: payload,
          signal,
        });
        await loadSchedule({ force: true });
        await loadPendingLessonRequests({ force: true });
        if (!mountedRef.current) return;
        setLessonReqState({ loading: false, error: null });
        setConfirmRequest({ show: false, slot: null });
      } catch (err) {
        if (!mountedRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLessonReqState({
          loading: false,
          error: err instanceof Error ? err.message : t.error,
        });
      }
    },
    [lang, t.error, startRequest, loadSchedule, loadPendingLessonRequests, availabilitySubjects],
  );

  const loadAttendance = useCallback(async () => {
    if (attendanceState.loading || attendanceData) return;
    try {
      setAttendanceState({ loading: true, error: null });
      const signal = startRequest("attendance");
      const data = await apiFetch<AttendanceData>({
        endpoint: "/student/attendance",
        signal,
      });
      if (!mountedRef.current) return;
      setAttendanceData(data);
      setAttendanceState({ loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setGlobalError(t.notLoggedIn);
        return;
      }
      const msg = err instanceof Error ? err.message : t.error;
      setAttendanceState({ loading: false, error: msg });
    }
  }, [attendanceState.loading, attendanceData, startRequest, t.error, t.notLoggedIn]);

  const loadHomework = useCallback(async () => {
    if (homeworkState.loading || homeworkList) return;
    try {
      setHomeworkState({ loading: true, error: null });
      const signal = startRequest("homework");
      const data = await apiFetch<HomeworkItem[]>({
        endpoint: "/student/homework",
        signal,
      });
      if (!mountedRef.current) return;
      setHomeworkList(data);
      setHomeworkState({ loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setGlobalError(t.notLoggedIn);
        return;
      }
      const msg = err instanceof Error ? err.message : t.error;
      setHomeworkState({ loading: false, error: msg });
    }
  }, [homeworkState.loading, homeworkList, startRequest, t.error, t.notLoggedIn]);

  const loadHomeworkDetail = useCallback(
    async (id: number) => {
      try {
        setHomeworkDetailState({ loading: true, error: null });
        const signal = startRequest(`homeworkDetail:${id}`);
        const data = await apiFetch<HomeworkDetail>({
          endpoint: `/student/homework/${id}`,
          signal,
        });
        if (!mountedRef.current) return;
        setSelectedHomework(data);
        setHomeworkDetailState({ loading: false, error: null });
      } catch (err) {
        if (!mountedRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
          setGlobalError(t.notLoggedIn);
          return;
        }
        const msg = err instanceof Error ? err.message : t.error;
        setHomeworkDetailState({ loading: false, error: msg });
      }
    },
    [startRequest, t.error, t.notLoggedIn],
  );

  const loadQuizzes = useCallback(async () => {
    if (quizState.loading || quizList) return;
    try {
      setQuizState({ loading: true, error: null });
      const signal = startRequest("quizzes");
      const data = await apiFetch<QuizItem[]>({
        endpoint: "/student/quizzes",
        signal,
      });
      if (!mountedRef.current) return;
      setQuizList(data);
      setQuizState({ loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setGlobalError(t.notLoggedIn);
        return;
      }
      const msg = err instanceof Error ? err.message : t.error;
      setQuizState({ loading: false, error: msg });
    }
  }, [quizState.loading, quizList, startRequest, t.error, t.notLoggedIn]);

  const loadQuizDetail = useCallback(
    async (id: number) => {
      try {
        setQuizDetailState({ loading: true, error: null });
        const signal = startRequest(`quizDetail:${id}`);
        const data = await apiFetch<QuizDetail>({
          endpoint: `/student/quizzes/${id}`,
          signal,
        });
        if (!mountedRef.current) return;
        setSelectedQuiz(data);
        setQuizDetailState({ loading: false, error: null });
      } catch (err) {
        if (!mountedRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
          setGlobalError(t.notLoggedIn);
          return;
        }
        const msg = err instanceof Error ? err.message : t.error;
        setQuizDetailState({ loading: false, error: msg });
      }
    },
    [startRequest, t.error, t.notLoggedIn],
  );

  const loadGrades = useCallback(async () => {
    if (gradesState.loading || gradesData) return;
    try {
      setGradesState({ loading: true, error: null });
      const signal = startRequest("grades");
      const data = await apiFetch<GradesData>({
        endpoint: "/student/grades",
        signal,
      });
      if (!mountedRef.current) return;
      setGradesData(data);
      setGradesState({ loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setGlobalError(t.notLoggedIn);
        return;
      }
      const msg = err instanceof Error ? err.message : t.error;
      setGradesState({ loading: false, error: msg });
    }
  }, [gradesState.loading, gradesData, startRequest, t.error, t.notLoggedIn]);

  const loadAnnouncements = useCallback(async () => {
    if (announcementsState.loading || announcements) return;
    try {
      setAnnouncementsState({ loading: true, error: null });
      const signal = startRequest("announcements");
      const data = await apiFetch<Announcement[]>({
        endpoint: "/student/announcements",
        signal,
      });
      if (!mountedRef.current) return;
      setAnnouncements(data);
      setAnnouncementsState({ loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setGlobalError(t.notLoggedIn);
        return;
      }
      const msg = err instanceof Error ? err.message : t.error;
      setAnnouncementsState({ loading: false, error: msg });
    }
  }, [announcementsState.loading, announcements, startRequest, t.error, t.notLoggedIn]);

  const loadNotifications = useCallback(async () => {
    if (notificationsState.loading || notificationsData) return;
    try {
      setNotificationsState({ loading: true, error: null });
      const signal = startRequest("notifications");
      const data = await apiFetch<NotificationsData>({
        endpoint: "/student/notifications",
        signal,
      });
      if (!mountedRef.current) return;
      setNotificationsData(data);
      setNotificationsState({ loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setGlobalError(t.notLoggedIn);
        return;
      }
      const msg = err instanceof Error ? err.message : t.error;
      setNotificationsState({ loading: false, error: msg });
    }
  }, [notificationsState.loading, notificationsData, startRequest, t.error, t.notLoggedIn]);

  const loadProfile = useCallback(async () => {
    if (profileState.loading || profileData) return;
    try {
      setProfileState({ loading: true, error: null });
      const signal = startRequest("profile");
      const raw = await apiFetch<unknown>({
        endpoint: "/student/profile",
        signal,
      });
      const safe = normalizeProfileResponse(raw);
      if (!mountedRef.current) return;
      setProfileData(safe);
      setProfileState({ loading: false, error: null });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
        setGlobalError(t.notLoggedIn);
        return;
      }
      const msg = err instanceof Error ? err.message : t.error;
      setProfileState({ loading: false, error: msg });
    }
  }, [profileState.loading, profileData, startRequest, t.error, t.notLoggedIn]);

  const loadTeacherAvailability = useCallback(
    async (
      teacherId: number | null,
      subjectId: number | null,
      opts?: { force?: boolean },
    ) => {
      if (!teacherId || teacherId <= 0 || !subjectId || subjectId <= 0) {
        setAvailabilityRaw(null);
        return;
      }
      const cacheKey = availabilityCacheKey(teacherId, subjectId);
      const cached = availabilityCacheRef.current.get(cacheKey);
      if (cached && !opts?.force) {
        setAvailabilityRaw(cached);
        return;
      }
      try {
        setAvailabilityState({ loading: true, error: null });
        const signal = startRequest("availability");
        const data = await getTeacherAvailability({
          teacherId,
          subjectId,
          from: dateToLocalKey(new Date()),
          to: dateToLocalKey(addDays(new Date(), 14)),
          signal,
        });
        if (!mountedRef.current) return;
        availabilityCacheRef.current.set(cacheKey, data);
        setAvailabilityRaw(data);
        setAvailabilityState({ loading: false, error: null });
      } catch (err) {
        if (!mountedRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
          setGlobalError(t.notLoggedIn);
          return;
        }
        setAvailabilityState({
          loading: false,
          error: err instanceof Error ? err.message : t.error,
        });
      }
    },
    [t.error, t.notLoggedIn, startRequest],
  );

  const cancelLessonRequest = useCallback(
    async (id: number) => {
      try {
        setLessonReqState({ loading: true, error: null });
        const signal = startRequest(`cancelLesson:${id}`);
        await apiFetch<unknown>({
          endpoint: `/student/lessons/requests/${id}/cancel`,
          method: "POST",
          body: {},
          signal,
        });
        if (!mountedRef.current) return;
        setPendingRequests((prev) => prev ? prev.filter((r) => r.id !== id) : prev);
        setLessonReqState({ loading: false, error: null });
      } catch (err) {
        if (!mountedRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLessonReqState({
          loading: false,
          error: err instanceof Error ? err.message : t.error,
        });
      }
    },
    [startRequest, t.error],
  );

  // ---------------------------------------------------------------------------
  // Rating modal callbacks
  // ---------------------------------------------------------------------------

  const closeTeacherRatingModal = useCallback(() => {
    setRatingTarget(null);
    setRatingData(null);
    setRatingState({ loading: false, error: null });
    setRatingSaving(false);
  }, []);

  /**
   * Opens the rating modal for a given lesson and fetches any existing rating.
   *
   * FIX A1: On NOT_AUTHENTICATED, we now fully reset all modal state before
   * setting the global error. Previously the modal/loading state was left
   * hanging (ratingTarget set, ratingState.loading = true) with no way for the
   * user to dismiss the half-open modal.
   */
  const openTeacherRating = useCallback(
    async (lesson: DashboardLesson) => {
      try {
        setRatingTarget(lesson);
        setRatingData(null);
        setRatingState({ loading: true, error: null });

        const signal = startRequest(`lessonRating:${lesson.sessionId}`);
        const data = await apiFetch<SessionRatingData>({
          endpoint: `/student/lesson-sessions/${lesson.sessionId}/rating`,
          signal,
        });

        if (!mountedRef.current) return;

        setRatingData(data);
        setRatingState({ loading: false, error: null });

        // If the backend already has a rating, mark it locally so the button
        // shows "Rated" immediately without a second round-trip.
        if (data.rating) {
          setRatedSessionIds((prev) =>
            prev.includes(lesson.sessionId) ? prev : [...prev, lesson.sessionId],
          );
        }
      } catch (err) {
        if (!mountedRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;

        // FIX A1: Reset all modal state BEFORE setting the global error so the
        // modal is never left in a loading/half-open state on auth failure.
        if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
          setRatingState({ loading: false, error: null });
          setRatingTarget(null);
          setRatingData(null);
          setGlobalError(t.notLoggedIn);
          return;
        }

        setRatingState({
          loading: false,
          error: err instanceof Error ? err.message : t.error,
        });
      }
    },
    [startRequest, t.notLoggedIn, t.error],
  );

  /**
   * Saves (creates or updates) a teacher rating for the current ratingTarget.
   *
   * FIX A2: On NOT_AUTHENTICATED, we now call setRatingSaving(false) before
   * setting the global error. Previously ratingSaving was left as true forever,
   * meaning the save button appeared permanently disabled/loading.
   */
  const saveTeacherRating = useCallback(
    async (payload: { stars: number; comment: string }) => {
      if (!ratingTarget) return;

      try {
        setRatingSaving(true);
        setRatingState((prev) => ({ ...prev, error: null }));

        const signal = startRequest(`lessonRatingSave:${ratingTarget.sessionId}`);
        const data = await apiFetch<SaveSessionRatingData>({
          endpoint: `/student/lesson-sessions/${ratingTarget.sessionId}/rating`,
          method: "POST",
          body: {
            stars: payload.stars,
            comment: payload.comment.trim() ? payload.comment.trim() : null,
          },
          signal,
        });

        if (!mountedRef.current) return;

        setRatedSessionIds((prev) =>
          prev.includes(ratingTarget.sessionId)
            ? prev
            : [...prev, ratingTarget.sessionId],
        );

        setRatingData({
          canRate: true,
          editableUntil: ratingData?.editableUntil ?? null,
          rating: data.rating,
        });

        setRatingSaving(false);
        closeTeacherRatingModal();
      } catch (err) {
        if (!mountedRef.current) return;
        if (err instanceof DOMException && err.name === "AbortError") return;

        // FIX A2: Clear the saving spinner BEFORE setting the global error so
        // the save button is never permanently stuck in a loading state.
        if (err instanceof Error && err.message === "NOT_AUTHENTICATED") {
          setRatingSaving(false);
          setGlobalError(t.notLoggedIn);
          return;
        }

        setRatingSaving(false);
        setRatingState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : t.error,
        }));
      }
    },
    [ratingTarget, ratingData?.editableUntil, startRequest, t.notLoggedIn, t.error, closeTeacherRatingModal],
  );

  // ---------------------------------------------------------------------------
  // Booking helpers
  // ---------------------------------------------------------------------------

  const markNotificationRead = useCallback(
    async (id: number) => {
      try {
        const signal = startRequest(`notifRead:${id}`);
        await apiFetch<unknown>({
          endpoint: `/student/notifications/${id}/read`,
          method: "PATCH",
          body: {},
          signal,
        });
        if (!mountedRef.current) return;
        setNotificationsData((prev) => {
          if (!prev) return prev;
          const items = prev.items.map((n) => n.id === id ? { ...n, isRead: true } : n);
          return { unreadCount: items.filter((x) => !x.isRead).length, items };
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    },
    [startRequest],
  );

  const markAllNotificationsRead = useCallback(async () => {
    try {
      const signal = startRequest("notifReadAll");
      await apiFetch<unknown>({
        endpoint: "/student/notifications/read-all",
        method: "PATCH",
        body: {},
        signal,
      });
      if (!mountedRef.current) return;
      setNotificationsData((prev) => {
        if (!prev) return prev;
        const items = prev.items.map((n) => ({ ...n, isRead: true }));
        return { unreadCount: 0, items };
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }, [startRequest]);

  // ---------------------------------------------------------------------------
  // Initial load — triggered once session resolves
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (sessionLoading) return;
    if (!authenticated) return;
    const timer = window.setTimeout(() => {
      void loadOverview();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sessionLoading, authenticated, loadOverview]);

  // ---------------------------------------------------------------------------
  // Tab switching
  // ---------------------------------------------------------------------------
  const switchTab = useCallback(
    async (tab: ActiveTab) => {
      setActiveTab(tab);

      if (tab === "overview") { await loadOverview(); return; }
      if (tab === "subjects") { await loadSubjects(); return; }

      if (tab === "schedule") {
        const ensuredSubjects = await (async () => {
          if (subjects && subjects.length > 0) return subjects;
          if (overviewData?.subjects && overviewData.subjects.length > 0)
            return overviewData.subjects;
          const loaded = await loadSubjects();
          return loaded ?? [];
        })();

        await Promise.all([
          loadSchedule(),
          loadPendingLessonRequests({ force: true }),
        ]);

        const effectiveSubjectId =
          selectedAvailabilitySubjectId ?? ensuredSubjects[0]?.subjectId ?? null;

        if (effectiveSubjectId && effectiveSubjectId !== selectedAvailabilitySubjectId) {
          setSelectedAvailabilitySubjectId(effectiveSubjectId);
        }

        const teacherId =
          ensuredSubjects.find((s) => s.subjectId === (effectiveSubjectId ?? 0))
            ?.teacher?.id ?? null;

        if (teacherId) {
          await loadTeacherAvailability(teacherId, effectiveSubjectId);
        } else {
          setAvailabilityRaw(null);
        }
        return;
      }

      if (tab === "attendance") return void loadAttendance();
      if (tab === "homework") return void loadHomework();
      if (tab === "quizzes") return void loadQuizzes();
      if (tab === "grades") return void loadGrades();
      if (tab === "announcements") return void loadAnnouncements();
      if (tab === "notifications") return void loadNotifications();
      if (tab === "profile") return void loadProfile();
    },
    [
      subjects,
      overviewData,
      selectedAvailabilitySubjectId,
      loadOverview,
      loadSubjects,
      loadSchedule,
      loadPendingLessonRequests,
      loadTeacherAvailability,
      loadAttendance,
      loadHomework,
      loadQuizzes,
      loadGrades,
      loadAnnouncements,
      loadNotifications,
      loadProfile,
    ],
  );

  // ---------------------------------------------------------------------------
  // Tabs config
  // ---------------------------------------------------------------------------
  const tabsConfig: { id: ActiveTab; icon: string }[] = useMemo(
    () => [
      { id: "overview", icon: "🏠" },
      { id: "subjects", icon: "📚" },
      { id: "schedule", icon: "🗓️" },
      { id: "homework", icon: "✏️" },
      { id: "quizzes", icon: "🧠" },
      { id: "attendance", icon: "✅" },
      { id: "grades", icon: "📊" },
      { id: "announcements", icon: "📢" },
      { id: "notifications", icon: "🔔" },
      { id: "profile", icon: "👤" },
    ],
    [],
  );

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div
      className="min-h-screen bg-linear-to-b from-emerald-50 via-sky-50 to-white px-4 py-6 lg:px-10"
      dir={direction}
    >
      <TeacherRatingModal
        open={!!ratingTarget}
        lang={lang}
        t={t}
        lesson={ratingTarget}
        state={ratingData}
        loading={ratingState.loading}
        saving={ratingSaving}
        error={ratingState.error}
        onClose={closeTeacherRatingModal}
        onSubmit={saveTeacherRating}
      />

      {/* Lesson-request confirmation dialog */}
      {confirmRequest.show && confirmRequest.slot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow-xl">
            <h3 className="text-sm font-semibold text-slate-900">
              {lang === "ar" ? "تأكيد الطلب" : "Confirm Request"}
            </h3>
            <p className="mt-2 text-xs text-slate-600">
              {lang === "ar"
                ? "هل تريد طلب هذه الحصة؟"
                : "Do you want to request this lesson?"}
            </p>
            <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs">
              <div className="font-medium text-slate-900">
                {selectedAvailabilityInfo?.subjectName || "Subject"}
              </div>
              <div className="mt-1 text-slate-500">
                {formatDateOnly(confirmRequest.slot.date, lang)} ·{" "}
                {formatTimeOnly(confirmRequest.slot.startsAt, lang)}–
                {formatTimeOnly(confirmRequest.slot.endsAt, lang)}
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                {selectedAvailabilityInfo?.teacherName}
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRequest({ show: false, slot: null })}
                className="rounded-full bg-slate-200 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-300"
              >
                {lang === "ar" ? "إلغاء" : "Cancel"}
              </button>
              <button
                type="button"
                onClick={() =>
                  confirmRequest.slot && void requestLesson(confirmRequest.slot)
                }
                className="rounded-full bg-emerald-500 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
                disabled={lessonReqState.loading}
              >
                {lessonReqState.loading
                  ? lang === "ar" ? "...جارٍ الطلب" : "...Requesting"
                  : lang === "ar" ? "نعم، اطلب" : "Yes, Request"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="mx-auto flex max-w-6xl flex-col gap-6 md:flex-row">
        {/* ------------------------------------------------------------------ */}
        {/* LEFT SIDEBAR                                                        */}
        {/* ------------------------------------------------------------------ */}
        <aside className="w-full shrink-0 rounded-3xl bg-white/90 p-4 shadow-lg ring-1 ring-emerald-100 md:w-64">
          <div className="mb-3 flex items-center gap-3 rounded-2xl bg-linear-to-r from-[#F18A68]/20 via-emerald-50 to-sky-50 px-3 py-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500 text-sm font-bold text-white shadow-md">
              {overviewData?.user?.fullName
                ? overviewData.user.fullName.charAt(0).toUpperCase()
                : "S"}
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-semibold text-slate-800">
                {t.welcomePrefix} {overviewData?.user?.fullName || "Student"}
              </span>
              <span className="text-[11px] text-slate-500">{t.subtitle}</span>
            </div>
          </div>

          <nav className="mb-3 space-y-1">
            {tabsConfig.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => void switchTab(tab.id)}
                className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-xs font-medium transition ${
                  activeTab === tab.id
                    ? "bg-emerald-500 text-white shadow-md"
                    : "bg-transparent text-slate-700 hover:bg-emerald-50"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span>{tab.icon}</span>
                  <span>{t.tabs[tab.id]}</span>
                </span>

                {tab.id === "notifications" &&
                  (notificationsData?.unreadCount ?? 0) > 0 && (
                    <span className="rounded-full bg-white/20 px-2 py-0.5 text-[10px]">
                      {notificationsData?.unreadCount}
                    </span>
                  )}

                {tab.id === "schedule" && pendingRequestsCount > 0 && (
                  <span className="rounded-full bg-amber-500 px-2 py-0.5 text-[10px] text-white">
                    {pendingRequestsCount}
                  </span>
                )}
              </button>
            ))}
          </nav>

          <div className="mt-auto rounded-2xl bg-emerald-50/70 p-3 text-[11px]">
            <p className="mb-2 font-semibold text-emerald-800">
              {t.actions.manageSelections}
            </p>
            <Link
              href={onboardingHref}
              className="inline-flex items-center rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-600"
            >
              {t.actions.goToSelections}
            </Link>
          </div>
        </aside>

        {/* ------------------------------------------------------------------ */}
        {/* MAIN CONTENT                                                        */}
        {/* ------------------------------------------------------------------ */}
        <main className="min-w-0 flex-1 space-y-4">
          <header className="space-y-1">
            {openedFromParent && (
              <button
                type="button"
                onClick={onBackToParent}
                className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                aria-label={
                  lang === "ar"
                    ? "العودة إلى لوحة ولي الأمر"
                    : "Back to Parent Dashboard"
                }
                title={
                  lang === "ar"
                    ? "العودة إلى لوحة ولي الأمر"
                    : "Back to Parent Dashboard"
                }
              >
                ← {lang === "ar" ? "رجوع" : "Back"}
              </button>
            )}

            <h1 className="text-xl font-semibold text-slate-900">{t.title}</h1>
            <p className="text-xs text-slate-600">
              {overviewData?.student?.gradeStage
                ? `${t.gradeLabel} ${overviewData.student.gradeStage} ${overviewData.student.gradeNumber ?? ""}`
                : overviewData?.student?.gradeNumber
                  ? `${t.gradeLabel} ${overviewData.student.gradeNumber}`
                  : ""}
            </p>

            {(notLoggedInError || globalError) && (
              <div className="mt-2 rounded-2xl bg-red-50 p-3 text-xs text-red-800 ring-1 ring-red-200">
                {notLoggedInError || globalError}
              </div>
            )}

            {lessonReqState.error && (
              <div className="mt-2 rounded-2xl bg-amber-50 p-3 text-xs text-amber-800 ring-1 ring-amber-200">
                <p>{lessonReqState.error}</p>
                <p className="mt-1 text-[11px] text-amber-700">{t.sections.bookingRaceHint}</p>
                <button
                  type="button"
                  onClick={() => void switchTab("schedule")}
                  className="mt-2 rounded-full bg-amber-600 px-3 py-1 text-[11px] font-medium text-white hover:bg-amber-700"
                >
                  {t.sections.noLessonsAction}
                </button>
              </div>
            )}
          </header>

          {/* ================================================================ */}
          {/* OVERVIEW TAB                                                      */}
          {/* ================================================================ */}
          {activeTab === "overview" && (
            <>
              {!overviewData && overviewState.loading && (
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="h-24 animate-pulse rounded-2xl bg-white/70 shadow-sm ring-1 ring-slate-100" />
                  <div className="h-24 animate-pulse rounded-2xl bg-white/70 shadow-sm ring-1 ring-slate-100" />
                  <div className="h-24 animate-pulse rounded-2xl bg-white/70 shadow-sm ring-1 ring-slate-100" />
                  <div className="h-40 animate-pulse rounded-2xl bg-white/70 shadow-sm ring-1 ring-slate-100 md:col-span-3" />
                  <p className="text-xs text-slate-500 md:col-span-3">{t.loading}</p>
                </div>
              )}

              {overviewData && (
                <>
                  {/* Stats row */}
                  <section className="grid gap-4 md:grid-cols-3">
                    <div className="rounded-2xl bg-white/90 p-4 shadow-sm ring-1 ring-emerald-100">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-600">
                            {t.stats.subjects}
                          </div>
                          <div className="mt-1 flex items-baseline gap-1">
                            <span className="text-2xl font-bold text-slate-900">
                              {subjectsCount}
                            </span>
                          </div>
                        </div>
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-lg">
                          📚
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl bg-white/90 p-4 shadow-sm ring-1 ring-sky-100">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-sky-600">
                            {t.stats.attendance}
                          </div>
                          <div className="mt-1 flex items-baseline gap-1">
                            <span className="text-2xl font-bold text-slate-900">
                              {attendancePercentage}%
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] text-slate-500">
                            {lang === "ar" ? "آخر 30 يومًا" : "Last 30 days"}
                          </p>
                        </div>
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-50 text-lg">
                          🎯
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl bg-white/90 p-4 shadow-sm ring-1 ring-violet-100">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-violet-600">
                            {t.stats.todos}
                          </div>
                          <div className="mt-1 flex items-baseline gap-1">
                            <span className="text-2xl font-bold text-slate-900">
                              {totalPending}
                            </span>
                            <span className="text-[11px] text-slate-500">
                              {t.stats.todosSuffix}
                            </span>
                          </div>
                          <p className="mt-1 text-[11px] text-slate-500">
                            {lang === "ar"
                              ? `واجبات: ${pendingHomeworkCount} · اختبارات: ${pendingQuizzesCount}`
                              : `Homework: ${pendingHomeworkCount} · Quizzes: ${pendingQuizzesCount}`}
                          </p>
                          <p className="mt-1 text-[11px] text-slate-500">
                            {lang === "ar"
                              ? `حصص هذا الأسبوع: ${totalThisWeek}`
                              : `Lessons this week: ${totalThisWeek}`}
                          </p>
                        </div>
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-50 text-lg">
                          ✅
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* Upcoming lessons — FIX B1: rating button removed from here */}
                  <section className="space-y-4">
                    <div className="rounded-2xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-100">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <h2 className="text-sm font-semibold text-slate-900">
                          {t.sections.upcomingLessons}
                        </h2>
                        {nextLesson && (
                          <span className="rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-medium text-emerald-700">
                            {formatDateTime(nextLesson.startsAt, lang)}
                          </span>
                        )}
                      </div>

                      {(overviewData.upcomingLessons ?? []).length === 0 && (
                        <div className="space-y-2">
                          <p className="text-xs text-slate-500">{t.sections.noLessons}</p>
                          <button
                            type="button"
                            onClick={() => void switchTab("schedule")}
                            className="rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-600"
                          >
                            {t.sections.noLessonsAction}
                          </button>
                        </div>
                      )}

                      {(overviewData.upcomingLessons ?? []).length > 0 && (
                        <ul className="space-y-2">
                          {(overviewData.upcomingLessons ?? []).map((lesson) => {
                            const badge = attendanceBadge(lesson.attendanceStatus, lang);
                            return (
                              <li
                                key={lesson.sessionId}
                                className="flex items-start justify-between gap-3 rounded-xl bg-linear-to-r from-emerald-50 to-sky-50 px-3 py-2 text-xs"
                              >
                                <div className="flex flex-1 flex-col">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium text-slate-900">
                                      {lessonTitle(lesson, lang)}
                                    </span>
                                    <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] text-slate-600">
                                      {lesson.teacherName}
                                    </span>
                                  </div>
                                  <span className="mt-1 text-[11px] text-slate-500">
                                    {formatDateTime(lesson.startsAt, lang)}{" "}
                                    {t.labels.at}{" "}
                                    {formatTimeOnly(lesson.endsAt, lang)}
                                  </span>
                                </div>

                                {/*
                                  FIX B1: The outer <div> wrapper that previously
                                  contained both the badge and the rate/rated button
                                  has been replaced with just this bare badge <span>.
                                  Rating now belongs exclusively in the Attendance tab.
                                */}
                                <span
                                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.className}`}
                                >
                                  {badge.label}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  </section>
                </>
              )}
            </>
          )}

          {/* ================================================================ */}
          {/* SUBJECTS TAB                                                      */}
          {/* ================================================================ */}
          {activeTab === "subjects" && (
            <section className="rounded-3xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-100">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">
                  {t.sections.subjects}
                </h2>
                <button
                  type="button"
                  onClick={() => void loadSubjects()}
                  className="rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
                  disabled={subjectsState.loading}
                >
                  {subjectsState.loading
                    ? lang === "ar" ? "…جاري" : "…Loading"
                    : lang === "ar" ? "تحميل" : "Load"}
                </button>
              </div>

              {subjectsState.error && (
                <p className="text-xs text-red-600">{subjectsState.error}</p>
              )}

              {subjects && subjects.length === 0 && !subjectsState.loading && (
                <p className="text-xs text-slate-500">
                  {lang === "ar"
                    ? "لم يتم اختيار أي مواد بعد."
                    : "You haven't selected any subjects yet."}
                </p>
              )}

              {subjects && subjects.length > 0 && (
                <div className="grid gap-3 md:grid-cols-2">
                  {subjects.map((subj) => (
                    <div
                      key={subj.subjectId}
                      className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2 text-xs"
                    >
                      <div className="flex flex-col">
                        <span className="font-semibold text-slate-900">
                          {lang === "ar" ? subj.nameAr || subj.nameEn : subj.nameEn || subj.nameAr}
                        </span>
                        <span className="text-[11px] text-slate-500">
                          {subj.teacher?.name ?? (lang === "ar" ? "لا يوجد مدرس" : "No teacher yet")}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {subj.teacher?.primaryVideoUrl ? (
                          <span className="text-[13px]">🎥</span>
                        ) : null}
                        <span className="text-[10px] text-slate-500">
                          {subj.selectionStatus ?? ""}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ================================================================ */}
          {/* SCHEDULE TAB                                                      */}
          {/* ================================================================ */}
          {activeTab === "schedule" && (
            <>
              <SchedulePanel
                lang={lang}
                t={t}
                schedule={schedule}
                state={scheduleState}
                onRefresh={() => {
                  void loadSchedule({ force: true });
                }}
              />

              <section className="rounded-3xl bg-white/90 p-4 ring-1 ring-slate-100">
                <div className="mb-4">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {lang === "ar" ? "حجز حصص إضافية" : "Book Extra Lessons"}
                  </h3>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {lang === "ar"
                      ? "اختر وقتًا يناسبك لحصة إضافية مع مدرسك."
                      : "Choose a time that works for you for an extra lesson."}
                  </p>
                </div>

                {/* Step 1: Choose subject */}
                {availabilitySubjects.length > 0 && (
                  <div className="mb-4">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-white">
                        1
                      </span>
                      <label className="text-[11px] font-medium text-slate-900">
                        {lang === "ar" ? "اختر المادة" : "Choose your subject"}
                      </label>
                    </div>
                    <select
                      className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs"
                      value={selectedAvailabilitySubjectId ?? ""}
                      onChange={(e) => {
                        const v = e.target.value ? Number(e.target.value) : null;
                        setSelectedAvailabilitySubjectId(v);
                        const teacherId =
                          availabilitySubjects.find((s) => s.subjectId === (v ?? 0))
                            ?.teacher?.id ?? null;
                        void loadTeacherAvailability(teacherId, v);
                      }}
                    >
                      <option value="" disabled>
                        {lang === "ar" ? "اختر مادة..." : "Select a subject..."}
                      </option>
                      {availabilitySubjects.map((s) => (
                        <option key={s.subjectId} value={s.subjectId}>
                          {(lang === "ar"
                            ? s.nameAr || s.nameEn
                            : s.nameEn || s.nameAr) ?? "Subject"}{" "}
                          — {s.teacher?.name ?? (lang === "ar" ? "لا يوجد مدرس" : "No teacher")}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Action buttons */}
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void loadPendingLessonRequests({ force: true })}
                    className="rounded-full bg-slate-900 px-3 py-1 text-[11px] font-medium text-white hover:bg-slate-800 disabled:opacity-60"
                  >
                    {lang === "ar" ? "تحديث الطلبات" : "Refresh requests"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const teacherId =
                        availabilitySubjects.find(
                          (s) => s.subjectId === (selectedAvailabilitySubjectId ?? 0),
                        )?.teacher?.id ?? null;
                      void loadTeacherAvailability(
                        teacherId,
                        selectedAvailabilitySubjectId,
                        { force: true },
                      );
                    }}
                    className="rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
                    disabled={!selectedAvailabilitySubjectId}
                  >
                    {lang === "ar" ? "تحديث التوفر" : "Refresh availability"}
                  </button>
                </div>

                {/* Pending requests */}
                {pendingOnlyRequests.length > 0 && (
                  <div className="mb-4">
                    <h4 className="mb-2 text-xs font-medium text-slate-700">
                      {lang === "ar" ? "طلباتك قيد الانتظار" : "Your Pending Requests"}
                    </h4>
                    <div className="space-y-2 text-xs">
                      {pendingOnlyRequests.map((r) => {
                        const badge = lessonRequestBadge(r.status, lang);
                        const subjectLabel =
                          lang === "ar"
                            ? r.subjectNameAr || r.subjectNameEn || ""
                            : r.subjectNameEn || r.subjectNameAr || "";
                        const teacherLabel = r.teacherName || r.teacher?.name || "";
                        const dateKey =
                          r.date ?? (r.startsAt ? String(r.startsAt).slice(0, 10) : null);
                        const timeLabel = r.timeWindow
                          ? formatTimeOnly(r.timeWindow, lang)
                          : `${formatTimeOnly(r.startsAt ?? "", lang)}–${formatTimeOnly(r.endsAt ?? "", lang)}`;

                        return (
                          <div
                            key={r.id}
                            className="flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2"
                          >
                            <div className="flex-1">
                              <div className="font-medium text-slate-900">{subjectLabel}</div>
                              <div className="text-[11px] text-slate-500">
                                {teacherLabel}
                                {dateKey ? ` · ${formatDateOnly(dateKey, lang)}` : ""}
                                {timeLabel.trim() ? ` · ${timeLabel}` : ""}
                              </div>
                              <div className="mt-1 text-[10px]">
                                <span className={`rounded-full px-2 py-0.5 ${badge.className}`}>
                                  {badge.label}
                                </span>
                              </div>
                              {r.cancelReason ? (
                                <div className="mt-1 text-[10px] text-slate-600">
                                  {lang === "ar" ? "السبب:" : "Reason:"} {r.cancelReason}
                                </div>
                              ) : null}
                            </div>
                            <button
                              className="ml-2 rounded-full bg-red-500 px-2 py-1 text-[10px] font-medium text-white hover:bg-red-600 disabled:opacity-50"
                              onClick={() => void cancelLessonRequest(r.id)}
                              disabled={lessonReqState.loading}
                            >
                              {t.actions.cancelRequest}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {pendingOnlyRequests.length === 0 && pendingRequests && (
                  <div className="mb-4 text-xs text-slate-500">
                    {lang === "ar" ? "لا توجد طلبات قيد الانتظار." : "No pending requests."}
                  </div>
                )}

                {/* Scheduled sessions (cancellable) */}
                {scheduledRequests.length > 0 && (
                  <div className="mb-4">
                    <h4 className="mb-2 text-xs font-medium text-slate-700">
                      {lang === "ar" ? "حصصك المجدولة" : "Your Scheduled Sessions"}
                    </h4>
                    <div className="space-y-2 text-xs">
                      {scheduledRequests.map((r) => {
                        const subjectLabel =
                          lang === "ar"
                            ? r.subjectNameAr || r.subjectNameEn || ""
                            : r.subjectNameEn || r.subjectNameAr || "";
                        const teacherLabel = r.teacherName || r.teacher?.name || "";
                        const dateKey =
                          r.date ?? (r.startsAt ? String(r.startsAt).slice(0, 10) : null);
                        const timeLabel = r.timeWindow
                          ? formatTimeOnly(r.timeWindow, lang)
                          : `${formatTimeOnly(r.startsAt ?? "", lang)}–${formatTimeOnly(r.endsAt ?? "", lang)}`;
                        const eligible = isCancelEligible(r);

                        return (
                          <div
                            key={r.id}
                            className="flex items-center justify-between rounded-xl bg-sky-50 px-3 py-2"
                          >
                            <div className="flex-1">
                              <div className="font-medium text-slate-900">{subjectLabel}</div>
                              <div className="text-[11px] text-slate-500">
                                {teacherLabel}
                                {dateKey ? ` · ${formatDateOnly(dateKey, lang)}` : ""}
                                {timeLabel.trim() ? ` · ${timeLabel}` : ""}
                              </div>
                              <div className="mt-1 text-[10px]">
                                <span className="rounded-full bg-sky-100 px-2 py-0.5 text-sky-700">
                                  {lang === "ar" ? "مجدول" : "Scheduled"}
                                </span>
                              </div>
                            </div>
                            {eligible ? (
                              <button
                                className="ml-2 rounded-full bg-red-500 px-2 py-1 text-[10px] font-medium text-white hover:bg-red-600 disabled:opacity-50"
                                onClick={() => void cancelScheduledSession(r.id)}
                                disabled={lessonReqState.loading}
                              >
                                {lang === "ar" ? "إلغاء" : "Cancel"}
                              </button>
                            ) : (
                              <span className="ml-2 text-[10px] text-slate-400">
                                {lang === "ar" ? "لا يمكن الإلغاء" : "Cannot cancel"}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Step 2: Pick a time */}
                <div className="mt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-[10px] font-bold text-white">
                      2
                    </span>
                    <h4 className="text-xs font-medium text-slate-700">
                      {lang === "ar" ? "اختر وقتًا مناسبًا" : "Pick a time"}
                    </h4>
                  </div>

                  {selectedAvailabilityInfo && (
                    <div className="mb-3 rounded-lg bg-slate-50 px-3 py-2">
                      <p className="text-[11px] text-slate-700">
                        {lang === "ar"
                          ? `توافر ${selectedAvailabilityInfo.teacherName} — ${selectedAvailabilityInfo.subjectName}`
                          : `Available times for ${selectedAvailabilityInfo.teacherName} — ${selectedAvailabilityInfo.subjectName}`}
                      </p>
                    </div>
                  )}

                  {availabilityState.loading && (
                    <p className="text-xs text-slate-500">{t.loading}</p>
                  )}

                  {!availabilityState.loading && availabilityState.error && (
                    <div className="rounded-lg bg-red-50 p-3">
                      <p className="text-xs text-red-700">{availabilityState.error}</p>
                      <p className="mt-1 text-[11px] text-red-600">
                        {lang === "ar"
                          ? "حاول التحديث أو اختر مادة أخرى."
                          : "Try refreshing or select another subject."}
                      </p>
                    </div>
                  )}

                  {!availabilityState.loading && !availabilityState.error && !selectedAvailabilitySubjectId && (
                    <div className="rounded-lg bg-slate-50 p-3">
                      <p className="text-xs text-slate-500">
                        {lang === "ar"
                          ? "اختر مادة لعرض الأوقات المتاحة."
                          : "Pick a subject to see available times."}
                      </p>
                    </div>
                  )}

                  {!availabilityState.loading &&
                    !availabilityState.error &&
                    bookableSlots.length === 0 &&
                    selectedAvailabilitySubjectId && (
                      <div className="rounded-lg bg-slate-50 p-3">
                        <p className="text-xs text-slate-500">
                          {t.sections.noAvailability}
                        </p>
                        <p className="mt-1 text-[11px] text-slate-400">
                          {lang === "ar"
                            ? "لا توجد أوقات متاحة حالياً. حاول لاحقاً أو تحدث مع مدرسك."
                            : "No available times at the moment. Try later or talk to your teacher."}
                        </p>
                      </div>
                    )}

                  {bookableSlots.length > 0 && (
                    <>
                      <div className="mb-3 rounded-lg bg-emerald-50 px-3 py-2">
                        <p className="text-[11px] text-emerald-700">
                          {lang === "ar"
                            ? "🎉 هنا الأوقات المتاحة أدناه 👇"
                            : "🎉 Here are the available times 👇"}
                        </p>
                        <p className="mt-1 text-[10px] text-emerald-600">
                          {lang === "ar"
                            ? "جميع الأوقات بتوقيت القاهرة"
                            : "All times shown in Cairo time"}
                        </p>
                      </div>

                      <div className="grid gap-2 md:grid-cols-2">
                        {bookableSlots.map((slot) => {
                          return (
                            <div
                              key={`${slot.scheduleId}-${slot.date}-${slot.startsAt}`}
                              className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2 text-xs"
                            >
                              <div className="flex-1">
                                <div className="font-medium text-slate-900">
                                  {selectedAvailabilityInfo?.subjectName || "Subject"}
                                </div>
                                <div className="text-[11px] text-slate-500">
                                  {selectedAvailabilityInfo?.teacherName} ·{" "}
                                  {formatDateOnly(slot.date, lang)} ·{" "}
                                  {formatTimeOnly(slot.startsAt, lang)}–
                                  {formatTimeOnly(slot.endsAt, lang)}
                                </div>
                              </div>
                              <button
                                className="ml-2 rounded-full bg-emerald-500 px-3 py-1 text-[10px] font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
                                onClick={() => {
                                  setConfirmRequest({ show: true, slot });
                                }}
                                disabled={lessonReqState.loading}
                              >
                                {lang === "ar" ? "اطلب هذا الموعد" : "Request this time"}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </section>
            </>
          )}

          {/* ================================================================ */}
          {/* ATTENDANCE TAB                                                    */}
          {/* ================================================================ */}
          {activeTab === "attendance" && (
            <section className="space-y-4">
              {/* Summary card */}
              <div className="rounded-3xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-100">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-slate-900">
                    {t.sections.attendanceSummary}
                  </h2>
                  <button
                    type="button"
                    onClick={() => void loadAttendance()}
                    className="rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
                    disabled={attendanceState.loading}
                  >
                    {attendanceState.loading
                      ? lang === "ar" ? "…جاري" : "…Loading"
                      : lang === "ar" ? "تحميل" : "Load"}
                  </button>
                </div>

                {attendanceState.error && (
                  <p className="text-xs text-red-600">{attendanceState.error}</p>
                )}

                {attendanceData?.summary ? (
                  <div className="flex items-center gap-6 text-xs">
                    <div>
                      <div className="text-[11px] text-slate-500">
                        {lang === "ar" ? "الفترة" : "Period"}
                      </div>
                      <div className="text-sm font-semibold text-slate-900">
                        {attendanceData.summary.period}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">
                        {lang === "ar" ? "الحصص" : "Sessions"}
                      </div>
                      <div className="text-sm font-semibold text-slate-900">
                        {attendanceData.summary.presentCount}/
                        {attendanceData.summary.totalSessions}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-500">
                        {t.stats.attendance}
                      </div>
                      <div className="text-sm font-semibold text-emerald-700">
                        {attendanceData.summary.percentage}%
                      </div>
                    </div>
                  </div>
                ) : (
                  !attendanceState.loading && !attendanceState.error && (
                    <p className="text-xs text-slate-500">
                      {lang === "ar"
                        ? "لا يوجد ملخص حضور متاح حتى الآن."
                        : "No attendance summary available yet."}
                    </p>
                  )
                )}
              </div>

              {/* Lesson list — FIX B2: rating button added here */}
              <div className="rounded-3xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-100">
                <h2 className="mb-3 text-sm font-semibold text-slate-900">
                  {t.sections.attendanceLessons}
                </h2>

                {attendanceState.loading && (
                  <p className="text-xs text-slate-500">{t.loading}</p>
                )}

                {(attendanceData?.lessons ?? []).length === 0 && !attendanceState.loading && (
                  <p className="text-xs text-slate-500">{t.sections.noLessons}</p>
                )}

                {(attendanceData?.lessons ?? []).length > 0 && (
                  <div className="space-y-2 text-xs">
                    {(attendanceData?.lessons ?? []).map((lesson) => {
                      const badge = attendanceBadge(lesson.attendanceStatus, lang);
                      return (
                        <div
                          key={lesson.sessionId}
                          className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2"
                        >
                          <div className="flex flex-col">
                            <span className="font-medium text-slate-900">
                              {lessonTitle(lesson, lang)}
                            </span>
                            <span className="text-[11px] text-slate-500">
                              {lesson.teacherName}
                            </span>
                            <span className="text-[11px] text-slate-500">
                              {formatDateTime(lesson.startsAt, lang)}
                            </span>
                          </div>

                          {/*
                            FIX B2: Replaced the bare badge <span> with a flex
                            wrapper so the badge and the conditional rate/rated
                            button sit side-by-side. The rating button lives here
                            because canRateLesson() tests attendanceStatus, which
                            is the canonical data shown in this tab.
                          */}
                          <div className="flex items-center gap-2">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${badge.className}`}
                            >
                              {badge.label}
                            </span>

                            {canRateLesson(lesson) &&
                              (ratedSessionIds.includes(lesson.sessionId) ? (
                                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700">
                                  {t.rating.rated}
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="rounded-full bg-violet-500 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-violet-600"
                                  onClick={() => void openTeacherRating(lesson)}
                                >
                                  {t.actions.rateTeacher}
                                </button>
                              ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ================================================================ */}
          {/* HOMEWORK TAB                                                      */}
          {/* ================================================================ */}
          {activeTab === "homework" && (
            <section className="grid gap-4 lg:grid-cols-[2fr,1fr]">
              <div className="rounded-3xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-100">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-slate-900">
                    {t.tabs.homework}
                  </h2>
                  <button
                    type="button"
                    onClick={() => void loadHomework()}
                    className="rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
                    disabled={homeworkState.loading}
                  >
                    {homeworkState.loading
                      ? lang === "ar" ? "…جاري" : "…Loading"
                      : lang === "ar" ? "تحميل" : "Load"}
                  </button>
                </div>

                {homeworkState.error && (
                  <p className="text-xs text-red-600">{homeworkState.error}</p>
                )}

                {homeworkList && homeworkList.length === 0 && !homeworkState.loading && (
                  <p className="text-xs text-slate-500">{t.sections.noHomework}</p>
                )}

                {homeworkList && homeworkList.length > 0 && (
                  <div className="space-y-2 text-xs">
                    {homeworkList.map((hw) => (
                      <div
                        key={hw.id}
                        className="flex items-center justify-between rounded-xl bg-emerald-50/70 px-3 py-2"
                      >
                        <div className="flex flex-col">
                          <span className="font-medium text-slate-900">{hw.title}</span>
                          <span className="text-[11px] text-slate-500">
                            {lang === "ar"
                              ? hw.subjectNameAr || hw.subjectNameEn
                              : hw.subjectNameEn || hw.subjectNameAr}
                          </span>
                          <span className="text-[11px] text-emerald-700">
                            {t.labels.due}: {formatDateOnly(hw.dueAt, lang)}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="rounded-full bg-emerald-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-600"
                          onClick={() => void loadHomeworkDetail(hw.id)}
                        >
                          {t.actions.viewDetails}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-3xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-100 text-xs">
                <h3 className="mb-2 text-sm font-semibold text-slate-900">
                  {t.actions.viewDetails}
                </h3>
                {homeworkDetailState.loading && (
                  <p className="text-xs text-slate-500">{t.loading}</p>
                )}
                {homeworkDetailState.error && (
                  <p className="text-xs text-red-600">{homeworkDetailState.error}</p>
                )}
                {!homeworkDetailState.loading && !selectedHomework && (
                  <p className="text-xs text-slate-500">
                    {lang === "ar"
                      ? "اختر واجبًا من القائمة لعرض التفاصيل."
                      : "Select a homework item to view details."}
                  </p>
                )}
                {selectedHomework && (
                  <div className="space-y-1">
                    <div className="font-semibold text-slate-900">{selectedHomework.title}</div>
                    <div className="text-[11px] text-slate-500">
                      {lang === "ar"
                        ? selectedHomework.subjectNameAr || selectedHomework.subjectNameEn
                        : selectedHomework.subjectNameEn || selectedHomework.subjectNameAr}
                    </div>
                    <div className="text-[11px] text-emerald-700">
                      {t.labels.due}: {formatDateOnly(selectedHomework.dueAt, lang)}
                    </div>
                    {selectedHomework.description && (
                      <p className="mt-2 text-[11px] text-slate-600">
                        {selectedHomework.description}
                      </p>
                    )}
                    {selectedHomework.attachments && selectedHomework.attachments.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <div className="text-[11px] font-semibold text-slate-800">
                          {lang === "ar" ? "المرفقات" : "Attachments"}
                        </div>
                        <ul className="list-disc space-y-0.5 pl-4">
                          {selectedHomework.attachments.map((att) => (
                            <li key={att.id}>
                              <a
                                href={att.fileUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-[11px] text-emerald-700 underline"
                              >
                                {att.fileName}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ================================================================ */}
          {/* QUIZZES TAB                                                       */}
          {/* ================================================================ */}
          {activeTab === "quizzes" && (
            <section className="grid gap-4 lg:grid-cols-[2fr,1fr]">
              <div className="rounded-3xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-100">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-slate-900">
                    {t.tabs.quizzes}
                  </h2>
                  <button
                    type="button"
                    onClick={() => void loadQuizzes()}
                    className="rounded-full bg-violet-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-violet-600 disabled:opacity-60"
                    disabled={quizState.loading}
                  >
                    {quizState.loading
                      ? lang === "ar" ? "…جاري" : "…Loading"
                      : lang === "ar" ? "تحميل" : "Load"}
                  </button>
                </div>

                {quizState.error && (
                  <p className="text-xs text-red-600">{quizState.error}</p>
                )}

                {quizList && quizList.length === 0 && !quizState.loading && (
                  <p className="text-xs text-slate-500">{t.sections.noQuizzes}</p>
                )}

                {quizList && quizList.length > 0 && (
                  <div className="space-y-2 text-xs">
                    {quizList.map((quiz) => (
                      <div
                        key={quiz.id}
                        className="flex items-center justify-between rounded-xl bg-violet-50/80 px-3 py-2"
                      >
                        <div className="flex flex-col">
                          <span className="font-medium text-slate-900">{quiz.title}</span>
                          <span className="text-[11px] text-slate-500">
                            {lang === "ar"
                              ? quiz.subjectNameAr || quiz.subjectNameEn
                              : quiz.subjectNameEn || quiz.subjectNameAr}
                          </span>
                          <span className="text-[11px] text-violet-700">
                            {t.labels.due}: {formatDateOnly(quiz.availableUntil, lang)}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="rounded-full bg-violet-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-600"
                          onClick={() => void loadQuizDetail(quiz.id)}
                        >
                          {t.actions.viewDetails}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-3xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-100 text-xs">
                <h3 className="mb-2 text-sm font-semibold text-slate-900">
                  {t.actions.viewDetails}
                </h3>
                {quizDetailState.loading && (
                  <p className="text-xs text-slate-500">{t.loading}</p>
                )}
                {quizDetailState.error && (
                  <p className="text-xs text-red-600">{quizDetailState.error}</p>
                )}
                {!quizDetailState.loading && !selectedQuiz && (
                  <p className="text-xs text-slate-500">
                    {lang === "ar"
                      ? "اختر اختبارًا من القائمة لعرض التفاصيل."
                      : "Select a quiz to view details."}
                  </p>
                )}
                {selectedQuiz && (
                  <div className="space-y-1">
                    <div className="font-semibold text-slate-900">{selectedQuiz.title}</div>
                    <div className="text-[11px] text-slate-500">
                      {lang === "ar"
                        ? selectedQuiz.subjectNameAr || selectedQuiz.subjectNameEn
                        : selectedQuiz.subjectNameEn || selectedQuiz.subjectNameAr}
                    </div>
                    <div className="text-[11px] text-violet-700">
                      {t.labels.due}: {formatDateOnly(selectedQuiz.availableUntil, lang)}
                    </div>
                    {selectedQuiz.description && (
                      <p className="mt-2 text-[11px] text-slate-600">
                        {selectedQuiz.description}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ================================================================ */}
          {/* GRADES TAB                                                        */}
          {/* ================================================================ */}
          {activeTab === "grades" && (
            <section className="rounded-3xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-100">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">
                  {t.tabs.grades}
                </h2>
                <button
                  type="button"
                  onClick={() => void loadGrades()}
                  className="rounded-full bg-slate-900 px-3 py-1 text-[11px] font-medium text-white hover:bg-slate-800 disabled:opacity-60"
                  disabled={gradesState.loading}
                >
                  {gradesState.loading
                    ? lang === "ar" ? "…جاري" : "…Loading"
                    : lang === "ar" ? "تحميل" : "Load"}
                </button>
              </div>

              {gradesState.error && (
                <p className="text-xs text-red-600">{gradesState.error}</p>
              )}

              {gradesData && (
                <div className="grid gap-4 md:grid-cols-2 text-xs">
                  <div>
                    <h3 className="mb-1 text-xs font-semibold text-emerald-700">
                      {t.sections.homework}
                    </h3>
                    {gradesData.homework.length === 0 && (
                      <p className="text-[11px] text-slate-500">
                        {lang === "ar" ? "لا توجد درجات واجبات بعد." : "No homework grades yet."}
                      </p>
                    )}
                    {gradesData.homework.length > 0 && (
                      <ul className="space-y-1.5">
                        {gradesData.homework.map((g) => (
                          <li
                            key={g.assignmentId ?? `${g.title}-${g.gradedAt ?? ""}`}
                            className="flex items-center justify-between rounded-xl bg-emerald-50/70 px-3 py-1.5"
                          >
                            <div className="mr-2 flex-1">
                              <div className="font-medium text-slate-900">{g.title}</div>
                              <div className="text-[11px] text-slate-500">
                                {lang === "ar"
                                  ? g.subjectNameAr || g.subjectNameEn
                                  : g.subjectNameEn || g.subjectNameAr}
                              </div>
                            </div>
                            <div className="text-[11px] font-semibold text-emerald-700">
                              {g.score ?? "-"} / {g.maxScore ?? "-"}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <h3 className="mb-1 text-xs font-semibold text-violet-700">
                      {t.sections.quizzes}
                    </h3>
                    {gradesData.quizzes.length === 0 && (
                      <p className="text-[11px] text-slate-500">
                        {lang === "ar" ? "لا توجد درجات اختبارات بعد." : "No quiz grades yet."}
                      </p>
                    )}
                    {gradesData.quizzes.length > 0 && (
                      <ul className="space-y-1.5">
                        {gradesData.quizzes.map((g) => (
                          <li
                            key={g.quizId ?? `${g.title}-${g.gradedAt ?? ""}`}
                            className="flex items-center justify-between rounded-xl bg-violet-50/70 px-3 py-1.5"
                          >
                            <div className="mr-2 flex-1">
                              <div className="font-medium text-slate-900">{g.title}</div>
                              <div className="text-[11px] text-slate-500">
                                {lang === "ar"
                                  ? g.subjectNameAr || g.subjectNameEn
                                  : g.subjectNameEn || g.subjectNameAr}
                              </div>
                            </div>
                            <div className="text-[11px] font-semibold text-violet-700">
                              {g.score ?? "-"} / {g.maxScore ?? "-"}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* ================================================================ */}
          {/* ANNOUNCEMENTS TAB                                                 */}
          {/* ================================================================ */}
          {activeTab === "announcements" && (
            <section className="rounded-3xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-100">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">
                  {t.tabs.announcements}
                </h2>
                <button
                  type="button"
                  onClick={() => void loadAnnouncements()}
                  className="rounded-full bg-amber-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-amber-600 disabled:opacity-60"
                  disabled={announcementsState.loading}
                >
                  {announcementsState.loading
                    ? lang === "ar" ? "…جاري" : "…Loading"
                    : lang === "ar" ? "تحميل" : "Load"}
                </button>
              </div>

              {announcementsState.error && (
                <p className="text-xs text-red-600">{announcementsState.error}</p>
              )}

              {announcements && announcements.length === 0 && !announcementsState.loading && (
                <p className="text-xs text-slate-500">{t.sections.noAnnouncements}</p>
              )}

              {announcements && announcements.length > 0 && (
                <ul className="space-y-2 text-xs">
                  {announcements.map((ann) => (
                    <li key={ann.id} className="rounded-xl bg-amber-50 px-3 py-2">
                      <div className="font-medium text-slate-900">{ann.title}</div>
                      <div className="mt-0.5 text-[11px] text-slate-600">{ann.body}</div>
                      <div className="mt-1 text-[10px] text-amber-700">
                        {formatDateOnly(ann.createdAt, lang)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ================================================================ */}
          {/* NOTIFICATIONS TAB                                                 */}
          {/* ================================================================ */}
          {activeTab === "notifications" && (
            <section className="rounded-3xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-100">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-slate-900">
                  {t.tabs.notifications}
                </h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void loadNotifications()}
                    className="rounded-full bg-slate-900 px-3 py-1 text-[11px] font-medium text-white hover:bg-slate-800 disabled:opacity-60"
                    disabled={notificationsState.loading}
                  >
                    {notificationsState.loading
                      ? lang === "ar" ? "…جاري" : "…Loading"
                      : lang === "ar" ? "تحميل" : "Load"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void markAllNotificationsRead()}
                    className="rounded-full bg-emerald-500 px-3 py-1 text-[11px] font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
                    disabled={
                      (notificationsData?.unreadCount ?? 0) === 0 ||
                      notificationsState.loading
                    }
                    title={
                      (notificationsData?.unreadCount ?? 0) === 0
                        ? lang === "ar" ? "لا توجد إشعارات غير مقروءة" : "No unread notifications"
                        : undefined
                    }
                  >
                    {t.actions.markAllRead}
                  </button>
                </div>
              </div>

              {notificationsState.error && (
                <p className="text-xs text-red-600">{notificationsState.error}</p>
              )}

              {notificationsData &&
                notificationsData.items.length === 0 &&
                !notificationsState.loading && (
                  <p className="text-xs text-slate-500">{t.sections.noNotifications}</p>
                )}

              {notificationsData && notificationsData.items.length > 0 && (
                <ul className="space-y-2 text-xs">
                  {notificationsData.items.map((notif: NotificationItem) => (
                    <li
                      key={notif.id}
                      className={`rounded-xl px-3 py-2 ${notif.isRead ? "bg-slate-50" : "bg-emerald-50/80"}`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-medium text-slate-900">{notif.title}</div>
                          <div className="mt-0.5 text-[11px] text-slate-600">{notif.body}</div>
                          <div className="mt-1 text-[10px] text-slate-400">
                            {formatDateTime(notif.createdAt, lang)}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          {!notif.isRead && (
                            <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-medium text-white">
                              {t.sections.unreadBadge}
                            </span>
                          )}
                          {!notif.isRead && (
                            <button
                              type="button"
                              className="rounded-full bg-white px-2 py-0.5 text-[10px] text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-50"
                              onClick={() => void markNotificationRead(notif.id)}
                            >
                              {t.actions.markRead}
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ================================================================ */}
          {/* PROFILE TAB                                                       */}
          {/* ================================================================ */}
          {activeTab === "profile" && (
            <section className="rounded-3xl bg-white/90 p-4 shadow-sm ring-1 ring-slate-100">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-900">
                  {t.sections.profileInfo}
                </h2>
                <button
                  type="button"
                  onClick={() => void loadProfile()}
                  className="rounded-full bg-slate-900 px-3 py-1 text-[11px] font-medium text-white hover:bg-slate-800 disabled:opacity-60"
                  disabled={profileState.loading}
                >
                  {profileState.loading
                    ? lang === "ar" ? "…جاري" : "…Loading"
                    : lang === "ar" ? "تحميل" : "Load"}
                </button>
              </div>

              {profileState.error && (
                <p className="text-xs text-red-600">{profileState.error}</p>
              )}

              {profileData && (
                <div className="grid gap-4 md:grid-cols-2 text-xs">
                  <div className="space-y-1">
                    <div className="font-semibold text-slate-900">
                      {profileData.user.fullName}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {profileData.user.email}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {lang === "ar" ? "اللغة المفضلة:" : "Preferred language:"}{" "}
                      {profileData.user.preferredLang ||
                        (lang === "ar" ? "غير محددة" : "Not set")}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {lang === "ar" ? "الصف:" : "Grade:"}{" "}
                      {profileData.student.gradeStage ?? ""}{" "}
                      {profileData.student.gradeNumber ?? ""}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="font-semibold text-slate-900">
                      {lang === "ar" ? "الأهل" : "Parents"}
                    </div>

                    {(profileData.parents ?? []).length === 0 && (
                      <p className="text-[11px] text-slate-500">
                        {lang === "ar"
                          ? "لا يوجد أولياء أمور مرتبطون."
                          : "No linked parents yet."}
                      </p>
                    )}

                    {(profileData.parents ?? []).length > 0 && (
                      <ul className="space-y-1">
                        {profileData.parents.map((p) => (
                          <li
                            key={p.parentId}
                            className="rounded-xl bg-slate-50 px-3 py-1.5"
                          >
                            <div className="font-medium text-slate-900">{p.fullName}</div>
                            <div className="text-[11px] text-slate-500">{p.relationship}</div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

// =============================================================================
// Page shell with Suspense boundary (required for useSearchParams)
// =============================================================================

function StudentDashboardPageFallback() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <p className="text-sm text-slate-500">Loading student dashboard...</p>
    </div>
  );
}

export default function StudentDashboardPage() {
  return (
    <Suspense fallback={<StudentDashboardPageFallback />}>
      <StudentDashboardPageContent />
    </Suspense>
  );
}
