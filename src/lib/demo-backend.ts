// Web-demo half of the build-time split.
//
// `vite --mode desktop` aliases this module to demo-backend.desktop.ts, which
// imports nothing — that is what keeps mock.ts and mock-data.ts out of the
// shipped desktop bundle. The runtime `isTauri` check in ipc.ts cannot do that
// job: a bundler has to see the import disappear, not a branch that is never
// taken.
import type { Backend } from "./ipc";
import { MockBackend } from "./mock";

export const createDemoBackend = (): Backend => new MockBackend();
