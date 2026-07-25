# Snail Mail — Design System

**Snail Mail** is the fastest open-source email productivity client — a keyboard-first, AI-native desktop app in the spirit of **Superhuman** that sits on top of Gmail and Outlook. The name is the joke; the speed isn't. **It only sounds slow.** Local-first: your mail cache, settings, and API keys never leave your machine. Fly through email with a full keymap (`E` done, `R` reply, `Z` undo anything), a `Ctrl+K` command palette (**Shell Command**), Split Inbox, Instant Reply, and BYOK AI drafting (Claude / OpenAI / NVIDIA NIM).

This design system captures Snail Mail's real visual language so designers and agents can build on-brand screens, prototypes, and marketing assets.

> **Sources used to build this system**
> - **Product codebase:** https://github.com/swarnavspujari/snail-mail (the client; the repo's package is named `snail-mail` — Snail Mail is the product brand). Design tokens originate from `src/styles/theme.css`, here evolved to the **Cerulean** palette (a blue pulled ~40% toward green) and a **Material Design 3** tonal dark mode; components and UI kit are recreated from `src/features/**` and `src/components/**`.
> - **Brand logos:** provided by the user — the rocket-snail lockup + icon (`assets/snail-mail-logo.svg`, `assets/snail-mail-icon.svg`), with reversed and app-tile variants derived from them.
> - **Design philosophy:** Superhuman's "How to design delightful dark themes" (blog.superhuman.com) informs the dark-theme rules below, and reference screenshots of Superhuman Mail informed the *feature set and layout patterns* (split inbox, command palette, instant reply, contact rail, auto-labels, calendar).
>
> Explore the repo further to build higher-fidelity designs — the `src/features/` tree is the ground truth for every screen.

**Similar, not the same.** Snail Mail deliberately reaches toward Superhuman-class *speed, layout, and feature parity* — but renders everything in its **own identity**: a cerulean accent (not Superhuman's palette), the rocket-snail brand mark (not their logo), and "Shell Command" (not "Superhuman Command"). Build in Snail Mail's identity; never reproduce another product's brand marks or exact colors.

Targets **WCAG 2.2**: visible keyboard focus rings everywhere, AA contrast on **both** themes, no reliance on color alone (unread is weight + colored dot + text strength). Both **dark** (the codebase's native mode) and **light** (the airy, spacious default) are first-class — the system is designed to be equally correct in either.

---

## The brand in one paragraph

The mark is a **snail whose shell is a rocket-borne envelope** — antennae, a smile, cyan fast-lines and a gold booster-flame trailing behind. It's the whole positioning in one drawing: *looks slow, moves fast.* Three fixed brand colors — **navy `#002839`** (ink, outlines, wordmark, app-tile body), **cyan `#52d0f6`** (the shell + speed lines), **gold `#fbca60`** (the booster flame). Cyan and gold **are** the product's dark-theme `--accent` and `--accent-2`, so identity and interface are one family. Voice is calm, direct, second-person, keyboard-forward — lean into the irony once ("It only sounds slow."), then get out of the way. See *Brand → Logo* and `explorations/Snail Mail Brand.html`.

---

## Index / manifest

- **`styles.css`** — the single entry point consumers link. `@import`s the five token files below.
- **`tokens/`**
  - `fonts.css` — the Google webfont substitutes (Source Sans 3, JetBrains Mono) + the marketing display face (Chakra Petch).
  - `colors.css` — surfaces, text, cerulean accent family, semantic status, borders, **fixed brand marks** (`--brand-navy/cyan/gold/paper`) (dark + light themes). Dark uses an MD3 tonal elevation ladder; both themes are authored in oklch.
  - `typography.css` — Segoe UI Variable / Cascadia Code families + Chakra Petch display, size ramp, weights, line-heights.
  - `layout.css` — spacing scale, fixed layout metrics, radii, shadows, motion.
  - `base.css` — body/focus/scrollbar resets, `.kbd` chip, the two keyframe animations.
- **`components/`** — reusable React primitives. Mount via `const { X } = window.<Namespace>` after loading `_ds_bundle.js` — run `check_design_system` for the exact `<Namespace>` (it is `SnailMailDesignSystem_<hash>`; the specimen cards resolve it by pattern so a rename/hash change never breaks them):
  - `forms/` — **Button**, **IconButton**, **Input**
  - `core/` — **Avatar**, **Kbd**, **KeyHint**, **HoverHint**, **Badge**, **Pill**
  - `mail/` — **MailRow** (+ multi-select), **BulkBar**, **MessageCard**, **AttachmentChip** (now with a Drive-upload progress state), **SplitTab**, **Label**, **InstantReply**, **ContactPanel**, **RestState**
  - `calendar/` — **EventBlock**, **EventPopover**, **EventModal**
  - `pickers/` — **PickerShell**, **DrivePicker**
  - `navigation/` — **NavRail**, **FolderSidebar**
  - `feedback/` — **UndoToast**, **UndoSendBar**
  - `shortcuts/` — **ShortcutsPanel**
- **`ui_kits/snail-mail/`** — full interactive recreation of the app (nav rail, folder sidebar, split inbox with labels + colored dots + hover actions, thread view with contact rail + instant reply, compose, Shell Command palette, search with operator tips, calendar week view, undo toasts). Light + dark. Open `index.html`.
- **`guidelines/`** — foundation specimen cards (Colors, Type, Spacing, Brand).
- **`assets/`** — the brand SVG set: `snail-mail-logo.svg` (+ `-on-dark`), `snail-mail-icon.svg` (+ `-on-dark`), `snail-mail-app-tile.svg` (square paper-white favicon / desktop icon).
- **`SKILL.md`** — Agent-Skill wrapper.

---

## Content fundamentals

Snail Mail's copy is **calm, direct, and second-person**. It talks *to you* and rarely about itself.

- **Voice:** confident and terse. Short imperative labels — "Mark Done", "Get Me To Zero", "Explore the demo first". Verbs first. The one recurring wink is the speed irony — *"It only sounds slow." · "Snail on the outside. Rocket underneath."* — used sparingly, never belabored.
- **Person:** second person ("your inbox", "your machine", "sound like you"). First-person plural only in genuine product voice ("we"), never marketing "we".
- **Tone:** reassuring about privacy and speed. "Mail never leaves your computer." "Breathe. Or press Tab for the next split." A dry warmth — the empty-split state is a moment of calm, not a hard sell.
- **Casing:** **Sentence case** everywhere — headings, buttons, menu items. Product name is "Snail Mail". Shortcut names are literal keys (`Ctrl+K`, `Shift+E`).
- **Numbers as to-do counts:** split/thread counts are **totals**, not unread — "a split reads like a to-do list." Say what a number *means*, not just the figure.
- **Emoji:** essentially none. Icons are monochrome — two line SVGs (paperclip = attach, sparkle-paperclip = AI) plus Unicode glyphs (`★ ▦ ← ✓`). Never decorative emoji in body copy or headings.
- **Keyboard-forward:** copy constantly teaches shortcuts inline ("press `Tab` for the next split", "`Z` to undo"). Every surface reinforces the keymap.
- **Examples of real copy:** "The fastest way through your inbox." · "Ten keys run everything." · "Forget everything else — `Ctrl+K` finds any command by name." · "Uses the full thread, attachments, and your Knowledge Base."

---

## Visual foundations

**Overall vibe:** a focused, professional cockpit that ships in two moods. **Dark** is a Material Design 3 tonal dark — soft dark surfaces (not black) on an elevation ladder, a single cerulean accent, hairline separations, dense typography. **Light** is airy and spacious — near-white surfaces, generous line height, nothing tinting the content. Both are first-class. Nothing decorative; every pixel serves triage speed. This is a tool, not a landing page.

### Dark theme, done right — the Material Design 3 tonal method

Snail Mail's dark theme is built the way **Material Design 3** builds dark surfaces — a *tonal elevation* system, not a near-black. It also satisfies the five dark-theme principles Superhuman published; the two agree.

1. **Tonal surfaces, not black.** The base is a *soft* dark tonal neutral — `#131819` (oklch L 0.205), a comfortable dark grey carrying a whisper of the cerulean hue — never `#000` or a saturated midnight-navy. This is the fix for "too dark": the old navy base read as black; a tonal base reads as a calm dark room.
2. **Elevation is a ladder of lighter surfaces.** Like MD3's `surface-container` roles, each nearer layer steps lighter — base `#131819` → surface `#1a2021` → raised (cards) `#252e2f` → overlay `#2b3638`. Depth comes from *stacking lighter tones*, almost never shadow. Never invert the light theme — that flips the physicality.
3. **Primary is a light, gentle accent.** MD3 uses a *light* primary in dark (tone ~80) carrying dark text — so Snail Mail's cerulean is `#52d0f6` with a dark `--on-accent`, not a deep saturated fill. Big bright blocks never vibrate against the dark. (This cyan is exactly the logo's shell cyan.)
4. **Reduce large blocks of bright color.** Accents appear as thin bars, small pills, `--accent-dim` washes, and the occasional light CTA — never full-bleed saturated panels. The command palette dims the app behind a scrim.
5. **Retune contrast per theme; no pure black/white.** Text tiers are tuned per theme (dark body is a soft near-white `#ecf1f2`, not `#fff`, to prevent halation). WCAG AA on both.

### Color
- **Layered surfaces — MD3 tonal ladder, lit from above.** Five dark surfaces from `base #131819` (furthest/darkest) → `surface #1a2021` → `raised #252e2f` → `overlay #2b3638`, plus a cerulean-tinted `selected #0d3f4f`. All carry a faint H210 tint. Depth comes from *stacking lighter tones*, almost never from shadow. Distant = darker.
- **No pure black or white.** Body text is a soft near-white `#ecf1f2` (oklch L 0.955), not `#fff`, to prevent halation. Three text tiers: primary `#ecf1f2` → secondary `#bcc7c9` → muted `#89989a`, all AA on the tonal surfaces.
- **One accent: cerulean.** A blue pulled ~40% toward green (hue 222). Dark: a *light* `--accent #52d0f6` (MD3 primary-in-dark) with dark `--on-accent`; hover lifts to `--accent-strong #79e2ff`; tinted fills use `--accent-dim` (18% alpha). It **is** the cyan of the logo's rocket shell and fast-lines.
- **Fixed brand marks.** `--brand-navy #002839`, `--brand-cyan #52d0f6`, `--brand-gold #fbca60`, `--brand-paper #ffffff` — theme-independent constants for the logo, the app-tile, and brand/marketing surfaces only. Cyan/gold equal the dark `--accent`/`--accent-2`; keep navy off large UI fills.
- **Semantic trio:** success `#6adfa1`, warning (gold) `#fbca60`, danger `#f87e75` — all lifted for the dark tonal surface.
- **Light theme is tuned, not inverted.** Cool near-white surfaces *lighten* as they come nearer (base `#f4f7f8` → raised `#ffffff`); the accent *deepens* to a mid cerulean `#0079a3` to hold against dark text. WCAG AA throughout. In light mode the layout also breathes more (bigger split-tab titles, roomier rows) — the airy, Superhuman-like default.
- **Auto-label palette.** Six theme-aware tag hues (`--tag-{violet,amber,green,blue,pink,gray}-{bg,fg}`) for categorical labels — soft tinted fill + legible same-hue text. Convention: pitch=violet, news=amber, CRM=green, marketing=blue.
- **Sender dots.** Unread markers cycle through `--dot-{blue,pink,amber,violet}` so threads are distinguishable at a glance — not a single accent dot.
- **Calendar palette.** Seven per-calendar hues (`--cal-{cerulean,green,violet,amber,rose,teal,gray}`, theme-aware) — one per calendar in the account list. An event renders in its calendar's hue as a **muted tinted block** (the color mixed into the surface, never a big saturated fill) plus a saturated left bar; the calendar's side-panel checkbox fills with the same color. Tuned to the tag/dot lightness band so the whole set reads as one cerulean-adjacent family.
- **No decorative wash.** There was once a `--wash-bottom` gradient tinting the bottom ~300px of every pane — Snail Mail's answer to Superhuman's peach glow. It's gone: it dimmed real content, and its light-theme gradient mixed `%` and `px` stops, which CSS reorders into a hard band (the bug fixed in `d0e7326`). The photography — inbox zero and the welcome screen — carries the warmth instead.

### Type
- **Segoe UI Variable Text** (the Windows system UI font), fallback `Segoe UI` → `system-ui`. Mono is **Cascadia Code** / Consolas for keycaps, model names, values. See "Fonts" below — these are OS fonts, intentionally not shipped.
- **Display: Chakra Petch** (bold italic) — a square, forward-slanted technical face echoing the wordmark's "fast" voice, exposed as `--font-display`. **Marketing / brand headings only** — never the dense app UI, which stays on the UI sans.
- Runs at **14px base**; ramp goes 11 (caption) · 12 (meta) · 13 (control) · 13.5 (body) · 15 (title) · 22 (screen title) · 26 (hero).
- **Three UI weights only:** 400 regular, 500 medium (labels, buttons), 600 semibold (titles, unread). Titles tighten letter-spacing to `-0.01em`; overlines widen to `0.06em` uppercase.

### Spacing & layout
- **Dense desktop rhythm** — 2px increments low in the scale (2/4/6/8/10/12/16…). Rows are `10px 16px`; cards `12px 16px`.
- **Fixed shell metrics:** 56px nav rail, 48px header, 30px footer hint strip, ~244px folder sidebar, 280px contact rail / 288px calendar day-panel, 620–640px command palette / dialog width.
- Layout is **flex/grid with explicit gaps**, full-height panels, internal scroll — no page scroll.

### Borders, radii, elevation
- **Hairlines do the work:** `--border` at 6% white (13% for `--border-strong`) separate everything. Cards are bordered, not shadowed.
- **Modest radii:** 4px (kbd chips) · 6px (buttons, inputs) · 8px (cards / message cards) · 12px (palette, dialogs) · pill (999px, badges & status).
- **Shadow only on overlays** — the command palette, compose modal, and toast float on `--shadow-overlay`. Resting surfaces cast none.

### Motion
- **Two short animations, no bounce on content.** `sm-fade-in` (120ms ease-out) for overlays appearing; `sm-pop-in` (140ms, `cubic-bezier(.2,.9,.3,1)`) for dialogs/toasts scaling up 0.98→1 with a 4px rise. Fast, calm, functional.
- **Hover** lifts to `--bg-hover` (or the next surface up); primary buttons deepen accent→accent-strong rather than change opacity. **Selected** rows use `--bg-selected` (a cerulean-tinted surface). **Disabled** drops to 50% opacity.
- **Focus** is a hard `--focus-ring` (2px cerulean halo) on `:focus-visible` everywhere — a WCAG requirement the product treats as a feature.

### Imagery
- The product is nearly image-free by design (a mail client). The one full-bleed image moment is **Inbox Zero** — the **`RestState`** component: when a split hits zero, the list is replaced by a daily photo **rotated from the Unsplash API**, with the app chrome (split tabs, header) sitting translucently on top — **no headline copy**, just **your inbox-zero streak** (🔥 `{n}-day inbox-zero streak`, or a quiet "Inbox zero" at 0) bottom-left and the **required Unsplash attribution** bottom-right, both under a bottom scrim so they stay legible on any photo. (Specimens: *Components → Mail → RestState* and *Patterns → Inbox Zero*.) Sender **avatars** are the main recurring "imagery": photo when available, else a deterministic OKLCH monogram keyed to the email address (same sender → same hue, always). HTML email bodies render on a clean **white card** inside a sandboxed iframe — a deliberate light island in the dark shell.

---

## Iconography

Snail Mail's iconography is **monochrome and inline**, rendered in the current text color. Two actions use small **line-drawn SVG icons** — a paperclip (attach) and an original paperclip-with-sparkle (AI / Write-with-AI, an homage to the paperclip assistant, **not** Microsoft's Clippy mascot, which is trademarked). Everything else is a **Unicode glyph**. Keep icons monochrome and lightweight; don't pull in a heavy icon library.

- **Unicode glyphs:** `←` back · `‹` `›` day nav · `★` star (in `--accent-2` gold) · `▦` calendar toggle · `◎` empty state · `•••` show-quoted-text toggle · `×` close/remove · `⭳` save · `↓`/`↑` navigate · `✓` done · `🕑` remind.
- **Line SVGs:** paperclip (attach) and the sparkle-paperclip (AI). Stroke = `currentColor`, 2px, round caps. Reuse these two rather than inventing new marks.
- **The brand mark** (`assets/snail-mail-icon.svg`, with an `-on-dark` reverse and the square `snail-mail-app-tile.svg`) is the only bespoke graphic — the rocket-snail. Use it for the app's identity lockup; the in-app header pairs the mark with the "Snail Mail" wordmark (full-artwork lockup by default — see *Brand → Logo* for header treatments).
- When an interface needs an icon the product doesn't have, prefer a **matching Unicode glyph** in the current text color, or a light 2px line SVG consistent with the paperclip — not a filled/duotone icon set.

---

## Keyboard & shortcut hints — the rule

Snail Mail is keyboard-first, so **every control that has a shortcut teaches it**. The system bakes one rule for this, adopted from the product's shortcut engine (`src/lib/keyboard.ts`, `src/lib/shortcuts-catalog.ts`):

> **Show a shortcut as keycap chips, never as plain text.** On hover or keyboard focus, an actionable control floats a `HoverHint` — a tooltip pairing the action's short label with its binding rendered as little keycaps (`ctrl` `K`), the "square button icons combined" from the Superhuman shortcut sheet. Not a bare `title=""`, not "(Ctrl+K)" spelled out in the label.

Three primitives implement it (all in the bundle):

- **`KeyHint`** — the atom. Turns a binding EXPR into keycaps: `mod+k` → `ctrl` `K`, `shift+e` → `shift` `E`, chords `g i` → `G` `I` (adjacent — no separator), alternatives `j|k` → `J` `K`. `on="surface"` is the raised `.kbd` look (footer strip, palette rows, `ShortcutsPanel`); `on="tooltip"` is the solid keycap tuned for a hint card. Windows-first, so `mod` renders `ctrl`.
- **`HoverHint`** — the rule itself. Wrap any control; it shows the label + `KeyHint` on hover/focus. The card is a **theme-aware inverse** of the app — a light card on the dark theme, a dark card on the light theme (the `--tip-*` tokens) — so it always pops off the surface. It portals to `<body>`, so it never clips inside a row or a scrolling panel, and flips / clamps to stay on-screen.
- **`ShortcutsPanel`** — the full reference sheet built from `SHORTCUTS_CATALOG` (Superhuman parity), every command by category with its keys as chips; planned rows dimmed with a **soon** tag.

Pull bindings from `SHORTCUTS_CATALOG` (the same source the keymap uses) so a hint and the real shortcut never drift. The plain `Kbd` chip stays for **inline help text** ("press `Tab` for the next split") — but for a *control's* shortcut, reach for `HoverHint`. In the UI kit the rule is live on the mail-row actions (Mark Done · Remind Me), the thread header, the compose action bar, search, and the calendar nav.

---

## Fonts

The product's native faces are Windows-only (`Segoe UI Variable Text`, `Cascadia Code`). To make previews and consumer designs render correctly on **any** OS, the system ships the closest **Google webfont** substitutes, loaded via `tokens/fonts.css`:

- **Source Sans 3** — UI / body (the Segoe UI stand-in). A humanist sans with similar proportions and x-height.
- **JetBrains Mono** — keycaps, code, values (the Cascadia stand-in).
- **Chakra Petch** — the **display** face, `--font-display`. A square, forward-slanted technical italic that echoes the rocket-snail wordmark. **Marketing / brand headings only** — keep the dense app UI on Source Sans.

The original OS families remain first in the fallback stacks (`typography.css`), so a Windows machine that has Segoe/Cascadia still renders them; everyone else gets the webfont automatically. If you'd rather ship the *real* Segoe UI Variable, upload the file and I'll swap `tokens/fonts.css` to self-host it.

---

## Components

Reusable primitives, grouped by concern. Mount via `const { X } = window.<Namespace>` after loading `_ds_bundle.js` (run `check_design_system` for the exact `<Namespace>`).

- **forms/** — `Button` (primary / secondary / quiet / danger; sm/md/lg), `IconButton` (quiet / bordered, with an `active` toggle state), `Input` (boxed / bare, with optional inline label).
- **core/** — `Avatar` (photo or deterministic monogram), `Kbd` (raw keycap chip), `KeyHint` (a binding → keycap chips), `HoverHint` (the hover-shortcut tooltip rule), `Badge` (count pill: neutral / active / solid), `Pill` (status/label chip: 5 tones × outline/dim/solid).
- **mail/** — `MailRow` (inbox conversation row; multi-select checked state), `BulkBar` (multi-select bulk-triage bar: Mark Done / Trash / Label + one counted undo), `MessageCard` (collapsed/expanded thread message), `AttachmentChip` (open/save/remove; plus a Drive-upload progress state for the compose tray), `SplitTab` (accent-underline tab + total badge), `Label` (colored auto-label tag), `InstantReply` (AI suggestion chips + preview + thumbs), `ContactPanel` (right-hand identity rail + CRM + mail history), `RestState` (inbox-zero photo surface — streak + attribution, no headline).
- **calendar/** — `EventBlock` (event chip in the day panel / week grid, with past/declined/pending states), `EventPopover` (event details + guest RSVP, role-gated edit/delete), `EventModal` (create/edit dialog with the notify-guests step).
- **pickers/** — `PickerShell` (shared keyboard option-list chrome — the base for every picker), `DrivePicker` (attach from Google Drive — insert-link vs attach-copy, reconnect gate).
- **navigation/** — `NavRail` (far-left icon rail), `FolderSidebar` (mailbox navigator + Auto Labels).
- **feedback/** — `UndoToast` (bottom-left undo confirmation), `UndoSendBar` (Undo Send countdown).
- **shortcuts/** — `ShortcutsPanel` (the full keyboard reference sheet + `SHORTCUTS_CATALOG`).

Each component ships a `.d.ts` (props contract), a `.prompt.md` (usage), and its group shares an `@dsCard` specimen.

### Feature-parity map

Toward Superhuman-class coverage, in Snail Mail's identity. Shipped in this system: **Split Inbox** (Important/Other + tabs), **multi-select bulk triage** (X select · select-all-from-here · bulk bar), **command palette** (Shell Command), **Instant Reply** + AI draft, **auto-labels**, **contact rail** with CRM + history, **undo anything** (toasts), **folder navigator** (Starred/Drafts/Sent/Done/Scheduled/Reminders/Snippets/Muted/Spam/Trash), **search with operator tips** (`from:`, `has:attachment`, `is:unread`, `before:`…), **calendar** (day-panel + week view, plus **event create/edit** and **details + guest RSVP**), **attach from Google Drive** (insert-link vs attach-copy) with a compose **attachment tray** (incl. upload progress), and the shared **picker** chrome behind every option list, plus the keyboard hint bar. In progress (tracking the app): the rest of the picker family (snooze · send-later · move · snippet · drafts · get-me-to-zero), thread **Ask AI** + invite **RSVP bar**, compose **selection bubble** + AI bar + spell/grammar, **onboarding**, and **settings**.

**Intentional additions** (present in the codebase already: Split Inbox, command palette, Instant Reply, labels, undo/toasts, calendar). Added here to reach feature parity with the reference screenshots the user supplied, each an established email-client pattern: `NavRail` (left icon rail), `FolderSidebar` (full mailbox navigator + Auto Labels), `ContactPanel` (right identity rail with CRM + history), and the search **operator-tips** panel. These extend the product's surface; validate them against the real app as it grows.

## UI kit

**`ui_kits/snail-mail/`** — an interactive, dual-theme recreation of the client, composing the primitives above:
- **Nav rail** (Mail / Calendar) + slide-in **folder sidebar** with Auto Labels.
- **Split inbox** — Important / Other tabs, colored unread dots, inline auto-labels, hover-revealed row actions (done / remind), and **multi-select** (`X`, or Ctrl/⌘+click) with a **bulk bar** (Mark Done · Trash · Label + one counted undo).
- **Thread view** — collapsed older messages, expanded latest on a light card, a **contact rail** (identity, Add to CRM, mail history) and **Instant Reply** chips with live preview + thumbs.
- **Compose** — To/Subject/body, ✦ Write-with-AI streaming draft, Smart Send / Remind, snippet/attach/discard.
- **Shell Command** (`⌘K`) — dark-on-any-theme palette with per-command icons + keycaps.
- **Search** (`/`) — results + an operator **Tips** panel.
- **Calendar** — a full **24-hour, 7-day week grid**: every hour on screen (scrolls, opens at ~7am), per-calendar colored events with side-by-side overlap packing, today column + live red now-line, an all-day lane, and a click-to-open event popover. The right-hand **calendar panel** (Superhuman-parity) carries a navigable mini-month (click any day to jump the week), Meet, Booking Pages, and the **calendars list grouped by account** — each a color-coded checkbox that shows/hides its events live; disconnected accounts show a reconnect prompt.
- **Undo toasts** — bottom-left, after Mark Done / send.
- Theme toggle (☾/☀) flips **light ⇄ dark** live; `C` compose · `Tab` switch split · `E` done · `Esc` back.

---

*Generated as a living design guide. The Design System tab renders every specimen and component card. Iterate with me to refine any value.*
