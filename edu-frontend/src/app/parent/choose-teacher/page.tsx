"use client";

/**
 * Choose Teacher Page (Parent) — SESSION ONLY (PRODUCTION) — FIXED
 * -----------------------------------------------------------------------------
 * ✅ Session cookie only (credentials: "include")
 * ✅ Unified behavior:
 *    - No current teacher  -> assign directly via /parent/teacher-options/select
 *    - Has current teacher -> create change request via /parent/requests
 *
 * ✅ IMPORTANT FIX (your reported bug):
 *    When "Change Teacher" flow is active, we MUST NOT allow selecting the
 *    SAME current teacher again.
 *
 * ✅ Next.js App Router fix:
 *    - useSearchParams() is wrapped safely in Suspense
 *
 * ✅ Phase 1 ratings support:
 *    - Supports rating and rating_count from backend
 *    - Shows "No ratings yet" fallback when no ratings exist
 */

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, type ApiError } from "@/src/lib/api";
import {
  Users,
  PlayCircle,
  ArrowLeftCircle,
  CheckCircle2,
  AlertTriangle,
  RefreshCcw,
} from "lucide-react";

/* =============================================================================
 * Types — Teacher Options
 * ============================================================================= */
type TeacherOptionRowApi = {
  teacher_id: number;
  teacher_full_name: string;
  bio?: string | null;
  photo_url?: string | null;
  demo_video_url?: string | null;
  years_experience?: string | number | null;
  rating?: number | null;
  rating_count?: number | null;
};

type TeacherOptionsResponse =
  | { success: true; data: TeacherOptionRowApi[]; message?: string }
  | { success: false; data?: never; message?: string };

type TeacherOption = {
  id: number;
  fullName: string;
  bio?: string | null;
  photoUrl?: string | null;
  demoVideoUrl?: string | null;
  yearsExperience?: string | number | null;
  rating?: number | null;
  ratingCount?: number | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function normaliseTeacherOptions(data: unknown): TeacherOption[] {
  if (!isRecord(data) || data.success !== true || !Array.isArray(data.data)) {
    throw new Error("Invalid teacher-options response shape.");
  }

  const payload = data as TeacherOptionsResponse;

  return payload.data.map((row: TeacherOptionRowApi) => ({
    id: row.teacher_id,
    fullName: row.teacher_full_name,
    bio: row.bio ?? null,
    photoUrl: row.photo_url ?? null,
    demoVideoUrl: row.demo_video_url ?? null,
    yearsExperience:
      typeof row.years_experience === "string"
        ? row.years_experience.trim() || null
        : typeof row.years_experience === "number"
          ? row.years_experience
          : null,
    rating: typeof row.rating === "number" ? row.rating : null,
    ratingCount:
      typeof row.rating_count === "number" ? row.rating_count : null,
  }));
}

function readEnvelopeFailureMessage(raw: unknown): string | null {
  if (isRecord(raw) && raw.success === false && typeof raw.message === "string") {
    return raw.message;
  }

  return null;
}

function normaliseSelections(raw: unknown): ParentSelectionApiRow[] {
  if (!isRecord(raw) || raw.success !== true || !Array.isArray(raw.data)) {
    throw new Error("Invalid parent selections response shape.");
  }
  return raw.data as ParentSelectionApiRow[];
}

/* =============================================================================
 * Types — Selections (detect current teacher)
 * ============================================================================= */
type ParentSelectionApiRow = {
  id: number;
  subject_id: number;
  teacher_id: number | null;
  teacher_name: string | null;
};

/* =============================================================================
 * Texts
 * ============================================================================= */
const chooseTeacherTexts = {
  en: {
    title: "Choose a teacher",
    subtitle:
      "Pick a teacher for this subject. You can watch demo videos before deciding.",
    backToDashboard: "Back to parent dashboard",

    loading: "Loading available teachers...",
    loadError: "Unable to load teachers. Please try again.",
    noTeachersTitle: "No teachers available yet",
    noTeachersBody:
      "There are currently no teachers available for this subject and your child's academic level.",

    noAlternativeTeachersTitle: "No other teachers available",
    noAlternativeTeachersBody:
      "Your child is already assigned to the only available teacher for this subject.",

    yearsExperience: "years experience",
    rating: "Rating",
    noRatingsYet: "No ratings yet",
    demoVideo: "Demo video",

    assigningTitle: "First-time assignment",
    assigningHint: "Selecting a teacher will assign them immediately.",

    changingTitle: "Change teacher request",
    changingHint:
      "This child already has a teacher. Selecting a new one will create a request (Pending).",

    currentTeacherLabel: "Current teacher",
    reasonLabel: "Reason (optional)",
    reasonPlaceholder: "e.g., Need different schedule",

    selectTeacher: "Select this teacher",
    selecting: "Saving...",

    selectionSuccess: "Your choice has been saved successfully.",
    requestSuccess:
      "Your change request was submitted successfully. You can track it in Requests.",
    selectionError: "Unable to save. Please try again.",

    sameTeacherBlocked:
      "This is already the current teacher. Please choose a different teacher.",

    missingParams:
      "Missing student/subject information. Please go back to the dashboard and open this page again.",
    notAuthed: "Your session has expired. Please log in again as a parent.",
    detectError:
      "Could not detect the current teacher for this subject. Please refresh.",
    refresh: "Refresh",
    suspenseLoading: "Loading teacher chooser...",
  },
  ar: {
    title: "اختيار المعلم",
    subtitle:
      "اختر معلماً لهذه المادة. يمكنك مشاهدة فيديوهات تعريفية قبل اتخاذ القرار.",
    backToDashboard: "العودة إلى لوحة ولي الأمر",

    loading: "جاري تحميل قائمة المعلمين...",
    loadError: "تعذر تحميل قائمة المعلمين. برجاء المحاولة مرة أخرى.",
    noTeachersTitle: "لا يوجد معلمون متاحون حالياً",
    noTeachersBody:
      "لا يوجد معلمون مضافون لهذه المادة والمرحلة الدراسية حتى الآن.",

    noAlternativeTeachersTitle: "لا يوجد معلمون آخرون متاحون",
    noAlternativeTeachersBody:
      "طفلك مرتبط بالفعل بالمعلم الوحيد المتاح لهذه المادة.",

    yearsExperience: "سنوات خبرة",
    rating: "التقييم",
    noRatingsYet: "لا توجد تقييمات بعد",
    demoVideo: "فيديو تعريفي",

    assigningTitle: "تعيين لأول مرة",
    assigningHint: "اختيار المعلم سيقوم بالتعيين مباشرة.",

    changingTitle: "طلب تغيير معلم",
    changingHint:
      "هذا الطفل لديه معلم بالفعل. اختيار معلم جديد سيُنشئ طلباً (قيد المراجعة).",

    currentTeacherLabel: "المعلم الحالي",
    reasonLabel: "السبب (اختياري)",
    reasonPlaceholder: "مثال: نحتاج جدول مختلف",

    selectTeacher: "اختيار هذا المعلم",
    selecting: "جاري الحفظ...",

    selectionSuccess: "تم حفظ اختيارك بنجاح.",
    requestSuccess:
      "تم إرسال طلب التغيير بنجاح. يمكنك متابعة حالته من تبويب الطلبات.",
    selectionError: "تعذر الحفظ. برجاء المحاولة مرة أخرى.",

    sameTeacherBlocked:
      "هذا هو نفس المعلم الحالي بالفعل. يرجى اختيار معلم مختلف.",

    missingParams:
      "بيانات الطالب أو المادة غير مكتملة. يرجى العودة للوحة ولي الأمر وفتح الصفحة مرة أخرى.",
    notAuthed: "انتهت الجلسة. يرجى تسجيل الدخول مرة أخرى كولي أمر.",
    detectError:
      "تعذر التحقق من المعلم الحالي لهذه المادة. يرجى التحديث.",
    refresh: "تحديث",
    suspenseLoading: "جاري تحميل صفحة اختيار المعلم...",
  },
} as const;

function ChooseTeacherFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-linear-to-b from-slate-50 via-slate-50 to-slate-100 px-4">
      <p className="text-sm text-slate-600">Loading teacher chooser...</p>
    </div>
  );
}

/* =============================================================================
 * Page content
 * ============================================================================= */
function ChooseTeacherPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const langParam = searchParams.get("lang");
  const lang = langParam === "ar" ? "ar" : "en";
  const t = chooseTeacherTexts[lang];

  const studentIdRaw = searchParams.get("studentId");
  const subjectIdRaw = searchParams.get("subjectId");
  const selectionIdRaw = searchParams.get("selectionId");

  const studentId = studentIdRaw ? Number(studentIdRaw) : NaN;
  const subjectId = subjectIdRaw ? Number(subjectIdRaw) : NaN;
  const selectionId = selectionIdRaw ? Number(selectionIdRaw) : NaN;

  const missingParams =
    !Number.isFinite(studentId) || !Number.isFinite(subjectId);

  const [teachers, setTeachers] = useState<TeacherOption[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [detecting, setDetecting] = useState<boolean>(true);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [currentTeacherId, setCurrentTeacherId] = useState<number | null>(null);
  const [currentTeacherName, setCurrentTeacherName] = useState<string | null>(
    null
  );

  const [savingTeacherId, setSavingTeacherId] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const [reason, setReason] = useState<string>("");

  const hasCurrentTeacher = useMemo(
    () => currentTeacherId != null,
    [currentTeacherId]
  );

  const visibleTeachers = useMemo(() => {
    if (!hasCurrentTeacher) return teachers;
    return teachers.filter((x) => x.id !== currentTeacherId);
  }, [teachers, hasCurrentTeacher, currentTeacherId]);

  const isYouTubeUrl = (url: string | null | undefined) => {
    if (!url) return false;
    return url.includes("youtube.com") || url.includes("youtu.be");
  };

  useEffect(() => {
    if (missingParams) {
      setDetecting(false);
      setDetectError(t.missingParams);
      return;
    }

    const run = async () => {
      try {
        setDetecting(true);
        setDetectError(null);

        const raw: unknown = await apiFetch(
          `/parent/student/${studentId}/selections`
        );

        const envelopeError = readEnvelopeFailureMessage(raw);
        if (envelopeError) {
          throw new Error(envelopeError);
        }

        const rows = normaliseSelections(raw);
        const row =
          rows.find((r) => Number(r.subject_id) === Number(subjectId)) ?? null;

        const teacherId =
          row &&
          typeof row.teacher_id === "number" &&
          Number.isFinite(row.teacher_id)
            ? row.teacher_id
            : null;

        const teacherName =
          row && typeof row.teacher_name === "string" ? row.teacher_name : null;

        setCurrentTeacherId(teacherId);
        setCurrentTeacherName(teacherName);
      } catch (err: unknown) {
        const msg = getSaveErrorMessage(err, t.detectError, t.notAuthed);
        setDetectError(msg);
        setCurrentTeacherId(null);
        setCurrentTeacherName(null);
      } finally {
        setDetecting(false);
      }
    };

    void run();
  }, [
    missingParams,
    studentId,
    subjectId,
    t.detectError,
    t.missingParams,
    t.notAuthed,
  ]);

  useEffect(() => {
    if (missingParams) {
      setLoading(false);
      setLoadError(t.missingParams);
      return;
    }

    const fetchTeachers = async () => {
      try {
        setLoading(true);
        setLoadError(null);

        const raw: unknown = await apiFetch(
          `/parent/teacher-options?student_id=${encodeURIComponent(String(studentId))}&subject_id=${encodeURIComponent(String(subjectId))}`
        );

        const envelopeError = readEnvelopeFailureMessage(raw);
        if (envelopeError) {
          throw new Error(envelopeError);
        }

        const list = normaliseTeacherOptions(raw);
        setTeachers(list);
      } catch (err: unknown) {
        const msg = getSaveErrorMessage(err, t.loadError, t.notAuthed);
        setLoadError(msg);
      } finally {
        setLoading(false);
      }
    };

    void fetchTeachers();
  }, [
    missingParams,
    studentId,
    subjectId,
    t.loadError,
    t.missingParams,
    t.notAuthed,
  ]);

  const handleSelectTeacher = async (teacherId: number) => {
    if (!Number.isFinite(studentId) || !Number.isFinite(subjectId)) {
      setSaveError(t.missingParams);
      return;
    }

    if (hasCurrentTeacher && currentTeacherId === teacherId) {
      setSaveError(t.sameTeacherBlocked);
      return;
    }

    try {
      setSavingTeacherId(teacherId);
      setSaveError(null);
      setSaveSuccess(null);

      if (!hasCurrentTeacher) {
        const body: {
          student_id: number;
          subject_id: number;
          selection_id?: number;
          teacher_id: number;
        } = {
          student_id: studentId,
          subject_id: subjectId,
          teacher_id: teacherId,
        };

        if (Number.isFinite(selectionId)) {
          body.selection_id = selectionId;
        }

        await apiFetch<{
          success: boolean;
          message?: string;
          data?: {
            selectionId: number | null;
            studentId: number;
            subjectId: number;
            teacherId: number;
          };
        }>("/parent/teacher-options/select", {
          method: "POST",
          json: body,
        });

        setSaveSuccess(t.selectionSuccess);
        return;
      }

      const requestBody: {
        student_id: number;
        subject_id: number;
        teacher_id: number;
        requested_teacher_id: number;
        type: "change_teacher";
        reason?: string;
      } = {
        student_id: studentId,
        subject_id: subjectId,
        teacher_id: Number(currentTeacherId),
        requested_teacher_id: teacherId,
        type: "change_teacher",
      };

      const cleanedReason = reason.trim();
      if (cleanedReason.length > 0) requestBody.reason = cleanedReason;

      await apiFetch<{
        success: boolean;
        message?: string;
        data?: { requestId: number; type: string | null };
      }>("/parent/requests", {
        method: "POST",
        json: requestBody,
      });

      setSaveSuccess(t.requestSuccess);

      setTimeout(() => {
        router.push(
          lang === "ar" ? "/parent/requests?lang=ar" : "/parent/requests"
        );
      }, 700);
    } catch (err: unknown) {
      // Auto-fallback if detection was stale and backend indicates the opposite flow.
      if (!hasCurrentTeacher && isCurrentTeacherConflict(err)) {
        try {
          const fallbackBody: {
            student_id: number;
            subject_id: number;
            teacher_id?: number;
            requested_teacher_id: number;
            type: "change_teacher";
            reason?: string;
          } = {
            student_id: studentId,
            subject_id: subjectId,
            requested_teacher_id: teacherId,
            type: "change_teacher",
          };
          if (Number.isFinite(currentTeacherId)) {
            fallbackBody.teacher_id = Number(currentTeacherId);
          }
          const cleanedReason = reason.trim();
          if (cleanedReason.length > 0) fallbackBody.reason = cleanedReason;

          await apiFetch<{
            success: boolean;
            message?: string;
            data?: { requestId: number; type: string | null };
          }>("/parent/requests", {
            method: "POST",
            json: fallbackBody,
          });
          setSaveSuccess(t.requestSuccess);
          setTimeout(() => {
            router.push(
              lang === "ar" ? "/parent/requests?lang=ar" : "/parent/requests"
            );
          }, 700);
          return;
        } catch (fallbackErr: unknown) {
          const msg = getSaveErrorMessage(
            fallbackErr,
            t.selectionError,
            t.notAuthed
          );
          setSaveError(msg);
          return;
        }
      }

      if (hasCurrentTeacher && isNoCurrentTeacherConflict(err)) {
        try {
          const fallbackBody: {
            student_id: number;
            subject_id: number;
            selection_id?: number;
            teacher_id: number;
          } = {
            student_id: studentId,
            subject_id: subjectId,
            teacher_id: teacherId,
          };
          if (Number.isFinite(selectionId)) {
            fallbackBody.selection_id = selectionId;
          }

          await apiFetch<{
            success: boolean;
            message?: string;
            data?: {
              selectionId: number | null;
              studentId: number;
              subjectId: number;
              teacherId: number;
            };
          }>("/parent/teacher-options/select", {
            method: "POST",
            json: fallbackBody,
          });
          setSaveSuccess(t.selectionSuccess);
          return;
        } catch (fallbackErr: unknown) {
          const msg = getSaveErrorMessage(
            fallbackErr,
            t.selectionError,
            t.notAuthed
          );
          setSaveError(msg);
          return;
        }
      }

      const msg = getSaveErrorMessage(err, t.selectionError, t.notAuthed);
      setSaveError(msg);
    } finally {
      setSavingTeacherId(null);
    }
  };

  const handleBackToDashboard = () => {
    router.push(
      lang === "ar" ? "/parent/dashboard?lang=ar" : "/parent/dashboard"
    );
  };

  const handleRefreshDetect = () => {
    window.location.reload();
  };

  const showNoAlternatives =
    !loading &&
    !loadError &&
    hasCurrentTeacher &&
    teachers.length > 0 &&
    visibleTeachers.length === 0;

  return (
    <div
      className="min-h-screen bg-linear-to-b from-slate-50 via-slate-50 to-slate-100 px-4 py-6 lg:px-8"
      dir={lang === "ar" ? "rtl" : "ltr"}
    >
      <div className="mx-auto max-w-5xl">
        <header className="mb-4 flex flex-col gap-3 rounded-2xl border border-slate-100 bg-white/90 p-4 shadow-sm backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50">
              <Users className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-slate-900">
                {t.title}
              </h1>
              <p className="text-[13px] text-slate-500">{t.subtitle}</p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleBackToDashboard}
            className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
          >
            <ArrowLeftCircle className="mx-1 h-4 w-4" />
            {t.backToDashboard}
          </button>
        </header>

        {!missingParams && (
          <div className="mb-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
            {detecting ? (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                {lang === "ar"
                  ? "جاري التحقق من المعلم الحالي..."
                  : "Detecting current teacher..."}
              </div>
            ) : detectError ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-start gap-2 text-sm text-amber-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4" />
                  <span>{detectError}</span>
                </div>
                <button
                  type="button"
                  onClick={handleRefreshDetect}
                  className="inline-flex w-fit items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  {t.refresh}
                </button>
              </div>
            ) : hasCurrentTeacher ? (
              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-900">
                  {t.changingTitle}
                </p>
                <p className="text-[13px] text-slate-600">{t.changingHint}</p>

                <p className="text-[12px] text-slate-500">
                  {`${t.currentTeacherLabel}: `}
                  <span className="font-medium text-slate-700">
                    {currentTeacherName ??
                      (lang === "ar" ? "غير محدد" : "Not set")}
                  </span>
                </p>

                <div className="pt-2">
                  <label className="mb-1 block text-[12px] font-medium text-slate-700">
                    {t.reasonLabel}
                  </label>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={t.reasonPlaceholder}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none ring-0 focus:border-emerald-300"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-900">
                  {t.assigningTitle}
                </p>
                <p className="text-[13px] text-slate-600">{t.assigningHint}</p>
              </div>
            )}
          </div>
        )}

        {loadError && (
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
            {loadError}
          </div>
        )}

        {loading && !loadError && (
          <div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
            <p className="text-sm text-slate-600">{t.loading}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {[1, 2].map((n) => (
                <div
                  key={n}
                  className="h-40 animate-pulse rounded-xl border border-slate-100 bg-slate-50"
                />
              ))}
            </div>
          </div>
        )}

        {!loading && !loadError && teachers.length === 0 && (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-[13px] text-slate-600">
            <p className="mb-1 text-sm font-semibold text-slate-800">
              {t.noTeachersTitle}
            </p>
            <p>{t.noTeachersBody}</p>
          </div>
        )}

        {showNoAlternatives && (
          <div className="rounded-2xl border border-dashed border-amber-200 bg-amber-50 p-6 text-center text-[13px] text-amber-900">
            <p className="mb-1 text-sm font-semibold">
              {t.noAlternativeTeachersTitle}
            </p>
            <p className="text-amber-800">{t.noAlternativeTeachersBody}</p>
          </div>
        )}

        {!loading && !loadError && visibleTeachers.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2">
            {visibleTeachers.map((teacher) => (
              <article
                key={teacher.id}
                className="flex flex-col rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"
              >
                <div className="mb-3 flex items-start gap-3">
                  {teacher.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={teacher.photoUrl}
                      alt={teacher.fullName}
                      className="h-12 w-12 shrink-0 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-sm font-semibold text-white">
                      {teacher.fullName
                        .split(" ")
                        .map((part) => part.trim().charAt(0).toUpperCase())
                        .slice(0, 2)
                        .join("")}
                    </div>
                  )}

                  <div className="flex-1">
                    <p className="text-sm font-semibold text-slate-900">
                      {teacher.fullName}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                      {teacher.yearsExperience != null && (
                        <span className="rounded-full bg-slate-50 px-2 py-0.5">
                          {teacher.yearsExperience} {t.yearsExperience}
                        </span>
                      )}

                      {teacher.rating != null && (teacher.ratingCount ?? 0) > 0 ? (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">
                          {t.rating}: {teacher.rating.toFixed(1)} / 5 ({teacher.ratingCount})
                        </span>
                      ) : (
                        <span className="rounded-full bg-slate-50 px-2 py-0.5 text-slate-500">
                          {t.noRatingsYet}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {teacher.bio && (
                  <p className="mb-2 text-[12px] text-slate-600">
                    {teacher.bio}
                  </p>
                )}

                {teacher.demoVideoUrl && (
                  <div className="mb-3 rounded-lg border border-slate-100 bg-slate-50 p-2">
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-slate-700">
                      <PlayCircle className="h-3.5 w-3.5 text-emerald-500" />
                      <span>{t.demoVideo}</span>
                    </div>
                    <div className="overflow-hidden rounded-md border border-slate-200 bg-black/80">
                      {isYouTubeUrl(teacher.demoVideoUrl) ? (
                        <iframe
                          src={teacher.demoVideoUrl}
                          title={teacher.fullName}
                          className="h-40 w-full"
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                        />
                      ) : (
                        <video
                          className="h-40 w-full"
                          controls
                          src={teacher.demoVideoUrl ?? undefined}
                        />
                      )}
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => handleSelectTeacher(teacher.id)}
                  disabled={savingTeacherId === teacher.id || detecting}
                  className="mt-auto inline-flex items-center justify-center rounded-md bg-emerald-500 px-3 py-2 text-[12px] font-semibold text-white shadow-sm hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-70"
                  title={
                    detectError
                      ? lang === "ar"
                        ? "تعذر التحقق من المعلم الحالي. يرجى التحديث."
                        : "Unable to detect current teacher. Please refresh."
                      : undefined
                  }
                >
                  {savingTeacherId === teacher.id
                    ? t.selecting
                    : t.selectTeacher}
                </button>
              </article>
            ))}
          </div>
        )}

        {(saveError || saveSuccess) && (
          <div className="mt-4 flex flex-col gap-2">
            {saveError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
                {saveError}
              </div>
            )}
            {saveSuccess && (
              <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800">
                <CheckCircle2 className="h-4 w-4" />
                <span>{saveSuccess}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChooseTeacherPage() {
  return (
    <Suspense fallback={<ChooseTeacherFallback />}>
      <ChooseTeacherPageContent />
    </Suspense>
  );
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

function getSaveErrorMessage(
  err: unknown,
  fallback: string,
  unauthorizedMessage: string
): string {
  if (isApiError(err)) {
    if (err.status === 401 || err.status === 403) return unauthorizedMessage;
    return err.message || fallback;
  }

  if (err instanceof Error) return err.message;
  return fallback;
}

function isCurrentTeacherConflict(err: unknown): boolean {
  if (!isApiError(err)) return false;
  const msg = String(err.message || "").toLowerCase();
  return (
    msg.includes("already has a current teacher") ||
    msg.includes("use the change-request flow")
  );
}

function isNoCurrentTeacherConflict(err: unknown): boolean {
  if (!isApiError(err)) return false;
  const msg = String(err.message || "").toLowerCase();
  return (
    msg.includes("no current teacher exists") ||
    msg.includes("use the direct teacher selection flow")
  );
}
