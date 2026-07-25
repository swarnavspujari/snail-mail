/** Keycap hint chip (design system core/Kbd) — the ONE component every
 *  hardcoded key hint renders through, so the chip can never drift between
 *  surfaces. `.kbd` in theme.css is its style; nothing else should reach for
 *  that class directly.
 *
 *  Deliberately NOT gated on settings.showKeyHints: the shortcuts panel, the
 *  Settings → Shortcuts editor and the onboarding key tour are ABOUT keys and
 *  keep their caps no matter what. Call sites that are decoration gate
 *  themselves; hover hints gate inside HoverHint. */
export function Kbd({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={`kbd ${className}`}>{children}</span>;
}
