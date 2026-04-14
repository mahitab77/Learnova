"use client";

import { useCallback, useEffect, useState } from "react";
import { authService, SessionMe } from "@/src/services/authService";

type SessionData = SessionMe["data"];

const LOGGED_OUT: SessionData = {
  authenticated: false,
  user: null,
  meta: {},
  activeStudentId: null,
  switchContext: null,
};

export function useSession() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<SessionData>(LOGGED_OUT);

  const refresh = useCallback(async () => {
    // meSafe NEVER throws -> stable UI
    const res = await authService.meSafe();
    setMe(res.data);
  }, []);

  const logout = useCallback(async () => {
  try {
    await authService.logout();
  } finally {
    // Always reset locally even if network fails
    setMe(LOGGED_OUT);

    // ✅ notify the whole app
    window.dispatchEvent(new Event("auth:changed"));
  }
}, []);


 useEffect(() => {
  let mounted = true;

  (async () => {
    try {
      const res = await authService.meSafe();
      if (mounted) setMe(res.data);
    } finally {
      if (mounted) setLoading(false);
    }
  })();

  const onAuthChanged = async () => {
    const res = await authService.meSafe();
    if (mounted) setMe(res.data);
  };

  window.addEventListener("auth:changed", onAuthChanged);

  return () => {
    mounted = false;
    window.removeEventListener("auth:changed", onAuthChanged);
  };
}, []);


  return {
    loading,
    me,
    authenticated: me.authenticated,
    user: me.user,
    meta: me.meta,
    activeStudentId: me.activeStudentId,
    switchContext: me.switchContext,
    refresh,
    logout,
  };
}
