import type { AccountInfo } from "./types";

/** Desktop with nothing connected shows the connect screen, never a fake inbox.
 *
 *  Accounts flagged `removing` are already gone as far as the UI is concerned:
 *  disconnect returns in milliseconds and tears down in the background, so
 *  counting them would leave the user staring at a dead inbox until the sweep
 *  finished. A `connected: false` account is a *dead grant*, not an absent one —
 *  that case wants the Reconnect banner, so it deliberately does not count as
 *  zero. The browser demo never needs any of this; its accounts come from the
 *  mock, which is why isTauri short-circuits first. */
export function needsConnect(
  isTauri: boolean,
  accounts: AccountInfo[]
): boolean {
  return isTauri && accounts.filter((a) => !a.removing).length === 0;
}
