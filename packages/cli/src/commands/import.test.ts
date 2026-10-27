import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { parseProjection } from "@horizon36596/zenith-schema";
import { runAlliance } from "./alliance.js";
import { runImport } from "./import.js";
import { runValidate } from "./validate.js";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const starter = join(repo, "examples/starter");
const fixture = (path: string): string => join(repo, "packages/import/fixtures", path);

let dir = "";
let out: string[] = [];
let errOut: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zenith-import-"));
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

describe("zenith import", () => {
  it("writes a .pp project as a canonical auto that zenith validate reads, with only its route's own error", () => {
    const target = join(dir, "score-and-park.auto.json");
    expect(runImport(fixture("pedro/score-and-park.pp"), { project: starter, out: target })).toBe(0);
    const auto = loadAuto(JSON.parse(readFileSync(target, "utf8")));
    expect(auto.name).toBe("score-and-park");
    expect(out.join("")).toMatch(/written: /);
    out = [];
    // The route itself ends 0.07 in past the centre line (OPPONENT_SIDE, issue #365), which zenith
    // validate reports and the import keeps; nothing else in the file is an error.
    expect(runValidate([target], { project: starter, json: true })).toBe(1);
    const report = JSON.parse(out.join("")) as { files: { findings: { severity: string; code: string; stepId: string }[] }[] };
    const errors = (report.files[0]?.findings ?? []).filter((finding) => finding.severity === "error");
    expect(errors.map((finding) => `${finding.code} ${finding.stepId}`)).toEqual(["OPPONENT_SIDE backToScore"]);
  });

  it("prints the auto on stdout and the warnings on stderr without --out", () => {
    expect(runImport(fixture("pedro/newer-version-with-event.pp"), { project: starter })).toBe(0);
    expect(loadAuto(JSON.parse(out.join(""))).steps[1]).toMatchObject({ kind: "command", name: "imported1" });
    expect(errOut.join("")).toMatch(/project version 1\.7\.0; the importer understands 1\.5\.0/);
    expect(errOut.join("")).toMatch(/SCHEMA\s+imported1/);
  });

  it("prints the auto, its warnings and its findings as JSON for an agent", () => {
    expect(runImport(fixture("pedro/groups-and-piecewise.pp"), { project: starter, json: true, alliance: "red" })).toBe(0);
    const body = JSON.parse(out.join("")) as { kind: string; auto: { alliance: string }; robotFootprint: unknown; findings: unknown[]; warnings: string[] };
    expect(body.kind).toBe("pedro");
    expect(body.auto.alliance).toBe("RED");
    expect(body.robotFootprint).toMatchObject({ lengthIn: 17, widthIn: 16.5 });
    expect(Array.isArray(body.findings)).toBe(true);
    expect(body.warnings.some((warning) => warning.includes("4 control points"))).toBe(true);
  });

  it("imports a trajectory.json as a 10 Hz projection", () => {
    expect(runImport(fixture("trajectory/meepmeep-line-and-turn.trajectory.json"), { project: starter, json: true })).toBe(0);
    const body = JSON.parse(out.join("")) as { kind: string; projection: { trajectory: { rateHz: number; poses: unknown[] } } };
    expect(body.kind).toBe("trajectory");
    expect(body.projection.trajectory.rateHz).toBe(10);
    expect(body.projection.trajectory.poses).toHaveLength(51);
  });

  it("writes a trajectory.json's projection in canonical form, which zenith alliance reads", () => {
    const target = join(dir, "partner.projection.json");
    expect(runImport(fixture("trajectory/meepmeep-line-and-turn.trajectory.json"), { project: starter, out: target })).toBe(0);
    const text = readFileSync(target, "utf8");
    const projection = parseProjection(JSON.parse(text));
    expect(canonicalize("projection", projection)).toBe(text);
    out = [];
    expect(runAlliance("first-auto", [target], { project: starter, json: true })).not.toBe(2);
  });

  it("writes a trajectory.json as an auto with --as-auto, and refuses --as-auto for a .pp file", () => {
    const target = join(dir, "meepmeep.auto.json");
    expect(runImport(fixture("trajectory/meepmeep-line-and-turn.trajectory.json"), { project: starter, out: target, asAuto: true })).toBe(0);
    const auto = loadAuto(JSON.parse(readFileSync(target, "utf8")));
    expect(auto.name).toBe("meepmeep-line-and-turn");
    expect(auto.steps.map((step) => step.id)).toEqual(["drive1", "wait1", "turn1"]);
    expect(out.join("")).toMatch(/timed from this project's robot\.json/);
    out = [];
    expect(runImport(fixture("pedro/score-and-park.pp"), { project: starter, asAuto: true, json: true })).toBe(2);
    expect((JSON.parse(out.join("")) as { error: string }).error).toMatch(/--as-auto is for a trajectory\.json/);
  });

  it("exits 2 and names the field when a file cannot be imported", () => {
    expect(runImport(fixture("pedro/broken/end-point-not-a-number.pp"), { project: starter })).toBe(2);
    expect(errOut.join("")).toContain("lines[1].endPoint.x");
    errOut = [];
    expect(runImport(fixture("trajectory/broken/pose-row-too-short.trajectory.json"), { project: starter, json: true })).toBe(2);
    const body = JSON.parse(out.join("")) as { issues: { path: string }[] };
    expect(body.issues.map((issue) => issue.path)).toContain("poses[1]");
  });

  it("exits 2 for a JSON file that is neither kind", () => {
    const other = join(dir, "other.json");
    writeFileSync(other, '{ "hello": 1 }\n', "utf8");
    expect(runImport(other, { project: starter })).toBe(2);
    expect(errOut.join("")).toMatch(/neither a Pedro Visualizer project/);
  });

  it("refuses to overwrite --out without --force", () => {
    const target = join(dir, "exists.auto.json");
    writeFileSync(target, "{}\n", "utf8");
    expect(runImport(fixture("pedro/score-and-park.pp"), { project: starter, out: target })).toBe(2);
    expect(errOut.join("")).toMatch(/already exists\. Pass --force to overwrite it\./);
    expect(readFileSync(target, "utf8")).toBe("{}\n");
    expect(runImport(fixture("pedro/score-and-park.pp"), { project: starter, out: target, force: true })).toBe(0);
  });

  it("prints every usage error as the JSON error shape under --json, and nothing on stderr", () => {
    const target = join(dir, "exists.auto.json");
    writeFileSync(target, "{}\n", "utf8");
    const cases: { file: string; options: Parameters<typeof runImport>[1]; says: RegExp }[] = [
      { file: fixture("pedro/score-and-park.pp"), options: { out: target }, says: /--force/ },
      { file: fixture("pedro/score-and-park.pp"), options: { alliance: "GREEN" }, says: /--alliance must be RED or BLUE/ },
      { file: fixture("pedro/score-and-park.pp"), options: { pedroCentre: "wide" }, says: /--pedro-centre must be a number of inches/ },
      { file: fixture("path/pedro-score-and-park.path.json"), options: { alliance: "BLUE" }, says: /a path\.json file names its own alliance and frame/ },
    ];
    for (const each of cases) {
      out = [];
      errOut = [];
      expect(runImport(each.file, { project: starter, json: true, ...each.options })).toBe(2);
      const body = JSON.parse(out.join("")) as { error: string; issues: unknown[] };
      expect(body.error).toMatch(each.says);
      expect(body.issues).toEqual([]);
      expect(errOut.join("")).toBe("");
    }
  });
});
