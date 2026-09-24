import { describe, expect, it } from "vitest";
import { can, ORGANIZER_ROLE_ALIASES, PERMISSIONS } from "../worker/lib/auth";
import { uiCan, UI_PERMISSIONS } from "../src/lib/permissions";
import type { Role } from "../worker/types";

const ROLES = Object.keys(PERMISSIONS) as Role[];

describe("permission matrix", () => {
  /**
   * A role that may change something must also be able to read it, otherwise the
   * UI can write a value it cannot display — which is exactly how `sys_admin`
   * ended up locked out of the settings screen.
   */
  it("grants read wherever it grants write", () => {
    for (const role of ROLES) {
      for (const permission of PERMISSIONS[role]) {
        if (!permission.endsWith(":write")) continue;
        const read = permission.replace(/:write$/, ":read");
        expect(
          can(role, read),
          `${role} has ${permission} but not ${read}`,
        ).toBe(true);
      }
    }
  });

  it("gives sys_admin every permission any other role has", () => {
    for (const role of ROLES) {
      for (const permission of PERMISSIONS[role]) {
        expect(can("sys_admin", permission), `sys_admin missing ${permission}`).toBe(true);
      }
    }
  });

  it("keeps the auditor read-only", () => {
    // Widened to `string` on purpose: the literal union makes TypeScript call
    // these comparisons unintentional, but the whole point of the test is to
    // fail if one of those permissions is ever ADDED to the auditor role.
    const privileged = ["org:manage", "user:manage", "integration:manage"];
    const writes = (PERMISSIONS.auditor as readonly string[]).filter(
      (p) => p.endsWith(":write") || privileged.includes(p),
    );
    expect(writes).toEqual([]);
  });

  it("separates viewing evidence from exporting it", () => {
    // A training admin may triage alerts but must not bulk-export biometrics.
    expect(can("training_admin", "evidence:view")).toBe(true);
    expect(can("training_admin", "evidence:export")).toBe(false);
  });

  it("only sys_admin may manage integrations and users", () => {
    expect(can("sys_admin", "integration:manage")).toBe(true);
    expect(can("training_admin", "integration:manage")).toBe(false);
    expect(can("auditor", "user:manage")).toBe(false);
  });

  it("refuses unknown permissions for every role", () => {
    for (const role of ROLES) expect(can(role, "totally:madeup")).toBe(false);
  });
});

/**
 * The browser keeps its own copy of the matrix so it can hide controls the API
 * would refuse. A copy that drifts is worse than no copy: the organizer console
 * silently lost its "start analysis" button for a sys_admin who genuinely had
 * the permission, because only the server side had been updated.
 */
describe("UI permission mirror", () => {
  it("matches the server matrix exactly, role for role", () => {
    for (const role of ROLES) {
      expect([...UI_PERMISSIONS[role]].sort(), `UI copy differs for ${role}`).toEqual(
        [...PERMISSIONS[role]].sort(),
      );
    }
  });

  it("covers every role the server knows about", () => {
    expect(Object.keys(UI_PERMISSIONS).sort()).toEqual([...ROLES].sort());
  });

  it("agrees with the server on individual checks", () => {
    for (const role of ROLES) {
      for (const permission of [...PERMISSIONS.sys_admin, "totally:madeup"]) {
        expect(uiCan(role, permission), `${role} / ${permission}`).toBe(can(role, permission));
      }
    }
  });
});

/** The organizer-role vocabulary from the spec maps onto existing roles (§32). */
describe("organizer role aliases", () => {
  it("maps ADMIN / ORGANIZER / VIEWER onto real roles", () => {
    expect(ORGANIZER_ROLE_ALIASES.ADMIN).toBe("sys_admin");
    expect(ORGANIZER_ROLE_ALIASES.ORGANIZER).toBe("training_admin");
    expect(ORGANIZER_ROLE_ALIASES.VIEWER).toBe("auditor");
  });

  it("gives an organizer the right to run monitoring and a viewer read-only", () => {
    expect(can(ORGANIZER_ROLE_ALIASES.ORGANIZER, "monitoring:write")).toBe(true);
    expect(can(ORGANIZER_ROLE_ALIASES.VIEWER, "monitoring:read")).toBe(true);
    expect(can(ORGANIZER_ROLE_ALIASES.VIEWER, "monitoring:write")).toBe(false);
  });
});
