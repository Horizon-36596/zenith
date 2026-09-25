import { parseAuto, parseField, parseRobot, parseWaypoints, SCHEMA_ID, type PathStep } from "@horizon36596/zenith-schema";
import { plan as corePlan, resolve } from "@horizon36596/zenith-core";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateAutoJava, pascalCase } from "./javaCodegen.js";
import { TEST_FIELD, TEST_ROBOT, TEST_WAYPOINTS } from "./testSupport.js";

const robot = parseRobot(TEST_ROBOT);
const field = parseField(TEST_FIELD);
const waypoints = parseWaypoints(TEST_WAYPOINTS);

const auto = parseAuto({
  $schema: SCHEMA_ID.auto,
  formatVersion: 1,
  name: "sample",
  title: "Sample Auto",
  alliance: "RED",
  start: { pose: { ref: "start" } },
  steps: [
    {
      id: "toShoot",
      kind: "path",
      timeoutS: 3,
      segments: [{ kind: "line", from: { ref: "start" }, to: { ref: "shoot" } }],
      heading: { mode: "tangentReversed" },
      speedFraction: 0.8,
      markers: [{ at: { t: 0.6 }, command: { name: "setIntake", args: { state: "IN" } } }],
      endCondition: { condition: "hopperFull" },
    },
    { id: "volley", kind: "command", name: "shootAll", args: { count: 3 }, timeoutS: 4 },
    { id: "settle", kind: "wait", seconds: 0.5 },
    {
      id: "park",
      kind: "parallel",
      mode: "deadline",
      deadline: "drive",
      steps: [
        {
          id: "drive",
          kind: "path",
          segments: [{ kind: "line", from: { ref: "shoot" }, to: { ref: "start" } }],
          heading: { mode: "tangent" },
        },
        { id: "idle", kind: "command", name: "setIntake", args: { state: "OFF" } },
      ],
    },
  ],
});

function buildPlan() {
  return corePlan(resolve(auto, waypoints), robot, field);
}

describe("pascalCase", () => {
  it("turns a kebab-case auto name into a Java class prefix", () => {
    expect(pascalCase("first-auto")).toBe("FirstAuto");
    expect(pascalCase("close")).toBe("Close");
    expect(pascalCase("auto_1")).toBe("Auto1");
  });
});

describe("generateAutoJava", () => {
  it("is deterministic: the same plan and options always produce the same text", () => {
    const options = { packageName: "org.example.teamcode.opmode.Auto", shaHex: "deadbeef", sourcePath: "autos/sample.auto.json", commandLibrary: "solverslib" as const };
    const first = generateAutoJava(buildPlan(), options);
    const second = generateAutoJava(buildPlan(), options);
    expect(first).toBe(second);
  });

  it("matches the golden output for a path, a command, a wait and a deadline parallel", () => {
    const java = generateAutoJava(buildPlan(), {
      packageName: "org.example.teamcode.opmode.Auto",
      shaHex: "deadbeef",
      sourcePath: "autos/sample.auto.json",
      commandLibrary: "solverslib",
    });
    expect(java).toMatchSnapshot();
  });

  it("names the class <Pascal>Generated and never edits the header's sha", () => {
    const java = generateAutoJava(buildPlan(), {
      packageName: "org.example.teamcode.opmode.Auto",
      shaHex: "cafef00d",
      sourcePath: "autos/sample.auto.json",
      commandLibrary: "solverslib",
    });
    expect(java).toContain("public abstract class SampleGenerated extends AutoFromFile");
    expect(java).toContain("sha cafef00d");
    expect(java).toContain('package org.example.teamcode.opmode.Auto;');
  });

  it("finding 7: the deadline child is composed exactly once, not twice", () => {
    const java = generateAutoJava(buildPlan(), {
      packageName: "org.example.teamcode.opmode.Auto",
      shaHex: "deadbeef",
      sourcePath: "autos/sample.auto.json",
      commandLibrary: "solverslib",
    });
    // The "drive" child of the "park" deadline-mode parallel must be built once (`m_drive`), wrapped
    // once (`member_drive`), and that same object reused as both a member and the deadline — not
    // called twice by two separate deadline-wrapper emissions (review finding 7).
    const buildCalls = java.match(/Command m_drive = /g) ?? [];
    const wrapCalls = java.match(/Command member_drive = step\("drive", m_drive\);/g) ?? [];
    expect(buildCalls.length).toBe(1);
    expect(wrapCalls.length).toBe(1);
    expect(java).toContain("Command deadline = member_drive;");
    expect(java).toContain("members.remove(deadline);");
  });

  it("finding 6: a deadline-mode parallel whose deadline names no direct child fails codegen with a clear, step-naming error instead of silently picking one", () => {
    const badAuto = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "bad-deadline",
      title: "Bad Deadline Auto",
      alliance: "RED",
      start: { pose: { ref: "start" } },
      steps: [
        {
          id: "park",
          kind: "parallel",
          mode: "deadline",
          deadline: "doesNotExist",
          steps: [
            {
              id: "drive",
              kind: "path",
              segments: [{ kind: "line", from: { ref: "shoot" }, to: { ref: "start" } }],
              heading: { mode: "tangent" },
            },
            { id: "idle", kind: "command", name: "setIntake", args: { state: "OFF" } },
          ],
        },
      ],
    });
    const badPlan = corePlan(resolve(badAuto, waypoints), robot, field);
    expect(() =>
      generateAutoJava(badPlan, {
        packageName: "org.example.teamcode.opmode.Auto",
        shaHex: "deadbeef",
        sourcePath: "autos/bad-deadline.auto.json",
        commandLibrary: "solverslib",
      }),
    ).toThrow(/"park"[\s\S]*"doesNotExist"[\s\S]*drive, idle/);
  });
});

describe("codegen for the Ivy runtime (commandLibrary: ivy)", () => {
  const ivyOptions = {
    packageName: "org.example.teamcode.opmode.Auto",
    shaHex: "deadbeef",
    sourcePath: "autos/sample.auto.json",
    commandLibrary: "ivy" as const,
  };

  it("matches the golden output for a path, a command, a wait and a deadline parallel", () => {
    expect(generateAutoJava(buildPlan(), ivyOptions)).toMatchSnapshot();
  });

  it("imports only the Ivy runtime, Ivy and Pedro, never SolversLib", () => {
    const java = generateAutoJava(buildPlan(), ivyOptions);
    expect(java).toContain("import org.horizon36596.zenith.ivy.AutoFromFile;");
    expect(java).toContain("import com.pedropathing.ivy.Command;");
    expect(java).not.toMatch(/solverslib|Pose2d|Poses\./);
    expect(java).toContain("protected Pose startPose() {");
    expect(java).toContain("return new Sequence(");
    expect(java).toContain('drive = Parallel.race(drive, Commands.waitUntil(NamedCommands.condition("hopperFull")));');
  });

  it("writes a branch as Branch.of, and an empty else as an instant command rather than Command.NOOP", () => {
    const withBranch = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 2,
      name: "choose",
      alliance: "RED",
      start: { pose: { ref: "start" } },
      steps: [
        {
          id: "maybe",
          kind: "branch",
          condition: "hopperFull",
          then: [{ id: "shoot", kind: "command", name: "shootAll", args: { count: 3 } }],
          else: [],
        },
        {
          id: "waitFull",
          kind: "wait",
          until: "hopperFull",
        },
      ],
    });
    const java = generateAutoJava(corePlan(resolve(withBranch, waypoints), robot, field), {
      ...ivyOptions,
      sourcePath: "autos/choose.auto.json",
    });
    expect(java).toContain('return Branch.of(NamedCommands.condition("hopperFull"), thenBranch, Commands.instant(() -> { }));');
    expect(java).toContain('return Commands.waitUntil(NamedCommands.condition("hopperFull"));');
    expect(java).not.toContain("NOOP");
  });

  it("is the SolversLib form when commandLibrary is solverslib", () => {
    const base = { packageName: "org.example.teamcode.opmode.Auto", shaHex: "deadbeef", sourcePath: "autos/sample.auto.json" };
    const java = generateAutoJava(buildPlan(), { ...base, commandLibrary: "solverslib" });
    expect(java).toContain("import org.horizon36596.zenith.solverslib.AutoFromFile;");
    expect(java).not.toContain("org.horizon36596.zenith.ivy");
  });
});

describe("codegen for a sequence step (format version 2)", () => {
  it("emits a SequentialCommandGroup of its members, each wrapped in step()", () => {
    const withSequence = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 2,
      name: "sweep-demo",
      alliance: "RED",
      start: { pose: { ref: "start" } },
      steps: [
        {
          id: "sweep",
          kind: "parallel",
          mode: "deadline",
          deadline: "drive",
          steps: [
            {
              id: "drive",
              kind: "path",
              segments: [{ kind: "line", from: "current", to: { ref: "shoot" } }],
              heading: { mode: "tangent" },
            },
            {
              id: "intakeCycle",
              kind: "sequence",
              steps: [
                { id: "on", kind: "command", name: "setIntake", args: { state: "IN" } },
                { id: "hold", kind: "wait", seconds: 0.75 },
                { id: "off", kind: "command", name: "setIntake", args: { state: "OFF" } },
              ],
            },
          ],
        },
      ],
    });
    const java = generateAutoJava(corePlan(resolve(withSequence, waypoints), robot, field), {
      packageName: "org.firstinspires.ftc.teamcode.opmode.Auto",
      sourcePath: "autos/sweep-demo.auto.json",
      commandLibrary: "solverslib",
      shaHex: "0000000",
    });
    expect(java).toMatch(
      /return new SequentialCommandGroup\(step\("on", \w+\(\)\), step\("hold", \w+\(\)\), step\("off", \w+\(\)\)\);/,
    );
    expect(java).toContain('Command member_intakeCycle = step("intakeCycle", m_intakeCycle);');
    expect(java).toContain("return Parallel.deadline(deadline, members.toArray(new Command[0]));");
  });
});

/** The starter example's first auto, the one the getting-started guide walks through. */
const starter = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const readStarter = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));

describe.skipIf(!existsSync(`${starter}zenith.json`))("codegen for the starter's first-auto", () => {
  it("matches the golden output", () => {
    const starterPlan = corePlan(
      resolve(parseAuto(readStarter("autos/first-auto.auto.json")), parseWaypoints(readStarter("autos/waypoints.json"))),
      parseRobot(readStarter("autos/robot.json")),
      parseField(readStarter("autos/field/biobuzz.field.json")),
    );
    const java = generateAutoJava(starterPlan, {
      packageName: "org.firstinspires.ftc.teamcode.zenith",
      shaHex: "deadbeef",
      sourcePath: "autos/first-auto.auto.json",
      commandLibrary: "solverslib",
    });
    expect(java).toContain("public abstract class FirstAutoGenerated extends AutoFromFile");
    expect(java).toMatchSnapshot();
  });
});

describe("generateAutoJava: a piecewise heading", () => {
  it("clips the ranges to each segment and emits Pedro's piecewise interpolator", () => {
    const piecewise = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 3,
      name: "ranges",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
      steps: [
        {
          id: "go",
          kind: "path",
          segments: [
            { kind: "line", from: { xIn: 0, yIn: 0 }, to: { xIn: 24, yIn: 0 } },
            { kind: "line", from: { xIn: 24, yIn: 0 }, to: { xIn: 48, yIn: 0 } },
          ],
          heading: {
            mode: "piecewise",
            ranges: [
              { startT: 0, endT: 0.25, heading: { mode: "constant", headingRad: 0 } },
              { startT: 0.25, endT: 1, heading: { mode: "linear", fromRad: 0, toRad: 1.5 } },
            ],
          },
        },
      ],
    });
    const java = generateAutoJava(corePlan(resolve(piecewise, waypoints), robot, field), {
      packageName: "org.example",
      shaHex: "deadbeef",
      sourcePath: "autos/ranges.auto.json",
      commandLibrary: "solverslib",
    });
    const interpolator = "com.pedropathing.paths.interpolator.Interpolator";
    // The first segment is t 0 to 0.5: the constant range to its own t 0.5, then the linear range.
    expect(java).toContain(
      `Path seg0 = Paths.line(`,
    );
    expect(java).toContain(
      `.heading(${interpolator}.piecewise().until(0.5, ${interpolator}.constant(headingRad(0.0))).until(1.0, (curve, t) -> headingRad(0.0) + turnRad(0.5 * Math.min(1, Math.max(0, (t - 0.5) / 0.5)))))`,
    );
    // The second segment is all linear range, from 0.5 rad to 1.5 rad.
    expect(java).toContain(
      `.heading(${interpolator}.piecewise().until(1.0, (curve, t) -> headingRad(0.0) + turnRad(0.5 + 1.0 * Math.min(1, Math.max(0, (t - 0.0) / 1.0)))))`,
    );
  });
});
describe("generateAutoJava: a path from \"current\"", () => {
  const fromCurrent = (markerAt: { t: number }) =>
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 3,
      name: "onward",
      alliance: "RED",
      start: { pose: { ref: "start" } },
      steps: [
        {
          id: "toShoot",
          kind: "path",
          segments: [{ kind: "line", from: { ref: "start" }, to: { ref: "shoot" } }],
          heading: { mode: "tangent" },
        },
        {
          id: "onward",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { ref: "start" } }],
          heading: { mode: "tangent" },
          markers: [{ at: markerAt, command: { name: "setIntake", args: { state: "IN" } } }],
        },
      ],
    });
  const options = { packageName: "org.example", shaHex: "deadbeef", sourcePath: "autos/onward.auto.json" };
  const generate = (markerAt: { t: number }, commandLibrary: "solverslib" | "ivy" = "solverslib") =>
    generateAutoJava(corePlan(resolve(fromCurrent(markerAt), waypoints), robot, field), { ...options, commandLibrary });

  it("defers it with DeferredPath, as the runtime does, and builds it from the live pose", () => {
    const java = generate({ t: 0 });
    expect(java).toContain("import org.horizon36596.zenith.solverslib.DeferredPath;");
    expect(java).toContain(
      'return DeferredPath.of("onward", this, from -> stepOnwardFrom(from), NamedCommands.build("setIntake", Args.of("state", "IN"), this));',
    );
    expect(java).toContain("private Command stepOnwardFrom(Pose2d from) {");
    expect(java).toContain("Path seg0 = Paths.line(Poses.toPedro(from), ");
    expect(java).not.toContain("/* current */");
    // The build method follows the step's own, so the class reads top to bottom.
    expect(java.indexOf("private Command stepOnward()")).toBeLessThan(java.indexOf("private Command stepOnwardFrom("));
    expect(java).not.toContain("the runtime measures the live one");
  });

  it("is the Ivy runtime's DeferredPath on Ivy, taking a Pedro pose", () => {
    const java = generate({ t: 0 }, "ivy");
    expect(java).toContain("import org.horizon36596.zenith.ivy.DeferredPath;");
    expect(java).toContain("private Command stepOnwardFrom(Pose from) {");
    expect(java).toContain("Path seg0 = Paths.line(from, ");
  });

  it("says so when a number in it comes from the planned length", () => {
    expect(generate({ t: 0.5 })).toContain(
      "// The lengths, marker distances and heading splits below are the planned path's; the runtime measures the live one.",
    );
  });

  it("imports DeferredPath only when some step needs it", () => {
    for (const commandLibrary of ["solverslib", "ivy"] as const) {
      expect(generateAutoJava(buildPlan(), { ...options, commandLibrary })).not.toContain("DeferredPath");
    }
  });
});

describe("generateAutoJava: a linear heading over two segments", () => {
  it("gives each segment its arc-length share of the sweep, as the runtime does", () => {
    const sweep = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 3,
      name: "sweep",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
      steps: [
        {
          id: "go",
          kind: "path",
          segments: [
            { kind: "line", from: { xIn: 0, yIn: 0 }, to: { xIn: 24, yIn: 0 } },
            { kind: "line", from: { xIn: 24, yIn: 0 }, to: { xIn: 48, yIn: 0 } },
          ],
          heading: { mode: "linear", fromRad: 0, toRad: 1 },
        },
      ],
    });
    const java = generateAutoJava(corePlan(resolve(sweep, waypoints), robot, field), {
      packageName: "org.example",
      shaHex: "deadbeef",
      sourcePath: "autos/sweep.auto.json",
      commandLibrary: "solverslib",
    });
    // Each share is the file's start plus a turn, so the running alliance's frame can mirror both.
    expect(java).toContain(".linear(headingRad(0.0), headingRad(0.0) + turnRad(0.5));");
    expect(java).toContain(".linear(headingRad(0.0) + turnRad(0.5), headingRad(0.0) + turnRad(1.0));");
  });
});

describe("generateAutoJava: headings in the running alliance's frame", () => {
  const facing = (heading: PathStep["heading"]) =>
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 3,
      name: "facing",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
      steps: [
        {
          id: "go",
          kind: "path",
          segments: [{ kind: "line", from: { xIn: 0, yIn: 0 }, to: { xIn: 24, yIn: 0 } }],
          heading,
        },
      ],
    });
  const generate = (heading: PathStep["heading"], commandLibrary: "solverslib" | "ivy") =>
    generateAutoJava(corePlan(resolve(facing(heading), waypoints), robot, field), {
      packageName: "org.example",
      shaHex: "deadbeef",
      sourcePath: "autos/facing.auto.json",
      commandLibrary,
    });

  it("mirrors a constant heading through headingRad, as the runtime mirrors it", () => {
    expect(generate({ mode: "constant", headingRad: 1.2 }, "solverslib")).toContain(".constant(headingRad(1.2));");
  });

  it("mirrors a facePoint point through alliance, like every other pose", () => {
    expect(generate({ mode: "facePoint", xIn: 30, yIn: -30 }, "solverslib")).toContain(
      ".facingPoint(Poses.toPedro(alliance(pose(30.0, -30.0, 0.0))));",
    );
    expect(generate({ mode: "facePoint", xIn: 30, yIn: -30 }, "ivy")).toContain(
      ".facingPoint(alliance(pose(30.0, -30.0, 0.0)));",
    );
  });
});

describe("generateAutoJava: method names", () => {
  it("never writes two methods with one name when a step id ends in WithTimeout", () => {
    const clash = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 3,
      name: "clash",
      alliance: "RED",
      start: { pose: { ref: "start" } },
      steps: [
        { id: "a", kind: "wait", seconds: 1, timeoutS: 2 },
        { id: "aWithTimeout", kind: "wait", seconds: 1 },
      ],
    });
    const java = generateAutoJava(corePlan(resolve(clash, waypoints), robot, field), {
      packageName: "org.example",
      shaHex: "deadbeef",
      sourcePath: "autos/clash.auto.json",
      commandLibrary: "solverslib",
    });
    const names = [...java.matchAll(/private Command (\w+)\(\)/g)].map((match) => match[1]);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["stepA", "stepAWithTimeout", "stepAWithTimeout2"]));
  });
});
