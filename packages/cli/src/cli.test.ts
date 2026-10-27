import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "@horizon36596/zenith-core";
import { parseAuto, parseRobot, SCHEMA_ID } from "@horizon36596/zenith-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDeploy } from "./commands/deploy.js";
import { runInit } from "./commands/init.js";
import { runNew } from "./commands/new.js";
import { runValidate } from "./commands/validate.js";
import { main } from "./index.js";
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

  it("writes a codegen section, so zenith deploy writes the OpModes (issue #156)", () => {
    expect(runInit({ cwd: root, commandLibrary: "solverslib" })).toBe(0);
    expect(loadProject(root).link.codegen).toEqual({
      package: "org.firstinspires.ftc.teamcode.zenith",
      dir: "TeamCode/src/main/java",
    });
  });

  it("writes the robot class --robot-class names, and refuses one that is not a Java class name", () => {
    expect(runInit({ cwd: root, commandLibrary: "ivy", robotClass: "org.firstinspires.ftc.teamcode.MyRobot" })).toBe(0);
    expect(loadProject(root).link.deploy?.robotClass).toBe("org.firstinspires.ftc.teamcode.MyRobot");
    expect(out.join("")).not.toContain("deploy.robotClass");
    expect(() => runInit({ cwd: root, force: true, robotClass: "my robot" })).toThrow(
      /--robot-class must be a fully qualified Java class name/,
    );
  });

  it("ends with a line saying to set deploy.robotClass when no robot class is given", () => {
    expect(runInit({ cwd: root, commandLibrary: "solverslib" })).toBe(0);
    expect(loadProject(root).link.deploy?.robotClass).toBeUndefined();
    const lines = out.join("").trimEnd().split("\n");
    expect(lines.at(-1)).toMatch(/"deploy\.robotClass".*--robot-class/);
  });

  it("prints a class that implements ZenithRobot as a suggestion, and never writes it", () => {
    const java = join(root, "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/robot");
    mkdirSync(java, { recursive: true });
    writeFileSync(
      join(java, "HiveBot.java"),
      [
        "package org.firstinspires.ftc.teamcode.robot;",
        "",
        "import org.horizon36596.zenith.solverslib.ZenithRobot;",
        "",
        "/** Not public class Fake implements ZenithRobot, which a comment can say. */",
        "public final class HiveBot implements ZenithRobot {",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    // Neither of these can be constructed by a generated OpMode, so neither is suggested.
    writeFileSync(
      join(java, "BaseBot.java"),
      "package org.firstinspires.ftc.teamcode.robot;\n\npublic abstract class BaseBot implements ZenithRobot {\n}\n",
      "utf8",
    );
    writeFileSync(
      join(java, "Helpers.java"),
      "package org.firstinspires.ftc.teamcode.robot;\n\nclass Helpers implements ZenithRobot {\n}\n",
      "utf8",
    );

    expect(runInit({ cwd: root, commandLibrary: "solverslib" })).toBe(0);
    const text = out.join("");
    expect(text).toContain("found: org.firstinspires.ftc.teamcode.robot.HiveBot implements ZenithRobot");
    expect(text).toContain('add "robotClass": "org.firstinspires.ftc.teamcode.robot.HiveBot" to its "deploy" section');
    expect(text).not.toContain("BaseBot");
    expect(text).not.toContain("Helpers");
    expect(text).not.toContain("Fake");
    expect(loadProject(root).link.deploy?.robotClass).toBeUndefined();
    expect(readFileSync(join(root, "zenith.json"), "utf8")).not.toContain("HiveBot");

    out = [];
    expect(runInit({ cwd: root, force: true, json: true })).toBe(0);
    const json = JSON.parse(out.join("")) as { robotClass: unknown; robotClassSuggestions: unknown };
    expect(json.robotClass).toBeNull();
    expect(json.robotClassSuggestions).toEqual(["org.firstinspires.ftc.teamcode.robot.HiveBot"]);
  });
});

describe("zenith init, then zenith deploy (issue #156)", () => {
  let err: string[] = [];

  beforeEach(() => {
    err = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it("refuses with the robotClass message, exit 2, until a robot class is set, then writes one OpMode per auto", async () => {
    expect(runInit({ cwd: root, commandLibrary: "solverslib" })).toBe(0);
    expect(runNew("demo", { cwd: root })).toBe(0);
    expect(await main(["node", "zenith", "deploy", "--project", root])).toBe(2);
    expect(err.join("")).toMatch(/has "codegen" but no "deploy\.robotClass"/);
    expect(existsSync(join(root, "TeamCode/src/main/assets/autos"))).toBe(false);

    expect(
      runInit({ cwd: root, force: true, commandLibrary: "solverslib", robotClass: "org.firstinspires.ftc.teamcode.zenith.MyRobot" }),
    ).toBe(0);
    out = [];
    expect(runDeploy({ cwd: root })).toBe(0);
    const stub = readFileSync(
      join(root, "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/zenith/generated/DemoAuto.java"),
      "utf8",
    );
    expect(stub).toContain("return new org.firstinspires.ftc.teamcode.zenith.MyRobot();");
    expect(out.join("")).not.toContain("no OpMode was written");
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

  it("loads a step id written before the step id rule and warns about it, with the rename", () => {
    runInit({ cwd: root });
    field();
    runNew("demo", { cwd: root });
    const auto = JSON.parse(readFileSync(join(root, "autos/demo.auto.json"), "utf8")) as { steps: { id?: string }[] };
    (auto.steps[0] as { id?: string }).id = "drive out";
    writeFileSync(join(root, "autos/demo.auto.json"), JSON.stringify(auto), "utf8");
    out = [];

    // A warning, so the file still validates.
    expect(runValidate(["autos/demo.auto.json"], { cwd: root, json: true })).toBe(0);
    const parsed = JSON.parse(out.join("")) as {
      files: { findings: { code: string; severity: string; message: string; fixes?: { kind: string; params: unknown }[] }[] }[];
    };
    const stepId = parsed.files[0]?.findings.filter((finding) => finding.code === "STEP_ID");
    expect(stepId).toEqual([
      expect.objectContaining({
        severity: "warning",
        message: 'Step id "drive out" has a space. Ids start with a letter and hold only letters, digits, _ and -.',
        fixes: [expect.objectContaining({ kind: "renameStep", params: { newId: "driveOut" } })],
      }),
    ]);
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

describe("usage errors", () => {
  let err: string[];
  beforeEach(() => {
    err = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("exits 2 for an unknown option, a bad flag value and a missing argument, with commander's message", async () => {
    expect(await main(["node", "zenith", "validate", "--bogus"])).toBe(2);
    expect(err.join("")).toMatch(/unknown option '--bogus'/);
    expect(await main(["node", "zenith", "optimize", "a.auto.json", "--budget", "x"])).toBe(2);
    expect(await main(["node", "zenith", "new"])).toBe(2);
    expect(err.join("")).not.toMatch(/^zenith: /m);
  });

  it("exits 0 for --help and --version", async () => {
    expect(await main(["node", "zenith", "--version"])).toBe(0);
    expect(await main(["node", "zenith", "validate", "--help"])).toBe(0);
  });
});
