// Per-address settings live on their own pane, not squeezed into a list row:
// grant health that NAMES the missing scopes (the old strip said "new access"),
// the signature as a first-class editor, the send-as aliases Gmail reports, and
// everything this address keeps on this machine.
import { useEffect, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { KeyHint } from "@/components/KeyHint";
import { Pill } from "@/components/Pill";
import { RowGroup, SettingRow, WideRow } from "@/components/SettingRow";
import { grantScopes, missingScopeNames } from "@/lib/grant-health";
import { backend, isTauri } from "@/lib/ipc";
import { clearMailCaches, useMail } from "@/stores/mail";
import { useProfiles, useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { SignatureEditor } from "../SignatureEditor";
import { useReceipt } from "../receipt";
import type { AccountInfo, ProfileInfo, SendAsAlias } from "@/lib/types";

const inputCls =
  "w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";

/** The name Google gave this account, if it gave one that isn't just the
 *  address. Undefined means "show the address itself" — both the pane heading
 *  and the identity card key off this, so they never disagree. */
export function accountDisplayName(
  profiles: Record<string, ProfileInfo>,
  email: string
): string | undefined {
  const name = profiles[email]?.name?.trim();
  return name && name !== email ? name : undefined;
}

export function AccountPane({ email }: { email: string }) {
  const accounts = useSettings((s) => s.accounts);
  const capabilities = useSettings((s) => s.capabilities);
  const profiles = useProfiles((s) => s.profiles);
  const account = accounts.accounts.find((a) => a.email === email);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (!account) {
    return (
      <p className="text-[12.5px] text-ink-3">
        That account is no longer connected.
      </p>
    );
  }

  const name = accountDisplayName(profiles, email);
  const slot = accounts.accounts.findIndex((a) => a.email === email) + 1;
  const caps = capabilities[email];
  const scopes = grantScopes(caps, account.provider);
  const missing = missingScopeNames(scopes);
  const active = accounts.active === email;

  // Re-consent IN PLACE: start_oauth updates the existing row (token, scopes,
  // connected) without touching this account's mail, cursors, or history.
  const reconnect = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await backend.startOauth("", "");
      await useSettings.getState().refreshAccounts();
      await backend.syncNow();
      await useMail.getState().refresh();
      setMsg("Reconnected — the new access is live.");
    } catch (e) {
      setMsg(String(e));
      await useSettings.getState().refreshAccounts();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* identity */}
      <section className="flex items-center gap-3.5 rounded-lg border border-line bg-surface p-4">
        <ProfilePhoto email={email} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-ink">
              {name ?? email}
            </span>
            {active && <Pill tone="accent">Active</Pill>}
            {!account.connected && <Pill tone="warning">Sign-in expired</Pill>}
            {account.removing && <Pill tone="neutral">Removing…</Pill>}
          </div>
          {/* the address only repeats when there's a display name above it */}
          {name && (
            <div className="mt-0.5 text-[12.5px] text-ink-2">{account.email}</div>
          )}
          <div className="mt-1 flex items-center gap-2 text-[11.5px] text-ink-3">
            <span>{account.provider === "mock" ? "Demo data" : "Gmail"}</span>
            <span>·</span>
            <span>Slot</span>
            <KeyHint expr={`alt+${slot}`} size="sm" />
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          {!active && !account.removing && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void useSettings
                  .getState()
                  .switchAccount(email)
                  .then(() => {
                    clearMailCaches();
                    return useMail.getState().refresh();
                  })
              }
            >
              Switch to this account
            </Button>
          )}
          <SlotButtons email={email} />
        </div>
      </section>

      {/* grant health — names what's missing, not "new access" */}
      <section
        className={`rounded-lg border p-4 ${
          missing.length
            ? "border-warn/45 bg-warn/10"
            : "border-line bg-surface"
        }`}
      >
        <div className="flex items-start gap-3">
          <span
            className={`inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[12px] ${
              missing.length ? "bg-warn/25 text-warn" : "bg-ok/20 text-ok"
            }`}
          >
            {missing.length ? "!" : "✓"}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[13.5px] font-semibold text-ink">
              {missing.length
                ? `Reconnect to restore ${missing.join(" and ")}`
                : "All access granted"}
            </div>
            <p className="mt-1 max-w-[62ch] text-[12px] leading-relaxed text-ink-2">
              {missing.length ? (
                <>
                  {caps?.legacyGrant
                    ? "This account was connected before the latest Google features, so its token predates the new scopes. "
                    : ""}
                  Reconnect once and tick every box on Google's consent screen. Your
                  mail cache and signature stay exactly as they are.
                </>
              ) : (
                "Drive attachments, contacts autocomplete and calendar writes all work on this account. Nothing to do."
              )}
            </p>
            {msg && <p className="mt-1.5 text-[12px] text-ink-2">{msg}</p>}
          </div>
          {missing.length > 0 && (
            <div className="shrink-0">
              <Button
                variant="primary"
                disabled={busy || !isTauri}
                onClick={() => void reconnect()}
              >
                {busy ? "Waiting for Google consent…" : "Reconnect account"}
              </Button>
            </div>
          )}
        </div>
        <div
          className={`mt-3.5 grid gap-x-[18px] gap-y-1.5 ${
            scopes.length > 1 ? "grid-cols-2" : "grid-cols-1"
          }`}
        >
          {scopes.map((s) => (
            <div
              key={s.label}
              className="flex items-center gap-2.5 border-t border-line py-1.5"
            >
              <span
                className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] ${
                  s.ok ? "bg-ok/20 text-ok" : "bg-warn/25 text-warn"
                }`}
              >
                {s.ok ? "✓" : "✕"}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                {s.label}
              </span>
              <span className="text-[11px] text-ink-3">{s.detail}</span>
            </div>
          ))}
        </div>
      </section>

      <SignatureSection email={email} />
      <SendAsSection email={email} />

      <RowGroup title="Sync & local data">
        <SettingRow
          label="Sync now"
          help="Incremental catch-up: new mail, label changes, and anything sent elsewhere."
        >
          <Button
            variant="secondary"
            size="sm"
            disabled={!isTauri}
            onClick={() => {
              void backend
                .syncNow()
                .then(() => useMail.getState().refresh())
                .then(() => useReceipt.getState().note("Sync started"))
                .catch((e) => useUi.getState().showToast(String(e)));
            }}
          >
            Sync now
          </Button>
        </SettingRow>
        <DisconnectRow account={account} />
      </RowGroup>
    </>
  );
}

/** Slot = Alt+1…9. Reordering reassigns them, so the arrows live here. */
function SlotButtons({ email }: { email: string }) {
  const accounts = useSettings((s) => s.accounts.accounts);
  const i = accounts.findIndex((a) => a.email === email);
  const move = (dir: -1 | 1) => {
    const emails = accounts.map((a) => a.email);
    const j = i + dir;
    if (j < 0 || j >= emails.length) return;
    [emails[i], emails[j]] = [emails[j], emails[i]];
    void useSettings.getState().reorderAccounts(emails);
    useReceipt.getState().note(`${email} moved to slot ${j + 1}`);
  };
  if (accounts.length < 2) return null;
  return (
    <span className="flex gap-1">
      <Button
        variant="quiet"
        size="sm"
        disabled={i === 0}
        title="Lower slot number"
        onClick={() => move(-1)}
      >
        ↑
      </Button>
      <Button
        variant="quiet"
        size="sm"
        disabled={i === accounts.length - 1}
        title="Higher slot number"
        onClick={() => move(1)}
      >
        ↓
      </Button>
    </span>
  );
}

function SignatureSection({ email }: { email: string }) {
  const signatures = useSettings((s) => s.settings.signatures);
  const saved = signatures[email] ?? "";
  const [draft, setDraft] = useState(saved);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(signatures[email] ?? "");
    setDirty(false);
  }, [email, signatures]);

  const commit = () => {
    if (!dirty || draft === saved) return;
    void useSettings
      .getState()
      .save({ signatures: { ...signatures, [email]: draft } });
    useReceipt.getState().note("Signature saved", () =>
      useSettings.getState().save({ signatures: { ...signatures, [email]: saved } })
    );
    setDirty(false);
  };

  return (
    <section>
      <div className="mx-0.5 mb-2 flex items-baseline gap-2.5">
        <h2 className="text-[13px] font-semibold text-ink">Signature</h2>
        <span className="text-[11.5px] text-ink-3">
          Used on every message sent from this address
        </span>
        <div className="flex-1" />
        <span className="text-[11px] text-ink-3">
          {dirty ? "unsaved — click away to commit" : "saved"}
        </span>
      </div>
      <div
        onBlur={commit}
        className="overflow-hidden rounded-lg border border-line bg-surface"
      >
        <div className="px-3.5 py-3">
          <SignatureEditor
            value={draft}
            onChange={(html) => {
              setDraft(html);
              setDirty(true);
            }}
          />
        </div>
        <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[11.5px] text-ink-3">
          <span>Commits when you click away — Ctrl+Z undoes it.</span>
          <div className="flex-1" />
          <Button variant="quiet" size="sm" onClick={commit} disabled={!dirty}>
            Save now
          </Button>
        </div>
      </div>
    </section>
  );
}

function SendAsSection({ email }: { email: string }) {
  const [aliases, setAliases] = useState<SendAsAlias[] | null>(null);
  useEffect(() => {
    setAliases(null);
    void backend
      .getSendAs(email)
      .then(setAliases)
      .catch(() => setAliases([]));
  }, [email]);

  if (!aliases || aliases.length <= 1) return null;
  return (
    <RowGroup
      title="Send-as addresses"
      action={<span className="text-[11.5px] text-ink-3">From Gmail, read-only</span>}
    >
      {aliases.map((a) => (
        <SettingRow
          key={a.email}
          label={a.email}
          help={a.displayName || undefined}
        >
          {a.isDefault && <Pill tone="accent">default</Pill>}
          {!a.verified && <Pill tone="warning">unverified</Pill>}
          {a.hasSignature && <Pill tone="neutral">own signature</Pill>}
        </SettingRow>
      ))}
    </RowGroup>
  );
}

/** Two-step, because it deletes this account's local mail. */
function DisconnectRow({ account }: { account: AccountInfo }) {
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);

  const disconnect = async () => {
    setPending(true);
    try {
      await backend.disconnect(account.email);
      // the removed account's lists/threads must not keep painting from memory
      clearMailCaches();
      await useSettings.getState().refreshAccounts();
      await useMail.getState().refresh();
      useUi.getState().setSettingsTab("general");
    } catch (e) {
      useUi.getState().showToast(`Couldn't remove ${account.email}: ${String(e)}`);
      await useSettings.getState().refreshAccounts();
    } finally {
      setPending(false);
      setArmed(false);
    }
  };

  return (
    <>
      <SettingRow
        label="Disconnect"
        tone="danger"
        help="Revokes the token with Google and deletes this account's local mail. Your mail stays in Gmail."
      >
        {account.removing ? (
          <span className="flex items-center gap-2 whitespace-nowrap text-[12px] text-ink-3">
            <span className="zb-spin inline-block h-3 w-3 rounded-full border-2 border-line-strong border-t-accent" />
            Removing…
          </span>
        ) : (
          <Button variant="danger" size="sm" onClick={() => setArmed(!armed)}>
            {armed ? "Cancel" : "Disconnect"}
          </Button>
        )}
      </SettingRow>
      {armed && !account.removing && (
        <WideRow>
          <div className="flex items-center gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2">
            <span className="flex-1 text-[12px] text-ink-2">
              Remove {account.email}? Its locally synced mail is deleted from this
              device.
            </span>
            <Button
              variant="danger"
              size="sm"
              disabled={pending}
              onClick={() => void disconnect()}
            >
              {pending ? "Removing…" : "Remove account"}
            </Button>
          </div>
        </WideRow>
      )}
    </>
  );
}

/** Header avatar with an override: click to pick a new photo, × resets to the
 *  Google one (or the monogram). */
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
        if (f) useUi.getState().showToast("Keep the photo under 1 MB.");
        return;
      }
      const r = new FileReader();
      r.onload = () => void useProfiles.getState().setPhoto(email, String(r.result));
      r.readAsDataURL(f);
    };
    input.click();
  };

  return (
    <span
      className="relative shrink-0 cursor-pointer"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={pick}
      title="Click to change the photo"
    >
      <Avatar
        name={profile?.name ?? email}
        email={email}
        src={profile?.picture}
        size={44}
      />
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

// ------------------------------------------------------------- add account

export function AddAccountPane() {
  const [clientStored, setClientStored] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void backend.hasGmailClient().then(setClientStored).catch(() => {});
  }, []);

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

  return (
    <>
      <RowGroup
        title="Add a Gmail account"
        hint={
          clientStored
            ? "Your OAuth client is already in the Windows Credential Manager — leave the fields blank and hit Connect. Add as many Gmail accounts as you like with the same client."
            : "Paste the OAuth client from Google Cloud Console (Desktop app type, Gmail API enabled — step by step in docs/SETUP.md). It's stored in the Windows Credential Manager, never on disk."
        }
      >
        <WideRow>
          <div className="space-y-2">
            <input
              className={inputCls}
              placeholder={
                clientStored
                  ? "Client ID (stored — leave blank to reuse)"
                  : "Client ID (…apps.googleusercontent.com)"
              }
              value={clientId}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => setClientId(e.target.value)}
            />
            <input
              className={inputCls}
              type="password"
              placeholder={
                clientStored
                  ? "Client secret (stored — leave blank to reuse)"
                  : "Client secret"
              }
              value={clientSecret}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => setClientSecret(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="primary"
                size="sm"
                disabled={
                  busy ||
                  !isTauri ||
                  (!clientStored && (!clientId.trim() || !clientSecret.trim()))
                }
                onClick={() => void connect()}
              >
                {busy ? "Waiting for browser consent…" : "Connect Gmail"}
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
      </RowGroup>

      <RowGroup title="Add an Outlook account">
        <SettingRow
          label="Microsoft Graph"
          help="Scaffolded, lands next release. It will use an Azure app registration (public client + PKCE, Mail.ReadWrite + Mail.Send) the same way Gmail uses its OAuth client."
        >
          <Button variant="secondary" size="sm" disabled>
            Coming next release
          </Button>
        </SettingRow>
      </RowGroup>
    </>
  );
}
