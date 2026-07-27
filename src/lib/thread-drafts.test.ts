// Projecting stored drafts back onto the thread they were written in.
//
// The payload is an opaque JSON blob written by whatever version of compose
// saved it, so the parsing here has to survive schema drift and outright
// corruption without losing the row — a draft is work the user did.
import { describe, expect, test } from "vitest";
import {
  draftPreview,
  draftRecipientLabel,
  draftsByThread,
  draftsForThread,
  parseDraft,
} from "./thread-drafts";
import type { DraftEntry } from "./types";

// `payload` is widened to unknown so a case can pass the object it means and
// have it stringified here, or pass a raw string to exercise a corrupt row.
function entry(
  over: Omit<Partial<DraftEntry>, "payload"> & { payload?: unknown }
): DraftEntry {
  const { payload, ...rest } = over;
  return {
    id: 1,
    account: "you@snail.local",
    updatedAt: 1000,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload ?? {}),
    ...rest,
  } as DraftEntry;
}

describe("parseDraft", () => {
  test("reads a modern payload", () => {
    const d = parseDraft(
      entry({
        payload: {
          threadId: "t1",
          to: ["Steven Zhang <steven.q.zhang@gmail.com>"],
          subject: "Re: Small Bets",
          body: "<p>Hello hello</p>",
        },
      })
    );
    expect(d.threadId).toBe("t1");
    expect(d.subject).toBe("Re: Small Bets");
    expect(d.preview).toBe("Hello hello");
  });

  test("a legacy comma-separated `to` still yields recipients", () => {
    // Recipients were a single string before chips landed; calling array
    // methods on it once took out the whole Drafts picker.
    const d = parseDraft(entry({ payload: { threadId: "t1", to: "a@x.com, b@x.com" } }));
    expect(d.to).toHaveLength(2);
  });

  test("a corrupt payload survives as an empty draft rather than throwing", () => {
    const d = parseDraft(entry({ payload: "{not json" }));
    expect(d.payload).toBeNull();
    expect(d.threadId).toBeNull();
    expect(d.to).toEqual([]);
  });

  test("a payload that parses to a non-object is treated as corrupt", () => {
    expect(parseDraft(entry({ payload: "42" })).payload).toBeNull();
    expect(parseDraft(entry({ payload: "null" })).payload).toBeNull();
  });
});

describe("draftPreview", () => {
  test("flattens HTML to one plain line", () => {
    expect(draftPreview("<p>One</p><p>Two</p>")).toBe("One Two");
    expect(draftPreview("a<br>b")).toBe("a b");
  });

  test("decodes the entities compose actually emits", () => {
    expect(draftPreview("<p>Tom &amp; Jerry&nbsp;&lt;3</p>")).toBe("Tom & Jerry <3");
  });

  test("an empty or non-string body is an empty preview", () => {
    expect(draftPreview("<p></p>")).toBe("");
    expect(draftPreview(undefined)).toBe("");
    expect(draftPreview(12)).toBe("");
  });
});

describe("draftsForThread", () => {
  const drafts = [
    entry({ id: 1, updatedAt: 300, payload: { threadId: "t1", body: "<p>later</p>" } }),
    entry({ id: 2, updatedAt: 100, payload: { threadId: "t1", body: "<p>earlier</p>" } }),
    entry({ id: 3, updatedAt: 200, payload: { threadId: "t2", body: "<p>other</p>" } }),
    entry({ id: 4, updatedAt: 250, payload: { threadId: null, body: "<p>new msg</p>" } }),
  ];

  test("returns only this thread's drafts, oldest first", () => {
    expect(draftsForThread(drafts, "t1").map((d) => d.id)).toEqual([2, 1]);
  });

  test("a fresh compose (no thread) belongs to no thread", () => {
    expect(draftsForThread(drafts, "t3")).toEqual([]);
  });
});

describe("draftsByThread", () => {
  test("one row per thread — the most recently touched", () => {
    const map = draftsByThread([
      entry({ id: 1, updatedAt: 100, payload: { threadId: "t1", body: "<p>old</p>" } }),
      entry({ id: 2, updatedAt: 900, payload: { threadId: "t1", body: "<p>new</p>" } }),
    ]);
    expect(map.size).toBe(1);
    expect(map.get("t1")?.preview).toBe("new");
  });

  test("threadless drafts never claim a row", () => {
    expect(draftsByThread([entry({ payload: { threadId: null } })]).size).toBe(0);
  });
});

describe("draftRecipientLabel", () => {
  test("prefers display names", () => {
    expect(draftRecipientLabel(["Steven Zhang <s@x.com>"])).toBe("Steven Zhang");
  });

  test("falls back to the address when there is no name", () => {
    expect(draftRecipientLabel(["s@x.com"])).toBe("s@x.com");
  });

  test("summarises a crowd rather than overflowing the column", () => {
    expect(draftRecipientLabel(["A <a@x>", "B <b@x>", "C <c@x>", "D <d@x>"])).toBe(
      "A, B +2"
    );
  });

  test("no recipients yet is empty, not 'to undefined'", () => {
    expect(draftRecipientLabel([])).toBe("");
  });
});
