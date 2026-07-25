import { useEffect, useState } from "react";
import { Button } from "@/components/Button";
import { Pill } from "@/components/Pill";
import { RowGroup, SettingRow, WideRow } from "@/components/SettingRow";
import { backend, isTauri } from "@/lib/ipc";
import { clearMailCaches, useMail } from "@/stores/mail";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useReceipt } from "../receipt";
import type { AiProviderId, PurgeReport } from "@/lib/types";

const inputCls =
  "w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";

const KEY_PLACEHOLDER: Record<AiProviderId, string> = {
  claude: "sk-ant-…",
  openai: "sk-…",
  nim: "nvapi-…",
};

export function PrivacyPane() {
  return (
    <>
      <CredentialsSection />
      <MachineSection />
      <p className="max-w-[70ch] rounded-lg border border-line border-l-2 border-l-accent bg-surface px-3.5 py-3 text-[12px] leading-relaxed text-ink-2">
        Mail never leaves your computer. No analytics, no crash uploads, no account
        on our side — the only outbound calls are to Google and to the AI provider
        you picked.
      </p>
    </>
  );
}

function CredentialsSection() {
  const providers = useSettings((s) => s.settings.providers);
  return (
    <RowGroup
      title="Keys & credentials"
      colLabel="Status"
      hint="Previously spread across three tabs. All of these live in the Windows Credential Manager — never on disk, never in logs, never in the repo."
    >
      <GoogleClientRow />
      {providers.map((p) => (
        <SecretRow
          key={p.id}
          label={`${p.label} key`}
          help={KEY_PLACEHOLDER[p.id]}
          stored={p.hasKey}
          placeholder={KEY_PLACEHOLDER[p.id]}
          onSave={(v) => useSettings.getState().setAiKey(p.id, v)}
          savedNote={`${p.label} key`}
        />
      ))}
      <SecretRow
        label="Unsplash access key"
        help="Falls back to the key that ships with the app."
        stored={false}
        storedLabel="built-in"
        placeholder="Your own access key"
        onSave={(v) => backend.setUnsplashKey(v)}
        savedNote="Unsplash key"
      />
    </RowGroup>
  );
}

/** The Google OAuth client is shared by every Gmail account. Replacing it means
 *  re-consenting, so the row says so instead of pretending it's a plain field. */
function GoogleClientRow() {
  const [stored, setStored] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void backend
      .hasGmailClient()
      .then(setStored)
      .catch(() => setStored(false));
  }, []);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await backend.startOauth(id.trim(), secret.trim());
      await useSettings.getState().refreshAccounts();
      setStored(true);
      setId("");
      setSecret("");
      setOpen(false);
      useReceipt.getState().note("Google OAuth client replaced");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingRow
        label="Google OAuth client"
        help="Shared by every Gmail account · Desktop app type · docs/SETUP.md"
      >
        <Pill tone={stored ? "success" : "neutral"}>
          {stored === null ? "checking…" : stored ? "stored" : "not set"}
        </Pill>
        <Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>
          {open ? "Cancel" : stored ? "Replace" : "Add client"}
        </Button>
      </SettingRow>
      {open && (
        <WideRow>
          <div className="space-y-2">
            <p className="text-[12px] text-ink-3">
              Replacing the client sends you through Google's consent screen again —
              your mail cache and signatures stay exactly as they are.
            </p>
            <input
              className={inputCls}
              placeholder="Client ID (…apps.googleusercontent.com)"
              value={id}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => setId(e.target.value)}
            />
            <input
              className={inputCls}
              type="password"
              placeholder="Client secret"
              value={secret}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => setSecret(e.target.value)}
            />
            <div className="flex items-center gap-3">
              <Button
                variant="primary"
                size="sm"
                disabled={busy || !isTauri || !id.trim() || !secret.trim()}
                onClick={() => void submit()}
              >
                {busy ? "Waiting for consent…" : "Save and reconnect"}
              </Button>
              {!isTauri && (
                <span className="text-[12px] text-warn">
                  OAuth needs the desktop app — this is the browser demo.
                </span>
              )}
              {msg && <span className="text-[12px] text-ink-2">{msg}</span>}
            </div>
          </div>
        </WideRow>
      )}
    </>
  );
}

/** A write-only credential: type it, it goes to the OS keychain, it never comes
 *  back. The row shows whether one is stored, never the value. */
function SecretRow({
  label,
  help,
  stored,
  storedLabel,
  placeholder,
  onSave,
  savedNote,
}: {
  label: string;
  help: string;
  stored: boolean;
  storedLabel?: string;
  placeholder: string;
  onSave: (value: string) => Promise<void>;
  savedNote: string;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const save = () => {
    void onSave(value)
      .then(() => {
        setMsg(
          value.trim()
            ? "Saved to the Windows Credential Manager."
            : "Cleared — the app falls back to its default."
        );
        useReceipt
          .getState()
          .note(`${savedNote} ${value.trim() ? "replaced" : "cleared"}`);
        setValue("");
        setOpen(false);
      })
      .catch((e) => setMsg(String(e)));
  };

  return (
    <>
      <SettingRow label={label} help={msg ?? help}>
        <Pill tone={stored ? "success" : "neutral"}>
          {stored ? "stored" : (storedLabel ?? "not set")}
        </Pill>
        <Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>
          {open ? "Cancel" : stored ? "Replace" : "Add key"}
        </Button>
      </SettingRow>
      {open && (
        <WideRow>
          <div className="flex gap-2">
            <input
              className={inputCls}
              type="password"
              autoFocus
              placeholder={placeholder}
              value={value}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") save();
              }}
              onChange={(e) => setValue(e.target.value)}
            />
            <Button variant="primary" size="sm" onClick={save}>
              Save
            </Button>
          </div>
          <p className="mt-1.5 text-[11.5px] text-ink-3">
            Leave it empty and save to clear the stored key.
          </p>
        </WideRow>
      )}
    </>
  );
}

function MachineSection() {
  const accounts = useSettings((s) => s.accounts.accounts);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  return (
    <RowGroup title="On this machine">
      <SettingRow
        label="Local mail cache"
        help={`%APPDATA%\\com.snail.mail · one SQLite database per account · ${accounts.length} ${
          accounts.length === 1 ? "account" : "accounts"
        }`}
        tag={<Pill tone="neutral">read-only</Pill>}
      />
      <SettingRow
        label="Resync from scratch"
        help="Drops the local copy of this account's mail and downloads it again, rebuilding the search and vector indexes. Your mail stays on Gmail."
      >
        <Button
          variant="danger"
          size="sm"
          disabled={busy || !isTauri}
          onClick={() => {
            setBusy(true);
            void backend
              .resyncAccount()
              .then(() => {
                useUi.getState().showToast("Resync started — mail is downloading again");
                useReceipt.getState().note("Resync started");
              })
              .catch((e) => useUi.getState().showToast(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "Starting…" : "Resync"}
        </Button>
      </SettingRow>
      <SettingRow
        label="Copy diagnostics"
        help={
          copied ??
          "Version, OS, account and sync state — no mail contents, no addresses' worth of data."
        }
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void collectDiagnostics().then(async (text) => {
              try {
                await navigator.clipboard.writeText(text);
                setCopied("Copied to the clipboard.");
              } catch {
                setCopied("Clipboard blocked — the report is in the console.");
                console.info(text);
              }
            });
          }}
        >
          Copy
        </Button>
      </SettingRow>
      <EraseAllRow />
    </RowGroup>
  );
}

/** The nuclear option, and the only thing in the app that can empty the OS
 *  keychain.
 *
 *  Uninstalling does NOT remove your Google refresh token, OAuth client secret
 *  or AI keys — Windows Credential Manager is out of an NSIS uninstaller's
 *  reach, so those entries have always survived "full uninstall". The
 *  uninstaller now shells out to the app for exactly this routine, and this row
 *  exposes the same thing to someone who just wants the machine clean.
 *
 *  Three steps to fire it (arm → type ERASE → confirm), because it is
 *  irreversible and there is no undo receipt for a deleted credential. The
 *  result is shown as a literal list of what went, not a "done!" — for a
 *  security action the receipt IS the feature. */
function EraseAllRow() {
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<PurgeReport | null>(null);

  const reset = () => {
    setArmed(false);
    setTyped("");
  };

  const erase = () => {
    setBusy(true);
    setReport(null);
    void backend
      .eraseAllLocalData()
      .then(async (r) => {
        setReport(r);
        reset();
        clearMailCaches();
        await useSettings.getState().refreshAccounts();
        await useMail.getState().refresh();
        useReceipt.getState().note("All local data erased");
      })
      .catch((e) => useUi.getState().showToast(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <SettingRow
        label="Erase all local data"
        tone="danger"
        help="Deletes every account's local mail, the search model, cached attachments — and every saved credential in the Windows Credential Manager, which uninstalling leaves behind. Your mail stays in Gmail."
      >
        <Button variant="danger" size="sm" disabled={busy} onClick={() => (armed ? reset() : setArmed(true))}>
          {armed ? "Cancel" : "Erase everything"}
        </Button>
      </SettingRow>

      {armed && (
        <WideRow>
          <div className="space-y-2.5 rounded-md border border-warn/40 bg-warn/10 px-3 py-2.5">
            <p className="text-[12px] leading-relaxed text-ink-2">
              This revokes every Google grant, deletes the saved tokens and API keys
              from the Windows Credential Manager, and removes all locally synced
              mail. It cannot be undone, and the app will be back at the connect
              screen. Type <span className="font-semibold text-ink">ERASE</span> to
              confirm.
            </p>
            <div className="flex items-center gap-2">
              <input
                className={inputCls}
                autoFocus
                placeholder="ERASE"
                value={typed}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && typed === "ERASE") erase();
                  if (e.key === "Escape") reset();
                }}
                onChange={(e) => setTyped(e.target.value)}
              />
              {/* Not isTauri-gated: unlike OAuth, this has a real browser
                  meaning (drop the demo's localStorage), and gating it would
                  leave the confirm flow and the receipt untestable in the demo. */}
              <Button
                variant="danger"
                size="sm"
                disabled={busy || typed !== "ERASE"}
                onClick={erase}
              >
                {busy ? "Erasing…" : "Erase everything"}
              </Button>
            </div>
            {!isTauri && (
              <p className="text-[12px] text-warn">
                In the browser demo this only clears this site's local storage —
                there is no keychain and no mail database to erase.
              </p>
            )}
          </div>
        </WideRow>
      )}

      {report && (
        <WideRow>
          <div className="rounded-md border border-line bg-raised px-3 py-2.5">
            <div className="mb-1.5 flex items-baseline gap-2">
              <span className="text-[12.5px] font-semibold text-ink">
                Erased {report.credentials.length + report.paths.length} item
                {report.credentials.length + report.paths.length === 1 ? "" : "s"}
              </span>
              {report.revoked > 0 && (
                <span className="text-[11.5px] text-ink-3">
                  · {report.revoked} Google grant
                  {report.revoked === 1 ? "" : "s"} revoked
                </span>
              )}
            </div>
            <ul className="max-h-56 overflow-y-auto font-mono text-[11px] leading-[1.7] text-ink-2">
              {report.credentials.map((c) => (
                <li key={`c-${c}`} className="truncate" title={c}>
                  <span className="text-ok">keychain</span> {c}
                </li>
              ))}
              {report.paths.map((p) => (
                <li key={`p-${p}`} className="truncate" title={p}>
                  <span className="text-ink-3">file</span> {p}
                </li>
              ))}
              {report.errors.map((e) => (
                <li key={`e-${e}`} className="text-warn" title={e}>
                  could not remove: {e}
                </li>
              ))}
            </ul>
            {report.errors.length > 0 && (
              <p className="mt-1.5 text-[11.5px] text-ink-3">
                Anything left above was locked by another process; it is removed on
                the next launch.
              </p>
            )}
          </div>
        </WideRow>
      )}
    </>
  );
}

/** A support report built only from what the UI already knows. */
async function collectDiagnostics(): Promise<string> {
  const s = useSettings.getState();
  const activity = await backend.getSyncActivity().catch(() => null);
  const lines = [
    `Snail Mail ${await appVersion()}`,
    `Shell: ${isTauri ? "Tauri desktop" : "browser demo"}`,
    `Platform: ${navigator.userAgent}`,
    `Theme: ${s.settings.theme} · embeddings: ${s.settings.embeddings}`,
    `Undo send: ${s.settings.undoSendSeconds}s · Drive: ${s.settings.driveAutoUpload}/${s.settings.driveShareMode}`,
    `Splits: ${s.settings.splits.map((x) => x.id).join(", ")}`,
    `Accounts (${s.accounts.accounts.length}):`,
    ...s.accounts.accounts.map((a) => {
      const c = s.capabilities[a.email];
      const caps = c
        ? `drive=${c.drive} contacts=${c.contacts} calendarWrite=${c.calendarWrite} legacy=${c.legacyGrant}`
        : "capabilities unknown";
      return `  · ${a.provider} · connected=${a.connected} · ${caps}`;
    }),
    `Sync: ${activity ? `${activity.stage} ${activity.done}/${activity.total}` : "idle"}`,
  ];
  return lines.join("\n");
}

async function appVersion(): Promise<string> {
  if (!isTauri) return "browser demo";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "unknown version";
  }
}
