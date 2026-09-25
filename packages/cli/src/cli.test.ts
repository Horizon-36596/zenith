import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "@horizon36596/zenith-core";
import { parseAuto, parseRobot, SCHEMA_ID } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "./commands/init.js";
import { runNew } from "./commands/new.js";
import { runValidate } from "./commands/validate.js";
import { loadProject, ProjectError } from "./project.js";

/** A field with nothing in it, so a test project does not depend on the season package. */
const EMPTY_FIELD = {
  $schema: SCHEMA_ID.field,
  formatVersion: 1,
  season: "test",
  name: "Empty test field",
  frame: {
    origin: "centre",
    xAxis: "audienceRight",
    yAxis: "awayFromAudience",
    headingZero: "+x",
    headingPositive: "ccw",
    units: "in",
    canonicalAlliance: "RED",
    mirror: "pointSymmetry",
  },
  sizeIn: { xIn: 144, yIn: 144 },
  obstacles: [],
};

let root = "";
let out: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zenith-cli-"));
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const field = (): void => {
  mkdirSync(join(root, "autos/field"), { recursive: true });
  writeFileSync(
    join(root, "autos/field/biobuzz.field.json"),
    `${JSON.stringify(EMPTY_FIELD, null, 2)}\n`,
    "utf8",
  );
};

describe("zenith init", () => {
  it("writes a project whose files are canonical and parse", () => {
    expect(runInit({ cwd: root })).toBe(0);
    const robotText = readFileSync(join(root, "autos/robot.json"), "utf8");
    expect(robotText.endsWith("\n")).toBe(true);
    expect(canonicalize("robot", parseRobot(JSON.parse(robotText) as unknown))).toBe(robotText);
    field();
    const project = loadProject(root);
    expect(project.link.autosDir).toBe("autos");
    expect(project.robot.footprint.startIn.provenance).toContain("NEEDS MEASUREMENT");
  });

  it("names no command library unless --command-library is given, and says what to set", () => {
    expect(runInit({ cwd: root })).toBe(0);
    expect(loadProject(root).link.deploy?.commandLibrary).toBeUndefined();
    expect(out.join("")).toContain('names no command library yet. Add "commandLibrary": "solverslib" or "commandLibrary": "ivy"');
  });

  it("writes the command library --command-library names", () => {
    for (const commandLibrary of ["solverslib", "ivy"] as const) {
      expect(runInit({ cwd: root, force: true, commandLibrary })).toBe(0);
      expect(loadProject(root).link.deploy?.commandLibrary).toBe(commandLibrary);
    }
    expect(() => runInit({ cwd: root, force: true, commandLibrary: "ftclib" })).toThrow(/solverslib" or "ivy/);
  });

  it("accepts --command-library in any case and writes it lowercase", () => {
    for (const [given, written] of [["Ivy", "ivy"], ["SOLVERSLIB", "solverslib"], ["SolversLib", "solverslib"]] as const) {
      expect(runInit({ cwd: root, force: true, commandLibrary: given })).toBe(0);
      expect(loadProject(root).link.deploy?.commandLibrary).toBe(written);
      expect(readFileSync(join(root, "zenith.json"), "utf8")).toContain(`"commandLibrary": "${written}"`);
    }
    expect(() => runInit({ cwd: root, force: true, commandLibrary: "FTCLib" })).toThrow(/not "FTCLib"/);
  });

  it("keeps files that are already there unless --force is given", () => {
    runInit({ cwd: root });
    writeFileSync(join(root, "autos/robot.json"), "{}", "utf8");
    runInit({ cwd: root });
    expect(readFileSync(join(root, "autos/robot.json"), "utf8")).toBe("{}");
    runInit({ cwd: root, force: true });
    expect(readFileSync(join(root, "autos/robot.json"), "utf8")).not.toBe("{}");
  });
});

describe("zenith new", () => {
  it("writes a canonical skeleton that validates", () => {
    runInit({ cwd: root });
    field();
    expect(runNew("demo", { cwd: root })).toBe(0);
    const text = readFileSync(join(root, "autos/demo.auto.json"), "utf8");
    expect(canonicalize("auto", parseAuto(JSON.parse(text) as unknown))).toBe(text);
    expect(runValidate(["autos/demo.auto.json"], { cwd: root })).toBe(0);
    expect(out.join("")).toContain("0 errors");
  });

  it("writes a skeleton that validates with 0 errors on the season's own field, for either alliance", () => {
    // No empty-field override here: the field is the BIOBUZZ file init copies out of the season
    // package, so its start rules (touching a wall, own half, not in the loading zone, not touching
    // a flower) are in force.
    runInit({ cwd: root });
    const copied = readFileSync(join(root, "autos/field/biobuzz.field.json"), "utf8");
    expect(JSON.parse(copied) as { startRules?: unknown }).toHaveProperty("startRules");
    for (const alliance of ["RED", "BLUE"]) {
      const name = `fresh-${alliance.toLowerCase()}`;
      expect(runNew(name, { cwd: root, alliance })).toBe(0);
      out = [];
      expect(runValidate([`autos/${name}.auto.json`], { cwd: root, json: true })).toBe(0);
      const parsed = JSON.parse(out.join("")) as { errors: number; files: { findings: { code: string }[] }[] };
      expect(parsed.errors, alliance).toBe(0);
      expect(parsed.files[0]?.findings.map((finding) => finding.code), alliance).not.toContain("START_ILLEGAL");
    }
    // A file's poses are in its own alliance's frame, so the BLUE skeleton is the RED one mirrored
    // onto BLUE's half by the field's point symmetry, not the RED numbers under a BLUE label.
    const startOf = (name: string): unknown =>
      (JSON.parse(readFileSync(join(root, `autos/${name}.auto.json`), "utf8")) as { start: { pose: unknown } }).start.pose;
    expect(startOf("fresh-red")).toMatchObject({ xIn: -12, yIn: -63, headingRad: 1.5708 });
    expect(startOf("fresh-blue")).toMatchObject({ xIn: 12, yIn: 63, headingRad: -1.5708 });
  });

  it("refuses to overwrite an auto without --force", () => {
    runInit({ cwd: root });
    field();
    runNew("demo", { cwd: root });
    expect(() => runNew("demo", { cwd: root })).toThrow(ProjectError);
    expect(runNew("demo", { cwd: root, force: true })).toBe(0);
  });
});

describe("zenith validate", () => {
  it("exits 1 and names the step when a check fails", () => {
    runInit({ cwd: root });
    field();
    runNew("demo", { cwd: root });
    const auto = JSON.parse(readFileSync(join(root, "autos/demo.auto.json"), "utf8")) as {
      steps: { segments: { to: { yIn: number } }[] }[];
    };
    // Drive off the north wall: 144 in from the middle of the field is outside it.
    (auto.steps[0] as { segments: { to: { yIn: number } }[] }).segments[0]!.to.yIn = 144;
    writeFileSync(join(root, "autos/demo.auto.json"), JSON.stringify(auto), "utf8");

    expect(runValidate(["autos/demo.auto.json"], { cwd: root })).toBe(1);
    expect(out.join("")).toContain("PERIMETER");
  });

  it("prints JSON an agent can read", () => {
    runInit({ cwd: root });
    field();
    runNew("demo", { cwd: root });
    out = [];
    expect(runValidate(["autos/demo.auto.json"], { cwd: root, json: true })).toBe(0);
    const parsed = JSON.parse(out.join("")) as { errors: number; files: { path: string }[] };
    expect(parsed.errors).toBe(0);
    expect(parsed.files[0]?.path).toBe("autos/demo.auto.json");
  });

  it("reports a schema error as a SCHEMA finding rather than crashing", () => {
    runInit({ cwd: root });
    field();
    writeFileSync(join(root, "autos/broken.auto.json"), '{ "formatVersion": 1 }', "utf8");
    expect(runValidate(["autos/broken.auto.json"], { cwd: root })).toBe(1);
    expect(out.join("")).toContain("SCHEMA");
  });

  it("explains itself when there is no project", () => {
    expect(() => runValidate(["nothing.auto.json"], { cwd: root })).toThrow(/zenith init/);
  });
});
