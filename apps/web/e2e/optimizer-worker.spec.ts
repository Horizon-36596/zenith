/**
 * The Optimize path host in the browser (issue #306): on the fake-cloud preview, the host runs the
 * OPT-10 Contract fixture in a real module Web Worker and in the page's slices, and both give the same
 * result hash. Stop in the worker gives a `stoppedEarly` result, and Continue ends on the unstopped
 * result. The 5 s safety stop pauses the longer runs on the way, and each is continued, so Continue is
 * driven here in a real worker as well.
 *
 * Nothing in the editor starts a run yet (the Optimize card is OPT-16), so the test imports the
 * host the way the card will, from the page.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { expect, test } from "@playwright/test";

const root = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));
const link = loadLink(read("zenith.json"));
const request = {
  auto: loadAuto(JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/core/test-fixtures/wide-collect-and-score.auto.json", import.meta.url)), "utf8")) as unknown),
  robot: loadRobot(read(link.robot)),
  field: loadField(read(link.field)),
  waypoints: loadWaypoints(read(link.waypoints ?? "autos/waypoints.json")),
  stepId: "toOtherSide",
  // As the editor's card runs it, with the season's rules (issue #365).
  withSeason: true,
};

interface Outcome {
  engine: string;
  hash?: string;
  status?: string;
  stops: { why: string; status: string; evaluations: number }[];
  error?: string;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("zenith.ui", JSON.stringify({ tour: { seen: true, coreDone: true, fullDone: false } }));
  });
});

test("the module worker and the page's slices give the same result, and Stop and Continue work in the worker", async ({ page }) => {
  test.setTimeout(300_000);
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.goto("/?cloud=fake");
  await expect(page.locator("#root")).not.toBeEmpty();

  const outcomes = await page.evaluate(async (input) => {
    type Run = { engine: string; stop(): void; continue(): void };
    type Result = { status: string; evaluations: number };
    type Host = {
      startOptimize(
        request: unknown,
        options: unknown,
        events: Record<string, (...args: never[]) => void>,
        host?: { engine?: string },
      ): Run;
      resultHash(result: Result): string;
    };
    const url = "/src/optimize/host.ts";
    const host = (await import(/* @vite-ignore */ url)) as Host;
    const once = (engine: "auto" | "slices", stopAtFirstReport: boolean): Promise<Outcome> =>
      new Promise((resolve) => {
        const stops: Outcome["stops"] = [];
        let reports = 0;
        const run = host.startOptimize(
          input,
          {},
          {
            progress: () => {
              reports += 1;
              if (stopAtFirstReport && reports === 1) run.stop();
            },
            stopped: (result: Result, why: string) => {
              stops.push({ why, status: result.status, evaluations: result.evaluations });
              run.continue();
            },
            done: (result: Result) => resolve({ engine: run.engine, hash: host.resultHash(result), status: result.status, stops }),
            failed: (message: string) => resolve({ engine: run.engine, error: message, stops }),
          },
          { engine },
        );
      });
    return { worker: await once("auto", false), slices: await once("slices", false), stopped: await once("auto", true) };
  }, request);

  expect(outcomes.worker.error).toBeUndefined();
  expect(outcomes.worker.engine).toBe("worker");
  expect(outcomes.slices.engine).toBe("slices");
  expect(outcomes.worker.status).toBe("improved");
  expect(outcomes.worker.hash).toBe(outcomes.slices.hash);
  // Every stop on the way, the safety stop's included, gave a stoppedEarly result.
  for (const stop of [...outcomes.worker.stops, ...outcomes.stopped.stops]) expect(stop.status).toBe("stoppedEarly");
  // The Stop sent at the first report is among the stops. Under load the safety stop can fire before
  // that report, so it need not be the first one (issue #426).
  expect(outcomes.stopped.stops.map((stop) => stop.why)).toContain("stop");
  expect(outcomes.stopped.engine).toBe("worker");
  expect(outcomes.stopped.hash).toBe(outcomes.worker.hash);
  // Two runs in a worker, each a module worker of its own.
  expect(workers.filter((url) => url.includes("/src/optimize/worker.ts"))).toHaveLength(2);
});
