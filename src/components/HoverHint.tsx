// Keyboard hint primitives (design system core/KeyHint + HoverHint).
//
// The rule: a control that has a shortcut teaches it — on hover or keyboard
// focus it floats a tooltip pairing the action's short label with its binding
// drawn as keycap chips, never a bare title="" and never "(Ctrl+K)" spelled
// out in a label. The card is a theme-aware INVERSE of the app (light card on
// dark, dark card on light — the --tip-* tokens), portals to <body> so it
// never clips inside a row or scrolling panel, and flips/clamps on-screen.
//
// Bindings resolve live from Settings → Shortcuts via the command id, the
// same source the keymap uses, so a hint and the real shortcut never drift.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { exprKeycaps } from "@/lib/keyboard";
import { useSettings } from "@/stores/settings";

/** A binding expr as keycap chips. Combos and chords both flatten to ADJACENT
 *  keycaps (no "+", no "then" — proximity conveys the grouping); "j|k"
 *  alternatives render side by side. `on="tooltip"` is the solid keycap tuned
 *  for the hint card; `on="surface"` matches the raised `.kbd` look. */
export function KeyHint({
  expr,
  on = "surface",
}: {
  expr: string;
  on?: "surface" | "tooltip";
}) {
  const chips = expr
    .split("|")
    .flatMap((alt) => exprKeycaps(alt.trim()))
    .filter((chip) => chip !== "then");
  if (chips.length === 0) return null;
  const cap =
    on === "tooltip"
      ? {
          background: "var(--tip-key-bg)",
          color: "var(--tip-key-fg)",
          border: "1px solid transparent",
        }
      : {
          background: "var(--bg-raised)",
          color: "var(--text-secondary)",
          border: "1px solid var(--border-strong)",
        };
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {chips.map((chip, i) => (
        <kbd
          key={i}
          className="inline-flex h-[18px] min-w-[18px] items-center justify-center whitespace-nowrap rounded px-1.5 text-[11px] not-italic leading-none"
          style={{ fontFamily: "var(--font-mono)", ...cap }}
        >
          {chip}
        </kbd>
      ))}
    </span>
  );
}

type Placement = "top" | "bottom" | "left" | "right";

function HintTip({
  label,
  expr,
  placement,
  anchor,
}: {
  label: string;
  expr: string;
  placement: Placement;
  anchor: { top: number; bottom: number; left: number; right: number; cx: number; cy: number };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: -9999, left: -9999, ready: false });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const M = 8; // keep this far from the viewport edge
    const GAP = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let p = placement;
    if (p === "top" && anchor.top - GAP - h < M) p = "bottom";
    else if (p === "bottom" && anchor.bottom + GAP + h > vh - M) p = "top";
    else if (p === "left" && anchor.left - GAP - w < M) p = "right";
    else if (p === "right" && anchor.right + GAP + w > vw - M) p = "left";

    let top: number;
    let left: number;
    if (p === "top") top = anchor.top - GAP - h;
    else if (p === "bottom") top = anchor.bottom + GAP;
    else top = anchor.cy - h / 2;

    if (p === "left") left = anchor.left - GAP - w;
    else if (p === "right") left = anchor.right + GAP;
    else left = anchor.cx - w / 2;

    left = Math.max(M, Math.min(left, vw - M - w));
    top = Math.max(M, Math.min(top, vh - M - h));
    setPos({ top, left, ready: true });
  }, [anchor, placement, label, expr]);

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="zb-pop-in pointer-events-none fixed z-[70] inline-flex items-center gap-2.5 whitespace-nowrap rounded-lg py-[5px] pl-[11px] pr-2 text-[13px] font-medium leading-tight"
      style={{
        top: pos.top,
        left: pos.left,
        opacity: pos.ready ? 1 : 0,
        background: "var(--tip-bg)",
        color: "var(--tip-fg)",
        border: "1px solid var(--tip-border)",
        boxShadow: "var(--tip-shadow)",
      }}
    >
      <span>{label}</span>
      {expr && <KeyHint expr={expr} on="tooltip" />}
    </div>,
    document.body
  );
}

/** Wrap exactly one interactive control. `command` pulls the live binding
 *  from Settings → Shortcuts; `expr` overrides it for editor-native keys. */
export function HoverHint({
  label,
  command,
  expr,
  placement = "top",
  delay = 320,
  wrapClassName = "inline-flex",
  children,
}: {
  label: string;
  command?: string;
  expr?: string;
  placement?: Placement;
  delay?: number;
  /** Layout class for the wrapper span (default inline-flex; use e.g.
   *  "flex w-full" when wrapping a full-width control). */
  wrapClassName?: string;
  children: React.ReactNode;
}) {
  const bound = useSettings((s) =>
    command ? (s.settings.shortcuts[command] ?? "") : ""
  );
  // The one choke point for all ~21 call sites: with hints off the card still
  // appears — it is how a bare icon button says what it does — but it drops to
  // the label alone, no keycaps. The shortcut itself keeps working.
  const keyHints = useSettings((s) => s.settings.showKeyHints);
  const resolved = keyHints ? (expr ?? bound) : "";
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{
    top: number;
    bottom: number;
    left: number;
    right: number;
    cx: number;
    cy: number;
  } | null>(null);

  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchor({
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
      });
      setOpen(true);
    }, delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <span
      ref={ref}
      className={wrapClassName}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onMouseDown={hide}
    >
      {children}
      {open && anchor && (
        <HintTip label={label} expr={resolved} placement={placement} anchor={anchor} />
      )}
    </span>
  );
}
