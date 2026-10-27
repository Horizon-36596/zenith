/**
 * The Optimize path worker (issue #306): a module Web Worker that serves one optimizer run with the
 * driver. `host.ts` starts it with
 * `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`, which Vite builds into
 * its own chunk (`vite.config.ts` sets the worker format to ES modules), and ends it with
 * `terminate()`. A worker serves one run; the host starts a new one for the next.
 */
import { serveOptimizer } from "./driver";
import type { DriverMessage, HostMessage, Port } from "./protocol";

serveOptimizer(self as unknown as Port<HostMessage, DriverMessage>);
