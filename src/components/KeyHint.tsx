// A binding as keycap chips (design system core/KeyHint): "mod+k" → ctrl K,
// "g i" → G then I, "j|down" → J ↓. The atom every shortcut hint is built from.
import { exprKeycaps } from "@/lib/keyboard";

export function KeyHint({
  expr,
  size = "md",
  on = "surface",
  className = "",
}: {
  expr: string;
  size?: "sm" | "md";
  /** "tooltip" flips the caps to the inverse hint-card palette. */
  on?: "surface" | "tooltip";
  className?: string;
}) {
  if (!expr) return null;
  const dims =
    size === "sm"
      ? "min-w-[15px] h-[15px] px-[5px] text-[10px]"
      : "min-w-[18px] h-[18px] px-1.5 text-[11px]";
  const cap =
    on === "tooltip"
      ? "border-transparent bg-[var(--tip-key-bg)] text-[var(--tip-key-fg)]"
      : "border-line-strong bg-raised text-ink-2";
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 align-middle ${className}`}>
      {expr
        .split("|")
        .flatMap((alt, i) =>
          exprKeycaps(alt.trim()).map((chip, j) =>
            chip === "then" ? (
              <span key={`${i}-${j}`} className="text-[10px] text-ink-3">
                then
              </span>
            ) : (
              <kbd
                key={`${i}-${j}`}
                className={`inline-flex items-center justify-center rounded border font-mono not-italic leading-none ${dims} ${cap}`}
              >
                {chip}
              </kbd>
            )
          )
        )}
    </span>
  );
}
