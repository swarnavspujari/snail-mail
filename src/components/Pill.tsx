// Count/status pill (design system core/Badge · Pill).

export type PillTone = "neutral" | "accent" | "success" | "warning" | "danger";
export type PillFill = "outline" | "dim" | "solid";

const TONES: Record<PillTone, { fg: string; edge: string; dim: string }> = {
  neutral: { fg: "text-ink-2", edge: "border-line-strong", dim: "bg-raised" },
  accent: { fg: "text-accent-strong", edge: "border-accent", dim: "bg-accent-dim" },
  success: { fg: "text-ok", edge: "border-ok", dim: "bg-ok/15" },
  warning: { fg: "text-warn", edge: "border-warn", dim: "bg-warn/15" },
  danger: { fg: "text-bad", edge: "border-bad", dim: "bg-bad/15" },
};

/** Status pill (design system core/Pill): a tone × a fill. "stored",
 *  "needs reconnect", "Conflict", "by context" — the vocabulary settings uses
 *  to say what state a row is in without a sentence. */
export function Pill({
  children,
  tone = "neutral",
  fill = "dim",
  title,
}: {
  children: React.ReactNode;
  tone?: PillTone;
  fill?: PillFill;
  title?: string;
}) {
  const t = TONES[tone];
  const look =
    fill === "outline"
      ? `border ${t.edge} bg-transparent ${t.fg}`
      : fill === "solid"
        ? tone === "neutral"
          ? "border border-transparent bg-raised text-ink"
          : `border border-transparent ${TONE_SOLID[tone]}`
        : `border border-transparent ${t.dim} ${t.fg}`;
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-[1.5px] text-[11px] font-medium leading-4 ${look}`}
    >
      {children}
    </span>
  );
}

const TONE_SOLID: Record<Exclude<PillTone, "neutral">, string> = {
  accent: "bg-accent text-on-accent",
  success: "bg-ok text-on-accent",
  warning: "bg-warn text-on-accent",
  danger: "bg-bad text-on-accent",
};

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "active" | "solid";
}) {
  const cls =
    tone === "solid"
      ? "border-transparent bg-accent text-on-accent"
      : tone === "active"
        ? "border-accent/40 bg-accent-dim text-accent-strong"
        : "border-line bg-raised text-ink-3";
  return (
    <span
      className={`inline-block min-w-[18px] rounded-full border px-1.5 text-center text-[10.5px] leading-[17px] tabular-nums ${cls}`}
    >
      {children}
    </span>
  );
}
