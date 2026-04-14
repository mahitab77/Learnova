// src/services/authService.ts
import { apiFetch, clearCsrfToken } from "@/src/lib/api";
import type { JsonValue } from "@/src/lib/api";
import { clearParentCsrfToken } from "@/src/services/parentService";

/**
 * Auth Service (SESSION-COOKIE based) — ESLint-safe (no `any`)
 * -----------------------------------------------------------------------------
 * ✅ Type-safe `/auth/me` that supports logged-out state (401 OR 200)
 * ✅ Provides `meSafe()` that NEVER throws (ideal for navbar/UI)
 * ✅ No explicit `any` (passes @typescript-eslint/no-explicit-any)
 *
 * IMPORTANT:
 * - Your apiFetch MUST send credentials: "include" internally for session cookies.
 */

export type SessionUser = {
  id: number;
  full_name: string;
  email: string | null;
  role: string;
};

export type SessionMeta = unknown;
export type SessionSwitchContext = {
  mode: "as_student";
  parentUserId: number;
  studentUserId: number;
  switchedAt: string | null;
} | null;

/**
 * ✅ Recommended normalized shape for `/auth/me`
 * - user is null when not authenticated
 * - authenticated is always present
 */
export type SessionMe = {
  success: true;
  data: {
    authenticated: boolean;
    user: SessionUser | null;
    meta: SessionMeta;
    activeStudentId: number | null;
    switchContext: SessionSwitchContext;
  };
};

/** ✅ payload must be JSON-serializable because apiFetch.json expects JsonValue */
export type RegisterParentPayload = JsonValue;

export type RegisterStudentPayload = {
  fullName: string;
  email: string;
  password: string;
  systemId: number;
  stageId: number;
  gradeLevelId?: number | null;
  preferredLang?: "ar" | "en";
};

export type RegisterStudentSuccess = {
  success: true;
  message?: string;
  data?: {
    userId?: number;
    studentId?: number;
    fullName?: string;
    email?: string;
    role?: "student";
    preferredLang?: "ar" | "en";
    academicScope?: {
      systemId: number;
      stageId: number;
      gradeLevelId: number | null;
    };
    academicScopeSource?: "canonical" | "legacy";
  };
};

/* -------------------------------------------------------------------------- */
/* Narrow helpers (no `any`)                                                  */
/* -------------------------------------------------------------------------- */

type UnknownRecord = Record<string, unknown>;

function isRecord(v: unknown): v is UnknownRecord {
  return typeof v === "object" && v !== null;
}

function readNested(obj: unknown, key: string): unknown {
  if (!isRecord(obj)) return undefined;
  return obj[key];
}

function toNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toBooleanOrUndefined(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function parseSwitchContext(v: unknown): SessionSwitchContext {
  if (!isRecord(v)) return null;
  if (v.mode !== "as_student") return null;
  const parentUserId = readNested(v, "parentUserId");
  const studentUserId = readNested(v, "studentUserId");
  const switchedAt = readNested(v, "switchedAt");

  if (typeof parentUserId !== "number" || !Number.isFinite(parentUserId)) return null;
  if (typeof studentUserId !== "number" || !Number.isFinite(studentUserId)) return null;
  if (!(typeof switchedAt === "string" || switchedAt === null || switchedAt === undefined)) return null;

  return {
    mode: "as_student",
    parentUserId,
    studentUserId,
    switchedAt: switchedAt === undefined ? null : switchedAt,
  };
}

function parseSessionUser(v: unknown): SessionUser | null {
  if (!isRecord(v)) return null;

  const id = readNested(v, "id");
  const full_name = readNested(v, "full_name");
  const email = readNested(v, "email");
  const role = readNested(v, "role");

  if (typeof id !== "number" || !Number.isFinite(id)) return null;
  if (typeof full_name !== "string") return null;
  if (!(typeof email === "string" || email === null || email === undefined)) return null;
  if (typeof role !== "string") return null;

  return {
    id,
    full_name,
    email: email === undefined ? null : (email as string | null),
    role,
  };
}

/**
 * Normalize strict `/auth/me` success envelope.
 */
function normalizeMeResponse(raw: unknown): SessionMe {
  if (!isRecord(raw) || readNested(raw, "success") !== true) {
    throw new Error("Invalid /auth/me response envelope.");
  }
  const data = readNested(raw, "data");
  if (!isRecord(data)) {
    throw new Error("Invalid /auth/me response payload.");
  }

  const userRaw = readNested(data, "user");
  const user = parseSessionUser(userRaw);

  const meta = readNested(data, "meta") ?? {};
  const activeStudentId = toNumberOrNull(readNested(data, "activeStudentId"));
  const switchContext = parseSwitchContext(readNested(data, "switchContext"));

  const authFromServer = toBooleanOrUndefined(readNested(data, "authenticated"));
  if (authFromServer === undefined) {
    throw new Error("Invalid /auth/me authenticated flag.");
  }
  const authenticated = authFromServer;
  if (authenticated && !user) {
    throw new Error("Invalid /auth/me user payload.");
  }

  return {
    success: true,
    data: {
      authenticated,
      user: authenticated ? user : null,
      meta,
      activeStudentId: authenticated ? activeStudentId : null,
      switchContext: authenticated ? switchContext : null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

function resetAuthBoundaryCsrfCaches(): void {
  clearCsrfToken();
  clearParentCsrfToken();
}

export const authService = {
  /**
   * Strict `/me` call:
   * - Uses apiFetch (may throw if your apiFetch throws on non-2xx)
   * - Returns normalized shape if it succeeds
   */
async me(): Promise<SessionMe> {
  const raw: unknown = await apiFetch<unknown>("/auth/me", {
    method: "GET",
    cache: "no-store",
  });
  return normalizeMeResponse(raw);
},


  /**
   * ✅ Safe `/me` call:
   * - NEVER throws
   * - Returns stable shape for navbar/UI
   * - Works even if backend returns 401 when logged out
   */
 async meSafe(): Promise<SessionMe> {
  try {
    const raw: unknown = await apiFetch<unknown>("/auth/me", {
      method: "GET",
      cache: "no-store",
    });
    return normalizeMeResponse(raw);
  } catch {
    return {
      success: true,
      data: {
        authenticated: false,
        user: null,
        meta: {},
        activeStudentId: null,
        switchContext: null,
      },
    };
  }
},

  async login(email: string, password: string) {
    const result = await apiFetch("/auth/login", {
      method: "POST",
      json: { email, password },
    });
    resetAuthBoundaryCsrfCaches();
    return result;
  },

  async logout() {
    try {
      return await apiFetch("/auth/logout", { method: "POST" });
    } finally {
      resetAuthBoundaryCsrfCaches();
    }
  },

  async registerStudent(payload: RegisterStudentPayload) {
    const requestBody: JsonValue = {
      fullName: payload.fullName,
      email: payload.email,
      password: payload.password,
      systemId: payload.systemId,
      stageId: payload.stageId,
      gradeLevelId: payload.gradeLevelId ?? null,
      ...(payload.preferredLang ? { preferredLang: payload.preferredLang } : {}),
    };

    const result = await apiFetch<RegisterStudentSuccess>("/auth/register-student", {
      method: "POST",
      json: requestBody,
    });
    resetAuthBoundaryCsrfCaches();
    return result;
  },

  async registerParentWithChildren(payload: RegisterParentPayload) {
    const result = await apiFetch("/auth/register-parent-with-children", {
      method: "POST",
      json: payload,
    });
    resetAuthBoundaryCsrfCaches();
    return result;
  },

  async registerTeacher(formData: FormData) {
    // apiFetch must still send credentials: "include" for session auto-login
    const result = await apiFetch("/auth/register-teacher", {
      method: "POST",
      body: formData,
    });
    resetAuthBoundaryCsrfCaches();
    return result;
  },
};
