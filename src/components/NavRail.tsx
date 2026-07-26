// Far-left icon rail (design system navigation/NavRail): brand mark on top,
// then Mail + Calendar sharing ONE vertical pill — a segmented control whose
// single raised "thumb" slides between the two slots as the active view
// changes, so the switch reads as one control with two states rather than two
// separate buttons. Depth is the bg-raised thumb over the bg-surface track
// (no shadow), per the resting-surface rule.
import type { CSSProperties } from "react";
import { useSettings } from "@/stores/settings";

// Over the inbox-zero photo the rail goes frosted: token overrides let the
// same classes render white-on-photo (matches App's ZERO_CHROME treatment).
const OVERLAY_VARS = {
  "--bg-base": "transparent",
  "--bg-surface": "rgba(255,255,255,0.12)",
  "--bg-raised": "rgba(255,255,255,0.24)",
  "--bg-hover": "rgba(255,255,255,0.14)",
  "--text-secondary": "rgba(255,255,255,0.9)",
  "--text-muted": "rgba(255,255,255,0.62)",
  "--border": "rgba(255,255,255,0.28)",
  "--accent-strong": "#fff",
} as CSSProperties;

// Rail icons are line-drawn SVGs (stroke, 2px, round joins) rather than the
// brand's Unicode glyphs: the grid glyph (▦) simply does not read as a
// calendar at 18px, so the two destinations share one crisp, matched set.
function MailIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="block shrink-0"
    >
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M4 7.5l6.9 4.8a2 2 0 0 0 2.2 0L20 7.5" />
    </svg>
  );
}

function CalendarIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="block shrink-0"
    >
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 9.5h17" />
      <path d="M8 3v3.5" />
      <path d="M16 3v3.5" />
    </svg>
  );
}

const SLOT = 34;
const PAD = 3;

export function NavRail({
  view,
  onMail,
  onCalendar,
  overlay,
}: {
  view: "mail" | "calendar";
  onMail: () => void;
  onCalendar: () => void;
  /** Render translucently over the inbox-zero photo. */
  overlay?: boolean;
}) {
  const theme = useSettings((s) => s.settings.theme);
  const items = [
    { id: "mail" as const, label: "Mail", icon: <MailIcon />, onClick: onMail },
    {
      id: "calendar" as const,
      label: "Calendar",
      icon: <CalendarIcon />,
      onClick: onCalendar,
    },
  ];
  const activeIndex = Math.max(0, items.findIndex((i) => i.id === view));

  return (
    <nav
      className={`relative flex w-14 shrink-0 flex-col items-center gap-2 bg-base py-3 ${
        overlay ? "" : "border-r border-line"
      }`}
      style={overlay ? OVERLAY_VARS : undefined}
    >
      {/* The rocket-snail mark — ink flips with the theme (navy on light,
          near-white on dark); over the photo it's always the on-dark cut. */}
      <img
        src={
          !overlay && theme === "light"
            ? "/snail-mail-icon.svg"
            : "/snail-mail-icon-on-dark.svg"
        }
        alt="Snail Mail"
        className="mb-2 h-8 w-8"
        draggable={false}
      />
      <div
        role="tablist"
        aria-orientation="vertical"
        className="relative flex flex-col rounded-full border border-line bg-surface"
        style={{ padding: PAD }}
      >
        {/* One thumb for both slots — it slides, so the pair reads as a single
            switch rather than two buttons. `--ease-pop` resolves to an empty
            string in some builds, and an empty var() is NOT undefined, so the
            fallback would not kick in and the whole transition would be
            dropped; the curve is inlined instead. */}
        <span
          aria-hidden="true"
          className="absolute rounded-full border border-line bg-raised"
          style={{
            left: PAD,
            top: PAD,
            width: SLOT,
            height: SLOT,
            boxSizing: "border-box",
            transform: `translateY(${activeIndex * SLOT}px)`,
            transition: "transform 220ms cubic-bezier(.2,.8,.2,1)",
          }}
        />
        {items.map((it) => (
          <button
            key={it.id}
            role="tab"
            aria-selected={view === it.id}
            aria-label={it.label}
            title={it.label}
            onClick={it.onClick}
            className={`relative z-[1] flex items-center justify-center rounded-full ${
              view === it.id
                ? "text-accent-strong"
                : "text-ink-3 hover:text-ink-2"
            }`}
            style={{ width: SLOT, height: SLOT }}
          >
            {it.icon}
          </button>
        ))}
      </div>
    </nav>
  );
}
