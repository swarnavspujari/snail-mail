// Two- or three-option control (design system forms/Segmented). Four or more
// options belong in a Select — a segmented row that wide stops being scannable.

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex shrink-0 gap-0.5 rounded-[7px] border border-line-strong bg-raised p-0.5"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`whitespace-nowrap rounded-[5px] px-[11px] py-1 text-[12px] ${
              on
                ? "bg-accent-dim font-medium text-ink"
                : "text-ink-3 hover:text-ink-2"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Four-or-more-option control (design system forms/Select). Native under the
 *  hood so it keeps its keyboard behaviour; styled as the design's field. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  className = "",
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={`max-w-[280px] cursor-pointer truncate rounded-md border border-line-strong bg-raised px-2.5 py-1.5 text-[12.5px] text-ink outline-none hover:border-accent focus:border-accent ${className}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
