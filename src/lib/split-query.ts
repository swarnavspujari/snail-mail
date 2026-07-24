// Split-inbox query language — TypeScript mirror of src-tauri/src/splits.rs.
// The Rust side is the real classifier (membership is materialized into the
// DB at sync time); this mirror exists for the browser-demo MockBackend and
// for instant validation in the split editor. Both implementations are held
// together by fixtures/split-query-cases.json (run by split-query.test.ts and
// the Rust conformance test) — change semantics in BOTH places or the
// fixtures will fail one of them.

import type { Split, Thread } from "./types";

export type SplitField = "from" | "to" | "subject" | "label" | "any";

export type SplitNode =
  | { kind: "or"; nodes: SplitNode[] }
  | { kind: "and"; nodes: SplitNode[] }
  | { kind: "term"; field: SplitField; value: string };

// ---------------------------------------------------------------- tokenize

type Tok = { kind: "l" } | { kind: "r" } | { kind: "word"; word: string };

function tokenize(q: string): Tok[] {
  const out: Tok[] = [];
  let cur = "";
  let inQ = false;
  const flush = () => {
    if (cur) out.push({ kind: "word", word: cur });
    cur = "";
  };
  for (const c of q) {
    if (c === '"') {
      inQ = !inQ;
      cur += '"';
    } else if ((c === "(" || c === ")") && !inQ) {
      flush();
      out.push({ kind: c === "(" ? "l" : "r" });
    } else if (/\s/.test(c) && !inQ) {
      flush();
    } else {
      cur += c;
    }
  }
  if (inQ) throw new Error("unclosed quote");
  flush();
  return out;
}

const unquote = (s: string) => s.replace(/^"+|"+$/g, "").trim();

// ------------------------------------------------------------------ parse

/** Parse a split definition. null = empty query = the catch-all. Throws with
 *  a user-facing message on a bad query. */
export function parseSplitQuery(q: string): SplitNode | null {
  const toks = tokenize(q);
  if (toks.length === 0) return null;
  const pos = { i: 0 };
  const node = parseOr(toks, pos);
  if (pos.i !== toks.length) throw new Error("unexpected ')' — check your parentheses");
  return node;
}

const isKw = (t: Tok | undefined, kw: string): boolean =>
  !!t && t.kind === "word" && t.word.toLowerCase() === kw;

function parseOr(toks: Tok[], pos: { i: number }): SplitNode {
  const nodes = [parseAnd(toks, pos)];
  while (isKw(toks[pos.i], "or")) {
    pos.i++;
    nodes.push(parseAnd(toks, pos));
  }
  return nodes.length === 1 ? nodes[0] : { kind: "or", nodes };
}

function parseAnd(toks: Tok[], pos: { i: number }): SplitNode {
  const nodes = [parsePrimary(toks, pos)];
  for (;;) {
    const t = toks[pos.i];
    if (isKw(t, "and")) {
      pos.i++;
      nodes.push(parsePrimary(toks, pos));
    } else if ((t?.kind === "word" && !isKw(t, "or")) || t?.kind === "l") {
      // adjacency = AND, Gmail-style: `from:acme.com subject:board`
      nodes.push(parsePrimary(toks, pos));
    } else {
      break;
    }
  }
  return nodes.length === 1 ? nodes[0] : { kind: "and", nodes };
}

function parsePrimary(toks: Tok[], pos: { i: number }): SplitNode {
  const t = toks[pos.i];
  if (t?.kind === "l") {
    pos.i++;
    const node = parseOr(toks, pos);
    if (toks[pos.i]?.kind !== "r") throw new Error("missing ')'");
    pos.i++;
    return node;
  }
  if (t?.kind === "word") {
    pos.i++;
    return term(t.word);
  }
  throw new Error("incomplete query — a term is missing");
}

function term(word: string): SplitNode {
  const lower = word.toLowerCase();
  if (lower === "and" || lower === "or") {
    throw new Error(`'${word}' needs something on both sides`);
  }
  if (!word.startsWith('"')) {
    const m = /^([A-Za-z]+):(.*)$/.exec(word);
    if (m) {
      const op = m[1].toLowerCase();
      if (op !== "from" && op !== "to" && op !== "subject" && op !== "label") {
        throw new Error(
          `unsupported operator '${op}:' — splits understand from:, to:, subject:, label:`
        );
      }
      const value = unquote(m[2]).toLowerCase();
      if (!value) throw new Error(`'${op}:' needs a value`);
      return { kind: "term", field: op, value };
    }
  }
  const value = unquote(word).toLowerCase();
  if (!value) throw new Error("empty term");
  return { kind: "term", field: "any", value };
}

// ------------------------------------------------------------------ match

export interface SplitFacts {
  senders: string[]; // `Name <email>` or bare address
  recipients: string[];
  subject: string;
  labels: string[];
}

function splitParticipant(raw: string): { name: string; email: string } {
  const t = raw.trim();
  const i = t.indexOf("<");
  if (i >= 0 && t.endsWith(">")) {
    return {
      name: t.slice(0, i).trim().toLowerCase(),
      email: t.slice(i + 1, -1).trim().toLowerCase(),
    };
  }
  return { name: "", email: t.toLowerCase() };
}

/** contains '@' → exact address; contains '.' → the ADDRESS domain equals it
 *  or is a subdomain (display names never satisfy a domain needle); bare word
 *  → substring of address or display name. Mirrors splits.rs exactly. */
function personMatches(raw: string, needle: string): boolean {
  const { name, email } = splitParticipant(raw);
  if (needle.includes("@")) return email === needle;
  if (needle.includes(".")) {
    const at = email.indexOf("@");
    if (at < 0) return false;
    const dom = email.slice(at + 1);
    return dom === needle || dom.endsWith(`.${needle}`);
  }
  return email.includes(needle) || name.includes(needle);
}

const ci = (hay: string, needle: string) => hay.toLowerCase().includes(needle);

export function matchesSplitQuery(node: SplitNode, f: SplitFacts): boolean {
  switch (node.kind) {
    case "or":
      return node.nodes.some((n) => matchesSplitQuery(n, f));
    case "and":
      return node.nodes.every((n) => matchesSplitQuery(n, f));
    case "term": {
      const v = node.value;
      switch (node.field) {
        case "from":
          return f.senders.some((p) => personMatches(p, v));
        case "to":
          return f.recipients.some((p) => personMatches(p, v));
        case "subject":
          return ci(f.subject, v);
        // substring keeps legacy `contains` semantics and lets
        // `label:promotions` reach CATEGORY_PROMOTIONS
        case "label":
          return f.labels.some((l) => ci(l, v));
        case "any":
          return (
            ci(f.subject, v) ||
            f.senders.some((p) => ci(p, v)) ||
            f.recipients.some((p) => ci(p, v))
          );
      }
    }
  }
}

// --------------------------------------------------------------- classify

interface CompiledSplit {
  id: string;
  node: SplitNode | null;
  catchAll: boolean;
  alsoShow: boolean;
}

/** Splits visible to `account`, in settings order, parsed once. A saved query
 *  that no longer parses compiles to never-matching (save validates, so this
 *  is a belt-and-braces guard, mirroring splits.rs). */
export function compileSplits(splits: Split[], account: string): CompiledSplit[] {
  return splits
    .filter((s) => s.accountId == null || s.accountId === account)
    .map((s) => {
      const q = s.query.trim();
      if (!q) return { id: s.id, node: null, catchAll: true, alsoShow: s.alsoShow };
      try {
        return { id: s.id, node: parseSplitQuery(q), catchAll: false, alsoShow: s.alsoShow };
      } catch {
        return { id: s.id, node: null, catchAll: false, alsoShow: s.alsoShow };
      }
    });
}

export function threadFacts(t: Thread): SplitFacts {
  return {
    senders: t.participants,
    recipients: t.recipients,
    subject: t.subject,
    labels: t.labels,
  };
}

/** First matching split (settings order) is home; the catch-all takes the
 *  rest. alsoShow forwards to where the thread would otherwise have landed —
 *  the next matching split, else the catch-all (Important-or-Other with the
 *  default ordering). Mirrors splits.rs classify(). */
export function classifySplits(
  specs: CompiledSplit[],
  f: SplitFacts
): { split: string; alsoIn: string[] } {
  const catchAll = () => specs.find((s) => s.catchAll)?.id ?? "other";
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    if (!s.node) continue;
    if (matchesSplitQuery(s.node, f)) {
      const alsoIn: string[] = [];
      if (s.alsoShow) {
        const target =
          specs
            .slice(i + 1)
            .find((x) => x.node && matchesSplitQuery(x.node, f))?.id ?? catchAll();
        if (target !== s.id) alsoIn.push(target);
      }
      return { split: s.id, alsoIn };
    }
  }
  return { split: catchAll(), alsoIn: [] };
}

/** The catch-all split's id for an account's visible splits ("other" unless
 *  the user made their own). Unclassified threads ("" — pre-migration rows
 *  the boot backfill hasn't reached) file here. */
export function catchAllSplitId(splits: Split[], account: string): string {
  return (
    splits.find(
      (s) => (s.accountId == null || s.accountId === account) && !s.query.trim()
    )?.id ?? "other"
  );
}

/** Membership test over the MATERIALIZED fields — the one predicate the UI,
 *  ZeroSweep prediction, and the mock's list paths share. */
export function threadInSplit(
  t: Thread,
  splitId: string,
  splits: Split[],
  account: string
): boolean {
  if (t.split === splitId) return true;
  if (t.alsoIn.includes(splitId)) return true;
  return t.split === "" && splitId === catchAllSplitId(splits, account);
}

// -------------------------------------------------------------- migration

/** v0.23: legacy structured rules -> query string (mirrors splits.rs
 *  query_from_rules; unknown fields fall back to `from`). */
export function queryFromRules(
  rules: { field: string; contains: string }[],
  op: string
): string {
  const joiner = op === "and" ? " AND " : " OR ";
  return rules
    .filter((r) => r.contains.trim())
    .map((r) => {
      const field = ["to", "subject", "label"].includes(r.field) ? r.field : "from";
      const v = r.contains.trim().replace(/"/g, "");
      return /\s/.test(v) ? `${field}:"${v}"` : `${field}:${v}`;
    })
    .join(joiner);
}
