import { sha256Hex, type OptimizeOptions, type OptimizeProgress, type OptimizeResult } from "@horizon36596/zenith-core";
import { serveOptimizer } from "./driver";
import type { DriverMessage, HostMessage, OptimizeRequest, Port } from "./protocol";

/**
 * The Optimize path host (issue #306). It runs one optimizer run off the editor's thread and owns the
 * controls that need a clock, which core never has:
 *
 * - **Where it runs.** A module Web Worker (`worker.ts`). Where no Worker can be built, because the
 *   browser has none, the constructor throws, or the worker fails to load before it answers, the
 *   same driver runs on the page in short slices on `setTimeout`, one batch of evaluations each.
 *   Both give the same result for the same request.
 * - **Stop** asks for the best so far. The run pauses there and `stopped` reports a `stoppedEarly`
 *   result. **Continue** goes on from the same point, and ends on the same result as a run that
 *   was never stopped.
 * - **The safety stop.** A run that is still going `SAFETY_STOP_MS` after it started, or after its
 *   last Continue, is stopped the same way, and `stopped` says it was the safety stop.
 * - **No answer.** A worker that does not answer Stop within `NO_ANSWER_MS` is ended, and `failed`
 *   says so.
 * - **Cancel on an edit.** Given `edits`, the run is cancelled when the auto or its project files
 *   change. The host never writes to the document: it only reports results, and nothing is reported
 *   after a cancel.
 *
 * The Optimize card (OPT-16) is what starts a run, shows its progress and applies a result.
 */

/** The wall-clock safety stop, in milliseconds (SET BY HAND: spec 16 section 7, a UI constant). */
export const SAFETY_STOP_MS = 5000;

/**
 * How long the host waits for an answer to Stop, in milliseconds (SET BY HAND). Stop is answered
 * after the current batch and the snapshot it asks for. On the wide collect-and-score test
 * fixture, default budget, an idle machine took 0.5 to 2.5 s for a batch and up to 2.8 s for the
 * snapshot, about 4.6 s together at worst, and more under load (issue #426). Ten seconds is still
 * only reached by a worker that has hung.
 */
export const NO_ANSWER_MS = 10_000;

/** Where a run runs: in a module worker, or on the page in slices. */
export type OptimizeEngine = "worker" | "slices";

/**
 * - `running`: searching; `stopping`: Stop was sent and the answer is awaited;
 * - `paused`: stopped with a result, and Continue goes on;
 * - `done`, `failed` and `cancelled` are final.
 */
export type OptimizeRunState = "running" | "stopping" | "paused" | "done" | "failed" | "cancelled";

/** Why a run was stopped: the person's Stop, or the safety stop. */
export type StopReason = "stop" | "safety";

/**
 * What the host reports. Progress, stops, the result and failures arrive on tasks of their own;
 * `cancelled` is reported as the run is cancelled.
 */
export interface OptimizeEvents {
  progress?(progress: OptimizeProgress): void;
  /** The run stopped with the best so far (`stoppedEarly`) and is paused; Continue goes on. */
  stopped?(result: OptimizeResult, why: StopReason): void;
  done?(result: OptimizeResult): void;
  failed?(message: string): void;
  cancelled?(reason: string): void;
}

export interface OptimizeRun {
  readonly engine: OptimizeEngine;
  readonly state: OptimizeRunState;
  /** Asks for the best so far and pauses. Only while running. */
  stop(): void;
  /** Goes on after a stop. Only while paused. */
  continue(): void;
  /** Ends the run. Nothing is reported after it but `cancelled`. */
  cancel(reason?: string): void;
}

/** What the host needs of a worker: a `Worker` has it. */
export interface WorkerLike extends Port<DriverMessage, HostMessage> {
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
}

/** The host's two timers, the safety stop and the wait for an answer. Tests pass their own. */
export interface HostTimers {
  set(task: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** Tells the host when the document the run was started on has changed (`editorEdits.ts`). */
export interface EditWatch {
  /** Calls `listener` after every change. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** True once the auto or a project file the run read is no longer the one it was started on. */
  changed(): boolean;
}

export interface HostOptions {
  /** `slices` runs on the page even where a Worker could be built. Default `auto`. */
  engine?: "auto" | "slices";
  /** Builds the worker. Default: the module worker in `worker.ts`. */
  createWorker?: () => WorkerLike;
  timers?: HostTimers;
  safetyStopMs?: number;
  noAnswerMs?: number;
  edits?: EditWatch;
}

/** What `cancel` reports when an edit cancelled the run (spec 16 section 8.1). */
export const EDITED_REASON = "The auto changed. Run again.";
const NO_ANSWER_MESSAGE = "The optimizer stopped answering, so it was ended. Run it again.";
const CANCELLED_REASON = "The run was cancelled.";

const browserTimers: HostTimers = {
  set: (task, ms) => setTimeout(task, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The module worker, or null where this browser cannot build one. */
function moduleWorker(): WorkerLike | null {
  if (typeof Worker !== "function") return null;
  try {
    // Written out in full so Vite finds it and builds the worker into its own chunk.
    return new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "zenith-optimizer" }) as unknown as WorkerLike;
  } catch {
    return null;
  }
}

/** The driver on the page, behind the same interface as a worker, its messages delivered on later tasks. */
function pageSlices(): WorkerLike {
  let ended = false;
  const inside: Port<HostMessage, DriverMessage> = {
    onmessage: null,
    postMessage: (message) => {
      setTimeout(() => {
        if (!ended) outside.onmessage?.({ data: message });
      }, 0);
    },
  };
  const outside: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage: (message) => {
      setTimeout(() => {
        if (!ended) inside.onmessage?.({ data: message });
      }, 0);
    },
    terminate: () => {
      ended = true;
      // On the page the driver shares the editor's thread, so ending the run must stop its batches
      // too, not only drop what they post.
      served.close();
    },
  };
  const served = serveOptimizer(inside);
  return outside;
}

/**
 * Starts one optimizer run. The request is posted to the worker as it is, so it must be plain data;
 * the season rules are named by `withSeason`, not passed.
 */
export function startOptimize(request: OptimizeRequest, options: OptimizeOptions, events: OptimizeEvents, host: HostOptions = {}): OptimizeRun {
  const timers = host.timers ?? browserTimers;
  const safetyStopMs = host.safetyStopMs ?? SAFETY_STOP_MS;
  const noAnswerMs = host.noAnswerMs ?? NO_ANSWER_MS;
  let state: OptimizeRunState = "running";
  let engine: OptimizeEngine = "slices";
  let worker: WorkerLike | null = null;
  /** True until the worker's first message: a failure before it falls back to the slices. */
  let unproven = false;
  let safety: unknown = null;
  let waiting: unknown = null;
  let stopReason: StopReason = "stop";
  let unsubscribe: (() => void) | null = null;

  const final = (): boolean => state === "done" || state === "failed" || state === "cancelled";

  const clearTimers = (): void => {
    if (safety !== null) timers.clear(safety);
    if (waiting !== null) timers.clear(waiting);
    safety = null;
    waiting = null;
  };

  const end = (next: "done" | "failed" | "cancelled"): void => {
    state = next;
    clearTimers();
    unsubscribe?.();
    unsubscribe = null;
    if (worker !== null) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
  };

  const armSafety = (): void => {
    if (Number.isFinite(safetyStopMs)) safety = timers.set(() => askStop("safety"), safetyStopMs);
  };

  const askStop = (why: StopReason): void => {
    if (state !== "running" || worker === null) return;
    state = "stopping";
    stopReason = why;
    if (safety !== null) timers.clear(safety);
    safety = null;
    worker.postMessage({ type: "stop" });
    waiting = timers.set(() => {
      if (state !== "stopping") return;
      end("failed");
      events.failed?.(NO_ANSWER_MESSAGE);
    }, noAnswerMs);
  };

  const onMessage = (message: DriverMessage): void => {
    if (final()) return;
    unproven = false;
    if (message.type === "progress") {
      events.progress?.(message.progress);
    } else if (message.type === "stopped") {
      if (waiting !== null) timers.clear(waiting);
      waiting = null;
      state = "paused";
      events.stopped?.(message.result, stopReason);
    } else if (message.type === "done") {
      end("done");
      events.done?.(message.result);
    } else {
      end("failed");
      events.failed?.(message.message);
    }
  };

  const attach = (next: WorkerLike, kind: OptimizeEngine): void => {
    worker = next;
    engine = kind;
    unproven = kind === "worker";
    next.onmessage = (event) => onMessage(event.data);
    next.onerror = () => {
      if (final()) return;
      if (unproven) {
        // It never answered, so it never ran: the same request on the page gives the same result.
        next.onmessage = null;
        next.onerror = null;
        next.terminate();
        const retry = pageSlices();
        attach(retry, "slices");
        retry.postMessage({ type: "start", request, options });
        if (state === "stopping") retry.postMessage({ type: "stop" });
        return;
      }
      end("failed");
      events.failed?.("The optimizer stopped with an error. Run it again.");
    };
  };

  const run: OptimizeRun = {
    get engine() {
      return engine;
    },
    get state() {
      return state;
    },
    stop: () => askStop("stop"),
    continue: () => {
      if (state !== "paused" || worker === null) return;
      state = "running";
      worker.postMessage({ type: "continue" });
      armSafety();
    },
    cancel: (reason = CANCELLED_REASON) => {
      if (final()) return;
      end("cancelled");
      events.cancelled?.(reason);
    },
  };

  if (host.edits?.changed() === true) {
    // Started on an auto that is no longer the open one: nothing to run. Reported on a later task,
    // as every other event is.
    state = "cancelled";
    setTimeout(() => events.cancelled?.(EDITED_REASON), 0);
    return run;
  }

  const built = host.engine === "slices" ? null : host.createWorker !== undefined ? host.createWorker() : moduleWorker();
  const first = built ?? pageSlices();
  attach(first, built === null ? "slices" : "worker");
  const edits = host.edits;
  if (edits !== undefined) unsubscribe = edits.subscribe(() => {
    if (edits.changed()) run.cancel(EDITED_REASON);
  });
  first.postMessage({ type: "start", request, options });
  armSafety();
  return run;
}

/**
 * A hash of a result, to compare two runs: SHA-256 of its JSON with the keys in order. A number
 * that JSON cannot write is written as its name, and -0 as 0, so a result that crossed
 * `postMessage` hashes as the one that did not.
 */
export function resultHash(result: OptimizeResult): string {
  const sorted = (value: unknown): unknown => {
    if (typeof value === "number") return Number.isFinite(value) ? (value === 0 ? 0 : value) : String(value);
    if (Array.isArray(value)) return value.map(sorted);
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .filter((key) => record[key] !== undefined)
          .sort()
          .map((key) => [key, sorted(record[key])]),
      );
    }
    return value;
  };
  return sha256Hex(JSON.stringify(sorted(result)));
}
