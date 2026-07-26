// Send + autosave + attachment plumbing shared by both composer shells: the
// new-message modal (Compose.tsx) and the inline reply dock (ReplyDock.tsx).
// Exactly one shell is mounted at a time (ui.compose is singular; the modal is
// gated to mode "new", the dock to reply/forward), so this hook — and its lone
// `fission:send` listener — runs once. Extracting it keeps the two shells
// purely presentational and the send path in one place.
import { useEffect, useRef, useState } from "react";
import { backend } from "@/lib/ipc";
import { pushTriageUndo } from "@/lib/commands";
import { pushUndo } from "@/lib/undo";
import { sanitizeUserHtml } from "@/lib/sanitize";
import { useMail } from "@/stores/mail";
import { activeCapabilities, useSettings } from "@/stores/settings";
import {
  composeHasContent,
  driveChipHtml,
  driveChipsInHtml,
  outgoingFromCompose,
  useUi,
  type ComposeState,
} from "@/stores/ui";
import type { DriveShareMode, MailAttachment, OutgoingMail } from "@/lib/types";

const MAX_ATTACH_TOTAL = 25_000_000; // Gmail's raw-message ceiling

function splitAddresses(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Plain-text of the user's message, for the optimistic row's snippet fallback
 *  (the card renders the HTML; this is only used when there's no HTML). */
function plainMessageText(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent?.trim() ?? "";
}

function readFileB64(file: File): Promise<MailAttachment> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.onload = () => {
      const url = String(r.result); // data:<mime>;base64,<data>
      resolve({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        dataBase64: url.slice(url.indexOf(",") + 1),
      });
    };
    r.readAsDataURL(file);
  });
}

// ---- oversized attachments → Drive links -----------------------------------
// The File objects behind the "upload to Drive?" confirm and the resolver
// behind the share-on-send dialog live here (module scope): the ui store only
// carries what the modals render. One compose is ever open, so one slot each.

let oversizedQueue: File[] = [];
let shareResolver: ((mode: DriveShareMode | "cancel") => void) | null = null;
let driveUploadSeq = 1;

/** Upload one oversized file to Drive with a live pending chip; on success
 *  insert the link chip at the caret and record it for share-on-send. */
function startDriveUpload(file: File) {
  const id = driveUploadSeq++;
  // Bind the upload to THIS compose session: if the composer closes (or a
  // different one opens) before the upload finishes, the chip must not land
  // in an unrelated email — the file just stays in the Drive folder.
  const originSeq = useUi.getState().composeSeq;
  useUi.setState((s) => ({
    driveUploads: [
      ...s.driveUploads,
      { id, name: file.name, sent: 0, total: file.size || 1 },
    ],
  }));
  backend
    .driveUploadFile(file, (sent, total) => {
      useUi.setState((s) => ({
        driveUploads: s.driveUploads.map((u) =>
          u.id === id ? { ...u, sent, total } : u
        ),
      }));
    })
    .then((f) => {
      useUi.setState((s) => ({
        driveUploads: s.driveUploads.filter((u) => u.id !== id),
      }));
      const ui = useUi.getState();
      if (!ui.compose || ui.composeSeq !== originSeq) return;
      const ref = { fileId: f.id, name: f.name, url: f.webViewLink, size: f.size };
      useUi.setState((s) => ({
        compose: s.compose
          ? { ...s.compose, driveLinks: [...s.compose.driveLinks, ref] }
          : null,
      }));
      // focus:false — this fires at an arbitrary time; don't yank the caret
      // out of whatever field the user is typing in.
      window.dispatchEvent(
        new CustomEvent("fission:insert-html", {
          detail: { html: driveChipHtml(ref), focus: false },
        })
      );
    })
    .catch((e) => {
      useUi.setState((s) => ({
        driveUploads: s.driveUploads.filter((u) => u.id !== id),
      }));
      useUi.getState().showToast(`Drive upload failed: ${String(e)}`);
    });
}

/** Confirm-modal actions (DriveUploadPrompt in ComposeShell). */
export function confirmDriveUpload(remember: boolean) {
  if (remember) void useSettings.getState().save({ driveAutoUpload: "always" });
  const files = oversizedQueue;
  oversizedQueue = [];
  useUi.setState({ drivePrompt: null });
  for (const f of files) startDriveUpload(f);
}

export function cancelDriveUpload() {
  oversizedQueue = [];
  useUi.setState({ drivePrompt: null });
}

/** Share-dialog actions (SharePrompt in ComposeShell). */
export function chooseShareMode(mode: DriveShareMode | "cancel") {
  useUi.setState({ sharePrompt: null });
  shareResolver?.(mode);
  shareResolver = null;
}

/** Ask the user how to share the linked files; resolves with the choice. */
function promptShareMode(count: number): Promise<DriveShareMode | "cancel"> {
  return new Promise((resolve) => {
    shareResolver = resolve;
    useUi.setState({ sharePrompt: { count } });
  });
}

/** The bare addr-spec of a recipient token — Drive's permissions API takes
 *  addresses only, but recipients arrive as "Name <email>" from autocomplete. */
function addrSpec(token: string): string {
  const m = token.match(/<([^>]+)>/);
  return (m ? m[1] : token).trim();
}

/** Share-on-send, shared by Send and Send Later: chips still present in the
 *  body (the user may have deleted some) get a share dialog before the mail
 *  moves. Per-file failures warn but never block the send — Gmail behaves
 *  the same way. Returns false when the user cancels (= cancel the send). */
export async function shareDriveLinks(
  c: ComposeState,
  outgoing: OutgoingMail
): Promise<boolean> {
  const chipsInBody = driveChipsInHtml(outgoing.bodyHtml ?? "");
  const toShare = c.driveLinks.filter((l) => chipsInBody.has(l.fileId));
  if (toShare.length === 0) return true;
  const mode = await promptShareMode(toShare.length);
  if (mode === "cancel") return false;
  if (mode !== useSettings.getState().settings.driveShareMode) {
    void useSettings.getState().save({ driveShareMode: mode });
  }
  if (mode !== "none") {
    const recipients = [...outgoing.to, ...outgoing.cc, ...outgoing.bcc]
      .map(addrSpec)
      .filter((a) => a.includes("@"));
    const failed: string[] = [];
    for (const link of toShare) {
      try {
        failed.push(...(await backend.driveShare(link.fileId, mode, recipients)));
      } catch (e) {
        useUi.getState().showToast(`Couldn't share "${link.name}": ${String(e)}`);
      }
    }
    if (failed.length > 0) {
      useUi.getState().showToast(`Couldn't share with: ${[...new Set(failed)].join(", ")}`);
    }
  }
  return true;
}

/** True when nothing Drive-related blocks a send right now (an upload mid-
 *  flight or an unanswered oversized prompt). Shared with Send Later. */
export function driveSendBlocker(): string | null {
  const ui = useUi.getState();
  if (ui.driveUploads.length > 0)
    return "A Drive upload is still in progress — it becomes a link when it finishes.";
  if (ui.drivePrompt) return "Decide what to do with the oversized attachments first.";
  return null;
}

export function useComposeController() {
  const compose = useUi((s) => s.compose);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Autosave the draft while typing, so a crash or close loses nothing.
  useEffect(() => {
    const t = setTimeout(() => {
      const c = useUi.getState().compose;
      if (!c) return;
      if (!composeHasContent(c)) return;
      // draftId/draftAccount name the row — they're never part of its contents
      const { draftId, draftAccount, ...payload } = c;
      void backend
        .saveDraft(draftId, draftAccount, JSON.stringify(payload))
        .then((ref) => {
          const cur = useUi.getState().compose;
          if (cur && (cur.draftId !== ref.id || cur.draftAccount !== ref.account)) {
            useUi.setState((s) => ({
              compose: s.compose
                ? { ...s.compose, draftId: ref.id, draftAccount: ref.account }
                : null,
            }));
          }
        })
        .catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [
    compose?.to,
    compose?.cc,
    compose?.bcc,
    compose?.subject,
    compose?.body,
    compose?.quote,
    compose?.attachments,
  ]);

  useEffect(() => {
    const send = async (markDone: boolean) => {
      const c = useUi.getState().compose;
      if (!c || sending) return;
      const to = splitAddresses(c.to);
      if (to.length === 0) {
        setError("Add at least one recipient.");
        return;
      }
      // The Undo Send window (seconds) is a user setting: 0 = off (leave now),
      // else the fuse the message waits out before it actually sends.
      const undoMs =
        Math.max(0, useSettings.getState().settings.undoSendSeconds ?? 10) * 1000;
      const blocker = driveSendBlocker();
      if (blocker) {
        setError(blocker);
        return;
      }
      setSending(true);
      setError(null);
      // The optimistic reply row (if any) so error/undo paths can retract it.
      let pendingLocalId: string | null = null;
      let flipTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outgoing = outgoingFromCompose(c);
        if (!(await shareDriveLinks(c, outgoing))) {
          setSending(false);
          return; // user cancelled the share dialog = cancelled the send
        }

        // Optimistic reply: append the message to the OPEN thread now, so it
        // shows at the bottom instantly (Superhuman-style). Scoped to a
        // reply/forward into the thread being read (the inline dock path) — the
        // new-message modal and list-only replies never dock here. Reconciled
        // away against the real message on the next getThread / mail:updated.
        const optimistic =
          !!c.threadId &&
          c.mode !== "new" &&
          useMail.getState().openThreadId === c.threadId;
        const appendPending = (
          status: "sending" | "sent",
          sentAt: number | null,
          outboxId: number | null,
          outboxAccount: string | null
        ) =>
          useMail.getState().addPendingMessage({
            threadId: c.threadId!,
            from: useSettings.getState().accounts.active ?? "",
            fromName: "You",
            to,
            cc: splitAddresses(c.cc),
            subject: c.subject || "(no subject)",
            bodyHtml: sanitizeUserHtml(c.body).trim() || null,
            bodyText: plainMessageText(c.body),
            status,
            sentAt,
            outboxId,
            outboxAccount,
            baselineCount: useMail.getState().openMessages.length,
          });

        // "Send & mark done": archive the thread + register its own triage undo.
        // Returns whether it ran, so the notification can say "& marked done".
        const runMarkDone = async () => {
          if (!(markDone && c.threadId)) return false;
          if (useMail.getState().openThreadId === c.threadId)
            useMail.getState().closeThread();
          const tid = c.threadId;
          await useMail.getState().archive(tid);
          pushTriageUndo("Mark Done", () => useMail.getState().moveToInbox(tid));
          await useUi.getState().checkInboxZero();
          return true;
        };

        if (undoMs === 0) {
          // Undo Send off: deliver immediately, no window, nothing to undo.
          if (c.draftId !== null && c.draftAccount !== null)
            void backend.deleteDraft(c.draftId, c.draftAccount).catch(() => {});
          useUi.getState().closeCompose();
          if (optimistic) pendingLocalId = appendPending("sending", null, null, null);
          await backend.sendMailNow(outgoing);
          if (pendingLocalId)
            useMail.getState().markPendingSent(pendingLocalId, Date.now());
          const done = await runMarkDone();
          useUi.getState().showToast(done ? "Sent & marked done" : "Sent");
        } else {
          // Queue with the fuse — that delay IS the Undo Send window (Z pulls
          // the draft back; the UndoSendBar shows the countdown + Send now).
          const queued = await backend.queueMail(outgoing, undoMs);
          if (c.draftId !== null && c.draftAccount !== null)
            void backend.deleteDraft(c.draftId, c.draftAccount).catch(() => {});
          const saved = { ...c, draftId: null, draftAccount: null };
          useUi.getState().closeCompose();
          if (optimistic) {
            pendingLocalId = appendPending("sending", null, queued.id, queued.account);
            const id = pendingLocalId;
            // Flip "Sending…" → sent with a real timestamp when the window ends
            // (the flush's mail:updated then reconciles it against the real row).
            flipTimer = setTimeout(
              () => useMail.getState().markPendingSent(id, Date.now()),
              undoMs
            );
          }
          const localId = pendingLocalId;
          const timer = flipTimer;
          pushUndo({
            // Match the bar + the actual send time exactly — a shorter buffer
            // left a dead second where Z skipped this entry and undid an older
            // action while the mail still went out. cancelOutbox's catch handles
            // the rare race where the flush already fired.
            label: "Send",
            expiresAt: Date.now() + undoMs,
            run: async () => {
              try {
                await backend.cancelOutbox(queued.id, queued.account);
                // Retract the optimistic row; the draft comes back below.
                if (localId) {
                  clearTimeout(timer);
                  useMail.getState().removePendingMessage(localId);
                }
                useUi.getState().startCompose(saved);
                useUi.getState().showToast("Send undone — draft restored");
              } catch {
                // Already flushed — leave the row; reconcile swaps in the real one.
                useUi.getState().showToast("Too late — already sent");
              }
              useUi.getState().clearPendingSend();
            },
          });
          const done = await runMarkDone();
          useUi.getState().setPendingSend({
            outboxId: queued.id,
            outboxAccount: queued.account,
            expiresAt: Date.now() + undoMs,
            label: done ? "Sent & marked done" : "Sent",
          });
        }
        await useMail.getState().refresh();
      } catch (e) {
        // Send failed before it left — retract the optimistic row.
        if (pendingLocalId) {
          clearTimeout(flipTimer);
          useMail.getState().removePendingMessage(pendingLocalId);
        }
        setError(String(e));
      } finally {
        setSending(false);
      }
    };
    const handler = (e: Event) =>
      void send(Boolean((e as CustomEvent).detail?.markDone));
    window.addEventListener("fission:send", handler);
    return () => window.removeEventListener("fission:send", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sending]);

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const current = useUi.getState().compose;
    if (!current) return;
    const existing = current.attachments.reduce(
      (n, a) => n + a.dataBase64.length * 0.75,
      0
    );
    let total = existing;
    const added: MailAttachment[] = [];
    const oversized: File[] = [];
    for (const f of Array.from(files)) {
      // Files that don't fit under Gmail's inline ceiling go to Drive and
      // send as a link chip instead of erroring (the Gmail behavior).
      if (total + f.size > MAX_ATTACH_TOTAL) {
        oversized.push(f);
        continue;
      }
      total += f.size;
      added.push(await readFileB64(f));
    }
    if (added.length) {
      useUi.setState((s) => ({
        compose: s.compose
          ? { ...s.compose, attachments: [...s.compose.attachments, ...added] }
          : null,
      }));
    }
    if (oversized.length) {
      if (!activeCapabilities().drive) {
        setError(
          "Attachments exceed the 25 MB limit. Reconnect Gmail with Drive access (Settings → Account) to send big files as Drive links."
        );
        return;
      }
      if (useSettings.getState().settings.driveAutoUpload === "always") {
        for (const f of oversized) startDriveUpload(f);
      } else {
        oversizedQueue = oversized;
        useUi.setState({ drivePrompt: { names: oversized.map((f) => f.name) } });
      }
    }
  };

  return { sending, error, setError, fileRef, addFiles };
}
