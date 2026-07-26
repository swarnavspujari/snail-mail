import { describe, expect, test } from "vitest";
import { addressOf, introGreetingName, introRecipients } from "./intro-forward";

const ME = "me@mine.com";

describe("introRecipients", () => {
  test("the introducer moves to Bcc and the Cc'd party becomes To", () => {
    const r = introRecipients(
      { from: "connector@x.com", to: [ME], cc: ["Ada <ada@y.com>"] },
      ME
    );
    expect(r.to).toEqual(["Ada <ada@y.com>"]);
    expect(r.bcc).toEqual(["connector@x.com"]);
  });

  test("with no Cc, the other To recipients are the introduced party", () => {
    const r = introRecipients(
      { from: "connector@x.com", to: [ME, "Ada <ada@y.com>", "bob@z.com"], cc: [] },
      ME
    );
    expect(r.to).toEqual(["Ada <ada@y.com>", "bob@z.com"]);
    expect(r.bcc).toEqual(["connector@x.com"]);
  });

  test("your own address never survives into To, in either field", () => {
    const r = introRecipients(
      { from: "connector@x.com", to: [`Me <${ME}>`], cc: [ME.toUpperCase(), "ada@y.com"] },
      ME
    );
    expect(r.to).toEqual(["ada@y.com"]);
  });

  test("the introducer is not left in To while also being Bcc'd", () => {
    // Some introducers put themselves in Cc as well as sending.
    const r = introRecipients(
      { from: "Connector <connector@x.com>", to: [ME], cc: ["connector@x.com", "ada@y.com"] },
      ME
    );
    expect(r.to).toEqual(["ada@y.com"]);
    expect(r.bcc).toEqual(["Connector <connector@x.com>"]);
  });

  test("duplicates across the pool collapse, original order kept", () => {
    const r = introRecipients(
      {
        from: "connector@x.com",
        to: [],
        cc: ["Zoe <zoe@y.com>", "ada@y.com", "ZOE@y.com"],
      },
      ME
    );
    expect(r.to).toEqual(["Zoe <zoe@y.com>", "ada@y.com"]);
  });

  test("a Cc holding only you falls back to To rather than opening blank", () => {
    const r = introRecipients(
      { from: "connector@x.com", to: ["ada@y.com"], cc: [ME] },
      ME
    );
    expect(r.to).toEqual(["ada@y.com"]);
  });

  test("nobody to introduce yields an empty To, not a malformed one", () => {
    const r = introRecipients({ from: "connector@x.com", to: [ME], cc: [] }, ME);
    expect(r.to).toEqual([]);
    expect(r.bcc).toEqual(["connector@x.com"]);
  });
});

describe("introGreetingName", () => {
  test("first name only", () => {
    expect(introGreetingName("Pierluigi Vinciguerra")).toBe("Pierluigi");
  });

  test("placeholder when the contact has no usable name", () => {
    // An address masquerading as a display name tells us nothing, so the
    // sentence keeps an obviously-fillable gap instead of "Thanks bob@x.com,".
    expect(introGreetingName("bob@x.com")).toBe("[Name]");
    expect(introGreetingName("")).toBe("[Name]");
    expect(introGreetingName(null)).toBe("[Name]");
  });

  test('quoted "Last, First" style does not leak punctuation', () => {
    expect(introGreetingName('"Vinciguerra, Pierluigi"')).toBe("Vinciguerra");
  });
});

describe("addressOf", () => {
  test("unwraps angle brackets and lowercases", () => {
    expect(addressOf("Ada <Ada@Y.com>")).toBe("ada@y.com");
    expect(addressOf("  bob@z.com ")).toBe("bob@z.com");
  });
});
