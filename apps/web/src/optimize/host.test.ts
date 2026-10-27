import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  canonicalize,
  createFinalCheck,
  createObjective,
  loadAuto,
  loadField,
  loadLink,
  loadRobot,
  loadWaypoints,
  robotClearanceIn,
  runOptimize,
  type OptimizeOptions,
  type OptimizeResult,
} from "@horizon36596/zenith-core";
import type { Auto, PathStep } from "@horizon36596/zenith-schema";
import { describe, expect, it, vi } from "vitest";
import { commit, getState, openAuto } from "../state/store";
import { inputOf, serveOptimizer } from "./driver";
import { editsSince } from "./editorEdits";
import { NO_ANSWER_MS, resultHash, SAFETY_STOP_MS, startOptimize, type HostOptions, type HostTimers, type OptimizeRun, type WorkerLike } from "./host";
import type { DriverMessage, HostMessage, OptimizeRequest, Port } from "./protocol";

/**
 * The Optimize path host (issue #306): the worker and the page's slices give the same result for the
 * Contract fixture; Stop gives a valid `stoppedEarly` result and Continue ends on the result of a run
 * that was never stopped; the safety stop does the same; an edit cancels a run without touching the
 * document; a worker that does not answer is ended; and a worker that cannot load leaves the run to the
 * slices.
 *
 * Node has no Web Worker, so "the worker" here is the driver behind a stand-in for the Worker
 * boundary: every message is structured-cloned and delivered on a later task, as a real worker's
 * are. The real module worker runs in the browser specs (`e2e/optimizer-worker.spec.ts`) and in
 * the desktop app (`apps/desktop/e2e/optimizer-worker.spec.ts`).
 */

/** How many batches the driver has asked of core's generator, in every run of this file. */
const batches = vi.hoisted(() => ({ count: 0 }));

// The search runs as it is; the wrapper only counts its batches, so a test can see that a run which
// was ended runs no more of them.
vi.mock("@horizon36596/zenith-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@horizon36596/zenith-core")>();
  const optimizeRoute: typeof actual.optimizeRoute = (...args) => {
    const inner = actual.optimizeRoute(...args);
    const counted: typeof inner = {
      next: (...command) => {
        batches.count += 1;
        return inner.next(...command);
      },
      return: (value) => inner.return(value),
      throw: (error) => inner.throw(error),
      [Symbol.iterator]: () => counted,
    };
    return counted;
  };
  return { ...actual, optimizeRoute };
});

const root = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));
const link = loadLink(read("zenith.json"));
const robot = loadRobot(read(link.robot));
const field = loadField(read(link.field));
const waypoints = loadWaypoints(read(link.waypoints ?? "autos/waypoints.json"));
/** collect-and-score with a toOtherSide round the west of the hive frame that has a faster way round (issues #365 and #367). */
const wideAuto = (): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../../packages/core/test-fixtures/wide-collect-and-score.auto.json", import.meta.url)), "utf8"));
const auto = loadAuto(wideAuto());

/** The Contract fixture: the wide fixture's `toOtherSide`, which goes round the west of the hive wider than it has to, run as the editor runs it, with the season's rules (issue #365). */
const contract: OptimizeRequest = { auto, robot, field, waypoints, stepId: "toOtherSide", withSeason: true };

/** A stand-in for a module worker: the driver, with every message cloned and delivered on a later task. */
function fakeWorker(): WorkerLike & { terminated: boolean; posted: HostMessage[] } {
  const inside: Port<HostMessage, DriverMessage> = {
    onmessage: null,
    postMessage: (message) => {
      const copy = structuredClone(message);
      setTimeout(() => {
        if (!worker.terminated) worker.onmessage?.({ data: copy });
      }, 0);
    },
  };
  const worker = {
    terminated: false,
    posted: [] as HostMessage[],
    onmessage: null as WorkerLike["onmessage"],
    onerror: null as WorkerLike["onerror"],
    postMessage: (message: HostMessage) => {
      worker.posted.push(message);
      const copy = structuredClone(message);
      setTimeout(() => {
        if (!worker.terminated) inside.onmessage?.({ data: copy });
      }, 0);
    },
    terminate: () => {
      worker.terminated = true;
      // A terminated worker runs nothing more, as a real one does.
      served.close();
    },
  };
  const served = serveOptimizer(inside);
  return worker;
}

/** Timers the test fires by hand; nothing fires on its own. */
function manualTimers(): HostTimers & { pending: Map<number, { task: () => void; ms: number }>; fire(ms: number): void } {
  let id = 0;
  const pending = new Map<number, { task: () => void; ms: number }>();
  return {
    pending,
    set: (task, ms) => {
      id += 1;
      pending.set(id, { task, ms });
      return id;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
    fire: (ms) => {
      for (const [key, timer] of [...pending.entries()]) {
        if (timer.ms !== ms) continue;
        pending.delete(key);
        timer.task();
      }
    },
  };
}

interface Seen {
  progress: number;
  stopped: { result: OptimizeResult; why: string }[];
  done: OptimizeResult | null;
  failed: string | null;
  cancelled: string | null;
}

/**
 * Runs a request to its end, calling `onProgress` with the run after each report and `onStopped`
 * after each stop. Resolves when the run is done, failed or cancelled.
 */
function drive(
  request: OptimizeRequest,
  options: OptimizeOptions,
  host: HostOptions,
  hooks: { onProgress?: (run: OptimizeRun, count: number) => void; onStopped?: (run: OptimizeRun, result: OptimizeResult) => void } = {},
): Promise<{ run: OptimizeRun; seen: Seen }> {
  return new Promise((resolvePromise) => {
    const seen: Seen = { progress: 0, stopped: [], done: null, failed: null, cancelled: null };
    const end = (): void => resolvePromise({ run, seen });
    const run: OptimizeRun = startOptimize(
      request,
      options,
      {
        progress: () => {
          seen.progress += 1;
          hooks.onProgress?.(run, seen.progress);
        },
        stopped: (result, why) => {
          seen.stopped.push({ result, why });
          hooks.onStopped?.(run, result);
        },
        done: (result) => {
          seen.done = result;
          end();
        },
        failed: (message) => {
          seen.failed = message;
          end();
        },
        cancelled: (reason) => {
          seen.cancelled = reason;
          end();
        },
      },
      host,
    );
  });
}

/** Never fires: a run with these timers has no safety stop and never gives up on an answer. */
const noTimers: HostTimers = { set: () => 0, clear: () => undefined };

/**
 * What a stopped result found, which a run with a budget of its evaluations finds too (spec 16
 * section 7). Its status, and without a pick its sentences, differ: a run that used its whole
 * budget says why it has no pick, and a stopped one says it stopped first.
 */
const found = (result: OptimizeResult) => ({
  evaluations: result.evaluations,
  step: result.step,
  pick: result.pick,
  alternatives: result.alternatives,
  scorer: result.scorer,
  marginIn: result.marginIn,
});

/** A stopped result is valid: `stoppedEarly`, inside the budget, the same as a run with a budget of its evaluations, and its pick passes the hard final check. */
function expectValidStop(result: OptimizeResult, request: OptimizeRequest, options: OptimizeOptions): void {
  expect(result.status).toBe("stoppedEarly");
  expect(result.evaluations).toBeGreaterThan(0);
  expect(result.evaluations).toBeLessThan(result.budget);
  const again = runOptimize(inputOf(request), { ...options, budget: result.evaluations });
  expect(found(structuredClone(result))).toStrictEqual(found(again));
  expect(result.changes.length).toBeGreaterThan(0);
  if (result.pick !== null) {
    const objective = createObjective(inputOf(request), { marginIn: robotClearanceIn(robot) });
    const verdict = createFinalCheck(inputOf(request), objective).verify(result.pick.step);
    expect(verdict.ok).toBe(true);
  }
}

/**
 * The search these tests run and compare against. Only the engines have to agree with each other and
 * with core's own drain, and a stopped run only has to be a prefix of this one, so the budget is
 * small: the default one made a single test a minute of synchronous work and starved the test
 * runner's worker of the time it needs to report back.
 */
const small: OptimizeOptions = { budget: 100 };
let smallResult: OptimizeResult | null = null;
/** What core's own drain finds with `small`, run once for the whole file because every test that needs it needs the same result. */
const unstoppedResult = (): OptimizeResult => (smallResult ??= runOptimize(inputOf(contract), small));

describe("the worker and the slices", () => {
  it("give the same result hash for the Contract fixture", async () => {
    const inWorker = await drive(contract, small, { createWorker: fakeWorker, timers: noTimers });
    const inSlices = await drive(contract, small, { engine: "slices", timers: noTimers });
    expect(inWorker.run.engine).toBe("worker");
    expect(inSlices.run.engine).toBe("slices");
    expect(inWorker.seen.done?.status).toBe("improved");
    expect(inWorker.seen.progress).toBeGreaterThan(1);
    expect(resultHash(inWorker.seen.done as OptimizeResult)).toBe(resultHash(inSlices.seen.done as OptimizeResult));
    // And the same as core's own drain, so neither host changes what the search finds.
    expect(resultHash(inSlices.seen.done as OptimizeResult)).toBe(resultHash(unstoppedResult()));
  }, 120_000);
});

describe("Stop and Continue", () => {
  const options = small;

  for (const engine of ["worker", "slices"] as const) {
    it(`Stop gives a valid stoppedEarly result, and Continue ends on the unstopped result (${engine})`, async () => {
      const unstopped = unstoppedResult();
      const host: HostOptions = engine === "worker" ? { createWorker: fakeWorker, timers: noTimers } : { engine: "slices", timers: noTimers };
      const { run, seen } = await drive(contract, options, host, {
        onProgress: (live, count) => {
          if (count === 2) live.stop();
        },
        onStopped: (live) => {
          expect(live.state).toBe("paused");
          live.continue();
        },
      });
      expect(seen.stopped).toHaveLength(1);
      expect(seen.stopped[0]?.why).toBe("stop");
      expectValidStop(seen.stopped[0]?.result as OptimizeResult, contract, options);
      expect(run.state).toBe("done");
      expect(resultHash(seen.done as OptimizeResult)).toBe(resultHash(unstopped));
    }, 120_000);
  }

  it("the safety stop pauses the run with the best so far, and Continue gives it a fresh 5 s", async () => {
    const unstopped = unstoppedResult();
    const timers = manualTimers();
    let armed = 0;
    const { seen } = await drive(contract, options, { createWorker: fakeWorker, timers }, {
      onProgress: (_live, count) => {
        // The safety stop is armed for the whole run; fire it once, after the first report.
        if ([...timers.pending.values()].some((timer) => timer.ms === SAFETY_STOP_MS)) armed += 1;
        if (count === 1) timers.fire(SAFETY_STOP_MS);
      },
      onStopped: (live) => {
        expect([...timers.pending.values()].some((timer) => timer.ms === SAFETY_STOP_MS)).toBe(false);
        live.continue();
        expect([...timers.pending.values()].some((timer) => timer.ms === SAFETY_STOP_MS)).toBe(true);
      },
    });
    expect(armed).toBeGreaterThan(0);
    expect(seen.stopped.map((stop) => stop.why)).toEqual(["safety"]);
    expectValidStop(seen.stopped[0]?.result as OptimizeResult, contract, options);
    expect(resultHash(seen.done as OptimizeResult)).toBe(resultHash(unstopped));
    // Nothing is left armed once the run is done.
    expect(timers.pending.size).toBe(0);
  }, 120_000);
});

describe("cancel on an edit", () => {
  it("an edit to the auto during a run cancels it without touching the document", async () => {
    const canonical = canonicalize("auto", auto);
    openAuto("collect-and-score.auto.json", auto, canonical);
    const opened = getState().auto as Auto;
    const request: OptimizeRequest = { ...contract, auto: opened };
    let worker: ReturnType<typeof fakeWorker> | null = null;
    let edited: Auto | null = null;
    const { run, seen } = await drive(
      request,
      {},
      {
        createWorker: () => (worker = fakeWorker()),
        timers: noTimers,
        edits: editsSince(request),
      },
      {
        onProgress: (_live, count) => {
          if (count !== 1) return;
          // The person writes a note on the step while the run is going.
          const steps = opened.steps.map((step) => (step.id === "toOtherSide" ? ({ ...step, notes: "Edited during the run." } as PathStep) : step));
          commit({ ...opened, steps });
          edited = getState().auto;
        },
      },
    );
    expect(seen.cancelled).toBe("The auto changed. Run again.");
    expect(seen.done).toBeNull();
    expect(seen.stopped).toHaveLength(0);
    expect(run.state).toBe("cancelled");
    expect((worker as ReturnType<typeof fakeWorker> | null)?.terminated).toBe(true);
    // The document is the person's edit, as they made it, and the only undo step is theirs.
    expect(getState().auto).toBe(edited);
    expect(getState().undo).toHaveLength(1);
    // Nothing more arrives after the cancel.
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(seen.done).toBeNull();
  }, 120_000);

  it("an edit cancels a run on the page's slices, and the slices run no further batch", async () => {
    const canonical = canonicalize("auto", auto);
    openAuto("collect-and-score.auto.json", auto, canonical);
    const opened = getState().auto as Auto;
    const request: OptimizeRequest = { ...contract, auto: opened };
    let atCancel = -1;
    const { run, seen } = await drive(
      request,
      {},
      { engine: "slices", timers: noTimers, edits: editsSince(request) },
      {
        onProgress: (_live, count) => {
          if (count !== 1) return;
          const steps = opened.steps.map((step) => (step.id === "toOtherSide" ? ({ ...step, notes: "Edited during the run." } as PathStep) : step));
          commit({ ...opened, steps });
          atCancel = batches.count;
        },
      },
    );
    expect(run.engine).toBe("slices");
    expect(seen.cancelled).toBe("The auto changed. Run again.");
    expect(run.state).toBe("cancelled");
    // The driver shares the editor's thread: after the cancel it must not keep draining the budget.
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(batches.count).toBe(atCancel);
    expect(seen.done).toBeNull();
  }, 120_000);

  it("a run started on an auto that is no longer open is cancelled at once", async () => {
    const canonical = canonicalize("auto", auto);
    openAuto("collect-and-score.auto.json", auto, canonical);
    const stale: OptimizeRequest = { ...contract, auto: structuredClone(auto) };
    const { seen } = await drive(stale, {}, { createWorker: fakeWorker, timers: noTimers, edits: editsSince(stale) });
    expect(seen.cancelled).toBe("The auto changed. Run again.");
    expect(seen.progress).toBe(0);
  });
});

describe("a worker that does not answer", () => {
  it("is ended when it does not answer Stop in time", async () => {
    const timers = manualTimers();
    const silent = {
      terminated: false,
      onmessage: null as WorkerLike["onmessage"],
      onerror: null as WorkerLike["onerror"],
      postMessage: (message: HostMessage) => {
        // It reports once after the start, then hangs.
        if (message.type === "start") {
          setTimeout(() => silent.onmessage?.({ data: { type: "progress", progress: { evaluations: 25, budget: 1150, bestJ: null, phase: "seeds" } } }), 0);
        }
      },
      terminate: () => {
        silent.terminated = true;
      },
    };
    const { run, seen } = await drive(contract, {}, { createWorker: () => silent, timers }, {
      onProgress: (live) => {
        live.stop();
        expect([...timers.pending.values()].some((timer) => timer.ms === NO_ANSWER_MS)).toBe(true);
        timers.fire(NO_ANSWER_MS);
      },
    });
    expect(seen.failed).toBe("The optimizer stopped answering, so it was ended. Run it again.");
    expect(run.state).toBe("failed");
    expect(silent.terminated).toBe(true);
    expect(timers.pending.size).toBe(0);
  });
});

describe("a worker that cannot be built", () => {
  it("leaves the run to the slices when the worker fails to load", async () => {
    const options: OptimizeOptions = { budget: 50 };
    const broken = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage: () => {
          setTimeout(() => worker.onerror?.({ message: "Refused to load the script." }), 0);
        },
        terminate: () => undefined,
      };
      return worker;
    };
    const { run, seen } = await drive(contract, options, { createWorker: broken, timers: noTimers });
    expect(run.engine).toBe("slices");
    expect(resultHash(seen.done as OptimizeResult)).toBe(resultHash(runOptimize(inputOf(contract), options)));
  }, 60_000);

  it("still answers a Stop asked before the worker failed to load, with a stopped result", async () => {
    const options: OptimizeOptions = { budget: 150 };
    const broken = (): WorkerLike => {
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        postMessage: (message) => {
          if (message.type === "start") setTimeout(() => worker.onerror?.({ message: "Refused to load the script." }), 0);
        },
        terminate: () => undefined,
      };
      return worker;
    };
    // The no-answer timer never fires on its own here: a lost Stop shows as a run that goes on to its
    // end with no stopped result, where the browser would end it as failed after 3 s.
    const timers = manualTimers();
    const seen: Seen = { progress: 0, stopped: [], done: null, failed: null, cancelled: null };
    let engine = "";
    await new Promise<void>((resolvePromise) => {
      const run = startOptimize(
        contract,
        options,
        {
          progress: () => {
            seen.progress += 1;
          },
          stopped: (result, why) => {
            seen.stopped.push({ result, why });
            expect([...timers.pending.values()].some((timer) => timer.ms === NO_ANSWER_MS)).toBe(false);
            run.continue();
          },
          done: (result) => {
            seen.done = result;
            engine = run.engine;
            resolvePromise();
          },
          failed: (message) => {
            seen.failed = message;
            resolvePromise();
          },
        },
        { createWorker: broken, timers },
      );
      // The person stops the run at once, before the worker has said anything.
      run.stop();
      expect(run.state).toBe("stopping");
    });
    expect(engine).toBe("slices");
    expect(seen.failed).toBeNull();
    expect(seen.stopped.map((stop) => stop.why)).toEqual(["stop"]);
    expect(seen.stopped[0]?.result.status).toBe("stoppedEarly");
  }, 60_000);

  it("uses the slices where there is no Worker at all", async () => {
    const options: OptimizeOptions = { budget: 25 };
    const { run, seen } = await drive(contract, options, { timers: noTimers });
    expect(typeof Worker).toBe("undefined");
    expect(run.engine).toBe("slices");
    expect(seen.done?.evaluations).toBeLessThanOrEqual(25);
  }, 60_000);
});
