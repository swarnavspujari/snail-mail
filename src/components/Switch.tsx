// Boolean control (design system forms/Switch): 34×20, accent fill when on,
// on-accent knob. The only control a true/false setting ever uses.

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name — the visible label lives in the SettingRow beside it. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-[34px] shrink-0 rounded-full border transition-colors disabled:opacity-50 ${
        checked ? "border-transparent bg-accent" : "border-line-strong bg-raised"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full transition-all ${
          checked ? "left-4 bg-on-accent" : "left-[2px] bg-ink-3"
        }`}
      />
    </button>
  );
}
