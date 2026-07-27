// @vitest-environment happy-dom
//
// A draft written before recipients became chips is a comma-joined string, and
// drafts persist ComposeState verbatim — so the shape change has to survive a
// resume. The stake is not cosmetic: a legacy draft that resumes wrong sends
// to the wrong people.
import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  backend: { saveDraft: vi.fn(), searchContacts: vi.fn() },
  isTauri: false,
}));

import { normalizeRecipients } from "@/lib/recipients";
import { composeHasContent, outgoingFromCompose, type ComposeState } from "./ui";

/** What DraftsPicker does to a stored payload on resume. */
function restore(payload: string): ComposeState {
  const parsed = JSON.parse(payload);
  return {
    ...parsed,
    to: normalizeRecipients(parsed.to),
    cc: normalizeRecipients(parsed.cc),
    bcc: normalizeRecipients(parsed.bcc),
    attachments: parsed.attachments ?? [],
    driveLinks: parsed.driveLinks ?? [],
    draftId: 9001,
    draftAccount: "demo@fission.local",
  };
}

/** A row written by v0.25.0 or earlier: strings, and no bcc at all. */
const LEGACY = JSON.stringify({
  mode: "new",
  threadId: null,
  to: 'ann@example.com, "Doe, Jane" <jane@example.com>',
  cc: "cc@example.com",
  subject: "Legacy draft",
  body: "<p>written before chips</p>",
  quote: "",
  attachments: [],
  driveLinks: [],
});

describe("resuming a pre-chips draft", () => {
  test("recipients come back as chips, with the comma'd name intact", () => {
    const c = restore(LEGACY);
    expect(c.to).toEqual(["ann@example.com", '"Doe, Jane" <jane@example.com>']);
    expect(c.cc).toEqual(["cc@example.com"]);
    expect(c.bcc).toEqual([]); // the field predates Bcc entirely
  });

  test("and it sends to exactly those people", () => {
    const out = outgoingFromCompose(restore(LEGACY));
    expect(out.to).toEqual(["ann@example.com", '"Doe, Jane" <jane@example.com>']);
    expect(out.cc).toEqual(["cc@example.com"]);
    expect(out.bcc).toEqual([]);
    expect(out.subject).toBe("Legacy draft");
  });

  test("a corrupt payload degrades to empty rather than throwing", () => {
    // The picker is how you reach every draft; a throw here loses all of them.
    const c = restore(JSON.stringify({ mode: "new", to: 42, subject: "junk", body: "" }));
    expect(c.to).toEqual([]);
    expect(c.cc).toEqual([]);
  });
});

describe("composeHasContent", () => {
  test("a new message with only a recipient is worth saving", () => {
    const c = restore(JSON.stringify({ mode: "new", to: "a@x.com", subject: "", body: "", quote: "" }));
    expect(composeHasContent(c)).toBe(true);
  });

  test("an opened-then-abandoned reply is not", () => {
    // Reply recipients are auto-filled, so they can't be the signal — that is
    // what keeps an untouched reply from leaving a junk draft behind.
    const c = restore(
      JSON.stringify({ mode: "reply", to: "a@x.com", subject: "Re: hi", body: "<p></p>", quote: "" })
    );
    expect(composeHasContent(c)).toBe(false);
  });
});
