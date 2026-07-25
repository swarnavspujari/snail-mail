// What an account's Google grant actually covers, per feature.
//
// The old settings strip said "Reconnect to grant new access" — true, but it
// never said WHICH access, so there was no way to tell a fully-granted account
// from one missing Drive, and no reason to believe reconnecting would help.
// This turns the capability flags into named scopes with a reason each, which is
// what the account pane and the search index both render.
import type { AccountInfo, Capabilities } from "./types";

export interface ScopeState {
  /** Human name, as it reads on Google's consent screen. */
  label: string;
  ok: boolean;
  /** Either "granted" or what the app can't do without it. */
  detail: string;
}

export function grantScopes(
  caps: Capabilities | undefined,
  provider: AccountInfo["provider"]
): ScopeState[] {
  if (provider !== "gmail") {
    return [
      { label: "Mail — read & send", ok: true, detail: "demo data, no grant needed" },
    ];
  }
  // A pre-v0.15 token predates every new scope, whatever the flags say.
  const legacy = caps?.legacyGrant ?? false;
  // Capabilities land one IPC round-trip after the account list; treat unknown
  // as fine so the first paint doesn't accuse every account of being stale.
  const granted = (flag: boolean | undefined) =>
    caps === undefined ? true : !legacy && !!flag;
  return [
    { label: "Mail — read & send", ok: true, detail: "granted at connect" },
    {
      label: "Google Drive",
      ok: granted(caps?.drive),
      detail: granted(caps?.drive) ? "granted" : "needed for large attachments",
    },
    {
      label: "Contacts",
      ok: granted(caps?.contacts),
      detail: granted(caps?.contacts) ? "granted" : "needed for autocomplete",
    },
    {
      label: "Calendar — write",
      ok: granted(caps?.calendarWrite),
      detail: granted(caps?.calendarWrite) ? "granted" : "needed to create events",
    },
  ];
}

/** Scope names for a sentence: "Reconnect to restore Drive and Contacts". */
export function missingScopeNames(scopes: ScopeState[]): string[] {
  return scopes.filter((s) => !s.ok).map((s) => s.label.split(" —")[0]);
}

export function grantHealthy(
  caps: Capabilities | undefined,
  provider: AccountInfo["provider"]
): boolean {
  return missingScopeNames(grantScopes(caps, provider)).length === 0;
}
