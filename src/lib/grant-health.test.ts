import { describe, expect, it } from "vitest";
import { grantHealthy, grantScopes, missingScopeNames } from "./grant-health";
import type { Capabilities } from "./types";

const full: Capabilities = {
  drive: true,
  contacts: true,
  calendarWrite: true,
  settingsRead: true,
  legacyGrant: false,
};

describe("grantScopes", () => {
  it("reports the four Google features in consent-screen order", () => {
    expect(grantScopes(full, "gmail").map((s) => s.label)).toEqual([
      "Mail — read & send",
      "Google Drive",
      "Contacts",
      "Calendar — write",
    ]);
  });

  it("says what a missing scope is needed FOR, not just that it's missing", () => {
    const rows = grantScopes({ ...full, drive: false }, "gmail");
    const drive = rows.find((s) => s.label === "Google Drive")!;
    expect(drive.ok).toBe(false);
    expect(drive.detail).toMatch(/large attachments/);
  });

  it("treats a legacy grant as missing every new scope, not just the unset ones", () => {
    const rows = grantScopes({ ...full, legacyGrant: true }, "gmail");
    expect(missingScopeNames(rows)).toEqual([
      "Google Drive",
      "Contacts",
      "Calendar",
    ]);
  });

  it("never claims mail access is missing — that one is granted at connect", () => {
    const rows = grantScopes({ ...full, legacyGrant: true }, "gmail");
    expect(rows[0].ok).toBe(true);
  });

  it("does not invent a Google grant for demo accounts", () => {
    const rows = grantScopes(undefined, "mock");
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
    expect(missingScopeNames(rows)).toEqual([]);
  });
});

describe("missingScopeNames", () => {
  it("strips the qualifier so the names read in a sentence", () => {
    const rows = grantScopes({ ...full, calendarWrite: false }, "gmail");
    // "Reconnect to restore Calendar", not "…restore Calendar — write"
    expect(missingScopeNames(rows)).toEqual(["Calendar"]);
  });

  it("lists several in scope order", () => {
    const rows = grantScopes({ ...full, contacts: false, drive: false }, "gmail");
    expect(missingScopeNames(rows)).toEqual(["Google Drive", "Contacts"]);
  });
});

describe("grantHealthy", () => {
  it("is true only when every scope is covered", () => {
    expect(grantHealthy(full, "gmail")).toBe(true);
    expect(grantHealthy({ ...full, contacts: false }, "gmail")).toBe(false);
    expect(grantHealthy({ ...full, legacyGrant: true }, "gmail")).toBe(false);
  });

  it("is true for demo accounts, which have no grant to be stale", () => {
    expect(grantHealthy(undefined, "mock")).toBe(true);
  });

  it("stays quiet while capabilities are still loading", () => {
    // first paint has no capabilities yet — don't cry wolf on every account
    expect(grantHealthy(undefined, "gmail")).toBe(true);
  });
});
