import { useEffect, useState } from "react";
import { Button } from "@/components/Button";
import { Pill } from "@/components/Pill";
import { RowGroup, SettingRow, WideRow } from "@/components/SettingRow";
import { backend, isTauri } from "@/lib/ipc";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useReceipt } from "../receipt";
import type { AiProviderId } from "@/lib/types";

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
        help={`%APPDATA%\\snail-mail · one SQLite database per account · ${accounts.length} ${
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
    </RowGroup>
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
