// Full-featured in-browser backend. Serves the identical surface as the Rust
// core so the app is usable (and demoable) with zero credentials. State
// mutations persist to localStorage.
import type {
  Backend,
  BulkArchiveOpts,
  BulkArchiveResult,
  DraftStreamHandlers,
  MailView,
} from "./ipc";
import type {
  AccountsState,
  AiProviderId,
  CalendarEvent,
  CalendarInfo,
  Capabilities,
  EventAttendee,
  EventDraft,
  EventWriteResult,
  RsvpResponse,
  SendUpdates,
  ThreadInvite,
  DraftEntry,
  DraftRef,
  OutboxRef,
  DraftRequest,
  DriveFile,
  DriveShareMode,
  KnowledgeBase,
  MailAttachment,
  Message,
  OutgoingMail,
  ProfileInfo,
  PurgeReport,
  SearchResult,
  SendAsAlias,
  Settings,
  Split,
  Streaks,
  SyncActivity,
  SyncProgress,
  Thread,
  ThreadId,
  ZeroEvent,
} from "./types";
import { buildSeedData, DEMO_ACCOUNT, DEMO_ACCOUNT_2 } from "./mock-data";
import {
  BUNDLED_CELEBRATIONS,
  defaultKnowledgeBase,
  defaultSettings,
} from "./defaults";
import {
  classifySplits,
  compileSplits,
  matchesSplitQuery,
  parseSplitQuery,
  queryFromRules,
  threadFacts,
  threadInSplit,
} from "./split-query";

const LS_KEY = "fission-mock-state-v1";

// Upper bound on the contact panel's mail-history query (mirrors the Rust
// command's limit). The panel drops the open thread and shows the top 5.
const CONTACT_HISTORY_LIMIT = 20;
/** Threads a simulated "Sync now" pass downloads. Bigger than the fixture
 *  corpus on purpose: a real incremental tick fetches whatever history.list
 *  turned up, and the pill needs a pass long enough to actually watch. */
const MOCK_SYNC_THREADS = 30;

/** Fixture "Google contacts" — people NOT in the demo mail corpus, so the
 *  browser demo shows address-book-sourced autocomplete (mirrors the desktop
 *  people_contacts table synced from the People API). */
const MOCK_GOOGLE_CONTACTS: { name: string; email: string }[] = [
  { name: "Nadia Osei", email: "nadia@atlascapital.vc" },
  { name: "Peter Lindqvist", email: "peter@nordicseed.fi" },
  { name: "Grace Whitmore", email: "grace.whitmore@summitlp.com" },
  { name: "Tomás Reyes", email: "tomas@andesventures.cl" },
  { name: "Sofia Marchetti", email: "sofia.marchetti@milanofund.it" },
  { name: "Ken Nakamura", email: "ken@sakurabridge.jp" },
];

/** The demo account's calendarList — stands in for Google's (primary first,
 *  varied access roles so role-gated affordances are all demoable). */
const DEMO_CALENDARS: CalendarInfo[] = [
  { id: "demo", name: "Personal", color: null, accessRole: "owner", primary: true },
  { id: "demo-work", name: "Pujari VP — Work", color: null, accessRole: "owner", primary: false },
  { id: "demo-family", name: "Family", color: null, accessRole: "writer", primary: false },
  { id: "demo-birthdays", name: "Birthdays", color: null, accessRole: "reader", primary: false },
];

interface PersistedState {
  threadPatches: Record<
    string,
    Partial<Pick<Thread, "inInbox" | "unread" | "snoozedUntil" | "labels" | "starred">> & {
      hidden?: "trash" | "spam" | null;
    }
  >;
  trashed: string[]; // legacy hard-trash list (pre-undo); still honored
  /** `account` is absent on rows persisted before ids carried their owner. */
  outbox: { id: number; account?: string; mail: OutgoingMail; sendAt: number }[];
  outboxSeq: number;
  drafts: DraftEntry[];
  draftSeq: number;
  profiles?: Record<string, ProfileInfo>;
  settings: Settings;
  kb: KnowledgeBase;
  streaks: Streaks;
  keys: Partial<Record<AiProviderId, string>>;
  activeAccount: string;
  accountOrder: string[];
  /** Demo-calendar CRUD overlay: fixtures are synthesized on read, so writes
   *  land here (created events, per-id field patches, deleted ids). */
  calendarOverlay: {
    created: CalendarEvent[];
    patched: Record<string, Partial<CalendarEvent>>;
    deleted: string[];
    seq: number;
  };
}

function loadPersisted(): PersistedState {
  const fresh: PersistedState = {
    threadPatches: {},
    trashed: [],
    outbox: [],
    outboxSeq: 1,
    drafts: [],
    draftSeq: 1,
    settings: defaultSettings(),
    kb: defaultKnowledgeBase(),
    streaks: { daily: 0, weekly: 0, lastZeroDay: null },
    keys: {},
    activeAccount: DEMO_ACCOUNT,
    accountOrder: [DEMO_ACCOUNT, DEMO_ACCOUNT_2],
    calendarOverlay: { created: [], patched: {}, deleted: [], seq: 1 },
  };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const loaded = JSON.parse(raw) as Partial<PersistedState>;
      const merged = { ...fresh, ...loaded };
      // v0.16: calendar CRUD overlay (older saves lack it)
      merged.calendarOverlay = { ...fresh.calendarOverlay, ...merged.calendarOverlay };
      // settings gained fields across versions — merge defaults in
      merged.settings = { ...fresh.settings, ...merged.settings };
      merged.settings.shortcuts = {
        ...fresh.settings.shortcuts,
        ...merged.settings.shortcuts,
      };
      // v0.6: account switching moved mod+N → alt+N (custom remaps survive)
      for (let n = 1; n <= 9; n++) {
        if (merged.settings.shortcuts[`account.${n}`] === `mod+${n}`) {
          merged.settings.shortcuts[`account.${n}`] = `alt+${n}`;
        }
      }
      // v0.7: the builtin Calendar split became the side panel
      merged.settings.splits = merged.settings.splits.filter(
        (sp) => !(sp.builtin && sp.id === "calendar")
      );
      // v0.23: splits gained the query language — legacy rules/op saved
      // copies migrate to a query string (mirrors store::migrate_splits)
      merged.settings.splits = merged.settings.splits.map((sp) => {
        const legacy = sp as Split & {
          rules?: { field: string; contains: string }[];
          op?: string;
        };
        const query =
          legacy.query ??
          (legacy.rules?.length ? queryFromRules(legacy.rules, legacy.op ?? "or") : "");
        return {
          id: legacy.id,
          name: legacy.name,
          builtin: legacy.builtin,
          query,
          accountId: legacy.accountId ?? null,
          alsoShow: legacy.alsoShow ?? false,
          hideWhenEmpty: legacy.hideWhenEmpty ?? false,
        };
      });
      // v0.9: Delete/Backspace joined "#" as trash defaults
      if (merged.settings.shortcuts["thread.trash"] === "#") {
        merged.settings.shortcuts["thread.trash"] = "#|delete|backspace";
      }
      // v0.11: arrows scroll the reader / move the list cursor, leaving j/k
      if (merged.settings.shortcuts["list.next"] === "j|down") {
        merged.settings.shortcuts["list.next"] = "j";
      }
      if (merged.settings.shortcuts["list.prev"] === "k|up") {
        merged.settings.shortcuts["list.prev"] = "k";
      }
      // v0.14: Superhuman-parity keys (mirrors store/mod.rs get_settings)
      for (const [key, oldV, newV] of [
        ["thread.mute", "m", "shift+m"],
        ["thread.move", "v", "v|l"],
        ["goto.trash", "g t", "g t|g #"],
        ["calendar.toggle", "", "0"],
        ["calendar.open", "g c", "g c|2"],
        ["calendar.prevDay", "left", "left|-"],
        ["calendar.nextDay", "right", "right|="],
        // v0.16.x: bare "1" = Inbox (mirrors "2" = Calendar).
        ["goto.inbox", "g i", "g i|1"],
        // v0.27: "ctrl+shift+i" was unmatchable (the engine emits "mod+…").
        ["thread.introReply", "ctrl+shift+i", "mod+shift+i"],
      ] as const) {
        if (merged.settings.shortcuts[key] === oldV) {
          merged.settings.shortcuts[key] = newV;
        }
      }
      return merged;
    }
  } catch {
    // corrupt state — start fresh
  }
  return fresh;
}

// Mirrors CONCEPT_GROUPS in src-tauri/src/mail/mock.rs — the demos'
// semantic stand-in. Keep the two lists identical.
const CONCEPT_GROUPS: string[][] = [
  ["invoice", "invoices", "bill", "bills", "billing", "receipt", "receipts", "payment", "payments", "paid", "wire", "wired", "transfer", "refund"],
  ["meeting", "meet", "call", "sync", "calendar", "schedule", "reschedule", "invite", "invitation", "agenda"],
  ["deck", "decks", "slides", "presentation", "pitch"],
  ["contract", "agreement", "terms", "term", "sheet", "legal", "counsel", "redline", "signature"],
  ["hire", "hiring", "candidate", "candidates", "recruit", "recruiting", "interview", "offer", "shortlist", "role"],
  ["budget", "burn", "runway", "spend", "cost", "costs", "expenses", "finance"],
  ["flight", "flights", "travel", "hotel", "trip", "itinerary", "booking"],
  ["bug", "bugs", "issue", "error", "crash", "ci", "build", "failed", "fix"],
  ["investor", "investors", "fund", "lp", "fundraise", "series", "valuation", "portfolio"],
  ["launch", "release", "ship", "shipping", "beta", "announcement"],
];

/** Toy embedding over concept groups; null = no concept words. */
function demoVec(text: string): number[] | null {
  const v = new Array(CONCEPT_GROUPS.length).fill(0);
  let any = false;
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!w) continue;
    CONCEPT_GROUPS.forEach((group, i) => {
      if (group.includes(w)) {
        v[i] += 1;
        any = true;
      }
    });
  }
  if (!any) return null;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

const cosSim = (a: number[], b: number[]) =>
  a.reduce((s, x, i) => s + x * b[i], 0);

export class MockBackend implements Backend {
  private threads: Thread[];
  private messages: Map<string, Message[]>;
  private accountOf: Map<string, string>;
  private state: PersistedState;
  private listeners = new Set<() => void>();
  private calendarListeners = new Set<(error: string | null) => void>();
  private syncListeners = new Set<(p: SyncProgress) => void>();
  private accountsListeners = new Set<(a: AccountsState) => void>();
  /** Accounts mid-removal (transient — mirrors the desktop's background
   *  teardown so the removing → gone flow is exercisable in the demo). */
  private removingAccounts = new Set<string>();
  private cancelFlags = new Map<number, boolean>();
  private aiSeq = 1;
  /** Simulated history-download state (mirrors the desktop's background crawl
   *  so the demo shows the status strip + inbox-first reveal over fixtures). */
  private lastProgress: SyncProgress | null = null;
  private downloading = false;
  private downloadStarted = false;
  private activityListeners = new Set<(a: SyncActivity) => void>();
  /** The in-flight simulated pass (what get_sync_activity serves), or null. */
  private lastActivity: SyncActivity | null = null;
  /** Cancels the running simulated pass so a second syncNow() can't interleave
   *  two counts into one pill. */
  private activityTimer: ReturnType<typeof setInterval> | null = null;
  /** Resolver of the in-flight pass, so a superseding pass can settle it —
   *  clearing the interval alone would strand the old caller's .then chain. */
  private activityResolve: (() => void) | null = null;

  constructor() {
    const seed = buildSeedData();
    this.threads = seed.threads;
    this.messages = seed.messages;
    this.accountOf = seed.accountOf;
    this.state = loadPersisted();
    for (const t of this.threads) {
      Object.assign(t, this.state.threadPatches[t.id]);
    }
    this.threads = this.threads.filter((t) => !this.state.trashed.includes(t.id));
    // Materialize split membership (mirrors the Rust upsert/classify path).
    this.reclassifyAll();
    // Return snoozed threads whose timer already elapsed while app was closed.
    this.wakeDueSnoozes();
    this.flushOutbox(); // sends that came due while the tab was closed
    setInterval(() => {
      this.wakeDueSnoozes();
      this.flushOutbox();
    }, 5_000);
  }

  /** Re-run the classifier over every thread — the mock's equivalent of the
   *  Rust sync-time materialization + background reclassify pass. */
  private reclassifyAll() {
    const splits = this.state.settings.splits;
    const specs = new Map<string, ReturnType<typeof compileSplits>>();
    for (const t of this.threads) {
      const account = this.accountOf.get(t.id) ?? DEMO_ACCOUNT;
      let spec = specs.get(account);
      if (!spec) {
        spec = compileSplits(splits, account);
        specs.set(account, spec);
      }
      const { split, alsoIn } = classifySplits(spec, threadFacts(t));
      t.split = split;
      t.alsoIn = alsoIn;
    }
  }

  private inActiveAccount(t: Thread): boolean {
    return (
      (this.accountOf.get(t.id) ?? this.state.activeAccount) ===
      this.state.activeAccount
    );
  }

  private hiddenOf(id: string): "trash" | "spam" | null {
    return this.state.threadPatches[id]?.hidden ?? null;
  }

  private flushOutbox() {
    const now = Date.now();
    const due = this.state.outbox.filter((o) => o.sendAt <= now);
    if (due.length === 0) return;
    this.state.outbox = this.state.outbox.filter((o) => o.sendAt > now);
    for (const o of due) this.deliverNow(o.mail);
    this.persist();
    this.notify();
  }

  private persist() {
    localStorage.setItem(LS_KEY, JSON.stringify(this.state));
  }

  private patch(id: ThreadId, p: PersistedState["threadPatches"][string]) {
    const t = this.threads.find((t) => t.id === id);
    if (!t) return;
    Object.assign(t, p);
    this.state.threadPatches[id] = { ...this.state.threadPatches[id], ...p };
    this.persist();
  }

  private notify() {
    for (const cb of this.listeners) cb();
  }

  private emitProgress(p: SyncProgress) {
    this.lastProgress = p;
    for (const cb of this.syncListeners) cb(p);
  }

  private emitActivity(a: SyncActivity) {
    // Mirror the core: the parked value is the IN-FLIGHT pass, so a terminal
    // tick clears it rather than leaving get_sync_activity reporting a
    // finished download forever.
    this.lastActivity = a.total === 0 || a.done >= a.total ? null : a;
    for (const cb of this.activityListeners) cb(a);
  }

  /** Run a simulated download pass, ticking once per thread the way the real
   *  fetch loop does (every Gmail round-trip is one `threads.get`). Deliberately
   *  NOT a single synthetic climb — the pill's whole job is to count real
   *  round-trips, so the demo has to produce real per-item ticks or it proves
   *  nothing. Resolves when the pass completes. */
  private runActivityPass(
    stage: SyncActivity["stage"],
    total: number,
    everyMs = 60
  ): Promise<void> {
    if (this.activityTimer) clearInterval(this.activityTimer);
    this.activityTimer = null;
    this.activityResolve?.();
    this.activityResolve = null;
    const account = this.state.activeAccount;
    if (total <= 0) {
      this.emitActivity({ account, stage, done: 0, total: 0 });
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.activityResolve = resolve;
      let done = 0;
      this.activityTimer = setInterval(() => {
        done += 1;
        this.emitActivity({ account, stage, done, total });
        if (done >= total) {
          if (this.activityTimer) clearInterval(this.activityTimer);
          this.activityTimer = null;
          this.activityResolve = null;
          resolve();
        }
      }, everyMs);
    });
  }

  /** Mirror the desktop's background history download: the inbox is "ready"
   *  immediately while done/trash/etc. fill in a beat later, and a
   *  `sync:progress` count climbs from the inbox size toward a "full history",
   *  then hides. Non-destructive — everything settles within ~6s. Started lazily
   *  on the first thread listing so it's visible right when the inbox first
   *  paints (not spent during onboarding). */
  private startHistoryDownload() {
    const realCount = this.threads.filter((t) => this.inActiveAccount(t)).length;
    if (realCount === 0) {
      this.emitProgress({ indexed: 0, total: 0, done: true });
      return;
    }
    const inboxCount = this.threads.filter(
      (t) => this.inActiveAccount(t) && this.hiddenOf(t.id) === null && t.inInbox
    ).length;
    // The fixture corpus is tiny (a handful of threads, most in the inbox); a
    // real mailbox's history is far larger. Use a synthetic denominator so the
    // bar visibly climbs from the inbox toward a "full history", mirroring the
    // desktop crawl that climbs to Gmail's threadsTotal over minutes.
    const total = Math.max(realCount, 60);
    this.downloading = true;
    let indexed = Math.max(1, inboxCount);
    this.emitProgress({ indexed, total, done: false });
    // The activity pill rides the same first pass: the inbox is fetched thread
    // by thread before anything else, exactly as reconcile() does. Real fixture
    // count, one tick each — no synthetic denominator here (unlike the
    // completeness bar above, which needs one to have anything to climb).
    void this.runActivityPass("reconcile-inbox", inboxCount).then(() =>
      // …then the backfill behind it, which is what fills the rest of the bar.
      this.runActivityPass("reconcile-rest", Math.max(0, total - inboxCount), 80)
    );
    const step = Math.max(1, Math.ceil((total - indexed) / 14));
    const iv = setInterval(() => {
      // first beat reveals the non-inbox views (inbox was visible from the
      // start); each beat lands another slice of the backfill.
      this.downloading = false;
      indexed = Math.min(total, indexed + step);
      const done = indexed >= total;
      this.emitProgress({ indexed, total, done });
      this.notify();
      if (done) clearInterval(iv);
    }, 450);
  }

  private wakeDueSnoozes() {
    const now = Date.now();
    let woke = false;
    for (const t of this.threads) {
      if (t.snoozedUntil !== null && t.snoozedUntil <= now) {
        this.patch(t.id, { snoozedUntil: null, inInbox: true, unread: true });
        woke = true;
      }
    }
    if (woke) this.notify();
  }

  private accountsState(): AccountsState {
    return {
      accounts: this.state.accountOrder.map((email) => ({
        email,
        provider: "mock" as const,
        connected: true,
        removing: this.removingAccounts.has(email) || undefined,
      })),
      active: this.state.activeAccount,
    };
  }

  private emitAccounts() {
    const snapshot = this.accountsState();
    for (const cb of this.accountsListeners) cb(snapshot);
  }

  async getAccounts(): Promise<AccountsState> {
    return this.accountsState();
  }
  async switchAccount(email: string): Promise<AccountsState> {
    if (this.state.accountOrder.includes(email)) {
      this.state.activeAccount = email;
      this.persist();
    }
    return this.accountsState();
  }
  async reorderAccounts(emails: string[]): Promise<AccountsState> {
    if (emails.length === this.state.accountOrder.length) {
      this.state.accountOrder = emails;
      this.persist();
    }
    return this.accountsState();
  }
  /** The demo never loses a token, so a disconnected demo account is always
   *  the "refused" case rather than the "missing" one. */
  async hasStoredGrant(email: string): Promise<boolean> {
    return this.accountsState().accounts.some((a) => a.email === email);
  }

  async hasGmailClient(): Promise<boolean> {
    return false;
  }
  /** Demo accounts hold every capability so the whole Drive/contacts flow is
   *  demoable in the browser (the desktop's mock accounts report none). */
  async getCapabilities(): Promise<Capabilities> {
    return {
      drive: true,
      contacts: true,
      calendarWrite: true,
      settingsRead: true,
      legacyGrant: false,
    };
  }
  async startOauth(): Promise<AccountsState> {
    throw new Error(
      "OAuth needs the desktop app (Rust core). The browser build runs in demo mode."
    );
  }
  /** Mirrors the desktop flow: mark removing + return instantly; a short
   *  background beat then drops the account, its threads, and emits
   *  accounts:updated. Idempotent — a second call is a no-op. */
  async disconnect(email: string): Promise<AccountsState> {
    if (
      !this.state.accountOrder.includes(email) ||
      this.removingAccounts.has(email) ||
      this.state.accountOrder.length <= 1
    ) {
      return this.accountsState();
    }
    this.removingAccounts.add(email);
    if (this.state.activeAccount === email) {
      const next = this.state.accountOrder.find(
        (e) => e !== email && !this.removingAccounts.has(e)
      );
      if (next) this.state.activeAccount = next;
    }
    const snapshot = this.accountsState();
    setTimeout(() => {
      this.removingAccounts.delete(email);
      this.state.accountOrder = this.state.accountOrder.filter((e) => e !== email);
      this.threads = this.threads.filter(
        (t) => (this.accountOf.get(t.id) ?? DEMO_ACCOUNT) !== email
      );
      this.persist();
      this.emitAccounts();
      this.notify();
    }, 400);
    this.emitAccounts();
    return snapshot;
  }
  /** The browser demo has no OS keychain and no SQLite files, so the honest
   *  analogue is "drop everything localStorage is holding". The report names
   *  the browser's own storage rather than inventing plausible-looking
   *  Credential Manager entries — a fake receipt for a security action is
   *  worse than no receipt. */
  async eraseAllLocalData(): Promise<PurgeReport> {
    // Reset in-memory state FIRST: `persist()` is called from a dozen places
    // and the next one would write the old mailbox straight back into the key
    // we just deleted, turning the receipt into a lie.
    this.threads = [];
    this.state.accountOrder = [];
    this.state.threadPatches = {};
    this.state.outbox = [];
    this.state.drafts = [];
    this.removingAccounts.clear();

    const paths: string[] = [];
    // LS_KEY by name, plus anything left under a brand prefix by an older
    // build — the browser analogue of the legacy-identifier sweep.
    for (const key of Object.keys(localStorage)) {
      if (key === LS_KEY || /^(snail|fission|zenbox)/.test(key)) {
        localStorage.removeItem(key);
        paths.push(`localStorage["${key}"]`);
      }
    }
    this.emitAccounts();
    this.notify();
    return { credentials: [], paths, revoked: 0, errors: [], dryRun: false };
  }
  /** Honest about what it does: wakes snoozes AND runs a real per-item
   *  download pass, so "Sync now" in the demo exercises the same event stream
   *  the desktop emits from `sync_now` → full_sync → incremental. Awaits the
   *  pass, like the desktop command awaits its sync. */
  async syncNow() {
    this.wakeDueSnoozes();
    await this.runActivityPass("incremental", MOCK_SYNC_THREADS);
    this.notify();
  }
  /** Repair Mail: a forced reconcile that re-parses every listed thread — the
   *  heaviest download in the app, and the one that used to run with no
   *  feedback at all. The demo fixtures carry real HTML, so nothing is actually
   *  repaired; the pass is simulated for parity. */
  async resyncAccount() {
    this.wakeDueSnoozes();
    const total = this.threads.filter((t) => this.inActiveAccount(t)).length;
    await this.runActivityPass("resync", total);
    this.notify();
  }

  async listThreads(view: MailView): Promise<Thread[]> {
    // Kick the simulated history download the first time the UI asks for mail,
    // so the status strip + inbox-first reveal are visible at the inbox.
    if (!this.downloadStarted) {
      this.downloadStarted = true;
      this.startHistoryDownload();
    }
    // Inbox-first: until the download's first beat lands, only the inbox (and
    // its snoozed offshoot) is "ready"; done/trash/labels fill in a moment later.
    if (this.downloading && view !== "inbox" && view !== "reminders") return [];
    const byDate = (a: Thread, b: Thread) => b.lastDate - a.lastDate;
    if (view === "trash")
      return this.threads
        .filter((t) => this.inActiveAccount(t) && this.hiddenOf(t.id) === "trash")
        .sort(byDate);
    const mine = this.threads.filter(
      (t) => this.inActiveAccount(t) && this.hiddenOf(t.id) === null
    );
    if (view.startsWith("label:")) {
      const label = view.slice(6);
      return mine.filter((t) => t.labels.includes(label)).sort(byDate);
    }
    if (view === "inbox")
      return mine.filter((t) => t.inInbox && t.snoozedUntil === null).sort(byDate);
    if (view === "reminders")
      return mine.filter((t) => t.snoozedUntil !== null).sort(byDate);
    if (view === "starred") return mine.filter((t) => t.starred).sort(byDate);
    return mine.filter((t) => !t.inInbox && t.snoozedUntil === null).sort(byDate);
  }

  async getThread(id: ThreadId): Promise<Message[]> {
    const msgs = this.messages.get(id);
    if (!msgs) throw new Error(`unknown thread ${id}`);
    // Opening a thread marks it read (matches Gmail + the Rust core).
    for (const m of msgs) m.unread = false;
    this.patch(id, { unread: false });
    return msgs;
  }
  async refetchMessageBody(id: ThreadId): Promise<Message[]> {
    // demo fixtures always carry a body — nothing to heal
    return this.messages.get(id) ?? [];
  }

  async archiveThread(id: ThreadId) {
    this.patch(id, { inInbox: false, snoozedUntil: null });
  }
  async moveToInbox(id: ThreadId) {
    this.patch(id, { inInbox: true, snoozedUntil: null });
  }
  async hideThread(id: ThreadId, reason: "trash" | "spam") {
    this.patch(id, { hidden: reason, inInbox: false, snoozedUntil: null });
  }
  async restoreThread(id: ThreadId) {
    this.patch(id, { hidden: null, inInbox: true, snoozedUntil: null });
  }
  async muteThread(id: ThreadId) {
    const t = this.threads.find((t) => t.id === id);
    if (!t) return;
    const labels = t.labels.includes("Muted") ? t.labels : [...t.labels, "Muted"];
    this.patch(id, { labels, inInbox: false });
  }
  async unmuteThread(id: ThreadId) {
    const t = this.threads.find((t) => t.id === id);
    if (!t) return;
    this.patch(id, { labels: t.labels.filter((l) => l !== "Muted"), inInbox: true });
  }
  async unsubscribeThread(id: ThreadId) {
    const msgs = this.messages.get(id) ?? [];
    const newsletter = msgs.some(
      (m) => m.from.includes("substack") || m.from.includes("strictlyvc")
    );
    return newsletter
      ? { kind: "opened" as const, target: `https://unsubscribe.example.com/${id}` }
      : { kind: "none" as const, target: null };
  }
  async toggleStar(id: ThreadId): Promise<boolean> {
    const t = this.threads.find((t) => t.id === id);
    if (!t) return false;
    this.patch(id, { starred: !t.starred });
    return t.starred; // patched in place above
  }
  async snoozeThread(id: ThreadId, untilMs: number) {
    this.patch(id, { inInbox: false, snoozedUntil: untilMs });
  }
  async markUnread(id: ThreadId) {
    this.patch(id, { unread: true });
    const msgs = this.messages.get(id);
    if (msgs?.length) msgs[msgs.length - 1].unread = true;
  }
  async markRead(id: ThreadId) {
    this.patch(id, { unread: false });
    const msgs = this.messages.get(id);
    for (const m of msgs ?? []) m.unread = false;
  }
  async moveLabel(id: ThreadId, label: string) {
    const t = this.threads.find((t) => t.id === id);
    if (!t) return;
    const labels = t.labels.includes(label)
      ? t.labels.filter((l) => l !== label)
      : [...t.labels, label];
    this.patch(id, { labels });
  }
  async listLabels() {
    const set = new Set<string>(["IMPORTANT", "CALENDAR", "Deals", "LPs", "Personal"]);
    for (const t of this.threads) for (const l of t.labels) set.add(l);
    return [...set];
  }

  async queueMail(mail: OutgoingMail, delayMs: number): Promise<OutboxRef> {
    const id = this.state.outboxSeq++;
    const account = this.state.activeAccount;
    this.state.outbox.push({ id, account, mail, sendAt: Date.now() + delayMs });
    this.persist();
    setTimeout(() => this.flushOutbox(), delayMs + 100);
    return { id, account };
  }

  /** Rows are addressed by (id, account) exactly as the Rust backend does —
   *  ids are per-account there, so matching on id alone would let one mailbox
   *  cancel another's identically-numbered send. */
  private outboxRow(outboxId: number, account: string) {
    return this.state.outbox.find(
      (o) => o.id === outboxId && (o.account ?? this.state.activeAccount) === account
    );
  }

  async cancelOutbox(outboxId: number, account: string): Promise<OutgoingMail> {
    const entry = this.outboxRow(outboxId, account);
    if (!entry) throw new Error("already sent");
    this.state.outbox = this.state.outbox.filter((o) => o !== entry);
    this.persist();
    return entry.mail;
  }

  async sendMailNow(mail: OutgoingMail): Promise<void> {
    // Undo Send off: deliver immediately, never touching the outbox.
    this.deliverNow(mail);
    this.persist();
    this.notify();
  }

  async sendOutboxNow(outboxId: number, account: string): Promise<void> {
    // Accelerate: flush a still-pending send now instead of waiting the window.
    const entry = this.outboxRow(outboxId, account);
    if (!entry) throw new Error("already sent");
    this.state.outbox = this.state.outbox.filter((o) => o !== entry);
    this.deliverNow(entry.mail);
    this.persist();
    this.notify();
  }

  private deliverNow(mail: OutgoingMail) {
    const nowMs = Date.now();
    if (mail.threadId) {
      const msgs = this.messages.get(mail.threadId);
      const t = this.threads.find((t) => t.id === mail.threadId);
      if (msgs && t) {
        msgs.push({
          id: `${mail.threadId}-m${msgs.length + 1}`,
          threadId: mail.threadId,
          from: "you@fission.local",
          fromName: "You",
          to: mail.to,
          cc: mail.cc,
          subject: mail.subject,
          snippet: mail.bodyText.slice(0, 120),
          bodyText: mail.bodyText,
          bodyHtml: mail.bodyHtml,
          date: nowMs,
          unread: false,
          attachments: [],
        });
        t.messageCount = msgs.length;
        t.lastDate = nowMs;
        t.snippet = mail.bodyText.slice(0, 120);
      }
    } else {
      const id = `t-sent-${nowMs}`;
      const msg: Message = {
        id: `${id}-m1`,
        threadId: id,
        from: "you@fission.local",
        fromName: "You",
        to: mail.to,
        cc: mail.cc,
        subject: mail.subject,
        snippet: mail.bodyText.slice(0, 120),
        bodyText: mail.bodyText,
        bodyHtml: mail.bodyHtml,
        date: nowMs,
        unread: false,
        attachments: [],
      };
      this.messages.set(id, [msg]);
      this.accountOf.set(id, this.state.activeAccount);
      this.threads.push({
        id,
        subject: mail.subject,
        snippet: msg.snippet,
        participants: ["You"],
        recipients: [...new Set([...mail.to, ...mail.cc])],
        messageCount: 1,
        lastDate: nowMs,
        unread: false,
        starred: false,
        labels: [],
        inInbox: false, // sent mail doesn't land in your own inbox
        snoozedUntil: null,
        split: "",
        alsoIn: [],
      });
    }
    this.reclassifyAll();
    this.notify();
  }

  /** Mirrors the Rust core's deterministic query planner: from:/to: →
   *  people, after:/before: → a date window, quoted phrases stay whole,
   *  other operators (has:, in:, …) drop — the demo has no server to honor
   *  them. */
  private parseQuery(query: string) {
    const tokens: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (const c of query) {
      if (c === '"') {
        inQuotes = !inQuotes;
        cur += c;
      } else if (/\s/.test(c) && !inQuotes) {
        if (cur) {
          tokens.push(cur);
          cur = "";
        }
      } else {
        cur += c;
      }
    }
    if (cur) tokens.push(cur);

    const unquote = (s: string) => s.replace(/^"|"$/g, "").trim();
    const dateMs = (v: string) => {
      const m = unquote(v).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
      return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
    };
    const people: string[] = [];
    const terms: string[] = [];
    let after: number | null = null;
    let before: number | null = null;
    for (const tok of tokens) {
      const lower = tok.toLowerCase();
      if (lower.startsWith("from:") || lower.startsWith("to:")) {
        const p = unquote(lower.slice(lower.indexOf(":") + 1));
        if (p) people.push(p);
      } else if (lower.startsWith("after:")) {
        after = dateMs(lower.slice(6));
      } else if (lower.startsWith("before:")) {
        before = dateMs(lower.slice(7));
      } else if (/^[a-z]+:/.test(lower)) {
        // Gmail-only operator — nothing local to honor in the demo
      } else {
        const t = unquote(lower);
        if (t) terms.push(t);
      }
    }
    return { people, terms, after, before };
  }

  async search(query: string): Promise<SearchResult[]> {
    const { people, terms, after, before } = this.parseQuery(query);
    if (!people.length && !terms.length && after == null && before == null)
      return [];
    const hits: { r: SearchResult; score: number }[] = [];
    for (const t of this.threads.filter((t) => this.inActiveAccount(t))) {
      if (after != null && t.lastDate < after) continue;
      if (before != null && t.lastDate >= before) continue;
      const msgs = this.messages.get(t.id) ?? [];
      // People narrow every route; person-only queries rank sender matches
      // (they wrote) above recipient matches (user wrote to them).
      let pscore = 0;
      for (const p of people) {
        for (const m of msgs) {
          if (`${m.fromName} ${m.from}`.toLowerCase().includes(p)) {
            pscore = Math.max(pscore, 2);
          } else if (
            [...m.to, ...m.cc].join("\n").toLowerCase().includes(p)
          ) {
            pscore = Math.max(pscore, 1);
          }
        }
      }
      if (people.length && !pscore) continue;

      const result: SearchResult = {
        threadId: t.id,
        subject: t.subject,
        snippet: t.snippet,
        lastDate: t.lastDate,
      };
      if (terms.length) {
        const subject = t.subject.toLowerCase();
        const from = msgs
          .map((m) => `${m.fromName} ${m.from}`)
          .join("\n")
          .toLowerCase();
        const body = msgs.map((m) => m.bodyText).join("\n").toLowerCase();
        // Mirrors the Rust core's weighted bm25 ordering: subject 10× and
        // from 5× outrank body 1×; every term must match somewhere (FTS AND).
        let score = 0;
        let all = true;
        for (const term of terms) {
          const s =
            (subject.includes(term) ? 10 : 0) +
            (from.includes(term) ? 5 : 0) +
            (body.includes(term) ? 1 : 0);
          if (!s) {
            all = false;
            break;
          }
          score += s;
        }
        if (!all) continue;
        hits.push({ r: result, score });
      } else {
        // person / date-window routes rank by from-vs-to match, then recency
        hits.push({ r: result, score: pscore });
      }
    }
    return hits
      .sort((a, b) => b.score - a.score || b.r.lastDate - a.r.lastDate)
      .map((h) => h.r);
  }
  // Demo has no server past the fixtures, so the "all mail" pass adds the
  // semantic leg instead: toy concept vectors + the same RRF fusion as the
  // Rust core. The instant search() stays lexical-only, like search_threads.
  async searchAll(query: string): Promise<SearchResult[]> {
    const lexical = await this.search(query);
    const { terms } = this.parseQuery(query);
    const q = terms.length ? demoVec(terms.join(" ")) : null;
    if (!q) return lexical;
    const vhits: { r: SearchResult; d: number }[] = [];
    for (const t of this.threads.filter((t) => this.inActiveAccount(t))) {
      const msgs = this.messages.get(t.id) ?? [];
      const v = demoVec(
        `${t.subject}\n${msgs.map((m) => m.bodyText).join("\n")}`
      );
      if (!v) continue;
      const sim = cosSim(q, v);
      if (sim <= 0) continue;
      vhits.push({
        r: {
          threadId: t.id,
          subject: t.subject,
          snippet: t.snippet,
          lastDate: t.lastDate,
        },
        d: 1 - sim,
      });
    }
    vhits.sort((a, b) => a.d - b.d);
    vhits.length = Math.min(vhits.length, 20); // VEC_LEG_LIMIT, as in the core
    // Reciprocal Rank Fusion, k=60 — keep in step with store::rrf_fuse: each
    // leg contributes 1/(60+rank), so dual-leg (exact) hits stay on top and
    // semantic-only neighbors extend recall below them.
    const K = 60;
    const fused = new Map<string, { s: number; r: SearchResult }>();
    lexical.forEach((r, i) => fused.set(r.threadId, { s: 1 / (K + 1 + i), r }));
    vhits.forEach(({ r }, i) => {
      const s = 1 / (K + 1 + i);
      const e = fused.get(r.threadId);
      if (e) e.s += s;
      else fused.set(r.threadId, { s, r });
    });
    return [...fused.values()]
      .sort((a, b) => b.s - a.s || b.r.lastDate - a.r.lastDate)
      .map((e) => e.r)
      .slice(0, 60);
  }
  async loadOlder(): Promise<number> {
    return 0;
  }

  /** Recent threads where `email` was a sender or recipient (from/to/cc) —
   *  the contact panel's mail history. Address-scoped, never a full-text body
   *  match, so it lists only conversations the person was actually on. Newest
   *  first, capped; the caller drops the open thread. */
  async threadsWithContact(email: string): Promise<SearchResult[]> {
    const needle = email.trim().toLowerCase();
    if (!needle.includes("@")) return [];
    const hits: SearchResult[] = [];
    for (const t of this.threads.filter((t) => this.inActiveAccount(t))) {
      if (this.hiddenOf(t.id) !== null) continue;
      const onThread = (this.messages.get(t.id) ?? []).some((m) =>
        [m.from, ...m.to, ...m.cc].some((addr) =>
          addr.toLowerCase().includes(needle)
        )
      );
      if (!onThread) continue;
      hits.push({
        threadId: t.id,
        subject: t.subject,
        snippet: t.snippet,
        lastDate: t.lastDate,
      });
    }
    return hits
      .sort((a, b) => b.lastDate - a.lastDate)
      .slice(0, CONTACT_HISTORY_LIMIT);
  }

  /** Mirrors store::sweep_once + the drain loop in bulk_archive: the whole
   *  split, not a display window, and the same visibility rules splitCounts
   *  uses — otherwise the demo reproduces the very bug this replaced, where
   *  the tab count and the sweep disagreed. */
  async bulkArchive(opts: BulkArchiveOpts): Promise<BulkArchiveResult> {
    const cutoff = Date.now() - opts.olderThanDays * 24 * 3600_000;
    const splits = this.state.settings.splits;
    const account = this.state.activeAccount;
    const ids: ThreadId[] = [];
    for (const t of this.threads) {
      if (!this.inActiveAccount(t) || this.hiddenOf(t.id) !== null) continue;
      if (!t.inInbox || t.snoozedUntil !== null) continue;
      if (opts.olderThanDays > 0 && t.lastDate > cutoff) continue;
      if (opts.preserveUnread && t.unread) continue;
      if (opts.preserveStarred && t.starred) continue;
      if (opts.splitId && !threadInSplit(t, opts.splitId, splits, account)) continue;
      this.patch(t.id, { inInbox: false });
      ids.push(t.id);
    }
    if (ids.length) this.notify();
    return { archived: ids.length, ids };
  }

  async bulkMoveToInbox(ids: ThreadId[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      // Only restore threads this mailbox actually holds, matching
      // store::unsweep_once — a stale id must not resurrect anything.
      const t = this.threads.find((x) => x.id === id);
      if (!t || !this.inActiveAccount(t)) continue;
      this.patch(id, { inInbox: true, snoozedUntil: null });
      n++;
    }
    if (n) this.notify();
    return n;
  }

  async splitCounts(): Promise<Record<string, number>> {
    const splits = this.state.settings.splits;
    const account = this.state.activeAccount;
    const counts: Record<string, number> = {};
    for (const t of this.threads) {
      if (!this.inActiveAccount(t) || this.hiddenOf(t.id) !== null) continue;
      if (!t.inInbox || t.snoozedUntil !== null) continue;
      for (const sp of splits) {
        if (sp.accountId != null && sp.accountId !== account) continue;
        if (threadInSplit(t, sp.id, splits, account)) {
          counts[sp.id] = (counts[sp.id] ?? 0) + 1;
        }
      }
    }
    return counts;
  }

  async previewSplit(query: string): Promise<{ ok: boolean; error: string | null; count: number }> {
    let node;
    try {
      node = parseSplitQuery(query);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), count: 0 };
    }
    if (!node) {
      return {
        ok: true,
        error: "empty query — this split would catch everything unmatched",
        count: 0,
      };
    }
    let count = 0;
    for (const t of this.threads) {
      if (!this.inActiveAccount(t) || this.hiddenOf(t.id) !== null) continue;
      if (!t.inInbox || t.snoozedUntil !== null) continue;
      if (matchesSplitQuery(node, threadFacts(t))) count++;
    }
    return { ok: true, error: null, count };
  }

  /** Fixture Drive corpus — enough variety to demo recents, search, link
   *  chips, and attach-as-copy in the browser with zero credentials. */
  private driveFixtures(): DriveFile[] {
    const d = (daysAgo: number) =>
      new Date(Date.now() - daysAgo * 24 * 3600_000).toISOString();
    const f = (
      id: string,
      name: string,
      mimeType: string,
      size: number | null,
      daysAgo: number
    ): DriveFile => ({
      id,
      name,
      mimeType,
      size,
      webViewLink: `https://drive.google.com/file/d/${id}/view`,
      iconLink: null,
      modifiedTime: d(daysAgo),
      owner: "You",
    });
    return [
      f("dmock-lp-deck", "Fund II — LP Update Deck.pdf", "application/pdf", 4_812_331, 0),
      f("dmock-model", "Helios Series A model.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 913_204, 1),
      f("dmock-memo", "Fieldstone investment memo", "application/vnd.google-apps.document", null, 1),
      f("dmock-board", "Board minutes 2026-06", "application/vnd.google-apps.document", null, 3),
      f("dmock-term", "Term sheet — Northwind (signed).pdf", "application/pdf", 1_204_887, 5),
      f("dmock-demo-video", "Product demo cut v3.mp4", "video/mp4", 812_044_211, 6),
      f("dmock-pitch", "Pitch portfolio review.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", 28_442_133, 9),
      f("dmock-headshot", "Speaker headshot.png", "image/png", 2_133_910, 12),
      f("dmock-dataroom", "Data room export.zip", "application/zip", 402_133_004, 20),
      f("dmock-onepager", "Snail Mail one-pager.pdf", "application/pdf", 688_112, 30),
    ];
  }

  async driveSearch(query: string): Promise<DriveFile[]> {
    const q = query.trim().toLowerCase();
    const all = this.driveFixtures();
    if (!q) return all; // "recents" — fixtures are already newest-first
    return all.filter((f) => f.name.toLowerCase().includes(q));
  }

  async driveDownloadAttach(fileId: string): Promise<MailAttachment> {
    const file = this.driveFixtures().find((f) => f.id === fileId);
    if (!file) throw new Error("unknown Drive file");
    if (file.size === null)
      throw new Error(
        "Google Docs/Sheets/Slides can't be attached as a copy — insert the link instead"
      );
    if (file.size > 25_000_000)
      throw new Error(
        "that file is over the 25 MB attachment limit — insert the link instead"
      );
    const content = `Demo Drive file: ${file.name}\n(real bytes come from Google Drive in the desktop app.)`;
    // btoa alone throws on non-Latin1 (fixture names carry em dashes)
    const utf8 = new TextEncoder().encode(content);
    let bin = "";
    for (const b of utf8) bin += String.fromCharCode(b);
    return {
      filename: file.name,
      mimeType: "text/plain",
      dataBase64: btoa(bin),
    };
  }

  driveUploadFile(
    file: File,
    onProgress: (sent: number, total: number) => void
  ): Promise<DriveFile> {
    // Fake resumable upload: ~10 ticks over ~1.5 s, then a synthetic file.
    return new Promise((resolve) => {
      const total = file.size || 1;
      let sent = 0;
      const step = Math.ceil(total / 10);
      const tick = () => {
        sent = Math.min(sent + step, total);
        onProgress(sent, total);
        if (sent >= total) {
          const id = `dmock-up-${Date.now()}`;
          resolve({
            id,
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            webViewLink: `https://drive.google.com/file/d/${id}/view`,
            iconLink: null,
            modifiedTime: new Date().toISOString(),
            owner: "You",
          });
          return;
        }
        setTimeout(tick, 150);
      };
      setTimeout(tick, 150);
    });
  }

  async driveShare(
    _fileId: string,
    _mode: Exclude<DriveShareMode, "none">,
    _emails: string[]
  ): Promise<string[]> {
    return []; // demo mode: nothing to share, nothing fails
  }

  /** Demo attachments have no real bytes — serve a stand-in text file. */
  private attachmentBlob(attachmentId: string): { name: string; blob: Blob } | null {
    for (const msgs of this.messages.values()) {
      for (const m of msgs) {
        const a = m.attachments.find((a) => a.id === attachmentId);
        if (a) {
          const content = `Demo attachment: ${a.filename}\n(${a.mimeType}, ${a.sizeBytes} bytes in the fixture inbox — real bytes come from Gmail in the desktop app.)`;
          return { name: a.filename, blob: new Blob([content], { type: "text/plain" }) };
        }
      }
    }
    return null;
  }

  async downloadAttachment(attachmentId: string): Promise<string | null> {
    const att = this.attachmentBlob(attachmentId);
    if (!att) throw new Error("unknown attachment");
    const url = URL.createObjectURL(att.blob);
    const aEl = document.createElement("a");
    aEl.href = url;
    aEl.download = att.name;
    aEl.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return att.name;
  }

  async openAttachment(attachmentId: string): Promise<void> {
    const att = this.attachmentBlob(attachmentId);
    if (!att) throw new Error("unknown attachment");
    const url = URL.createObjectURL(att.blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  /** Drafts persisted before ids carried their owner default to the active
   *  account — the mailbox that necessarily wrote them back when this was a
   *  single-account store. */
  private draftAccountOf(d: DraftEntry): string {
    return d.account ?? this.state.activeAccount;
  }

  async saveDraft(
    draftId: number | null,
    draftAccount: string | null,
    payload: string
  ): Promise<DraftRef> {
    const now = Date.now();
    if (draftId !== null && draftAccount !== null) {
      const d = this.state.drafts.find(
        (d) => d.id === draftId && this.draftAccountOf(d) === draftAccount
      );
      if (d) {
        d.payload = payload;
        d.updatedAt = now;
        d.account = draftAccount;
        this.persist();
        return { id: draftId, account: draftAccount };
      }
      // row vanished — fall through and recreate under the active account
    }
    const id = this.state.draftSeq++;
    const account = this.state.activeAccount;
    this.state.drafts.push({ id, account, payload, updatedAt: now });
    this.persist();
    return { id, account };
  }

  async listDrafts(): Promise<DraftEntry[]> {
    return this.state.drafts
      .filter((d) => this.draftAccountOf(d) === this.state.activeAccount)
      .map((d) => ({ ...d, account: this.draftAccountOf(d) }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteDraft(draftId: number, account: string): Promise<void> {
    this.state.drafts = this.state.drafts.filter(
      (d) => !(d.id === draftId && this.draftAccountOf(d) === account)
    );
    this.persist();
  }

  async getProfile(email: string): Promise<ProfileInfo | null> {
    return this.state.profiles?.[email] ?? null;
  }

  async setProfilePhoto(email: string, picture: string | null): Promise<void> {
    if (!this.state.profiles) this.state.profiles = {};
    const prof = this.state.profiles[email] ?? { name: email.split("@")[0], picture: null };
    this.state.profiles[email] = { ...prof, picture };
    this.persist();
  }

  /** Superset of src-tauri/src/mail/mock.rs demo_events: the first five
   *  blocks mirror the desktop demo (same ids — keep in sync; the board
   *  meeting arrives as an invite so RSVP is demoable). The browser demo
   *  extends them across several calendars — plus an overlap, a family
   *  dinner, and weekday all-day events — so the per-calendar colors,
   *  side-by-side packing, the all-day lane, and the show/hide checkboxes
   *  are all exercisable, like a real Google calendarList. */
  private baseEvents(startMs: number, endMs: number): CalendarEvent[] {
    const H = 3600_000;
    const D = 24 * H;
    const me = this.state.activeAccount;
    const blocks: Array<{
      from: number;
      to: number;
      title: string;
      location: string | null;
      calId: string;
      /** Weekday gate (Date.getDay()); undefined = every day. */
      dow?: number;
      allDay?: boolean;
    }> = [
      { from: 7, to: 8, title: "Workout", location: null, calId: "demo" },
      { from: 8.5, to: 9.75, title: "Deep work — LP letter", location: null, calId: "demo" },
      { from: 10, to: 11.5, title: "Helios Board Meeting", location: "Zoom", calId: "demo-work" },
      { from: 12.5, to: 13.25, title: "Lunch", location: null, calId: "demo" },
      { from: 14, to: 14.75, title: "Fieldstone intro call", location: "Meet", calId: "demo-work" },
      // browser-demo extensions (desktop demo stops above)
      { from: 10.75, to: 11.75, title: "Portfolio pipeline sync", location: null, calId: "demo-work" },
      { from: 18, to: 19.5, title: "Family dinner", location: null, calId: "demo-family" },
      { from: 0, to: 24, title: "Denver offsite", location: "Denver", calId: "demo-work", dow: 3, allDay: true },
      { from: 0, to: 24, title: "Maya's birthday", location: null, calId: "demo-birthdays", dow: 5, allDay: true },
    ];
    const events: CalendarEvent[] = [];
    let dayStart = new Date(startMs).setHours(0, 0, 0, 0);
    while (dayStart < endMs) {
      const dow = new Date(dayStart).getDay();
      blocks.forEach(({ from, to, title, location, calId, dow: onDow, allDay }, i) => {
        if (onDow !== undefined && onDow !== dow) return;
        const s = allDay ? dayStart : dayStart + from * H;
        const e = allDay ? dayStart + D : dayStart + to * H;
        if (e <= startMs || s >= endMs) return;
        const invited = i === 2; // Helios Board Meeting
        const attendees: EventAttendee[] = invited
          ? [
              {
                email: "maya@heliosrobotics.io",
                displayName: "Maya Okafor",
                optional: false,
                responseStatus: "accepted",
                self: false,
                organizer: true,
              },
              {
                email: me,
                displayName: null,
                optional: false,
                responseStatus: "needsAction",
                self: true,
                organizer: false,
              },
            ]
          : i === 4
            ? [
                {
                  email: me,
                  displayName: null,
                  optional: false,
                  responseStatus: "accepted",
                  self: true,
                  organizer: true,
                },
                {
                  email: "lena@fieldstone.bio",
                  displayName: "Lena Fischer",
                  optional: false,
                  responseStatus: "accepted",
                  self: false,
                  organizer: false,
                },
              ]
            : [];
        const cal =
          DEMO_CALENDARS.find((c) => c.id === calId) ?? DEMO_CALENDARS[0];
        events.push({
          id: `demo-${dayStart}-${i}`,
          calendarId: cal.id,
          calendar: cal.name,
          color: null,
          title,
          startMs: s,
          endMs: e,
          allDay: !!allDay,
          location,
          description: invited
            ? "Agenda: Q2 financials, Series A close, hiring plan."
            : null,
          htmlLink: null,
          etag: `"demo-${dayStart}-${i}"`,
          status: "confirmed",
          organizerEmail: invited ? "maya@heliosrobotics.io" : me,
          organizerSelf: !invited,
          recurringEventId: null,
          hangoutLink: i === 4 ? "https://meet.google.com/demo-fieldstone" : null,
          attendees,
          accessRole: cal.accessRole,
          icalUid: `demo-${dayStart}-${i}@fission.local`,
        });
      });
      dayStart += D;
    }
    return events;
  }

  /** Fixtures + the CRUD overlay (created / patched / deleted). */
  async listEvents(startMs: number, endMs: number): Promise<CalendarEvent[]> {
    const ov = this.state.calendarOverlay;
    const events = this.baseEvents(startMs, endMs)
      .filter((e) => !ov.deleted.includes(e.id))
      .map((e) => (ov.patched[e.id] ? { ...e, ...ov.patched[e.id] } : e))
      // an event edited AWAY from its fixture day no longer overlaps here
      .filter((e) => e.startMs < endMs && e.endMs > startMs);
    // …and one edited INTO this range comes from a day the base synthesis
    // above never generated — pull patched ids in by their own times.
    for (const id of Object.keys(ov.patched)) {
      if (events.some((e) => e.id === id) || ov.deleted.includes(id)) continue;
      const ev = this.findEvent(id);
      if (ev && ev.startMs < endMs && ev.endMs > startMs) events.push(ev);
    }
    for (const c of ov.created) {
      if (c.startMs < endMs && c.endMs > startMs) events.push({ ...c });
    }
    events.sort((a, b) => a.startMs - b.startMs);
    return events;
  }

  /** One event (fixture or created) with its patches applied. Fixture ids
   *  encode their local-midnight day: demo-{dayStart}-{i}. */
  private findEvent(eventId: string): CalendarEvent | null {
    const ov = this.state.calendarOverlay;
    const created = ov.created.find((e) => e.id === eventId);
    if (created) return { ...created };
    if (ov.deleted.includes(eventId)) return null;
    const m = /^demo-(\d+)-(\d+)$/.exec(eventId);
    if (!m) return null;
    const dayStart = Number(m[1]);
    const base = this.baseEvents(dayStart, dayStart + 24 * 3600_000).find(
      (e) => e.id === eventId
    );
    if (!base) return null;
    return { ...base, ...(ov.patched[eventId] ?? {}) };
  }

  private notifyCalendar() {
    for (const cb of this.calendarListeners) cb(null);
  }

  private applyEventPatch(eventId: string, patch: Partial<CalendarEvent>) {
    const ov = this.state.calendarOverlay;
    const created = ov.created.find((e) => e.id === eventId);
    if (created) Object.assign(created, patch);
    else ov.patched[eventId] = { ...ov.patched[eventId], ...patch };
  }

  private bumpEtag(etag: string | null): string {
    const n = Number((etag ?? '"0"').replace(/[^0-9]/g, "")) || 0;
    return `"${n + 1}"`;
  }

  /** New guest list for a draft; existing guests keep their RSVP state and
   *  the organizer (you) joins automatically, like Google. */
  private draftAttendees(
    draft: EventDraft,
    existing: CalendarEvent | null
  ): EventAttendee[] {
    const me = this.state.activeAccount.toLowerCase();
    const list = draft.attendees.map((email): EventAttendee => {
      const known = existing?.attendees.find(
        (a) => a.email.toLowerCase() === email.toLowerCase()
      );
      if (known) return known;
      const self = email.toLowerCase() === me;
      return {
        email,
        displayName: null,
        optional: false,
        responseStatus: self ? "accepted" : "needsAction",
        self,
        organizer: false,
      };
    });
    if (list.length > 0 && !list.some((a) => a.self)) {
      list.unshift({
        email: me,
        displayName: null,
        optional: false,
        responseStatus: "accepted",
        self: true,
        organizer: existing ? existing.organizerSelf : true,
      });
    }
    return list;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    return DEMO_CALENDARS.map((c) => ({ ...c }));
  }

  async createEvent(
    draft: EventDraft,
    _sendUpdates: SendUpdates
  ): Promise<CalendarEvent> {
    const ov = this.state.calendarOverlay;
    const n = ov.seq++;
    const id = `demo-created-${n}`;
    const me = this.state.activeAccount;
    const cal =
      DEMO_CALENDARS.find((c) => c.id === (draft.calendarId || "demo")) ??
      DEMO_CALENDARS[0];
    const ev: CalendarEvent = {
      id,
      calendarId: cal.id,
      calendar: cal.name,
      color: null,
      title: draft.title,
      startMs: draft.startMs,
      endMs: draft.endMs,
      allDay: draft.allDay,
      location: draft.location,
      description: draft.description,
      htmlLink: null,
      etag: '"1"',
      status: "confirmed",
      organizerEmail: me,
      organizerSelf: true,
      recurringEventId: null,
      // Demo stand-in for Google's auto-attached Meet when conferencing is
      // requested (the desktop app gets a real meet.google.com link back).
      hangoutLink: draft.addConferencing ? `https://meet.google.com/demo-${n}` : null,
      attendees: this.draftAttendees(draft, null),
      accessRole: cal.accessRole,
      icalUid: `${id}@fission.local`,
    };
    ov.created.push(ev);
    this.persist();
    this.notifyCalendar();
    return ev;
  }

  async updateEvent(
    _calendarId: string,
    eventId: string,
    etag: string | null,
    draft: EventDraft,
    _sendUpdates: SendUpdates
  ): Promise<EventWriteResult> {
    const current = this.findEvent(eventId);
    if (!current) throw new Error("event not found");
    if (etag && current.etag && etag !== current.etag) {
      return { status: "conflict", event: current };
    }
    const patch: Partial<CalendarEvent> = {
      title: draft.title,
      startMs: draft.startMs,
      endMs: draft.endMs,
      allDay: draft.allDay,
      location: draft.location,
      description: draft.description,
      attendees: this.draftAttendees(draft, current),
      etag: this.bumpEtag(current.etag),
    };
    // Mirror event_body: add a Meet on edit only when the event has none yet,
    // so re-saving an event that already has one never duplicates it.
    if (draft.addConferencing && !current.hangoutLink) {
      patch.hangoutLink = `https://meet.google.com/demo-${this.state.calendarOverlay.seq++}`;
    }
    this.applyEventPatch(eventId, patch);
    this.persist();
    this.notifyCalendar();
    return { status: "ok", event: this.findEvent(eventId) };
  }

  async deleteEvent(
    _calendarId: string,
    eventId: string,
    etag: string | null,
    _sendUpdates: SendUpdates
  ): Promise<EventWriteResult> {
    const current = this.findEvent(eventId);
    if (!current) return { status: "ok", event: null }; // already gone
    if (etag && current.etag && etag !== current.etag) {
      return { status: "conflict", event: current };
    }
    const ov = this.state.calendarOverlay;
    ov.created = ov.created.filter((e) => e.id !== eventId);
    if (/^demo-\d+-\d+$/.test(eventId)) ov.deleted.push(eventId);
    delete ov.patched[eventId];
    this.persist();
    this.notifyCalendar();
    return { status: "ok", event: null };
  }

  /** Mirror of the desktop demo's invite fixtures (mock.rs demo_ics): the
   *  board-meeting thread resolves to that day's fixture event, the dinner
   *  deliberately doesn't — exercising the open-in-Google-Calendar fallback. */
  async threadInvite(threadId: ThreadId): Promise<ThreadInvite | null> {
    if (threadId === "t-cal-board") {
      const day = new Date(2026, 6, 9).getTime(); // Thu Jul 9, 2026 local
      const event = this.findEvent(`demo-${day}-2`);
      return {
        method: "REQUEST",
        uid: `demo-${day}-2@fission.local`,
        summary: "Helios Robotics Board Meeting",
        organizerEmail: "maya@heliosrobotics.io",
        startMs: day + 10 * 3600_000,
        endMs: day + 11.5 * 3600_000,
        allDay: false,
        openUrl: null,
        event,
      };
    }
    if (threadId === "t-cal-dinner") {
      const day = new Date(2026, 6, 15).getTime();
      return {
        method: "REQUEST",
        uid: "saastrix-founders-dinner-2026@saastrix.com",
        summary: "Founders' Dinner — SF",
        organizerEmail: "events@saastrix.com",
        startMs: day + 19 * 3600_000,
        endMs: day + 22 * 3600_000,
        allDay: false,
        openUrl: "https://calendar.google.com/",
        event: null,
      };
    }
    return null;
  }

  async rsvpEvent(
    _calendarId: string,
    eventId: string,
    response: RsvpResponse
  ): Promise<CalendarEvent> {
    const current = this.findEvent(eventId);
    if (!current) throw new Error("event not found");
    if (!current.attendees.some((a) => a.self)) {
      throw new Error("You're not on this event's guest list");
    }
    this.applyEventPatch(eventId, {
      attendees: current.attendees.map((a) =>
        a.self ? { ...a, responseStatus: response } : a
      ),
      etag: this.bumpEtag(current.etag),
    });
    this.persist();
    this.notifyCalendar();
    const updated = this.findEvent(eventId);
    if (!updated) throw new Error("event not found");
    return updated;
  }

  async getSettings() {
    return this.state.settings;
  }
  async saveSettings(settings: Settings) {
    for (const sp of settings.splits) {
      try {
        parseSplitQuery(sp.query);
      } catch (e) {
        throw new Error(`split "${sp.name}": ${e instanceof Error ? e.message : e}`);
      }
    }
    const splitsChanged =
      JSON.stringify(this.state.settings.splits) !== JSON.stringify(settings.splits);
    this.state.settings = settings;
    this.persist();
    // A changed definition re-files the mailbox (mirrors the Rust background
    // reclassify pass + its mail:updated).
    if (splitsChanged) {
      this.reclassifyAll();
      this.notify();
    }
  }
  async getKnowledgeBase() {
    return this.state.kb;
  }
  async saveKnowledgeBase(kb: KnowledgeBase) {
    this.state.kb = kb;
    this.persist();
  }

  async setAiKey(provider: AiProviderId, key: string) {
    this.state.keys[provider] = key;
    const p = this.state.settings.providers.find((p) => p.id === provider);
    if (p) p.hasKey = key.length > 0;
    this.persist();
  }
  async testAiProvider(provider: AiProviderId) {
    const key = this.state.keys[provider];
    if (!key)
      return { ok: false, message: "No key saved. Real calls need the desktop app." };
    return {
      ok: true,
      message: "Key saved (demo mode — real network test runs in the desktop app).",
    };
  }

  aiDraft(req: DraftRequest, handlers: DraftStreamHandlers): () => void {
    const id = this.aiSeq++;
    this.cancelFlags.set(id, false);
    const kb = this.state.kb;
    const thread = req.threadId ? this.threads.find((t) => t.id === req.threadId) : null;
    const msgs = req.threadId ? this.messages.get(req.threadId) ?? [] : [];
    const last = msgs[msgs.length - 1];

    let body: string;
    if (req.existingText) {
      body = `${req.existingText.trim()}\n\n[Demo edit applied: "${req.instruction}"]`;
    } else {
      const greeting = last ? `Hi ${last.fromName.split(" ")[0]},` : "Hi,";
      const ctx = thread
        ? `Thanks for the note on "${thread.subject}".`
        : "";
      const instructionLine = req.instruction
        ? `Here's a draft along the lines of: ${req.instruction}.`
        : "Happy to help — here are my thoughts.";
      const kbLine = kb.instructions
        ? `\n\n[Demo mode: your standing instructions are being applied — "${kb.instructions.slice(0, 90)}"]`
        : "";
      body = `${greeting}\n\n${ctx} ${instructionLine}\n\nLet me know if this works on your end and I'll take it from there.\n\nBest,\nDemo Draft${kbLine}`;
    }

    const words = body.split(/(?<=\s)/);
    let i = 0;
    const tick = () => {
      if (this.cancelFlags.get(id)) return;
      if (i >= words.length) {
        handlers.onDone();
        return;
      }
      handlers.onChunk(words[i]);
      i++;
      setTimeout(tick, 18);
    };
    setTimeout(tick, 250);
    return () => this.cancelFlags.set(id, true);
  }

  async aiSuggestReplies(threadId: ThreadId): Promise<string[]> {
    const msgs = this.messages.get(threadId) ?? [];
    const last = msgs[msgs.length - 1];
    const name = last ? last.fromName.split(" ")[0] : "there";
    return [
      `Thanks ${name} — confirming receipt. I'll review and come back to you by tomorrow.`,
      `Appreciate the nudge. Yes on my end — let's lock it in.`,
      `Thanks for this. A few questions before I can confirm — do you have 15 minutes this week?`,
    ];
  }

  async getStreaks() {
    return this.state.streaks;
  }

  async recordZero(splitId: string): Promise<ZeroEvent | null> {
    const today = new Date().toISOString().slice(0, 10);
    const s = this.state.streaks;
    if (s.lastZeroDay !== today) {
      const yesterday = new Date(Date.now() - 24 * 3600_000)
        .toISOString()
        .slice(0, 10);
      s.daily = s.lastZeroDay === yesterday ? s.daily + 1 : 1;
      s.weekly = Math.floor(s.daily / 7);
      s.lastZeroDay = today;
      this.persist();
    }
    const img =
      BUNDLED_CELEBRATIONS[
        Math.floor(Math.random() * BUNDLED_CELEBRATIONS.length)
      ];
    return { splitId, daily: s.daily, weekly: s.weekly, imagePath: img };
  }

  async listCelebrationImages() {
    return BUNDLED_CELEBRATIONS;
  }

  async refreshCalendar() {
    // demo events are synthesized on read — announce "fresh" immediately
    for (const cb of this.calendarListeners) cb(null);
  }

  // The Unsplash key lives in the Rust core only; the browser demo serves a
  // bundled scene so the empty-state layout is still demoable.
  async getDailyPhoto() {
    return {
      url: "/inbox-zero/quiet-lake.svg",
      blurHash: null,
      authorName: "Snail Mail demo art",
      authorLink: null,
      photoLink: null,
      downloadLocation: null,
      cachedDataUri: null,
      fetchedAt: Date.now(),
    };
  }
  async photoShown() {}
  async setUnsplashKey() {}

  /** Recipient autocomplete from the demo corpus: everyone the active
   *  account has sent to or heard from, ranked like the Rust core. */
  async searchContacts(query: string) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const me = this.state.activeAccount.toLowerCase();
    // aggregate name+email + freq across all messages in the active account
    const idx = new Map<string, { name: string; email: string; freq: number }>();
    const add = (name: string, rawEmail: string) => {
      const email = rawEmail.trim().toLowerCase();
      if (!email.includes("@") || email === me) return;
      const cur = idx.get(email);
      if (cur) {
        cur.freq++;
        if (!cur.name && name) cur.name = name;
      } else {
        idx.set(email, { name: name.trim(), email, freq: 1 });
      }
    };
    const parseAddr = (raw: string): [string, string] => {
      const m = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
      if (m) return [m[1].trim(), m[2].trim()];
      return ["", raw.trim()];
    };
    for (const t of this.threads) {
      if (!this.inActiveAccount(t)) continue;
      for (const msg of this.messages.get(t.id) ?? []) {
        add(msg.fromName, msg.from);
        for (const addr of [...msg.to, ...msg.cc]) {
          const [name, email] = parseAddr(addr);
          add(name, email);
        }
      }
    }
    const hits = [...idx.values()].filter(
      (c) => c.name.toLowerCase().includes(q) || c.email.includes(q)
    );
    hits.sort((a, b) => {
      const ap = a.name.toLowerCase().startsWith(q) || a.email.startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) || b.email.startsWith(q) ? 0 : 1;
      return ap - bp || b.freq - a.freq;
    });
    // Merge the fixture Google address book the way the Rust core merges the
    // people_contacts table: prefix matches first, history beats address
    // book within each band, dedup by email.
    const isPrefix = (c: { name: string; email: string }) =>
      c.name.toLowerCase().startsWith(q) || c.email.startsWith(q);
    const people = MOCK_GOOGLE_CONTACTS.filter(
      (c) => c.name.toLowerCase().includes(q) || c.email.includes(q)
    );
    const merged = [
      ...hits.filter(isPrefix),
      ...people.filter(isPrefix),
      ...hits.filter((c) => !isPrefix(c)),
      ...people.filter((c) => !isPrefix(c)),
    ];
    const seen = new Set<string>();
    const out: { name: string; email: string }[] = [];
    for (const { name, email } of merged) {
      if (seen.has(email) || email === me) continue;
      seen.add(email);
      out.push({ name, email });
      if (out.length >= 8) break;
    }
    return out;
  }

  /** Demo mode syncs no real Google contacts — report the fixture count. */
  async refreshContacts(): Promise<number> {
    return MOCK_GOOGLE_CONTACTS.length;
  }

  /** Fixture send-as aliases so the Settings list is demoable. */
  async getSendAs(email: string): Promise<SendAsAlias[]> {
    return [
      {
        email,
        displayName: "You",
        isDefault: true,
        verified: true,
        hasSignature: true,
      },
      {
        email: email.replace("@", "+deals@"),
        displayName: "Deal Flow",
        isDefault: false,
        verified: true,
        hasSignature: false,
      },
    ];
  }

  /** Tiny stand-in for Harper: a fixed misspelling list so the demo shows
   *  the underline + click-to-fix flow. The desktop app lints for real. */
  async lintText(text: string) {
    const known: Record<string, string[]> = {
      teh: ["the"],
      recieve: ["receive"],
      definately: ["definitely"],
      adress: ["address"],
      seperate: ["separate"],
      occured: ["occurred"],
      wich: ["which"],
      thier: ["their"],
    };
    const hits = [];
    const re = /[A-Za-z']+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const fixes = known[m[0].toLowerCase()];
      if (fixes) {
        hits.push({
          span: { start: m.index, end: m.index + m[0].length },
          message: `Did you mean "${fixes[0]}"?`,
          suggestions: fixes,
        });
      }
    }
    return hits;
  }

  onMailUpdated(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  onSyncProgress(cb: (p: SyncProgress) => void): () => void {
    this.syncListeners.add(cb);
    // Replay the current state so a subscriber that mounts after the download
    // started (App effect runs after the backend is constructed) still catches
    // the in-flight progress.
    if (this.lastProgress) cb(this.lastProgress);
    return () => this.syncListeners.delete(cb);
  }
  onSyncActivity(cb: (a: SyncActivity) => void): () => void {
    this.activityListeners.add(cb);
    return () => this.activityListeners.delete(cb);
  }
  /** The desktop's pull command: subscribers get the in-flight pass on mount
   *  rather than replaying through the listener (which would double-count for
   *  anyone already subscribed). */
  async getSyncActivity(): Promise<SyncActivity | null> {
    return this.lastActivity;
  }
  onCalendarUpdated(cb: (error: string | null) => void): () => void {
    this.calendarListeners.add(cb);
    return () => this.calendarListeners.delete(cb);
  }
  // Demo fixtures carry real HTML + no remote images, so these never fire.
  onThreadImages(): () => void {
    return () => {};
  }
  onTriageError(): () => void {
    return () => {};
  }
  onNotice(): () => void {
    return () => {};
  }
  // The storage split is a desktop-only, one-time event; the demo never migrates.
  onMigrationProgress(): () => void {
    return () => {};
  }
  onAccountsUpdated(cb: (a: AccountsState) => void): () => void {
    this.accountsListeners.add(cb);
    return () => this.accountsListeners.delete(cb);
  }
}

// assignSplit is gone (v0.23): split membership is materialized on Thread
// (`split` / `alsoIn`) by the backend — Rust at sync time, this mock via
// reclassifyAll(). UI-side membership checks use threadInSplit() from
// src/lib/split-query.ts.
