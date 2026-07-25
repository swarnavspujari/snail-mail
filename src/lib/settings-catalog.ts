// Every plain preference in one declarative table.
//
// The panes render from it and the Ctrl+F index is built from it, so a setting
// cannot exist in the search results and be missing from its pane (or the other
// way round — the five keys at the bottom of "On launch" and "Attachments" were
// real settings with no interface at all until this table listed them).
//
// Control vocabulary, one per job: boolean → Switch, two or three options →
// Segmented, four or more → Select, free text → Input, anything that leaves the
// machine → Button (control: "action").
import type { Settings } from "./types";

export type PaneId =
  | "general"
  | "mail"
  | "ai"
  | "keyboard"
  | "zero"
  | "privacy"
  | "about";

export type ControlKind = "switch" | "segmented" | "select" | "text" | "action";

/** Pane headings — also the first half of every search breadcrumb. */
export const PANE_TITLES: Record<PaneId, string> = {
  general: "General",
  mail: "Mail & triage",
  ai: "AI & knowledge",
  keyboard: "Keyboard",
  zero: "Inbox zero",
  privacy: "Privacy & keys",
  about: "About & updates",
};

export const PANE_SUBTITLES: Record<PaneId, string> = {
  general: "How the app looks, and what it shows when it launches. Everything here applies the moment you change it.",
  mail: "Splits, undo windows, and what happens to files too big to email.",
  ai: "Bring your own key. Prompts, snippets and voice examples travel with your drafts; the keys live in Privacy & keys.",
  keyboard: "Every command in the app, grouped the way the command palette groups them. Remap anything; conflicts are flagged before they bite.",
  zero: "What an empty split looks like, and how far you've kept it that way.",
  privacy: "One home for every credential the app holds, and everything it keeps on disk.",
  about: "Version, channel and what changed. Updates install themselves from GitHub Releases.",
};

export interface PrefOption {
  /** Stored value, as a string (numeric keys are converted on write). */
  value: string;
  label: string;
}

export interface PrefRow {
  /** Stable id — also what search matches on and what the pane keys rows by. */
  id: string;
  label: string;
  help?: string;
  pane: PaneId;
  section: string;
  control: ControlKind;
  /** The settings key this row owns. Exactly one row per key. */
  key?: keyof Settings;
  /** Numeric settings key — the stored value is a number, not the option string. */
  numeric?: boolean;
  options?: PrefOption[];
  /** Button label for `action` rows. */
  action?: string;
  actionVariant?: "primary" | "secondary" | "quiet" | "danger";
  /** Extra search terms. The settings key is always searchable. */
  keywords?: string;
}

export const PREF_ROWS: PrefRow[] = [
  // ---------------------------------------------------------------- General
  {
    id: "theme",
    label: "Theme",
    help: "Dark sits on the MD3 tonal ladder; light is tuned for contrast, not inverted.",
    pane: "general",
    section: "Appearance",
    control: "segmented",
    key: "theme",
    options: [
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
    ],
    keywords: "dark light appearance colour color",
  },
  // Both hint toggles live under Appearance for now — they are the same
  // decision ("how much does the app teach me its keys?") split across two
  // surfaces, and "On launch" was never true of them: either can be flipped
  // mid-session and takes effect at once.
  {
    id: "showShortcutBar",
    label: "Show the bottom hint bar",
    help: "The strip of keycaps along the bottom of the inbox.",
    pane: "general",
    section: "Appearance",
    control: "switch",
    key: "showShortcutBar",
    keywords: "hints keycaps footer strip",
  },
  {
    id: "showKeyHints",
    label: "Show keyboard hints everywhere else",
    help: "Keycaps on hover, the inline key strips, and the sidebar chords. The shortcuts panel and Settings → Shortcuts always show their keys.",
    pane: "general",
    section: "Appearance",
    control: "switch",
    key: "showKeyHints",
    keywords: "hints keycaps tooltip hover chords teach",
  },
  {
    id: "sidebarOpen",
    label: "Open the folder sidebar",
    help: "The folder and label rail beside the list.",
    pane: "general",
    section: "On launch",
    control: "switch",
    key: "sidebarOpen",
    keywords: "labels folders rail",
  },
  {
    id: "calendarOpen",
    label: "Open the calendar day panel",
    help: "The day agenda next to the inbox.",
    pane: "general",
    section: "On launch",
    control: "switch",
    key: "calendarOpen",
    keywords: "agenda day panel",
  },
  {
    id: "notifications",
    label: "New mail",
    help: "Only while the Snail Mail window is in the background.",
    pane: "general",
    section: "Notifications",
    control: "switch",
    key: "notifications",
    keywords: "notify desktop toast",
  },
  {
    id: "showBadge",
    label: "Unread badge on the app icon",
    help: "Unread conversations in Important, on the taskbar (Windows), dock (macOS) or launcher (Linux). Desktop only.",
    pane: "general",
    section: "Notifications",
    control: "switch",
    key: "showBadge",
    keywords: "badge taskbar dock launcher unread count icon overlay",
  },
  {
    id: "tour",
    label: "Welcome tour",
    help: "Connect, AI, theme, shortcuts — four steps, two minutes.",
    pane: "general",
    section: "Onboarding",
    control: "action",
    action: "Replay tour",
    actionVariant: "secondary",
    keywords: "onboarding walkthrough first run",
  },

  // ---------------------------------------------------------- Mail & triage
  {
    id: "undoSendSeconds",
    label: "Undo send window",
    help: "Hold outgoing mail so you can pull it back. Z undoes; Ctrl+Shift+Z sends instantly.",
    pane: "mail",
    section: "Sending",
    control: "segmented",
    key: "undoSendSeconds",
    numeric: true,
    options: [
      { value: "0", label: "Off" },
      { value: "10", label: "10s" },
      { value: "30", label: "30s" },
    ],
    keywords: "undo send delay outbox",
  },
  {
    id: "driveAutoUpload",
    label: "Files over 25 MB",
    help: "Google's limit. Bigger files go to Drive and send as a link, like Gmail.",
    pane: "mail",
    section: "Attachments",
    control: "segmented",
    key: "driveAutoUpload",
    options: [
      { value: "ask", label: "Ask first" },
      { value: "always", label: "Always upload" },
    ],
    keywords: "attachments oversized large google drive",
  },
  {
    id: "driveShareMode",
    label: "Drive link access",
    help: "Who can open the files you send as Drive links.",
    pane: "mail",
    section: "Attachments",
    control: "segmented",
    key: "driveShareMode",
    options: [
      { value: "recipients", label: "Recipients" },
      { value: "anyone", label: "Anyone" },
      { value: "none", label: "Unchanged" },
    ],
    keywords: "sharing permissions link access",
  },
  {
    id: "hiddenCalendars",
    label: "Hidden calendars",
    help: "Hidden from the week grid and the day panel.",
    pane: "mail",
    section: "Calendar",
    control: "action",
    key: "hiddenCalendars",
    action: "Manage",
    actionVariant: "secondary",
    keywords: "calendars hide show",
  },

  // -------------------------------------------------------- AI & knowledge
  {
    id: "embeddings",
    label: "Embeddings",
    help: "Local keeps mail on-device and works offline; the model is a one-time 34 MB download.",
    pane: "ai",
    section: "Semantic search",
    control: "select",
    key: "embeddings",
    options: [
      { value: "local", label: "Local model (private, offline)" },
      { value: "openai", label: "OpenAI text-embedding-3-small" },
    ],
    keywords: "semantic vector search meaning",
  },

  // ------------------------------------------------------------- Inbox zero
  {
    id: "celebrationDir",
    label: "Photo folder",
    help: "Point at your own images instead of the daily photo. Empty uses the bundled set.",
    pane: "zero",
    section: "Rest photo",
    control: "text",
    key: "celebrationDir",
    keywords: "celebration images pictures unsplash folder",
  },
];

export function prefsFor(pane: PaneId, section: string): PrefRow[] {
  return PREF_ROWS.filter((r) => r.pane === pane && r.section === section);
}

export function prefRow(id: string): PrefRow {
  const r = PREF_ROWS.find((x) => x.id === id);
  if (!r) throw new Error(`unknown preference row: ${id}`);
  return r;
}

/** The stored value of a row as a string, for comparing against options. */
export function rawValueFor(row: PrefRow, settings: Settings): string {
  if (!row.key) return "";
  const v = settings[row.key];
  return v === null || v === undefined ? "" : String(v);
}

/** How a row's current value reads in the search results and the footer. */
export function valueTextFor(row: PrefRow, settings: Settings): string {
  if (!row.key) return "";
  const raw = rawValueFor(row, settings);
  if (row.control === "switch") return settings[row.key] ? "On" : "Off";
  if (row.control === "segmented" || row.control === "select") {
    return row.options?.find((o) => o.value === raw)?.label ?? raw;
  }
  if (row.control === "text") return raw || "Not set";
  return "";
}

/** The patch that writes `value` to the row's settings key. Controls hand back
 *  strings; the settings keys are typed, so each kind converts on the way in
 *  (a boolean stored as the string "false" reads as true everywhere). */
export function patchFor(row: PrefRow, value: string): Partial<Settings> {
  if (!row.key) return {};
  if (row.control === "switch") {
    return { [row.key]: value === "true" } as Partial<Settings>;
  }
  if (row.numeric) return { [row.key]: Number(value) } as Partial<Settings>;
  if (row.control === "text") {
    return { [row.key]: value.trim() ? value.trim() : null } as Partial<Settings>;
  }
  return { [row.key]: value } as Partial<Settings>;
}
