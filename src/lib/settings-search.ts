// One index over everything settings can show you: preferences, every command's
// keys, each connected address, and the help entries. Ctrl+F inside settings
// searches this — so "drive" finds the two Drive preferences AND the account
// whose grant is missing Drive, and "ctrl k" finds the command that owns it.
import {
  PANE_TITLES,
  PREF_ROWS,
  rawValueFor,
  valueTextFor,
  type PrefRow,
} from "./settings-catalog";
import { grantHealthy } from "./grant-health";
import { exprKeycaps } from "./keyboard";
import type { ShortcutRow, ShortcutState } from "./shortcut-edit";
import type { AccountsState, Capabilities, Settings } from "./types";

export type SearchKind = "Settings" | "Shortcuts" | "Accounts" | "Help";

export interface SearchEntry {
  kind: SearchKind;
  label: string;
  /** Breadcrumb: "Mail & triage › Attachments". */
  path: string;
  /** Pane to jump to — a PaneId, or "account:<email>". */
  pane: string;
  glyph: string;
  /** Extra terms matched but not shown. */
  keywords: string;
  /** Current value, rendered ("On", "30s", "needs reconnect"). */
  value?: string;
  /** Set on boolean preferences: search can flip them without leaving. */
  toggleKey?: keyof Settings;
  /** The preference row this points at, when it is one. */
  prefId?: string;
  /** Shortcut binding, for Shortcuts entries. */
  keys?: string;
  commandId?: string;
  state?: ShortcutState;
  /** External URL, for Help entries that open a page. */
  url?: string;
}

const KIND_ORDER: SearchKind[] = ["Settings", "Shortcuts", "Accounts", "Help"];
/** Per-kind cap so one kind can't crowd the others out. */
const PER_KIND = 6;
/** What an empty query shows: a taste of each kind, not the whole index. */
const PREVIEW_PER_KIND = 3;

function prefEntry(row: PrefRow, settings: Settings): SearchEntry {
  return {
    kind: "Settings",
    label: row.label,
    path: `${PANE_TITLES[row.pane]} › ${row.section}`,
    pane: row.pane,
    glyph: "▸",
    keywords: [row.help ?? "", row.keywords ?? "", row.key ?? "", row.id].join(" "),
    value: valueTextFor(row, settings),
    toggleKey: row.control === "switch" ? row.key : undefined,
    prefId: row.id,
  };
}

/** Sections rendered by hand (splits, providers, the knowledge base, keys) still
 *  have to be findable — they're listed here with the same breadcrumbs. */
function bespokeEntries(settings: Settings): SearchEntry[] {
  const out: SearchEntry[] = [];
  const at = (pane: keyof typeof PANE_TITLES, section: string) =>
    `${PANE_TITLES[pane]} › ${section}`;

  for (const s of settings.splits) {
    out.push({
      kind: "Settings",
      label: s.name,
      path: at("mail", "Split inboxes"),
      pane: "mail",
      glyph: "▸",
      keywords: `split inbox tab ${s.query} ${s.builtin ? "built-in" : "custom"}`,
      value: s.query.trim() === "" ? "catch-all" : s.query,
    });
  }
  out.push({
    kind: "Settings",
    label: "Split inboxes",
    path: at("mail", "Split inboxes"),
    pane: "mail",
    glyph: "▸",
    keywords: "splits tabs rules query important other",
    value: `${settings.splits.length} splits`,
  });

  for (const p of settings.providers) {
    out.push({
      kind: "Settings",
      label: p.label,
      path: at("ai", "Default provider"),
      pane: "ai",
      glyph: "▸",
      keywords: `ai provider model ${p.model} ${p.id}`,
      value: settings.defaultAiProvider === p.id ? "default" : p.hasKey ? "key stored" : "no key",
    });
    out.push({
      kind: "Settings",
      label: `${p.label} API key`,
      path: at("privacy", "Keys & credentials"),
      pane: "privacy",
      glyph: "▸",
      keywords: `key credential secret ${p.id}`,
      value: p.hasKey ? "stored" : "not set",
    });
  }

  out.push(
    {
      kind: "Settings",
      label: "Standing instructions",
      path: at("ai", "Knowledge base"),
      pane: "ai",
      glyph: "▸",
      keywords: "knowledge base rules tone voice prompt",
    },
    {
      kind: "Settings",
      label: "Snippets",
      path: at("ai", "Knowledge base"),
      pane: "ai",
      glyph: "▸",
      keywords: "knowledge base reusable blocks bio disclaimer",
    },
    {
      kind: "Settings",
      label: "Voice examples",
      path: at("ai", "Knowledge base"),
      pane: "ai",
      glyph: "▸",
      keywords: "knowledge base tone sounds like me",
    },
    {
      kind: "Settings",
      label: "Google OAuth client",
      path: at("privacy", "Keys & credentials"),
      pane: "privacy",
      glyph: "▸",
      keywords: "oauth client id secret google credential gmail connect",
    },
    {
      kind: "Settings",
      label: "Unsplash access key",
      path: at("privacy", "Keys & credentials"),
      pane: "privacy",
      glyph: "▸",
      keywords: "unsplash photo key credential rest state",
    },
    {
      kind: "Settings",
      label: "Local mail cache",
      path: at("privacy", "On this machine"),
      pane: "privacy",
      glyph: "▸",
      keywords: "cache disk storage resync rebuild sqlite",
    },
    {
      kind: "Settings",
      label: "Copy diagnostics",
      path: at("privacy", "On this machine"),
      pane: "privacy",
      glyph: "▸",
      keywords: "diagnostics support bug report version",
    },
    {
      kind: "Settings",
      label: "Erase all local data",
      path: at("privacy", "On this machine"),
      pane: "privacy",
      glyph: "▸",
      // "uninstall" and "credential manager" are how someone actually looks for
      // this: they are handing the laptop back, not browsing preferences.
      keywords:
        "erase delete wipe reset everything uninstall remove credential manager keychain token password revoke factory",
    },
    {
      kind: "Settings",
      label: "Your streak",
      path: at("zero", "Your streak"),
      pane: "zero",
      glyph: "▸",
      keywords: "inbox zero streak days weeks read-only",
    }
  );
  return out;
}

function accountEntries(
  accounts: AccountsState,
  capabilities: Record<string, Capabilities>,
  settings: Settings
): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const a of accounts.accounts) {
    const healthy = grantHealthy(capabilities[a.email], a.provider);
    out.push({
      kind: "Accounts",
      label: a.email,
      path: `Accounts › ${healthy ? "all access granted" : "needs reconnect"}`,
      pane: `account:${a.email}`,
      glyph: "◉",
      keywords: `account address grant scopes slot signature ${a.provider}`,
      value: healthy ? "healthy" : "reconnect",
    });
    out.push({
      kind: "Accounts",
      label: `Signature — ${a.email}`,
      path: `Accounts › ${a.email}`,
      pane: `account:${a.email}`,
      glyph: "✎",
      keywords: "signature sign-off footer",
      value: (settings.signatures[a.email] ?? "").trim() ? "set" : "not set",
    });
  }
  out.push({
    kind: "Accounts",
    label: "Add an account",
    path: "Accounts › Add account",
    pane: "account:add",
    glyph: "＋",
    keywords: "connect gmail outlook oauth new address",
  });
  return out;
}

export const HELP_LINKS: { label: string; keywords: string; url: string }[] = [
  {
    label: "Connect a Gmail account",
    keywords: "oauth client id secret setup docs",
    url: "https://github.com/swarnavspujari/snail-mail/blob/main/docs/SETUP.md",
  },
  {
    label: "Keyboard shortcut sheet",
    keywords: "shortcuts printable reference keys",
    url: "https://github.com/swarnavspujari/snail-mail/blob/main/docs/SHORTCUTS.md",
  },
  {
    label: "Report an issue",
    keywords: "bug github issue support",
    url: "https://github.com/swarnavspujari/snail-mail/issues",
  },
];

export function buildSettingsIndex(input: {
  settings: Settings;
  accounts: AccountsState;
  capabilities: Record<string, Capabilities>;
  shortcutRows: ShortcutRow[];
}): SearchEntry[] {
  const { settings, accounts, capabilities, shortcutRows } = input;
  return [
    ...PREF_ROWS.map((r) => prefEntry(r, settings)),
    ...bespokeEntries(settings),
    ...shortcutRows.map((r) => ({
      kind: "Shortcuts" as const,
      label: r.title,
      path: `Keyboard › ${r.group}`,
      pane: "keyboard",
      glyph: "⌘",
      keywords: [
        r.id,
        r.context ?? "",
        r.expr,
        ...r.expr
          .split("|")
          .filter(Boolean)
          .flatMap((a) => {
            const chips = exprKeycaps(a.trim());
            return [chips.join(" "), chips.join("+")];
          }),
      ].join(" "),
      keys: r.expr,
      commandId: r.id,
      state: r.state,
      value: r.expr ? undefined : "not assigned",
    })),
    ...accountEntries(accounts, capabilities, settings),
    ...HELP_LINKS.map((h) => ({
      kind: "Help" as const,
      label: h.label,
      path: "About & updates › Help",
      pane: "about",
      glyph: "?",
      keywords: h.keywords,
      url: h.url,
    })),
  ];
}

/** Filter + order the index for a query. Empty query returns a short preview. */
export function searchEntries(index: SearchEntry[], query: string): SearchEntry[] {
  const q = query.trim().toLowerCase();
  const hits = q
    ? index.filter((e) =>
        `${e.label} ${e.path} ${e.keywords} ${e.keys ?? ""} ${e.value ?? ""}`
          .toLowerCase()
          .includes(q)
      )
    : index;
  const cap = q ? PER_KIND : PREVIEW_PER_KIND;
  const out: SearchEntry[] = [];
  for (const kind of KIND_ORDER) {
    out.push(...hits.filter((e) => e.kind === kind).slice(0, cap));
  }
  return out;
}

/** Group the flat result list into the sections the overlay renders. */
export function groupEntries(
  entries: SearchEntry[]
): { kind: SearchKind; entries: SearchEntry[] }[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    entries: entries.filter((e) => e.kind === kind),
  })).filter((g) => g.entries.length > 0);
}

/** The value text for a preference row (re-exported so the overlay can refresh
 *  a row's value after toggling it in place). */
export { rawValueFor, valueTextFor };
