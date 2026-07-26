// "Double-opt-in intro" reply (Ctrl+Shift+I).
//
// The move this automates: someone introduces you to a person, and you reply
// to the *introduced* party while dropping the introducer to Bcc so the rest
// of the thread stops landing in their inbox. Doing it by hand means retyping
// three recipient fields correctly every time, in the one situation where
// getting Bcc wrong is embarrassing in public.

/** Bare address out of `Name <a@b.c>` / `<a@b.c>` / `a@b.c`. */
export function addressOf(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

/** First name for the greeting. Falls back to the literal `[Name]` so the
 *  sentence stays grammatical and the gap is obviously a placeholder to fill —
 *  better than silently addressing someone as their email address. */
export function introGreetingName(fromName: string | null | undefined): string {
  const n = (fromName ?? "").trim();
  // A display name that is really just the address tells us nothing.
  if (!n || n.includes("@")) return "[Name]";
  const first = n.split(/\s+/)[0].replace(/[",]/g, "").trim();
  return first || "[Name]";
}

export interface IntroTarget {
  /** The message's sender — the introducer, who moves to Bcc. */
  from: string;
  to: string[];
  cc: string[];
}

export interface IntroRecipients {
  to: string[];
  bcc: string[];
}

/**
 * Who goes where.
 *
 * - The sender is always Bcc'd — that is the whole point of the gesture.
 * - The people being introduced are whoever the sender put in **Cc**; when
 *   there is no Cc, they are the other **To** recipients instead. (Introducers
 *   use both conventions and the user gets no say in which.)
 * - Your own address never survives into To. You are the one replying.
 *
 * Preserves the sender's ordering, because that ordering often encodes who the
 * introduction is actually *for*.
 */
export function introRecipients(target: IntroTarget, me: string): IntroRecipients {
  const meAddr = addressOf(me);
  const fromAddr = addressOf(target.from);

  const pool = target.cc.length > 0 ? target.cc : target.to;
  const seen = new Set<string>();
  const to: string[] = [];
  for (const raw of pool) {
    const a = addressOf(raw);
    // Drop yourself and the introducer; the latter is going to Bcc and must
    // not also sit in To, which would defeat the entire manoeuvre.
    if (!a || a === meAddr || a === fromAddr || seen.has(a)) continue;
    seen.add(a);
    to.push(raw);
  }

  // A Cc that contained only you (or only the sender) would otherwise produce
  // an empty To — fall back to the other field rather than open a blank reply.
  if (to.length === 0 && target.cc.length > 0) {
    for (const raw of target.to) {
      const a = addressOf(raw);
      if (!a || a === meAddr || a === fromAddr || seen.has(a)) continue;
      seen.add(a);
      to.push(raw);
    }
  }

  return { to, bcc: [target.from] };
}
