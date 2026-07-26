import { useEffect, useRef } from "react";

/** Keep the keyboard-selected row visible inside its own scroll container.
 *
 *  Both the command palette and PickerShell moved their highlight on
 *  Arrow/Ctrl+J without ever scrolling, so holding Down walked the selection
 *  off the bottom of a `max-h` list and the user was steering something they
 *  could no longer see.
 *
 *  `block: "nearest"` is the important part: it scrolls only when the row is
 *  actually out of view, so arrowing through visible rows doesn't jitter the
 *  list. Returns a ref to put on the *scroll container*; rows are located by
 *  index via `data-row`.
 */
export function useScrollSelectedIntoView<T extends HTMLElement>(index: number) {
  const containerRef = useRef<T>(null);
  useEffect(() => {
    const row = containerRef.current?.querySelector<HTMLElement>(
      `[data-row="${index}"]`
    );
    // `scrollIntoView` is unimplemented in jsdom/happy-dom, so guard it rather
    // than let a test environment throw inside an effect.
    row?.scrollIntoView?.({ block: "nearest" });
  }, [index]);
  return containerRef;
}
