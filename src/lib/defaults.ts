// Defaults shared by the mock backend and the settings UI.
// The Rust core keeps an identical set in src-tauri/src/store/mod.rs.
import type { KnowledgeBase, Settings, Split } from "./types";

export const DEFAULT_SPLITS: Split[] = [
  {
    id: "important",
    name: "Important",
    builtin: true,
    query: "label:IMPORTANT",
    accountId: null,
    alsoShow: false,
    hideWhenEmpty: false,
  },
  {
    id: "other",
    name: "Other",
    builtin: true,
    query: "", // empty query = catch-all for threads no other split claims
    accountId: null,
    alsoShow: false,
    hideWhenEmpty: false,
  },
  // The old builtin "Calendar" split is gone as of v0.7 — the calendar lives
  // in a toggleable side panel now; saved copies are dropped on load.
];

// Aligned with Superhuman v7 (Windows & Linux edition): A reply-all, S star,
// # trash, Shift+E mark not done, U toggles read/unread, G-then-O Other,
// Ctrl+Shift+Enter send & mark done, Ctrl+1-9 switch accounts.
export const DEFAULT_SHORTCUTS: Record<string, string> = {
  "palette.open": "mod+k",
  compose: "c",
  "thread.done": "e",
  "thread.notDone": "shift+e",
  "thread.snooze": "h",
  "thread.reply": "r",
  "thread.replyAll": "a",
  "thread.forward": "f",
  "thread.replyAllOrOpen": "enter",
  "thread.star": "s",
  "thread.trash": "#|delete|backspace",
  "thread.spam": "!",
  // Shift+M matches Superhuman; bare M stays reserved for their Comment key.
  "thread.mute": "shift+m",
  "thread.unsubscribe": "mod+u",
  undo: "z|mod+z",
  // J/K change conversation everywhere; arrows scroll the open email (reader)
  // or move the cursor (list) — see list.cursorDown/reader.lineDown.
  "list.next": "j",
  "list.prev": "k",
  "list.cursorDown": "down",
  "list.cursorUp": "up",
  "reader.lineDown": "down",
  "reader.lineUp": "up",
  "reader.pageUp": "shift+space",
  // Multi-message threads: ↓/↑ step the per-message cursor and Enter drills into
  // the focused message. These share keys with reader.lineDown/Up (down/up) and
  // thread.replyAllOrOpen (enter); the commands' `when` (>1 message) + registry
  // order decide the winner, so single-message threads keep scroll / Reply-All.
  "thread.focusNext": "down",
  "thread.focusPrev": "up",
  "thread.focusEnter": "enter",
  "thread.unread": "u",
  // V = Move, L = Add/Remove Label in Superhuman; both open our picker.
  "thread.move": "v|l",
  search: "/",
  "ai.ask": "?",
  "split.next": "tab",
  "split.prev": "shift+tab",
  // Bare "1" mirrors calendar.open's "2": 1 = Inbox, 2 = Calendar.
  "goto.inbox": "g i|1",
  "goto.other": "g o",
  "goto.done": "g e",
  "goto.reminders": "g h",
  "goto.starred": "g s",
  // Superhuman's Trash chord is G-#; G-T stays ours until a Sent view lands.
  "goto.trash": "g t|g #",
  "goto.drafts": "g d",
  "compose.ai": "mod+j",
  "compose.send": "mod+enter",
  "compose.sendDone": "mod+shift+enter",
  "compose.sendLater": "mod+shift+l",
  "compose.snippet": "mod+;",
  "compose.expandTo": "mod+shift+o",
  "compose.expandCc": "mod+shift+c",
  "compose.expandBcc": "mod+shift+b",
  "compose.expandSubject": "mod+shift+s",
  // D = Drive. Superhuman has no equivalent key; mod+shift+d is unclaimed.
  "compose.attachDrive": "mod+shift+d",
  // Discard the draft. Shift+"," is "<" in KeyboardEvent.key, so the physical
  // Ctrl+Shift+, arrives as "mod+<"; the "mod+shift+," alt is the label shown.
  "compose.discard": "mod+shift+,|mod+<",
  // New-message composer: K/J background the draft and jump to the prev/next
  // email (the header ↑/↓ chevrons do the same). Suppressed while a field has
  // focus, so typing "j"/"k" is never hijacked.
  "compose.prevEmail": "k",
  "compose.nextEmail": "j",
  // Accelerate a pending send (skip the Undo Send window, send instantly).
  "send.accelerate": "mod+shift+z",
  "theme.toggle": "",
  "badge.toggle": "",
  // Superhuman calendar keys: 0 opens the day view, 2 the week; -/= move
  // days while the calendar owns focus (our ←/→ still work).
  "calendar.toggle": "0",
  "calendar.open": "g c|2",
  "calendar.prevDay": "left|-",
  "calendar.nextDay": "right|=",
  "calendar.today": "",
  // B = Create Event, matching Superhuman (C stays Compose).
  "calendar.newEvent": "b",
  "sidebar.toggle": "",
  "shortcutBar.toggle": "",
  "shortcuts.show": "",
  "list.selectAll": "mod+a",
  "list.toggleSelect": "x",
  "thread.cycleSuggestion": "tab",
  "thread.scrollDown": "space",
  back: "escape",
  "inbox.zeroSweep": "",
  "sync.now": "",
  "sync.resync": "",
  "update.check": "",
  "settings.open": "mod+,",
  // Alt+N (was mod+N through v0.5) — keeps Ctrl+N for browser muscle memory
  "account.1": "alt+1",
  "account.2": "alt+2",
  "account.3": "alt+3",
  "account.4": "alt+4",
  "account.5": "alt+5",
  "account.6": "alt+6",
  "account.7": "alt+7",
  "account.8": "alt+8",
  "account.9": "alt+9",
};

export function defaultSettings(): Settings {
  return {
    splits: DEFAULT_SPLITS.map((s) => ({ ...s })),
    // NIM/DeepSeek is the default because it's the key the user supplied
    defaultAiProvider: "nim",
    providers: [
      {
        id: "claude",
        label: "Claude",
        model: "claude-sonnet-5",
        baseUrl: null,
        hasKey: false,
      },
      {
        id: "openai",
        label: "OpenAI",
        model: "gpt-5.2",
        baseUrl: null,
        hasKey: false,
      },
      {
        id: "nim",
        label: "NVIDIA NIM",
        model: "deepseek-ai/deepseek-v4-pro",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        hasKey: false,
      },
    ],
    celebrationDir: null,
    shortcuts: { ...DEFAULT_SHORTCUTS },
    signatures: {},
    theme: "dark",
    notifications: true,
    showBadge: true,
    onboarded: false,
    calendarOpen: false,
    hiddenCalendars: [],
    sidebarOpen: false,
    showShortcutBar: true,
    undoSendSeconds: 10,
    driveAutoUpload: "ask",
    driveShareMode: "recipients",
    embeddings: "local",
  };
}

export function defaultKnowledgeBase(): KnowledgeBase {
  return { instructions: "", snippets: [], voiceExamples: [] };
}

export const BUNDLED_CELEBRATIONS = [
  "/inbox-zero/dawn-ridge.svg",
  "/inbox-zero/quiet-lake.svg",
  "/inbox-zero/night-dunes.svg",
  "/inbox-zero/aurora-field.svg",
];
