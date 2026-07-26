// Optimistic reply messages: a reply the user just sent shows at the bottom of
// the open thread instantly (Superhuman-style), before the backend confirms it.
// This is front-end-only state living beside useMail.openMessages — no new IPC
// surface. The lifecycle: "sending" (waiting out the Undo Send window) →
// "sent" (window elapsed / immediate send, real timestamp) → reconciled away
// once getThread / mail:updated brings the real message back.
import type { ThreadId } from "./types";

export interface PendingMessage {
  /** Client id ("pending-N"); the real message keeps the server id. */
  localId: string;
  threadId: ThreadId;
  from: string;
  fromName: string;
  to: string[];
  cc: string[];
  subject: string;
  /** The user's message (rich HTML), sanitized; no appended quote trail. */
  bodyHtml: string | null;
  bodyText: string;
  createdAt: number;
  /** "sending" during the Undo Send window; "sent" once it has left. */
  status: "sending" | "sent";
  /** Epoch ms the message actually left; null while still "sending". */
  sentAt: number | null;
  /** Outbox row backing a queued send (undo cancels it); null for an
   *  immediate send (Undo Send off). */
  outboxId: number | null;
  /** The account owning `outboxId` (null whenever outboxId is). */
  outboxAccount: string | null;
  /** openMessages length when the send fired — the reconcile baseline. */
  baselineCount: number;
}

/**
 * Drop the optimistic rows whose real message has landed in the server list,
 * leaving no duplicate. A send never grows openMessages itself (pendings live
 * apart), so any excess of `serverCount` over the baseline captured at send
 * time is delivered replies catching up: retire that many pendings, oldest
 * first. During the Undo Send window the mock hasn't delivered yet, so
 * serverCount == baseline and every pending survives.
 *
 * Pure + side-effect-free so it's unit-testable; pendings for other threads
 * pass through untouched.
 */
export function reconcilePendingMessages(
  pendings: PendingMessage[],
  threadId: ThreadId,
  serverCount: number
): PendingMessage[] {
  const here = pendings
    .filter((p) => p.threadId === threadId)
    .sort((a, b) => a.createdAt - b.createdAt);
  if (here.length === 0) return pendings;
  const landed = Math.max(0, serverCount - here[0].baselineCount);
  if (landed === 0) return pendings;
  const drop = new Set(here.slice(0, landed).map((p) => p.localId));
  return pendings.filter((p) => !drop.has(p.localId));
}
