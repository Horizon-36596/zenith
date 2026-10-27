import type { OptimizeInput, OptimizeOptions, OptimizeProgress, OptimizeResult } from "@horizon36596/zenith-core";

/**
 * The messages between the Optimize path host (`host.ts`) and the optimizer driver (`driver.ts`),
 * which runs in a module Web Worker (`worker.ts`) or, when no Worker can be built, on the page in
 * short slices (issue #306).
 *
 * Everything here crosses `postMessage`, so it is plain data. The season rules are functions, so
 * the request names them instead of carrying them: the driver resolves them from `field.json`, the
 * same way the editor's own preview does.
 */

/** What to optimize: the optimizer's input without the season rules, and whether to use them. */
export interface OptimizeRequest extends Omit<OptimizeInput, "season"> {
  /**
   * True to run with the season rules `field.json` names (`resolveSeason`), as the editor's
   * preview does; false or absent to run with none.
   */
  withSeason?: boolean;
}

/** From the host to the driver. */
export type HostMessage =
  /** Starts the run. Sent once, first. */
  | { type: "start"; request: OptimizeRequest; options: OptimizeOptions }
  /** Asks for the best so far and pauses the run there; the driver answers `stopped` (or `done`). */
  | { type: "stop" }
  /** Goes on from where a stopped run paused. */
  | { type: "continue" };

/** From the driver to the host. */
export type DriverMessage =
  /** After every batch of evaluations. */
  | { type: "progress"; progress: OptimizeProgress }
  /** The answer to `stop`: the result a stop at this point gives (`stoppedEarly`). The run is paused. */
  | { type: "stopped"; result: OptimizeResult }
  /** The run's own result. Nothing follows it. */
  | { type: "done"; result: OptimizeResult }
  /** The run could not go on, in a full sentence. Nothing follows it. */
  | { type: "failed"; message: string };

/** One end of the channel: a worker's global scope, a `Worker`, or the page's own stand-in for one. */
export interface Port<In, Out> {
  postMessage(message: Out): void;
  onmessage: ((event: { data: In }) => void) | null;
}
