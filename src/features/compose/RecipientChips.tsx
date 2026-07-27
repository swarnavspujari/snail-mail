// Recipients as chips: one rectangle per address, × to remove, drag to
// reorder — and drag ACROSS To / Cc / Bcc, which is the half of drag that
// actually saves work. Replaces the old comma-separated <input>, where
// reordering meant retyping and removing one address meant hunting for the
// right comma.
//
// Drag runs on pointer events, not HTML5 drag-and-drop: DnD is unreliable
// inside the WebView2 composer. The drop target is resolved with
// elementFromPoint against [data-chip-slot] markers, so one gesture can cross
// row boundaries without any of the three rows knowing about the others.
//
// All list arithmetic lives in lib/recipients.ts and is pure, so reordering
// and cross-field moves are unit-tested with no DOM.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { backend } from "@/lib/ipc";
import { Avatar } from "@/components/Avatar";
import {
  addRecipients,
  displayLabel,
  isPlausibleAddress,
  parseRecipientText,
  removeRecipient,
  splitTypedRecipients,
  transferRecipient,
  type ChipSlot,
  type RecipientLists,
  type Recipients,
} from "@/lib/recipients";
import type { Contact } from "@/lib/types";

const DEBOUNCE_MS = 120;
/** Pointer travel before a press becomes a drag — below this it stays a click,
 *  so tapping a chip (or its ×) never starts one. */
const DRAG_SLOP_PX = 4;

// ---------------------------------------------------------------- the group
//
// The three rows share one drag session, so a chip can leave To and land in
// Bcc. A group owns every list it renders chips for; a single-field consumer
// (the calendar's Guests field) is just a group of one.

type Lists = RecipientLists;
type DragTarget = ChipSlot;

interface GroupApi {
  lists: Lists;
  setList: (field: string, next: Recipients) => void;
  dragging: DragTarget | null;
  over: DragTarget | null;
  beginDrag: (from: DragTarget, ev: React.PointerEvent) => void;
}

const GroupContext = createContext<GroupApi | null>(null);

export function RecipientChipGroup<L extends Lists>({
  lists,
  onChange,
  children,
}: {
  lists: L;
  /** Whole-group patch — a cross-field drag rewrites two lists at once. */
  onChange: (patch: Partial<L>) => void;
  children: React.ReactNode;
}) {
  const [dragging, setDragging] = useState<DragTarget | null>(null);
  const [over, setOver] = useState<DragTarget | null>(null);
  // Window listeners outlive the render that installed them; read live state
  // through refs so a drop never applies to a stale list.
  const listsRef = useRef<Lists>(lists);
  listsRef.current = lists;
  const onChangeRef = useRef<(patch: Lists) => void>(onChange as (p: Lists) => void);
  onChangeRef.current = onChange as (p: Lists) => void;

  const setList = useCallback((field: string, next: Recipients) => {
    onChangeRef.current({ [field]: next });
  }, []);

  const beginDrag = useCallback((from: DragTarget, ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    const startX = ev.clientX;
    const startY = ev.clientY;
    let armed = false;
    let target: DragTarget | null = null;

    const resolve = (x: number, y: number): DragTarget | null => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-chip-slot]");
      if (!el) return null;
      const field = el.dataset.chipField;
      if (!field || !(field in listsRef.current)) return null;
      const raw = el.dataset.chipIndex;
      // A row's trailing slot carries no index — dropping there means "end".
      const index = raw === undefined ? listsRef.current[field].length : Number(raw);
      return { field, index };
    };

    const move = (e: PointerEvent) => {
      if (!armed) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_SLOP_PX) return;
        armed = true;
        setDragging(from);
      }
      target = resolve(e.clientX, e.clientY);
      setOver(target);
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDragging(null);
      setOver(null);
      if (!armed || !target) return;
      const next = transferRecipient(listsRef.current, from, target);
      if (next !== listsRef.current) onChangeRef.current(next);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, []);

  const api = useMemo<GroupApi>(
    () => ({ lists, setList, dragging, over, beginDrag }),
    [lists, setList, dragging, over, beginDrag]
  );
  return <GroupContext.Provider value={api}>{children}</GroupContext.Provider>;
}

// ----------------------------------------------------------------- one row

export function RecipientChips({
  field,
  placeholder,
  autoFocus,
}: {
  /** Key into the group's lists — also the drop-target field name. */
  field: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const group = useContext(GroupContext);
  if (!group) throw new Error("RecipientChips must be inside a RecipientChipGroup");
  const value = group.lists[field] ?? [];
  const setValue = (next: Recipients) => group.setList(field, next);

  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const closeSuggestions = () => {
    seq.current++;
    setSuggestions([]);
    setOpen(false);
  };

  const refresh = (tok: string) => {
    const id = ++seq.current;
    if (tok.trim().length < 1) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    setTimeout(() => {
      if (seq.current !== id) return;
      backend
        .searchContacts(tok.trim())
        .then((hits) => {
          if (seq.current !== id) return;
          setSuggestions(hits);
          setActive(0);
          setOpen(hits.length > 0);
        })
        .catch(() => {});
    }, DEBOUNCE_MS);
  };

  /** Turn the pending text into chips. Chips carry the whole token, so a name
   *  with a comma in it survives — the reason the old code dropped names. */
  const commit = (raw: string) => {
    const tokens = parseRecipientText(raw);
    if (tokens.length > 0) setValue(addRecipients(value, tokens));
    setText("");
    closeSuggestions();
  };

  const accept = (c: Contact) => {
    const token = c.name ? `${c.name} <${c.email}>` : c.email;
    setValue(addRecipients(value, [token]));
    setText("");
    closeSuggestions();
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (open && suggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => Math.min(suggestions.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(suggestions[active]);
        return;
      }
      if (e.key === "Escape") {
        // close the dropdown only — don't let Esc bubble to the compose closer
        e.preventDefault();
        e.stopPropagation();
        closeSuggestions();
        return;
      }
    }
    if (e.key === "Enter" && text.trim()) {
      e.preventDefault();
      commit(text);
      return;
    }
    if (e.key === "Tab" && text.trim()) {
      // Tab still walks to the next field — but don't leave typed text behind.
      commit(text);
      return;
    }
    if (e.key === "Backspace" && text === "" && value.length > 0) {
      // Put the chip back in the input rather than vaporizing it: an accidental
      // Backspace is then one Enter away from undone.
      e.preventDefault();
      setText(value[value.length - 1]);
      setValue(removeRecipient(value, value.length - 1));
    }
  };

  const dragging = group.dragging;
  const over = group.over;

  const chip = (token: string, i: number) => {
    const bad = !isPlausibleAddress(token);
    const isDragging = dragging?.field === field && dragging.index === i;
    const isOver =
      !!dragging && over?.field === field && over.index === i && !isDragging;
    return (
      <span
        key={`${token}-${i}`}
        data-chip-slot
        data-chip-field={field}
        data-chip-index={i}
        title={bad ? `${token} — that doesn't look like an email address` : token}
        onPointerDown={(ev) => {
          // the × owns its own press
          if ((ev.target as HTMLElement).closest("[data-chip-remove]")) return;
          group.beginDrag({ field, index: i }, ev);
        }}
        className={`fm-chip inline-flex max-w-[15rem] cursor-grab items-center gap-1 rounded-md border px-1.5 py-[1px] text-[12.5px] leading-5 select-none ${
          bad
            ? "border-warn/60 bg-warn/10 text-ink"
            : "border-line-strong bg-raised text-ink"
        } ${isDragging ? "opacity-40" : ""} ${
          isOver ? "ring-2 ring-accent/70" : ""
        }`}
      >
        <span className="truncate">{displayLabel(token)}</span>
        <button
          type="button"
          data-chip-remove
          tabIndex={-1}
          aria-label={`Remove ${displayLabel(token)}`}
          title={`Remove ${displayLabel(token)}`}
          onClick={() => setValue(removeRecipient(value, i))}
          className="fm-chip-x -mr-0.5 rounded px-[3px] text-[13px] leading-4 text-ink-3"
        >
          ×
        </button>
      </span>
    );
  };

  return (
    <div className="relative min-w-0 flex-1">
      <div
        // The trailing slot has no index: dropping anywhere in the row's slack
        // (including on the input) appends to this field.
        data-chip-slot
        data-chip-field={field}
        onClick={() => inputRef.current?.focus()}
        className={`flex flex-wrap items-center gap-1 ${
          dragging && over?.field === field ? "rounded-md ring-1 ring-accent/40" : ""
        }`}
      >
        {value.map(chip)}
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => {
            // A separator closes a token wherever it came from — keystroke,
            // paste, IME, autofill. Keydown alone missed every non-key path.
            const { done, rest } = splitTypedRecipients(e.target.value);
            if (done.length > 0) {
              setValue(addRecipients(value, done));
              closeSuggestions();
            }
            setText(rest);
            refresh(rest);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // Don't lose a typed address to a stray click. Suggestions commit
            // on mousedown (preventDefault), so this never steals that choice.
            if (text.trim()) commit(text);
            setTimeout(() => setOpen(false), 120);
          }}
          className="min-w-[8rem] flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          placeholder={value.length === 0 ? placeholder : undefined}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {open && (
        <div className="zb-fade-in absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line-strong bg-overlay py-1 shadow-2xl">
          {suggestions.map((c, i) => (
            <button
              key={c.email}
              // onMouseDown (not onClick) so it fires before the input's blur
              onMouseDown={(e) => {
                e.preventDefault();
                accept(c);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left ${
                i === active ? "bg-selected" : "hover:bg-hover"
              }`}
            >
              <Avatar name={c.name || c.email} email={c.email} size={22} />
              <span className="min-w-0 flex-1">
                {c.name && (
                  <span className="mr-1.5 text-[13px] text-ink">{c.name}</span>
                )}
                <span className="text-[12px] text-ink-3">{c.email}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
