import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as core from "@horizon36596/zenith-core";
import { canonicalize, loadAuto, type OptimizeResult } from "@horizon36596/zenith-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "./server.js";

/**
 * The Contract of OPT-12 (issue #304): `zenith.optimize` returns the OptimizeResult and never writes,
 * and `zenith.edit.setRoute` applies a route, writes canonical form and refuses a route that moves an
 * end with the edit's own message.
 *
 * The step is `toOtherSide` in `packages/core/test-fixtures/wide-collect-and-score.auto.json`, the one
 * the CLI Contract test uses: it goes round the west of the hive frame wider than it has to, so the
 * search finds a faster route that stays on RED's side of the centre line (issues #365 and #367).
 */

vi.setConfig({ testTimeout: 60_000 });

// The core search runs as it is; the spy only records what the tool hands it.
vi.mock("@horizon36596/zenith-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@horizon36596/zenith-core")>();
  return { ...actual, runOptimize: vi.fn(actual.runOptimize) };
});

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(here, "..", "..", "..", "examples", "starter");
const AUTO_FILE = "autos/collect-and-score.auto.json";
/** collect-and-score with a toOtherSide round the west of the hive frame that has a faster way round (issue #367). */
const WIDE = join(here, "..", "..", "core", "test-fixtures", "wide-collect-and-score.auto.json");
const AUTO = "collect-and-score";
const STEP = "toOtherSide";
/**
 * A search of forty evaluations already finds an improvement on the wide fixture's step, and a clear
 * route round the hive frame for a step through it, in one to two seconds. The search is pure, so the
 * same budget always gives the same result; a larger one only makes these tests slower.
 */
const BUDGET = 40;

interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

interface Segment {
  kind: string;
  from: unknown;
  to: unknown;
}

interface EditBody {
  written: string;
  auto: { steps: { id: string; segments?: Segment[]; heading?: unknown }[] };
  findings: { code: string; severity: string }[];
}

describe("zenith.optimize and zenith.edit.setRoute", () => {
  let client: Client;
  const temps: string[] = [];

  const project = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "zenith-mcp-optimize-"));
    cpSync(examplesDir, dir, { recursive: true });
    cpSync(WIDE, join(dir, AUTO_FILE));
    temps.push(dir);
    return dir;
  };

  const raw = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const result = (await client.callTool({ name, arguments: { auto: AUTO, ...args } })) as ToolResult;
    return { text: result.content.find((item) => item.type === "text")?.text ?? "", isError: result.isError === true };
  };

  const optimize = async (dir: string, args: Record<string, unknown> = {}): Promise<OptimizeResult> => {
    const { text, isError } = await raw("zenith.optimize", { stepId: STEP, budget: BUDGET, project: dir, ...args });
    if (isError) throw new Error(`tool error: ${text}`);
    return JSON.parse(text) as OptimizeResult;
  };

  /** Writes one path from south of the hive frame's west base bar to north of it, straight along the bar, as `through-the-hive`. */
  const writeThroughTheHive = (dir: string): void => {
    const through = {
      $schema: "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
      formatVersion: 4,
      name: "through-the-hive",
      alliance: "RED",
      start: { pose: { xIn: -23.65, yIn: -40, headingRad: 1.5708 } },
      steps: [
        {
          id: "pastTheHive",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: -23.65, yIn: 40 } }],
          heading: { mode: "constant", headingRad: 1.5708 },
        },
      ],
    };
    writeFileSync(join(dir, "autos", "through-the-hive.auto.json"), `${JSON.stringify(through, null, 2)}\n`, "utf8");
  };

  beforeAll(async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    client = new Client({ name: "zenith-mcp-optimize-test", version: "0.0.0" });
    await client.connect(clientSide);
  });

  // The tools read and write with node:fs's sync calls and the in-memory transport delivers each
  // message in the same tick, so vitest went from one test to the next without a turn of the event
  // loop and the worker never read the runner's replies to its task updates for the whole file.
  // birpc then threw `Timeout calling "onTaskUpdate"` once the file passed 60 s (issue #423), though
  // the runner had answered long before. One macrotask after each test lets the worker read them.
  afterEach(async () => {
    vi.mocked(core.runOptimize).mockClear();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  afterAll(async () => {
    await client.close();
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it("registers zenith.optimize as read-only and zenith.edit.setRoute as a writer", async () => {
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "zenith.optimize")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "zenith.edit.setRoute")).toBeDefined();
    expect(tools.find((tool) => tool.name === "zenith.edit.setRoute")?.annotations?.readOnlyHint).not.toBe(true);
  });

  it("zenith.optimize returns the OptimizeResult and leaves the file as it was", async () => {
    const dir = project();
    const before = readFileSync(join(dir, AUTO_FILE), "utf8");
    const result = await optimize(dir);
    expect(readFileSync(join(dir, AUTO_FILE), "utf8")).toBe(before);
    expect(result.status).toBe("improved");
    expect(result.stepId).toBe(STEP);
    expect(result.pick?.step).toEqual(result.step);
    expect(result.pick?.t0.after.ownS).toBeLessThanOrEqual(result.pick?.t0.before.ownS ?? 0);
    expect(result.inputKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evaluations).toBeLessThanOrEqual(BUDGET);
  });

  it("zenith.optimize passes its options to the search", async () => {
    const dir = project();
    const result = await optimize(dir, {
      budget: 60,
      scorer: "estimate",
      mode: "routeOnly",
      marginIn: 0.5,
      allowSplit: false,
      allowRanges: false,
      maxPaths: 2,
    });
    expect(result.scorer).toBe("estimate");
    expect(result.mode).toBe("routeOnly");
    expect(result.marginIn).toBe(0.5);
    expect(result.budget).toBe(60);
    for (const route of [result.pick, ...result.alternatives]) {
      if (route === null) continue;
      expect(route.step.segments).toHaveLength(1);
      expect((route.step.heading as { mode: string }).mode).not.toBe("piecewise");
    }
    // Every option reaches the core search under its own name, including the ones the result does not echo.
    expect(core.runOptimize).toHaveBeenCalledTimes(1);
    const [input, options] = vi.mocked(core.runOptimize).mock.calls[0] ?? [];
    expect(input?.stepId).toBe(STEP);
    expect(options).toEqual({ budget: 60, scorer: "estimate", mode: "routeOnly", marginIn: 0.5, allowSplit: false, allowRanges: false, maxPaths: 2 });
  });

  it("zenith.optimize passes the heading holds to the search, and leaves out a 0 (issue #448)", async () => {
    const dir = project();
    await optimize(dir, { budget: 60, holdStartHeadingIn: 4, holdEndHeadingIn: 0 });
    expect(vi.mocked(core.runOptimize).mock.calls[0]?.[1]).toEqual({ budget: 60, holdStartHeadingIn: 4 });
  });

  it("zenith.optimize hands the search only the options it was given", async () => {
    const dir = project();
    await optimize(dir, { maxPaths: 1 });
    expect(vi.mocked(core.runOptimize).mock.calls[0]?.[1]).toEqual({ budget: BUDGET, maxPaths: 1 });
  });

  it("zenith.optimize returns an infeasible result with no pick and the closest attempt", async () => {
    const dir = project();
    // The step as a straight line through the hive frame's west base bar, which check() reports, and
    // no route round the frame keeps six inches, the most the tool takes, from every structure.
    const file = join(dir, AUTO_FILE);
    const wide = JSON.parse(readFileSync(file, "utf8")) as { steps: { id: string; segments?: Segment[] }[] };
    const step = wide.steps.find((candidate) => candidate.id === STEP);
    const first = step?.segments?.[0];
    const last = step?.segments?.[step.segments.length - 1];
    if (step === undefined || first === undefined || last === undefined) throw new Error("the wide fixture lost its step");
    step.segments = [{ kind: "line", from: first.from, to: last.to }];
    writeFileSync(file, `${JSON.stringify(wide, null, 2)}\n`, "utf8");
    const before = readFileSync(file, "utf8");
    const result = await optimize(dir, { marginIn: 6, budget: 40 });
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(result.status).toBe("infeasible");
    expect(result.stepId).toBe(STEP);
    expect(result.originalBlocked).toMatchObject({ step: 4, code: "STRUCTURE" });
    expect(result.marginIn).toBe(6);
    expect(result.pick).toBeNull();
    expect(result.step).toBeNull();
    expect(result.alternatives).toEqual([]);
    expect(result.closest).not.toBeNull();
    expect(result.closest?.shortfallIn).toBeGreaterThan(0);
    expect(["wall", "keepOut", "structure"]).toContain(result.closest?.kind);
    expect(result.closest?.pose).toEqual({ xIn: expect.any(Number), yIn: expect.any(Number), headingRad: expect.any(Number) });
    expect(result.changes.length + result.notes.length).toBeGreaterThan(0);
  });

  it("zenith.optimize never calls a step that check() passes infeasible, even at a margin no route keeps (PR #395)", async () => {
    const dir = project();
    const result = await optimize(dir, { marginIn: 6, budget: 40 });
    expect(result.status).toBe("noBetter");
    expect(result.originalBlocked).toBeNull();
    expect(result.closest).toBeNull();
  });

  it("zenith.optimize returns noBetter with no pick when the route is already as fast as it gets", async () => {
    const dir = project();
    const { text, isError } = await raw("zenith.optimize", {
      auto: "first-auto",
      stepId: "driveOut",
      budget: 60,
      mode: "routeOnly",
      allowSplit: false,
      project: dir,
    });
    expect(isError, text).toBe(false);
    const result = JSON.parse(text) as OptimizeResult;
    expect(result.status).toBe("noBetter");
    expect(result.pick).toBeNull();
    expect(result.step).toBeNull();
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it("zenith.optimize refuses to run against a robot override that does not load", async () => {
    const dir = project();
    writeFileSync(join(dir, "autos", "broken.robot.json"), "{}\n", "utf8");
    const doc = JSON.parse(readFileSync(join(dir, AUTO_FILE), "utf8")) as Record<string, unknown>;
    doc.robot = "autos/broken.robot.json";
    writeFileSync(join(dir, AUTO_FILE), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
    const { text, isError } = await raw("zenith.optimize", { stepId: STEP, budget: BUDGET, project: dir });
    expect(isError).toBe(true);
    expect(text).toContain("zenith.optimize cannot run");
    expect(text).toContain("autos/broken.robot.json");
    // It stopped before the search: nothing was optimized against the project's own robot instead.
    expect(core.runOptimize).not.toHaveBeenCalled();
  });

  it("zenith.optimize returns the fastest clear route for a step through the hive frame, and says what it goes through (issue #388)", async () => {
    const dir = project();
    writeThroughTheHive(dir);
    const { text, isError } = await raw("zenith.optimize", { auto: "through-the-hive", stepId: "pastTheHive", budget: BUDGET, project: dir });
    expect(isError, text).toBe(false);
    const result = JSON.parse(text) as OptimizeResult;
    expect(result.status, result.changes.join(" ")).toBe("improved");
    expect(result.originalBlocked).toMatchObject({ step: 4, code: "STRUCTURE" });
    expect(result.originalBlocked?.label).toMatch(/of the hive frame$/);
    expect(result.changes[0]).toMatch(/^The original goes through the .+ of the hive frame, so this is the fastest clear route found: it /);
    expect(result.findingsRemoved.map((finding) => finding.code)).toContain("STRUCTURE");
  });

  it("zenith.optimize gives the same result for the same inputs", async () => {
    const dir = project();
    expect(await optimize(dir)).toEqual(await optimize(dir));
  });

  it("zenith.optimize says so when the step is not there or is not a path", async () => {
    const dir = project();
    const missing = await raw("zenith.optimize", { stepId: "nope", project: dir });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("nope");
    for (const stepId of ["shootPreloads", "waitForFull"]) {
      const notPath = await raw("zenith.optimize", { stepId, project: dir });
      expect(notPath.isError, stepId).toBe(true);
      expect(notPath.text).toContain(stepId);
      expect(notPath.text).toContain("only a path can be optimized");
    }
  });

  it("zenith.edit.setRoute applies the route zenith.optimize returned, in canonical form, and the result validates", async () => {
    const dir = project();
    const result = await optimize(dir);
    if (result.status !== "improved" || result.step === null) throw new Error(`expected improved, got ${result.status}`);
    const { text, isError } = await raw("zenith.edit.setRoute", {
      stepId: STEP,
      segments: result.step.segments,
      heading: result.step.heading,
      project: dir,
    });
    expect(isError, text).toBe(false);
    const body = JSON.parse(text) as EditBody;
    expect(body.written).toBe(AUTO_FILE);
    expect(body.findings.filter((finding) => finding.severity === "error")).toEqual([]);
    const file = readFileSync(join(dir, AUTO_FILE), "utf8");
    expect(canonicalize("auto", loadAuto(JSON.parse(file) as unknown))).toBe(file);
    const written = JSON.parse(file) as { steps: { id: string; segments?: unknown; heading?: unknown }[] };
    const step = written.steps.find((candidate) => candidate.id === STEP);
    expect(step?.segments).toEqual(JSON.parse(JSON.stringify(result.step.segments)));
    expect(step?.heading).toEqual(JSON.parse(JSON.stringify(result.step.heading)));
  });

  it("zenith.edit.setRoute refuses a route that moves an end, names both ends and writes nothing", async () => {
    const dir = project();
    const result = await optimize(dir);
    if (result.status !== "improved" || result.step === null) throw new Error(`expected improved, got ${result.status}`);
    const before = readFileSync(join(dir, AUTO_FILE), "utf8");
    const segments = JSON.parse(JSON.stringify(result.step.segments)) as Segment[];
    const last = segments[segments.length - 1];
    if (last === undefined) throw new Error("the pick has no segments");
    last.to = { xIn: 0, yIn: 0, headingRad: 0 };
    const { text, isError } = await raw("zenith.edit.setRoute", {
      stepId: STEP,
      segments,
      heading: result.step.heading,
      project: dir,
    });
    expect(isError).toBe(true);
    expect(text).toContain("A new route keeps both ends.");
    expect(text).toContain(STEP);
    expect(readFileSync(join(dir, AUTO_FILE), "utf8")).toBe(before);
  });

  it("zenith.edit.setRoute refuses a route whose first path starts somewhere else, and writes nothing", async () => {
    const dir = project();
    const result = await optimize(dir);
    if (result.status !== "improved" || result.step === null) throw new Error(`expected improved, got ${result.status}`);
    const before = readFileSync(join(dir, AUTO_FILE), "utf8");
    const segments = JSON.parse(JSON.stringify(result.step.segments)) as Segment[];
    const first = segments[0];
    if (first === undefined) throw new Error("the pick has no segments");
    first.from = { xIn: 0, yIn: 0, headingRad: 0 };
    const { text, isError } = await raw("zenith.edit.setRoute", {
      stepId: STEP,
      segments,
      heading: result.step.heading,
      project: dir,
    });
    expect(isError).toBe(true);
    expect(text).toContain("A new route keeps both ends.");
    expect(text).toContain(STEP);
    expect(readFileSync(join(dir, AUTO_FILE), "utf8")).toBe(before);
  });

  it("zenith.edit.setRoute refuses a step that is not there", async () => {
    const dir = project();
    const before = readFileSync(join(dir, AUTO_FILE), "utf8");
    const { text, isError } = await raw("zenith.edit.setRoute", {
      stepId: "nope",
      segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 0 } }],
      heading: { mode: "tangent" },
      project: dir,
    });
    expect(isError).toBe(true);
    expect(text).toContain("nope");
    expect(readFileSync(join(dir, AUTO_FILE), "utf8")).toBe(before);
  });
});
