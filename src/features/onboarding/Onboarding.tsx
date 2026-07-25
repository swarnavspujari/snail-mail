import { useState } from "react";
import { backend, isTauri } from "@/lib/ipc";
import { SyncActivityPill } from "@/components/SyncActivityPill";
import { useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";

function BrandMark() {
  const theme = useSettings((s) => s.settings.theme);
  return (
    <img
      src={theme === "light" ? "/snail-mail-icon.svg" : "/snail-mail-icon-on-dark.svg"}
      alt=""
      aria-hidden
      className="h-9 w-auto"
      draggable={false}
    />
  );
}

const STEPS = ["welcome", "ai", "theme", "tour"] as const;

const KEYS: Array<[string, string]> = [
  ["J / K", "move through mail"],
  ["Enter", "open a conversation"],
  ["E", "done — archive and move on"],
  ["H", "remind me later (snooze)"],
  ["R / A", "reply / reply-all"],
  ["C", "compose"],
  ["Z", "undo anything — even Send"],
  ["Tab", "next split inbox"],
  ["Ctrl+K", "every command, searchable"],
  ["?", "ask AI about a thread"],
];

function Dot({ active }: { active: boolean }) {
  return (
    <span
      className={`h-1.5 rounded-full transition-all ${
        active ? "w-5 bg-accent" : "w-1.5 bg-line-strong"
      }`}
    />
  );
}

/** First-run flow: connect → AI key → theme → 30-second shortcut tour.
 *  Gated by settings.onboarded; replayable from Settings → Appearance. */
export function Onboarding() {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [aiKey, setAiKey] = useState("");
  const theme = useSettings((s) => s.settings.theme);

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const finish = () => void useSettings.getState().save({ onboarded: true });

  const connect = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await backend.startOauth("", "");
      await useSettings.getState().refreshAccounts();
      await backend.syncNow();
      await useMail.getState().refresh();
      next();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveAiKey = async () => {
    if (!aiKey.trim()) return next();
    setBusy(true);
    try {
      await useSettings.getState().setAiKey("nim", aiKey.trim());
      next();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const primaryBtn =
    "rounded-lg bg-accent px-5 py-2.5 text-[13.5px] font-medium text-on-accent hover:bg-accent-strong disabled:opacity-50";
  const ghostBtn =
    "rounded-lg border border-line-strong px-5 py-2.5 text-[13.5px] text-ink-2 hover:bg-hover";

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-base">
      <div className="zb-pop-in w-[560px] max-w-[92vw]">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <BrandMark />
          <span className="text-[22px] font-semibold tracking-tight text-ink">
            Snail Mail
          </span>
        </div>

        {STEPS[step] === "welcome" && (
          <div className="text-center">
            <h1 className="text-[26px] font-semibold leading-snug text-ink">
              The fastest way through
              <br />
              your inbox.
            </h1>
            <p className="mx-auto mt-3 max-w-[400px] text-[14px] leading-relaxed text-ink-2">
              Keyboard-first triage, split inboxes, and AI drafting — all local,
              on your machine. Connect Gmail to begin, or look around with the
              demo inbox first.
            </p>
            <div className="mt-8 flex items-center justify-center gap-3">
              {isTauri ? (
                <button className={primaryBtn} disabled={busy} onClick={connect}>
                  {busy ? "Waiting for your browser…" : "Connect Gmail"}
                </button>
              ) : (
                <span className="text-[12.5px] text-warn">
                  Connecting Gmail needs the desktop app — this is the browser demo.
                </span>
              )}
              <button className={ghostBtn} onClick={next}>
                Explore the demo first
              </button>
            </div>
            {isTauri && (
              <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
                Your browser will ask for Google consent. Because Snail Mail is a
                small beta, Google shows “unverified app” — click{" "}
                <b>Advanced</b>, then <b>Continue</b> to the app. Mail never
                leaves your computer.
              </p>
            )}
            {/* connect() awaits syncNow() — the first reconcile of the whole
                mailbox, and the single biggest download the app ever does. It
                used to run behind nothing but a static "Waiting for your
                browser…". No account prop: there is no switcher yet, so follow
                whatever pass is running. */}
            <div className="mt-5">
              <SyncActivityPill inline />
            </div>
            {msg && <p className="mt-3 text-[12.5px] text-bad">{msg}</p>}
          </div>
        )}

        {STEPS[step] === "ai" && (
          <div className="text-center">
            <h1 className="text-[22px] font-semibold text-ink">
              AI drafting <span className="text-ink-3">(optional)</span>
            </h1>
            <p className="mx-auto mt-3 max-w-[420px] text-[14px] leading-relaxed text-ink-2">
              Paste an API key to draft replies with AI (<b>Ctrl+J</b>) and get
              instant reply suggestions. NVIDIA NIM is preconfigured; Claude and
              OpenAI are one click away in Settings. Skip freely — everything
              else works without it.
            </p>
            <input
              value={aiKey}
              onChange={(e) => setAiKey(e.target.value)}
              type="password"
              placeholder="nvapi-…  (NVIDIA NIM key)"
              className="mx-auto mt-6 block w-[380px] max-w-full rounded-lg border border-line-strong bg-raised px-4 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
            />
            <div className="mt-6 flex items-center justify-center gap-3">
              <button className={primaryBtn} disabled={busy} onClick={() => void saveAiKey()}>
                {aiKey.trim() ? "Save key & continue" : "Skip for now"}
              </button>
            </div>
            {msg && <p className="mt-3 text-[12.5px] text-bad">{msg}</p>}
          </div>
        )}

        {STEPS[step] === "theme" && (
          <div className="text-center">
            <h1 className="text-[22px] font-semibold text-ink">Pick your light</h1>
            <div className="mt-6 flex justify-center gap-4">
              {(
                [
                  ["dark", "#0e1014", "#8496ff", "Dark"],
                  ["light", "#f4f5f8", "#4655c4", "Light"],
                ] as const
              ).map(([t, bg, accent, label]) => (
                <button
                  key={t}
                  onClick={() => void useSettings.getState().save({ theme: t })}
                  className={`w-40 overflow-hidden rounded-xl border-2 text-left transition-colors ${
                    theme === t ? "border-accent" : "border-line hover:border-line-strong"
                  }`}
                >
                  <div className="h-20 p-3" style={{ background: bg }}>
                    <div
                      className="h-2 w-16 rounded-full"
                      style={{ background: accent }}
                    />
                    <div
                      className="mt-2 h-1.5 w-24 rounded-full opacity-40"
                      style={{ background: accent }}
                    />
                  </div>
                  <div className="bg-surface px-3 py-2 text-[13px] text-ink">{label}</div>
                </button>
              ))}
            </div>
            <button className={`${primaryBtn} mt-7`} onClick={next}>
              Continue
            </button>
          </div>
        )}

        {STEPS[step] === "tour" && (
          <div className="text-center">
            <h1 className="text-[22px] font-semibold text-ink">
              Ten keys run everything
            </h1>
            <div className="mx-auto mt-6 grid max-w-[440px] grid-cols-2 gap-x-8 gap-y-2.5 text-left">
              {KEYS.map(([k, what]) => (
                <div key={k} className="flex items-center gap-3">
                  <span className="kbd shrink-0">{k}</span>
                  <span className="text-[12.5px] text-ink-2">{what}</span>
                </div>
              ))}
            </div>
            <p className="mt-5 text-[12.5px] text-ink-3">
              Forget everything else — <span className="kbd">Ctrl+K</span> finds
              any command by name.
            </p>
            <button className={`${primaryBtn} mt-6`} onClick={finish}>
              Start using Snail Mail
            </button>
          </div>
        )}

        <div className="mt-10 flex items-center justify-center gap-1.5">
          {STEPS.map((s, i) => (
            <Dot key={s} active={i === step} />
          ))}
        </div>
      </div>
    </div>
  );
}
