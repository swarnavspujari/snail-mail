// Right-hand identity rail for the open thread (design system
// mail/ContactPanel): who you're talking to, plus recent mail history.
import { useEffect, useState } from "react";
import { backend, openExternal } from "@/lib/ipc";
import { useMail } from "@/stores/mail";
import type { SearchResult, ThreadId } from "@/lib/types";
import { Avatar } from "@/components/Avatar";

const FREEMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "fission.local",
]);

// Session cache of each contact's raw mail history so reopening a thread
// paints the panel instantly; the fetch revalidates behind it.
const historyCache = new Map<string, SearchResult[]>();

export function ContactPanel({
  name,
  email,
  currentThreadId,
}: {
  name: string;
  email: string;
  currentThreadId: ThreadId;
}) {
  const [rawHistory, setRawHistory] = useState<SearchResult[]>(
    () => historyCache.get(email) ?? []
  );

  useEffect(() => {
    let stale = false;
    setRawHistory(historyCache.get(email) ?? []);
    // Address-scoped history: threads this contact was actually a participant
    // in (from/to/cc), not a full-text match on their name — so unrelated mail
    // that merely mentions the word never leaks in.
    backend
      .threadsWithContact(email)
      .then((r) => {
        historyCache.set(email, r);
        if (!stale) setRawHistory(r);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [email]);

  // Drop the open thread at render time (the cache keeps the raw list).
  const history = rawHistory
    .filter((x) => x.threadId !== currentThreadId)
    .slice(0, 5);

  const domain = email.split("@")[1] ?? "";
  const website = domain && !FREEMAIL.has(domain.toLowerCase()) ? domain : null;

  return (
    <aside className="flex w-56 shrink-0 flex-col gap-3.5 overflow-y-auto border-l border-line bg-surface px-[22px] py-[18px] xl:w-64 2xl:w-[280px]">
      <Avatar name={name} email={email} size={44} />
      <div>
        <div className="text-[21px] font-semibold tracking-tight text-ink">
          {name}
        </div>
        <div className="mt-1 text-[13px] text-ink-2">{email}</div>
      </div>
      {history.length > 0 && (
        <div className="mt-1">
          <div className="mb-2.5 flex items-center gap-2 text-[13px] font-medium text-ink">
            <span aria-hidden className="opacity-55">
              ✉
            </span>
            Mail
          </div>
          <div className="flex flex-col gap-2">
            {history.map((h) => (
              <button
                key={h.threadId}
                onClick={() => void useMail.getState().openThread(h.threadId)}
                className="truncate text-left text-[13px] text-ink-2 hover:text-ink"
                title={h.subject}
              >
                {h.subject}
              </button>
            ))}
          </div>
        </div>
      )}
      {website && (
        <div className="mt-1 flex items-center gap-2 text-[13px] text-ink-2">
          <span aria-hidden className="opacity-55">
            🔗
          </span>
          {/* The domain is derived from the sender's address, so it is only ever
              a guess at "their website" — but it was rendered as dead text
              beside a link glyph, which promises a link and delivers nothing.
              Opens in the system browser, never in-app: this is untrusted
              content derived from mail. */}
          <button
            className="truncate text-left text-accent-strong hover:underline"
            title={`Open https://${website}`}
            onClick={() => void openExternal(`https://${website}`)}
          >
            {website}
          </button>
        </div>
      )}
    </aside>
  );
}
