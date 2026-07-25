import { create } from "zustand";
import { backend } from "@/lib/ipc";
import { defaultKnowledgeBase, defaultSettings } from "@/lib/defaults";
import type {
  AccountInfo,
  AccountsState,
  AiProviderId,
  Capabilities,
  KnowledgeBase,
  ProfileInfo,
  Settings,
  Streaks,
} from "@/lib/types";

interface SettingsState {
  loaded: boolean;
  accounts: AccountsState;
  /** Per-account OAuth grant coverage (Drive/Contacts/…); Google features
   *  gate on this. Refreshed with the account list. */
  capabilities: Record<string, Capabilities>;
  settings: Settings;
  kb: KnowledgeBase;
  streaks: Streaks;

  load: () => Promise<void>;
  save: (patch: Partial<Settings>) => Promise<void>;
  saveKb: (kb: KnowledgeBase) => Promise<void>;
  setAiKey: (provider: AiProviderId, key: string) => Promise<void>;
  refreshAccounts: () => Promise<void>;
  switchAccount: (email: string) => Promise<void>;
  reorderAccounts: (emails: string[]) => Promise<void>;
}

let accountsPushSubscribed = false;

async function loadCapabilities(
  accounts: AccountsState
): Promise<Record<string, Capabilities>> {
  const entries = await Promise.all(
    accounts.accounts.map(async (a) => {
      const caps = await backend.getCapabilities(a.email).catch(() => null);
      return [a.email, caps] as const;
    })
  );
  return Object.fromEntries(entries.filter(([, c]) => c !== null)) as Record<
    string,
    Capabilities
  >;
}

export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  accounts: { accounts: [], active: "" },
  capabilities: {},
  settings: defaultSettings(),
  kb: defaultKnowledgeBase(),
  streaks: { daily: 0, weekly: 0, lastZeroDay: null },

  load: async () => {
    // The core pushes accounts:updated when the list changes underneath the
    // UI (a background removal finished, a grant died). Subscribed here, not
    // at module scope, so tests with partial backend mocks stay unaffected.
    if (!accountsPushSubscribed) {
      accountsPushSubscribed = true;
      backend.onAccountsUpdated((accounts) => {
        set({ accounts });
        void loadCapabilities(accounts).then((capabilities) => set({ capabilities }));
      });
    }
    const [settings, kb, streaks, accounts] = await Promise.all([
      backend.getSettings(),
      backend.getKnowledgeBase(),
      backend.getStreaks(),
      backend.getAccounts(),
    ]);
    set({ settings, kb, streaks, accounts, loaded: true });
    // Capabilities gate feature affordances (Drive/Contacts/…), not first
    // paint — activeCapabilities() reads all-false until they land.
    void loadCapabilities(accounts).then((capabilities) =>
      set({ capabilities })
    );
  },

  save: async (patch) => {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    await backend.saveSettings(settings);
  },

  saveKb: async (kb) => {
    set({ kb });
    await backend.saveKnowledgeBase(kb);
  },

  setAiKey: async (provider, key) => {
    await backend.setAiKey(provider, key);
    const settings = await backend.getSettings();
    set({ settings });
  },

  refreshAccounts: async () => {
    const accounts = await backend.getAccounts();
    set({ accounts, capabilities: await loadCapabilities(accounts) });
  },

  switchAccount: async (email) => {
    if (email === get().accounts.active) return;
    set({ accounts: await backend.switchAccount(email) });
  },

  reorderAccounts: async (emails) => {
    set({ accounts: await backend.reorderAccounts(emails) });
  },
}));

/** Cached account profiles (name + photo) for the header and settings. */
interface ProfilesState {
  profiles: Record<string, ProfileInfo>;
  loadFor: (email: string) => Promise<void>;
  setPhoto: (email: string, picture: string | null) => Promise<void>;
}

export const useProfiles = create<ProfilesState>((set, get) => ({
  profiles: {},
  loadFor: async (email) => {
    if (get().profiles[email]) return;
    const p = await backend.getProfile(email).catch(() => null);
    if (p) set((s) => ({ profiles: { ...s.profiles, [email]: p } }));
  },
  setPhoto: async (email, picture) => {
    await backend.setProfilePhoto(email, picture);
    const p = (await backend.getProfile(email).catch(() => null)) ?? {
      name: email,
      picture,
    };
    set((s) => ({ profiles: { ...s.profiles, [email]: p } }));
  },
}));

export function activeAccount(): AccountInfo | undefined {
  const s = useSettings.getState().accounts;
  return s.accounts.find((a) => a.email === s.active) ?? s.accounts[0];
}

/** The active account's grant coverage (all-false while unknown/loading). */
export function activeCapabilities(): Capabilities {
  const s = useSettings.getState();
  return (
    s.capabilities[s.accounts.active] ?? {
      drive: false,
      contacts: false,
      calendarWrite: false,
      settingsRead: false,
      legacyGrant: false,
    }
  );
}

export function activeSignature(): string {
  const s = useSettings.getState();
  const email = s.accounts.active;
  return (s.settings.signatures[email] ?? "").trim();
}
