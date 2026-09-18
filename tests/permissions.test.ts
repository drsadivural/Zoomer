import { describe, expect, it } from "vitest";
import { can, PERMISSIONS } from "../worker/lib/auth";
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
    const writes = PERMISSIONS.auditor.filter(
      (p) => p.endsWith(":write") || p === "org:manage" || p === "user:manage" || p === "integration:manage",
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
