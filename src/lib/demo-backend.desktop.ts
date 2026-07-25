// Desktop half of the build-time split — deliberately imports nothing.
//
// The desktop app always has __TAURI_INTERNALS__, so `isTauri` is true and this
// is unreachable. It throws rather than returning a stub so that a regression
// routing desktop through the demo path fails loudly instead of quietly showing
// fabricated mail.
import type { Backend } from "./ipc";

export const createDemoBackend = (): Backend => {
  throw new Error("the demo backend is not bundled in the desktop app");
};
