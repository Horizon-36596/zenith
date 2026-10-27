import { optimizeRoute, type OptimizeCommand, type OptimizeInput, type OptimizeProgress, type OptimizeResult } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import type { DriverMessage, HostMessage, OptimizeRequest, Port } from "./protocol";

/**
 * The optimizer driver (issue #306): it drains core's `optimizeRoute` generator one batch at a time and
 * talks to the host in `protocol.ts` messages.
 *
 * It runs in the module worker (`worker.ts`) and, when no Worker can be built, on the page itself
 * (`host.ts`'s slices). Both are this same code, so both give the same result for the same request.
 *
 * Each batch is one `next()` of the generator, about 25 evaluations (`DEFAULT_BATCH_SIZE`), and the
 * driver schedules the next batch on a fresh task, so a message from the host is read between two
 * batches: in the worker that is how Stop gets in, and on the page it is what keeps the editor
 * drawing.
 *
 * Stop is the generator's `{ snapshot: true }`: the generator answers with the result a stop there
 * gives and stays where it is, so Continue goes on from the same point and ends on the same result
 * as a run that was never stopped. The driver has no clock; the safety stop and the wait for an
 * answer are the host's.
 */

/** Runs `task` on a fresh task. The worker and the page both use `setTimeout`. */
export type Schedule = (task: () => void) => void;

const nextTask: Schedule = (task) => {
  setTimeout(task, 0);
};

/** The optimizer's input for a request, with the season rules resolved where it runs. */
export function inputOf(request: OptimizeRequest): OptimizeInput {
  const { withSeason, ...rest } = request;
  return withSeason === true ? { ...rest, season: resolveSeason(request.field).rules } : rest;
}

const messageOf = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

/** A progress report as it is posted: the snapshot, when there is one, goes in its own message. */
const reportOf = (progress: OptimizeProgress): OptimizeProgress => {
  const { snapshot: _snapshot, ...report } = progress;
  return report;
};

/** The served run, for the page's slices: `close` ends it where a worker would be terminated. */
export interface ServedOptimizer {
  /** Ends the run at once: no further batch runs and nothing more is posted. */
  close(): void;
}

/** Serves one run on `port`: it waits for `start`, then drains the generator a batch per task. */
export function serveOptimizer(port: Port<HostMessage, DriverMessage>, schedule: Schedule = nextTask): ServedOptimizer {
  let run: Generator<OptimizeProgress, OptimizeResult, OptimizeCommand | undefined> | null = null;
  /** What `next()` sends back the next time: the command answers the generator's last report. */
  let command: OptimizeCommand | undefined;
  /**
   * False until the generator's first `next()`. That call only starts the generator and drops its
   * argument, so a Stop asked before it waits for the next call, which can answer it.
   */
  let begun = false;
  let stopAsked = false;
  let paused = false;
  let scheduled = false;
  let finished = false;

  const finish = (message: DriverMessage): void => {
    finished = true;
    run = null;
    port.postMessage(message);
  };

  const step = (): void => {
    scheduled = false;
    if (run === null || paused || finished) return;
    if (stopAsked && begun) {
      command = { snapshot: true };
      stopAsked = false;
    }
    let next: IteratorResult<OptimizeProgress, OptimizeResult>;
    try {
      next = run.next(command);
    } catch (error) {
      finish({ type: "failed", message: messageOf(error) });
      return;
    }
    begun = true;
    command = undefined;
    if (next.done === true) {
      finish({ type: "done", result: next.value });
      return;
    }
    const snapshot = next.value.snapshot;
    if (snapshot !== undefined) {
      paused = true;
      port.postMessage({ type: "stopped", result: snapshot });
      return;
    }
    // A stop sent at the search's last report gets no snapshot, since the search is done: the run
    // goes on to its own result, and that answers the stop.
    port.postMessage({ type: "progress", progress: reportOf(next.value) });
    later();
  };

  const later = (): void => {
    if (scheduled) return;
    scheduled = true;
    schedule(step);
  };

  port.onmessage = (event) => {
    const message = event.data;
    if (finished) return;
    if (message.type === "start") {
      if (run !== null) return;
      try {
        run = optimizeRoute(inputOf(message.request), message.options);
      } catch (error) {
        finish({ type: "failed", message: messageOf(error) });
        return;
      }
      later();
    } else if (message.type === "stop") {
      if (run === null || paused) return;
      stopAsked = true;
    } else if (paused) {
      paused = false;
      later();
    }
  };

  return {
    close: () => {
      finished = true;
      run = null;
      port.onmessage = null;
    },
  };
}
