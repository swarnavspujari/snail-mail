import { describe, expect, test } from "vitest";
import { reconcilePendingMessages, type PendingMessage } from "./pending";

function pending(over: Partial<PendingMessage>): PendingMessage {
  return {
    localId: "pending-1",
    threadId: "t1",
    from: "you@fission.local",
    fromName: "You",
    to: ["maya@heliosrobotics.io"],
    cc: [],
    subject: "Re: Term sheet",
    bodyHtml: "<p>sounds good</p>",
    bodyText: "sounds good",
    createdAt: 1000,
    status: "sending",
    sentAt: null,
    outboxId: 7,
    outboxAccount: "you@fission.local",
    baselineCount: 2,
    ...over,
  };
}

describe("reconcilePendingMessages", () => {
  test("keeps the pending while the server hasn't delivered yet (Undo Send window)", () => {
    const p = [pending({})];
    // baselineCount 2, server still 2 → nothing landed
    expect(reconcilePendingMessages(p, "t1", 2)).toEqual(p);
  });

  test("drops the pending once the real message lands (server grew by one)", () => {
    const p = [pending({})];
    expect(reconcilePendingMessages(p, "t1", 3)).toEqual([]);
  });

  test("retires oldest-first when two replies were sent and only one landed", () => {
    const p = [
      pending({ localId: "pending-1", createdAt: 1000 }),
      pending({ localId: "pending-2", createdAt: 2000 }),
    ];
    // both captured baseline 2; server now 3 → exactly one delivered
    const kept = reconcilePendingMessages(p, "t1", 3);
    expect(kept.map((x) => x.localId)).toEqual(["pending-2"]);
  });

  test("retires both when both replies landed", () => {
    const p = [
      pending({ localId: "pending-1", createdAt: 1000 }),
      pending({ localId: "pending-2", createdAt: 2000 }),
    ];
    expect(reconcilePendingMessages(p, "t1", 4)).toEqual([]);
  });

  test("never touches pendings for other threads", () => {
    const p = [
      pending({ localId: "pending-1", threadId: "t1", baselineCount: 2 }),
      pending({ localId: "pending-2", threadId: "t2", baselineCount: 5 }),
    ];
    // reconciling t1 with a delivered reply must leave t2 alone
    const kept = reconcilePendingMessages(p, "t1", 3);
    expect(kept.map((x) => x.localId)).toEqual(["pending-2"]);
  });

  test("is a no-op when the thread has no pendings", () => {
    const p = [pending({ threadId: "t2" })];
    expect(reconcilePendingMessages(p, "t1", 9)).toEqual(p);
  });
});
