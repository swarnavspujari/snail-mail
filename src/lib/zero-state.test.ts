import { describe, expect, it } from "vitest";
import { needsConnect } from "./zero-state";
import type { AccountInfo } from "./types";

const acct = (email: string, over: Partial<AccountInfo> = {}): AccountInfo => ({
  email,
  provider: "gmail",
  connected: true,
  removing: false,
  ...over,
});

describe("needsConnect", () => {
  it("is false in the browser demo even with no accounts", () => {
    expect(needsConnect(false, [])).toBe(false);
  });

  it("is true on desktop with no accounts", () => {
    expect(needsConnect(true, [])).toBe(true);
  });

  it("is false on desktop with a connected account", () => {
    expect(needsConnect(true, [acct("a@b.com")])).toBe(false);
  });

  it("treats an account mid-removal as already gone", () => {
    expect(needsConnect(true, [acct("a@b.com", { removing: true })])).toBe(true);
  });

  it("keeps a dead-grant account in place (reconnect, not re-onboard)", () => {
    expect(needsConnect(true, [acct("a@b.com", { connected: false })])).toBe(
      false
    );
  });

  it("ignores undefined removing (the field is optional)", () => {
    const a = { email: "a@b.com", provider: "gmail", connected: true } as AccountInfo;
    expect(needsConnect(true, [a])).toBe(false);
  });

  it("is true once the last of several accounts is removing", () => {
    expect(
      needsConnect(true, [
        acct("a@b.com", { removing: true }),
        acct("c@d.com", { removing: true }),
      ])
    ).toBe(true);
  });
});
