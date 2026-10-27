import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "@horizon36596/zenith-core";
import { canonicalize, loadAuto, setRoute, type Finding, type OptimizeResult } from "@horizon36596/zenith-core";
import type { Auto, PathStep } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../index.js";
import { makeProject, simpleAuto, TEST_FIELD, writeAuto } from "../testSupport.js";
import { formatDiff, formatOptimizeCard, runOptimize } from "./optimize.js";
import { runValidate } from "./validate.js";

/**
 * The Contract of OPT-11 (issue #303): `zenith optimize` on a step it can make faster prints a dry run
 * that leaves the file alone, `--write` saves canonical form that validates, `--json` is the
 * `OptimizeResult`, and the exit codes are 0 for improved or no better, 2 for infeasible and 1 for an
 * error.
 *
 * The step is `toOtherSide` in `packages/core/test-fixtures/wide-collect-and-score.auto.json`, the
 * starter's collect-and-score as issue #365 first routed it. It goes round the west of the hive frame
 * wider than it has to, so the search finds a faster route that stays on RED's side of the centre
 * line; the shipped starter is already as fast as the optimizer gets it (issue #367). The core
 * Contract test (`optimize.contract.test.ts`) keeps the route it had before, which clipped the hive.
 */

const STARTER = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const AUTO_FILE = "autos/collect-and-score.auto.json";
const STEP = "toOtherSide";
/**
 * A search of forty evaluations already finds an improvement on the wide fixture's step, moves its
 * marker and improves the starter's sweepGarden, in one to two seconds. The search is pure, so the
 * same budget always gives the same result; a larger one only makes these tests slower.
 */
const BUDGET = 40;

vi.setConfig({ testTimeout: 60_000 });

// The core search runs as it is; the spy only records the options the verb hands it.
vi.mock("@horizon36596/zenith-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@horizon36596/zenith-core")>();
  return { ...actual, runOptimize: vi.fn(actual.runOptimize) };
});

let root = "";
let out: string[] = [];
let errOut: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-optimize-"));
  out = [];
  errOut = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    errOut.push(String(chunk));
    return true;
  });
});

// Every test here is synchronous and vitest goes from one test to the next without a turn of the
// event loop, so the worker never read the runner's replies to its task updates for the whole file.
// birpc then threw `Timeout calling "onTaskUpdate"` once the file passed 60 s (issue #423), though
// the runner had answered long before. One macrotask after each test lets the worker read them.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(core.runOptimize).mockClear();
  rmSync(root, { recursive: true, force: true });
});

const stdout = (): string => out.join("");
const stderr = (): string => errOut.join("");
const readText = (relative: string): string => readFileSync(join(root, relative), "utf8");
/** The wide fixture is collect-and-score with a toOtherSide round the west of the hive frame that has a faster way round. */
const WIDE = fileURLToPath(new URL("../../../core/test-fixtures/wide-collect-and-score.auto.json", import.meta.url));
const copyStarter = (): void => {
  cpSync(STARTER, root, { recursive: true });
  cpSync(WIDE, join(root, AUTO_FILE));
};
const json = (): OptimizeResult & { auto: string; written: boolean } => JSON.parse(stdout()) as OptimizeResult & { auto: string; written: boolean };

describe("zenith optimize: the dry run", () => {
  it("prints before and after under both models, the diff of the step, and leaves the file untouched", () => {
    copyStarter();
    const before = readText(AUTO_FILE);
    const code = runOptimize(AUTO_FILE, { cwd: root, step: STEP, budget: BUDGET });
    expect(code).toBe(0);
    expect(readText(AUTO_FILE)).toBe(before);
    const text = stdout();
    expect(text).toContain(`Optimize path: ${STEP}`);
    expect(text).toContain("improved");
    expect(text).toMatch(/instant sim\s+\d+\.\d\d s\s+\S+\s+\d+\.\d\d s/);
    expect(text).toMatch(/estimate\s+\d+\.\d\d s\s+\S+\s+\d+\.\d\d s/);
    expect(text).toContain("Margin");
    expect(text).toContain(`Changes to step "${STEP}"`);
    expect(text).toMatch(/^- /m);
    expect(text).toMatch(/^\+ /m);
    expect(text).toContain("Nothing was written");
    expect(text).toContain("--write");
  });

  it("lists the markers that move on the field", () => {
    copyStarter();
    // A marker a quarter of the way along the step moves when the route's length changes.
    const doc = JSON.parse(readText(AUTO_FILE)) as { steps: Record<string, unknown>[] };
    const step = doc.steps.find((candidate) => candidate.id === STEP);
    if (step === undefined) throw new Error("the starter lost its step");
    step.markers = [{ at: { t: 0.5 }, command: { name: "setIntake", args: { on: true } } }];
    writeFileSync(join(root, AUTO_FILE), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    const code = runOptimize(AUTO_FILE, { cwd: root, step: STEP, json: true, budget: BUDGET });
    expect(code).toBe(0);
    const result = json();
    if (result.status !== "improved") throw new Error(`expected improved, got ${result.status}: ${result.changes.join(" ")}`);
    expect(result.movedMarkers.length).toBeGreaterThan(0);
    // The card is built from the result, so it lists them without a second search.
    expect(formatOptimizeCard(result, { autoPath: AUTO_FILE, marginFromFlag: false, diff: [], written: false })).toContain("Markers that move");
  });
});

describe("zenith optimize --json", () => {
  it("prints the OptimizeResult, exits 0 and writes nothing", () => {
    copyStarter();
    const before = readText(AUTO_FILE);
    const code = runOptimize(AUTO_FILE, { cwd: root, step: STEP, json: true, budget: BUDGET });
    expect(code).toBe(0);
    expect(readText(AUTO_FILE)).toBe(before);
    const result = json();
    expect(result.status).toBe("improved");
    expect(result.stepId).toBe(STEP);
    expect(result.written).toBe(false);
    expect(result.auto).toBe(AUTO_FILE);
    for (const key of [
      "status",
      "stepId",
      "mode",
      "step",
      "pick",
      "alternatives",
      "scorer",
      "scorerReason",
      "marginIn",
      "movedMarkers",
      "findingsAdded",
      "findingsRemoved",
      "changes",
      "notes",
      "evaluations",
      "budget",
      "inputKey",
      "closest",
    ]) {
      expect(result, key).toHaveProperty(key);
    }
    expect(result.pick?.step).toEqual(result.step);
    expect(result.pick?.t0.after.ownS).toBeLessThanOrEqual(result.pick?.t0.before.ownS ?? 0);
    expect(result.inputKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same result on a second run (it uses no clock and no randomness)", () => {
    copyStarter();
    runOptimize(AUTO_FILE, { cwd: root, step: STEP, json: true, budget: BUDGET });
    const first = stdout();
    out = [];
    runOptimize(AUTO_FILE, { cwd: root, step: STEP, json: true, budget: BUDGET });
    expect(stdout()).toBe(first);
  });

  it("passes the flags through to the search", () => {
    copyStarter();
    runOptimize(AUTO_FILE, { cwd: root, step: STEP, json: true, score: "estimate", mode: "route", budget: 60, marginIn: 0.5, split: false, ranges: false, maxPaths: 2 });
    const result = json();
    expect(result.scorer).toBe("estimate");
    expect(result.mode).toBe("routeOnly");
    expect(result.marginIn).toBe(0.5);
    expect(result.budget).toBe(60);
    expect(result.evaluations).toBeLessThanOrEqual(60);
    for (const route of [result.pick, ...result.alternatives]) {
      if (route === null) continue;
      expect(route.step.segments).toHaveLength(1);
      expect(route.step.heading?.mode).not.toBe("piecewise");
    }
    // Every flag reaches the core search under its own name, including the two the result does not echo.
    expect(core.runOptimize).toHaveBeenCalledTimes(1);
    expect(vi.mocked(core.runOptimize).mock.calls[0]?.[1]).toEqual({
      scorer: "estimate",
      mode: "routeOnly",
      budget: 60,
      marginIn: 0.5,
      allowSplit: false,
      allowRanges: false,
      maxPaths: 2,
    });
  });

  it("passes --hold-start-in and --hold-end-in through as the heading holds, and leaves out a 0 (issue #448)", () => {
    copyStarter();
    runOptimize(AUTO_FILE, { cwd: root, step: STEP, json: true, budget: 60, holdStartIn: 0, holdEndIn: 6 });
    expect(vi.mocked(core.runOptimize).mock.calls[0]?.[1]).toEqual({ budget: 60, holdEndHeadingIn: 6 });
    const result = json();
    for (const route of [result.pick, ...result.alternatives]) {
      if (route === null) continue;
      const heading = route.step.heading;
      // The last range holds E's heading as a constant over at least the last 6 in.
      expect(heading?.mode === "piecewise" ? heading.ranges[heading.ranges.length - 1]?.heading.mode : heading?.mode).toBe("constant");
    }
  });

  it("keeps every route to --max-paths paths when it may split", () => {
    copyStarter();
    runOptimize(AUTO_FILE, { cwd: root, step: STEP, json: true, budget: BUDGET, maxPaths: 1 });
    expect(vi.mocked(core.runOptimize).mock.calls[0]?.[1]).toEqual({ budget: BUDGET, maxPaths: 1 });
    const result = json();
    for (const route of [result.pick, ...result.alternatives]) {
      if (route === null) continue;
      expect(route.step.segments).toHaveLength(1);
    }
  });

  it("maps --mode heading to headingOnly and keeps the segments as written", () => {
    copyStarter();
    const original = loadAuto(JSON.parse(readText(AUTO_FILE))).steps.find((step) => step.id === STEP) as PathStep;
    runOptimize(AUTO_FILE, { cwd: root, step: STEP, json: true, mode: "heading", budget: 80 });
    const result = json();
    expect(result.mode).toBe("headingOnly");
    if (result.step !== null) expect(result.step.segments).toEqual(original.segments);
  });
});

describe("zenith optimize --write", () => {
  it("saves the pick through setRoute in canonical form, changes nothing else, and validates", () => {
    copyStarter();
    const original = loadAuto(JSON.parse(readText(AUTO_FILE)));
    const code = runOptimize(AUTO_FILE, { cwd: root, step: STEP, json: true, write: true, budget: BUDGET });
    expect(code).toBe(0);
    const result = json();
    expect(result.status).toBe("improved");
    expect(result.written).toBe(true);
    if (result.step === null) throw new Error("expected a pick");

    const saved = readText(AUTO_FILE);
    const expected = canonicalize("auto", setRoute(original, STEP, result.step.segments, result.step.heading as NonNullable<PathStep["heading"]>));
    expect(saved).toBe(expected);
    expect(canonicalize("auto", loadAuto(JSON.parse(saved)))).toBe(saved);

    // Every other step is the original's.
    const after = loadAuto(JSON.parse(saved)) as Auto;
    for (const step of original.steps) {
      if (step.id === STEP) continue;
      expect(after.steps.find((candidate) => candidate.id === step.id)).toEqual(step);
    }
    expect(after.steps.find((candidate) => candidate.id === STEP)).toEqual(result.step);

    // A second zenith validate passes.
    out = [];
    expect(runValidate([AUTO_FILE], { cwd: root })).toBe(0);
  });

  it("says so in the text card, and a second run from the written file is no worse", () => {
    copyStarter();
    expect(runOptimize(AUTO_FILE, { cwd: root, step: STEP, write: true, budget: BUDGET })).toBe(0);
    expect(stdout()).toContain(`Wrote ${AUTO_FILE}`);
    expect(stdout()).not.toContain("Nothing was written");
    out = [];
    expect(runOptimize(AUTO_FILE, { cwd: root, step: STEP, json: true, budget: BUDGET })).toBe(0);
    expect(["improved", "noBetter"]).toContain(json().status);
  });

  it("exits 1, not the infeasible 2, when the file cannot be saved, and says so in --json", () => {
    copyStarter();
    const file = join(root, AUTO_FILE);
    const before = readText(AUTO_FILE);
    chmodSync(file, 0o444);
    try {
      const code = runOptimize(AUTO_FILE, { cwd: root, step: STEP, json: true, write: true, budget: BUDGET });
      expect(code).toBe(1);
      const printed = JSON.parse(stdout()) as { error?: string };
      expect(printed.error).toContain(`Could not write ${AUTO_FILE}`);
      out = [];
      expect(runOptimize(AUTO_FILE, { cwd: root, step: STEP, write: true, budget: BUDGET })).toBe(1);
      expect(stderr()).toContain(`Could not write ${AUTO_FILE}`);
    } finally {
      chmodSync(file, 0o644);
    }
    expect(readText(AUTO_FILE)).toBe(before);
  });

  it("writes nothing when the route is already as fast as it gets", () => {
    copyStarter();
    const before = readText("autos/first-auto.auto.json");
    const code = runOptimize("first-auto", { cwd: root, step: "driveOut", write: true, json: true, budget: 60, mode: "route", split: false });
    expect(code).toBe(0);
    const result = json();
    expect(result.status).toBe("noBetter");
    expect(result.written).toBe(false);
    expect(readText("autos/first-auto.auto.json")).toBe(before);
  });
});

describe("zenith optimize: exit codes", () => {
  /** A path whose own end is inside the test field's post box: no route can fix that. */
  const buried = (): Record<string, unknown> =>
    simpleAuto("buried", {
      steps: [
        {
          id: "drive",
          kind: "path",
          segments: [{ kind: "line", from: { ref: "start" }, to: { xIn: 0, yIn: 0, headingRad: 0 } }],
          heading: { mode: "tangent" },
          speedFraction: 0.8,
        },
      ],
    });

  it("exits 2 for an infeasible step, leaves the file alone even with --write, and says why", () => {
    makeProject(root);
    writeAuto(root, "autos", "buried", buried());
    const before = readText("autos/buried.auto.json");
    const code = runOptimize("buried", { cwd: root, step: "drive", write: true, budget: 40 });
    expect(code).toBe(2);
    expect(readText("autos/buried.auto.json")).toBe(before);
    expect(stdout()).toContain("infeasible");
    expect(stdout()).toContain("postBox");
    expect(stdout()).toContain("Nothing was written");
  });

  it("exits 2 in --json too, with status infeasible", () => {
    makeProject(root);
    writeAuto(root, "autos", "buried", buried());
    const code = runOptimize("buried", { cwd: root, step: "drive", json: true, budget: 40 });
    expect(code).toBe(2);
    expect(json().status).toBe("infeasible");
  });

  it("exits 1 for a step that is not there, naming it", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    expect(runOptimize("demo", { cwd: root, step: "nope" })).toBe(1);
    expect(stderr()).toContain('"nope"');
  });

  it("exits 1 for a step that is not a path", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    expect(runOptimize("demo", { cwd: root, step: "shoot1" })).toBe(1);
    expect(stderr()).toContain("only a path can be optimized");
  });

  it("exits 1, with an error key, in --json", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    expect(runOptimize("demo", { cwd: root, step: "nope", json: true })).toBe(1);
    expect((JSON.parse(stdout()) as { error: string }).error).toContain('"nope"');
  });

  it("exits 1 for a margin, a budget or a path limit the search cannot run with", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", simpleAuto("demo"));
    expect(runOptimize("demo", { cwd: root, step: "drive", marginIn: -1 })).toBe(1);
    expect(runOptimize("demo", { cwd: root, step: "drive", budget: 0 })).toBe(1);
    expect(runOptimize("demo", { cwd: root, step: "drive", maxPaths: 0 })).toBe(1);
  });

  it("exits 1 for an auto that does not load, and writes nothing", () => {
    makeProject(root);
    writeAuto(root, "autos", "demo", { name: "demo" });
    const before = readText("autos/demo.auto.json");
    expect(runOptimize("demo", { cwd: root, step: "drive", write: true })).toBe(1);
    expect(readText("autos/demo.auto.json")).toBe(before);
  });

  it("exits 1 when there is no auto at that path", () => {
    makeProject(root);
    expect(runOptimize("missing", { cwd: root, step: "drive" })).toBe(1);
  });
});

/**
 * A step through a structure (issue #388, spec 16 section 4.4 step 7): the original was never a
 * route the robot could drive, so the verb prints the fastest clear route even when it is slower,
 * says what the original goes through, and exits 2 with that sentence when there is no clear route.
 */
describe("zenith optimize: a step through a structure", () => {
  /** A straight line from the start waypoint through the test field's post box to a point past it. */
  const through = (): Record<string, unknown> =>
    simpleAuto("through", {
      steps: [
        {
          id: "drive",
          kind: "path",
          segments: [{ kind: "line", from: { ref: "start" }, to: { xIn: 30, yIn: 50, headingRad: 1.5708 } }],
          heading: { mode: "constant", headingRad: 1.5708 },
          speedFraction: 0.8,
        },
      ],
    });

  it("prints the fastest clear route, slower than the original, and says what the original goes through", () => {
    makeProject(root);
    writeAuto(root, "autos", "through", through());
    const code = runOptimize("through", { cwd: root, step: "drive", budget: 120, score: "estimate" });
    expect(code).toBe(0);
    const text = stdout();
    expect(text).toContain("Result: improved.");
    expect(text).toMatch(/The original goes through the structure "postBox", so this is the fastest clear route found: it is \d+\.\d\d s slower in the estimate\./);
    expect(text).toMatch(/ {2}\d+\.\d\d s slower under the scorer\./);
    expect(text).not.toMatch(/-\d+\.\d\d s faster/);
  });

  it("carries originalBlocked in --json", () => {
    makeProject(root);
    writeAuto(root, "autos", "through", through());
    expect(runOptimize("through", { cwd: root, step: "drive", budget: 120, score: "estimate", json: true })).toBe(0);
    const result = json();
    expect(result.status).toBe("improved");
    expect(result.originalBlocked).toEqual({ step: 4, code: "STRUCTURE", label: 'the structure "postBox"', phrase: 'goes through the structure "postBox"' });
    expect(result.pick?.gainS ?? 0).toBeLessThan(0);
  });

  it("exits 2 with the sentence when no clear route joins the step's ends", () => {
    makeProject(root);
    // The post box grown into a wall across the whole field.
    writeFileSync(
      join(root, "autos/field/field.json"),
      `${JSON.stringify({ ...TEST_FIELD, obstacles: [{ ...TEST_FIELD.obstacles[0], minYIn: -10, maxYIn: 10, minXIn: -80, maxXIn: 80 }] }, null, 2)}\n`,
    );
    writeAuto(root, "autos", "through", through());
    const code = runOptimize("through", { cwd: root, step: "drive", budget: 120, score: "estimate" });
    expect(code).toBe(2);
    expect(stdout()).toContain("Result: infeasible.");
    expect(stdout()).toContain('The original goes through the structure "postBox", and no clear route was found between the step\'s two ends.');
  });
});

/**
 * The shipped starter's sweepGarden rides the field wall, which check() allows; only the instant
 * sim's tracking takes it past the wall's slack (the review of PR #395). It is not blocked, so the
 * verb says improved or no better, exits 0, and never says the original goes through anything.
 */
describe("zenith optimize: a starter step that check() passes", () => {
  it("is improved or no better, exits 0, and does not say the original goes past the wall", () => {
    cpSync(STARTER, root, { recursive: true });
    const code = runOptimize(AUTO_FILE, { cwd: root, step: "sweepGarden", budget: BUDGET });
    const text = stdout();
    expect(code, text).toBe(0);
    expect(text).toMatch(/Result: (improved|noBetter)\./);
    expect(text).not.toContain("infeasible");
    expect(text).not.toContain("The original");
  });

  it("carries no originalBlocked in --json", () => {
    cpSync(STARTER, root, { recursive: true });
    expect(runOptimize(AUTO_FILE, { cwd: root, step: "sweepGarden", json: true, budget: BUDGET })).toBe(0);
    const result = json();
    expect(["improved", "noBetter"]).toContain(result.status);
    expect(result.originalBlocked).toBeNull();
  });
});

describe("zenith optimize: the command", () => {
  it("is registered with the flags of spec 16 section 8.2", () => {
    const command = buildProgram().commands.find((candidate) => candidate.name() === "optimize");
    if (command === undefined) throw new Error("zenith optimize is not registered");
    const flags = command.options.map((option) => option.long);
    for (const flag of ["--step", "--margin-in", "--budget", "--score", "--mode", "--no-split", "--no-ranges", "--max-paths", "--write", "--json", "--project"]) {
      expect(flags, flag).toContain(flag);
    }
    expect(command.helpInformation()).toContain("sim|estimate");
  });

  it("is a dry run unless --write is named, and reads no clock", () => {
    const source = readFileSync(fileURLToPath(new URL("./optimize.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/Date\.now|performance\.now|Math\.random|new Date\(/);
  });
});

describe("zenith optimize: the text card", () => {
  /** A real improved result from the starter, which each test then dresses up. The search runs once for the whole block and each test gets its own copy. */
  let searched: OptimizeResult | null = null;
  const improved = (): OptimizeResult => {
    if (searched === null) {
      copyStarter();
      runOptimize(AUTO_FILE, { cwd: root, step: STEP, json: true, budget: BUDGET });
      searched = json();
      out = [];
    }
    if (searched.pick === null) throw new Error("expected a pick");
    return structuredClone(searched);
  };
  const card = (result: OptimizeResult, marginFromFlag = false): string =>
    formatOptimizeCard(result, { autoPath: AUTO_FILE, marginFromFlag, diff: [], written: false });
  const finding = (code: string, message: string): Finding => ({ code, severity: "warning", stepId: STEP, message }) as Finding;

  it("numbers the alternatives with their labels, times and changes", () => {
    const result = improved();
    const pick = result.pick as NonNullable<OptimizeResult["pick"]>;
    result.alternatives = [
      { ...pick, label: "Faster in the instant sim, slower in the estimate", changes: ["It goes round the hive on the left."] },
      { ...pick, label: null, changes: [] },
    ];
    const text = card(result);
    expect(text).toContain("\nAlternatives:\n");
    expect(text).toContain("  1. Faster in the instant sim, slower in the estimate");
    expect(text).toContain("       It goes round the hive on the left.");
    expect(text).toContain("  2. Another route that passes the final check");
    expect(text.split("\n").filter((line) => /^ {4}estimate\s/.test(line))).toHaveLength(2);
  });

  it("gives the pick's label, which only a pick round a blocked original has, and none otherwise", () => {
    const result = improved();
    expect(card(result)).toContain("\nBefore and after:\n");
    const pick = result.pick as NonNullable<OptimizeResult["pick"]>;
    result.pick = { ...pick, label: "Faster in the instant sim, slower in the estimate" };
    expect(card(result)).toContain("\nBefore and after (Faster in the instant sim, slower in the estimate):\n");
  });

  it("lists the findings it removes and the findings it adds", () => {
    const result = improved();
    result.findingsRemoved = [finding("STRUCTURE", "The robot clips the hive.")];
    result.findingsAdded = [finding("CLEARANCE", "The robot passes close to the wall.")];
    const text = card(result);
    expect(text).toContain(`Findings it removes:\n  STRUCTURE (warning) on "${STEP}": The robot clips the hive.`);
    expect(text).toContain(`Findings it adds:\n  CLEARANCE (warning) on "${STEP}": The robot passes close to the wall.`);
  });

  it("names the field wall, a keep-out and a structure in the closest attempt", () => {
    const result: OptimizeResult = { ...improved(), pick: null, alternatives: [], status: "infeasible" };
    const pose = { xIn: 1, yIn: -2.5, headingRad: 0 };
    expect(card({ ...result, closest: { step: null, pose, kind: "wall", id: null, shortfallIn: 1.5 } })).toContain(
      "Closest attempt: the robot at (1.00, -2.50) falls 1.5 in short of the field wall.",
    );
    expect(card({ ...result, closest: { step: null, pose, kind: "keepOut", id: "launchZone", shortfallIn: 0.25 } })).toContain(
      'Closest attempt: the robot at (1.00, -2.50) falls 0.25 in short of the keep-out "launchZone".',
    );
    expect(card({ ...result, closest: { step: null, pose, kind: "structure", id: "hive", shortfallIn: 2 } })).toContain(
      'falls 2 in short of the structure "hive".',
    );
    expect(card({ ...result, closest: null })).not.toContain("Closest attempt");
  });

  it("names the centre line, which has no id, where a route comes closest to it, never as an empty name", () => {
    const result = improved();
    const pick = result.pick as NonNullable<OptimizeResult["pick"]>;
    result.pick = { ...pick, closest: { kind: "keepOut", id: core.CENTRE_LINE_KEEPOUT_ID, clearanceIn: 4.05 } };
    const text = card(result);
    expect(text).toContain("Closest it comes to the centre line: 4.05 in.");
    expect(text).not.toContain('""');
    result.pick = { ...pick, closest: { kind: "structure", id: "frameLegSouthWest", clearanceIn: 3.5 } };
    expect(card(result)).toContain('Closest it comes to the structure "frameLegSouthWest": 3.5 in.');
  });

  it("says where the margin came from", () => {
    const result = improved();
    expect(card(result, true)).toContain("to structures (set by --margin-in).");
    expect(card(result, false)).toContain("to structures (the robot's clearance).");
  });

  it("marks a gap between two changed places with ...", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = ["A", "b", "c", "d", "e", "f", "g", "h", "i", "J"].join("\n");
    expect(formatDiff(before, after)).toEqual(["  ...", "- a", "+ A", "  b", "  c", "  ...", "  h", "  i", "- j", "+ J"]);
  });

  it("starts with the gap marker and keeps one run of context when the changes are close", () => {
    const before = ["a", "b", "c", "d"].join("\n");
    const after = ["a", "B", "c", "d"].join("\n");
    expect(formatDiff(before, after)).toEqual(["  ...", "  a", "- b", "+ B", "  c", "  d"]);
  });
});
