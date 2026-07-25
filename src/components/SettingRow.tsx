// The unit every preference pane is built from (design system forms/SettingRow):
// label + help on the left, exactly one control on the right, hairline-separated
// inside a rounded group. Read-only facts are labelled and never sit between two
// controls.

export function RowGroup({
  title,
  hint,
  colLabel,
  isNew,
  children,
  action,
}: {
  title?: string;
  hint?: string;
  /** Column header for a repeated control ("Hide when empty"). */
  colLabel?: string;
  /** Marks a section that had no interface before this redesign. */
  isNew?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section>
      {(title || colLabel) && (
        <div className="mx-0.5 mb-2 flex items-baseline gap-2.5">
          {title && (
            <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
          )}
          {isNew}
          <div className="flex-1" />
          {action}
          {colLabel && (
            <span className="text-[10.5px] uppercase tracking-[0.05em] text-ink-3">
              {colLabel}
            </span>
          )}
        </div>
      )}
      {hint && (
        <p className="mx-0.5 mb-2.5 -mt-1 max-w-[70ch] text-[12px] leading-relaxed text-ink-3">
          {hint}
        </p>
      )}
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {children}
      </div>
    </section>
  );
}

export function SettingRow({
  label,
  help,
  tag,
  children,
  tone,
}: {
  label: React.ReactNode;
  help?: React.ReactNode;
  /** Status pill shown next to the label. */
  tag?: React.ReactNode;
  /** The single control for this setting. */
  children?: React.ReactNode;
  tone?: "danger";
}) {
  return (
    <div className="flex items-center gap-4 border-t border-line px-3.5 py-[11px] transition-colors first:border-t-0 hover:bg-hover">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`text-[13px] ${tone === "danger" ? "text-bad" : "text-ink"}`}
          >
            {label}
          </span>
          {tag}
        </div>
        {help && (
          <div className="mt-0.5 text-[11.5px] leading-snug text-ink-3">{help}</div>
        )}
      </div>
      {children && (
        <div className="flex shrink-0 items-center gap-2.5">{children}</div>
      )}
    </div>
  );
}

/** A row whose content spans the full width (an editor, a list, a form). */
export function WideRow({ children }: { children: React.ReactNode }) {
  return <div className="border-t border-line px-3.5 py-3 first:border-t-0">{children}</div>;
}
