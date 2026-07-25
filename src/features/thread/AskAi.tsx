import { useEffect, useRef, useState } from "react";
import { backend } from "@/lib/ipc";
import { useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Kbd } from "@/components/Kbd";

/** "?" — ask a question about the open thread; answer streams in. */
export function AskAi() {
  const threadId = useMail((s) => s.openThreadId);
  const keyHints = useSettings((s) => s.settings.showKeyHints);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => cancelRef.current?.();
  }, []);

  const ask = () => {
    if (!question.trim() || running) return;
    setAnswer("");
    setError(null);
    setRunning(true);
    cancelRef.current = backend.aiDraft(
      {
        threadId,
        instruction: `Answer this question about the email thread (do not write a reply, just answer): ${question}`,
        existingText: null,
        providerId: null,
      },
      {
        onChunk: (c) => setAnswer((a) => a + c),
        onDone: () => setRunning(false),
        onError: (e) => {
          setError(e);
          setRunning(false);
        },
      }
    );
  };

  return (
    <div
      className="zb-fade-in absolute inset-0 z-30 flex items-start justify-center bg-black/50 pt-24"
      onClick={() => useUi.getState().setAskAiOpen(false)}
    >
      <div
        className="zb-pop-in w-[620px] max-w-[90vw] rounded-xl border border-line-strong bg-overlay shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <span className="text-[13px] font-medium text-ink">Ask AI</span>
          <span className="text-[11px] text-ink-3">
            grounded in this thread + attachments
          </span>
          <div className="flex-1" />
          {keyHints && <Kbd>Esc</Kbd>}
        </div>
        <div className="p-4">
          <input
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") ask();
              if (e.key === "Escape") useUi.getState().setAskAiOpen(false);
            }}
            placeholder="e.g. What are they asking me to confirm, and by when?"
            className="w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent"
          />
          {(answer || running || error) && (
            <div className="mt-3 max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-surface px-3 py-2 text-[13px] leading-relaxed text-ink">
              {answer}
              {running && <span className="animate-pulse text-accent">▍</span>}
              {error && <span className="text-bad">{error}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
