/**
 * UI mirror of `worker/lib/auth.ts`, so the interface hides what the API would
 * refuse anyway.
 *
 * This list previously lived inline in `auth-context.tsx`, where it silently
 * drifted from the server's the moment a permission was added — the organizer
 * console's controls disappeared for an admin who genuinely had the right.
 * `tests/permissions.test.ts` now asserts the two are identical, so a new
 * permission that is added on only one side fails the build instead.
 *
 * The server remains the authority. Nothing here grants access; it only decides
 * whether a control is worth showing.
 */
export type UserRole = "sys_admin" | "training_admin" | "auditor";

export const UI_PERMISSIONS: Record<UserRole, string[]> = {
  sys_admin: [
    "org:manage", "user:manage", "settings:read", "settings:write", "integration:manage",
    "trainee:write", "trainee:read", "enrollment:write", "enrollment:read",
    "session:write", "session:read", "alert:write", "alert:read",
    "evidence:view", "evidence:export", "audit:read", "report:create",
    "monitoring:read", "monitoring:write",
  ],
  training_admin: [
    "trainee:write", "trainee:read", "enrollment:write", "enrollment:read",
    "session:write", "session:read", "alert:write", "alert:read",
    "evidence:view", "report:create", "settings:read",
    "monitoring:read", "monitoring:write",
  ],
  auditor: [
    "trainee:read", "enrollment:read", "session:read", "alert:read",
    "evidence:view", "evidence:export", "audit:read", "report:create", "settings:read",
    "monitoring:read",
  ],
};

export function uiCan(role: UserRole, permission: string): boolean {
  return UI_PERMISSIONS[role]?.includes(permission) ?? false;
}
