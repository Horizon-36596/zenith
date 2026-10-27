import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, loadRobot } from "@horizon36596/zenith-core";
import { parseRobot, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { starterRobot } from "../testSupport.js";
import { checkCommandRegistry, mergeCommandScan } from "./mergeCommands.js";
import { scanCommands, type SourceFile } from "./scanCommands.js";

const fixtureRoot = fileURLToPath(new URL("../../fixtures/java/", import.meta.url));
const fixture = (dir: string): SourceFile[] =>
  readdirSync(join(fixtureRoot, dir))
    .sort()
    .map((name) => ({ path: `${dir}/${name}`, text: readFileSync(join(fixtureRoot, dir, name), "utf8") }));

/**
 * A BIOBUZZ robot's registry, shaped like the one Horizon keeps for its own robot: the starter
 * robot with these commands and conditions in place of its own.
 */
const biobuzzRobot = (): Robot =>
  loadRobot({
    ...(JSON.parse(JSON.stringify(starterRobot())) as Robot),
    commands: [
      {
        name: "shootAll",
        summary: "Spin up, fire count pollen at the current target, settle.",
        params: {
          count: { type: "integer", min: 1, max: 4 },
          cadence: { type: "enum", values: ["rapid", "precise"], default: "precise" },
        },
        estimateS: "0.6 + count * cadence",
        requires: ["launcher", "turret", "intake"],
        stationary: true,
        ledger: { launches: "count" },
      },
      {
        name: "setIntake",
        summary: "Drive one intake, or both, in a direction.",
        params: {
          side: { type: "enum", values: ["FRONT", "BACK", "BOTH"] },
          state: { type: "enum", values: ["STOP", "FORWARD", "REVERSE"] },
        },
        estimateS: "0",
        requires: ["intake"],
        stationary: false,
      },
      { name: "assumeTipped", summary: "Count the hive as tipped.", estimateS: "0", requires: [], ledger: { tip: "own" } },
      { name: "launcherIdle", estimateS: "0", requires: ["launcher"], stationary: false },
      { name: "relocalize", estimateS: "0", requires: [], stationary: false },
      { name: "cancelAll", estimateS: "0", requires: ["intake", "launcher", "turret"], stationary: false },
    ],
    conditions: [
      { name: "hopperFull", ledger: "full" },
      { name: "hopperEmpty", ledger: "empty" },
      { name: "tipSeen" },
    ],
  });

const withCommands = (robot: Robot, commands: Robot["commands"], conditions?: Robot["conditions"]): Robot => {
  const out: Robot = { ...robot, commands };
  if (conditions === undefined) delete out.conditions;
  else out.conditions = conditions;
  return out;
};

describe("checkCommandRegistry", () => {
  it("finds the BIOBUZZ robot.json and its Java in agreement, with one remark", () => {
    const findings = checkCommandRegistry(biobuzzRobot(), scanCommands(fixture("biobuzz")));
    expect(findings.filter((finding) => finding.severity !== "info")).toEqual([]);
    expect(findings.map((finding) => [finding.severity, finding.name, finding.key])).toEqual([["info", "setIntake", "state"]]);
    expect(findings[0]?.message).toContain('"STOP"');
  });

  it("names every declared command and condition the Java does not register, as errors", () => {
    const findings = checkCommandRegistry(starterRobot(), scanCommands(fixture("readme")));
    const errors = findings.filter((finding) => finding.severity === "error");
    expect(errors.map((finding) => [finding.subject, finding.name])).toEqual([
      ["command", "intakeOff"],
      ["command", "spinUp"],
      ["condition", "hopperFull"],
      ["condition", "hopperEmpty"],
    ]);
    expect(errors[0]?.message).toContain('NamedCommands.register("intakeOff", ...)');
  });

  it("warns when robot.json gives a default to an argument the Java requires", () => {
    const findings = checkCommandRegistry(starterRobot(), scanCommands(fixture("readme")));
    const score = findings.find((finding) => finding.name === "score" && finding.key === "count");
    expect(score?.severity).toBe("warning");
    expect(score?.message).toContain("fails at init");
  });

  it("warns about a declared param the factory never reads, only when the factory was read completely", () => {
    const findings = checkCommandRegistry(starterRobot(), scanCommands(fixture("readme")));
    expect(findings.find((finding) => finding.name === "intakeOn" && finding.key === "state")?.severity).toBe("warning");

    const robot = withCommands(starterRobot(), [{ name: "delegated", estimateS: "0", params: { x: { type: "number" } } }]);
    const tricky = checkCommandRegistry(robot, scanCommands(fixture("tricky")));
    expect(tricky.find((finding) => finding.name === "delegated" && finding.key === "x")).toBeUndefined();
  });

  it("calls an enum value the Java enum lacks an error, since the robot refuses it", () => {
    const robot = biobuzzRobot();
    const setIntake = robot.commands.find((command) => command.name === "setIntake");
    if (setIntake?.params?.state?.type !== "enum") throw new Error("the example changed");
    setIntake.params.state.values = ["STOP", "FORWARD", "REVERSE", "HOLD"];
    const findings = checkCommandRegistry(robot, scanCommands(fixture("biobuzz")));
    const error = findings.find((finding) => finding.severity === "error");
    expect(error?.message).toContain('"HOLD"');
    expect(error?.message).toContain("Intake.MotorState");
  });

  it("calls a required argument robot.json leaves out an error, and an optional one a warning", () => {
    const robot = withCommands(starterRobot(), [
      { name: "driveForward", estimateS: "unknown" },
      { name: "park", estimateS: "unknown" },
    ]);
    const findings = checkCommandRegistry(robot, scanCommands(fixture("tricky")));
    const drive = findings.filter((finding) => finding.name === "driveForward" && finding.subject === "command");
    expect(drive.map((finding) => [finding.severity, finding.key])).toEqual([
      ["error", "distanceIn"],
      ["warning", "speed"],
    ]);
  });

  it("softens a missing registration to a warning while some names could not be read", () => {
    const robot = withCommands(starterRobot(), [{ name: "extraOne", estimateS: "0" }]);
    const findings = checkCommandRegistry(robot, scanCommands(fixture("tricky")));
    const extra = findings.find((finding) => finding.name === "extraOne");
    expect(extra?.severity).toBe("warning");
    expect(extra?.message).toContain("could not be read");
  });

  it("passes the scan's own issues on, after the comparison", () => {
    const findings = checkCommandRegistry(withCommands(starterRobot(), []), scanCommands(fixture("tricky")));
    const scanFindings = findings.filter((finding) => finding.subject === "scan");
    expect(scanFindings.length).toBeGreaterThan(0);
    expect(findings.slice(-scanFindings.length)).toEqual(scanFindings);
  });
});

describe("mergeCommandScan", () => {
  it("changes nothing when robot.json already has everything", () => {
    const robot = biobuzzRobot();
    const merged = mergeCommandScan(robot, scanCommands(fixture("biobuzz")));
    expect(merged.changes).toEqual([]);
    expect(canonicalize("robot", merged.robot)).toBe(canonicalize("robot", robot));
  });

  it("fills an empty registry from the Java, with honest estimates and provenance", () => {
    const empty = withCommands(biobuzzRobot(), [], []);
    const merged = mergeCommandScan(empty, scanCommands(fixture("biobuzz")));
    expect(merged.changes.map((change) => [change.kind, change.name])).toEqual([
      ["addCommand", "assumeTipped"],
      ["addCommand", "cancelAll"],
      ["addCommand", "launcherIdle"],
      ["addCommand", "relocalize"],
      ["addCommand", "setIntake"],
      ["addCommand", "shootAll"],
      ["addCondition", "hopperEmpty"],
      ["addCondition", "hopperFull"],
      ["addCondition", "tipSeen"],
    ]);
    const shootAll = merged.robot.commands.find((command) => command.name === "shootAll");
    expect(shootAll).toEqual({
      name: "shootAll",
      params: { count: { type: "integer" }, cadence: { type: "string", default: "precise" } },
      estimateS: "unknown",
      provenance: "SET FROM biobuzz/BiobuzzRobot.java; estimateS NEEDS MEASUREMENT",
    });
    expect(merged.robot.commands.find((command) => command.name === "setIntake")?.params).toEqual({
      side: { type: "enum", values: ["FRONT", "BACK", "BOTH"] },
      state: { type: "enum", values: ["STOP", "FORWARD", "REVERSE"], default: "STOP" },
    });
    expect(merged.robot.conditions?.[0]).toEqual({ name: "hopperEmpty", provenance: "SET FROM biobuzz/BiobuzzRobot.java" });
    // Every estimate is "unknown": no number is invented.
    expect(merged.robot.commands.every((command) => command.estimateS === "unknown")).toBe(true);
  });

  it("writes a file that validates, is canonical, and does not change when merged again", () => {
    const empty = withCommands(biobuzzRobot(), [], []);
    const scan = scanCommands(fixture("biobuzz"));
    const merged = mergeCommandScan(empty, scan);
    const text = canonicalize("robot", parseRobot(merged.robot));
    expect(canonicalize("robot", parseRobot(JSON.parse(text)))).toBe(text);
    const again = mergeCommandScan(loadRobot(JSON.parse(text)), scan);
    expect(again.changes).toEqual([]);
    expect(canonicalize("robot", again.robot)).toBe(text);
  });

  it("adds a missing param to an existing command and keeps everything a person wrote", () => {
    const robot = biobuzzRobot();
    const shootAll = robot.commands.find((command) => command.name === "shootAll");
    if (shootAll?.params === undefined) throw new Error("the example changed");
    delete shootAll.params.cadence;
    const before = JSON.parse(JSON.stringify(shootAll)) as typeof shootAll;
    const merged = mergeCommandScan(robot, scanCommands(fixture("biobuzz")));
    expect(merged.changes).toEqual([
      {
        kind: "addParam",
        name: "shootAll",
        key: "cadence",
        message: 'Add the optional string argument shootAll.cadence, default "precise" (biobuzz/BiobuzzRobot.java:35).',
      },
    ]);
    const after = merged.robot.commands.find((command) => command.name === "shootAll");
    expect(after).toEqual({
      ...before,
      params: { ...before.params, cadence: { type: "string", default: "precise", provenance: "SET FROM biobuzz/BiobuzzRobot.java" } },
    });
    // The input is not changed.
    expect(shootAll.params.cadence).toBeUndefined();
  });

  it("never removes an entry the Java does not register; it reports it instead", () => {
    const merged = mergeCommandScan(starterRobot(), scanCommands(fixture("readme")));
    expect(merged.robot.commands.map((command) => command.name)).toEqual(["intakeOn", "intakeOff", "spinUp", "score"]);
    expect(merged.changes).toEqual([]);
    expect(merged.findings.filter((finding) => finding.severity === "error").map((finding) => finding.name)).toEqual([
      "intakeOff",
      "spinUp",
      "hopperFull",
      "hopperEmpty",
    ]);
  });

  it("leaves out an enum argument whose constants it could not find, and says so", () => {
    const scan = scanCommands([{ path: "Robot.java", text: fixture("biobuzz").find((file) => file.path.endsWith("BiobuzzRobot.java"))?.text ?? "" }]);
    const merged = mergeCommandScan(withCommands(biobuzzRobot(), [], []), scan);
    expect(merged.robot.commands.find((command) => command.name === "setIntake")?.params).toBeUndefined();
    const findings = merged.findings.filter((finding) => finding.name === "setIntake");
    expect(findings.map((finding) => [finding.subject, finding.severity, finding.key])).toEqual([
      ["command", "warning", "side"],
      ["command", "warning", "state"],
      ["scan", "warning", undefined],
      ["scan", "warning", undefined],
    ]);
    expect(findings[2]?.message).toContain("not declared in the scanned sources");
  });
});
