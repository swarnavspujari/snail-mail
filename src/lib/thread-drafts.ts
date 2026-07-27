// Reading saved drafts back OUT of storage and onto the surfaces they belong
// to: the conversation they were written in, and that conversation's row.
//
// A draft is stored as an opaque JSON blob (the compose state, minus its own
// row identity) — see stores/ui flushComposeDraft. Nothing read it back except
// the Drafts picker, so writing a reply and backing out left the thread looking
// exactly as if you had never written anything. The draft was safe; it was just
// invisible everywhere you would look for it.
//
// Everything here is defensive about the payload: these rows outlive schema
// changes (recipients were once a comma-separated string), and a draft the user
// spent real effort on must never be lost to a parse error — worst case it
// still shows, with whatever fields survived.
import { displayLabel, normalizeRecipients } from "./recipients";
import type { DraftEntry, ThreadId } from "./types";

export interface ThreadDraft {
  /** Row identity — id alone doesn't name a draft (ids are per-account). */
  id: number;
  account: string;
  updatedAt: number;
  threadId: ThreadId | null;
  to: string[];
  subject: string;
  /** First line or so of the body, as plain text. */
  preview: string;
  /** The payload as stored, for handing straight back to startCompose. */
  payload: Record<string, unknown> | null;
}

/** Body HTML (or text) down to a single plain line. */
export function draftPreview(body: unknown): string {
  if (typeof body !== "string") return "";
  return body
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6])>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** One stored row, projected into something renderable. Never throws. */
export function parseDraft(entry: DraftEntry): ThreadDraft {
  let payload: Record<string, unknown> | null = null;
  try {
    const p: unknown = JSON.parse(entry.payload);
    if (p && typeof p === "object") payload = p as Record<string, unknown>;
  } catch {
    // Corrupt row — still listed (with no recipients or preview) rather than
    // dropped, so it stays discoverable and discardable.
  }
  const threadId = payload?.threadId;
  return {
    id: entry.id,
    account: entry.account,
    updatedAt: entry.updatedAt,
    threadId: typeof threadId === "string" ? threadId : null,
    to: normalizeRecipients(payload?.to),
    subject: typeof payload?.subject === "string" ? payload.subject : "",
    preview: draftPreview(payload?.body),
    payload,
  };
}

/** The drafts written on one conversation, newest last (they read as the
 *  continuation of the thread, so they sort like messages do). */
export function draftsForThread(
  drafts: DraftEntry[],
  threadId: ThreadId
): ThreadDraft[] {
  return drafts
    .map(parseDraft)
    .filter((d) => d.threadId === threadId)
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

/** Thread id → its most recently touched draft, for the list-row marker. A
 *  row has space for one, and the newest is the one you were last writing. */
export function draftsByThread(drafts: DraftEntry[]): Map<ThreadId, ThreadDraft> {
  const out = new Map<ThreadId, ThreadDraft>();
  for (const entry of drafts) {
    const d = parseDraft(entry);
    if (!d.threadId) continue;
    const seen = out.get(d.threadId);
    if (!seen || d.updatedAt > seen.updatedAt) out.set(d.threadId, d);
  }
  return out;
}

/** "Steven Zhang" / "Steven Zhang, Ana" / "" — the row's `to` line. */
export function draftRecipientLabel(to: string[]): string {
  const names = to.map(displayLabel).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}
