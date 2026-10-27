/**
 * Issue #159: setting Zenith up in a robot repository that has no zenith.json. What the scan of
 * TeamCode prefills, the five files Set up writes, and the Gradle lines it shows after.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, linkSkeleton, loadAuto, loadField, loadLink, loadRobot, loadWaypoints, robotSkeleton } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { robotClassProblem, SETUP_PATHS, setupFileSet } from "../project/setupFiles";
import { derive } from "../state/derived";
import { gradleLines, planSetup } from "./setupPlan";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const field = loadField(JSON.parse(readFileSync(`${repo}packages/season-biobuzz/field/biobuzz.field.json`, "utf8")));

/** A team's TeamCode as a scan reads it: its robot class and the commands it registers. */
const TEAM_ROBOT = {
  path: "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/robot/TeamRobot.java",
  text: [
    "package org.firstinspires.ftc.teamcode.robot;",
    "",
    "public class TeamRobot implements ZenithRobot {",
    "    @Override public void registerCommands(AutoFromFile opMode) {",
    '        NamedCommands.register("intakeOn", (args, ctx) -> intake.on());',
    '        NamedCommands.register("score", (args, ctx) -> new Score(NamedCommands.argInt(args, "score", "count")));',
    '        NamedCommands.registerCondition("holdingPiece", intake::hasPiece);',
    "    }",
    "}",
    "",
  ].join("\n"),
};

const IVY_IMPORT = {
  path: "TeamCode/src/main/java/org/firstinspires/ftc/teamcode/robot/Wiring.java",
  text: "package org.firstinspires.ftc.teamcode.robot;\n\nimport org.horizon36596.zenith.ivy.NamedCommands;\n",
};

describe("planSetup", () => {
  it("prefills the robot class from the class that implements ZenithRobot, and the commands the code registers", () => {
    const plan = planSetup("team-robot", [TEAM_ROBOT]);
    expect(plan.robotClasses).toEqual(["org.firstinspires.ftc.teamcode.robot.TeamRobot"]);
    expect(plan.robotClass).toBe("org.firstinspires.ftc.teamcode.robot.TeamRobot");
    expect(plan.commands).toEqual(["intakeOn", "score"]);
    expect(plan.conditions).toEqual(["holdingPiece"]);
    expect(plan.filesScanned).toBe(1);
  });

  it("leaves the library unchosen when no import names one, and never picks a default", () => {
    const plan = planSetup("team-robot", [TEAM_ROBOT]);
    expect(plan.library).toBeNull();
    expect(plan.libraryImports).toEqual([]);
  });

  it("prefills the library from an import that names it", () => {
    const plan = planSetup("team-robot", [TEAM_ROBOT, IVY_IMPORT]);
    expect(plan.library).toBe("ivy");
    expect(plan.libraryImports[0]?.at).toEqual({ path: IVY_IMPORT.path, line: 3 });
  });

  it("seeds robot.json's commands from the scan, each estimate NEEDS MEASUREMENT", () => {
    const { robot } = planSetup("team-robot", [TEAM_ROBOT]);
    expect(robot.name).toBe("team-robot");
    expect(robot.commands.map((command) => command.name)).toEqual(["intakeOn", "score"]);
    for (const command of robot.commands) {
      expect(command.estimateS).toBe("unknown");
      expect(command.provenance).toMatch(/estimateS NEEDS MEASUREMENT/);
    }
    expect((robot.conditions ?? []).map((condition) => condition.name)).toEqual(["holdingPiece"]);
    // The rest of the robot is the skeleton zenith init writes, labelled as Set up's.
    const skeleton = loadRobot(JSON.parse(robotSkeleton("team-robot", "the editor's Set up")));
    expect({ ...robot, commands: [], conditions: [] }).toEqual(skeleton);
  });

  it("prefills no robot class when several implement ZenithRobot, and lists them all", () => {
    const other = { path: "TeamCode/src/main/java/a/Other.java", text: "package a;\npublic class Other implements ZenithRobot {}\n" };
    const plan = planSetup("team-robot", [TEAM_ROBOT, other]);
    expect(plan.robotClasses).toEqual(["a.Other", "org.firstinspires.ftc.teamcode.robot.TeamRobot"]);
    expect(plan.robotClass).toBe("");
  });

  it("has nothing to prefill from a folder with no code", () => {
    const plan = planSetup("empty", []);
    expect(plan).toMatchObject({ robotClass: "", library: null, commands: [], conditions: [], filesScanned: 0 });
  });
});

describe("setupFileSet", () => {
  const robot = planSetup("team-robot", [TEAM_ROBOT]).robot;

  it("writes zenith.json, robot.json, waypoints.json, the season's field and one skeleton auto", () => {
    const files = setupFileSet({ commandLibrary: null, robotClass: null, robot, field });
    expect(files.map((file) => file.path)).toEqual([...SETUP_PATHS]);
    expect(SETUP_PATHS).toEqual([
      "zenith.json",
      "autos/robot.json",
      "autos/waypoints.json",
      "autos/field/biobuzz.field.json",
      "autos/first-auto.auto.json",
    ]);
  });

  it("writes each file at the path its zenith.json names", () => {
    const [link] = setupFileSet({ commandLibrary: null, robotClass: null, robot, field });
    const parsed = loadLink(JSON.parse(link?.text ?? ""));
    expect([...SETUP_PATHS]).toEqual(["zenith.json", parsed.robot, parsed.waypoints, parsed.field, `${parsed.autosDir}/first-auto.auto.json`]);
  });

  it("writes a zenith.json with no sim block, and no codegen section without a robot class", () => {
    const [link] = setupFileSet({ commandLibrary: null, robotClass: null, robot, field });
    const parsed = loadLink(JSON.parse(link?.text ?? ""));
    expect(parsed.sim).toBeUndefined();
    expect(parsed.codegen).toBeUndefined();
    expect(parsed.deploy?.commandLibrary).toBeUndefined();
    expect(parsed.deploy?.robotClass).toBeUndefined();
    expect(link?.text).toBe(linkSkeleton({ codegen: false }));
  });

  it("writes the library and robot class chosen, and the codegen section with a robot class", () => {
    const [link] = setupFileSet({ commandLibrary: "solverslib", robotClass: "org.firstinspires.ftc.teamcode.robot.TeamRobot", robot, field });
    const parsed = loadLink(JSON.parse(link?.text ?? ""));
    expect(parsed.deploy).toMatchObject({ commandLibrary: "solverslib", robotClass: "org.firstinspires.ftc.teamcode.robot.TeamRobot" });
    expect(parsed.codegen).toEqual({ package: "org.firstinspires.ftc.teamcode.zenith", dir: "TeamCode/src/main/java" });
    expect(parsed.sim).toBeUndefined();
  });

  it("writes every file in canonical form, each loading with the current schema", () => {
    const files = Object.fromEntries(setupFileSet({ commandLibrary: "ivy", robotClass: "a.B", robot, field }).map((file) => [file.path, file.text]));
    expect(canonicalize("robot", loadRobot(JSON.parse(files["autos/robot.json"] ?? "")))).toBe(files["autos/robot.json"]);
    expect(canonicalize("waypoints", loadWaypoints(JSON.parse(files["autos/waypoints.json"] ?? "")))).toBe(files["autos/waypoints.json"]);
    expect(canonicalize("field", loadField(JSON.parse(files["autos/field/biobuzz.field.json"] ?? "")))).toBe(
      files["autos/field/biobuzz.field.json"],
    );
    expect(files["autos/field/biobuzz.field.json"]).toBe(canonicalize("field", field));
    const auto = loadAuto(JSON.parse(files["autos/first-auto.auto.json"] ?? ""));
    expect(canonicalize("auto", auto)).toBe(files["autos/first-auto.auto.json"]);
    expect(files["autos/robot.json"]).toContain('"name": "intakeOn"');
  });

  it("writes a skeleton auto with no errors on the season's field for the skeleton robot", () => {
    const files = Object.fromEntries(setupFileSet({ commandLibrary: null, robotClass: null, robot, field }).map((file) => [file.path, file.text]));
    const auto = loadAuto(JSON.parse(files["autos/first-auto.auto.json"] ?? ""));
    const waypoints = loadWaypoints(JSON.parse(files["autos/waypoints.json"] ?? ""));
    const errors = derive(auto, robot, field, waypoints).findings.filter((finding) => finding.severity === "error");
    expect(errors).toEqual([]);
  });

  it("refuses a robot class that is not a fully qualified Java class name", () => {
    expect(robotClassProblem("org.firstinspires.ftc.teamcode.robot.TeamRobot")).toBeNull();
    expect(robotClassProblem("TeamRobot")).toBeNull();
    expect(robotClassProblem("org.team.Team Robot")).toMatch(/fully qualified Java class name/);
    expect(robotClassProblem("org..Team")).toMatch(/fully qualified Java class name/);
    expect(() => setupFileSet({ commandLibrary: null, robotClass: "not a class", robot, field })).toThrow(/fully qualified Java class name/);
  });
});

describe("gradleLines", () => {
  it("gives the chosen library's lines with this release's runtime", () => {
    const ivy = gradleLines("ivy", "0.1.1");
    expect(ivy).toContain("implementation 'com.pedropathing.ivy:pedro:1.1.1'");
    expect(ivy).toContain("implementation 'com.github.Horizon-36596:zenith:v0.1.1'");
    expect(ivy).toContain("implementation 'com.pedropathing:core:3.0.0-20260828.185437-17'");
    expect(ivy).not.toContain("solverslib");
    const solvers = gradleLines("solverslib", "0.1.1");
    expect(solvers).toContain("implementation 'org.solverslib:core:0.3.6'");
    expect(solvers).toContain("https://repo.dairy.foundation/releases");
    expect(solvers).not.toContain("ivy");
  });

  it("names no library when none is chosen, and says where to find its line", () => {
    const none = gradleLines(null, "0.1.1");
    expect(none).toContain("implementation 'com.github.Horizon-36596:zenith:v0.1.1'");
    expect(none).not.toContain("ivy:pedro");
    expect(none).not.toContain("solverslib:core");
    expect(none).toMatch(/command library/);
  });
});
