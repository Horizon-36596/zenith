import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, estimate, loadAuto } from "@horizon36596/zenith-core";
import type { Auto, Step } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAutoAndPlan } from "../autoLoad.js";
import { loadProject } from "../project.js";
import { makeProject, TEST_ROBOT } from "../testSupport.js";
import { runCodegen } from "./codegen.js";
import { runDeploy } from "./deploy.js";
import { runValidate } from "./validate.js";

/**
 * M-C5's Contract, its second half (spec 13 section 16): an auto with envelopes and a rejoin pose
 * still validates, deploys and runs. The envelope and the rejoin pose are planner-only, so the
 * Java a deploy or a codegen writes must be the same with or without them.
 *
 * The auto is the runtime's own conformance fixture, `envelopes.auto.json`, so the same file is
 * run by both Java runtimes (`ConformanceTest`, next to it) and checked here. Its companion,
 * `envelopes-stripped.auto.json`, is the same auto with every `envelope` and `rejoinFrom` taken
 * out; the runtime test asserts that both drive and log the same, and this file keeps the
 * companion in step. Set `ZENITH_UPDATE_GOLDEN=1` to write the companion instead of comparing.
 */
const conformance = fileURLToPath(new URL("../../../../robot/auto-runtime/src/test/resources/conformance/", import.meta.url));
const FIXTURE = `${conformance}envelopes.auto.json`;
const STRIPPED = `${conformance}envelopes-stripped.auto.json`;

/** The conformance world's commands, declared so the planner knows them. `take` moves the robot. */
const ROBOT = {
  ...TEST_ROBOT,
  commands: [
    {
      name: "take",
      params: { loops: { type: "integer", min: 0 } },
      estimateS: "unknown",
      movesRobot: true,
    },
    { name: "instant", params: { tag: { type: "string" } }, estimateS: "0" },
  ],
};

/** The conformance waypoints, with the provenance a team's own file carries. */
function waypoints(): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(`${conformance}waypoints.json`, "utf8")) as {
    waypoints: Record<string, Record<string, unknown>>;
  };
  const labelled = Object.fromEntries(
    Object.entries(doc.waypoints).map(([name, pose]) => [name, { ...pose, provenance: "SET BY HAND: conformance fixture" }]),
  );
  return { ...doc, waypoints: labelled };
}

/** The auto with every envelope and rejoin pose taken out, all the way down. */
function stripped(auto: Auto): Auto {
  const strip = (step: Step): Step => {
    const { envelope: _envelope, rejoinFrom: _rejoinFrom, ...rest } = step as Step & { envelope?: unknown; rejoinFrom?: unknown };
    const bare = rest as Step;
    if (bare.kind === "parallel" || bare.kind === "sequence") return { ...bare, steps: bare.steps.map(strip) };
    if (bare.kind === "branch") {
      return { ...bare, then: bare.then.map(strip), ...(bare.else === undefined ? {} : { else: bare.else.map(strip) }) };
    }
    return bare;
  };
  return { ...auto, steps: auto.steps.map(strip) };
}

const fixture = (): Auto => loadAuto(JSON.parse(readFileSync(FIXTURE, "utf8")));

let roots: string[] = [];
let out: string[] = [];

/** A project holding one auto file, `autos/envelopes.auto.json`, with these bytes. */
function projectWith(bytes: string): string {
  const root = mkdtempSync(join(tmpdir(), "zenith-envelopes-"));
  roots.push(root);
  makeProject(root);
  writeFileSync(join(root, "autos/robot.json"), `${JSON.stringify(ROBOT, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "autos/waypoints.json"), `${JSON.stringify(waypoints(), null, 2)}\n`, "utf8");
  writeFileSync(join(root, "autos/envelopes.auto.json"), bytes, "utf8");
  return root;
}

beforeEach(() => {
  roots = [];
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("an auto with envelopes and a rejoin pose (M-C5)", () => {
  it("is the fixture it says it is: envelopes on a path, a command and a wait, a what-if run time and a rejoin pose", () => {
    const auto = fixture();
    const kinds = auto.steps.filter((step) => "envelope" in step && step.envelope !== undefined).map((step) => step.kind);
    expect(kinds).toEqual(["path", "command", "wait"]);
    const collect = auto.steps.find((step) => step.id === "collect");
    expect(collect?.kind === "command" ? collect.envelope?.actualDurationS : undefined).toBe(1.5);
    expect(auto.steps.some((step) => step.kind === "path" && step.rejoinFrom !== undefined)).toBe(true);
  });

  it("keeps its stripped companion in step, byte for byte", () => {
    const companion = canonicalize("auto", {
      ...stripped(fixture()),
      name: "envelopes-stripped",
      title: "The envelopes fixture with every envelope and rejoin pose taken out",
    });
    if (process.env["ZENITH_UPDATE_GOLDEN"] === "1") writeFileSync(STRIPPED, companion, "utf8");
    expect(readFileSync(STRIPPED, "utf8")).toBe(companion);
  });

  it("validates with no errors, and times the moving command by its envelope's what-if run time", () => {
    const root = projectWith(readFileSync(FIXTURE, "utf8"));
    expect(runValidate(["envelopes"], { cwd: root, json: true })).toBe(0);
    const report = JSON.parse(out.join("")) as { errors: number; files: { findings: { severity: string }[] }[] };
    expect(report.errors).toBe(0);

    const loaded = loadAutoAndPlan(join(root, "autos/envelopes.auto.json"), loadProject(root));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const timed = estimate(loaded.loaded.plan, loaded.loaded.plan.robot);
    // The collect's envelope lasts at most 2 s and previews a 1.5 s run (actualDurationS), which
    // the planner times it by; the runtime reads past both keys.
    expect(timed.byStepId["collect"]?.nominalS).toBe(1.5);
    expect(timed.byStepId["collect"]?.fromActualDuration).toBe(true);
  });

  it("deploys: the file is copied as it is, envelopes included, and its OpMode stub is written", () => {
    const bytes = readFileSync(FIXTURE, "utf8");
    const root = projectWith(bytes);
    expect(runDeploy({ cwd: root })).toBe(0);
    expect(readFileSync(join(root, "deploy/envelopes.auto.json"), "utf8")).toBe(bytes);
    const stub = readFileSync(join(root, "java/org/example/teamcode/opmode/Auto/generated/EnvelopesAuto.java"), "utf8");
    expect(stub).toContain('@Override protected String autoName() { return "envelopes"; }');
  });

  it("generates the same Java with or without its envelopes and rejoin pose", () => {
    const generate = (bytes: string): string => {
      const root = projectWith(bytes);
      out = [];
      expect(runCodegen("envelopes", { cwd: root, json: true })).toBe(0);
      const { written, shaHex } = JSON.parse(out.join("")) as { written: string; shaHex: string };
      // The header names the file's hash, which is the one thing that should differ.
      return readFileSync(join(root, written), "utf8").split(shaHex).join("<sha>");
    };
    const withEnvelopes = generate(readFileSync(FIXTURE, "utf8"));
    const without = generate(canonicalize("auto", stripped(fixture())));
    expect(withEnvelopes).toBe(without);
  });
});
