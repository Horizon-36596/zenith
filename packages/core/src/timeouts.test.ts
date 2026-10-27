import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Auto, Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { estimate } from "./estimate.js";
import { applyFix } from "./fix.js";
import { FINDING_HELP, helpForFinding } from "./findingHelp.js";
import { raisedTimeoutS } from "./kinematics.js";
import { loadAuto, loadField, loadRobot, loadWaypoints } from "./load.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import type { Finding } from "./types.js";

/**
 * Timeouts and the time estimate (issue #154, sweep finding N9). A timeout bounds a step's seconds,
 * so the time budget can say how long the routine takes when a wait runs its full timeout; a wait
 * until a condition with no timeout can wait forever, so it warns; and a timeout shorter than the
 * step's own estimate cuts the step off, so it warns, says where, and caps the estimate there.
 */

const root = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));

const robot = loadRobot(read("autos/robot.json"));
const field = loadField(read("autos/field/biobuzz.field.json"));
const waypoints = loadWaypoints(read("autos/waypoints.json"));

const starter = (name: string): Auto => loadAuto(read(`autos/${name}.auto.json`));

/** The starter auto with one top-level step rewritten. */
function edited(name: string, stepId: string, rewrite: (step: Record<string, unknown>) => Record<string, unknown>): Auto {
  const raw = read(`autos/${name}.auto.json`) as { steps: Record<string, unknown>[] };
  return loadAuto({ ...raw, steps: raw.steps.map((step) => (step["id"] === stepId ? rewrite({ ...step }) : step)) });
}

function run(auto: Auto) {
  const planned = plan(resolve(auto, waypoints), robot, field);
  const result = estimate(planned, robot);
  return { estimate: result, findings: check(planned, result, robot, field) };
}

const codeOf = (findings: readonly Finding[], code: Finding["code"]): Finding[] =>
  findings.filter((finding) => finding.code === code);

describe("a wait or a command with no estimate but a timeout", () => {
  it("takes at most its timeout", () => {
    const row = run(starter("collect-and-score")).estimate.byStepId["waitForFull"];
    expect(row?.nominalS).toBeNull();
    expect(row?.unknown).toBe(true);
    expect(row?.highS).toBe(1);
  });

  it("makes TIME_BUDGET say the routine fits even if it runs its full timeout, and name it", () => {
    const { estimate: result, findings } = run(starter("collect-and-score"));
    const budget = codeOf(findings, "TIME_BUDGET");
    expect(budget).toHaveLength(1);
    const note = budget[0] as Finding;
    expect(note.severity).toBe("info");
    expect(note.stepId).toBe("total");
    expect(note.stepIds?.[0]).toBe("waitForFull");
    expect(note.message).toContain("waitForFull");
    expect(note.message).toContain("1 s timeout");
    expect(note.message).toContain(`(${((result.nominalS ?? 0) + 1).toFixed(1)} s)`);
    expect(note.message).not.toContain("may not fit");
    expect(note.message).not.toContain("lower bound");
  });

  it("names the steps that end on a condition after the step with a timeout", () => {
    const note = codeOf(run(starter("collect-and-score")).findings, "TIME_BUDGET")[0];
    expect(note?.stepIds).toEqual(["waitForFull", "collectFlower", "sweepGarden"]);
  });

  it("counts a wait in a race at no more than the member that ends the race", () => {
    // all-step-kinds races the garden sweep against a wait until full with a 3 s timeout. The sweep
    // ends the race first, so running the wait's whole timeout adds nothing to the routine.
    const { estimate: result, findings } = run(starter("all-step-kinds"));
    const note = codeOf(findings, "TIME_BUDGET")[0];
    expect(note?.message).toContain("untilFull");
    expect(note?.message).toContain(`(${(result.nominalS ?? 0).toFixed(1)} s)`);
  });
});

describe("the lower-bound note", () => {
  const unbounded = (): Auto =>
    edited("collect-and-score", "waitForFull", (step) => {
      const { timeoutS: _timeoutS, ...rest } = step;
      return rest;
    });

  it("is kept for a step with no estimate and no timeout, and names it", () => {
    const note = codeOf(run(unbounded()).findings, "TIME_BUDGET")[0];
    expect(note?.severity).toBe("info");
    expect(note?.stepId).toBe("total");
    expect(note?.stepIds).toEqual(["waitForFull"]);
    expect(note?.message).toContain("lower bound");
    expect(note?.message).toContain("waitForFull has no estimate and no timeout");
  });

  it("leaves out a member of a deadline group that the deadline stops", () => {
    const raw = starter("collect-and-score");
    const group: Step = {
      id: "timed",
      kind: "parallel",
      mode: "deadline",
      deadline: "pause",
      steps: [
        { id: "pause", kind: "wait", seconds: 1 },
        { id: "listen", kind: "wait", until: "hopperFull" },
      ],
    };
    const note = codeOf(run({ ...raw, steps: [...raw.steps, group] }).findings, "TIME_BUDGET")[0];
    expect(note?.stepIds).toEqual(["waitForFull", "collectFlower", "sweepGarden"]);
    expect(note?.message).not.toContain("listen");
  });

  // A race ends when its first member does, so a member that could wait forever adds nothing to the
  // total when another member is sure to end. The note leaves it out, as WAIT_NO_TIMEOUT does.
  describe("leaves out a member of a race that another member is sure to end", () => {
    const untimed = (id: string): Step => ({ id, kind: "wait", until: "hopperFull" });
    const drive = (id: string): Step => ({
      id,
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { ref: "park" } }],
      heading: { mode: "tangent" },
    });
    const layouts: { name: string; members: Step[]; quiet: string[] }[] = [
      { name: "a timed wait and a wait with no timeout", members: [{ id: "rs", kind: "wait", seconds: 1 }, untimed("rw")], quiet: ["rw"] },
      { name: "a path and a wait with no timeout", members: [drive("rp"), untimed("rw")], quiet: ["rw"] },
      {
        name: "a sequence holding a wait with no timeout, and a path",
        members: [{ id: "rq", kind: "sequence", steps: [untimed("rw")] }, drive("rp")],
        quiet: ["rq", "rw"],
      },
    ];
    for (const layout of layouts) {
      it(`with ${layout.name}`, () => {
        const raw = starter("collect-and-score");
        const race: Step = { id: "r", kind: "parallel", mode: "race", steps: layout.members };
        const { findings } = run({ ...raw, steps: [...raw.steps, race] });
        const note = codeOf(findings, "TIME_BUDGET")[0];
        expect(note?.severity).toBe("info");
        expect(note?.stepIds).toEqual(["waitForFull", "collectFlower", "sweepGarden"]);
        expect(note?.message).not.toContain("lower bound");
        for (const id of layout.quiet) expect(note?.message).not.toContain(` ${id} `);
        expect(codeOf(findings, "WAIT_NO_TIMEOUT")).toEqual([]);
      });
    }
  });

  it("stays when the total is over the period", () => {
    const raw = unbounded();
    const long: Step = { id: "dwell", kind: "wait", seconds: 10 };
    const budget = codeOf(run({ ...raw, steps: [...raw.steps, long] }).findings, "TIME_BUDGET");
    expect(budget.map((finding) => finding.severity).sort()).toEqual(["info", "warning"]);
    const note = budget.find((finding) => finding.severity === "info");
    expect(note?.message).toContain("lower bound");
    expect(note?.stepIds).toEqual(["waitForFull"]);
  });
});

describe("TIME_BUDGET's info help", () => {
  it("has its own words, not the over-time advice", () => {
    const help = helpForFinding({ code: "TIME_BUDGET", severity: "info" });
    expect(help).not.toEqual(FINDING_HELP.TIME_BUDGET);
    expect(help.fix).not.toContain("Cut or shorten");
    expect(helpForFinding({ code: "TIME_BUDGET", severity: "warning" })).toEqual(FINDING_HELP.TIME_BUDGET);
  });
});

describe("WAIT_NO_TIMEOUT", () => {
  it("warns about a wait until a condition with no timeout, with a fix that writes no number", () => {
    const auto = edited("collect-and-score", "waitForFull", (step) => {
      const { timeoutS: _timeoutS, ...rest } = step;
      return rest;
    });
    const findings = codeOf(run(auto).findings, "WAIT_NO_TIMEOUT");
    expect(findings).toHaveLength(1);
    const finding = findings[0] as Finding;
    expect(finding.severity).toBe("warning");
    expect(finding.stepId).toBe("waitForFull");
    expect(finding.fixes?.map((fix) => fix.kind)).toEqual(["focusTimeout"]);
    expect(applyFix(auto, finding.fixes?.[0] as NonNullable<Finding["fixes"]>[number])).toEqual(auto);
  });

  it("does not fire for a wait with a timeout, or for a path that ends on a condition", () => {
    // collectFlower and sweepGarden end on hopperFull and have no timeout: codegen races the
    // condition against the path, so the path's own end bounds them.
    expect(codeOf(run(starter("collect-and-score")).findings, "WAIT_NO_TIMEOUT")).toEqual([]);
  });

  it("does not fire for a wait that a race or a deadline group ends, and does under all", () => {
    const raw = starter("collect-and-score");
    const until = (id: string): Step => ({ id, kind: "wait", until: "hopperFull" });
    const pause = (id: string): Step => ({ id, kind: "wait", seconds: 1 });
    const groups: Step[] = [
      { id: "raced", kind: "parallel", mode: "race", steps: [until("inRace"), pause("raceEnd")] },
      { id: "timed", kind: "parallel", mode: "deadline", deadline: "deadlineEnd", steps: [pause("deadlineEnd"), until("inDeadline")] },
      { id: "together", kind: "parallel", mode: "all", steps: [until("inAll"), pause("allEnd")] },
      { id: "limited", kind: "parallel", mode: "deadline", deadline: "isDeadline", steps: [until("isDeadline"), pause("besideDeadline")] },
    ];
    const warned = codeOf(run({ ...raw, steps: [...raw.steps, ...groups] }).findings, "WAIT_NO_TIMEOUT");
    expect(warned.map((finding) => finding.stepId).sort()).toEqual(["inAll", "isDeadline"]);
  });

  // A race ends when its first member does, so it only ends a wait when some other member is sure
  // to end. Two waits with no timeout racing each other can both wait for the rest of the period.
  const untimedRace = (id: string): Step => ({
    id,
    kind: "parallel",
    mode: "race",
    steps: [
      { id: "waitA", kind: "wait", until: "hopperFull" },
      { id: "waitB", kind: "wait", until: "holdingPiece" },
    ],
  });
  const warnedIn = (findings: readonly Finding[]): string[] =>
    codeOf(findings, "WAIT_NO_TIMEOUT").map((finding) => finding.stepId).sort();

  it("fires for each wait in a race whose members can all wait forever, as the time budget note says", () => {
    const raw = starter("collect-and-score");
    const { findings } = run({ ...raw, steps: [...raw.steps, untimedRace("eitherSignal")] });
    expect(warnedIn(findings)).toEqual(["waitA", "waitB"]);
    const note = codeOf(findings, "TIME_BUDGET")[0];
    expect(note?.message).toContain("waitA and waitB have no estimate and no timeout");
  });

  it("fires for a race of waits with no timeout that is a deadline group's deadline", () => {
    const raw = starter("collect-and-score");
    const group: Step = {
      id: "listening",
      kind: "parallel",
      mode: "deadline",
      deadline: "eitherSignal",
      steps: [untimedRace("eitherSignal"), { id: "beside", kind: "wait", until: "hopperEmpty" }],
    };
    expect(warnedIn(run({ ...raw, steps: [...raw.steps, group] }).findings)).toEqual(["waitA", "waitB"]);
  });

  it("does not fire for a wait in a race with a member that is sure to end, nested or not", () => {
    const raw = starter("collect-and-score");
    const groups: Step[] = [
      {
        id: "timedSignal",
        kind: "parallel",
        mode: "race",
        steps: [
          { id: "untimed", kind: "wait", until: "hopperFull" },
          { id: "timed", kind: "wait", until: "holdingPiece", timeoutS: 2 },
        ],
      },
      {
        id: "orPause",
        kind: "parallel",
        mode: "race",
        steps: [
          { id: "listenInSequence", kind: "sequence", steps: [{ id: "deep", kind: "wait", until: "hopperFull" }] },
          { id: "pauseInSequence", kind: "sequence", steps: [{ id: "brief", kind: "wait", seconds: 1 }] },
        ],
      },
    ];
    expect(warnedIn(run({ ...raw, steps: [...raw.steps, ...groups] }).findings)).toEqual([]);
  });

  it("reads the same layouts the same way without an estimate", () => {
    const raw = starter("collect-and-score");
    const groups: Step[] = [
      untimedRace("eitherSignal"),
      {
        id: "raced",
        kind: "parallel",
        mode: "race",
        steps: [
          { id: "inRace", kind: "wait", until: "hopperFull" },
          { id: "raceEnd", kind: "wait", seconds: 1 },
        ],
      },
    ];
    const planned = plan(resolve({ ...raw, steps: [...raw.steps, ...groups] }, waypoints), robot, field);
    expect(warnedIn(check(planned, null, robot, field))).toEqual(["waitA", "waitB"]);
  });
});

describe("raisedTimeoutS", () => {
  it("rounds 1.2 times the estimate up to a tenth of a second", () => {
    expect(raisedTimeoutS(3.41)).toBe(4.1);
    expect(raisedTimeoutS(1)).toBe(1.2);
  });

  it("does not push a product that lands on a tenth to the next one", () => {
    expect(raisedTimeoutS(3.5)).toBe(4.2);
    expect(raisedTimeoutS(0.5)).toBe(0.6);
  });

  it("never offers less than 1.2 times the estimate", () => {
    for (let estimateS = 0.01; estimateS < 30; estimateS += 0.37) {
      expect(raisedTimeoutS(estimateS)).toBeGreaterThanOrEqual(estimateS * 1.2);
    }
  });
});

describe("a timeout under the step's own estimate", () => {
  const tight = (timeoutS: number): Auto => edited("collect-and-score", "toGarden", (step) => ({ ...step, timeoutS }));

  it("warns, caps the estimate at the timeout, and says where the path stops", () => {
    const base = run(starter("collect-and-score")).estimate;
    const ownS = base.byStepId["toGarden"]?.nominalS ?? 0;
    expect(ownS).toBeCloseTo(3.53, 2);

    const { estimate: result, findings } = run(tight(1));
    const row = result.byStepId["toGarden"];
    expect(row?.nominalS).toBe(1);
    expect(row?.highS).toBe(1);
    expect(row?.uncappedS).toBeCloseTo(ownS, 9);
    expect(result.nominalS).toBeCloseTo((base.nominalS ?? 0) - ownS + 1, 9);

    const found = codeOf(findings, "TIMEOUT_TIGHT");
    expect(found).toHaveLength(1);
    const finding = found[0] as Finding;
    expect(finding.severity).toBe("warning");
    expect(finding.stepId).toBe("toGarden");
    expect(finding.t).toBeGreaterThan(0);
    expect(finding.t).toBeLessThan(1);
    expect(finding.message).toContain(`t ${(finding.t ?? 0).toFixed(2)}`);
    expect(finding.message).toContain("short of the end");
  });

  it("offers to raise the timeout to 1.2 times the estimate, rounded up to 0.1 s, which clears it", () => {
    const auto = tight(1);
    const finding = codeOf(run(auto).findings, "TIMEOUT_TIGHT")[0] as Finding;
    const fix = finding.fixes?.[0];
    expect(fix?.kind).toBe("raiseTimeout");
    expect(fix?.label).toBe("Raise the timeout to 4.3 s");
    expect(fix?.kind === "raiseTimeout" ? fix.params.timeoutS : null).toBe(4.3);

    const fixed = applyFix(auto, fix as NonNullable<Finding["fixes"]>[number]);
    const step = fixed.steps.find((candidate) => candidate.id === "toGarden");
    expect(step?.kind === "path" ? step.timeoutS : null).toBe(4.3);
    expect(codeOf(run(fixed).findings, "TIMEOUT_TIGHT")).toEqual([]);
  });

  it("stays info between 1.0 and 1.2 times the estimate, and leaves the estimate alone", () => {
    const { estimate: result, findings } = run(tight(3.8));
    expect(result.byStepId["toGarden"]?.nominalS).toBeCloseTo(3.53, 2);
    expect(result.byStepId["toGarden"]?.uncappedS).toBeUndefined();
    expect(codeOf(findings, "TIMEOUT_TIGHT").map((finding) => finding.severity)).toEqual(["info"]);
  });
});
