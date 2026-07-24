import { useEffect, useState } from "react";
import { backend, isTauri } from "@/lib/ipc";
import { formatKeyExpr } from "@/lib/keyboard";
import { allCommands } from "@/lib/commands";
import { useUpdater } from "@/lib/updater";
import { useMail } from "@/stores/mail";
import { useProfiles, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { Avatar } from "@/components/Avatar";
import { SignatureEditor } from "./SignatureEditor";
import { parseSplitQuery } from "@/lib/split-query";
import type {
  AiProviderId,
  Capabilities,
  SendAsAlias,
  Split,
} from "@/lib/types";

const TABS = [
  ["account", "Account"],
  ["ai", "AI Providers"],
  ["knowledge", "Knowledge Base"],
  ["splits", "Splits"],
  ["shortcuts", "Shortcuts"],
  ["celebration", "Inbox Zero"],
  ["appearance", "Appearance"],
] as const;

const inputCls =
  "w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";
const btnCls =
  "rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-medium text-on-accent hover:bg-accent-strong disabled:opacity-50";
const btnGhost =
  "rounded-md border border-line-strong px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-hover";

function Section({
  title,
  children,
  hint,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-8">
      <h2 className="mb-1 text-[14px] font-semibold text-ink">{title}</h2>
      {hint && <p className="mb-3 text-[12px] text-ink-3">{hint}</p>}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Account

/** Header avatar with an override: click to pick a new photo, × resets to
 *  the Google one (or the monogram). */
function ProfilePhoto({ email }: { email: string }) {
  const profile = useProfiles((s) => s.profiles[email]);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    void useProfiles.getState().loadFor(email);
  }, [email]);

  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f || f.size > 1_000_000) {
        if (f) window.alert("Keep the photo under 1 MB.");
        return;
      }
      const r = new FileReader();
      r.onload = () =>
        void useProfiles.getState().setPhoto(email, String(r.result));
      r.readAsDataURL(f);
    };
    input.click();
  };

  return (
    <span
      className="relative cursor-pointer"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={pick}
      title="Click to change the photo"
    >
      <Avatar name={profile?.name ?? email} email={email} src={profile?.picture} size={28} />
      {hover && profile?.picture && (
        <button
          className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-overlay text-[10px] text-ink-2 shadow"
          onClick={(e) => {
            e.stopPropagation();
            void useProfiles.getState().setPhoto(email, null);
          }}
          title="Remove custom photo"
        >
          ×
        </button>
      )}
    </span>
  );
}

/** Read-only send-as aliases (users.settings.sendAs), fetched at connect and
 *  cached; shown so the user can see what Gmail can send as. The From-alias
 *  selector in compose is a later step. */
function SendAsList({ email }: { email: string }) {
  const [aliases, setAliases] = useState<SendAsAlias[]>([]);
  useEffect(() => {
    void backend
      .getSendAs(email)
      .then(setAliases)
      .catch(() => setAliases([]));
  }, [email]);
  if (aliases.length <= 1) return null; // just the primary — nothing to show
  return (
    <div className="mt-2 rounded-md border border-line bg-raised px-3 py-2">
      <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-ink-3">
        Send-as addresses
      </div>
      {aliases.map((a) => (
        <div key={a.email} className="flex items-center gap-2 py-0.5 text-[12.5px]">
          <span className="text-ink">{a.email}</span>
          {a.displayName && <span className="text-ink-3">{a.displayName}</span>}
          {a.isDefault && (
            <span className="rounded bg-accent-dim px-1.5 py-0.5 text-[10.5px] text-accent-strong">
              default
            </span>
          )}
          {!a.verified && <span className="text-[11px] text-warn">unverified</span>}
          {a.hasSignature && (
            <span className="text-[11px] text-ink-3" title="Has its own Gmail signature">
              ✎ signature
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Feature scopes this account's grant is missing (shown in the Reconnect
 *  strip). legacyGrant (pre-v0.15 token) means all of them. */
function missingGrants(caps: Capabilities | undefined): string[] {
  if (!caps) return [];
  if (caps.legacyGrant) return ["Drive", "Contacts", "Calendar"];
  const missing: string[] = [];
  if (!caps.drive) missing.push("Drive");
  if (!caps.contacts) missing.push("Contacts");
  if (!caps.calendarWrite) missing.push("Calendar");
  return missing;
}

function AccountTab() {
  const accounts = useSettings((s) => s.accounts);
  const capabilities = useSettings((s) => s.capabilities);
  const settings = useSettings((s) => s.settings);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [clientStored, setClientStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [sigDrafts, setSigDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    void backend.hasGmailClient().then(setClientStored);
  }, []);

  // Disconnect (revokes server-side) then a fresh Connect — the one-time
  // re-consent that unlocks scopes added after the account was connected.
  const reconnect = async (email: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await backend.disconnect(email);
      await backend.startOauth("", "");
      await useSettings.getState().refreshAccounts();
      await backend.syncNow();
      await useMail.getState().refresh();
      setMsg("Reconnected with the new access.");
    } catch (e) {
      setMsg(String(e));
      await useSettings.getState().refreshAccounts();
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // blank fields reuse the client already in the keychain
      await backend.startOauth(clientId.trim(), clientSecret.trim());
      await useSettings.getState().refreshAccounts();
      await backend.syncNow();
      await useMail.getState().refresh();
      setMsg("Connected. Syncing the inbox…");
      setClientId("");
      setClientSecret("");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, dir: -1 | 1) => {
    const emails = accounts.accounts.map((a) => a.email);
    const j = index + dir;
    if (j < 0 || j >= emails.length) return;
    [emails[index], emails[j]] = [emails[j], emails[index]];
    void useSettings.getState().reorderAccounts(emails);
  };

  const saveSignature = (email: string) => {
    void useSettings.getState().save({
      signatures: { ...settings.signatures, [email]: sigDrafts[email] ?? "" },
    });
  };

  return (
    <>
      <Section
        title="Accounts"
        hint="Slot number = Alt+1…9 to switch instantly. Reorder to reassign slots. Each account gets its own signature."
      >
        <div className="space-y-3">
          {accounts.accounts.map((a, i) => {
            const active = a.email === accounts.active;
            const sig = sigDrafts[a.email] ?? settings.signatures[a.email] ?? "";
            const sigDirty =
              (sigDrafts[a.email] ?? null) !== null &&
              sigDrafts[a.email] !== (settings.signatures[a.email] ?? "");
            return (
              <div key={a.email} className="rounded-lg border border-line bg-surface p-3">
                <div className="flex items-center gap-3">
                  <span className="kbd">Alt+{i + 1}</span>
                  <ProfilePhoto email={a.email} />
                  <div className={`h-2 w-2 rounded-full ${a.connected ? "bg-ok" : "bg-warn"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-ink">
                      {a.email}
                      {active && (
                        <span className="ml-2 rounded bg-accent-dim px-1.5 py-0.5 text-[10.5px] text-accent-strong">
                          active
                        </span>
                      )}
                    </div>
                    <div className="text-[11.5px] capitalize text-ink-3">
                      {a.provider === "mock" ? "demo data" : a.provider}
                    </div>
                  </div>
                  <button className={btnGhost} onClick={() => move(i, -1)} disabled={i === 0} title="Move up (lower slot)">
                    ↑
                  </button>
                  <button
                    className={btnGhost}
                    onClick={() => move(i, 1)}
                    disabled={i === accounts.accounts.length - 1}
                    title="Move down (higher slot)"
                  >
                    ↓
                  </button>
                  {!active && (
                    <button
                      className={btnGhost}
                      onClick={() =>
                        void useSettings
                          .getState()
                          .switchAccount(a.email)
                          .then(() => useMail.getState().refresh())
                      }
                    >
                      Switch
                    </button>
                  )}
                  {a.provider === "gmail" && capabilities[a.email]?.contacts && active && (
                    <button
                      className={btnGhost}
                      title="Re-sync Google Contacts for recipient autocomplete (also refreshes daily)"
                      onClick={async () => {
                        try {
                          const n = await backend.refreshContacts();
                          useUi.getState().showToast(`Contacts refreshed — ${n} synced`);
                        } catch (e) {
                          useUi.getState().showToast(String(e));
                        }
                      }}
                    >
                      Refresh contacts
                    </button>
                  )}
                  {a.provider === "gmail" && (
                    <button
                      className={btnGhost}
                      onClick={async () => {
                        await backend.disconnect(a.email);
                        await useSettings.getState().refreshAccounts();
                        await useMail.getState().refresh();
                      }}
                    >
                      Disconnect
                    </button>
                  )}
                </div>
                {a.provider === "gmail" && missingGrants(capabilities[a.email]).length > 0 && (
                  <div className="mt-2 flex items-center gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2">
                    <span className="flex-1 text-[12px] text-ink-2">
                      {capabilities[a.email]?.legacyGrant
                        ? "This account was connected before the latest Google features."
                        : `Not granted: ${missingGrants(capabilities[a.email]).join(", ")}.`}{" "}
                      Reconnect once and check every box on Google's consent
                      screen to use Drive attachments and contacts autocomplete.
                    </span>
                    <button
                      className={btnCls}
                      disabled={busy}
                      onClick={() => void reconnect(a.email)}
                    >
                      {busy ? "Waiting for consent…" : "Reconnect to grant new access"}
                    </button>
                  </div>
                )}
                {(a.provider === "gmail" || a.provider === "mock") && (
                  <SendAsList email={a.email} />
                )}
                <div className="mt-2">
                  <SignatureEditor
                    value={sig}
                    onChange={(html) =>
                      setSigDrafts((d) => ({ ...d, [a.email]: html }))
                    }
                  />
                  {sigDirty && (
                    <button className={`${btnCls} mt-1.5`} onClick={() => saveSignature(a.email)}>
                      Save signature
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section
        title="Add a Gmail account"
        hint={
          clientStored
            ? "Your OAuth client is already in the Windows Credential Manager — leave the fields blank and hit Connect. Add as many Gmail accounts as you like with the same client."
            : "Paste the OAuth client from Google Cloud Console (Desktop app type, Gmail API enabled — step-by-step in docs/SETUP.md). It's stored in the Windows Credential Manager, never on disk."
        }
      >
        <div className="space-y-2">
          <input
            className={inputCls}
            placeholder={clientStored ? "Client ID (stored — leave blank to reuse)" : "Client ID (…apps.googleusercontent.com)"}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <input
            className={inputCls}
            type="password"
            placeholder={clientStored ? "Client secret (stored — leave blank to reuse)" : "Client secret"}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <button
              className={btnCls}
              disabled={busy || !isTauri || (!clientStored && (!clientId.trim() || !clientSecret.trim()))}
              onClick={connect}
            >
              {busy ? "Waiting for browser consent…" : "Connect Gmail"}
            </button>
            {!isTauri && (
              <span className="text-[12px] text-warn">
                OAuth needs the desktop app — this is the browser demo.
              </span>
            )}
            {msg && <span className="text-[12px] text-ink-2">{msg}</span>}
          </div>
        </div>
      </Section>

      <Section
        title="Add an Outlook account"
        hint="Microsoft Graph support is scaffolded and lands next release. It will use an Azure app registration (public client + PKCE, Mail.ReadWrite + Mail.Send) the same way Gmail uses its OAuth client — setup steps are already drafted in docs/SETUP.md."
      >
        <button className={btnGhost} disabled>
          Coming next release
        </button>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- AI

function AiTab() {
  const settings = useSettings((s) => s.settings);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, string>>({});

  const saveKey = async (id: AiProviderId) => {
    const key = keys[id] ?? "";
    await useSettings.getState().setAiKey(id, key);
    setKeys((k) => ({ ...k, [id]: "" }));
    setStatus((s) => ({ ...s, [id]: "Key saved to OS keychain." }));
  };

  const test = async (id: AiProviderId) => {
    setStatus((s) => ({ ...s, [id]: "Testing…" }));
    try {
      const r = await backend.testAiProvider(id);
      setStatus((s) => ({ ...s, [id]: `${r.ok ? "✓" : "✗"} ${r.message}` }));
    } catch (e) {
      setStatus((s) => ({ ...s, [id]: `✗ ${String(e)}` }));
    }
  };

  const patchProvider = (id: AiProviderId, patch: Partial<(typeof settings.providers)[number]>) => {
    void useSettings.getState().save({
      providers: settings.providers.map((p) =>
        p.id === id ? { ...p, ...patch } : p
      ),
    });
  };

  return (
    <>
      <Section
        title="Bring your own key"
        hint="Keys are stored in the Windows Credential Manager and only ever sent to the provider you chose. They never appear in logs or the repo."
      >
        <div className="space-y-4">
          {settings.providers.map((p) => (
            <div key={p.id} className="rounded-lg border border-line bg-surface p-4">
              <div className="mb-2 flex items-center gap-2">
                <label className="flex items-center gap-2 text-[13.5px] font-medium text-ink">
                  <input
                    type="radio"
                    name="defaultProvider"
                    checked={settings.defaultAiProvider === p.id}
                    onChange={() =>
                      void useSettings.getState().save({ defaultAiProvider: p.id })
                    }
                    className="accent-[#6d7ff2]"
                  />
                  {p.label}
                </label>
                {settings.defaultAiProvider === p.id && (
                  <span className="rounded bg-accent-dim px-1.5 py-0.5 text-[10.5px] text-accent-strong">
                    default
                  </span>
                )}
                <div className="flex-1" />
                <span
                  className={`text-[11.5px] ${p.hasKey ? "text-ok" : "text-ink-3"}`}
                >
                  {p.hasKey ? "key stored" : "no key"}
                </span>
              </div>
              <div className="flex gap-2">
                <input
                  className={inputCls}
                  type="password"
                  placeholder={
                    p.id === "claude"
                      ? "sk-ant-…"
                      : p.id === "openai"
                        ? "sk-…"
                        : "nvapi-…"
                  }
                  value={keys[p.id] ?? ""}
                  onChange={(e) =>
                    setKeys((k) => ({ ...k, [p.id]: e.target.value }))
                  }
                />
                <button
                  className={btnCls}
                  disabled={!(keys[p.id] ?? "").trim()}
                  onClick={() => void saveKey(p.id)}
                >
                  Save
                </button>
                <button className={btnGhost} onClick={() => void test(p.id)}>
                  Test connection
                </button>
              </div>
              <div className="mt-2 flex gap-2">
                <input
                  className={inputCls}
                  value={p.model}
                  onChange={(e) => patchProvider(p.id, { model: e.target.value })}
                  title="Model"
                />
                {p.id === "nim" && (
                  <input
                    className={inputCls}
                    value={p.baseUrl ?? ""}
                    onChange={(e) =>
                      patchProvider(p.id, { baseUrl: e.target.value })
                    }
                    placeholder="Base URL (hosted or self-hosted NIM)"
                    title="OpenAI-compatible base URL"
                  />
                )}
              </div>
              {status[p.id] && (
                <div className="mt-2 text-[12px] text-ink-2">{status[p.id]}</div>
              )}
            </div>
          ))}
        </div>
      </Section>
      <Section
        title="Semantic search"
        hint="Vector search finds meaning, not just words — 'invoice' matches a wire-transfer receipt. Local keeps mail on-device and works offline; the model (~34 MB) downloads in the background on first use."
      >
        <select
          className={inputCls}
          value={settings.embeddings}
          onChange={(e) =>
            void useSettings.getState().save({
              embeddings: e.target.value as "local" | "openai",
            })
          }
        >
          <option value="local">Local model (private, offline)</option>
          <option value="openai">
            OpenAI text-embedding-3-small (uses your OpenAI key)
          </option>
        </select>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Knowledge

function KnowledgeTab() {
  const kb = useSettings((s) => s.kb);
  const [draft, setDraft] = useState(kb.instructions);
  const [snipTitle, setSnipTitle] = useState("");
  const [snipBody, setSnipBody] = useState("");
  const [exTitle, setExTitle] = useState("");
  const [exBody, setExBody] = useState("");

  const save = (patch: Partial<typeof kb>) =>
    void useSettings.getState().saveKb({ ...kb, ...patch });

  return (
    <>
      <Section
        title="Standing instructions"
        hint="How the AI should sound and rules it must always follow. Injected into every draft."
      >
        <textarea
          className={`${inputCls} min-h-28 resize-y`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={'e.g. "Be warm but brief. Never use exclamation marks. Sign off with just \'S\'. When scheduling, always propose two concrete times."'}
        />
        <div className="mt-2 flex items-center gap-3">
          <button className={btnCls} onClick={() => save({ instructions: draft })}>
            Save instructions
          </button>
          {draft !== kb.instructions && (
            <span className="text-[12px] text-warn">unsaved changes</span>
          )}
        </div>
      </Section>

      <Section
        title="Snippets"
        hint="Reusable blocks the AI can weave into drafts (bios, disclaimers, scheduling links…)."
      >
        <div className="mb-3 space-y-2">
          {kb.snippets.map((s) => (
            <div
              key={s.id}
              className="flex items-start gap-3 rounded-md border border-line bg-surface px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink">{s.title}</div>
                <div className="truncate text-[12px] text-ink-3">{s.body}</div>
              </div>
              <button
                className="text-[12px] text-ink-3 hover:text-bad"
                onClick={() =>
                  save({ snippets: kb.snippets.filter((x) => x.id !== s.id) })
                }
              >
                remove
              </button>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <input
            className={inputCls}
            placeholder="Snippet title"
            value={snipTitle}
            onChange={(e) => setSnipTitle(e.target.value)}
          />
          <textarea
            className={`${inputCls} min-h-16 resize-y`}
            placeholder="Snippet text"
            value={snipBody}
            onChange={(e) => setSnipBody(e.target.value)}
          />
          <button
            className={btnCls}
            disabled={!snipTitle.trim() || !snipBody.trim()}
            onClick={() => {
              save({
                snippets: [
                  ...kb.snippets,
                  { id: `snip-${Date.now()}`, title: snipTitle, body: snipBody },
                ],
              });
              setSnipTitle("");
              setSnipBody("");
            }}
          >
            Add snippet
          </button>
        </div>
      </Section>

      <Section
        title="Voice examples"
        hint="Paste emails you've written that sound like you. The AI mimics their tone and structure."
      >
        <div className="mb-3 space-y-2">
          {kb.voiceExamples.map((s) => (
            <div
              key={s.id}
              className="flex items-start gap-3 rounded-md border border-line bg-surface px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-ink">{s.title}</div>
                <div className="truncate text-[12px] text-ink-3">{s.body}</div>
              </div>
              <button
                className="text-[12px] text-ink-3 hover:text-bad"
                onClick={() =>
                  save({
                    voiceExamples: kb.voiceExamples.filter((x) => x.id !== s.id),
                  })
                }
              >
                remove
              </button>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <input
            className={inputCls}
            placeholder='Label, e.g. "how I decline pitches"'
            value={exTitle}
            onChange={(e) => setExTitle(e.target.value)}
          />
          <textarea
            className={`${inputCls} min-h-24 resize-y`}
            placeholder="Paste the example email"
            value={exBody}
            onChange={(e) => setExBody(e.target.value)}
          />
          <button
            className={btnCls}
            disabled={!exTitle.trim() || !exBody.trim()}
            onClick={() => {
              save({
                voiceExamples: [
                  ...kb.voiceExamples,
                  { id: `ex-${Date.now()}`, title: exTitle, body: exBody },
                ],
              });
              setExTitle("");
              setExBody("");
            }}
          >
            Add example
          </button>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Splits

/** Query input with instant client-side validation and a debounced backend
 *  match-count preview. The same syntax the row list displays round-trips
 *  here — from:domain.com, quoted phrases, AND/OR, parentheses. */
function SplitQueryField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    try {
      parseSplitQuery(value);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setCount(null);
      return;
    }
    if (!value.trim()) {
      setCount(null);
      return;
    }
    const t = setTimeout(() => {
      void backend
        .previewSplit(value)
        .then((p) => setCount(p.ok ? p.count : null))
        .catch(() => setCount(null));
    }, 300);
    return () => clearTimeout(t);
  }, [value]);

  return (
    <div className="flex-1">
      <input
        className={inputCls}
        placeholder={
          placeholder ?? "from:alice@example.com OR from:news.example.com"
        }
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      {error ? (
        <p className="mt-1 text-[11.5px] text-bad">{error}</p>
      ) : count !== null ? (
        <p className="mt-1 text-[11.5px] text-ink-3">
          matches {count} recent inbox conversation{count === 1 ? "" : "s"}
        </p>
      ) : null}
    </div>
  );
}

/** Inline editor shared by "edit split" and "new split". */
function SplitEditor({
  initial,
  accounts,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: { name: string; query: string; accountId: string | null; alsoShow: boolean };
  accounts: { email: string }[];
  submitLabel: string;
  onSubmit: (v: typeof initial) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [query, setQuery] = useState(initial.query);
  const [accountId, setAccountId] = useState(initial.accountId);
  const [alsoShow, setAlsoShow] = useState(initial.alsoShow);

  const valid = (() => {
    if (!name.trim() || !query.trim()) return false;
    try {
      parseSplitQuery(query);
      return true;
    } catch {
      return false;
    }
  })();

  return (
    <div className="space-y-2">
      <input
        className={inputCls}
        placeholder='Split name, e.g. "Travel Deals"'
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <SplitQueryField value={query} onChange={setQuery} />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
          applies to
          <select
            className="rounded-md border border-line-strong bg-raised px-2 py-1 text-[12.5px] text-ink"
            value={accountId ?? ""}
            onChange={(e) => setAccountId(e.target.value || null)}
          >
            <option value="">all accounts</option>
            {accounts.map((a) => (
              <option key={a.email} value={a.email}>
                {a.email}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
          <input
            type="checkbox"
            checked={alsoShow}
            onChange={(e) => setAlsoShow(e.target.checked)}
            className="accent-[#6d7ff2]"
          />
          also show matches in Important or Other
        </label>
        <div className="flex-1" />
        {onCancel && (
          <button className={btnGhost} onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          className={btnCls}
          disabled={!valid}
          onClick={() => onSubmit({ name: name.trim(), query: query.trim(), accountId, alsoShow })}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

function SplitsTab() {
  const settings = useSettings((s) => s.settings);
  const accounts = useSettings((s) => s.accounts.accounts);
  const [editingId, setEditingId] = useState<string | null>(null);

  const saveSplits = (splits: Split[]) =>
    void useSettings.getState().save({ splits });

  const move = (id: string, dir: -1 | 1) => {
    const splits = [...settings.splits];
    const i = splits.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= splits.length) return;
    [splits[i], splits[j]] = [splits[j], splits[i]];
    saveSplits(splits);
  };

  const addSplit = (v: {
    name: string;
    query: string;
    accountId: string | null;
    alsoShow: boolean;
  }) => {
    const split: Split = {
      id: `custom-${Date.now()}`,
      builtin: false,
      hideWhenEmpty: false,
      ...v,
    };
    // Custom splits go on top so they win over Important — reorder any time.
    saveSplits([split, ...settings.splits]);
  };

  return (
    <>
      <Section
        title="Split inboxes"
        hint="Splits divide the inbox into focused tabs, checked top to bottom — the first match wins, and the whole mailbox is organized as mail syncs. Counts show total conversations. Tab / Shift+Tab cycles between them."
      >
        <div className="space-y-2">
          {settings.splits.map((s, i) => (
            <div
              key={s.id}
              className="rounded-md border border-line bg-surface px-3 py-2"
            >
              <div className="flex items-center gap-3">
                <div className="flex flex-col">
                  <button
                    className="text-[10px] leading-3 text-ink-3 hover:text-ink disabled:opacity-30"
                    disabled={i === 0}
                    onClick={() => move(s.id, -1)}
                    title="Move up (matches earlier)"
                  >
                    ▲
                  </button>
                  <button
                    className="text-[10px] leading-3 text-ink-3 hover:text-ink disabled:opacity-30"
                    disabled={i === settings.splits.length - 1}
                    onClick={() => move(s.id, 1)}
                    title="Move down (matches later)"
                  >
                    ▼
                  </button>
                </div>
                <span className="text-[13px] font-medium text-ink">{s.name}</span>
                <span className="max-w-[260px] truncate font-mono text-[11px] text-ink-3">
                  {s.query.trim() === "" ? "catch-all" : s.query}
                </span>
                {s.accountId && (
                  <span className="rounded bg-raised px-1.5 py-0.5 text-[10.5px] text-ink-3">
                    {s.accountId}
                  </span>
                )}
                {s.alsoShow && (
                  <span className="text-[10.5px] text-ink-3">+ Important/Other</span>
                )}
                <div className="flex-1" />
                <label className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                  <input
                    type="checkbox"
                    checked={s.hideWhenEmpty}
                    onChange={(e) =>
                      saveSplits(
                        settings.splits.map((x) =>
                          x.id === s.id
                            ? { ...x, hideWhenEmpty: e.target.checked }
                            : x
                        )
                      )
                    }
                    className="accent-[#6d7ff2]"
                  />
                  hide when empty
                </label>
                {s.query.trim() !== "" && (
                  <button
                    className="text-[12px] text-ink-3 hover:text-ink"
                    onClick={() => setEditingId(editingId === s.id ? null : s.id)}
                  >
                    edit
                  </button>
                )}
                {!s.builtin && (
                  <button
                    className="text-[12px] text-ink-3 hover:text-bad"
                    onClick={() =>
                      saveSplits(settings.splits.filter((x) => x.id !== s.id))
                    }
                  >
                    remove
                  </button>
                )}
              </div>
              {editingId === s.id && (
                <div className="mt-3 border-t border-line pt-3">
                  <SplitEditor
                    initial={{
                      name: s.name,
                      query: s.query,
                      accountId: s.accountId,
                      alsoShow: s.alsoShow,
                    }}
                    accounts={accounts}
                    submitLabel="Save"
                    onCancel={() => setEditingId(null)}
                    onSubmit={(v) => {
                      saveSplits(
                        settings.splits.map((x) => (x.id === s.id ? { ...x, ...v } : x))
                      );
                      setEditingId(null);
                    }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="New custom split"
        hint='Write the definition as a search query: from:alice@example.com OR to:feedback@example.com · subject:"survey results" · from:thriftytraveler.com matches the whole domain.'
      >
        <SplitEditor
          key={settings.splits.length /* reset the form after a create */}
          initial={{ name: "", query: "", accountId: null, alsoShow: false }}
          accounts={accounts}
          submitLabel="Create split"
          onSubmit={addSplit}
        />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Shortcuts

function ShortcutsTab() {
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  const [editing, setEditing] = useState<string | null>(null);
  const [expr, setExpr] = useState("");

  const commands = allCommands();

  return (
    <Section
      title="Keyboard shortcuts"
      hint='Click a binding to remap. Format: single keys ("e"), combos ("mod+k"), chords ("g i"), alternatives ("j|down"). "mod" is Ctrl on Windows.'
    >
      <div className="overflow-hidden rounded-lg border border-line">
        {commands.map((c) => (
          <div
            key={c.id}
            className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2 last:border-b-0"
          >
            <span className="flex-1 text-[13px] text-ink">{c.title}</span>
            {editing === c.id ? (
              <input
                autoFocus
                className="w-40 rounded-md border border-accent bg-raised px-2 py-1 text-[12.5px] text-ink outline-none"
                value={expr}
                onChange={(e) => setExpr(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    void useSettings.getState().save({
                      shortcuts: { ...shortcuts, [c.id]: expr.trim() },
                    });
                    setEditing(null);
                  }
                  if (e.key === "Escape") setEditing(null);
                  e.stopPropagation();
                }}
                onBlur={() => setEditing(null)}
              />
            ) : (
              <button
                className="kbd hover:border-accent"
                onClick={() => {
                  setEditing(c.id);
                  setExpr(shortcuts[c.id] ?? "");
                }}
              >
                {shortcuts[c.id] ? formatKeyExpr(shortcuts[c.id]) : "unbound"}
              </button>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- Celebration

function CelebrationTab() {
  const settings = useSettings((s) => s.settings);
  const streaks = useSettings((s) => s.streaks);
  const [dir, setDir] = useState(settings.celebrationDir ?? "");

  return (
    <>
      <Section title="Streak">
        <div className="flex gap-4">
          <div className="flex-1 rounded-lg border border-line bg-surface px-4 py-3 text-center">
            <div className="text-2xl font-semibold text-ink">{streaks.daily}</div>
            <div className="text-[11.5px] text-ink-3">day streak</div>
          </div>
          <div className="flex-1 rounded-lg border border-line bg-surface px-4 py-3 text-center">
            <div className="text-2xl font-semibold text-ink">{streaks.weekly}</div>
            <div className="text-[11.5px] text-ink-3">week streak</div>
          </div>
        </div>
      </Section>
      <Section
        title="Celebration images"
        hint="Shown full-screen when a split hits zero. Leave empty to use the bundled set, or point to a folder of your own images."
      >
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="C:\\Users\\you\\Pictures\\celebrations (empty = bundled)"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
          />
          <button
            className={btnCls}
            onClick={() =>
              void useSettings.getState().save({
                celebrationDir: dir.trim() ? dir.trim() : null,
              })
            }
          >
            Save
          </button>
        </div>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------- Appearance

/** Manual update check + status. Auto-update also runs on boot / focus / every
 *  4h; this surfaces the state (and any failure, which used to be invisible). */
function UpdateControls() {
  const status = useUpdater((s) => s.status);
  const checking = useUpdater((s) => s.checking);
  const ready = useUpdater((s) => s.ready);
  const downloading = useUpdater((s) => s.downloading);
  const error = useUpdater((s) => s.error);
  return (
    <div className="flex flex-wrap items-center gap-3">
      {ready ? (
        <button className={btnCls} onClick={() => void useUpdater.getState().restart()}>
          Restart to install {ready}
        </button>
      ) : (
        <button
          className={btnGhost}
          disabled={checking || !!downloading}
          onClick={() => void useUpdater.getState().checkNow()}
        >
          {checking ? "Checking…" : downloading ? "Downloading…" : "Check for updates"}
        </button>
      )}
      {status && (
        <span className={`text-[12px] ${error ? "text-warn" : "text-ink-3"}`}>
          {status}
        </span>
      )}
    </div>
  );
}

function AppearanceTab() {
  const theme = useSettings((s) => s.settings.theme);
  const notifications = useSettings((s) => s.settings.notifications);
  const onboarded = useSettings((s) => s.settings.onboarded);
  const undoSendSeconds = useSettings((s) => s.settings.undoSendSeconds);
  const driveAutoUpload = useSettings((s) => s.settings.driveAutoUpload);
  return (
    <>
      <Section
        title="Theme"
        hint="Dark is the default and follows Superhuman's dark-theme principles. Light is tuned for perceptual contrast, not just inverted."
      >
        <div className="flex gap-3">
          {(["dark", "light"] as const).map((t) => (
            <label
              key={t}
              className={`flex flex-1 cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 ${
                theme === t ? "border-accent bg-accent-dim" : "border-line bg-surface"
              }`}
            >
              <input
                type="radio"
                name="theme"
                checked={theme === t}
                onChange={() => void useSettings.getState().save({ theme: t })}
                className="accent-[#6d7ff2]"
              />
              <span className="text-[13px] capitalize text-ink">{t}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section
        title="Notifications"
        hint="New-mail notifications appear only while the Snail Mail window is in the background."
      >
        <label className="flex cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            checked={notifications}
            onChange={(e) =>
              void useSettings.getState().save({ notifications: e.target.checked })
            }
            className="accent-[#6d7ff2]"
          />
          <span className="text-[13px] text-ink">Notify me about new mail</span>
        </label>
      </Section>

      <Section
        title="Undo send"
        hint="Hold outgoing mail briefly so you can pull it back before it leaves. Press Z to undo, or Ctrl+Shift+Z to send instantly. Off sends the moment you hit Send."
      >
        <select
          value={undoSendSeconds}
          onChange={(e) =>
            void useSettings
              .getState()
              .save({ undoSendSeconds: Number(e.target.value) })
          }
          className="cursor-pointer rounded-md border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
        >
          <option value={0}>Off — send immediately</option>
          <option value={10}>10 seconds</option>
          <option value={30}>30 seconds</option>
        </select>
      </Section>

      <Section
        title="Oversized attachments"
        hint="Files over the 25 MB email limit upload to Google Drive and send as a link, like Gmail. (This is also where 'always upload without asking' can be turned back off.)"
      >
        <select
          value={driveAutoUpload}
          onChange={(e) =>
            void useSettings
              .getState()
              .save({ driveAutoUpload: e.target.value as "ask" | "always" })
          }
          className="cursor-pointer rounded-md border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
        >
          <option value="ask">Ask before uploading to Drive</option>
          <option value="always">Always upload to Drive without asking</option>
        </select>
      </Section>

      <Section
        title="Welcome tour"
        hint="Replay the first-run walkthrough (connect, AI, theme, shortcuts)."
      >
        <button
          className={btnGhost}
          onClick={() => {
            void useSettings.getState().save({ onboarded: false });
            useUi.getState().setScreen("mail");
          }}
        >
          {onboarded ? "Show the welcome tour again" : "Tour will show on the mail screen"}
        </button>
      </Section>

      <Section
        title="Daily photo"
        hint="Empty splits show a calm daily photo from Unsplash (fetched once a day by the Rust core, never from the web bundle). A built-in key ships with the app; paste your own Unsplash Access Key here to use it instead — it lives in the Windows Credential Manager."
      >
        <UnsplashKeyControls />
      </Section>

      <Section
        title="Updates"
        hint="Updates install themselves from GitHub Releases — on launch, when you refocus the window, and every few hours. Check manually here; failures show up instead of failing silently."
      >
        <UpdateControls />
      </Section>
    </>
  );
}

function UnsplashKeyControls() {
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Unsplash Access Key (blank = built-in)"
          className={inputCls}
        />
        <button
          className={btnGhost}
          onClick={() => {
            void backend
              .setUnsplashKey(key)
              .then(() => {
                setStatus(
                  key.trim()
                    ? "Key saved to OS keychain."
                    : "Custom key cleared — using the built-in key."
                );
                setKey("");
              })
              .catch((e) => setStatus(String(e)));
          }}
        >
          Save
        </button>
      </div>
      {status && <div className="text-[12px] text-ink-3">{status}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- shell

export function SettingsScreen() {
  const tab = useUi((s) => s.settingsTab);

  return (
    <div className="flex h-full">
      <nav className="w-52 shrink-0 border-r border-line bg-surface py-3">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => useUi.getState().setSettingsTab(id)}
            className={`block w-full px-5 py-2 text-left text-[13px] ${
              tab === id
                ? "bg-selected font-medium text-ink"
                : "text-ink-2 hover:bg-hover"
            }`}
          >
            {label}
          </button>
        ))}
        <div className="mt-4 px-5 text-[11px] text-ink-3">
          <span className="kbd">Esc</span> back to inbox
        </div>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-2xl">
          {tab === "account" && <AccountTab />}
          {tab === "ai" && <AiTab />}
          {tab === "knowledge" && <KnowledgeTab />}
          {tab === "splits" && <SplitsTab />}
          {tab === "shortcuts" && <ShortcutsTab />}
          {tab === "celebration" && <CelebrationTab />}
          {tab === "appearance" && <AppearanceTab />}
        </div>
      </div>
    </div>
  );
}
