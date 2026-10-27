import { readFileSync } from "node:fs";
import { parseAuto, type Auto, type Field, type Robot, type Waypoints } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { loadAuto, loadField, loadRobot, loadWaypoints } from "../load.js";
import { plan } from "../plan.js";
import { resolve } from "../resolve.js";
import { MecanumPlant } from "../sim/plant.js";
import { plantParams } from "../sim/params.js";
import { simulate } from "../sim/simulate.js";
import type { SimTrace } from "../sim/types.js";
import type { Plan } from "../types.js";
import { createLiveRun, type LiveBelief, type LiveCommand, type LiveHost, type LiveRun } from "./liveRun.js";

/**
 * The live run's contract. The one that matters most: a live run fed by the instant sim's own
 * plant, with a host that runs no commands and reads no conditions, IS the instant sim, byte for
 * byte, on every example auto. That is what lets a program that drives its own robot trust that it
 * follows a path exactly the way the editor's preview and the robot's Pedro do.
 */

const examples = new URL("../../../../examples/", import.meta.url);
const read = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, examples), "utf8"));

interface Project {
  robot: Robot;
  field: Field;
  waypoints: Waypoints;
}

const project = (dir: string): Project => ({
  robot: loadRobot(read(`${dir}/autos/robot.json`)),
  field: loadField(read(`${dir}/autos/field/biobuzz.field.json`)),
  waypoints: loadWaypoints(read(`${dir}/autos/waypoints.json`)),
});

const EXAMPLES: readonly (readonly [string, string])[] = [
  ["starter", "first-auto"],
  ["starter", "collect-and-score"],
  ["starter", "all-step-kinds"],
  ["starter", "cycle-and-park"],
];

const planOf = (p: Project, auto: Auto): Plan => plan(resolve(auto, p.waypoints), p.robot, p.field);

const beliefOf = (plant: MecanumPlant): LiveBelief => {
  const m = plant.motion();
  return {
    xIn: m.x,
    yIn: m.y,
    headingRad: m.heading,
    vxInPerS: m.vx,
    vyInPerS: m.vy,
    omegaRadPerS: m.omega,
    twistForwardInPerS: m.twistX,
    twistLeftInPerS: m.twistY,
  };
};

/** Drives a live run with the instant sim's plant, the way a host program drives its own robot. */
function driveWithPlant(run: LiveRun, plant: MecanumPlant, tickS: number, maxTicks: number): void {
  for (let i = 0; i < maxTicks; i += 1) {
    const result = run.tick(beliefOf(plant));
    if (result.finished) return;
    plant.drive(result.powers);
    plant.update(tickS);
  }
}

const withoutSource = (trace: SimTrace): unknown => ({ ...trace, source: null });

describe("createLiveRun", () => {
  for (const [dir, name] of EXAMPLES) {
    it(`is the instant sim when fed its plant: ${dir}/${name}`, () => {
      const p = project(dir);
      const auto = loadAuto(read(`${dir}/autos/${name}.auto.json`));
      const thePlan = planOf(p, auto);
      const tickS = 0.01;
      const expected = simulate(thePlan, p.robot, p.field, { tickS });
      expect(expected.completed).toBe(true);

      const start = thePlan.startPose;
      const plant = new MecanumPlant(plantParams(p.robot, p.field, "robot", {}), start.xIn, start.yIn, start.headingRad);
      const run = createLiveRun(thePlan, p.robot, p.field, {}, { tickS });
      driveWithPlant(run, plant, tickS, 100_000);

      expect(run.finished).toBe(true);
      const actual = run.trace();
      expect(actual.source).toBe("live");
      expect(JSON.stringify(withoutSource(actual))).toBe(JSON.stringify(withoutSource(expected)));
    });
  }

  const p = project("starter");
  const lineAuto = (extra: Record<string, unknown>[]): Auto =>
    parseAuto({
      formatVersion: 3,
      name: "live-test",
      alliance: "RED",
      start: { pose: { xIn: -60, yIn: -36, headingRad: 0 }, holds: { pollen: 0 } },
      steps: extra,
    });

  /** A host command that takes `ticks` executes to finish, and says what happened to it. */
  const counted = (ticks: number, log: string[], label: string): LiveCommand => {
    let left = ticks;
    return {
      initialize: () => {
        left = ticks;
        log.push(`${label}:init`);
      },
      execute: () => {
        left -= 1;
      },
      isFinished: () => left <= 0,
      end: (interrupted) => log.push(`${label}:${interrupted ? "interrupted" : "end"}`),
    };
  };

  it("runs the host's own commands and times the step by them, not by estimateS", () => {
    const auto = lineAuto([{ id: "shoot", kind: "command", name: "shootAll", args: { count: 2 } }]);
    const log: string[] = [];
    const seen: unknown[] = [];
    const host: LiveHost = {
      command: (name, args, stepId) => {
        seen.push({ name, args, stepId });
        return counted(30, log, name);
      },
    };
    const run = createLiveRun(planOf(p, auto), p.robot, p.field, host, { tickS: 0.02 });
    const belief: LiveBelief = { xIn: -60, yIn: -36, headingRad: 0, vxInPerS: 0, vyInPerS: 0, omegaRadPerS: 0 };
    let ticks = 0;
    while (!run.tick(belief).finished) ticks += 1;
    expect(seen).toEqual([{ name: "shootAll", args: { count: 2 }, stepId: "shoot" }]);
    expect(log).toEqual(["shootAll:init", "shootAll:end"]);
    // Thirty executes: the command ends on the thirtieth tick, which is stamped 29 ticks in.
    expect(ticks).toBe(29);
    const step = run.trace().steps.find((s) => s.id === "shoot");
    expect(step?.endS).toBeCloseTo(29 * 0.02, 9);
  });

  it("reads an end condition from the host every tick and cuts the path there", () => {
    const auto = lineAuto([
      {
        id: "sweep",
        kind: "path",
        segments: [{ kind: "line", from: { xIn: -60, yIn: -36, headingRad: 0 }, to: { xIn: -12, yIn: -36 } }],
        heading: { mode: "constant", headingRad: 0 },
        endCondition: { condition: "hopperFull" },
        markers: [{ at: { t: 0 }, command: { name: "setIntake", args: { side: "BOTH", state: "FORWARD" } } }],
      },
    ]);
    const log: string[] = [];
    let full = false;
    const host: LiveHost = {
      command: (name) => counted(1_000_000, log, name),
      condition: (name) => name === "hopperFull" && full,
    };
    const thePlan = planOf(p, auto);
    const plant = new MecanumPlant(plantParams(p.robot, p.field, "robot", {}), -60, -36, 0);
    const run = createLiveRun(thePlan, p.robot, p.field, host, { tickS: 0.01 });
    let ticks = 0;
    for (; ticks < 5000; ticks += 1) {
      if (plant.state.x > -40) full = true;
      const result = run.tick(beliefOf(plant));
      if (result.finished) break;
      plant.drive(result.powers);
      plant.update(0.01);
    }
    expect(run.finished).toBe(true);
    const trace = run.trace();
    const sweep = trace.steps.find((s) => s.id === "sweep");
    expect(sweep?.conditionFired).toBe(true);
    expect(trace.events.some((e) => e.kind === "conditionFired" && e.detail === "hopperFull")).toBe(true);
    // Cut well short of the 48 in leg, and the marker's intake was started, then interrupted.
    expect(plant.state.x).toBeLessThan(-25);
    expect(log).toEqual(["setIntake:init", "setIntake:interrupted"]);
  });

  it("ends a running marker when a later marker needs one of its subsystems", () => {
    // spinUp needs the launcher; score needs the launcher and the intake; intakeOn only the intake.
    const auto = lineAuto([
      {
        id: "go",
        kind: "path",
        segments: [{ kind: "line", from: { xIn: -60, yIn: -36, headingRad: 0 }, to: { xIn: -12, yIn: -36 } }],
        heading: { mode: "constant", headingRad: 0 },
        markers: [
          { at: { t: 0 }, command: { name: "spinUp" } },
          { at: { t: 0.25 }, command: { name: "intakeOn", args: { state: "FORWARD" } } },
          { at: { t: 0.5 }, command: { name: "score", args: { count: 1 } } },
        ],
      },
    ]);
    const log: string[] = [];
    const host: LiveHost = { command: (name) => counted(1_000_000, log, name) };
    const plant = new MecanumPlant(plantParams(p.robot, p.field, "robot", {}), -60, -36, 0);
    const run = createLiveRun(planOf(p, auto), p.robot, p.field, host, { tickS: 0.01 });
    driveWithPlant(run, plant, 0.01, 10_000);
    expect(run.finished).toBe(true);
    expect(log).toEqual([
      "spinUp:init",
      "intakeOn:init",
      // score takes both subsystems over, newest first, as the runtime's runner ends them.
      "intakeOn:interrupted",
      "spinUp:interrupted",
      "score:init",
      "score:interrupted",
    ]);
  });

  it("lets a turn on the spot's markers take turns on a subsystem, as a path's do", () => {
    const auto = lineAuto([
      {
        id: "face",
        kind: "path",
        segments: [{ kind: "line", from: { xIn: -60, yIn: -36, headingRad: 0 }, to: { xIn: -60, yIn: -36 } }],
        heading: { mode: "constant", headingRad: 1 },
        markers: [
          { at: { t: 0 }, command: { name: "spinUp" } },
          { at: { t: 0 }, command: { name: "score", args: { count: 1 } } },
        ],
      },
    ]);
    const log: string[] = [];
    const host: LiveHost = { command: (name) => counted(1_000_000, log, name) };
    const plant = new MecanumPlant(plantParams(p.robot, p.field, "robot", {}), -60, -36, 0);
    const run = createLiveRun(planOf(p, auto), p.robot, p.field, host, { tickS: 0.01 });
    driveWithPlant(run, plant, 0.01, 10_000);
    expect(run.finished).toBe(true);
    expect(log).toEqual(["spinUp:init", "spinUp:interrupted", "score:init", "score:interrupted"]);
  });

  it("asks the host which side a branch takes, as the branch starts", () => {
    const auto = lineAuto([
      {
        id: "choose",
        kind: "branch",
        condition: "hopperEmpty",
        then: [{ id: "yes", kind: "command", name: "launcherIdle" }],
        else: [{ id: "no", kind: "command", name: "cancelAll" }],
      },
    ]);
    for (const empty of [true, false]) {
      const log: string[] = [];
      const host: LiveHost = { command: (name) => counted(1, log, name), condition: () => empty };
      const run = createLiveRun(planOf(p, auto), p.robot, p.field, host, { tickS: 0.02 });
      const belief: LiveBelief = { xIn: -60, yIn: -36, headingRad: 0, vxInPerS: 0, vyInPerS: 0, omegaRadPerS: 0 };
      for (let i = 0; i < 10 && !run.tick(belief).finished; i += 1);
      expect(log).toEqual(empty ? ["launcherIdle:init", "launcherIdle:end"] : ["cancelAll:init", "cancelAll:end"]);
    }
  });

  it("waits on a host condition until it reads true", () => {
    const auto = lineAuto([{ id: "hold", kind: "wait", until: "hopperFull" }]);
    let full = false;
    const run = createLiveRun(planOf(p, auto), p.robot, p.field, { condition: () => full }, { tickS: 0.02 });
    const belief: LiveBelief = { xIn: -60, yIn: -36, headingRad: 0, vxInPerS: 0, vyInPerS: 0, omegaRadPerS: 0 };
    for (let i = 0; i < 50; i += 1) expect(run.tick(belief).finished).toBe(false);
    full = true;
    expect(run.tick(belief).finished).toBe(true);
  });

  it("interrupts what is running when cancelled, and then writes no power", () => {
    const auto = lineAuto([{ id: "shoot", kind: "command", name: "shootAll", args: { count: 4 } }]);
    const log: string[] = [];
    const run = createLiveRun(planOf(p, auto), p.robot, p.field, { command: (n) => counted(1_000, log, n) }, {
      tickS: 0.02,
    });
    const belief: LiveBelief = { xIn: -60, yIn: -36, headingRad: 0, vxInPerS: 0, vyInPerS: 0, omegaRadPerS: 0 };
    run.tick(belief);
    expect(run.tick(belief).activeStepIds).toEqual(["shoot"]);
    run.cancel();
    expect(log).toEqual(["shootAll:init", "shootAll:interrupted"]);
    expect(run.tick({ ...belief, xIn: -50 }).powers).toEqual({ forward: 0, strafe: 0, turn: 0 });
  });

  it("keeps holding the end pose after the routine finishes", () => {
    const auto = lineAuto([
      {
        id: "go",
        kind: "path",
        segments: [{ kind: "line", from: { xIn: -60, yIn: -36, headingRad: 0 }, to: { xIn: -36, yIn: -36 } }],
        heading: { mode: "constant", headingRad: 0 },
      },
    ]);
    const plant = new MecanumPlant(plantParams(p.robot, p.field, "robot", {}), -60, -36, 0);
    const run = createLiveRun(planOf(p, auto), p.robot, p.field, {}, { tickS: 0.01 });
    driveWithPlant(run, plant, 0.01, 10_000);
    expect(run.finished).toBe(true);
    // Shoved 6 in back toward the start, the follower drives forward to the end pose again.
    const traceAtEnd = JSON.stringify(run.trace());
    const shoved: LiveBelief = { ...beliefOf(plant), xIn: plant.state.x - 6 };
    expect(run.tick(shoved).powers.forward).toBeGreaterThan(0.1);
    // and the trace, which ends with the routine, does not grow while the robot holds
    expect(JSON.stringify(run.trace())).toBe(traceAtEnd);
  });
});
