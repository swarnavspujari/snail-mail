// Boot critical path: loaded flips as soon as the four core reads land;
// per-account capabilities fill in behind first paint.
import { beforeEach, expect, test, vi } from "vitest";
import type { Capabilities } from "@/lib/types";

const backend = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getKnowledgeBase: vi.fn(),
  getStreaks: vi.fn(),
  getAccounts: vi.fn(),
  getCapabilities: vi.fn(),
  onAccountsUpdated: vi.fn(() => () => {}),
}));

vi.mock("@/lib/ipc", () => ({ backend, isTauri: false }));

import { defaultKnowledgeBase, defaultSettings } from "@/lib/defaults";
import { useSettings } from "./settings";

beforeEach(() => {
  vi.clearAllMocks();
  useSettings.setState({ loaded: false, capabilities: {} });
});

test("loaded flips before capabilities resolve; capabilities fill in after", async () => {
  backend.getSettings.mockResolvedValue(defaultSettings());
  backend.getKnowledgeBase.mockResolvedValue(defaultKnowledgeBase());
  backend.getStreaks.mockResolvedValue({ daily: 0, weekly: 0, lastZeroDay: null });
  backend.getAccounts.mockResolvedValue({
    accounts: [{ email: "you@fission.local", label: null }],
    active: "you@fission.local",
  });
  let resolveCaps!: (c: Capabilities) => void;
  backend.getCapabilities.mockReturnValue(
    new Promise<Capabilities>((r) => (resolveCaps = r))
  );

  await useSettings.getState().load();
  // first paint unblocked; the capability round-trip is still in flight
  expect(useSettings.getState().loaded).toBe(true);
  expect(useSettings.getState().capabilities).toEqual({});

  resolveCaps({
    drive: true,
    contacts: true,
    calendarWrite: true,
    settingsRead: true,
    legacyGrant: false,
  });
  await vi.waitFor(() => {
    expect(
      useSettings.getState().capabilities["you@fission.local"]?.drive
    ).toBe(true);
  });
});
