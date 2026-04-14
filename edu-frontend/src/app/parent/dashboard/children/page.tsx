"use client";

import { Suspense, useState, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  UserCircle2,
  BookOpen,
  Loader2,
  IdCard,
  Users,
  ExternalLink,
  Plus,
  AlertCircle,
} from "lucide-react";

import { parentDashboardTexts } from "../parentDashboardTexts";
import { useSession } from "@/src/hooks/useSession";
import {
  useParentStudents,
  useStudentSelections,
  useParentSwitchToStudent,
} from "../parentDashboardHooks";
import type { ParentStudent } from "../parentDashboardTypes";

function ParentChildrenPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const lang = searchParams.get("lang") === "ar" ? "ar" : "en";
  const t = parentDashboardTexts[lang];
  const dir = lang === "ar" ? "rtl" : "ltr";

  // ============================================================================
  // Authentication & Data Loading
  // ============================================================================

  const { loading: sessionLoading, authenticated } = useSession();
  const { students, loading, error } = useParentStudents();
  const { switchToStudent, switching, error: switchError } =
    useParentSwitchToStudent();

  const notAuthed =
    !sessionLoading && (!authenticated || error === "NOT_AUTHENTICATED");

  const [switchingStudentUserId, setSwitchingStudentUserId] = useState<
    number | null
  >(null);

  // ============================================================================
  // Helper Functions
  // ============================================================================

  const studentDashboardUrl = useMemo(() => {
    const base = "/student/dashboard";
    return `${base}?lang=${lang}&from=parent`;
  }, [lang]);

  const goToStudentDashboard = async (student: ParentStudent) => {
    if (!student.studentUserId) {
      alert(
        lang === "ar"
          ? "هوية الابن غير مكتملة. يرجى التواصل مع الدعم."
          : "Linked child identity is incomplete. Please contact support."
      );
      return;
    }

    setSwitchingStudentUserId(student.studentUserId);
    const result = await switchToStudent(student.studentUserId);
    setSwitchingStudentUserId(null);

    if (result.ok) {
      router.push(studentDashboardUrl);
      router.refresh();
    }
  };

  /**
   * ✅ Single unified navigation:
   * Both "Choose Teacher" and "Change Teacher" must go to ChooseTeacher page.
   *
   * ChooseTeacher page will detect if there is already a teacher for this subject:
   *  - If NO teacher => assign immediately (POST /parent/teacher-options/select)
   *  - If teacher exists => create change request (POST /parent/requests)
   */
  const goToChooseTeacher = (args: {
    studentId: number;
    subjectId: number;
  }) => {
    router.push(
      `/parent/choose-teacher?studentId=${args.studentId}&subjectId=${args.subjectId}&lang=${lang}`
    );
  };

  // ============================================================================
  // ChildSelections Component (Shows ALL subjects by default)
  // ============================================================================

  interface ChildSelectionsProps {
    student: ParentStudent;
  }

  function ChildSelections({ student }: ChildSelectionsProps) {
    const studentIdForSelections = student.studentId;

    const {
      rows,
      loading: selectionsLoading,
      error: selectionsError,
    } = useStudentSelections(studentIdForSelections);

    // Error & Loading States
    if (selectionsError === "NOT_AUTHENTICATED") {
      return (
        <div className="rounded-lg border border-red-100 bg-red-50 p-3 text-sm text-red-700">
          {lang === "ar" ? "يجب تسجيل الدخول." : "You must be logged in."}
        </div>
      );
    }

    if (selectionsLoading) {
      return (
        <div className="flex items-center gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />
          {t.childrenSelectionsLoading}
        </div>
      );
    }

    if (selectionsError) {
      return (
        <div className="rounded-lg border border-red-100 bg-red-50 p-3 text-sm text-red-700">
          {t.childrenSelectionsError}
        </div>
      );
    }

    if (rows.length === 0) {
      return (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-center">
          <BookOpen className="mx-auto h-8 w-8 text-slate-400" />
          <p className="mt-2 text-sm text-slate-500">
            {t.childrenSelectionsEmpty}
          </p>
          <button
            type="button"
            onClick={() =>
              router.push(
                `/parent/add-subject?studentId=${student.studentId}&lang=${lang}`
              )
            }
            className="mt-3 inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-600"
          >
            <Plus className="h-3 w-3" />
            {lang === "ar" ? "إضافة أول مادة" : "Add First Subject"}
          </button>
        </div>
      );
    }

    // Calculate Stats
    const subjectsWithTeacher = rows.filter((r) => r.teacherId).length;
    const subjectsWithoutTeacher = rows.length - subjectsWithTeacher;

    return (
      <div className="space-y-3">
        {/* Quick Stats Bar */}
        <div className="rounded-lg bg-emerald-50/50 p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="text-center">
                <div className="text-sm font-semibold text-slate-900">
                  {rows.length}
                </div>
                <div className="text-[10px] text-slate-500">
                  {lang === "ar" ? "مادة" : "Subjects"}
                </div>
              </div>

              <div className="h-4 w-px bg-slate-300"></div>

              <div className="text-center">
                <div className="text-sm font-semibold text-emerald-700">
                  {subjectsWithTeacher}
                </div>
                <div className="text-[10px] text-slate-500">
                  {lang === "ar" ? "مع مدرس" : "With Teacher"}
                </div>
              </div>

              <div className="h-4 w-px bg-slate-300"></div>

              <div className="text-center">
                <div className="text-sm font-semibold text-amber-600">
                  {subjectsWithoutTeacher}
                </div>
                <div className="text-[10px] text-slate-500">
                  {lang === "ar" ? "بدون مدرس" : "Needs Teacher"}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ALL Subjects List */}
        <div className="space-y-2">
          {rows.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between rounded-lg border border-slate-100 bg-white p-3"
            >
              <div className="flex items-center gap-3">
                <BookOpen
                  className={`h-4 w-4 ${
                    s.teacherId ? "text-emerald-500" : "text-amber-500"
                  }`}
                />
                <div>
                  <p className="text-sm font-medium text-slate-900">
                    {lang === "ar"
                      ? s.subjectNameAr || s.subjectNameEn
                      : s.subjectNameEn || s.subjectNameAr}
                  </p>
                  <p className="text-xs text-slate-500">
                    {s.teacherName ||
                      (lang === "ar" ? "بدون مدرس" : "No teacher")}
                  </p>
                </div>
              </div>

              <div className="flex gap-1">
                {/* ✅ FIRST-TIME: Choose Teacher */}
                {!s.teacherId ? (
                  <button
                    type="button"
                    onClick={() =>
                      goToChooseTeacher({
                        studentId: student.studentId,
                        subjectId: s.subjectId,
                      })
                    }
                    className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600"
                  >
                    {t.childrenActionChooseTeacher}
                  </button>
                ) : (
                  /* ✅ HAS TEACHER: Change Teacher (still goes to ChooseTeacher page) */
                  <button
                    type="button"
                    onClick={() =>
                      goToChooseTeacher({
                        studentId: student.studentId,
                        subjectId: s.subjectId,
                      })
                    }
                    className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-600"
                  >
                    {lang === "ar" ? "تغيير المعلم" : "Change Teacher"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ============================================================================
  // ChildCard Component
  // ============================================================================

  interface ChildCardProps {
    student: ParentStudent;
  }

  function ChildCard({ student }: ChildCardProps) {
    const isSwitching =
      student.studentUserId != null &&
      switchingStudentUserId === student.studentUserId;
    const hasChildIdentity = student.studentUserId != null;
    const directLoginEnabled = student.hasOwnLogin;
    const childAccountStatus =
      lang === "ar"
        ? hasChildIdentity
          ? "هوية الابن: مكتملة"
          : "هوية الابن: غير مكتملة (مشكلة بيانات)"
        : hasChildIdentity
          ? "Child identity: complete"
          : "Child identity: incomplete (data integrity issue)";
    const directLoginStatus =
      lang === "ar"
        ? directLoginEnabled
          ? "تسجيل الدخول المباشر: مفعل"
          : "تسجيل الدخول المباشر: غير مفعل"
        : directLoginEnabled
          ? "Direct login: enabled"
          : "Direct login: disabled";

    return (
      <div className="overflow-hidden rounded-xl border border-emerald-100 bg-linear-to-br from-emerald-50/40 to-white shadow-sm transition-all duration-200 hover:shadow-md">
        {/* Header */}
        <div className="p-4">
          <div className="flex items-start justify-between gap-4">
            {/* Avatar & Info */}
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-emerald-100 p-2">
                <UserCircle2 className="h-8 w-8 text-emerald-600" />
              </div>

              <div className="flex-1">
                {/* Name + Grade */}
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {student.studentName}
                  </h3>
                  {student.gradeStage && (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                      {student.gradeStage} {student.gradeNumber ?? ""}
                    </span>
                  )}
                </div>

                {/* Meta */}
                <div className="mt-1 space-y-1">
                  {student.relationship && (
                    <div className="flex items-center gap-1 text-xs text-slate-600">
                      <Users className="h-3 w-3 text-slate-400" />
                      <span>
                        {lang === "ar" ? "العلاقة: " : "Relationship: "}
                        {student.relationship}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center gap-1 text-xs text-slate-500">
                    <IdCard className="h-3 w-3 text-slate-400" />
                    <span>ID: {student.studentId}</span>
                    {student.studentUserId &&
                      student.studentUserId !== student.studentId && (
                        <>
                          <span className="text-slate-300">•</span>
                          <span>
                            {lang === "ar" ? "الحساب: " : "Account: "}
                            {student.studentUserId}
                          </span>
                        </>
                      )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={hasChildIdentity ? "text-slate-500" : "text-red-600"}
                    >
                      {childAccountStatus}
                    </span>
                    <span className="text-slate-300">•</span>
                    <span
                      className={
                        directLoginEnabled ? "text-emerald-600" : "text-amber-600"
                      }
                    >
                      {directLoginStatus}
                    </span>
                  </div>
                  {!hasChildIdentity && (
                    <div className="mt-1 inline-flex items-center gap-1 rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700 ring-1 ring-red-200">
                      <AlertCircle className="h-3 w-3" />
                      <span>
                        {lang === "ar"
                          ? "البيانات غير مكتملة. يرجى التواصل مع الدعم."
                          : "Linked child identity is incomplete. Please contact support."}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Go to student dashboard */}
            <button
              type="button"
              disabled={isSwitching || switching || !hasChildIdentity}
              onClick={(event) => {
                event.stopPropagation();
                void goToStudentDashboard(student);
              }}
              className={`
                inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold
                transition-all duration-150
                ${
                  isSwitching || switching || !hasChildIdentity
                    ? "cursor-not-allowed bg-slate-100 text-slate-400"
                    : "bg-linear-to-r from-emerald-500 to-emerald-600 text-white shadow-sm hover:from-emerald-600 hover:to-emerald-700 hover:shadow"
                }
              `}
              title={
                !hasChildIdentity
                  ? lang === "ar"
                    ? "هوية الابن غير مكتملة. يرجى التواصل مع الدعم."
                    : "Linked child identity is incomplete. Please contact support."
                  : undefined
              }
            >
              {isSwitching ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {lang === "ar" ? "جاري التحويل..." : "Switching..."}
                </>
              ) : (
                <>
                  <ExternalLink className="h-3 w-3" />
                  {lang === "ar" ? "لوحة الطالب" : "Student Dashboard"}
                </>
              )}
            </button>
          </div>
        </div>

        {/* Subjects */}
        <div className="border-t border-emerald-100 p-4">
          <ChildSelections student={student} />
        </div>

        {/* Add Subject */}
        <div className="border-t border-emerald-100 bg-emerald-50/30 p-3">
          <button
            type="button"
            onClick={() =>
              router.push(`/parent/add-subject?studentId=${student.studentId}&lang=${lang}`)
            }
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-medium text-orange-400 transition-colors hover:bg-emerald-600"
          >
            <Plus className="h-4 w-4" />
            {lang === "ar" ? "إضافة مادة جديدة" : "Add New Subject"}
          </button>
        </div>
      </div>
    );
  }

  // ============================================================================
  // Main Render
  // ============================================================================

  return (
    <div className="space-y-6" dir={dir}>
      {/* Header */}
      <header className="rounded-2xl border border-emerald-100 bg-linear-to-r from-emerald-50/50 to-white p-5 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">{t.childrenTitle}</h1>
            <p className="text-sm text-slate-500">{t.childrenSubtitle}</p>
          </div>

          <button
            type="button"
            onClick={() => router.push(`/parent/add-child?lang=${lang}`)}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
          >
            <Plus className="h-4 w-4" />
            {lang === "ar" ? "إضافة طفل جديد" : "Add New Child"}
          </button>
        </div>

        {/* Auth Errors */}
        {notAuthed && (
          <div className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-800 ring-1 ring-red-200">
            {lang === "ar"
              ? "يجب تسجيل الدخول كولي أمر."
              : "You must be logged in as a parent."}
          </div>
        )}

        {/* Switching Errors */}
        {switchError && switchError !== "NOT_AUTHENTICATED" && (
          <div className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-amber-200">
            {switchError}
          </div>
        )}
      </header>

      {/* Content */}
      <section className="rounded-2xl border border-emerald-100 bg-linear-to-b from-emerald-50/20 to-white p-5 shadow-sm backdrop-blur-sm">
        {/* Loading */}
        {(sessionLoading || loading) && !notAuthed && (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-500" />
            <p className="mt-3 text-sm text-slate-500">
              {lang === "ar"
                ? "جاري تحميل بيانات الأطفال..."
                : "Loading children data..."}
            </p>
          </div>
        )}

        {/* Error */}
        {!notAuthed && error && error !== "NOT_AUTHENTICATED" && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-red-500" />
              <div>
                <h4 className="text-sm font-medium text-red-800">
                  {lang === "ar" ? "خطأ في تحميل البيانات" : "Data Loading Error"}
                </h4>
                <p className="mt-1 text-sm text-red-700">{t.loadError}</p>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="mt-2 rounded-lg bg-red-100 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-200"
                >
                  {lang === "ar" ? "إعادة المحاولة" : "Try Again"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Empty */}
        {!sessionLoading && !loading && !notAuthed && students.length === 0 && (
          <div className="rounded-xl border border-dashed border-emerald-200 bg-linear-to-br from-emerald-50/30 to-white p-8 text-center">
            <div className="mx-auto inline-flex rounded-full bg-emerald-100 p-4">
              <UserCircle2 className="h-12 w-12 text-emerald-600" />
            </div>
            <h3 className="mt-4 text-sm font-semibold text-slate-900">
              {lang === "ar" ? "لا توجد أطفال مسجلين" : "No children registered"}
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              {lang === "ar"
                ? "ابدأ بإضافة طفلك الأول لتعيين المواد والمدرسين."
                : "Start by adding your first child to assign subjects and teachers."}
            </p>
            <button
              type="button"
              onClick={() => router.push(`/parent/add-child?lang=${lang}`)}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
            >
              <Plus className="h-4 w-4" />
              {lang === "ar" ? "إضافة طفل جديد" : "Add New Child"}
            </button>
          </div>
        )}

        {/* Children */}
        {!sessionLoading && !loading && !notAuthed && students.length > 0 && (
          <div className="space-y-4">
            <div className="rounded-lg bg-emerald-50/50 p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-slate-900">
                  {lang === "ar" ? "إجمالي الأطفال:" : "Total Children:"}{" "}
                  {students.length}
                </p>
                <p className="text-xs text-slate-500">
                  {lang === "ar"
                    ? "جميع المواد معروضة أدناه"
                    : "All subjects are shown below"}
                </p>
              </div>
            </div>

            {students.map((student) => (
              <ChildCard key={student.linkId || student.studentId} student={student} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ParentChildrenPageFallback() {
  return <div className="space-y-6"><div className="h-32 animate-pulse rounded-2xl bg-slate-100" /></div>;
}

export default function ParentChildrenPage() {
  return (
    <Suspense fallback={<ParentChildrenPageFallback />}>
      <ParentChildrenPageContent />
    </Suspense>
  );
}
