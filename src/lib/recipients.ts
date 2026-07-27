// Recipient lists as arrays, and the pure operations chips need.
//
// Compose used to hold To/Cc/Bcc as single comma-separated strings, which made
// every read a parse and every write a join — and made a display name
// containing a comma unrepresentable (RecipientInput worked around it by
// throwing the name away). The model is now `string[]`: one token per
// recipient, each `"Name <a@b.c>"` or a bare address. Strings survive only at
// two edges — a legacy draft payload on the way in, and nothing on the way out
// (OutgoingMail was always arrays).
//
// Everything drag does is moveRecipient or transferRecipient, so reordering
// tests without a DOM.

export type Recipients = string[];

/** The lists a drag session spans — To/Cc/Bcc in compose, a single "guests"
 *  list in the event editor. Keyed by field name so one group can serve both. */
export type RecipientLists = Record<string, Recipients>;

/** Where a chip is, or is being dropped. */
export interface ChipSlot {
  field: string;
  index: number;
}

/** Split text into the tokens a separator has already closed (`done`) and the
 *  tail still being typed (`rest`). Commas and semicolons separate, but only
 *  OUTSIDE angle brackets and quotes: `"Doe, Jane" <j@x.com>` is ONE
 *  recipient, and splitting it was the exact ambiguity chips exist to remove.
 *
 *  The field commits on this, not on a comma keydown: a separator can arrive
 *  by paste, IME, or autofill without ever producing a keystroke. */
export function splitTypedRecipients(raw: string): { done: string[]; rest: string } {
  const done: string[] = [];
  let buf = "";
  let angle = false;
  let quote = false;
  for (const ch of raw) {
    if (ch === '"' && !angle) {
      quote = !quote;
      buf += ch;
    } else if (ch === "<") {
      angle = true;
      buf += ch;
    } else if (ch === ">") {
      angle = false;
      buf += ch;
    } else if ((ch === "," || ch === ";" || ch === "\n") && !angle && !quote) {
      if (buf.trim()) done.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  return { done, rest: buf };
}

/** Every token in the text, closed or not — for a paste, or committing what is
 *  left in the field on Enter or blur. */
export function parseRecipientText(raw: string): string[] {
  const { done, rest } = splitTypedRecipients(raw);
  return rest.trim() ? [...done, rest.trim()] : done;
}

/** Accept whatever a draft payload holds — a legacy comma-separated string, an
 *  array, or nothing — and answer with tokens. Drafts persist ComposeState
 *  verbatim, so rows written before the array model must keep loading forever;
 *  a throw here takes out the drafts picker, and with it access to every
 *  draft. */
export function normalizeRecipients(v: unknown): Recipients {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
  }
  if (typeof v === "string") return parseRecipientText(v);
  return [];
}

/** The bare addr-spec of a token — `"Ann <a@b.c>"` → `a@b.c`. Drive sharing
 *  and Google's attendee list both take addresses only. */
export function addrSpec(token: string): string {
  const m = token.match(/<([^>]+)>/);
  return (m ? m[1] : token).trim();
}

/** The friendly part of a token, else the bare address — the chip's label. */
export function displayLabel(token: string): string {
  const m = token.match(/^(.*?)<(.+?)>$/);
  if (m) return m[1].trim().replace(/^["']|["']$/g, "") || m[2].trim();
  return token.trim();
}

/** Loose enough to accept anything a mail server might, strict enough to catch
 *  a typo. Deliberately NOT a send gate — a chip this rejects still sends, and
 *  Gmail rejects it exactly as it does today. No regex gets to make an address
 *  unsendable. */
export function isPlausibleAddress(token: string): boolean {
  const addr = addrSpec(token);
  if (!addr || /\s/.test(addr)) return false;
  const at = addr.lastIndexOf("@");
  if (at <= 0 || at === addr.length - 1) return false;
  const domain = addr.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

/** Append tokens, dropping blanks and case-insensitive duplicates of what is
 *  already there. Returns the same array when nothing was added, so React
 *  identity checks stay meaningful. */
export function addRecipients(list: Recipients, tokens: string[]): Recipients {
  const seen = new Set(list.map((t) => addrSpec(t).toLowerCase()));
  const added: string[] = [];
  for (const t of tokens) {
    const trimmed = t.trim();
    if (!trimmed) continue;
    const key = addrSpec(trimmed).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(trimmed);
  }
  return added.length === 0 ? list : [...list, ...added];
}

export function removeRecipient(list: Recipients, index: number): Recipients {
  if (index < 0 || index >= list.length) return list;
  return list.filter((_, i) => i !== index);
}

/** Move a chip within one field. `to` is the destination index in the list as
 *  it stands BEFORE the move (the drop-target index the UI reports). */
export function moveRecipient(list: Recipients, from: number, to: number): Recipients {
  if (from < 0 || from >= list.length) return list;
  const clamped = Math.max(0, Math.min(to, list.length - 1));
  if (clamped === from) return list;
  const next = [...list];
  const [chip] = next.splice(from, 1);
  next.splice(clamped, 0, chip);
  return next;
}

/** Move a chip between fields. A drop onto its own field is a reorder; a drop
 *  of an address the destination already holds just removes it from the
 *  source, so a To→Cc drag can't leave the same person in both. Returns the
 *  SAME object when nothing moved, so callers can skip the write. */
export function transferRecipient<L extends RecipientLists>(
  lists: L,
  from: ChipSlot,
  to: ChipSlot
): L {
  const source = lists[from.field];
  const dest = lists[to.field];
  if (!source || !dest) return lists;
  if (from.index < 0 || from.index >= source.length) return lists;
  if (from.field === to.field) {
    // The row's trailing drop slot reports `length`; as a destination inside
    // its own list that means the last seat, not one past it.
    const moved = moveRecipient(source, from.index, Math.min(to.index, source.length - 1));
    return moved === source ? lists : { ...lists, [from.field]: moved };
  }
  const chip = source[from.index];
  const at = Math.max(0, Math.min(to.index, dest.length));
  const already = dest.some(
    (t) => addrSpec(t).toLowerCase() === addrSpec(chip).toLowerCase()
  );
  return {
    ...lists,
    [from.field]: removeRecipient(source, from.index),
    [to.field]: already ? dest : [...dest.slice(0, at), chip, ...dest.slice(at)],
  };
}
