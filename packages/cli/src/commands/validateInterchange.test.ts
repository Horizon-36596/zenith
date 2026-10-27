import { copyFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAuto } from "@horizon36596/zenith-core";
import { runImport } from "./import.js";
import { runValidate } from "./validate.js";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const starter = join(repo, "examples/starter");
const fixture = (path: string): string => join(repo, "packages/import/fixtures", path);

let dir = "";
let out: string[] = [];
let errOut: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zenith-validate-interchange-"));
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

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

interface Body {
  project: string | null;
  errors: number;
  files: { path: string; kind?: string; findings: { severity: string; code: string; stepId: string; field: string; message: string }[] }[];
}

const body = (): Body => JSON.parse(out.join("")) as Body;

/** The broken interchange fixtures and the field each must be named by, as the importer tests hold them. */
const BROKEN: [string, string][] = [
  ["path/broken/bezier-too-many-controls.path.json", "steps[2].segments[0].control"],
  ["path/broken/command-step.path.json", "steps[1].kind"],
  ["path/broken/duplicate-step-id.path.json", "steps[3].id"],
  ["path/broken/frame-without-preset-or-keys.path.json", "frame.originIn"],
  ["path/broken/linear-heading-missing-to.path.json", "steps[2].heading.to"],
  ["path/broken/missing-start-pose.path.json", "startPose"],
  ["path/broken/piecewise-gap.path.json", "steps[2].heading.ranges[1].startT"],
  ["path/broken/segments-do-not-join.path.json", "steps[0].segments[1].from"],
  ["path/broken/unknown-field.path.json", "steps[0]"],
  ["path/broken/wrong-season.path.json", "season"],
  ["trajectory/broken/axes-not-perpendicular.trajectory.json", "frame.yAxis"],
  ["trajectory/broken/frame-without-preset-or-keys.trajectory.json", "frame.originIn"],
  ["trajectory/broken/missing-bounding-box.trajectory.json", "boundingBox"],
  ["trajectory/broken/phase-ends-before-it-starts.trajectory.json", "phases[0].endS"],
  ["trajectory/broken/pose-row-too-short.trajectory.json", "poses[1]"],
  ["trajectory/broken/rate-not-positive.trajectory.json", "rateHz"],
  ["trajectory/broken/unknown-field.trajectory.json", ""],
  ["trajectory/broken/wrong-season.trajectory.json", "season"],
];

describe("zenith validate on interchange files", () => {
  it("covers every broken interchange fixture", () => {
    const all = ["path", "trajectory"].flatMap((kind) =>
      readdirSync(fixture(`${kind}/broken`))
        .filter((name) => name.endsWith(".json"))
        .map((name) => `${kind}/broken/${name}`),
    );
    expect(BROKEN.map(([path]) => path).sort()).toEqual(all.sort());
  });

  for (const [path, field] of BROKEN) {
    it(`exits 1 on ${path} with an error finding naming ${field === "" ? "the file" : field}`, () => {
      expect(runValidate([fixture(path)], { project: starter, json: true })).toBe(1);
      const result = body();
      const file = result.files[0];
      expect(file?.kind).toBe(path.startsWith("path/") ? "path" : "trajectory");
      const errors = (file?.findings ?? []).filter((finding) => finding.severity === "error");
      expect(errors.map((finding) => finding.field)).toContain(field);
      for (const finding of errors) {
        expect(finding.code).toBe("SCHEMA");
        expect(finding.stepId).toBe("(file)");
        expect(finding.message.startsWith(`${finding.field === "" ? "(file)" : finding.field}: `)).toBe(true);
      }
    });
  }

  it("exits 0 on every good interchange fixture", () => {
    const good = [
      ...readdirSync(fixture("path")).filter((name) => name.endsWith(".json")).map((name) => fixture(`path/${name}`)),
      ...readdirSync(fixture("trajectory")).filter((name) => name.endsWith(".json")).map((name) => fixture(`trajectory/${name}`)),
    ];
    expect(runValidate(good, { project: starter, json: true })).toBe(0);
    expect(body().files.map((file) => file.kind)).toEqual([...good.map((path) => (path.replace(/\\/g, "/").includes("/path/") ? "path" : "trajectory"))]);
  });

  it("prints the field in the table a person reads", () => {
    expect(runValidate([fixture("path/broken/piecewise-gap.path.json")], { project: starter })).toBe(1);
    expect(out.join("")).toMatch(/error\s+SCHEMA\s+\(file\)\s+steps\[2\]\.heading\.ranges\[1\]\.startT: is 0\.5; it must be where ranges\[0\] ends/);
  });

  it("reports the importer's warnings as warnings, which do not fail the run", () => {
    const slow = join(dir, "slow.trajectory.json");
    const doc = JSON.parse(readFileSync(fixture("trajectory/pedro-20hz.trajectory.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(slow, JSON.stringify({ ...doc, rateHz: 5 }));
    expect(runValidate([slow], { project: starter, json: true })).toBe(0);
    const warnings = body().files[0]?.findings.filter((finding) => finding.severity === "warning") ?? [];
    expect(warnings.map((finding) => finding.message).join("\n")).toMatch(/rateHz is 5, below the 10 Hz/);
  });

  it("checks an interchange file outside any project against its season's own field", () => {
    const loose = join(dir, "loose.path.json");
    copyFileSync(fixture("path/pedro-score-and-park.path.json"), loose);
    const broken = join(dir, "broken.path.json");
    copyFileSync(fixture("path/broken/piecewise-gap.path.json"), broken);
    expect(runValidate([loose], { cwd: dir, json: true })).toBe(0);
    expect(body().project).toBeNull();
    out = [];
    expect(runValidate([broken], { cwd: dir, json: true })).toBe(1);
    expect(body().files[0]?.findings.map((finding) => finding.field)).toContain("steps[2].heading.ranges[1].startT");
  });

  it("finds an interchange file named relative to the project root", () => {
    const project = join(dir, "project");
    cpSync(starter, project, { recursive: true });
    copyFileSync(fixture("path/broken/wrong-season.path.json"), join(project, "partner.path.json"));
    expect(runValidate(["partner.path.json"], { cwd: dir, project, json: true })).toBe(1);
    expect(body().files[0]).toMatchObject({ kind: "path" });
    expect(body().files[0]?.findings.map((finding) => finding.field)).toContain("season");
  });

  it("validates autos and interchange files side by side", () => {
    const auto = join(starter, "autos/first-auto.auto.json");
    expect(runValidate([auto, fixture("path/broken/wrong-season.path.json")], { project: starter, json: true })).toBe(1);
    const result = body();
    expect(result.files[0]?.kind).toBeUndefined();
    expect(result.files[1]?.kind).toBe("path");
    expect(result.errors).toBeGreaterThan(0);
  });
});

describe("zenith import: path.json files, and the Pedro centre for a .pp file", () => {
  it("writes a path.json as a canonical auto that zenith validate reads, with only its route's own error", () => {
    // Named after the auto, as zenith validate requires: the robot loads an auto by its name.
    const target = join(dir, "pedro-score-and-park.auto.json");
    expect(runImport(fixture("path/pedro-score-and-park.path.json"), { project: starter, out: target })).toBe(0);
    const auto = loadAuto(JSON.parse(readFileSync(target, "utf8")));
    expect(auto.name).toBe("pedro-score-and-park");
    expect(auto.steps.map((step) => step.id)).toContain("gardenApproach");
    out = [];
    // The route itself ends 0.07 in past the centre line (OPPONENT_SIDE, issue #365), which zenith
    // validate reports and the import keeps; nothing else in the file is an error.
    expect(runValidate([target], { project: starter, json: true })).toBe(1);
    const report = JSON.parse(out.join("")) as { files: { findings: { severity: string; code: string; stepId: string }[] }[] };
    const errors = (report.files[0]?.findings ?? []).filter((finding) => finding.severity === "error");
    expect(errors.map((finding) => `${finding.code} ${finding.stepId}`)).toEqual(["OPPONENT_SIDE backToScore"]);
  });

  it("prints the auto, its warnings and its findings as JSON for an agent", () => {
    expect(runImport(fixture("path/roadrunner-piecewise.path.json"), { project: starter, json: true })).toBe(0);
    const result = JSON.parse(out.join("")) as { kind: string; auto: { alliance: string }; findings: unknown[]; warnings: string[] };
    expect(result.kind).toBe("path");
    expect(result.auto.alliance).toBe("RED");
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("exits 2 and names the field when a path.json cannot be imported", () => {
    expect(runImport(fixture("path/broken/segments-do-not-join.path.json"), { project: starter, json: true })).toBe(2);
    const result = JSON.parse(out.join("")) as { issues: { path: string }[] };
    expect(result.issues.map((issue) => issue.path)).toContain("steps[0].segments[1].from");
  });

  it("moves a .pp import by the Pedro centre it is given", () => {
    expect(runImport(fixture("pedro/score-and-park.pp"), { project: starter, json: true })).toBe(0);
    const standard = (JSON.parse(out.join("")) as { auto: { start: { pose: { xIn: number; yIn: number } } } }).auto.start.pose;
    out = [];
    expect(runImport(fixture("pedro/score-and-park.pp"), { project: starter, json: true, pedroCentre: "72" })).toBe(0);
    const shifted = (JSON.parse(out.join("")) as { auto: { start: { pose: { xIn: number; yIn: number } } } }).auto.start.pose;
    expect(shifted.xIn - standard.xIn).toBeCloseTo(-1.25, 9);
    expect(shifted.yIn - standard.yIn).toBeCloseTo(-1.25, 9);
  });
});
