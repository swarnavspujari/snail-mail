// Cache-first navigation semantics of the mail store: reopening a thread
// paints from the session cache while getThread revalidates behind it, label
// views revisit from cache without clearing, and refresh() applies each view
// as its fetch lands instead of behind a six-way barrier.
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Message, Thread } from "@/lib/types";

const backend = vi.hoisted(() => ({
  listThreads: vi.fn(),
  getThread: vi.fn(),
  refetchMessageBody: vi.fn(),
  splitCounts: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/ipc", () => ({ backend, isTauri: false }));

import { clearMailCaches, useMail } from "./mail";

function msg(over: Partial<Message>): Message {
  return {
    id: "m1",
    threadId: "t1",
    from: "maya@heliosrobotics.io",
    fromName: "Maya Chen",
    to: ["you@fission.local"],
    cc: [],
    subject: "Term sheet",
    date: 1000,
    bodyText: "hello",
    bodyHtml: null,
    snippet: "hello",
    unread: false,
    attachments: [],
    ...over,
  } as Message;
}

function thread(over: Partial<Thread>): Thread {
  return {
    id: "t1",
    subject: "Term sheet",
    snippet: "hello",
    participants: ["Maya Chen"],
    recipients: [],
    messageCount: 1,
    lastDate: 1000,
    unread: false,
    starred: false,
    inInbox: true,
    snoozedUntil: null,
    labels: [],
    split: "",
    alsoIn: [],
    ...over,
  } as Thread;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearMailCaches();
  useMail.setState({
    loaded: false,
    inbox: [],
    done: [],
    reminders: [],
    starred: [],
    trash: [],
    labelThreads: [],
    listView: "inbox",
    openThreadId: null,
    openMessages: [],
    blankHealDone: false,
    pendingMessages: [],
    selectedIndex: 0,
    selectedIds: new Set(),
  });
});

describe("openThread cache", () => {
  test("first open starts empty and fills when getThread lands", async () => {
    backend.getThread.mockResolvedValue([msg({})]);
    const p = useMail.getState().openThread("t1");
    expect(useMail.getState().openMessages).toEqual([]);
    expect(useMail.getState().blankHealDone).toBe(false);
    await p;
    expect(useMail.getState().openMessages).toHaveLength(1);
    expect(useMail.getState().blankHealDone).toBe(true);
  });

  test("reopen paints cached messages synchronously, then reconciles", async () => {
    backend.getThread.mockResolvedValue([msg({})]);
    await useMail.getState().openThread("t1");
    useMail.getState().closeThread();

    // revalidation now returns a grown thread, but slowly
    const d = deferred<Message[]>();
    backend.getThread.mockReturnValue(d.promise);
    const p = useMail.getState().openThread("t1");
    // cached message visible before the fetch resolves — no blank pane
    expect(useMail.getState().openMessages).toHaveLength(1);
    expect(useMail.getState().blankHealDone).toBe(true);
    d.resolve([msg({}), msg({ id: "m2", bodyText: "reply" })]);
    await p;
    expect(useMail.getState().openMessages).toHaveLength(2);
  });

  test("blank-body heal updates the cache so a reopen shows healed bodies", async () => {
    backend.getThread.mockResolvedValue([msg({ bodyText: "", bodyHtml: null })]);
    backend.refetchMessageBody.mockResolvedValue([msg({ bodyText: "healed" })]);
    await useMail.getState().openThread("t1");
    await vi.waitFor(() => {
      expect(useMail.getState().blankHealDone).toBe(true);
    });
    expect(useMail.getState().openMessages[0].bodyText).toBe("healed");
    useMail.getState().closeThread();

    const d = deferred<Message[]>();
    backend.getThread.mockReturnValue(d.promise);
    void useMail.getState().openThread("t1");
    expect(useMail.getState().openMessages[0].bodyText).toBe("healed");
    expect(useMail.getState().blankHealDone).toBe(true);
  });

  test("cache is bounded: the oldest of 51 threads is evicted", async () => {
    for (let i = 0; i <= 50; i++) {
      backend.getThread.mockResolvedValue([msg({ id: `m${i}`, threadId: `t${i}` })]);
      await useMail.getState().openThread(`t${i}`);
    }
    const d = deferred<Message[]>();
    backend.getThread.mockReturnValue(d.promise);
    void useMail.getState().openThread("t1"); // still cached
    expect(useMail.getState().openMessages).toHaveLength(1);
    void useMail.getState().openThread("t0"); // evicted → cold start
    expect(useMail.getState().openMessages).toEqual([]);
  });
});

describe("refresh", () => {
  test("each view applies as it lands; inbox does not wait for the rest", async () => {
    const slow = deferred<Thread[]>();
    backend.listThreads.mockImplementation((view: string) =>
      view === "inbox"
        ? Promise.resolve([thread({})])
        : view === "done"
          ? slow.promise
          : Promise.resolve([])
    );
    const p = useMail.getState().refresh();
    await vi.waitFor(() => {
      expect(useMail.getState().loaded).toBe(true);
    });
    // inbox is painted while done is still in flight
    expect(useMail.getState().inbox).toHaveLength(1);
    expect(useMail.getState().done).toEqual([]);
    slow.resolve([thread({ id: "t9", inInbox: false })]);
    await p;
    expect(useMail.getState().done).toHaveLength(1);
  });
});

describe("label views", () => {
  test("first visit fetches; revisit paints from cache and revalidates", async () => {
    const deals = [thread({ id: "t5", labels: ["Deals"] })];
    backend.listThreads.mockResolvedValue(deals);
    useMail.getState().setListView("label:Deals");
    expect(useMail.getState().labelThreads).toEqual([]); // cold: nothing yet
    await vi.waitFor(() => {
      expect(useMail.getState().labelThreads).toHaveLength(1);
    });

    useMail.getState().setListView("inbox");
    expect(useMail.getState().labelThreads).toEqual([]);

    // revisit: cached list paints synchronously while the refetch hangs
    const d = deferred<Thread[]>();
    backend.listThreads.mockReturnValue(d.promise);
    useMail.getState().setListView("label:Deals");
    expect(useMail.getState().labelThreads).toHaveLength(1);
    d.resolve([]);
    await vi.waitFor(() => {
      expect(useMail.getState().labelThreads).toEqual([]);
    });
  });
});
