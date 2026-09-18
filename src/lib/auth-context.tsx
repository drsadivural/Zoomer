import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiClientError, type CurrentUser } from "./api";

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Session lives in an HttpOnly cookie; this only mirrors who is signed in. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((r) => !cancelled && setUser(r.user))
      .catch(() => !cancelled && setUser(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    try {
      const result = await api.login(email, password);
      setUser(result.user);
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : "ログインに失敗しました";
      setError(message);
      throw err;
    }
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, error, login, logout }),
    [user, loading, error, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/** Mirrors worker/lib/auth.ts so the UI hides what the API would refuse. */
const PERMISSIONS: Record<CurrentUser["role"], string[]> = {
  sys_admin: [
    "org:manage", "user:manage", "settings:read", "settings:write", "integration:manage",
    "trainee:write", "trainee:read", "enrollment:write", "enrollment:read",
    "session:write", "session:read", "alert:write", "alert:read",
    "evidence:view", "evidence:export", "audit:read", "report:create",
  ],
  training_admin: [
    "trainee:write", "trainee:read", "enrollment:write", "enrollment:read",
    "session:write", "session:read", "alert:write", "alert:read",
    "evidence:view", "report:create", "settings:read",
  ],
  auditor: [
    "trainee:read", "enrollment:read", "session:read", "alert:read",
    "evidence:view", "evidence:export", "audit:read", "report:create", "settings:read",
  ],
};

export function useCan(): (permission: string) => boolean {
  const { user } = useAuth();
  return useCallback(
    (permission: string) => (user ? PERMISSIONS[user.role].includes(permission) : false),
    [user],
  );
}
