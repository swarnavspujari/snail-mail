// The pure core behind recipient chips. Everything drag does is moveRecipient
// or transferRecipient, so reordering is covered without a DOM — and the
// legacy-string path is covered because a draft written before this model
// still holds one, and throwing on it takes out the drafts picker.
import { describe, expect, test } from "vitest";
import {
  addRecipients,
  addrSpec,
  displayLabel,
  isPlausibleAddress,
  moveRecipient,
  normalizeRecipients,
  parseRecipientText,
  removeRecipient,
  splitTypedRecipients,
  transferRecipient,
} from "./recipients";

describe("splitTypedRecipients", () => {
  test("a trailing separator closes the token and empties the tail", () => {
    expect(splitTypedRecipients("a@x.com,")).toEqual({ done: ["a@x.com"], rest: "" });
  });

  test("text after the last separator stays in the field", () => {
    expect(splitTypedRecipients("a@x.com, bo")).toEqual({
      done: ["a@x.com"],
      rest: " bo",
    });
  });

  test("nothing closes without a separator", () => {
    expect(splitTypedRecipients("a@x.com")).toEqual({ done: [], rest: "a@x.com" });
  });

  test("a comma inside a quoted name does not close a token", () => {
    expect(splitTypedRecipients('"Doe, Jane" <j@x.com>')).toEqual({
      done: [],
      rest: '"Doe, Jane" <j@x.com>',
    });
  });
});

describe("parseRecipientText", () => {
  test("splits on commas and semicolons", () => {
    expect(parseRecipientText("a@x.com, b@x.com; c@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
    ]);
  });

  test("keeps a display name containing a comma whole", () => {
    // The exact ambiguity chips exist to remove: the old code split this into
    // `"Doe` and `Jane" <j@x.com>` and had to drop the name to stay correct.
    expect(parseRecipientText('"Doe, Jane" <j@x.com>, b@x.com')).toEqual([
      '"Doe, Jane" <j@x.com>',
      "b@x.com",
    ]);
  });

  test("does not split inside angle brackets", () => {
    expect(parseRecipientText("Ann <a;b@x.com>")).toEqual(["Ann <a;b@x.com>"]);
  });

  test("newlines separate too (pasting a column of addresses)", () => {
    expect(parseRecipientText("a@x.com\nb@x.com\n")).toEqual(["a@x.com", "b@x.com"]);
  });

  test("blank input yields nothing", () => {
    expect(parseRecipientText("   ,  ; ")).toEqual([]);
  });
});

describe("normalizeRecipients", () => {
  test("a legacy comma-separated string becomes tokens", () => {
    expect(normalizeRecipients("a@x.com, Ann <b@x.com>")).toEqual([
      "a@x.com",
      "Ann <b@x.com>",
    ]);
  });

  test("an array passes through, trimmed and de-blanked", () => {
    expect(normalizeRecipients([" a@x.com ", "", "b@x.com"])).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
  });

  test("missing or junk fields answer empty rather than throwing", () => {
    // A draft row predating Bcc has no bcc at all; a corrupt one can hold
    // anything. Neither may take the picker down.
    expect(normalizeRecipients(undefined)).toEqual([]);
    expect(normalizeRecipients(null)).toEqual([]);
    expect(normalizeRecipients(42)).toEqual([]);
    expect(normalizeRecipients([1, "a@x.com", null])).toEqual(["a@x.com"]);
  });
});

describe("addrSpec / displayLabel", () => {
  test("pulls the address out of an angle-bracket token", () => {
    expect(addrSpec("Ann Lee <ann@x.com>")).toBe("ann@x.com");
    expect(addrSpec("ann@x.com")).toBe("ann@x.com");
  });

  test("labels prefer the friendly name, unquoted", () => {
    expect(displayLabel('"Doe, Jane" <j@x.com>')).toBe("Doe, Jane");
    expect(displayLabel("<j@x.com>")).toBe("j@x.com");
    expect(displayLabel("j@x.com")).toBe("j@x.com");
  });
});

describe("isPlausibleAddress", () => {
  test("accepts ordinary addresses, with or without a name", () => {
    expect(isPlausibleAddress("ann@example.com")).toBe(true);
    expect(isPlausibleAddress("Ann Lee <ann@example.co.uk>")).toBe(true);
    expect(isPlausibleAddress("a+tag@sub.example.com")).toBe(true);
  });

  test("flags the typos a chip should show", () => {
    expect(isPlausibleAddress("ann")).toBe(false);
    expect(isPlausibleAddress("ann@localhost")).toBe(false);
    expect(isPlausibleAddress("@example.com")).toBe(false);
    expect(isPlausibleAddress("ann@")).toBe(false);
    expect(isPlausibleAddress("ann @example.com")).toBe(false);
  });
});

describe("addRecipients", () => {
  test("appends and skips case-insensitive duplicates", () => {
    expect(addRecipients(["a@x.com"], ["B@x.com", "a@X.com"])).toEqual([
      "a@x.com",
      "B@x.com",
    ]);
  });

  test("a duplicate differing only by display name is still a duplicate", () => {
    expect(addRecipients(["Ann <a@x.com>"], ["a@x.com"])).toEqual(["Ann <a@x.com>"]);
  });

  test("returns the same array when nothing was added", () => {
    const list = ["a@x.com"];
    expect(addRecipients(list, ["  ", "a@x.com"])).toBe(list);
  });
});

describe("moveRecipient", () => {
  const list = ["a", "b", "c", "d"];

  test("moves forward", () => {
    expect(moveRecipient(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
  });

  test("moves backward", () => {
    expect(moveRecipient(list, 3, 1)).toEqual(["a", "d", "b", "c"]);
  });

  test("a no-op move returns the same array", () => {
    expect(moveRecipient(list, 1, 1)).toBe(list);
  });

  test("out-of-range indices are clamped or ignored, never thrown", () => {
    expect(moveRecipient(list, 0, 99)).toEqual(["b", "c", "d", "a"]);
    expect(moveRecipient(list, 99, 0)).toBe(list);
    expect(moveRecipient([], 0, 0)).toEqual([]);
  });
});

describe("removeRecipient", () => {
  test("drops the indexed chip", () => {
    expect(removeRecipient(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });

  test("an out-of-range index changes nothing", () => {
    const list = ["a"];
    expect(removeRecipient(list, 5)).toBe(list);
  });
});

describe("transferRecipient", () => {
  const fields = { to: ["a@x.com", "b@x.com"], cc: ["c@x.com"], bcc: [] as string[] };

  test("a drop on its own field is a reorder", () => {
    const next = transferRecipient(fields, { field: "to", index: 0 }, { field: "to", index: 1 });
    expect(next.to).toEqual(["b@x.com", "a@x.com"]);
    expect(next.cc).toEqual(["c@x.com"]);
  });

  test("a cross-field drop moves the chip out of the source", () => {
    const next = transferRecipient(fields, { field: "to", index: 0 }, { field: "bcc", index: 0 });
    expect(next.to).toEqual(["b@x.com"]);
    expect(next.bcc).toEqual(["a@x.com"]);
  });

  test("dropping at an index inserts there, not at the end", () => {
    const next = transferRecipient(
      { ...fields, cc: ["c@x.com", "d@x.com"] },
      { field: "to", index: 0 },
      { field: "cc", index: 1 }
    );
    expect(next.cc).toEqual(["c@x.com", "a@x.com", "d@x.com"]);
  });

  test("dragging onto a field that already holds the address just removes it", () => {
    // Otherwise a To -> Cc drag would leave the same person in both.
    const next = transferRecipient(
      { to: ["Ann <a@x.com>"], cc: ["a@x.com"], bcc: [] },
      { field: "to", index: 0 },
      { field: "cc", index: 0 }
    );
    expect(next.to).toEqual([]);
    expect(next.cc).toEqual(["a@x.com"]);
  });

  test("an impossible source leaves everything alone", () => {
    expect(transferRecipient(fields, { field: "to", index: 9 }, { field: "cc", index: 0 })).toBe(
      fields
    );
  });
});
