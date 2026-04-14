// src/app/student/onboarding/page.tsx
"use client";

/**
 * Student Onboarding (3-step wizard)
 * 1) Choose a subject (from enrolled OR enroll a new subject)
 * 2) Choose a teacher for the subject
 * 3) Confirm & save
 * 
 * ✅ **SESSION-BASED AUTH UPDATES APPLIED:**
 * - Removed userId from query params and localStorage
 * - Now uses /auth/me endpoint as source of truth
 * - Removed all x-user-id headers
 * - Updated "must login" messages
 * - Added role enforcement (student only)
 * - All auth checks use session cookie
 * 
 * ✅ **FIXES IMPLEMENTED:**
 * 1) Resilient /auth/me parsing
 * 2) Better role enforcement redirect target
 * 3) Teacher details effect cleanup
 * 4) StepDot numbering
 * 5) Specific validation messages
 */

import React, { Suspense, useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, API_BASE } from "@/src/lib/api";

/* =============================================================================
 * Types
 * ========================================================================== */

type Lang = "en" | "ar";
type SubjectPickMode = "enrolled" | "other";

type OnboardingSubject = {
  id: string; // subject id as string
  name: string;
};

type OnboardingTeacher = {
  id: string; // teacher id as string
  name: string;
  ratingAvg: number | null;
  ratingCount: number;
};

type ApiResponse<T> = {
  success: boolean;
  data: T;
  message?: string;
};

type StudentSubjectRow = {
  subjectId: number;
  nameEn: string | null;
  nameAr: string | null;
  teacher: {
    id: number;
    name: string;
    photoUrl: string | null;
    primaryVideoUrl: string | null;
  };
  selectionStatus: string;
  selectedBy: string;
  selectedAt: string | null;
};

type AvailableSubjectRow = {
  subjectId: number;
  nameEn: string;
  nameAr: string;
};

type TeacherVideoClip = {
  title: string;
  url: string;
};

type TeacherDetails = {
  id: string;
  name: string;
  photoUrl: string | null;
  bio: string | null;
  videoClips: TeacherVideoClip[];
};

// ✅ SESSION: Response type for /auth/me endpoint
type MePayload = {
  authenticated: boolean;
  user: { id: number; role: string } | null;
  activeStudentId: number | null;
  meta?: Record<string, unknown>;
};

/* =============================================================================
 * i18n texts
 * ========================================================================== */

const texts = {
  en: {
    pageTitle: "Student Onboarding",
    pageSubtitle: "First, choose a subject and teacher.",

    step1Label: "Subject",
    step2Label: "Teacher",
    step3Label: "Confirm",

    step1Title: "1) Choose a subject",
    step2Title: "2) Choose a teacher",
    step3Title: "3) Confirm",

    enrolledRadioTitle: "Choose from your enrolled subjects",
    otherRadioTitle: "Other (add another subject)",
    availableDropdownTitle: "Choose another subject to enroll in",
    availableDropdownPlaceholder: "Choose a subject…",
    enrollNote:
      "This subject will be added to your enrolled subjects before selecting a teacher.",

    loadingSubjects: "Loading subjects…",
    loadingTeachers: "Loading teachers…",
    enrolling: "Enrolling…",

    noAvailableSubjects:
      "No additional subjects are currently available for your grade.",
    noTeachersForSubject:
      "There are currently no teachers available yet for this subject. Please check again later.",

    subjectLabel: "Subject",
    teacherLabel: "Teacher",
    notSelected: "Not selected",

    cancel: "Cancel",
    back: "Back",
    next: "Next",
    enrollAndNext: "Enroll & Next",

    saving: "Saving…",
    confirm: "Confirm",

    doneTitle: "Onboarding completed!",
    doneMessage: "You can now go to your dashboard.",
    goToDashboard: "Go to dashboard",

    // ✅ SESSION: Updated login message (removed x-user-id reference)
    mustLogin: "You must be logged in to continue.",
    genericLoadError:
      "We couldn't load your selection data. Please refresh the page or contact the school administrator.",
    subjectNotEnrolledGuard:
      "Please enroll in the subject first before choosing a teacher.",

    noEnrolledSubjects: "You have not selected any subjects yet.",
    noTeacherYet: "No teacher selected yet",
    teacherPrefix: "Teacher",

    viewTeacherDetails: "View details",
    teacherDetailsTitle: "Teacher details",
    aboutTeacher: "About",
    teacherVideos: "Video clips",
    noTeacherVideos: "No video clips available yet.",
    close: "Close",
    loadingTeacherDetails: "Loading teacher details…",
    failedTeacherDetails: "Failed to load teacher details.",
    openVideo: "Open video",
    chooseAnotherSubject: "Choose another subject",
    retryLoadTeachers: "Try again",

    // Step 0 — scope
    step0Label: "Grade",
    step0Title: "0) Your grade level",
    step0Intro: "Tell us which educational system and grade you are in so we can show you the right subjects and teachers.",
    selectSystem: "Education system",
    selectSystemPlaceholder: "Choose a system…",
    selectStage: "Stage",
    selectStagePlaceholder: "Choose a stage…",
    selectGradeLevel: "Grade level",
    selectGradeLevelPlaceholder: "Choose a grade…",
    loadingCatalog: "Loading grade catalog…",
    scopeRequired: "Please select at least your education system and stage.",
    savingScope: "Saving…",
  },
  ar: {
    pageTitle: "تهيئة الطالب",
    pageSubtitle: "أولاً، اختر المادة والمعلم.",

    step1Label: "المادة",
    step2Label: "المعلم",
    step3Label: "تأكيد",

    step1Title: "١) اختر المادة",
    step2Title: "٢) اختر المعلم",
    step3Title: "٣) تأكيد",

    enrolledRadioTitle: "اختر من المواد المسجلة لديك",
    otherRadioTitle: "أخرى (إضافة مادة جديدة)",
    availableDropdownTitle: "اختر مادة جديدة للتسجيل بها",
    availableDropdownPlaceholder: "اختر مادة…",
    enrollNote: "سيتم إضافة هذه المادة إلى موادك المسجلة قبل اختيار المعلم.",

    loadingSubjects: "جاري تحميل المواد…",
    loadingTeachers: "جاري تحميل المعلمين…",
    enrolling: "جاري التسجيل…",

    noAvailableSubjects: "لا توجد مواد إضافية متاحة حالياً لصفك.",
    noTeachersForSubject:
      "لا يوجد معلمون متاحون لهذه المادة حاليًا. برجاء المحاولة لاحقًا.",

    subjectLabel: "المادة",
    teacherLabel: "المعلم",
    notSelected: "غير مُحدد",

    cancel: "إلغاء",
    back: "السابق",
    next: "التالي",
    enrollAndNext: "سجل ثم التالي",

    saving: "جاري الحفظ…",
    confirm: "تأكيد",

    doneTitle: "تم إكمال التهيئة!",
    doneMessage: "يمكنك الآن الذهاب إلى لوحة التحكم الخاصة بك.",
    goToDashboard: "الذهاب إلى لوحة الطالب",

    // ✅ SESSION: Updated login message (removed x-user-id reference)
    mustLogin: "يجب تسجيل الدخول أولاً للمتابعة.",
    genericLoadError:
      "تعذر تحميل بيانات التهيئة. برجاء إعادة تحميل الصفحة أو التواصل مع إدارة المدرسة.",
    subjectNotEnrolledGuard: "برجاء تسجيل المادة أولاً قبل اختيار المعلم.",

    noEnrolledSubjects: "لم يتم اختيار أي مواد حتى الآن.",
    noTeacherYet: "لم يتم اختيار معلم بعد",
    teacherPrefix: "المعلم",

    viewTeacherDetails: "عرض التفاصيل",
    teacherDetailsTitle: "تفاصيل المعلم",
    aboutTeacher: "نبذة",
    teacherVideos: "مقاطع فيديو",
    noTeacherVideos: "لا توجد مقاطع فيديو متاحة حالياً.",
    close: "إغلاق",
    loadingTeacherDetails: "جاري تحميل تفاصيل المعلم…",
    failedTeacherDetails: "تعذر تحميل تفاصيل المعلم.",
    openVideo: "فتح الفيديو",
    chooseAnotherSubject: "اختر مادة أخرى",
    retryLoadTeachers: "حاول مرة أخرى",

    // Step 0 — scope
    step0Label: "الصف",
    step0Title: "٠) مرحلتك الدراسية",
    step0Intro: "أخبرنا بالنظام التعليمي والصف الذي أنت فيه لنعرض لك المواد والمعلمين المناسبين.",
    selectSystem: "النظام التعليمي",
    selectSystemPlaceholder: "اختر النظام…",
    selectStage: "المرحلة",
    selectStagePlaceholder: "اختر المرحلة…",
    selectGradeLevel: "الصف الدراسي",
    selectGradeLevelPlaceholder: "اختر الصف…",
    loadingCatalog: "جاري تحميل الصفوف الدراسية…",
    scopeRequired: "برجاء اختيار النظام التعليمي والمرحلة على الأقل.",
    savingScope: "جاري الحفظ…",
  },
} as const;

// ✅ Modal + page can accept either EN or AR text object
type LangTexts = (typeof texts)[Lang];

/* -------------------------------------------------------------------------- */
/* Grade catalog types (for Step 0 scope selection)                           */
/* -------------------------------------------------------------------------- */

type CatalogSystem = { id: number; name: string; code: string };
type CatalogStage  = { id: number; systemId: number; nameEn: string; nameAr: string; code: string };
type CatalogLevel  = { id: number; stageId: number; nameEn: string; nameAr: string; code: string };

type GradeCatalog = {
  systems: CatalogSystem[];
  stages: CatalogStage[];
  levels: CatalogLevel[];
};

/* =============================================================================
 * Helpers
 * ========================================================================== */

function getErrorMessage(err: unknown): string {
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    const message = (err as { message: string }).message.trim();
    if (message.length > 0) return message;
  }
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error.";
}

function pickSubjectName(
  row: { nameEn: string | null; nameAr: string | null },
  lang: Lang
): string {
  const candidates = lang === "ar" ? [row.nameAr, row.nameEn] : [row.nameEn, row.nameAr];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "";
}

function mapAvailableSubjects(
  rows: AvailableSubjectRow[],
  lang: Lang
): OnboardingSubject[] {
  return rows
    .map((s) => {
      const name = pickSubjectName({ nameEn: s.nameEn, nameAr: s.nameAr }, lang);
      if (!name) return null;
      return { id: String(s.subjectId), name };
    })
    .filter((x): x is OnboardingSubject => x !== null);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Strict `/auth/me` contract:
 * { success: true, data: { authenticated, user, activeStudentId?, meta? } }
 */
function normalizeMeResponse(body: unknown): MePayload | null {
  if (!isRecord(body) || body.success !== true || !isRecord(body.data)) return null;
  const data = body.data;
  if (typeof data.authenticated !== "boolean") return null;
  return data as MePayload;
}

/**
 * Strict teachers discovery contract:
 * { success: true, data: Teacher[] }
 */
function normalizeTeachers(body: unknown): OnboardingTeacher[] {
  if (!isRecord(body) || body.success !== true || !Array.isArray(body.data)) {
    throw new Error("Invalid teachers discovery response shape.");
  }

  const normalized: OnboardingTeacher[] = [];

  const normalizeTeacherRow = (row: unknown): OnboardingTeacher | null => {
    if (!row || typeof row !== "object") return null;
    const r = row as { id?: number | string; _id?: number | string; name?: unknown; full_name?: unknown; rating_avg?: unknown; rating_count?: unknown };

    const idSource = r._id ?? r.id;
    if (idSource === undefined || idSource === null) return null;

    const name =
      (typeof r.name === "string" && r.name.trim()) ||
      (typeof r.full_name === "string" && r.full_name.trim()) ||
      "";

    if (!name) return null;

    const ratingAvg =
      r.rating_avg !== null && r.rating_avg !== undefined && !isNaN(Number(r.rating_avg))
        ? Number(r.rating_avg)
        : null;
    const ratingCount = Number(r.rating_count || 0);

    return { id: String(idSource), name, ratingAvg, ratingCount };
  };

  for (const item of body.data) {
    const t = normalizeTeacherRow(item);
    if (t) normalized.push(t);
  }

  return normalized;
}

/**
 * Convert relative media paths to full URLs.
 * Examples:
 * - "/uploads/teacher-videos/abc.mp4" -> "<base>/uploads/teacher-videos/abc.mp4"
 */
function resolveMediaUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  const url = rawUrl.trim();
  if (!url) return null;

  if (url.startsWith("http://") || url.startsWith("https://")) return url;

  // API_BASE is usually ".../api"
  const base = API_BASE.replace(/\/+$/, "");
  const baseNoApi = base.replace(/\/api\/?$/i, "");

  if (url.startsWith("/")) return `${baseNoApi}${url}`;
  return `${baseNoApi}/${url}`;
}

function normalizeTeacherDetails(body: unknown, fallbackId: string): TeacherDetails | null {
  if (!isRecord(body) || body.success !== true || !isRecord(body.data)) return null;
  const raw = body.data;

  const r = raw as {
    id?: number | string;
    _id?: number | string;
    teacherId?: number | string;
    name?: unknown;
    full_name?: unknown;
    photoUrl?: unknown;
    photo_url?: unknown;
    avatarUrl?: unknown;
    bio?: unknown;
    bio_short?: unknown;
    bioShort?: unknown;
    primaryVideoUrl?: unknown;
    primary_video_url?: unknown;
    videos?: unknown;
    videoClips?: unknown;
    clips?: unknown;
  };

  const idSource = r._id ?? r.id ?? r.teacherId ?? fallbackId;
  const id = String(idSource);

  const name =
    (typeof r.name === "string" && r.name.trim()) ||
    (typeof r.full_name === "string" && r.full_name.trim()) ||
    "";
  if (!name) return null;

  const photoUrl =
    (typeof r.photoUrl === "string" && r.photoUrl.trim()) ||
    (typeof r.photo_url === "string" && r.photo_url.trim()) ||
    (typeof r.avatarUrl === "string" && r.avatarUrl.trim()) ||
    null;

  const bio =
    (typeof r.bio === "string" && r.bio.trim()) ||
    (typeof r.bioShort === "string" && r.bioShort.trim()) ||
    (typeof r.bio_short === "string" && r.bio_short.trim()) ||
    null;

  const clips: TeacherVideoClip[] = [];

  const pushClip = (title: string, url: string) => {
    const u = resolveMediaUrl(url);
    if (!u) return;
    clips.push({ title: title.trim() || "Video", url: u });
  };

  const primary =
    (typeof r.primaryVideoUrl === "string" && r.primaryVideoUrl.trim()) ||
    (typeof r.primary_video_url === "string" && r.primary_video_url.trim()) ||
    null;
  if (primary) pushClip("Primary clip", primary);

  const listSource = r.videoClips ?? r.videos ?? r.clips;
  if (Array.isArray(listSource)) {
    for (const item of listSource) {
      if (!item || typeof item !== "object") continue;
      const it = item as { title?: unknown; name?: unknown; url?: unknown; videoUrl?: unknown };
      const title =
        (typeof it.title === "string" && it.title.trim()) ||
        (typeof it.name === "string" && it.name.trim()) ||
        "";
      const url =
        (typeof it.url === "string" && it.url.trim()) ||
        (typeof it.videoUrl === "string" && it.videoUrl.trim()) ||
        "";
      if (url) pushClip(title || "Video", url);
    }
  }

  // de-dupe by URL
  const seen = new Set<string>();
  const videoClips = clips.filter((c) => {
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });

  return {
    id,
    name,
    photoUrl: resolveMediaUrl(photoUrl),
    bio,
    videoClips,
  };
}

/* =============================================================================
 * Page component
 * ========================================================================== */

function StudentOnboardingContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // language
  const langParam = searchParams.get("lang");
  const lang: Lang = langParam === "ar" ? "ar" : "en";
  const t: LangTexts = texts[lang];
  const direction = lang === "ar" ? "rtl" : "ltr";

  const withLang = useCallback(
    (path: string) => (lang === "ar" ? `${path}?lang=ar` : path),
    [lang]
  );

  /* -----------------------------------------------------------------------
   * ✅ SESSION: Auth/user context - UPDATED
   * --------------------------------------------------------------------- */
  const [authResolved, setAuthResolved] = useState(false);
  const [me, setMe] = useState<MePayload | null>(null);

  // ✅ FIX #1: Use resilient /auth/me parsing
  useEffect(() => {
    const loadMe = async () => {
      try {
        const body: unknown = await apiFetch("/auth/me");
        setMe(normalizeMeResponse(body));
      } catch {
        setMe(null);
      } finally {
        setAuthResolved(true);
      }
    };

    void loadMe();
  }, []);

  // ✅ FIX #2: Better role enforcement - redirect non-students to homepage, not login
  useEffect(() => {
    if (authResolved && me?.authenticated && me.user?.role !== "student") {
      router.replace(withLang("/"));
    }
  }, [authResolved, me, router, withLang]);

  /* -----------------------------------------------------------------------
   * Wizard state (0 = scope, 1 = subject, 2 = teacher, 3 = confirm)
   * --------------------------------------------------------------------- */
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);

  /* -----------------------------------------------------------------------
   * Step 0: Grade catalog + scope selection
   * --------------------------------------------------------------------- */
  const [catalog, setCatalog] = useState<GradeCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [scopeSystemId, setScopeSystemId] = useState<string>("");
  const [scopeStageId, setScopeStageId] = useState<string>("");
  const [scopeGradeLevelId, setScopeGradeLevelId] = useState<string>("");
  const [scopeSaving, setScopeSaving] = useState(false);

  // Derived: stages for chosen system, levels for chosen stage
  const catalogStagesForSystem = useMemo(
    () => (catalog?.stages ?? []).filter((s) => s.systemId === Number(scopeSystemId)),
    [catalog, scopeSystemId]
  );
  const catalogLevelsForStage = useMemo(
    () => (catalog?.levels ?? []).filter((l) => l.stageId === Number(scopeStageId)),
    [catalog, scopeStageId]
  );

  // Fetch catalog + check if student already has scope (skip Step 0 if yes)
  useEffect(() => {
    if (!authResolved || !me?.authenticated) return;

    const run = async () => {
      try {
        setCatalogLoading(true);

        const [catalogResult, profileResult] = await Promise.allSettled([
          apiFetch<{ success: boolean; data: GradeCatalog }>("/meta/grade-catalog"),
          apiFetch<{
            success: boolean;
            data: {
              student: {
                systemId?: number | null;
                stageId?: number | null;
                gradeLevelId?: number | null;
              };
            };
          }>("/student/profile"),
        ]);

        if (catalogResult.status === "fulfilled") {
          const body = catalogResult.value;
          if (body?.success && body.data) {
            setCatalog(body.data);
          }
        }

        if (profileResult.status === "fulfilled") {
          const st = profileResult.value?.data?.student;
          if (st?.systemId && st?.stageId) {
            // Scope already set — skip Step 0
            setScopeSystemId(String(st.systemId));
            setScopeStageId(String(st.stageId));
            setScopeGradeLevelId(st.gradeLevelId ? String(st.gradeLevelId) : "");
            setStep(1);
          }
        }
      } catch {
        // catalog load failure is non-fatal; Step 0 will show without data
      } finally {
        setCatalogLoading(false);
      }
    };

    void run();
  }, [authResolved, me]);

  const handleSaveScope = useCallback(async () => {
    if (!scopeSystemId || !scopeStageId) {
      setTopError(t.scopeRequired);
      return;
    }
    try {
      setScopeSaving(true);
      setTopError(null);
      await apiFetch("/student/scope", {
        method: "PUT",
        json: {
          systemId: Number(scopeSystemId),
          stageId: Number(scopeStageId),
          gradeLevelId: scopeGradeLevelId ? Number(scopeGradeLevelId) : null,
        },
      });
      setStep(1);
    } catch (err) {
      setTopError(getErrorMessage(err));
    } finally {
      setScopeSaving(false);
    }
  }, [scopeSystemId, scopeStageId, scopeGradeLevelId, t.scopeRequired]);

  /* -----------------------------------------------------------------------
   * Loaded data: enrolled + available
   * --------------------------------------------------------------------- */
  const [studentSubjects, setStudentSubjects] = useState<StudentSubjectRow[]>([]);
  const [availableSubjects, setAvailableSubjects] = useState<OnboardingSubject[]>([]);
  const [loadingOnboarding, setLoadingOnboarding] = useState(false);

  /* -----------------------------------------------------------------------
   * Selection state
   * --------------------------------------------------------------------- */
  const [pickMode, setPickMode] = useState<SubjectPickMode>("enrolled");
  const [pickedEnrolledId, setPickedEnrolledId] = useState<string>("");
  const [pickedAvailableId, setPickedAvailableId] = useState<string>("");

  // teacher list and selection
  const [teachers, setTeachers] = useState<OnboardingTeacher[]>([]);
  const [selectedTeacherId, setSelectedTeacherId] = useState<string>("");
  const [loadingTeachers, setLoadingTeachers] = useState(false);

  // UI errors
  const [topError, setTopError] = useState<string | null>(null);
  const [teacherError, setTeacherError] = useState<string | null>(null);
  const [teacherRetryKey, setTeacherRetryKey] = useState(0);

  // states
  const [enrolling, setEnrolling] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  /* -----------------------------------------------------------------------
   * Teacher details modal state
   * --------------------------------------------------------------------- */
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsTeacherId, setDetailsTeacherId] = useState<string | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsCache, setDetailsCache] = useState<Record<string, TeacherDetails>>({});
  
  // ✅ FIX #3: Use ref for detailsCache to prevent unnecessary effect re-runs
  const detailsCacheRef = useRef(detailsCache);
  useEffect(() => {
    detailsCacheRef.current = detailsCache;
  }, [detailsCache]);

  /* -----------------------------------------------------------------------
   * Derived values
   * --------------------------------------------------------------------- */
  const selectedSubjectId = pickMode === "enrolled" ? pickedEnrolledId : pickedAvailableId;

  const enrolledIdSet = useMemo(
    () => new Set(studentSubjects.map((s) => String(s.subjectId))),
    [studentSubjects]
  );

  const selectedIsEnrolled = useMemo(() => {
    if (!selectedSubjectId) return false;
    return enrolledIdSet.has(selectedSubjectId);
  }, [enrolledIdSet, selectedSubjectId]);

  const selectedSubjectName = useMemo(() => {
    if (!selectedSubjectId) return "";
    const enrolled = studentSubjects.find((s) => String(s.subjectId) === selectedSubjectId);
    if (enrolled) return pickSubjectName(enrolled, lang) || "";
    const avail = availableSubjects.find((s) => s.id === selectedSubjectId);
    return avail?.name ?? "";
  }, [selectedSubjectId, studentSubjects, availableSubjects, lang]);

  const activeTeacherDetails = useMemo(() => {
    if (!detailsTeacherId) return null;
    return detailsCache[detailsTeacherId] ?? null;
  }, [detailsCache, detailsTeacherId]);


  /* =============================================================================
   * Load enrolled + available subjects (only after scope step is done)
   * ========================================================================== */
  useEffect(() => {
    // ✅ SESSION: Updated auth check
    if (!authResolved) return;
    if (step === 0) return; // wait until scope is confirmed
    if (!me?.authenticated || !me.user?.id) {
      setTopError(texts[lang].mustLogin);
      setStudentSubjects([]);
      setAvailableSubjects([]);
      setLoadingOnboarding(false);
      return;
    }

    const fallbackLoadError = texts[lang].genericLoadError;

    const load = async () => {
      try {
        setLoadingOnboarding(true);
        setTopError(null);

        // 1) enrolled subjects
        // ✅ SESSION: Removed x-user-id header
        const subjectsJson = await apiFetch<ApiResponse<StudentSubjectRow[]>>(
          "/student/subjects"
        );
        if (!subjectsJson.success || !Array.isArray(subjectsJson.data)) {
          throw new Error(fallbackLoadError);
        }
        setStudentSubjects(subjectsJson.data);

        // 2) available subjects (not yet enrolled)
        // ✅ SESSION: Removed x-user-id header
        try {
          const availJson = await apiFetch<ApiResponse<AvailableSubjectRow[]>>(
            "/student/subjects/available"
          );
          if (availJson?.success && Array.isArray(availJson.data)) {
            setAvailableSubjects(mapAvailableSubjects(availJson.data, lang));
          } else {
            setAvailableSubjects([]);
          }
        } catch {
          setAvailableSubjects([]);
        }
      } catch (err) {
        setTopError(getErrorMessage(err) || texts[lang].genericLoadError);
        setStudentSubjects([]);
        setAvailableSubjects([]);
      } finally {
        setLoadingOnboarding(false);
      }
    };

    void load();
  }, [authResolved, me, lang, step]); // step guards against loading before scope is set

  /**
   * Ensure we always have a valid "enrolled" selection when possible:
   * - If no enrolled subjects => force mode "other"
   * - If mode "enrolled" but nothing selected => pick first enrolled subject
   */
  useEffect(() => {
    if (loadingOnboarding) return;

    if (studentSubjects.length === 0) {
      // nothing enrolled => the only path is "other"
      setPickMode("other");
      setPickedEnrolledId("");
      setPickedAvailableId("");
      setSelectedTeacherId("");
      setTeachers([]);
      setTeacherError(null);
      return;
    }

    if (pickMode === "enrolled" && !pickedEnrolledId) {
      setPickedEnrolledId(String(studentSubjects[0].subjectId));
    }
  }, [loadingOnboarding, studentSubjects, pickMode, pickedEnrolledId]);

  /* =============================================================================
   * Handlers (centralized resets)
   * ========================================================================== */

  const resetTeacherSelection = useCallback(() => {
    setSelectedTeacherId("");
    setTeachers([]);
    setTeacherError(null);
  }, []);

  /**
   * Pick an enrolled subject.
   * This is called ONLY from the subject radio inside the map,
   * so it receives the correct subject id.
   */
  const handlePickEnrolled = useCallback(
    (id: string) => {
      setPickMode("enrolled");
      setPickedEnrolledId(id);
      setPickedAvailableId("");
      resetTeacherSelection();
    },
    [resetTeacherSelection]
  );

  /**
   * Switch to "enrolled" mode (radio above list).
   * NOTE: This should NOT pick a subjectId from nowhere.
   * If none selected, we choose the first enrolled subject (if available).
   */
  const handleSwitchToEnrolledMode = useCallback(() => {
    setPickMode("enrolled");
    setPickedAvailableId("");
    resetTeacherSelection();

    // if no enrolled picked, pick first (if exists)
    if (!pickedEnrolledId && studentSubjects.length > 0) {
      setPickedEnrolledId(String(studentSubjects[0].subjectId));
    }
  }, [pickedEnrolledId, resetTeacherSelection, studentSubjects]);

  /**
   * Switch to "other" mode (add subject)
   */
  const handlePickOther = useCallback(() => {
    setPickMode("other");
    setPickedAvailableId("");
    resetTeacherSelection();
  }, [resetTeacherSelection]);

  const handleAvailableDropdownChange = useCallback(
    (id: string) => {
      setPickedAvailableId(id);
      resetTeacherSelection();
    },
    [resetTeacherSelection]
  );

  /**
   * Enroll selected available subject by POST /student/subjects
   * Controller expects the entire list, so we merge current + new and POST.
   */
  const enrollSelectedAvailableSubject = useCallback(async (): Promise<boolean> => {
    // ✅ SESSION: Updated auth check
    if (!authResolved || !me?.authenticated || !me.user?.id) {
      setTopError(texts[lang].mustLogin);
      return false;
    }

    if (pickMode !== "other" || !pickedAvailableId) return false;

    const newIdNum = Number(pickedAvailableId);
    if (!Number.isFinite(newIdNum) || newIdNum <= 0) {
      setTopError(lang === "ar" ? "برجاء اختيار مادة صحيحة." : "Please select a valid subject.");
      return false;
    }

    try {
      setEnrolling(true);
      setTopError(null);

      const currentIds = studentSubjects
        .map((s) => Number(s.subjectId))
        .filter((n) => Number.isFinite(n) && n > 0);

      const merged = Array.from(new Set([...currentIds, newIdNum]));

      const json = await apiFetch<ApiResponse<StudentSubjectRow[]>>("/student/subjects", {
        method: "POST",
        json: { subjectIds: merged },
      });
      if (json?.success && Array.isArray(json.data)) {
        setStudentSubjects(json.data);
      }

      // Refresh available subjects list
      try {
        // ✅ SESSION: Removed x-user-id header
        const availJson = await apiFetch<ApiResponse<AvailableSubjectRow[]>>(
          "/student/subjects/available"
        );

        if (availJson?.success && Array.isArray(availJson.data)) {
          setAvailableSubjects(mapAvailableSubjects(availJson.data, lang));
        } else {
          setAvailableSubjects([]);
        }
      } catch {
        // ignore refresh errors
      }

      // After enrolling, switch back to enrolled mode and select the new subject
      setPickMode("enrolled");
      setPickedEnrolledId(String(newIdNum));
      setPickedAvailableId("");
      resetTeacherSelection();

      return true;
    } catch (err) {
      setTopError(getErrorMessage(err) || texts[lang].genericLoadError);
      return false;
    } finally {
      setEnrolling(false);
    }
  }, [
    authResolved,
    lang,
    pickMode,
    pickedAvailableId,
    resetTeacherSelection,
    studentSubjects,
    me, // ✅ SESSION: Changed from userId to me
  ]);

  /* =============================================================================
   * Guard: step 2 requires enrolled subject
   * ========================================================================== */
  useEffect(() => {
    if (step !== 2) return;
    if (!selectedSubjectId) return;

    if (!selectedIsEnrolled) {
      setTopError(texts[lang].subjectNotEnrolledGuard);
      setStep(1);
    }
  }, [step, selectedSubjectId, selectedIsEnrolled, lang]);

  /* =============================================================================
   * Load teachers for subject (Step 2 only)
   * ========================================================================== */
  useEffect(() => {
    if (step !== 2) return;

    // reset if no subject
    if (!selectedSubjectId) {
      setTeachers([]);
      setTeacherError(null);
      return;
    }

    // ✅ SESSION: Updated auth check
    if (!authResolved || !me?.authenticated || !me.user?.id) {
      setTeachers([]);
      setTeacherError(texts[lang].mustLogin);
      return;
    }

    // must be enrolled
    if (!selectedIsEnrolled) {
      setTeachers([]);
      setTeacherError(texts[lang].subjectNotEnrolledGuard);
      return;
    }

    const controller = new AbortController();

    const run = async () => {
      try {
        setLoadingTeachers(true);
        setTeacherError(null);

        const body: unknown = await apiFetch(
          `${API_BASE}/student/teachers?subjectId=${encodeURIComponent(selectedSubjectId)}`,
          {
            method: "GET",
            credentials: "include", // ✅ Session cookies
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              // ❌ REMOVED: "x-user-id": String(userId),
            },
          }
        );

        /* shared apiFetch already throws on non-OK responses.
          const fallback =
            lang === "ar"
              ? "تعذر تحميل قائمة المعلمين لهذه المادة."
              : "Failed to load teachers for this subject.";
        */

        const list = normalizeTeachers(body);
        setTeachers(list);

        // if previously selected teacher no longer exists, clear it
        if (selectedTeacherId && !list.some((x) => x.id === selectedTeacherId)) {
          setSelectedTeacherId("");
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setTeachers([]);
        setTeacherError(getErrorMessage(err));
      } finally {
        setLoadingTeachers(false);
      }
    };

    void run();
    return () => controller.abort();
  }, [
    step,
    selectedSubjectId,
    selectedTeacherId,
    lang,
    authResolved,
    me, // ✅ SESSION: Changed from userId to me
    selectedIsEnrolled,
    teacherRetryKey,
  ]);

  /* =============================================================================
   * Teacher details modal
   * ========================================================================== */

  const openTeacherDetails = useCallback((teacherId: string) => {
    setDetailsTeacherId(teacherId);
    setDetailsOpen(true);
  }, []);

  const closeTeacherDetails = useCallback(() => {
    setDetailsOpen(false);
    setDetailsTeacherId(null);
    setDetailsError(null);
    setDetailsLoading(false);
  }, []);

  // ESC close
  useEffect(() => {
    if (!detailsOpen || !detailsTeacherId) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeTeacherDetails();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailsOpen, detailsTeacherId, closeTeacherDetails]);

  // Fetch details (cached)
  useEffect(() => {
    const teacherId = detailsTeacherId;
    if (!detailsOpen || !teacherId) return;

    // ✅ FIX #3: Check cache via ref instead of state to avoid dependency loop
    if (detailsCacheRef.current[teacherId]) {
      setDetailsError(null);
      setDetailsLoading(false);
      return;
    }

    // ✅ SESSION: Updated auth check
    if (!authResolved || !me?.authenticated || !me.user?.id) {
      setDetailsError(texts[lang].mustLogin);
      setDetailsLoading(false);
      return;
    }

    const controller = new AbortController();

    const load = async () => {
      try {
        setDetailsLoading(true);
        setDetailsError(null);

        // ✅ Include subjectId as optional query param (helps backend choose relevant clips)
        const url = `${API_BASE}/student/teachers/${encodeURIComponent(teacherId)}${
          selectedSubjectId ? `?subjectId=${encodeURIComponent(selectedSubjectId)}` : ""
        }`;

        // ✅ SESSION: Removed x-user-id header
        const body: unknown = await apiFetch(url, {
          method: "GET",
          credentials: "include", // ✅ Session cookies
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            // ❌ REMOVED: "x-user-id": String(userId),
          },
        });

        /* shared apiFetch already throws on non-OK responses. */

        const normalized = normalizeTeacherDetails(body, teacherId);

        if (!normalized) throw new Error(texts[lang].failedTeacherDetails);

        setDetailsCache((prev) => ({ ...prev, [teacherId]: normalized }));
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setDetailsError(getErrorMessage(err) || texts[lang].failedTeacherDetails);
      } finally {
        setDetailsLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, [
    detailsOpen, 
    detailsTeacherId, 
    authResolved, 
    me, // ✅ SESSION: Changed from userId to me
    lang, 
    selectedSubjectId
  ]);

  /* =============================================================================
   * Submit selection
   * ========================================================================== */

  const handleSubmit = useCallback(async () => {
    try {
      setSubmitting(true);
      setTopError(null);

      // ✅ SESSION: Updated auth check
      if (!authResolved || !me?.authenticated || !me.user?.id) {
        throw new Error(texts[lang].mustLogin);
      }
      
      // ✅ FIX #5: Specific validation messages
      if (!selectedSubjectId) {
        throw new Error(lang === "ar" ? "برجاء اختيار مادة." : "Please choose a subject.");
      }
      if (!selectedTeacherId) {
        throw new Error(lang === "ar" ? "برجاء اختيار معلم." : "Please choose a teacher.");
      }
      if (!selectedIsEnrolled) throw new Error(texts[lang].subjectNotEnrolledGuard);

      const subjectIdNum = Number(selectedSubjectId);
      const teacherIdNum = Number(selectedTeacherId);

      await apiFetch<ApiResponse<{ studentId: number; subjectId: number; teacherId: number }>>(
        "/student/select-teacher",
        {
          method: "POST",
          json: {
            subjectId: Number.isFinite(subjectIdNum) ? subjectIdNum : selectedSubjectId,
            teacherId: Number.isFinite(teacherIdNum) ? teacherIdNum : selectedTeacherId,
          },
        }
      );

      setDone(true);
    } catch (err) {
      setTopError(getErrorMessage(err) || texts[lang].genericLoadError);
    } finally {
      setSubmitting(false);
    }
  }, [
    authResolved, 
    lang, 
    selectedIsEnrolled, 
    selectedSubjectId, 
    selectedTeacherId, 
    me // ✅ SESSION: Changed from userId to me
  ]);

  /* =============================================================================
   * Early returns for auth states
   * ========================================================================== */
  
  // Show loading while auth is being resolved
  if (!authResolved) {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-6 lg:px-8" dir={direction}>
        <div className="flex min-h-[200px] items-center justify-center">
          <p className="text-sm text-slate-500">Loading...</p>
        </div>
      </div>
    );
  }

  // ✅ SESSION: Show login required message if not authenticated
  if (!me?.authenticated || !me.user?.id) {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-6 lg:px-8" dir={direction}>
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-slate-900">{t.pageTitle}</h1>
        </div>
        <div className="rounded-md border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{t.mustLogin}</p>
        </div>
      </div>
    );
  }

  // ✅ FIX #2: Show loading for non-students (redirect is handled in useEffect)
  if (me.user.role !== "student") {
    return (
      <div className="min-h-screen bg-slate-50 px-4 py-6 lg:px-8" dir={direction}>
        <div className="flex min-h-[200px] items-center justify-center">
          <p className="text-sm text-slate-500">Redirecting...</p>
        </div>
      </div>
    );
  }

  /* =============================================================================
   * Render
   * ========================================================================== */

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 lg:px-8" dir={direction}>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">{t.pageTitle}</h1>
        <p className="text-sm text-slate-500">{t.pageSubtitle}</p>
      </div>

      {/* Step indicator with numbering */}
      <div className="mb-6 flex items-center gap-3">
        <StepDot active={step === 0} label={t.step0Label} n={0} />
        <div className="h-px flex-1 bg-slate-200" />
        <StepDot active={step === 1} label={t.step1Label} n={1} />
        <div className="h-px flex-1 bg-slate-200" />
        <StepDot active={step === 2} label={t.step2Label} n={2} />
        <div className="h-px flex-1 bg-slate-200" />
        <StepDot active={step === 3} label={t.step3Label} n={3} />
      </div>

      {/* Global error */}
      {topError && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {topError}
        </div>
      )}

      {/* Teacher Details Modal */}
      {detailsOpen && (
        <TeacherDetailsModal
          t={t}
          loading={detailsLoading}
          error={detailsError}
          details={activeTeacherDetails}
          onClose={closeTeacherDetails}
        />
      )}

      {!done ? (
        <>
          {/* =========================
              STEP 0 — Grade scope
              ========================= */}
          {step === 0 && (
            <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
              <h2 className="mb-1 text-lg font-medium text-slate-900">{t.step0Title}</h2>
              <p className="mb-4 text-sm text-slate-500">{t.step0Intro}</p>

              {catalogLoading ? (
                <p className="text-sm text-slate-500">{t.loadingCatalog}</p>
              ) : (
                <div className="space-y-4">
                  {/* System */}
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700">{t.selectSystem}</label>
                    <select
                      value={scopeSystemId}
                      onChange={(e) => {
                        setScopeSystemId(e.target.value);
                        setScopeStageId("");
                        setScopeGradeLevelId("");
                      }}
                      className="block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-500 focus:outline-none"
                    >
                      <option value="">{t.selectSystemPlaceholder}</option>
                      {(catalog?.systems ?? []).map((sys) => (
                        <option key={sys.id} value={String(sys.id)}>{sys.name}</option>
                      ))}
                    </select>
                  </div>

                  {/* Stage */}
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700">{t.selectStage}</label>
                    <select
                      value={scopeStageId}
                      disabled={!scopeSystemId}
                      onChange={(e) => {
                        setScopeStageId(e.target.value);
                        setScopeGradeLevelId("");
                      }}
                      className="block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
                    >
                      <option value="">{t.selectStagePlaceholder}</option>
                      {catalogStagesForSystem.map((st) => (
                        <option key={st.id} value={String(st.id)}>
                          {lang === "ar" ? (st.nameAr || st.nameEn) : (st.nameEn || st.nameAr)}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Grade level (optional) */}
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-700">{t.selectGradeLevel}</label>
                    <select
                      value={scopeGradeLevelId}
                      disabled={!scopeStageId}
                      onChange={(e) => setScopeGradeLevelId(e.target.value)}
                      className="block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-emerald-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
                    >
                      <option value="">{t.selectGradeLevelPlaceholder}</option>
                      {catalogLevelsForStage.map((lv) => (
                        <option key={lv.id} value={String(lv.id)}>
                          {lang === "ar" ? (lv.nameAr || lv.nameEn) : (lv.nameEn || lv.nameAr)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <div className="mt-5 flex justify-end">
                <button
                  type="button"
                  disabled={scopeSaving || catalogLoading || !scopeSystemId || !scopeStageId}
                  onClick={handleSaveScope}
                  className="rounded-md bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {scopeSaving ? t.savingScope : t.next}
                </button>
              </div>
            </div>
          )}

          {/* =========================
              STEP 1
              ========================= */}
          {step === 1 && (
            <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
              <h2 className="mb-4 text-lg font-medium text-slate-900">{t.step1Title}</h2>

              <div className="space-y-4">
                {/* Enrolled */}
                <div className="rounded-lg border border-slate-200 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <input
                      id="mode-enrolled"
                      type="radio"
                      name="subjectMode"
                      checked={pickMode === "enrolled"}
                      // ✅ Correct: this only switches the mode (does not pick "id")
                      onChange={handleSwitchToEnrolledMode}
                    />
                    <label htmlFor="mode-enrolled" className="text-sm font-medium text-slate-900">
                      {t.enrolledRadioTitle}
                    </label>
                  </div>

                  {loadingOnboarding ? (
                    <p className="text-xs text-slate-500">{t.loadingSubjects}</p>
                  ) : studentSubjects.length === 0 ? (
                    <p className="text-xs text-slate-500">{t.noEnrolledSubjects}</p>
                  ) : (
                    <div className="grid gap-2 md:grid-cols-2">
                      {studentSubjects.map((s) => {
                        const id = String(s.subjectId);
                        const name = pickSubjectName(s, lang) || `#${id}`;
                        const checked = pickMode === "enrolled" && pickedEnrolledId === id;

                        const teacherName =
                          s.teacher &&
                          typeof s.teacher.name === "string" &&
                          s.teacher.name.trim().length > 0
                            ? s.teacher.name.trim()
                            : null;

                        const teacherText = teacherName
                          ? `${t.teacherPrefix}: ${teacherName}`
                          : t.noTeacherYet;

                        return (
                          <label
                            key={id}
                            className={`flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 ${
                              checked
                                ? "border-emerald-500 bg-emerald-50"
                                : "border-slate-200 hover:border-slate-300"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <input
                                type="radio"
                                name="enrolledSubject"
                                checked={checked}
                                // ✅ Correct: pass the mapped subject id
                                onChange={() => handlePickEnrolled(id)}
                              />
                              <div className="leading-tight">
                                <div className="text-sm font-medium text-slate-900">{name}</div>
                                <div className="text-[11px] text-slate-500">{teacherText}</div>
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Other */}
                <div className="rounded-lg border border-slate-200 p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <input
                      id="mode-other"
                      type="radio"
                      name="subjectMode"
                      checked={pickMode === "other"}
                      onChange={handlePickOther}
                    />
                    <label htmlFor="mode-other" className="text-sm font-medium text-slate-900">
                      {t.otherRadioTitle}
                    </label>
                  </div>

                  {pickMode === "other" && (
                    <>
                      <p className="mb-2 text-xs font-semibold text-slate-700">
                        {t.availableDropdownTitle}
                      </p>

                      {availableSubjects.length === 0 ? (
                        <p className="text-xs text-slate-500">{t.noAvailableSubjects}</p>
                      ) : (
                        <>
                          <select
                            value={pickedAvailableId}
                            onChange={(e) => handleAvailableDropdownChange(e.target.value)}
                            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                          >
                            <option value="">{t.availableDropdownPlaceholder}</option>
                            {availableSubjects.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>

                          <p className="mt-2 text-[11px] text-slate-500">{t.enrollNote}</p>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                  onClick={() => router.push(withLang("/student/dashboard"))}
                >
                  {t.cancel}
                </button>

                <button
                  type="button"
                  disabled={
                    loadingOnboarding ||
                    enrolling ||
                    (pickMode === "enrolled" && !pickedEnrolledId) ||
                    (pickMode === "other" && (!pickedAvailableId || availableSubjects.length === 0))
                  }
                  onClick={async () => {
                    if (pickMode === "enrolled") {
                      setTopError(null);
                      setStep(2);
                      return;
                    }

                    const ok = await enrollSelectedAvailableSubject();
                    if (ok) {
                      setTopError(null);
                      setStep(2);
                    }
                  }}
                  className={`rounded-md px-4 py-1.5 text-sm text-white ${
                    loadingOnboarding ||
                    enrolling ||
                    (pickMode === "enrolled" && !pickedEnrolledId) ||
                    (pickMode === "other" && (!pickedAvailableId || availableSubjects.length === 0))
                      ? "cursor-not-allowed bg-emerald-300"
                      : "bg-emerald-500 hover:bg-emerald-600"
                  }`}
                >
                  {pickMode === "other" ? (enrolling ? t.enrolling : t.enrollAndNext) : t.next}
                </button>
              </div>
            </div>
          )}

          {/* =========================
              STEP 2
              ========================= */}
          {step === 2 && (
            <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
              <h2 className="mb-3 text-lg font-medium text-slate-900">{t.step2Title}</h2>

              <div className="mb-3 rounded-md bg-slate-50 p-3 text-xs">
                <p className="text-[11px] text-slate-400">{t.subjectLabel}</p>
                <p className="text-sm text-slate-900">{selectedSubjectName || t.notSelected}</p>
              </div>

              {loadingTeachers ? (
                <p className="text-sm text-slate-500">{t.loadingTeachers}</p>
              ) : teachers.length === 0 ? (
                <div className="space-y-3">
                  {teacherError ? (
                    <p className="text-sm text-red-600">{teacherError}</p>
                  ) : (
                    <p className="text-sm text-slate-400">{t.noTeachersForSubject}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      {t.chooseAnotherSubject}
                    </button>
                    {teacherError && (
                      <button
                        type="button"
                        onClick={() => setTeacherRetryKey((k) => k + 1)}
                        className="rounded-md border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50"
                      >
                        {t.retryLoadTeachers}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {teachers.map((teacher) => {
                    const selected = selectedTeacherId === teacher.id;

                    return (
                      <div
                        key={teacher.id}
                        className={`rounded-lg border p-4 text-sm transition ${
                          selected
                            ? "border-emerald-500 bg-emerald-50"
                            : "border-slate-200 hover:border-slate-300"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <button
                            type="button"
                            onClick={() => setSelectedTeacherId(teacher.id)}
                            className="flex-1 text-left"
                            aria-pressed={selected}
                          >
                            <p className="font-medium text-slate-900">{teacher.name}</p>
                            {selectedSubjectName && (
                              <p className="mt-1 text-[11px] text-slate-400">{selectedSubjectName}</p>
                            )}
                            {teacher.ratingAvg !== null ? (
                              <p className="mt-1 text-[11px] text-amber-600">
                                ★ {teacher.ratingAvg.toFixed(1)}{" "}
                                <span className="text-slate-400">({teacher.ratingCount})</span>
                              </p>
                            ) : (
                              <p className="mt-1 text-[11px] text-slate-400">No ratings yet</p>
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openTeacherDetails(teacher.id);
                            }}
                            className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-emerald-700 hover:bg-emerald-100"
                          >
                            {t.viewTeacherDetails}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="mt-5 flex justify-between gap-2">
                <button
                  type="button"
                  className="rounded-md px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                  onClick={() => setStep(1)}
                >
                  {t.back}
                </button>
                <button
                  type="button"
                  disabled={selectedTeacherId.length === 0 || teachers.length === 0}
                  onClick={() => setStep(3)}
                  className={`rounded-md px-4 py-1.5 text-sm text-white ${
                    selectedTeacherId.length === 0 || teachers.length === 0
                      ? "cursor-not-allowed bg-emerald-300"
                      : "bg-emerald-500 hover:bg-emerald-600"
                  }`}
                >
                  {t.next}
                </button>
              </div>
            </div>
          )}

          {/* =========================
              STEP 3
              ========================= */}
          {step === 3 && (
            <div className="rounded-xl border border-slate-100 bg-white p-5 shadow-sm">
              <h2 className="mb-3 text-lg font-medium text-slate-900">{t.step3Title}</h2>

              <p className="mb-4 text-sm text-slate-500">
                {lang === "ar" ? "راجع اختيارك قبل الحفظ." : "Review your selection before saving."}
              </p>

              <div className="mb-4 space-y-3">
                <div className="rounded-md bg-slate-50 p-3">
                  <p className="text-xs text-slate-400">{t.subjectLabel}</p>
                  <p className="text-sm text-slate-900">{selectedSubjectName || t.notSelected}</p>
                </div>

                <div className="rounded-md bg-slate-50 p-3">
                  <p className="text-xs text-slate-400">{t.teacherLabel}</p>
                  <p className="text-sm text-slate-900">
                    {selectedTeacherId.length > 0
                      ? teachers.find((x) => x.id === selectedTeacherId)?.name ?? t.notSelected
                      : t.notSelected}
                  </p>
                </div>
              </div>

              <div className="mt-5 flex justify-between gap-2">
                <button
                  type="button"
                  className="rounded-md px-4 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
                  onClick={() => setStep(2)}
                >
                  {t.back}
                </button>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={submitting || !selectedSubjectId || !selectedTeacherId}
                  className={`rounded-md px-4 py-1.5 text-sm text-white ${
                    submitting || !selectedSubjectId || !selectedTeacherId
                      ? "cursor-not-allowed bg-emerald-300"
                      : "bg-emerald-500 hover:bg-emerald-600"
                  }`}
                >
                  {submitting ? t.saving : t.confirm}
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="rounded-xl border border-emerald-200 bg-white p-6 text-center shadow-sm">
          <p className="mb-2 text-2xl">✅</p>
          <p className="mb-1 font-medium text-slate-900">{t.doneTitle}</p>
          <p className="mb-4 text-sm text-slate-500">{t.doneMessage}</p>
          <button
            type="button"
            onClick={() => router.push(withLang("/student/dashboard"))}
            className="inline-flex items-center rounded-md bg-emerald-500 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-600"
          >
            {t.goToDashboard}
          </button>
        </div>
      )}
    </div>
  );
}

/* =============================================================================
 * Step indicator dot
 * ========================================================================== */

type StepDotProps = {
  active: boolean;
  label: string;
  n: number; // ✅ FIX #4: Added step number
};

function StepDot({ active, label, n }: StepDotProps) {
  return (
    <div className="flex items-center gap-2">
      <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium ${
        active ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-600"
      }`}>
        {n} {/* ✅ FIX #4: Show step number instead of first letter */}
      </div>
      <span className="text-xs text-slate-500">{label}</span>
    </div>
  );
}

/* =============================================================================
 * Teacher Details Modal
 * ========================================================================== */

type TeacherDetailsModalProps = {
  t: LangTexts;
  loading: boolean;
  error: string | null;
  details: TeacherDetails | null;
  onClose: () => void;
};

function TeacherDetailsModal({ t, loading, error, details, onClose }: TeacherDetailsModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        // click outside closes
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <p className="text-sm font-semibold text-slate-900">{t.teacherDetailsTitle}</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
          >
            {t.close}
          </button>
        </div>

        <div className="max-h-[75vh] overflow-auto p-4">
          {loading ? (
            <p className="text-sm text-slate-500">{t.loadingTeacherDetails}</p>
          ) : error ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error}
            </div>
          ) : !details ? (
            <p className="text-sm text-slate-500">{t.failedTeacherDetails}</p>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <div className="h-16 w-16 overflow-hidden rounded-full bg-slate-100">
                  {details.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={details.photoUrl}
                      alt={details.name}
                      className="h-full w-full object-cover"
                    />
                  ) : null}
                </div>

                <div className="min-w-0">
                  <p className="text-base font-semibold text-slate-900">{details.name}</p>

                  {details.bio ? (
                    <div className="mt-2 rounded-md bg-slate-50 p-3">
                      <p className="text-[11px] font-semibold text-slate-600">{t.aboutTeacher}</p>
                      <p className="mt-1 text-sm text-slate-700">{details.bio}</p>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="rounded-md border border-slate-100 bg-white">
                <div className="border-b border-slate-100 px-3 py-2">
                  <p className="text-[11px] font-semibold text-slate-600">{t.teacherVideos}</p>
                </div>

                <div className="p-3">
                  {details.videoClips.length === 0 ? (
                    <p className="text-sm text-slate-500">{t.noTeacherVideos}</p>
                  ) : (
                    <div className="space-y-3">
                      {details.videoClips.map((clip, idx) => (
                        <div
                          key={`${clip.url}-${idx}`}
                          className="rounded-lg border border-slate-200 p-3"
                        >
                          <p className="mb-2 text-sm font-medium text-slate-900">{clip.title}</p>
                          <video
                            controls
                            preload="metadata"
                            className="w-full rounded-md bg-black"
                            src={clip.url}
                          />
                          <a
                            href={clip.url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-block text-[11px] font-medium text-emerald-700 hover:underline"
                          >
                            {t.openVideo}
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-slate-100 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
          >
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}

function StudentOnboardingFallback() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <p className="text-sm text-slate-500">Loading...</p>
    </div>
  );
}

export default function StudentOnboarding() {
  return (
    <Suspense fallback={<StudentOnboardingFallback />}>
      <StudentOnboardingContent />
    </Suspense>
  );
}
