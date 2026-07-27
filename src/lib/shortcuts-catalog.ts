// The complete Superhuman shortcut sheet (their categories, their labels,
// their keys — transcribed from the current Windows build) with each entry
// mapped onto Snail Mail:
//   ready   — wired to a command (the panel shows the LIVE, remappable
//             binding from Settings → Shortcuts) or native to the editor
//   partial — the capability exists but only via UI, or on a different key
//   planned — the underlying feature hasn't landed yet; this doubles as the
//             shortcut roadmap (see docs/SHORTCUTS.md for the same matrix)
// Keys use the keyboard-engine expr syntax ("mod+shift+c", "g i" chords,
// "j|k" for side-by-side keycaps).

export type ShortcutStatus = "ready" | "partial" | "planned";

export interface CatalogItem {
  /** Superhuman's label, verbatim. */
  label: string;
  /** Superhuman's binding (expr syntax; "|" renders as separate keycaps). */
  keys: string;
  /** Command ids whose live bindings drive the display, one per keys-alt.
   *  Omitted for editor-native keys (TipTap) and unimplemented features. */
  commands?: string[];
  status: ShortcutStatus;
  /** Shown as a tooltip: where the capability lives / how ours differs. */
  note?: string;
}

export interface CatalogSection {
  title: string;
  items: CatalogItem[];
}

export const SHORTCUTS_CATALOG: CatalogSection[] = [
  {
    title: "Actions",
    items: [
      { label: "Superhuman Command", keys: "mod+k", commands: ["palette.open"], status: "ready", note: "Shell Command" },
      { label: "Search", keys: "/", commands: ["search"], status: "ready" },
      { label: "Undo", keys: "z", commands: ["undo"], status: "ready" },
      { label: "Ask AI", keys: "?", commands: ["ai.ask"], status: "ready", note: "Ask AI about the open thread" },
    ],
  },
  {
    title: "Navigation",
    items: [
      { label: "Next / Previous Conversation", keys: "j|k", commands: ["list.next", "list.prev"], status: "ready" },
      { label: "Next / Previous Message", keys: "n|p", status: "planned", note: "Per-message navigation inside a thread" },
      { label: "Open", keys: "enter", commands: ["thread.replyAllOrOpen"], status: "ready", note: "In the list" },
      { label: "Back", keys: "escape", commands: ["back"], status: "ready" },
      { label: "Next Split Inbox", keys: "tab", commands: ["split.next"], status: "ready" },
      { label: "Previous Split Inbox", keys: "shift+tab", commands: ["split.prev"], status: "ready" },
      { label: "Open Label Menu", keys: "left", status: "planned", note: "←/→ move calendar days while the panel is focused" },
      { label: "Page Down", keys: "space", commands: ["thread.scrollDown"], status: "ready", note: "Pages the open email" },
      { label: "Page Up", keys: "shift+space", commands: ["reader.pageUp"], status: "ready" },
      { label: "Jump to Top", keys: "mod+up", status: "planned" },
      { label: "Jump to Bottom", keys: "mod+down", status: "planned" },
      { label: "Switch Accounts", keys: "alt+1-9", status: "ready", note: "Slots follow the order in Settings → Account" },
      { label: "Superhuman Focus", keys: "right|left|down|up", status: "planned", note: "Focus mode" },
    ],
  },
  {
    title: "Conversations",
    items: [
      { label: "Mark Done (Archive)", keys: "e", commands: ["thread.done"], status: "ready" },
      { label: "Mark not Done", keys: "shift+e", commands: ["thread.notDone"], status: "ready" },
      { label: "Remind Me (Snooze)", keys: "h", commands: ["thread.snooze"], status: "ready" },
      { label: "Star", keys: "s", commands: ["thread.star"], status: "ready" },
      { label: "Mark Read or Unread", keys: "u", commands: ["thread.unread"], status: "ready" },
      { label: "Summarize", keys: "i", status: "planned", note: "AI thread summary" },
      { label: "Mute", keys: "shift+m", commands: ["thread.mute"], status: "ready" },
      { label: "Trash", keys: "#", commands: ["thread.trash"], status: "ready", note: "Delete / Backspace work too" },
      { label: "Mark as Spam", keys: "!", commands: ["thread.spam"], status: "ready" },
      { label: "Unsubscribe", keys: "mod+u", commands: ["thread.unsubscribe"], status: "ready" },
      { label: "Print", keys: "mod+p", status: "planned" },
      { label: "Select Conversation", keys: "x", commands: ["list.toggleSelect"], status: "ready" },
      { label: "Clear Selection", keys: "escape", commands: ["back"], status: "ready" },
      { label: "Select All From Here", keys: "mod+a", commands: ["list.selectAll"], status: "ready" },
      { label: "Select All", keys: "mod+shift+a", status: "planned" },
      { label: "Share Conversation", keys: "mod+s", status: "planned", note: "Team feature" },
      { label: "Comment", keys: "m", status: "planned", note: "Team comments — M stays reserved for this" },
      { label: "Delete Comment", keys: "mod+backspace", status: "planned" },
    ],
  },
  {
    title: "Labels",
    items: [
      { label: "Move", keys: "v", commands: ["thread.move"], status: "ready" },
      { label: "Add or Remove Label", keys: "l", commands: ["thread.move"], status: "ready", note: "Opens the Move / Label picker" },
      { label: "Remove Label", keys: "y", status: "planned" },
      { label: "Remove Label, Next", keys: "[", status: "planned" },
      { label: "Remove Label, Previous", keys: "]", status: "planned" },
      { label: "Remove All Labels", keys: "shift+y", status: "planned" },
    ],
  },
  {
    title: "Messages",
    items: [
      { label: "Compose", keys: "c", commands: ["compose"], status: "ready" },
      { label: "Reply All", keys: "enter", commands: ["thread.replyAllOrOpen"], status: "ready", note: "In a conversation (A works too)" },
      { label: "Reply", keys: "r", commands: ["thread.reply"], status: "ready" },
      { label: "Forward", keys: "f", commands: ["thread.forward"], status: "ready" },
      { label: "Open Links & Attachments", keys: "mod+o", status: "planned", note: "Click to open today" },
      { label: "Cycle Through Links", keys: "tab", status: "planned", note: "Tab previews Instant Replies today" },
      { label: "Expand Message", keys: "o", status: "planned", note: "Click a collapsed message today" },
      { label: "Expand/Collapse Header", keys: "shift+h", status: "planned" },
      { label: "Expand All Messages", keys: "shift+o", status: "planned" },
      { label: "Show New Messages", keys: "shift+n", status: "planned" },
      { label: "Use Snippet", keys: "mod+;", commands: ["compose.snippet"], status: "ready", note: "In compose" },
    ],
  },
  {
    title: "Compose",
    items: [
      { label: "To", keys: "mod+shift+o", commands: ["compose.expandTo"], status: "ready" },
      { label: "Cc", keys: "mod+shift+c", commands: ["compose.expandCc"], status: "ready" },
      { label: "Bcc", keys: "mod+shift+b", commands: ["compose.expandBcc"], status: "ready" },
      { label: "From", keys: "mod+shift+f", status: "planned", note: "Send-as identities" },
      { label: "Edit Subject", keys: "mod+shift+s", commands: ["compose.expandSubject"], status: "ready" },
      { label: "Superhuman AI", keys: "mod+j", commands: ["compose.ai"], status: "ready", note: "Write with AI" },
      { label: "Attach", keys: "mod+shift+u", status: "partial", note: "Via the 📎 button in compose" },
      { label: "Discard Draft", keys: "mod+shift+,", status: "partial", note: "Via the 🗑 button in compose" },
      { label: "Instant Intro (to BCC)", keys: "mod+shift+i", commands: ["thread.introReply"], status: "ready" },
      { label: "Remind me", keys: "mod+shift+h", status: "planned", note: "Reminder-on-send" },
      { label: "Send later", keys: "mod+shift+l", commands: ["compose.sendLater"], status: "ready" },
      { label: "Use Snippet Inline", keys: ";", status: "partial", note: "Ctrl+; opens the snippet picker today" },
      { label: "Insert Emoji", keys: ":", status: "planned" },
      { label: "Send", keys: "mod+enter", commands: ["compose.send"], status: "ready" },
      { label: "Send Instantly", keys: "mod+shift+z", commands: ["send.accelerate"], status: "ready", note: "Flushes the Undo Send window" },
      { label: "Send + Mark Done", keys: "mod+shift+enter", commands: ["compose.sendDone"], status: "ready" },
    ],
  },
  {
    title: "Pop Out Compose",
    items: [
      { label: "Pop Out Compose", keys: "shift+c", status: "planned", note: "Our composer docks inline / full-view" },
      { label: "Reply All, Pop Out Draft", keys: "shift+enter", status: "planned" },
      { label: "Reply, Pop Out Draft", keys: "shift+r", status: "planned" },
      { label: "Forward, Pop Out Draft", keys: "shift+f", status: "planned" },
      { label: "Pop Out Draft", keys: "mod+shift+p", status: "planned" },
      { label: "Pop In Draft", keys: "mod+shift+p", status: "planned" },
      { label: "Pop Out Draft & Search", keys: "mod+/", status: "planned" },
      { label: "Toggle Focus", keys: "mod+d", status: "planned" },
    ],
  },
  {
    title: "Format",
    items: [
      { label: "Bold", keys: "mod+b", status: "ready", note: "In compose" },
      { label: "Italics", keys: "mod+i", status: "ready", note: "In compose" },
      { label: "Underline", keys: "mod+u", status: "ready", note: "In compose" },
      { label: "Hyperlink", keys: "mod+k", status: "ready", note: "In compose (opens the palette elsewhere)" },
      { label: "Color", keys: "mod+o", status: "partial", note: "Via the selection bubble" },
      { label: "Strikethrough", keys: "mod+shift+x", status: "ready", note: "In compose" },
      { label: "Numbers", keys: "mod+shift+7", status: "ready", note: "In compose" },
      { label: "Bullets", keys: "mod+shift+8", status: "ready", note: "In compose" },
      { label: "Quote", keys: "mod+shift+9", status: "partial", note: "Via the selection bubble (editor: Ctrl+Shift+B)" },
      { label: "Indent List", keys: "tab", status: "ready", note: "Inside a list" },
      { label: "Outdent List", keys: "shift+tab", status: "ready", note: "Inside a list" },
      { label: "Increase Indent", keys: "mod+]", status: "planned" },
      { label: "Decrease Indent", keys: "mod+[", status: "planned" },
    ],
  },
  {
    title: "Folders",
    items: [
      { label: "Go to Inbox", keys: "1|g i", commands: ["goto.inbox"], status: "ready", note: "1 = Inbox, 2 = Calendar" },
      { label: "Go to Important", keys: "g i", commands: ["goto.inbox"], status: "ready", note: "The Important split" },
      { label: "Go to Other", keys: "g o", commands: ["goto.other"], status: "ready" },
      { label: "Go to Starred", keys: "g s", commands: ["goto.starred"], status: "ready" },
      { label: "Go to Drafts", keys: "g d", commands: ["goto.drafts"], status: "ready" },
      { label: "Go to Sent", keys: "g t", status: "planned", note: "G then T opens Trash until a Sent view lands" },
      { label: "Go to Done", keys: "g e", commands: ["goto.done"], status: "ready" },
      { label: "Go to Reminders", keys: "g h", commands: ["goto.reminders"], status: "ready" },
      { label: "Go to Muted", keys: "g m", status: "planned" },
      { label: "Go to Snippets", keys: "g ;", status: "planned", note: "Snippets live in Settings → Knowledge Base" },
      { label: "Go to Spam", keys: "g !", status: "planned" },
      { label: "Go to Trash", keys: "g #", commands: ["goto.trash"], status: "ready", note: "G then T works too (for now)" },
      { label: "Go to All Mail", keys: "g a", status: "planned" },
      { label: "Go to Label …", keys: "g l", status: "planned", note: "Labels via the ☰ sidebar today" },
    ],
  },
  {
    title: "Windows",
    items: [
      { label: "New Tab", keys: "mod+t", status: "planned", note: "Tabbed windows" },
      { label: "Next Tab", keys: "mod+shift+]", status: "planned" },
      { label: "Previous Tab", keys: "mod+shift+[", status: "planned" },
      { label: "Close Tab", keys: "mod+w", status: "planned" },
      { label: "Increase Font Size", keys: "mod+=", status: "planned" },
      { label: "Decrease Font Size", keys: "mod+-", status: "planned" },
      { label: "Reset Font Size", keys: "mod+0", status: "planned" },
      { label: "Find Within Page", keys: "mod+f", status: "planned" },
      { label: "Copy Private Link", keys: "alt+/", status: "planned", note: "Team feature" },
    ],
  },
  {
    title: "Calendar",
    items: [
      { label: "Open Day", keys: "0", commands: ["calendar.toggle"], status: "ready", note: "The day panel beside the inbox" },
      { label: "Open Week", keys: "2", commands: ["calendar.open"], status: "ready", note: "G then C works too" },
      { label: "Previous Day/Week", keys: "-", commands: ["calendar.prevDay"], status: "ready", note: "While the calendar is focused (← too)" },
      { label: "Next Day/Week", keys: "=", commands: ["calendar.nextDay"], status: "ready", note: "While the calendar is focused (→ too)" },
      { label: "Share Availability", keys: "mod+shift+a", status: "planned" },
      { label: "Create Event", keys: "b", status: "planned", note: "The calendar is read-only today" },
      { label: "Create Empty Event", keys: "shift+b", status: "planned" },
    ],
  },
  {
    title: "Filters",
    items: [
      { label: "Unread", keys: "shift+u", status: "planned", note: "List filters" },
      { label: "Starred", keys: "shift+s", status: "planned" },
      { label: "Important", keys: "shift+i", status: "planned" },
      { label: "No reply", keys: "shift+r", status: "planned" },
    ],
  },
];

/** The catalog's display expr for an item, honoring live remaps: each
 *  keys-alternative is replaced by its command's current binding — preferring
 *  the alternative that matches the catalog (so parity shows Superhuman's key)
 *  and falling back to the user's first remapped key otherwise. */
export function liveKeysFor(
  item: CatalogItem,
  shortcuts: Record<string, string>
): string {
  if (!item.commands || item.commands.length === 0) return item.keys;
  const wanted = item.keys.split("|");
  return item.commands
    .map((id, i) => {
      const want = wanted[i] ?? wanted[0];
      const bound = shortcuts[id] ?? "";
      if (!bound) return want;
      const alts = bound.split("|").map((s) => s.trim());
      return alts.includes(want) ? want : alts[0];
    })
    .join("|");
}
