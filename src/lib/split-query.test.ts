// Conformance: the TS mirror must agree with src-tauri/src/splits.rs on every
// shared fixture case (the Rust side runs the same file in cargo test).
import { describe, expect, it } from "vitest";
import fixtures from "../../fixtures/split-query-cases.json";
import {
  classifySplits,
  compileSplits,
  matchesSplitQuery,
  parseSplitQuery,
  queryFromRules,
  threadInSplit,
} from "./split-query";
import type { Split, Thread } from "./types";

interface FixThread {
  id: string;
  subject: string;
  participants: string[];
  recipients: string[];
  labels: string[];
}
interface FixCase {
  name: string;
  query: string;
  matches?: string[];
  error?: boolean;
}

const threads = fixtures.threads as FixThread[];
const cases = fixtures.cases as FixCase[];

const facts = (t: FixThread) => ({
  senders: t.participants,
  recipients: t.recipients,
  subject: t.subject,
  labels: t.labels,
});

describe("split query conformance (shared fixtures)", () => {
  for (const c of cases) {
    it(c.name, () => {
      if (c.error) {
        expect(() => parseSplitQuery(c.query)).toThrow();
        return;
      }
      const node = parseSplitQuery(c.query);
      expect(node).not.toBeNull();
      const got = threads
        .filter((t) => matchesSplitQuery(node!, facts(t)))
        .map((t) => t.id)
        .sort();
      expect(got).toEqual([...(c.matches ?? [])].sort());
    });
  }
});

const split = (id: string, query: string, extra: Partial<Split> = {}): Split => ({
  id,
  name: id,
  builtin: id === "important" || id === "other",
  query,
  accountId: null,
  alsoShow: false,
  hideWhenEmpty: false,
  ...extra,
});

const thread = (extra: Partial<Thread>): Thread => ({
  id: "t",
  subject: "",
  snippet: "",
  participants: [],
  recipients: [],
  messageCount: 1,
  lastDate: 0,
  unread: false,
  starred: false,
  labels: [],
  inInbox: true,
  snoozedUntil: null,
  split: "",
  alsoIn: [],
  ...extra,
});

describe("classification (mirrors splits.rs tests)", () => {
  const splits = [
    split("travel", "from:thriftytraveler.com", { alsoShow: true }),
    split("important", "label:IMPORTANT"),
    split("other", ""),
  ];

  it("first match wins; alsoShow forwards to where it would otherwise land", () => {
    const specs = compileSplits(splits, "a@b.com");
    const deal = facts({
      id: "x",
      subject: "sale",
      participants: ["Thrifty Traveler <deals@thriftytraveler.com>"],
      recipients: [],
      labels: ["IMPORTANT"],
    });
    expect(classifySplits(specs, deal)).toEqual({ split: "travel", alsoIn: ["important"] });
    const unlabeled = { ...deal, labels: [] };
    expect(classifySplits(specs, unlabeled)).toEqual({ split: "travel", alsoIn: ["other"] });
    const plain = facts({
      id: "y",
      subject: "hi",
      participants: ["Bob <bob@plain.io>"],
      recipients: [],
      labels: [],
    });
    expect(classifySplits(specs, plain)).toEqual({ split: "other", alsoIn: [] });
  });

  it("account-scoped splits vanish for other accounts", () => {
    const scoped = [split("work", "from:acme.com", { accountId: "work@x.com" }), split("other", "")];
    const f = facts({
      id: "z",
      subject: "hi",
      participants: ["Maya <maya@acme.com>"],
      recipients: [],
      labels: [],
    });
    expect(classifySplits(compileSplits(scoped, "work@x.com"), f).split).toBe("work");
    expect(classifySplits(compileSplits(scoped, "personal@x.com"), f).split).toBe("other");
  });

  it("threadInSplit reads materialized fields and files unclassified under the catch-all", () => {
    expect(threadInSplit(thread({ split: "travel" }), "travel", splits, "a@b")).toBe(true);
    expect(threadInSplit(thread({ split: "x", alsoIn: ["important"] }), "important", splits, "a@b")).toBe(true);
    expect(threadInSplit(thread({ split: "" }), "other", splits, "a@b")).toBe(true);
    expect(threadInSplit(thread({ split: "" }), "important", splits, "a@b")).toBe(false);
  });
});

describe("legacy rules migration", () => {
  it("mirrors splits.rs query_from_rules", () => {
    expect(
      queryFromRules(
        [
          { field: "from", contains: "acme.com" },
          { field: "subject", contains: "board deck" },
        ],
        "or"
      )
    ).toBe('from:acme.com OR subject:"board deck"');
    expect(queryFromRules([{ field: "label", contains: "IMPORTANT" }], "or")).toBe(
      "label:IMPORTANT"
    );
    expect(queryFromRules([{ field: "weird", contains: "x" }], "and")).toBe("from:x");
  });
});
