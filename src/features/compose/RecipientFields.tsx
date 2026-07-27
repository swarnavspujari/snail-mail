// The To / Cc / Bcc / Subject block, shared by both composer shells with two
// collapse behaviors:
//
//   • variant="dock"  (reply/forward) — recipients are pre-filled, so they
//     collapse to a one-line summary ("To Alice  Cc …"); click or Ctrl+Shift+O
//     expands all four rows.
//   • variant="modal" (new message) — Superhuman-style: To + Subject are always
//     visible with the caret on To; a chevron on the To row reveals Cc/Bcc.
//
// Either way Ctrl+Shift+O/C/B/S (via the fission:compose-field event) reveal +
// focus a field, and Tab then walks To → Cc → Bcc → Subject → body.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "@/stores/ui";
import { displayLabel, type Recipients } from "@/lib/recipients";
import { RecipientChipGroup, RecipientChips } from "./RecipientChips";

type Field = "to" | "cc" | "bcc" | "subject";

function summarize(list: Recipients): string {
  return list.map(displayLabel).join(", ");
}

function FieldRow({
  field,
  label,
  right,
  children,
}: {
  field: Field;
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      data-field={field}
      // items-start, not items-center: a full To row wraps onto several lines
      // of chips and the label has to stay on the first one.
      className="flex items-start gap-2 border-b border-line px-4 py-2"
    >
      <label className="w-14 shrink-0 py-[3px] text-[12.5px] font-medium text-ink-2">
        {label}
      </label>
      {children}
      {right}
    </div>
  );
}

export function RecipientFields({ variant }: { variant: "modal" | "dock" }) {
  const compose = useUi((s) => s.compose)!;
  const rootRef = useRef<HTMLDivElement>(null);
  // dock: whether the summary is expanded to full rows.
  // modal: whether Cc/Bcc are revealed below To.
  const [expanded, setExpanded] = useState(false);

  const patch = (p: Partial<typeof compose>) =>
    useUi.setState((s) => ({ compose: s.compose ? { ...s.compose, ...p } : null }));

  const focusField = useCallback(
    (field: Field) => {
      // Reveal any hidden rows before focusing: the dock un-summarizes; the
      // modal only needs to reveal Cc/Bcc (To/Subject are always shown).
      if (variant === "dock" || field === "cc" || field === "bcc") setExpanded(true);
      requestAnimationFrame(() => {
        rootRef.current
          ?.querySelector<HTMLInputElement>(`[data-field="${field}"] input`)
          ?.focus();
      });
    },
    [variant]
  );

  // Ctrl+Shift+O/C/B/S (from the keyboard engine) reveal + focus a field.
  useEffect(() => {
    const handler = (e: Event) => {
      const field = (e as CustomEvent).detail?.field as Field | undefined;
      if (field) focusField(field);
    };
    window.addEventListener("fission:compose-field", handler);
    return () => window.removeEventListener("fission:compose-field", handler);
  }, [focusField]);

  const summary = useMemo(() => {
    const to = summarize(compose.to);
    const cc = summarize(compose.cc);
    const bcc = summarize(compose.bcc);
    return (
      <>
        <span className="text-ink-3">To</span> {to || "…"}
        {cc && (
          <>
            {"  "}
            <span className="text-ink-3">Cc</span> {cc}
          </>
        )}
        {bcc && (
          <>
            {"  "}
            <span className="text-ink-3">Bcc</span> {bcc}
          </>
        )}
      </>
    );
  }, [compose.to, compose.cc, compose.bcc]);

  const ccBccRows = (
    <>
      <FieldRow field="cc" label="Cc">
        <RecipientChips field="cc" />
      </FieldRow>
      <FieldRow field="bcc" label="Bcc">
        <RecipientChips field="bcc" />
      </FieldRow>
    </>
  );

  const subjectRow = (
    <FieldRow field="subject" label="Subject">
      <input
        value={compose.subject}
        onChange={(e) => patch({ subject: e.target.value })}
        className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
        placeholder="Subject"
      />
    </FieldRow>
  );

  // One group across all three rows, so a chip dragged out of To can land in
  // Cc or Bcc — a drop rewrites two lists at once, hence the whole-patch
  // callback rather than three independent onChanges.
  const lists = useMemo(
    () => ({ to: compose.to, cc: compose.cc, bcc: compose.bcc }),
    [compose.to, compose.cc, compose.bcc]
  );

  // ---- dock: summary ↔ four rows -------------------------------------------
  if (variant === "dock") {
    return (
      <RecipientChipGroup lists={lists} onChange={patch}>
      <div ref={rootRef}>
        {expanded ? (
          <>
            <FieldRow field="to" label="To">
              <RecipientChips field="to" />
            </FieldRow>
            {ccBccRows}
            {subjectRow}
          </>
        ) : (
          <button
            onClick={() => focusField("to")}
            title="Edit recipients — Ctrl+Shift+O To · C Cc · B Bcc · S Subject"
            className="flex w-full items-center gap-1 border-b border-line px-4 py-2 text-left text-[12.5px] text-ink-2 hover:bg-hover"
          >
            {summary}
          </button>
        )}
      </div>
      </RecipientChipGroup>
    );
  }

  // ---- modal: To + Subject always; Cc/Bcc behind a chevron -----------------
  return (
    <RecipientChipGroup lists={lists} onChange={patch}>
    <div ref={rootRef}>
      <FieldRow
        field="to"
        label="To"
        right={
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setExpanded((e) => !e)}
            title={expanded ? "Hide Cc & Bcc" : "Add Cc & Bcc"}
            aria-label={expanded ? "Hide Cc and Bcc" : "Add Cc and Bcc"}
            aria-expanded={expanded}
            className="shrink-0 rounded p-1 text-ink-3 hover:bg-hover hover:text-ink"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className={`transition-transform ${expanded ? "rotate-180" : ""}`}
            >
              <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        }
      >
        <RecipientChips field="to" autoFocus />
      </FieldRow>
      {expanded && ccBccRows}
      {subjectRow}
    </div>
    </RecipientChipGroup>
  );
}
