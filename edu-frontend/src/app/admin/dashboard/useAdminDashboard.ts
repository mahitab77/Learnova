// src/app/admin/dashboard/useAdminDashboard.ts
// ============================================================================
// Admin Dashboard Hook (DROP-IN REPLACEMENT)
// ----------------------------------------------------------------------------
// ✅ No feature removal (subjects, teachers, approvals, schedules, users, etc.)
// ✅ SESSION-TRUTH admin guard (prevents false "Not Admin" flash)
// ✅ Admin Notifications inbox support (panel-ready):
//    - loadAdminNotifications()
//    - markAdminNotificationRead()
//    - markAllAdminNotificationsRead()
// ✅ No `any`
// ✅ Uses ONLY shared notification types from adminTypes.ts
// ✅ Normalizes backend shapes:
//      - NotificationRow[] OR
//      - NotificationInbox { unreadCount, items }
// ============================================================================

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import adminService from "@/src/services/adminService";

import {
  AdminUser,
  Lang,
  ParentRequestRow,
  SubjectAdminRow,
  TabKey,
  TeacherAdminRow,
  StudentAdminRow,
  ParentAdminRow,
  ParentStudentLinkRow,
  TeacherAssignmentRow,
  TeacherScheduleRow,
  AnnouncementRow,
  AdminOverview,
  AdminSettings,
  AdminLessonSessionRow,
  NotificationInbox,
  NotificationRow,
  NotificationApiResponse,
  adminTypeUtils,
  ModeratorAdminRow,
} from "./adminTypes";

import type { LangTexts } from "./adminTexts";

// ---------------------------------------------------------------------------
// Phase 3 Feature Flag (module scope => stable, no deps warnings)
// ---------------------------------------------------------------------------
const ENABLE_LESSON_SESSIONS_ENDPOINT =
  process.env.NEXT_PUBLIC_ENABLE_LESSON_SESSIONS_ENDPOINT === "1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  return fallback;
}

/**
 * Normalize notifications API response into NotificationInbox.
 * Supports:
 *  - NotificationRow[]                          (list-only)
 *  - NotificationInbox { unreadCount, items }   (list + unreadCount)
 */
function normalizeInbox(raw: NotificationApiResponse): NotificationInbox {
  if (Array.isArray(raw)) {
    const unreadCount = raw.reduce((acc, n) => {
      const isRead = adminTypeUtils.normalizeIsRead(n.is_read);
      return acc + (isRead ? 0 : 1);
    }, 0);

    return { unreadCount, items: raw };
  }

  const items: NotificationRow[] = Array.isArray(raw.items) ? raw.items : [];

  const unreadCount =
    typeof raw.unreadCount === "number"
      ? raw.unreadCount
      : items.reduce((acc, n) => {
          const isRead = adminTypeUtils.normalizeIsRead(n.is_read);
          return acc + (isRead ? 0 : 1);
        }, 0);

  return { unreadCount, items };
}

export function useAdminDashboard(lang: Lang, t: LangTexts) {
  // -------------------------------------------------------------------------
  // Role guard state
  // -------------------------------------------------------------------------
  const [adminUser, setAdminUser] = useState<AdminUser | null>(null);

  // LocalStorage loaded flag (UI hint only)
  const [localChecked, setLocalChecked] = useState(false);

  // Session-truth admin check (source of truth)
  const [sessionChecked, setSessionChecked] = useState(false);
  const [sessionIsAdmin, setSessionIsAdmin] = useState<boolean | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [loadedTabs, setLoadedTabs] = useState<Partial<Record<TabKey, boolean>>>({
    overview: true,
  });

  // -------------------------------------------------------------------------
  // OVERVIEW state
  // -------------------------------------------------------------------------
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Subjects state
  // -------------------------------------------------------------------------
  const [subjects, setSubjects] = useState<SubjectAdminRow[]>([]);
  const [subjectsLoading, setSubjectsLoading] = useState(false);
  const [subjectsError, setSubjectsError] = useState<string | null>(null);

  const [newSubNameAr, setNewSubNameAr] = useState("");
  const [newSubNameEn, setNewSubNameEn] = useState("");
  const [newSubSort, setNewSubSort] = useState<string>("");
  const [newSubActive, setNewSubActive] = useState(true);
  const [creatingSubject, setCreatingSubject] = useState(false);
  const [creatingSubjectError, setCreatingSubjectError] = useState<string | null>(null);

  const [editingSubjectId, setEditingSubjectId] = useState<number | null>(null);
  const [editSubNameAr, setEditSubNameAr] = useState("");
  const [editSubNameEn, setEditSubNameEn] = useState("");
  const [editSubSort, setEditSubSort] = useState<string>("");
  const [editSubActive, setEditSubActive] = useState(true);
  const [updatingSubject, setUpdatingSubject] = useState(false);
  const [updatingSubjectError, setUpdatingSubjectError] = useState<string | null>(null);
  const [deletingSubjectId, setDeletingSubjectId] = useState<number | null>(null);
  const [deletingSubjectError, setDeletingSubjectError] = useState<string | null>(null);
  const [subjectMessage, setSubjectMessage] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Teachers state
  // -------------------------------------------------------------------------
  const [teachers, setTeachers] = useState<TeacherAdminRow[]>([]);
  const [teachersLoading, setTeachersLoading] = useState(false);
  const [teachersError, setTeachersError] = useState<string | null>(null);

  const [newTeacherName, setNewTeacherName] = useState("");
  const [newTeacherBio, setNewTeacherBio] = useState("");
  const [newTeacherGender, setNewTeacherGender] = useState("");
  const [newTeacherPhotoUrl, setNewTeacherPhotoUrl] = useState("");
  const [newTeacherActive, setNewTeacherActive] = useState(true);
  const [creatingTeacher, setCreatingTeacher] = useState(false);
  const [creatingTeacherError, setCreatingTeacherError] = useState<string | null>(null);
  const [teacherMessage, setTeacherMessage] = useState<string | null>(null);

  const [assignTeacherId, setAssignTeacherId] = useState<string>("");
  const [assignSubjectId, setAssignSubjectId] = useState<string>("");
  const [assignPriority, setAssignPriority] = useState<string>("");
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null);
  const [assignSubjectsLoading, setAssignSubjectsLoading] = useState(false);
  const [assignSubjectsError, setAssignSubjectsError] = useState<string | null>(null);

  const [updatingTeacherId, setUpdatingTeacherId] = useState<number | null>(null);
  const [updatingTeacherError, setUpdatingTeacherError] = useState<string | null>(null);
  const [teacherActionError, setTeacherActionError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // TEACHER APPROVALS state
  // -------------------------------------------------------------------------
  const [pendingTeachers, setPendingTeachers] = useState<TeacherAdminRow[]>([]);
  const [pendingTeachersLoading, setPendingTeachersLoading] = useState(false);
  const [pendingTeachersError, setPendingTeachersError] = useState<string | null>(null);
  const [approvingTeacherId, setApprovingTeacherId] = useState<number | null>(null);
  const [rejectingTeacherId, setRejectingTeacherId] = useState<number | null>(null);
  const [updatingCapacityTeacherId, setUpdatingCapacityTeacherId] = useState<number | null>(null);

  // -------------------------------------------------------------------------
  // ASSIGNMENTS state
  // -------------------------------------------------------------------------
  const [teacherAssignments, setTeacherAssignments] = useState<TeacherAssignmentRow[]>([]);
  const [teacherAssignmentsLoading, setTeacherAssignmentsLoading] = useState(false);
  const [teacherAssignmentsError, setTeacherAssignmentsError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // SCHEDULES state
  // -------------------------------------------------------------------------
  const [teacherSchedules, setTeacherSchedules] = useState<TeacherScheduleRow[]>([]);
  const [teacherSchedulesLoading, setTeacherSchedulesLoading] = useState(false);
  const [teacherSchedulesError, setTeacherSchedulesError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // ANNOUNCEMENTS state
  // -------------------------------------------------------------------------
  const [announcements, setAnnouncements] = useState<AnnouncementRow[]>([]);
  const [announcementsLoading, setAnnouncementsLoading] = useState(false);
  const [announcementsError, setAnnouncementsError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // ADMIN NOTIFICATIONS state
  // -------------------------------------------------------------------------
  const [adminNotifications, setAdminNotifications] = useState<NotificationInbox>({
    unreadCount: 0,
    items: [],
  });
  const [adminNotificationsLoading, setAdminNotificationsLoading] = useState(false);
  const [adminNotificationsError, setAdminNotificationsError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Parent requests state
  // -------------------------------------------------------------------------
  const [requests, setRequests] = useState<ParentRequestRow[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [approvingLessonId, setApprovingLessonId] = useState<number | null>(null);
  const [cancellingLessonId, setCancellingLessonId] = useState<number | null>(null);

  // -------------------------------------------------------------------------
  // Users (Students & Parents) state
  // -------------------------------------------------------------------------
  const [students, setStudents] = useState<StudentAdminRow[]>([]);
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [studentsError, setStudentsError] = useState<string | null>(null);

  const [parents, setParents] = useState<ParentAdminRow[]>([]);
  const [parentsLoading, setParentsLoading] = useState(false);
  const [parentsError, setParentsError] = useState<string | null>(null);

  const [updatingUserId, setUpdatingUserId] = useState<number | null>(null);
  const [userActionError, setUserActionError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Parent ↔ Student links state
  // -------------------------------------------------------------------------
  const [parentStudentLinks, setParentStudentLinks] = useState<ParentStudentLinkRow[]>([]);
  const [parentStudentLinksLoading, setParentStudentLinksLoading] = useState(false);
  const [parentStudentLinksError, setParentStudentLinksError] = useState<string | null>(null);
  const [creatingLink, setCreatingLink] = useState(false);
  const [creatingLinkError, setCreatingLinkError] = useState<string | null>(null);
  const [deletingLinkId, setDeletingLinkId] = useState<number | null>(null);
  const [deletingLinkError, setDeletingLinkError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // SETTINGS state
  // -------------------------------------------------------------------------
  const [adminSettings, setAdminSettings] = useState<AdminSettings | null>(null);
  const [adminSettingsLoading, setAdminSettingsLoading] = useState(false);
  const [adminSettingsError, setAdminSettingsError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // ADMIN LESSON SESSIONS (Phase 3)
  // -------------------------------------------------------------------------
  const [lessonSessions, setLessonSessions] = useState<AdminLessonSessionRow[]>([]);
  const [lessonSessionsLoading, setLessonSessionsLoading] = useState(false);
  const [lessonSessionsError, setLessonSessionsError] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // MODERATORS state
  // -------------------------------------------------------------------------
  const [moderators, setModerators] = useState<ModeratorAdminRow[]>([]);
  const [moderatorsLoading, setModeratorsLoading] = useState(false);
  const [moderatorsError, setModeratorsError] = useState<string | null>(null);
  const [creatingModerator, setCreatingModerator] = useState(false);
  const [creatingModeratorError, setCreatingModeratorError] = useState<string | null>(null);
  const [moderatorMessage, setModeratorMessage] = useState<string | null>(null);

  const dir = lang === "ar" ? "rtl" : "ltr";

  // -------------------------------------------------------------------------
  // Role guard: localStorage (UI hint only)
  // -------------------------------------------------------------------------
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("edu-user");
      if (!raw) return;
      const parsed = JSON.parse(raw) as AdminUser;
      setAdminUser(parsed);
    } catch {
      // ignore
    } finally {
      setLocalChecked(true);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Session-truth admin check (uses /admin/overview)
  // -------------------------------------------------------------------------
  const checkAdminSession = useCallback(async () => {
    setSessionError(null);
    try {
      const data = await adminService.getAdminOverview();
      setOverview(data);
      setSessionIsAdmin(true);
    } catch (err: unknown) {
      console.log("Admin session check failed:", err);
      setSessionIsAdmin(false);
      setSessionError(
        lang === "ar"
          ? "جلسة المدير غير صالحة. الرجاء تسجيل الدخول مرة أخرى."
          : "Admin session is not valid. Please login again."
      );
    } finally {
      setSessionChecked(true);
    }
  }, [lang]);

  // -------------------------------------------------------------------------
  // LOADERS
  // -------------------------------------------------------------------------
  const loadOverview = useCallback(async () => {
    try {
      setOverviewLoading(true);
      setOverviewError(null);
      const data = await adminService.getAdminOverview();
      setOverview(data);
    } catch (err: unknown) {
      setOverviewError(getErrorMessage(err, "Failed to load overview data."));
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  const loadSubjects = useCallback(async () => {
    try {
      setSubjectsLoading(true);
      setSubjectsError(null);
      const data = await adminService.getSubjects();
      setSubjects(data);
    } catch (err: unknown) {
      setSubjectsError(getErrorMessage(err, t.subjectsError));
    } finally {
      setSubjectsLoading(false);
    }
  }, [t.subjectsError]);

  const loadTeachers = useCallback(async () => {
    try {
      setTeachersLoading(true);
      setTeachersError(null);
      const data = await adminService.getTeachers();
      setTeachers(data);
    } catch (err: unknown) {
      setTeachersError(getErrorMessage(err, t.teachersError));
    } finally {
      setTeachersLoading(false);
    }
  }, [t.teachersError]);

  const loadPendingTeachers = useCallback(async () => {
    try {
      setPendingTeachersLoading(true);
      setPendingTeachersError(null);
      const data = await adminService.getPendingTeachers();
      setPendingTeachers(data);
    } catch (err: unknown) {
      setPendingTeachersError(getErrorMessage(err, "Failed to load pending teachers."));
    } finally {
      setPendingTeachersLoading(false);
    }
  }, []);

  const loadTeacherAssignments = useCallback(async () => {
    try {
      setTeacherAssignmentsLoading(true);
      setTeacherAssignmentsError(null);
      const data = await adminService.getTeacherAssignments();
      setTeacherAssignments(data);
    } catch (err: unknown) {
      setTeacherAssignmentsError(getErrorMessage(err, "Failed to load teacher assignments."));
    } finally {
      setTeacherAssignmentsLoading(false);
    }
  }, []);

  const loadTeacherSchedules = useCallback(async () => {
    try {
      setTeacherSchedulesLoading(true);
      setTeacherSchedulesError(null);
      const data = await adminService.getTeacherSchedules();
      setTeacherSchedules(data);
    } catch (err: unknown) {
      setTeacherSchedulesError(getErrorMessage(err, "Failed to load teacher schedules."));
    } finally {
      setTeacherSchedulesLoading(false);
    }
  }, []);

  const loadAnnouncements = useCallback(async () => {
    try {
      setAnnouncementsLoading(true);
      setAnnouncementsError(null);
      const data = await adminService.getAnnouncements();
      setAnnouncements(data);
    } catch (err: unknown) {
      setAnnouncementsError(getErrorMessage(err, "Failed to load announcements."));
    } finally {
      setAnnouncementsLoading(false);
    }
  }, []);

  const loadAdminNotifications = useCallback(async () => {
    try {
      setAdminNotificationsLoading(true);
      setAdminNotificationsError(null);

      const raw = (await adminService.getAdminNotifications()) as NotificationApiResponse;
      const inbox = normalizeInbox(raw);

      setAdminNotifications(inbox);
    } catch (err: unknown) {
      setAdminNotificationsError(getErrorMessage(err, "Failed to load notifications."));
    } finally {
      setAdminNotificationsLoading(false);
    }
  }, []);

  const loadRequests = useCallback(async () => {
    try {
      setRequestsLoading(true);
      setRequestsError(null);
      const [parentData, lessonData] = await Promise.all([
        adminService.getParentRequests(),
        adminService.getPendingLessonRequests(),
      ]);
      const lessonRows = Array.isArray(lessonData)
        ? lessonData.map((row) => {
            const r = row as Record<string, unknown>;
            return {
              id: Number(r.id || 0),
              status: "pending",
              reason_text: null,
              created_at: (typeof r.created_at === "string" ? r.created_at : null),
              parent_id: 0,
              parent_name:
                typeof r.requested_by === "string" ? r.requested_by : "System",
              student_id: 0,
              student_name:
                typeof r.requested_by === "string" ? r.requested_by : "Student",
              subject_name_en:
                typeof r.subject_name_en === "string" ? r.subject_name_en : "",
              subject_name_ar:
                typeof r.subject_name_ar === "string" ? r.subject_name_ar : "",
              current_teacher_id: null,
              current_teacher_name:
                typeof r.teacher_name === "string" ? r.teacher_name : null,
              request_type: "lesson" as const,
            };
          })
        : [];
      const parentRows = parentData.map((r) => ({
        ...r,
        request_type: "parent" as const,
      }));
      setRequests([...lessonRows, ...parentRows]);
    } catch (err: unknown) {
      setRequestsError(getErrorMessage(err, t.requestsError));
    } finally {
      setRequestsLoading(false);
    }
  }, [t.requestsError]);

  const loadStudents = useCallback(async () => {
    try {
      setStudentsLoading(true);
      setStudentsError(null);
      const data = await adminService.getStudents();
      setStudents(data);
    } catch (err: unknown) {
      setStudentsError(getErrorMessage(err, "Failed to load students."));
    } finally {
      setStudentsLoading(false);
    }
  }, []);

  const loadParents = useCallback(async () => {
    try {
      setParentsLoading(true);
      setParentsError(null);
      const data = await adminService.getParents();
      setParents(data);
    } catch (err: unknown) {
      setParentsError(getErrorMessage(err, "Failed to load parents."));
    } finally {
      setParentsLoading(false);
    }
  }, []);

  const loadParentStudentLinks = useCallback(async () => {
    try {
      setParentStudentLinksLoading(true);
      setParentStudentLinksError(null);
      const data = await adminService.getParentStudentLinks();
      setParentStudentLinks(data);
    } catch (err: unknown) {
      setParentStudentLinksError(getErrorMessage(err, "Failed to load parent–student links."));
    } finally {
      setParentStudentLinksLoading(false);
    }
  }, []);

  const loadAdminSettings = useCallback(async () => {
    try {
      setAdminSettingsLoading(true);
      setAdminSettingsError(null);
      const data = await adminService.getAdminSettings();
      setAdminSettings(data);
    } catch (err: unknown) {
      setAdminSettingsError(getErrorMessage(err, "Failed to load admin settings."));
    } finally {
      setAdminSettingsLoading(false);
    }
  }, []);

  const loadAssignSubjects = useCallback(async () => {
    try {
      setAssignSubjectsLoading(true);
      setAssignSubjectsError(null);
      const data = await adminService.getSubjects();
      setSubjects(data);
    } catch (err: unknown) {
      setAssignSubjectsError(getErrorMessage(err, t.teachersSubjectsError));
    } finally {
      setAssignSubjectsLoading(false);
    }
  }, [t.teachersSubjectsError]);

  // -------------------------------------------------------------------------
  // Lesson Sessions Loader (Phase 3)
  // -------------------------------------------------------------------------
  const loadLessonSessions = useCallback(async () => {
    if (!ENABLE_LESSON_SESSIONS_ENDPOINT) {
      setLessonSessions([]);
      setLessonSessionsError(
        lang === "ar"
          ? "ميزة جلسات الدروس غير مفعّلة حالياً لأن الـ backend لا يحتوي على /admin/lesson-sessions بعد."
          : "Lesson sessions are disabled for now because the backend endpoint /admin/lesson-sessions is not implemented yet."
      );
      return;
    }

    try {
      setLessonSessionsLoading(true);
      setLessonSessionsError(null);
      const data = await adminService.getAdminLessonSessions();
      setLessonSessions(data);
    } catch (err: unknown) {
      setLessonSessionsError(getErrorMessage(err, "Failed to load lesson sessions."));
    } finally {
      setLessonSessionsLoading(false);
    }
  }, [lang]);

  const loadModerators = useCallback(async () => {
    try {
      setModeratorsLoading(true);
      setModeratorsError(null);
      const data = await adminService.getModerators();
      setModerators(data);
    } catch (err: unknown) {
      setModeratorsError(getErrorMessage(err, "Failed to load moderators."));
    } finally {
      setModeratorsLoading(false);
    }
  }, []);

  const handleCreateModerator = useCallback(
    async (input: { full_name: string; email: string; password: string }) => {
      setCreatingModerator(true);
      setCreatingModeratorError(null);
      setModeratorMessage(null);
      try {
        await adminService.createModerator(input);
        await loadModerators();
        setModeratorMessage(
          lang === "ar" ? "تم إنشاء حساب المشرف المساعد بنجاح." : "Moderator account created."
        );
      } catch (err: unknown) {
        setCreatingModeratorError(getErrorMessage(err, "Failed to create moderator."));
      } finally {
        setCreatingModerator(false);
      }
    },
    [lang, loadModerators]
  );

  const loadTabData = useCallback(
    async (tab: TabKey) => {
      switch (tab) {
        case "overview":
          await loadOverview();
          break;
        case "subjects":
          await loadSubjects();
          break;
        case "teachers":
          await Promise.all([loadTeachers(), loadAssignSubjects()]);
          break;
        case "approvals":
          await loadPendingTeachers();
          break;
        case "assignments":
          await loadTeacherAssignments();
          break;
        case "schedules":
          await loadTeacherSchedules();
          break;
        case "sessions":
          if (ENABLE_LESSON_SESSIONS_ENDPOINT) {
            await loadLessonSessions();
          }
          break;
        case "announcements":
          await loadAnnouncements();
          break;
        case "notifications":
          await loadAdminNotifications();
          break;
        case "requests":
          await loadRequests();
          break;
        case "users":
          await Promise.all([loadStudents(), loadParents(), loadParentStudentLinks()]);
          break;
        case "moderators":
          await loadModerators();
          break;
        case "settings":
          await loadAdminSettings();
          break;
        default:
          break;
      }
    },
    [
      loadOverview,
      loadSubjects,
      loadTeachers,
      loadAssignSubjects,
      loadPendingTeachers,
      loadTeacherAssignments,
      loadTeacherSchedules,
      loadLessonSessions,
      loadAnnouncements,
      loadAdminNotifications,
      loadRequests,
      loadStudents,
      loadParents,
      loadParentStudentLinks,
      loadModerators,
      loadAdminSettings,
    ]
  );

  useEffect(() => {
    if (!localChecked) return;
    if (!sessionChecked) {
      void checkAdminSession();
    }
  }, [localChecked, sessionChecked, checkAdminSession]);

  useEffect(() => {
    if (!sessionChecked || sessionIsAdmin !== true) return;
    if (loadedTabs[activeTab]) return;

    void loadTabData(activeTab).then(() => {
      setLoadedTabs((prev) => ({ ...prev, [activeTab]: true }));
    });
  }, [activeTab, loadedTabs, loadTabData, sessionChecked, sessionIsAdmin]);

  // -------------------------------------------------------------------------
  // Handlers: Teacher approvals
  // -------------------------------------------------------------------------
  const approveTeacher = useCallback(
    async (id: number, approval_notes?: string) => {
      setApprovingTeacherId(id);
      try {
        await adminService.approveTeacher(id, approval_notes);
        await loadPendingTeachers();
        await loadTeachers();
      } catch (err: unknown) {
        setPendingTeachersError(getErrorMessage(err, "Failed to approve teacher."));
      } finally {
        setApprovingTeacherId(null);
      }
    },
    [loadPendingTeachers, loadTeachers]
  );

  const rejectTeacher = useCallback(
    async (id: number, approval_notes?: string) => {
      setRejectingTeacherId(id);
      try {
        await adminService.rejectTeacher(id, approval_notes);
        await loadPendingTeachers();
      } catch (err: unknown) {
        setPendingTeachersError(getErrorMessage(err, "Failed to reject teacher."));
      } finally {
        setRejectingTeacherId(null);
      }
    },
    [loadPendingTeachers]
  );

  const updateTeacherCapacity = useCallback(
    async (id: number, max_capacity: number) => {
      setUpdatingCapacityTeacherId(id);
      try {
        await adminService.updateTeacherCapacity(id, max_capacity);
        await loadPendingTeachers();
        await loadTeachers();
      } catch (err: unknown) {
        setPendingTeachersError(getErrorMessage(err, "Failed to update teacher capacity."));
      } finally {
        setUpdatingCapacityTeacherId(null);
      }
    },
    [loadPendingTeachers, loadTeachers]
  );

  // -------------------------------------------------------------------------
  // Handlers: Assignments
  // -------------------------------------------------------------------------
  const reassignStudentTeacher = useCallback(
    async (input: { student_id: number; subject_id: number; to_teacher_id: number }) => {
      try {
        await adminService.reassignStudentTeacher(input);
        await loadTeacherAssignments();
      } catch (err: unknown) {
        setTeacherAssignmentsError(getErrorMessage(err, "Failed to reassign student."));
        throw err;
      }
    },
    [loadTeacherAssignments]
  );

  // -------------------------------------------------------------------------
  // Handlers: Schedules
  // -------------------------------------------------------------------------
  const createTeacherSchedule = useCallback(
    async (input: {
      teacher_id: number;
      weekday: number;
      start_time: string;
      end_time: string;
      is_group?: boolean;
      max_students?: number | null;
    }) => {
      try {
        await adminService.createTeacherSchedule(input);
        await loadTeacherSchedules();
      } catch (err: unknown) {
        setTeacherSchedulesError(getErrorMessage(err, "Failed to create schedule."));
        throw err;
      }
    },
    [loadTeacherSchedules]
  );

  const updateTeacherSchedule = useCallback(
    async (
      id: number,
      input: Partial<{
        weekday: number;
        start_time: string;
        end_time: string;
        is_group: boolean;
        max_students: number | null;
      }>
    ) => {
      try {
        await adminService.updateTeacherSchedule(id, input);
        await loadTeacherSchedules();
      } catch (err: unknown) {
        setTeacherSchedulesError(getErrorMessage(err, "Failed to update schedule."));
        throw err;
      }
    },
    [loadTeacherSchedules]
  );

  const deleteTeacherSchedule = useCallback(
    async (id: number) => {
      try {
        await adminService.deleteTeacherSchedule(id);
        await loadTeacherSchedules();
      } catch (err: unknown) {
        setTeacherSchedulesError(getErrorMessage(err, "Failed to delete schedule."));
        throw err;
      }
    },
    [loadTeacherSchedules]
  );

  // -------------------------------------------------------------------------
  // Handlers: Announcements
  // -------------------------------------------------------------------------
  const createAnnouncement = useCallback(
    async (input: { title: string; body: string; audience?: "all" | "students" | "parents" | "teachers" }) => {
      try {
        await adminService.createAnnouncement(input);
        await loadAnnouncements();
      } catch (err: unknown) {
        setAnnouncementsError(getErrorMessage(err, "Failed to create announcement."));
        throw err;
      }
    },
    [loadAnnouncements]
  );

  // -------------------------------------------------------------------------
  // Handlers: Admin notifications
  // -------------------------------------------------------------------------
  const markAdminNotificationRead = useCallback(async (id: number) => {
    setAdminNotificationsError(null);
    try {
      await adminService.markAdminNotificationRead(id);

      setAdminNotifications((prev) => {
        const nextItems: NotificationRow[] = prev.items.map((n) =>
          n.id === id ? { ...n, is_read: 1, read_at: n.read_at ?? new Date().toISOString() } : n
        );

        const unreadCount = nextItems.reduce((acc, n) => {
          const isRead = adminTypeUtils.normalizeIsRead(n.is_read);
          return acc + (isRead ? 0 : 1);
        }, 0);

        return { unreadCount, items: nextItems };
      });
    } catch (err: unknown) {
      setAdminNotificationsError(getErrorMessage(err, "Failed to mark notification read."));
    }
  }, []);

  const markAllAdminNotificationsRead = useCallback(async () => {
    setAdminNotificationsError(null);
    try {
      await adminService.markAllAdminNotificationsRead();

      setAdminNotifications((prev) => ({
        unreadCount: 0,
        items: prev.items.map((n) => ({
          ...n,
          is_read: 1,
          read_at: n.read_at ?? new Date().toISOString(),
        })),
      }));
    } catch (err: unknown) {
      setAdminNotificationsError(getErrorMessage(err, "Failed to mark all notifications read."));
    }
  }, []);

  // -------------------------------------------------------------------------
  // Handlers: Settings
  // -------------------------------------------------------------------------
  const updateAdminSettingsHandler = useCallback(async (input: Partial<AdminSettings>) => {
    try {
      const updatedSettings = await adminService.updateAdminSettings(input);
      setAdminSettings(updatedSettings);
    } catch (err: unknown) {
      setAdminSettingsError(getErrorMessage(err, "Failed to update settings."));
      throw err;
    }
  }, []);

  // -------------------------------------------------------------------------
  // Handlers: Subjects
  // -------------------------------------------------------------------------
  const handleCreateSubject = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubjectMessage(null);
    setCreatingSubjectError(null);

    if (!newSubNameAr.trim() || !newSubNameEn.trim()) {
      setCreatingSubjectError(t.subjectsError);
      return;
    }

    try {
      setCreatingSubject(true);
      const sort = newSubSort.trim() ? Number.parseInt(newSubSort.trim(), 10) : 0;

      await adminService.createSubject({
        name_ar: newSubNameAr.trim(),
        name_en: newSubNameEn.trim(),
        sort_order: Number.isNaN(sort) ? 0 : sort,
        is_active: newSubActive ? 1 : 0,
      });

      setNewSubNameAr("");
      setNewSubNameEn("");
      setNewSubSort("");
      setNewSubActive(true);
      await loadSubjects();
      setSubjectMessage(lang === "ar" ? "تم إنشاء المادة بنجاح" : "Subject created successfully");
    } catch (err: unknown) {
      setCreatingSubjectError(getErrorMessage(err, t.subjectsError || "Failed to create subject"));
    } finally {
      setCreatingSubject(false);
    }
  };

  const startEditSubject = (sub: SubjectAdminRow) => {
    setEditingSubjectId(sub.id);
    setEditSubNameAr(sub.name_ar);
    setEditSubNameEn(sub.name_en);
    setEditSubSort(sub.sort_order != null ? String(sub.sort_order) : "");
    setEditSubActive(sub.is_active === 1 || sub.is_active === true);
    setSubjectMessage(null);
    setUpdatingSubjectError(null);
  };

  const cancelEditSubject = () => {
    setEditingSubjectId(null);
    setSubjectMessage(null);
    setUpdatingSubjectError(null);
  };

  const handleUpdateSubject = async (id: number) => {
    setSubjectMessage(null);
    setUpdatingSubjectError(null);
    try {
      setUpdatingSubject(true);
      const sort = editSubSort.trim() ? Number.parseInt(editSubSort.trim(), 10) : undefined;

      await adminService.updateSubject(id, {
        name_ar: editSubNameAr.trim(),
        name_en: editSubNameEn.trim(),
        sort_order: Number.isNaN(sort ?? 0) ? undefined : sort,
        is_active: editSubActive ? 1 : 0,
      });

      setSubjectMessage(t.subjectsUpdateSuccess);
      setEditingSubjectId(null);
      await loadSubjects();
    } catch (err: unknown) {
      setUpdatingSubjectError(getErrorMessage(err, t.subjectsError || "Failed to update subject"));
    } finally {
      setUpdatingSubject(false);
    }
  };

  const handleDeleteSubject = async (id: number) => {
    const confirmed = window.confirm(t.subjectsDeleteConfirm);
    if (!confirmed) return;

    setSubjectMessage(null);
    setDeletingSubjectError(null);
    setDeletingSubjectId(id);
    try {
      await adminService.deleteSubject(id);
      setSubjectMessage(t.subjectsDeleteSuccess);
      await loadSubjects();
    } catch (err: unknown) {
      setDeletingSubjectError(getErrorMessage(err, t.subjectsError || "Failed to delete subject"));
    } finally {
      setDeletingSubjectId(null);
    }
  };

  // -------------------------------------------------------------------------
  // Handlers: Teachers + Assign
  // -------------------------------------------------------------------------
  const handleCreateTeacher = async (e: React.FormEvent) => {
    e.preventDefault();
    setTeacherMessage(null);
    setCreatingTeacherError(null);

    if (!newTeacherName.trim()) {
      setCreatingTeacherError(t.teacherCreateError || "Teacher name is required");
      return;
    }

    try {
      setCreatingTeacher(true);
      await adminService.createTeacher({
        name: newTeacherName.trim(),
        bio_short: newTeacherBio.trim() || null,
        gender: newTeacherGender.trim() || null,
        photo_url: newTeacherPhotoUrl.trim() || null,
        is_active: newTeacherActive ? 1 : 0,
      });

      setTeacherMessage(t.teacherCreateSuccess);
      setNewTeacherName("");
      setNewTeacherBio("");
      setNewTeacherGender("");
      setNewTeacherPhotoUrl("");
      setNewTeacherActive(true);
      await loadTeachers();
    } catch (err: unknown) {
      setCreatingTeacherError(getErrorMessage(err, t.teacherCreateError || "Failed to create teacher"));
    } finally {
      setCreatingTeacher(false);
    }
  };

  const handleAssignTeacher = async (e: React.FormEvent) => {
    e.preventDefault();
    setAssignError(null);
    setAssignSuccess(null);

    if (!assignTeacherId || !assignSubjectId) {
      setAssignError(t.teachersAssignError);
      return;
    }

    try {
      setAssigning(true);
      const priorityValue = assignPriority.trim() ? Number.parseInt(assignPriority.trim(), 10) : 0;

      await adminService.assignTeacherToSubject({
        teacherId: Number.parseInt(assignTeacherId, 10),
        subjectId: Number.parseInt(assignSubjectId, 10),
        priority: Number.isNaN(priorityValue) ? 0 : priorityValue,
      });

      setAssignSuccess(t.teachersAssignSuccess);
      setAssignTeacherId("");
      setAssignSubjectId("");
      setAssignPriority("");
      await loadTeachers();
    } catch (err: unknown) {
      setAssignError(getErrorMessage(err, t.teachersAssignError));
    } finally {
      setAssigning(false);
    }
  };

  const toggleTeacherActive = useCallback(
    async (teacherId: number, currentActive: boolean) => {
      setUpdatingTeacherId(teacherId);
      setUpdatingTeacherError(null);

      try {
        await adminService.updateTeacher(teacherId, { is_active: currentActive ? 0 : 1 });
        await loadTeachers();
      } catch (err: unknown) {
        const msg = getErrorMessage(err, t.teachersError || "Failed to update teacher status");
        setUpdatingTeacherError(msg);
        setTeacherActionError(msg);
      } finally {
        setUpdatingTeacherId(null);
      }
    },
    [loadTeachers, t.teachersError]
  );

  // -------------------------------------------------------------------------
  // Handlers: Parent requests
  // -------------------------------------------------------------------------
  const handleApproveRequest = async (id: number) => {
    setRequestsError(null);
    setApprovingId(id);
    try {
      await adminService.approveParentRequest(id);
      await loadRequests();
    } catch (err: unknown) {
      setRequestsError(getErrorMessage(err, t.requestsError));
    } finally {
      setApprovingId(null);
    }
  };

  const handleRejectRequest = async (id: number) => {
    setRequestsError(null);
    setRejectingId(id);
    try {
      await adminService.rejectParentRequest(id);
      await loadRequests();
    } catch (err: unknown) {
      setRequestsError(getErrorMessage(err, t.requestsError));
    } finally {
      setRejectingId(null);
    }
  };

  const handleApproveLessonRequest = useCallback(async (id: number) => {
    setRequestsError(null);
    setApprovingLessonId(id);
    try {
      await adminService.approveLessonRequest(id);
      await Promise.all([loadRequests(), loadLessonSessions()]);
    } catch (err: unknown) {
      setRequestsError(getErrorMessage(err, "Failed to approve lesson request."));
    } finally {
      setApprovingLessonId(null);
    }
  }, [loadLessonSessions, loadRequests]);

  const handleCancelLessonSession = useCallback(async (id: number, reason?: string) => {
    setRequestsError(null);
    setCancellingLessonId(id);
    try {
      await adminService.cancelLessonSession(id, reason);
      await Promise.all([loadRequests(), loadLessonSessions()]);
    } catch (err: unknown) {
      setRequestsError(getErrorMessage(err, "Failed to cancel lesson session."));
    } finally {
      setCancellingLessonId(null);
    }
  }, [loadLessonSessions, loadRequests]);

  // -------------------------------------------------------------------------
  // Handlers: Users activate/deactivate
  // -------------------------------------------------------------------------
  const toggleUserActive = useCallback(
    async (userId: number, currentActive: boolean) => {
      setUpdatingUserId(userId);
      setUserActionError(null);

      try {
        await adminService.toggleUserActive(userId, !currentActive);
        await Promise.all([loadStudents(), loadParents()]);
      } catch (err: unknown) {
        setUserActionError(getErrorMessage(err, "Failed to update user status."));
      } finally {
        setUpdatingUserId(null);
      }
    },
    [loadStudents, loadParents]
  );

  // -------------------------------------------------------------------------
  // Handlers: Parent–Student links
  // -------------------------------------------------------------------------
  const createParentStudentLink = useCallback(
    async (input: { parentId: number; studentId: number; relationship: "mother" | "father" | "guardian" }) => {
      setCreatingLink(true);
      setParentStudentLinksError(null);
      setCreatingLinkError(null);

      try {
        await adminService.createParentStudentLink({
          parent_id: input.parentId,
          student_id: input.studentId,
          relationship: input.relationship,
        });

        await loadParentStudentLinks();
      } catch (err: unknown) {
        const msg = getErrorMessage(err, "Failed to create parent–student link.");
        setCreatingLinkError(msg);
        setParentStudentLinksError(msg);
      } finally {
        setCreatingLink(false);
      }
    },
    [loadParentStudentLinks]
  );

  const deleteParentStudentLink = useCallback(
    async (id: number) => {
      setDeletingLinkId(id);
      setParentStudentLinksError(null);
      setDeletingLinkError(null);

      try {
        await adminService.deleteParentStudentLink(id);
        await loadParentStudentLinks();
      } catch (err: unknown) {
        const msg = getErrorMessage(err, "Failed to delete parent–student link.");
        setDeletingLinkError(msg);
        setParentStudentLinksError(msg);
      } finally {
        setDeletingLinkId(null);
      }
    },
    [loadParentStudentLinks]
  );

  // -------------------------------------------------------------------------
  // Guard outputs
  // -------------------------------------------------------------------------
  const checkedRole = useMemo(() => localChecked && sessionChecked, [localChecked, sessionChecked]);

  const isAdmin = useMemo(() => {
    if (!sessionChecked) return false;
    return sessionIsAdmin === true;
  }, [sessionChecked, sessionIsAdmin]);

  // -------------------------------------------------------------------------
  // Exposed API
  // -------------------------------------------------------------------------
  return {
    lang,
    dir,
    adminUser,
    checkedRole,
    isAdmin,

    sessionChecked,
    sessionIsAdmin,
    sessionError,

    activeTab,
    setActiveTab,

    overview,
    overviewLoading,
    overviewError,
    loadOverview,

    subjects,
    subjectsLoading,
    subjectsError,
    loadSubjects,
    newSubNameAr,
    newSubNameEn,
    newSubSort,
    newSubActive,
    creatingSubject,
    creatingSubjectError,
    editingSubjectId,
    editSubNameAr,
    editSubNameEn,
    editSubSort,
    editSubActive,
    updatingSubject,
    updatingSubjectError,
    deletingSubjectId,
    deletingSubjectError,
    subjectMessage,
    handleCreateSubject,
    startEditSubject,
    cancelEditSubject,
    handleUpdateSubject,
    handleDeleteSubject,
    setNewSubNameAr,
    setNewSubNameEn,
    setNewSubSort,
    setNewSubActive,
    setEditSubNameAr,
    setEditSubNameEn,
    setEditSubSort,
    setEditSubActive,

    teachers,
    teachersLoading,
    teachersError,
    loadTeachers,
    newTeacherName,
    newTeacherBio,
    newTeacherGender,
    newTeacherPhotoUrl,
    newTeacherActive,
    creatingTeacher,
    creatingTeacherError,
    teacherMessage,
    setNewTeacherName,
    setNewTeacherBio,
    setNewTeacherGender,
    setNewTeacherPhotoUrl,
    setNewTeacherActive,
    handleCreateTeacher,
    subjectsForAssign: subjects,
    assignTeacherId,
    assignSubjectId,
    assignPriority,
    assigning,
    assignError,
    assignSuccess,
    assignSubjectsLoading,
    assignSubjectsError,
    setAssignTeacherId,
    setAssignSubjectId,
    setAssignPriority,
    handleAssignTeacher,
    loadAssignSubjects,
    updatingTeacherId,
    updatingTeacherError,
    teacherActionError,
    toggleTeacherActive,

    pendingTeachers,
    pendingTeachersLoading,
    pendingTeachersError,
    approvingTeacherId,
    rejectingTeacherId,
    updatingCapacityTeacherId,
    approveTeacher,
    rejectTeacher,
    updateTeacherCapacity,
    loadPendingTeachers,

    teacherAssignments,
    teacherAssignmentsLoading,
    teacherAssignmentsError,
    loadTeacherAssignments,
    reassignStudentTeacher,

    teacherSchedules,
    teacherSchedulesLoading,
    teacherSchedulesError,
    loadTeacherSchedules,
    createTeacherSchedule,
    updateTeacherSchedule,
    deleteTeacherSchedule,

    announcements,
    announcementsLoading,
    announcementsError,
    loadAnnouncements,
    createAnnouncement,

    adminNotifications,
    adminNotificationsLoading,
    adminNotificationsError,
    loadAdminNotifications,
    markAdminNotificationRead,
    markAllAdminNotificationsRead,

    requests,
    requestsLoading,
    requestsError,
    approvingId,
    rejectingId,
    approvingLessonId,
    cancellingLessonId,
    handleApproveRequest,
    handleRejectRequest,
    handleApproveLessonRequest,
    handleCancelLessonSession,

    students,
    studentsLoading,
    studentsError,
    loadStudents,
    parents,
    parentsLoading,
    parentsError,
    loadParents,
    updatingUserId,
    userActionError,
    toggleUserActive,

    parentStudentLinks,
    parentStudentLinksLoading,
    parentStudentLinksError,
    creatingLink,
    creatingLinkError,
    deletingLinkId,
    deletingLinkError,
    createParentStudentLink,
    deleteParentStudentLink,
    loadParentStudentLinks,

    adminSettings,
    adminSettingsLoading,
    adminSettingsError,
    loadAdminSettings,
    updateAdminSettings: updateAdminSettingsHandler,

    lessonSessions,
    lessonSessionsLoading,
    lessonSessionsError,
    loadLessonSessions,

    moderators,
    moderatorsLoading,
    moderatorsError,
    loadModerators,
    creatingModerator,
    creatingModeratorError,
    moderatorMessage,
    handleCreateModerator,
  };
}
