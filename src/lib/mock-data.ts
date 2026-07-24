// Seed fixtures for the mock backend (browser dev + demo mode before OAuth).
import type { Message, Thread } from "./types";

const H = 3600_000;
const D = 24 * H;
const now = Date.now();

interface Seed {
  thread: Omit<
    Thread,
    "snippet" | "messageCount" | "lastDate" | "participants" | "recipients" | "split" | "alsoIn"
  >;
  account?: string; // defaults to the primary demo account
  messages: Array<
    Pick<Message, "from" | "fromName" | "to" | "cc" | "bodyText"> & {
      ageMs: number;
      unread?: boolean;
      bodyHtml?: string;
      attachments?: Array<{ filename: string; mimeType: string; sizeBytes: number }>;
    }
  >;
}

const ME = "you@fission.local";
export const DEMO_ACCOUNT = "demo@fission.local";
export const DEMO_ACCOUNT_2 = "angel@fission.local";

const seeds: Seed[] = [
  {
    thread: {
      id: "t-term-sheet",
      subject: "Term sheet — Series A close timing",
      unread: true,
      starred: true,
      labels: ["IMPORTANT", "Deals"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "maya@heliosrobotics.io",
        fromName: "Maya Chen",
        to: [ME],
        cc: ["legal@heliosrobotics.io"],
        ageMs: 26 * H,
        bodyText:
          "Hi,\n\nAttached is the revised term sheet with the changes we discussed on the board pro-rata and the option pool sizing. Our counsel flagged one open item: the closing date. We'd like to target the 15th, but need your confirmation on wiring logistics before we lock it.\n\nCan you confirm by Thursday?\n\nBest,\nMaya",
        attachments: [
          { filename: "Helios_SeriesA_TermSheet_v4.pdf", mimeType: "application/pdf", sizeBytes: 182_340 },
        ],
      },
      {
        from: "maya@heliosrobotics.io",
        fromName: "Maya Chen",
        to: [ME],
        cc: [],
        ageMs: 3 * H,
        unread: true,
        bodyText:
          "Quick nudge on the note below — our counsel needs the go/no-go on the 15th by EOD tomorrow to hold the schedule.\n\nMaya",
      },
    ],
  },
  {
    thread: {
      id: "t-diligence",
      subject: "Diligence follow-ups from Tuesday's call",
      unread: true,
      starred: false,
      labels: ["IMPORTANT", "Deals"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "dev.arora@granitecapital.com",
        fromName: "Dev Arora",
        to: [ME],
        cc: [],
        ageMs: 7 * H,
        unread: true,
        bodyText:
          "Following up on Tuesday — three things outstanding from our side:\n\n1. Cohort retention data past month 18\n2. The updated cap table post-SAFE conversion\n3. Reference contacts for the two enterprise pilots\n\nWe're aiming to bring this to IC on Monday, so anything you can get us by Friday helps.\n\nDev",
      },
    ],
  },
  {
    thread: {
      id: "t-board-deck",
      subject: "Q2 board deck — review draft",
      unread: false,
      starred: false,
      labels: ["IMPORTANT", "LPs"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "priya@fissionventures.com",
        fromName: "Priya Nair",
        to: [ME],
        cc: [],
        ageMs: 2 * D,
        bodyText:
          "Draft of the Q2 board deck is attached. The open questions are on slide 14 (hiring plan) and slide 19 (the revised burn multiple). Would love your pass before I circulate to the rest of the board Sunday night.\n\nPriya",
        attachments: [
          { filename: "Q2_Board_Deck_DRAFT.pdf", mimeType: "application/pdf", sizeBytes: 2_412_800 },
          { filename: "burn_notes.txt", mimeType: "text/plain", sizeBytes: 4_210 },
        ],
      },
    ],
  },
  {
    thread: {
      id: "t-intro-founder",
      subject: "Intro: Lena Okafor (Fieldstone Bio) <> you",
      unread: true,
      starred: false,
      labels: ["IMPORTANT"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "james@thirdactvc.com",
        fromName: "James Whitfield",
        to: [ME, "lena@fieldstone.bio"],
        cc: [],
        ageMs: 30 * H,
        unread: true,
        bodyText:
          "Connecting you two — Lena is building Fieldstone Bio (computational protein design for ag). Raising a seed, and given your thesis around applied bio tooling I thought this was worth your time. Lena, over to you to share the deck.\n\nJames",
      },
      {
        from: "lena@fieldstone.bio",
        fromName: "Lena Okafor",
        to: [ME],
        cc: ["james@thirdactvc.com"],
        ageMs: 22 * H,
        unread: true,
        bodyText:
          "Thanks James!\n\nGreat to meet you. Deck attached — we're raising a $3.5M seed to get our first two crop-protection candidates through greenhouse trials. Happy to find 30 minutes next week if there's mutual interest.\n\nLena",
        attachments: [
          { filename: "Fieldstone_Seed_Deck.pdf", mimeType: "application/pdf", sizeBytes: 3_105_000 },
        ],
      },
    ],
  },
  {
    thread: {
      id: "t-cal-board",
      subject: "Invitation: Helios Robotics Board Meeting @ Thu Jul 9, 2026 10:00 (PT)",
      unread: true,
      starred: false,
      labels: ["CALENDAR"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "calendar-invite@google.com",
        fromName: "Google Calendar",
        to: [ME],
        cc: [],
        ageMs: 9 * H,
        unread: true,
        bodyText:
          "You have been invited to: Helios Robotics Board Meeting\nWhen: Thursday, July 9, 2026 10:00 – 11:30 AM (PT)\nWhere: Zoom (link in event)\nOrganizer: maya@heliosrobotics.io\n\nAgenda: Q2 financials, Series A close, hiring plan.",
      },
    ],
  },
  {
    thread: {
      id: "t-cal-dinner",
      subject: "Invitation: Founders' Dinner — SF @ Wed Jul 15, 2026 19:00 (PT)",
      unread: false,
      starred: false,
      labels: ["CALENDAR"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "events@saastrix.com",
        fromName: "SaaStrix Events",
        to: [ME],
        cc: [],
        ageMs: 3 * D,
        bodyText:
          "You're confirmed for the Founders' Dinner on July 15th, 7 PM at Foreign Cinema. Dress code: casual. Reply to this email with dietary restrictions.",
      },
    ],
  },
  {
    thread: {
      id: "t-newsletter-strictly",
      subject: "StrictlyVC: Andreessen's newest fund, a fintech reckoning",
      unread: true,
      starred: false,
      labels: [],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "connie@strictlyvc.com",
        fromName: "StrictlyVC",
        to: [ME],
        cc: [],
        ageMs: 12 * H,
        unread: true,
        bodyText:
          "Top of the morning. A16z is raising its largest fund yet, per two sources... [newsletter continues]\n\nAlso today: the fintech secondaries market heats up, and a profile of the quiet giant of vertical SaaS.",
        // Exercises the sanitized-HTML reading pane in demo mode: tables,
        // inline styles, links, and an image, like real newsletter mail.
        bodyHtml: `<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;font-family:Georgia,serif">
  <tr><td style="background:#111827;color:#f9fafb;padding:18px 24px;font-size:20px;font-weight:bold">StrictlyVC</td></tr>
  <tr><td style="padding:20px 24px;font-size:15px;line-height:1.6;color:#111827">
    <p style="margin:0 0 12px">Top of the morning. <strong>A16z is raising its largest fund yet</strong>, per two sources with knowledge of the matter — a vehicle that would eclipse its 2024 flagship.</p>
    <p style="margin:0 0 12px">Also today: the fintech secondaries market heats up, and a profile of <a href="https://example.com/vertical-saas">the quiet giant of vertical SaaS</a>.</p>
    <table cellpadding="8" style="border:1px solid #e5e7eb;border-collapse:collapse;width:100%;font-size:13px">
      <tr style="background:#f3f4f6"><td><b>Fund</b></td><td><b>Target</b></td><td><b>Status</b></td></tr>
      <tr><td>Flagship VIII</td><td>$8.0B</td><td>Raising</td></tr>
      <tr><td>Bio Fund IV</td><td>$2.5B</td><td>Closed</td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:12px;color:#6b7280">You're receiving this because you subscribed. <a href="https://unsubscribe.example.com/strictlyvc">Unsubscribe</a></p>
  </td></tr>
</table>`,
      },
    ],
  },
  {
    thread: {
      id: "t-newsletter-lenny",
      subject: "How the best PMs run discovery (Lenny's Newsletter)",
      unread: true,
      starred: false,
      labels: [],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "lenny@substack.com",
        fromName: "Lenny Rachitsky",
        to: [ME],
        cc: [],
        ageMs: 2 * D,
        unread: true,
        bodyText:
          "This week: a deep dive on continuous discovery habits, with playbooks from PMs at Figma, Linear, and Notion... [newsletter continues]",
        // Exercises the inline shadow-DOM reading pane against the patterns
        // that used to break in the iframe: a <head> <style> the layout
        // depends on, a class-hidden preheader, an inline-hidden preview-pad
        // run, and a hero title duplicating the subject (both stripped at
        // render by prepareEmailHtml).
        bodyHtml: `<html><head><style>
  .preheader { display: none !important; }
  .wrap { max-width: 600px; margin: 0 auto; font-family: Georgia, serif; }
  .lede { font-size: 15px; line-height: 1.65; color: #24292f; margin: 0 0 14px; }
  .card { border: 1px solid #e1e4e8; border-radius: 8px; padding: 14px 16px; margin: 0 0 14px; background: #fafbfc; }
  .cta { color: #ffffff; background: #ff6719; border-radius: 20px; padding: 8px 18px; text-decoration: none; display: inline-block; }
  @media (max-width: 600px) { .wrap { width: 100% !important; } }
</style></head><body>
<div class="preheader">This week: a deep dive on continuous discovery habits, with playbooks from PMs at Figma, Linear, and Notion.</div>
<div style="display:none;font-size:1px;line-height:1px;max-height:0;overflow:hidden">&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>
<div class="wrap">
  <h1 style="font-size:26px;line-height:1.25;margin:8px 0 4px">How the best PMs run discovery</h1>
  <p style="color:#6a737d;margin:0 0 18px;font-size:13px">Lenny's Newsletter &middot; July 2026</p>
  <p class="lede">Continuous discovery isn't a research phase you schedule — it's a weekly habit. The teams that ship the right things talk to customers on a cadence, not a milestone.</p>
  <div class="card"><b>The playbook, condensed:</b><br>1. One customer conversation per week, owned by the PM.<br>2. Assumptions mapped before solutions get named.<br>3. Prototypes tested on Tuesdays, decisions made on Thursdays.</div>
  <p class="lede">Inside: how PMs at <a href="https://example.com/figma">Figma</a>, <a href="https://example.com/linear">Linear</a>, and Notion structure their weeks, and the interview snapshot template they all converge on.</p>
  <p style="margin:18px 0"><a class="cta" href="https://example.com/discovery-deep-dive">Read the full post</a></p>
  <p style="font-size:12px;color:#6a737d">You're on the free list. <a href="https://unsubscribe.example.com/lenny">Unsubscribe</a></p>
</div>
</body></html>`,
      },
    ],
  },
  {
    thread: {
      id: "t-github",
      subject: "[snail-mail] Your workflow run failed: CI on main",
      unread: false,
      starred: false,
      labels: [],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "notifications@github.com",
        fromName: "GitHub",
        to: [ME],
        cc: [],
        ageMs: 5 * D,
        bodyText:
          "CI on main failed after 2m14s.\n\nwindows-build: error LNK2019 unresolved external symbol...\n\nView the full run for details.",
        // Wide content: a long single-line <pre> and a fixed-width nowrap
        // table must scroll inside their own box, never widen the pane.
        bodyHtml: `<div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:640px">
  <p style="margin:0 0 12px"><b>[snail-mail]</b> Run <a href="https://example.com/runs/8841">#8841</a> failed on <code>main</code> after 2m14s.</p>
  <pre style="background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:12px;font-size:12px">windows-build: error LNK2019: unresolved external symbol __imp_OrtGetApiBase referenced in function ort_api_init (fastembed-5.17.2\\ort\\sys\\lib.rs:114) [C:\\actions-runner\\_work\\email-productivity-client\\src-tauri\\target\\release\\deps\\fission_mail.exe]</pre>
  <table width="720" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:12.5px;border:1px solid #d0d7de">
    <tr style="background:#f6f8fa"><td nowrap><b>Job</b></td><td nowrap><b>Commit</b></td><td nowrap><b>Message</b></td><td nowrap><b>Duration</b></td></tr>
    <tr><td nowrap>windows-build</td><td nowrap><code>f97f2d9c1a4e</code></td><td nowrap>chore: release v0.17.1 — snooze natural-language reminder parser and timezone labels</td><td nowrap>2m14s</td></tr>
    <tr><td nowrap>lint-and-test</td><td nowrap><code>f97f2d9c1a4e</code></td><td nowrap>chore: release v0.17.1 — snooze natural-language reminder parser and timezone labels</td><td nowrap>58s ✓</td></tr>
  </table>
  <p style="margin:12px 0 0"><a href="https://example.com/runs/8841">View the full run</a> for logs and artifacts.</p>
</div>`,
      },
    ],
  },
  {
    thread: {
      id: "t-wire-receipt",
      subject: "Wire transfer confirmation — Mercury",
      unread: false,
      starred: false,
      labels: [],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "no-reply@mercury.com",
        fromName: "Mercury",
        to: [ME],
        cc: [],
        ageMs: 4 * D,
        bodyText:
          "Your outgoing wire of $250,000.00 to Helios Robotics Inc. has been sent. Reference: MRC-99418-2026. It should arrive within 1 business day.",
      },
    ],
  },
  {
    thread: {
      id: "t-lp-update",
      subject: "LP quarterly update — Fund II",
      unread: false,
      starred: true,
      labels: ["IMPORTANT"],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "ops@pujarivp.com",
        fromName: "Fund Ops",
        to: [ME],
        cc: [],
        ageMs: 6 * D,
        bodyText:
          "Reminder that the Fund II quarterly letter is due to LPs by the 10th. Draft numbers are in the data room; the TVPI moved to 1.8x with the Helios markup. Need your narrative section by Wednesday.",
      },
    ],
  },
  {
    thread: {
      id: "t-recruiting",
      subject: "Re: Platform lead role — candidate shortlist",
      unread: false,
      starred: false,
      labels: [],
      inInbox: true,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "sofia@talentfoundry.co",
        fromName: "Sofia Reyes",
        to: [ME],
        cc: [],
        ageMs: 8 * D,
        bodyText:
          "Shortlist attached — four candidates, two from operator backgrounds. My top pick is candidate B (ex-Stripe, ran founder programs). Want me to set up intro calls for next week?",
        attachments: [
          { filename: "platform_lead_shortlist.txt", mimeType: "text/plain", sizeBytes: 2_900 },
        ],
      },
    ],
  },
];

// Second demo account (angel@) — proves Ctrl+1/2 account switching.
const account2Seeds: Seed[] = [
  {
    thread: {
      id: "t2-safe-note",
      subject: "SAFE for Brightloop — countersigned copy",
      unread: true,
      starred: true,
      labels: ["IMPORTANT"],
      inInbox: true,
      snoozedUntil: null,
    },
    account: DEMO_ACCOUNT_2,
    messages: [
      {
        from: "theo@brightloop.dev",
        fromName: "Theo Lindqvist",
        to: [ME],
        cc: [],
        ageMs: 5 * H,
        unread: true,
        bodyText:
          "Countersigned SAFE attached — $50k at a $6M cap, as discussed. Wiring details are in the doc. Thanks for moving fast on this, means a lot.\n\nTheo",
        attachments: [
          { filename: "Brightloop_SAFE_countersigned.pdf", mimeType: "application/pdf", sizeBytes: 96_500 },
        ],
      },
    ],
  },
  {
    thread: {
      id: "t2-demo-day",
      subject: "You're invited: Foundry Batch 12 Demo Day",
      unread: true,
      starred: false,
      labels: ["CALENDAR"],
      inInbox: true,
      snoozedUntil: null,
    },
    account: DEMO_ACCOUNT_2,
    messages: [
      {
        from: "events@foundryaccel.com",
        fromName: "Foundry Accelerator",
        to: [ME],
        cc: [],
        ageMs: 20 * H,
        unread: true,
        bodyText:
          "Invitation: Foundry Batch 12 Demo Day\nWhen: July 22, 2026, 1:00 PM (PT)\nWhere: Fort Mason, SF + livestream\n\n14 companies presenting. RSVP by the 10th for in-person seats.",
      },
    ],
  },
  {
    thread: {
      id: "t2-angellist",
      subject: "Your Q2 portfolio summary is ready",
      unread: false,
      starred: false,
      labels: [],
      inInbox: true,
      snoozedUntil: null,
    },
    account: DEMO_ACCOUNT_2,
    messages: [
      {
        from: "no-reply@angellist.com",
        fromName: "AngelList",
        to: [ME],
        cc: [],
        ageMs: 2 * D,
        bodyText:
          "Your Q2 2026 portfolio summary: 11 active investments, 2 markups this quarter (Brightloop, Corvid Security), 1 write-down. Full report in your dashboard.",
      },
    ],
  },
];

// Older archived threads so the Done view and search have content.
const doneSeed: Seed[] = [
  {
    thread: {
      id: "t-done-saastr",
      subject: "Your SaaStr Annual ticket confirmation",
      unread: false,
      starred: false,
      labels: [],
      inInbox: false,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "tickets@saastrannual.com",
        fromName: "SaaStr Annual",
        to: [ME],
        cc: [],
        ageMs: 12 * D,
        bodyText: "Ticket confirmed for SaaStr Annual 2026, September 9–11, San Mateo. Order #88213.",
      },
    ],
  },
  {
    thread: {
      id: "t-done-memo",
      subject: "Investment memo feedback — Corvid Security",
      unread: false,
      starred: false,
      labels: ["IMPORTANT"],
      inInbox: false,
      snoozedUntil: null,
    },
    messages: [
      {
        from: "priya@fissionventures.com",
        fromName: "Priya Nair",
        to: [ME],
        cc: [],
        ageMs: 15 * D,
        bodyText:
          "Left comments on the Corvid memo. Main pushback: the bottoms-up TAM feels generous given the ACVs we saw in diligence. Otherwise supportive — good find.",
      },
    ],
  },
];

function buildMessages(seed: Seed): Message[] {
  return seed.messages.map((m, i) => ({
    id: `${seed.thread.id}-m${i + 1}`,
    threadId: seed.thread.id,
    from: m.from,
    fromName: m.fromName,
    to: m.to,
    cc: m.cc,
    subject: seed.thread.subject,
    snippet: m.bodyText.slice(0, 120).replace(/\n+/g, " "),
    bodyText: m.bodyText,
    bodyHtml: m.bodyHtml ?? null,
    date: now - m.ageMs,
    unread: m.unread ?? false,
    attachments: (m.attachments ?? []).map((a, j) => ({
      id: `${seed.thread.id}-m${i + 1}-a${j + 1}`,
      messageId: `${seed.thread.id}-m${i + 1}`,
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
    })),
  }));
}

export function buildSeedData(): {
  threads: Thread[];
  messages: Map<string, Message[]>;
  accountOf: Map<string, string>;
} {
  const threads: Thread[] = [];
  const messages = new Map<string, Message[]>();
  const accountOf = new Map<string, string>();
  for (const seed of [...seeds, ...account2Seeds, ...doneSeed]) {
    const msgs = buildMessages(seed);
    messages.set(seed.thread.id, msgs);
    accountOf.set(seed.thread.id, seed.account ?? DEMO_ACCOUNT);
    const last = msgs[msgs.length - 1];
    threads.push({
      ...seed.thread,
      snippet: last.snippet,
      participants: [...new Set(msgs.map((m) => `${m.fromName} <${m.from}>`))],
      recipients: [...new Set(msgs.flatMap((m) => [...m.to, ...m.cc]))],
      messageCount: msgs.length,
      lastDate: last.date,
      unread: msgs.some((m) => m.unread),
      split: "", // classified by MockBackend (mirrors the Rust upsert path)
      alsoIn: [],
    });
  }
  return { threads, messages, accountOf };
}
