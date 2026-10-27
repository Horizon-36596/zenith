import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../canonicalize.js";
import { sha256Hex } from "../hash.js";
import { loadAuto, loadField, loadRobot, loadWaypoints } from "../load.js";
import { plan } from "../plan.js";
import { resolve } from "../resolve.js";
import { makeSimCurve } from "../sim/curves.js";
import { piecewiseSegmentPieces } from "../sim/pedroPath.js";
import type { PlanStep } from "../types.js";
import {
  codegenBlockedMessage,
  generateAutoJava,
  generateAutoJavaWithMap,
  type JavaCodegenOptions,
} from "./javaCodegen.js";

/**
 * The generator in core is the one `zenith codegen` writes with (its goldens live beside the CLI)
 * and the one the editor's Code tab runs in the browser. These tests cover what the editor adds:
 * the map from each step to the lines it wrote.
 */
const starter = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (path: string): unknown => JSON.parse(readFileSync(`${starter}${path}`, "utf8"));

const robot = loadRobot(read("autos/robot.json"));
const field = loadField(read("autos/field/biobuzz.field.json"));
const waypoints = loadWaypoints(read("autos/waypoints.json"));

const options: JavaCodegenOptions = {
  packageName: "org.example.teamcode",
  shaHex: "0123abcd",
  sourcePath: "autos/mixed.auto.json",
  commandLibrary: "solverslib",
};

/** Every kind of step, a timeout, a path from "current" and a group inside a group. */
const mixed = loadAuto({
  $schema: "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
  formatVersion: 4,
  name: "mixed",
  alliance: "RED",
  start: { pose: { ref: "start" } },
  steps: [
    {
      id: "driveOut",
      kind: "path",
      timeoutS: 3,
      segments: [{ kind: "line", from: { ref: "start" }, to: { ref: "scoreSouth" } }],
      heading: { mode: "tangent" },
      markers: [{ at: { t: 0.5 }, command: { name: "score", args: { count: 1 } } }],
    },
    { id: "scorePreload", kind: "command", name: "score", args: { count: 4 } },
    {
      id: "together",
      kind: "parallel",
      mode: "all",
      steps: [
        { id: "pause", kind: "wait", seconds: 0.25 },
        {
          id: "inner",
          kind: "sequence",
          steps: [{ id: "again", kind: "command", name: "score", args: { count: 1 } }],
        },
      ],
    },
    {
      id: "maybe",
      kind: "branch",
      condition: "hasPollen",
      then: [{ id: "yes", kind: "wait", seconds: 0.1 }],
      else: [{ id: "no", kind: "wait", seconds: 0.2 }],
    },
    {
      id: "park",
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { ref: "park" } }],
      heading: { mode: "tangent" },
    },
  ],
});

const planned = plan(resolve(mixed, waypoints, robot), robot, field);

const allIds = (steps: readonly PlanStep[]): string[] =>
  steps.flatMap((step) => [step.id, ...allIds(step.children ?? [])]);

describe("generateAutoJavaWithMap", () => {
  for (const commandLibrary of ["solverslib", "ivy"] as const) {
    describe(`for ${commandLibrary}`, () => {
      const given = { ...options, commandLibrary };
      const { text, stepLines } = generateAutoJavaWithMap(planned, given);
      const lines = text.split("\n");

      it("returns exactly the text generateAutoJava writes", () => {
        expect(text).toBe(generateAutoJava(planned, given));
      });

      it("maps every step, children included, to at least one range", () => {
        const mapped = new Set(stepLines.map((range) => range.stepId));
        for (const id of allIds(planned.steps)) expect(mapped.has(id), id).toBe(true);
      });

      it("lists ranges in line order, inside the text, never overlapping", () => {
        let previousEnd = 0;
        for (const range of stepLines) {
          expect(range.startLine).toBeGreaterThan(previousEnd);
          expect(range.endLine).toBeGreaterThanOrEqual(range.startLine);
          expect(range.endLine).toBeLessThanOrEqual(lines.length);
          previousEnd = range.endLine;
        }
      });

      it("points each top-level step at its call in buildRoutine()", () => {
        const top = stepLines.slice(0, planned.steps.length);
        top.forEach((range, index) => {
          const id = planned.steps[index]?.id ?? "";
          expect(range.stepId).toBe(id);
          expect(range.startLine).toBe(range.endLine);
          expect(lines[range.startLine - 1]).toContain(`step("${id}", `);
        });
      });

      it("points every other range at a whole private method", () => {
        for (const range of stepLines.slice(planned.steps.length)) {
          expect(lines[range.startLine - 1]).toMatch(/^ {4}private Command step\w+\(/);
          expect(lines[range.endLine - 1]).toBe("    }");
        }
      });

      it("gives a step with a timeout its wrapper, and a path from current its builder", () => {
        const of = (id: string): string[] =>
          stepLines
            .filter((range) => range.stepId === id && range.startLine !== range.endLine)
            .map((range) => lines[range.startLine - 1] ?? "");
        expect(of("driveOut")).toEqual([
          "    private Command stepDriveOut() {",
          "    private Command stepDriveOutWithTimeout() {",
        ]);
        expect(of("park")[1]).toMatch(/private Command stepParkFrom\(/);
      });
    });
  }
});

/** Plans a one-off auto against the starter's robot, field and waypoints. */
const planOf = (steps: unknown[]): ReturnType<typeof plan> =>
  plan(
    resolve(
      loadAuto({
        $schema: "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
        formatVersion: 4,
        name: "probe",
        alliance: "RED",
        start: { pose: { ref: "start" } },
        steps,
      }),
      waypoints,
      robot,
    ),
    robot,
    field,
  );

/** The lines of one private method, from its signature to its closing brace. */
const methodBody = (text: string, signature: string): string[] => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`    private Command ${signature}(`));
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const end = lines.indexOf("    }", start);
  return lines.slice(start, end + 1);
};

describe("the exported form (issue #535)", () => {
  const exported = { robotClass: "org.example.teamcode.MyRobot", preselectTeleOp: "Drive" };
  for (const commandLibrary of ["solverslib", "ivy"] as const) {
    describe(`for ${commandLibrary}`, () => {
      const reference = generateAutoJavaWithMap(planned, { ...options, commandLibrary });
      const { text, stepLines } = generateAutoJavaWithMap(planned, { ...options, commandLibrary, exported });
      const lines = text.split("\n");
      const routineOn = (java: string): string => java.slice(java.indexOf("    protected Command buildRoutine() {"));

      it("builds exactly the reference class's routine, from buildRoutine() to the end", () => {
        expect(routineOn(text)).toBe(routineOn(reference.text));
      });

      it("is a concrete @Autonomous OpMode that constructs the robot zenith.json names", () => {
        expect(text).toContain('@Autonomous(name = "mixed (exported)", group = "Exported", preselectTeleOp = "Drive")');
        expect(text).toContain("public class MixedExported extends AutoFromFile {");
        expect(text).toContain("        return new org.example.teamcode.MyRobot();");
        expect(text).toContain('        return "mixed";');
        expect(text).not.toContain("abstract");
        expect(text).not.toContain("Do not edit");
        expect(text).toContain("<b>Not recommended.</b>");
      });

      it("reads no file: loadSpec() returns the alliance, start pose and default speed in code", () => {
        const spec = commandLibrary === "solverslib" ? "AutoSpec" : "AutoFile";
        const start = planned.startPose;
        expect(text).toContain(`    protected ${spec} loadSpec() {`);
        expect(text).toContain(`        return ${spec}.inCode("mixed", "mixed", "RED",`);
        // Java double literals, as every number in the class is written.
        const java = (value: number): string => {
          const text = String(Number(value.toFixed(4)));
          return text.includes(".") ? text : `${text}.0`;
        };
        const speed = robot.kinematics.defaultPathSpeedFraction.value;
        expect(text).toContain(
          `${java(start.xIn)}, ${java(start.yIn)}, ${java(start.headingRad)}, ${java(speed)});`,
        );
        // startPose() is left to AutoFromFile, which mirrors the in-code start like any other pose.
        expect(text).not.toContain("startPose()");
      });

      it("imports what it names, Zenith's classes in a group of their own", () => {
        const imports = lines.filter((line) => line.startsWith("import "));
        expect(imports).toContain("import com.qualcomm.robotcore.eventloop.opmode.Autonomous;");
        expect(imports).toContain(`import org.horizon36596.zenith.${commandLibrary}.ZenithRobot;`);
        const zenithAt = lines.findIndex((line) => line.startsWith("import org.horizon36596."));
        expect(lines[zenithAt - 1]).toBe("");
        expect(lines.slice(zenithAt).filter((line) => line.startsWith("import com.")).length).toBe(0);
      });

      it("maps each top-level step to its call in buildRoutine(), as the reference does", () => {
        planned.steps.forEach((step, index) => {
          const range = stepLines[index];
          expect(range?.stepId).toBe(step.id);
          expect(lines[(range?.startLine ?? 0) - 1]).toContain(`step("${step.id}", `);
        });
        expect(stepLines.length).toBe(reference.stepLines.length);
      });
    });
  }

  it("names the alliance a BLUE file was written for", () => {
    const blue = plan(resolve({ ...mixed, alliance: "BLUE" }, waypoints, robot), robot, field);
    const text = generateAutoJava(blue, { ...options, exported: { robotClass: "a.B" } });
    expect(text).toContain('AutoSpec.inCode("mixed", "mixed", "BLUE",');
    expect(text).toContain('@Autonomous(name = "mixed (exported)", group = "Exported")');
  });
});

describe("a turn on the spot", () => {
  // Two steps of no length, as AutoBuilder builds them: TurnInPlace, never followPath (decision D10).
  const turns = planOf([
    {
      id: "faceEast",
      kind: "path",
      segments: [{ kind: "line", from: { ref: "start" }, to: { ref: "start" } }],
      heading: { mode: "constant", headingRad: 0 },
      markers: [{ at: { t: 0 }, command: { name: "score", args: { count: 1 } } }],
    },
    {
      id: "faceNorth",
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { ref: "start" } }],
      heading: { mode: "constant", headingRad: 1.5708 },
      endCondition: { condition: "hasPollen" },
    },
  ]);

  for (const commandLibrary of ["solverslib", "ivy"] as const) {
    describe(`for ${commandLibrary}`, () => {
      const text = generateAutoJava(turns, { ...options, commandLibrary });

      it("holds the end pose with TurnInPlace instead of following a path", () => {
        const body = methodBody(text, "stepFaceEast").join("\n");
        expect(body).not.toContain("followPath(");
        expect(body).not.toContain("Paths.");
        expect(body).toContain("alliance(pose(-13.0, -63.0, 0.0))");
        expect(body).toMatch(/Command drive = new TurnInPlace\(this, new [\w.]*Pose\(end\.x\(\), end\.y\(\), headingRad\(0\.0\)\)\);/);
        expect(text).toContain(`import org.horizon36596.zenith.${commandLibrary}.TurnInPlace;`);
      });

      it("starts its markers with the turn through the path's marker runner, every one at 0", () => {
        const body = methodBody(text, "stepFaceEast").join("\n");
        expect(body).toContain('markers.add(new PathMarkers.Marker(0.0, NamedCommands.build("score", Args.of("count", 1.0), this)));');
        expect(body).toContain("drive = PathMarkers.wrap(drive, segmentLengthsIn, markers, this);");
        expect(body).not.toContain("Parallel.deadline");
      });

      it("decides turn or follow from current on the live path, as AutoBuilder does", () => {
        expect(methodBody(text, "stepFaceNorth").join("\n")).toContain("DeferredPath.of(");
        const body = methodBody(text, "stepFaceNorthFrom");
        // The live polygon, measured as PedroPaths.build measures it, against the same limit.
        const live = commandLibrary === "ivy" ? "from" : "Poses.toPedro(from)";
        const pedroPose = commandLibrary === "ivy" ? "Pose" : "com.pedropathing.math.Pose";
        expect(body.join("\n")).toContain(`polygons.add(new ${pedroPose}[] { ${live}, `);
        expect(text).toContain("import org.horizon36596.zenith.PedroPaths;");
        const decision = body.indexOf("        if (PedroPaths.lengthIn(polygons) > PedroPaths.TURN_IN_PLACE_MAX_IN) {");
        expect(decision).toBeGreaterThanOrEqual(0);
        const close = body.indexOf("        }", decision);
        expect(close).toBeGreaterThan(decision);
        // Longer than the limit: followed from the live pose, raced against the end condition.
        const longer = body.slice(decision, close).join("\n");
        expect(longer).toContain(`Paths.line(${live}, `);
        expect(longer).toContain("Command drive = followPath(path, ");
        expect(longer).toContain("drive = Parallel.race(drive, ");
        expect(longer).toContain("return drive;");
        // Otherwise a turn on the spot at the end pose, raced against the same end condition.
        const shorter = body.slice(close).join("\n");
        expect(shorter).not.toContain("followPath(");
        expect(shorter).toContain(`Command drive = new TurnInPlace(this, new ${pedroPose}(end.x(), end.y(), headingRad(1.5708)));`);
        expect(shorter).toContain("drive = Parallel.race(drive, ");
        expect(shorter).toContain("return drive;");
      });

      it("reads a tangent turn from current off the live path", () => {
        const tangent = planOf([
          {
            id: "faceAlong",
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { ref: "start" } }],
            heading: { mode: "tangentReversed" },
          },
        ]);
        const body = methodBody(generateAutoJava(tangent, { ...options, commandLibrary }), "stepFaceAlongFrom");
        expect(body.join("\n")).toContain(
          "end.y(), PedroPaths.normalize(PedroPaths.endTangentRad(polygons) + Math.PI)));",
        );
      });

      it("looks up the end condition from current at init, not when the step starts", () => {
        const outer = methodBody(text, "stepFaceNorth").join("\n");
        expect(outer).toContain(
          'java.util.function.BooleanSupplier endCondition = NamedCommands.condition("hasPollen");',
        );
        expect(outer).toContain("from -> stepFaceNorthFrom(from, endCondition)");
        const body = methodBody(text, "stepFaceNorthFrom");
        expect(body[0]).toBe(
          `    private Command stepFaceNorthFrom(${commandLibrary === "ivy" ? "Pose" : "Pose2d"} from, java.util.function.BooleanSupplier endCondition) {`,
        );
        const until = commandLibrary === "ivy" ? "Commands.waitUntil" : "new WaitUntilCommand";
        expect(body.join("\n")).not.toContain("NamedCommands.condition(");
        expect(body.join("\n")).toContain(`drive = Parallel.race(drive, ${until}(endCondition));`);
      });
    });
  }

  it("leaves TurnInPlace unimported when no step turns on the spot", () => {
    expect(generateAutoJava(planned, options)).not.toContain("TurnInPlace");
  });
});

describe("a parallel's members", () => {
  it("get locals of their own when two ids read the same in camelCase", () => {
    const together = planOf([
      {
        id: "arms",
        kind: "parallel",
        mode: "deadline",
        deadline: "arm1",
        steps: [
          { id: "arm-1", kind: "wait", seconds: 0.1 },
          { id: "arm1", kind: "wait", seconds: 0.2 },
        ],
      },
    ]);
    for (const commandLibrary of ["solverslib", "ivy"] as const) {
      const body = methodBody(generateAutoJava(together, { ...options, commandLibrary }), "stepArms");
      const declared = body
        .map((line) => /^\s+Command (\w+) = /.exec(line)?.[1])
        .filter((name): name is string => name !== undefined);
      expect(new Set(declared).size, declared.join(", ")).toBe(declared.length);
      // The deadline is the member the file names, arm1, not arm-1.
      expect(body).toContain('        Command member_arm12 = step("arm1", m_arm12);');
      expect(body).toContain("        Command deadline = member_arm12;");
    }
  });
});

describe("a piecewise heading on a curve", () => {
  it("ends each range at the segment t the runtime's chord table gives, not at the arc-length fraction", () => {
    // A lopsided curve: its control point sits near the start, so t runs far from arc length.
    const from = { xIn: -48, yIn: -48 };
    const control = { xIn: -46, yIn: -46 };
    const to = { xIn: 24, yIn: 0 };
    const ranges = [
      { startT: 0, endT: 0.3, heading: { mode: "constant", headingRad: 0 } },
      { startT: 0.3, endT: 1, heading: { mode: "constant", headingRad: 1 } },
    ] as const;
    const lopsided = planOf([
      {
        id: "sweep",
        kind: "path",
        segments: [{ kind: "bezier", from, control: [control], to }],
        heading: { mode: "piecewise", ranges },
      },
    ]);
    const body = methodBody(generateAutoJava(lopsided, options), "stepSweep").join("\n");
    const curve = makeSimCurve([
      { x: from.xIn, y: from.yIn },
      { x: control.xIn, y: control.yIn },
      { x: to.xIn, y: to.yIn },
    ]);
    const pieces = piecewiseSegmentPieces(ranges, curve, 0, 1, 0);
    const untils = [...body.matchAll(/\.until\(([-\d.e]+), /g)].map((match) => Number(match[1]));
    expect(untils).toHaveLength(pieces.length);
    pieces.forEach((piece, index) => expect(untils[index]).toBeCloseTo(piece.endT, 4));
    // And the runtime's t is well away from the fraction on this curve, so the test can tell them apart.
    expect(Math.abs((pieces[0]?.endT ?? 0) - 0.3)).toBeGreaterThan(0.01);
  });
});

describe("a marker's distance", () => {
  it("is clamped to the path, so a path shortened after its marker was set never emits a negative distance (W2-11)", () => {
    // driveOut is 27 in long; both markers were set on a longer path.
    const shortened = planOf([
      {
        id: "driveOut",
        kind: "path",
        segments: [{ kind: "line", from: { ref: "start" }, to: { ref: "scoreSouth" } }],
        heading: { mode: "tangent" },
        markers: [
          { at: { distanceFromEndIn: 50 }, command: { name: "score", args: { count: 1 } } },
          { at: { distanceIn: 80 }, command: { name: "score", args: { count: 2 } } },
        ],
      },
    ]);
    const lengthIn = shortened.steps[0]?.lengthIn ?? 0;
    expect(lengthIn).toBeGreaterThan(20);
    const text = generateAutoJava(shortened, options);
    const distances = [...text.matchAll(/new PathMarkers\.Marker\((-?[\d.]+)/g)].map((match) => Number(match[1]));
    expect(distances).toHaveLength(2);
    expect(distances[0]).toBe(0);
    expect(distances[1]).toBeCloseTo(lengthIn, 3);
  });
});

describe("the header's sha in the browser", () => {
  it("is the same as the CLI's node:crypto digest of the canonical auto", () => {
    const canonical = canonicalize("auto", mixed);
    const cli = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 8);
    expect(sha256Hex(canonical).slice(0, 8)).toBe(cli);
  });
});

describe("codegenBlockedMessage", () => {
  it("counts the errors in a sentence", () => {
    expect(codegenBlockedMessage(1)).toBe("zenith codegen writes no Java while the auto has 1 error. Fix it first.");
    expect(codegenBlockedMessage(3)).toBe("zenith codegen writes no Java while the auto has 3 errors. Fix them first.");
  });
});

describe("a step id written before ids followed the waypoint name rule", () => {
  // A space, punctuation, a quote, a backslash and a leading digit: the file still loads (STEP_ID
  // is a warning), so the Java it generates has to compile.
  const odd = 'say "hi"\\now';
  const oldIds = planOf([
    { id: "shoot preload", kind: "wait", seconds: 0.5 },
    {
      id: "2nd",
      kind: "parallel",
      mode: "deadline",
      deadline: odd,
      steps: [
        { id: odd, kind: "wait", seconds: 1 },
        { id: "drive.out", kind: "wait", seconds: 0.2 },
      ],
    },
  ]);

  for (const commandLibrary of ["solverslib", "ivy"] as const) {
    const text = generateAutoJava(oldIds, { ...options, commandLibrary });

    it(`gives every method and local a valid Java identifier for ${commandLibrary}`, () => {
      const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
      const methods = [...text.matchAll(/private Command (\S+)\(/g)].map((match) => match[1] ?? "");
      const locals = [...text.matchAll(/^\s+Command (\S+) =/gm)].map((match) => match[1] ?? "");
      expect(methods).toEqual(expect.arrayContaining(["stepShootPreload", "step2nd"]));
      expect(locals.length).toBeGreaterThan(0);
      for (const name of [...methods, ...locals]) expect(name, name).toMatch(identifier);
    });

    it(`writes each id as a properly escaped string literal for ${commandLibrary}`, () => {
      expect(text).toContain('step("shoot preload", ');
      expect(text).toContain('step("2nd", ');
      expect(text).toContain('step("say \\"hi\\"\\\\now", ');
      expect(text).toContain('step("drive.out", ');
      // Every literal on a step(...) line closes on that line, so no quote in an id ends one early.
      for (const line of text.split("\n").filter((candidate) => candidate.includes("step(\""))) {
        const rest = line.replace(/"(?:[^"\\\n]|\\.)*"/g, "");
        expect(rest, line).not.toContain('"');
      }
    });
  }
});
