// Global keyboard engine. Supports:
//   - single keys:            "e", "/", "?"
//   - modifier combos:        "mod+k" (mod = Ctrl on Windows, Cmd on macOS)
//   - two-key chords:         "g i"  (press g, then i within the chord window)
//   - alternatives:           "j|down"
// While focus is in an input/textarea/contenteditable, only mod+ combos and
// Escape fire, so typing never triggers actions.

export interface Binding {
  expr: string;
  run: () => void;
  when?: () => boolean;
  /** Fire even while an overlay (palette/picker/event popover) is open. */
  bypassOverlays?: boolean;
  /** Precomputed expr.split("|") (filled lazily, once per binding). */
  alts?: string[];
}

/** The "|"-separated alternatives for a binding, computed once and cached. */
function altsOf(b: Binding): string[] {
  return (b.alts ??= b.expr.split("|").map((s) => s.trim()));
}

const CHORD_WINDOW_MS = 1200;

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Canonical token for a keydown event, e.g. "mod+k", "shift+tab", "?". */
export function eventToken(e: KeyboardEvent): string | null {
  let key = e.key;
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta")
    return null;
  key = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  if (key === "arrowdown") key = "down";
  if (key === "arrowup") key = "up";
  if (key === "arrowleft") key = "left";
  if (key === "arrowright") key = "right";
  if (key === " ") key = "space";

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  // Symbols already encode shift in e.key ("?" not "/"), so they stay bare.
  // Letters ("Shift+E") and non-printables ("Shift+Tab") get the prefix.
  const isLetter = key.length === 1 && key >= "a" && key <= "z";
  if (e.shiftKey && (key.length > 1 || isLetter)) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);
}

function formatKeyToken(p: string, isMac: boolean): string {
  if (p === "mod") return isMac ? "⌘" : "Ctrl";
  if (p === "shift") return "Shift";
  if (p === "alt") return "Alt";
  if (p === "escape") return "Esc";
  if (p === "enter") return "Enter";
  if (p === "tab") return "Tab";
  if (p === "space") return "Space";
  if (p === "down") return "↓";
  if (p === "up") return "↑";
  if (p === "left") return "←";
  if (p === "right") return "→";
  if (p === "backspace") return "Backspace";
  if (p === "delete") return "Del";
  return p.length === 1 ? p.toUpperCase() : p;
}

export function formatKeyExpr(expr: string): string {
  if (!expr) return "";
  const isMac = isMacPlatform();
  return expr
    .split("|")[0]
    .split(" ")
    .map((part) =>
      part
        .split("+")
        .map((p) => formatKeyToken(p, isMac))
        .join("+")
    )
    .join(" then ");
}

/** One keycap label per chip for the shortcuts panel — "mod+shift+c" →
 *  ["Ctrl","Shift","C"]; chords insert a literal "then" separator: "g i" →
 *  ["G","then","I"]. Takes a single alternative (no "|" handling). */
export function exprKeycaps(expr: string): string[] {
  if (!expr) return [];
  const isMac = isMacPlatform();
  const chips: string[] = [];
  expr.split(" ").forEach((part, i) => {
    if (i > 0) chips.push("then");
    for (const p of part.split("+")) chips.push(formatKeyToken(p, isMac));
  });
  return chips;
}

interface Installed {
  getBindings: () => Binding[];
  isOverlayOpen: () => boolean;
}

let pendingPrefix: string | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;

export function installKeyboard(cfg: Installed): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    const token = eventToken(e);
    if (!token) return;

    const editable = isEditable(e.target);
    const overlay = cfg.isOverlayOpen();
    const bindings = cfg.getBindings();

    const tryMatch = (candidate: string): Binding | null => {
      for (const b of bindings) {
        if (overlay && !b.bypassOverlays) continue;
        if (editable && !candidate.includes("mod+") && candidate !== "escape")
          continue;
        for (const alt of altsOf(b)) {
          if (alt === candidate && (!b.when || b.when())) return b;
        }
      }
      return null;
    };

    // Chord continuation takes priority.
    if (pendingPrefix) {
      const chord = `${pendingPrefix} ${token}`;
      pendingPrefix = null;
      clearTimeout(pendingTimer);
      const hit = tryMatch(chord);
      if (hit) {
        e.preventDefault();
        hit.run();
        return;
      }
      // fall through: treat as a fresh keypress
    }

    // Is this token the start of any chord?
    if (!editable && !overlay) {
      const opensChord = bindings.some(
        (b) =>
          altsOf(b).some((alt) => alt.startsWith(`${token} `)) &&
          (!b.when || b.when())
      );
      if (opensChord) {
        pendingPrefix = token;
        clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => {
          pendingPrefix = null;
        }, CHORD_WINDOW_MS);
        e.preventDefault();
        return;
      }
    }

    const hit = tryMatch(token);
    if (hit) {
      e.preventDefault();
      hit.run();
    }
  };

  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}
