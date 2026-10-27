import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { check, loadAuto, loadField, loadRobot, loadWaypoints, mirrorAuto, plan, resolve, type Finding } from "@horizon36596/zenith-core";
import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type Field, type Robot } from "@horizon36596/zenith-schema";
import { beforeAll, describe, expect, it } from "vitest";
import { biobuzzOwnSide, biobuzzRules, G402_RULE, OWN_HALF_TOLERANCE_IN } from "./rules.js";

/**
 * OPPONENT_SIDE (issue #365): during AUTO the robot may not go past the centre line into the other
 * alliance's side (BIOBUZZ Competition Manual V1, §11.4.1, G402, with Figure 9-5's columns: A to C
 * red, D to F blue). It is an error, it reads the same line and tolerance as START_ILLEGAL's own-half
 * test (G304.A), and the auto's alliance decides which side is its own.
 *
 * The robot is 18 in long and 14 in wide, so facing east its nose is 9 in ahead of its centre and
 * facing north its side is 7 in out; its corners are 11.40 in from the centre.
 */
const fieldPath = fileURLToPath(new URL("../field/biobuzz.field.json", import.meta.url));

let field: Field;
let robot: Robot;

const robotWith = (mouths: unknown[] = []): Robot =>
  parseRobot({
    $schema: SCHEMA_ID.robot,
    formatVersion: 1,
    name: "Test robot",
    frame: { forward: "+x", left: "+y", headingZero: "+x", headingPositive: "ccw" },
    footprint: {
      startIn: { lengthIn: 18, widthIn: 14, provenance: "PLACEHOLDER: test fixture" },
      expandedIn: { lengthIn: 18, widthIn: 14, provenance: "PLACEHOLDER: test fixture" },
      centreOfRotationIn: { xIn: 0, yIn: 0 },
    },
    kinematics: {
      maxForwardVelInPerS: { value: 60 },
      maxStrafeVelInPerS: { value: 50 },
      forwardDecelInPerS2: { value: 60 },
      strafeDecelInPerS2: { value: 40 },
      accelInPerS2: { value: 60 },
      maxAngularVelRadPerS: { value: 6 },
      defaultPathSpeedFraction: { value: 0.8 },
      follower: { library: "pedro", version: "3.0.0-20260828.185437-17", holdEnd: true },
    },
    commands: [{ name: "shootAll", estimateS: "1" }],
    ...(mouths.length === 0 ? {} : { mouths }),
  });

beforeAll(() => {
  field = loadField(JSON.parse(readFileSync(fieldPath, "utf8")) as unknown);
  robot = robotWith();
});

const autoOf = (alliance: "RED" | "BLUE", start: { xIn: number; yIn: number; headingRad: number }, steps: unknown[]): Auto =>
  parseAuto({ $schema: SCHEMA_ID.auto, formatVersion: 4, name: "centre-line", alliance, start: { pose: start }, steps });

const lineTo = (id: string, xIn: number, yIn: number, heading: unknown = { mode: "tangent" }): unknown => ({
  id,
  kind: "path",
  segments: [{ kind: "line", from: "current", to: { xIn, yIn } }],
  heading,
});

const findingsOf = (auto: Auto, with_: Robot = robot): Finding[] =>
  check(plan(resolve(auto), with_, field), null, with_, field, biobuzzRules);

const over = (auto: Auto, with_: Robot = robot): Finding[] => findingsOf(auto, with_).filter((f) => f.code === "OPPONENT_SIDE");

/** RED, driving east along y = -40 until its nose is at `noseXIn`. */
const eastTo = (noseXIn: number): Auto =>
  autoOf("RED", { xIn: -40, yIn: -40, headingRad: 0 }, [lineTo("toLine", noseXIn - 9, -40)]);

describe("OPPONENT_SIDE (G402)", () => {
  it("is an error when the robot drives a few inches past the centre line", () => {
    const found = over(eastTo(3));
    expect(found).toHaveLength(1);
    const [finding] = found as [Finding];
    expect(finding.severity).toBe("error");
    expect(finding.stepId).toBe("toLine");
    expect(finding.geometry?.penetrationIn).toBeCloseTo(3, 6);
    expect(finding.geometry?.pointIn?.xIn).toBeCloseTo(3, 6);
    // Where the robot is worst, and the stretch it is over, for the clip ghost and the tint.
    expect(finding.geometry?.poseIn?.xIn).toBeCloseTo(-6, 6);
    expect(finding.geometry?.footprintIn?.length).toBe(1);
    expect(finding.geometry?.tRange?.[1]).toBe(1);
    expect(finding.message).toContain("crosses the centre line into BLUE's side");
    expect(finding.message).toContain("3.00 in over");
    expect(finding.message).toContain("for about 2 in (t 0.94 to 1.00)");
    // The worst corner, a front corner of the robot, for the canvas; the message stays in words.
    expect(finding.geometry?.pointIn?.yIn).toBeCloseTo(-33, 6);
    expect(finding.message.endsWith(G402_RULE)).toBe(true);
    expect(G402_RULE).toContain("§11.4.1");
    expect(G402_RULE).toContain("MAJOR FOUL");
    expect(G402_RULE).toContain("YELLOW CARD");
    // The path ends over the line, so no route between its ends keeps off it: no Route around.
    expect(finding.fixes).toBeUndefined();
  });

  it("passes a robot that stays a hair inside the tolerance, and reports one just past it", () => {
    expect(over(eastTo(OWN_HALF_TOLERANCE_IN - 0.01))).toEqual([]);
    expect(over(eastTo(0))).toEqual([]);
    const [just] = over(eastTo(OWN_HALF_TOLERANCE_IN + 0.01)) as [Finding];
    expect(just.geometry?.penetrationIn).toBeCloseTo(OWN_HALF_TOLERANCE_IN + 0.01, 6);
  });

  it("reports a turn on the spot whose corners swing over the line, though both its ends are clear", () => {
    // Facing north the side is 2 in short of the line, facing east the nose is 1 in short, and in
    // between a corner, 11.40 in from the centre, swings over.
    const auto = autoOf("RED", { xIn: -40, yIn: -40, headingRad: Math.PI / 2 }, [
      lineTo("across", -10, -40, { mode: "constant", headingRad: Math.PI / 2 }),
      lineTo("turn", -10, -40, { mode: "linear", fromRad: Math.PI / 2, toRad: 0 }),
    ]);
    const found = over(auto);
    expect(found.map((finding) => finding.stepId)).toEqual(["turn"]);
    const [turn] = found as [Finding];
    expect(turn.message).toContain("while it turns on the spot");
    expect(turn.geometry?.penetrationIn).toBeGreaterThan(1);
    expect(turn.geometry?.penetrationIn).toBeLessThan(Math.hypot(9, 7) - 10 + 1e-9);
    // A turn on the spot has no route to go round anything with.
    expect(turn.fixes).toBeUndefined();
  });

  it("checks a mirrored BLUE auto against BLUE's own side, with the same finding", () => {
    const red = eastTo(3);
    const blue = mirrorAuto(red, "pointSymmetry", biobuzzRules.mirrorId);
    expect(blue.alliance).toBe("BLUE");
    const [redFinding] = over(red) as [Finding];
    const [blueFinding] = over(blue) as [Finding];
    expect(blueFinding.geometry?.penetrationIn).toBeCloseTo(redFinding.geometry?.penetrationIn ?? NaN, 6);
    expect(blueFinding.geometry?.pointIn?.xIn).toBeCloseTo(-3, 6);
    expect(blueFinding.message).toContain("into RED's side");
    // The RED file's own poses read as BLUE's are on RED's side from the start.
    const [wrong] = over({ ...red, alliance: "BLUE" }) as [Finding];
    expect(wrong.stepId).toBe("toLine");
    expect(wrong.message).toContain("into RED's side");
  });

  it("counts an intake mouth that reaches over the line, as part of the robot", () => {
    // A mouth 4 in deep whose front edge is 11 in ahead of the centre, 2 in past the frame.
    const withMouth = robotWith([{ id: "front", side: "FRONT", offsetIn: { xIn: 9, yIn: 0 }, widthIn: 10, depthIn: 4 }]);
    const [finding] = over(eastTo(-1), withMouth) as [Finding];
    expect(finding.message).toContain("The robot's intake mouth crosses");
    expect(finding.geometry?.worstPolygonIndex).toBe(1);
    expect(finding.geometry?.penetrationIn).toBeCloseTo(1, 6);
    expect(over(eastTo(-1))).toEqual([]);
  });

  it("leaves a start-configuration body over the line to START_ILLEGAL, with the same line and tolerance", () => {
    // Facing north at x = -6.96 the side is 0.04 in over: inside the tolerance for both rules.
    const inside = autoOf("RED", { xIn: -7 + 0.04, yIn: -65, headingRad: Math.PI / 2 }, [{ id: "wait", kind: "wait", seconds: 1 }]);
    expect(findingsOf(inside).filter((f) => f.code === "START_ILLEGAL" || f.code === "OPPONENT_SIDE")).toEqual([]);
    const outside = autoOf("RED", { xIn: -7 + 0.06, yIn: -65, headingRad: Math.PI / 2 }, [{ id: "wait", kind: "wait", seconds: 1 }]);
    const codes = findingsOf(outside).map((f) => f.code);
    expect(codes).toContain("START_ILLEGAL");
    expect(codes).not.toContain("OPPONENT_SIDE");
  });

  describe("a start whose start-configuration body is on the robot's own side but whose expanded body is over", () => {
    // START_ILLEGAL measures the 14 in wide start-configuration body, whose side touches the line
    // facing north at x = -7; the 20 in wide expanded body, which OPPONENT_SIDE sweeps, is 3 in over.
    const expanding = (): Robot =>
      parseRobot({
        ...robotWith(),
        footprint: { ...robotWith().footprint, expandedIn: { lengthIn: 18, widthIn: 20, provenance: "PLACEHOLDER: test fixture" } },
      });
    const north = { xIn: -7, yIn: -65, headingRad: Math.PI / 2 };

    it("reports the robot standing over the line from the start, when no step moves it", () => {
      const found = findingsOf(autoOf("RED", north, [{ id: "wait", kind: "wait", seconds: 5 }]), expanding());
      expect(found.filter((f) => f.code === "START_ILLEGAL")).toEqual([]);
      const over = found.filter((f) => f.code === "OPPONENT_SIDE");
      expect(over.map((f) => f.stepId)).toEqual(["wait"]);
      const [standing] = over as [Finding];
      expect(standing.geometry?.penetrationIn).toBeCloseTo(3, 6);
      expect(standing.message).toContain("stands 3.00 in over the centre line into BLUE's side for this step");
    });

    it("measures a first path from its start sample, where it is farthest over", () => {
      const auto = autoOf("RED", north, [lineTo("west", -30, -65, { mode: "constant", headingRad: Math.PI / 2 })]);
      const over = findingsOf(auto, expanding()).filter((f) => f.code === "OPPONENT_SIDE");
      expect(over.map((f) => f.stepId)).toEqual(["west"]);
      const [driving] = over as [Finding];
      expect(driving.t).toBe(0);
      expect(driving.geometry?.penetrationIn).toBeCloseTo(3, 6);
      expect(driving.geometry?.tRange?.[0]).toBe(0);
      expect(driving.message).toContain("up to 3.00 in over");
    });
  });

  it("finds every starter auto on its own side, as RED and mirrored as BLUE", () => {
    const starter = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
    const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));
    const starterRobot = loadRobot(read("autos/robot.json"));
    const starterField = loadField(read("autos/field/biobuzz.field.json"));
    const waypoints = loadWaypoints(read("autos/waypoints.json"));
    const names = readdirSync(`${starter}autos`).filter((file) => file.endsWith(".auto.json"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const red = loadAuto(read(`autos/${name}`));
      for (const auto of [red, mirrorAuto(red, "pointSymmetry", biobuzzRules.mirrorId, waypoints)]) {
        const planned = plan(resolve(auto, waypoints), starterRobot, starterField);
        const found = check(planned, null, starterRobot, starterField, biobuzzRules).filter((f) => f.code === "OPPONENT_SIDE");
        expect(found.map((f) => `${auto.alliance} ${f.stepId}: ${f.message}`), name).toEqual([]);
      }
    }
  });

  it("reports the starter's old route under the hive, kept as a core test fixture, as crossing the line", () => {
    // Issue #365: the old collect-and-score drove its scoring spot on x = -9 and bowed its curve
    // controls to x = -5, which cleared the hive frame's west legs and went over the centre line.
    // The shipped collect-and-score goes round the west side instead and finds nothing (the test above).
    const starter = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
    const read = (relative: string): unknown => JSON.parse(readFileSync(`${starter}${relative}`, "utf8"));
    const starterRobot = loadRobot(read("autos/robot.json"));
    const starterField = loadField(read("autos/field/biobuzz.field.json"));
    const waypoints = loadWaypoints(read("autos/waypoints.json"));
    const corridor = fileURLToPath(new URL("../../core/test-fixtures/corridor-collect-and-score.auto.json", import.meta.url));
    const old = loadAuto(JSON.parse(readFileSync(corridor, "utf8")) as unknown);
    const planned = plan(resolve(old, waypoints), starterRobot, starterField);
    const found = check(planned, null, starterRobot, starterField, biobuzzRules).filter((f) => f.code === "OPPONENT_SIDE");
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.severity === "error")).toBe(true);
    expect(found.map((f) => f.stepId)).toContain("toOtherSide");
  });

  it("reads the line from the field file: x = 0, with each alliance's own side the half its hive is in", () => {
    expect(biobuzzOwnSide(field, "RED")).toEqual({ axis: "x", lineIn: 0, ownSign: -1, toleranceIn: OWN_HALF_TOLERANCE_IN, rule: G402_RULE });
    expect(biobuzzOwnSide(field, "BLUE")?.ownSign).toBe(1);
    expect(biobuzzOwnSide({ ...field, elements: [] }, "RED")).toBeNull();
  });
});
