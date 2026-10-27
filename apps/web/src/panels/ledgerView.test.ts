/**
 * What the Ledger panel draws (`ledgerView.ts`): the example's steps as flows from place to place,
 * the strip at the playhead, where the pieces lie at the end, a shot that lands loose counted as
 * missed, and nectar in the up cell making the hive tip on less pollen.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadRobot, plan, resolve } from "@horizon36596/zenith-core";
import type { LedgerEntry, LedgerLocation, LedgerRun, SeasonRules, SeasonState } from "@horizon36596/zenith-core";
import { biobuzzRules, initialBiobuzzState } from "@horizon36596/zenith-season-biobuzz";
import { describe, expect, it } from "vitest";
import { ledgerFor } from "../state/ledgerRun";
import { ledgerEnd, ledgerNow, ledgerStepLines, stepPhases } from "./ledgerView";

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as unknown;

const field = loadField(read("../../../../examples/starter/autos/field/biobuzz.field.json"));
const robot = loadRobot(read("../../../../examples/starter/autos/robot.json"));
const example = loadAuto(read("../../../../examples/starter/autos/collect-and-score.auto.json"));

function exampleRun() {
  const view = ledgerFor(plan(resolve(example, undefined, robot), robot, field), field);
  if (view.run === null) throw new Error(view.reason ?? "no ledger");
  return { run: view.run, season: view.season };
}

/** What a line's flows say, as short words, for comparing: "what: from > pieces > to". */
const said = (run: LedgerRun, season: SeasonRules) =>
  ledgerStepLines(run, season, "RED").map((line) => [
    line.stepId,
    line.flows
      .map((flow) => {
        const pieces = flow.parts.map((part) => `${String(part.count)} ${part.kind}`).join(" ");
        return `${flow.what}: ${flow.from.label} > ${pieces} > ${flow.to.label}`;
      })
      .join(", "),
  ]);

describe("the Ledger's lines for the example", () => {
  it("draws each step that moved pieces as flows from where the pieces were to where they went", () => {
    const { run, season } = exampleRun();
    expect(said(run, season)).toEqual([
      ["shootPreloads", "score: robot > 4 pollen > hive, tip: hive > 4 pollen 3 nectarRed > floor, garden side"],
      ["collectFlower", "collect: flower 1 > 4 pollen > robot"],
      ["scoreFlowerPollen", "score: robot > 4 pollen > hive"],
      ["sweepGarden", "collect: red garden > 4 pollen > robot"],
      ["scoreGardenPollen", "score: robot > 4 pollen > hive, tip: hive > 8 pollen > floor, loading side"],
    ]);
    const lines = ledgerStepLines(run, season, "RED");
    expect(lines.reduce((sum, line) => sum + line.collected, 0)).toBe(8);
    expect(lines.reduce((sum, line) => sum + line.launched, 0)).toBe(12);
    expect(lines[0]?.words).toBe("shootPreloads: launched 4");
  });

  it("says where the pieces lie at the end, by kind, with every flower and our hive", () => {
    const { run, season } = exampleRun();
    const end = ledgerEnd(run, season, "RED");
    expect(end.robot.count).toBe(0);
    expect(end.robot.words).toBe("robot: empty");
    expect(end.hive).toMatchObject({ id: "hiveRed", tips: 2, pollen: 0, needed: 8 });
    expect(end.flowers.map((flower) => [flower.id, flower.count])).toEqual([
      ["flower0", 4],
      ["flower1", 0],
      ["flower2", 4],
      ["flower3", 4],
    ]);
    const tipped = end.others.find((place) => place.id === "floorRedGardenSide");
    expect(tipped?.parts.map((part) => [part.kind, part.count])).toEqual([
      ["pollen", 4],
      ["nectarRed", 3],
    ]);
    expect(tipped?.words).toBe("floorRedGardenSide: 4 pollen, 3 nectarRed");
    // Our alliance only (issue #95), and a garden line in plain words.
    expect(end.others.some((place) => place.parts.some((part) => part.kind === "nectarBlue"))).toBe(false);
    expect(end.others.find((place) => place.id === "gardenBlue")?.label).toBe("blue garden");
  });
});

describe("the strip at the playhead", () => {
  it("shows the robot and our hive once each finished step has run", () => {
    const { run, season } = exampleRun();
    const finishedUpTo = (last: string) => {
      const ids = run.entries.map((entry) => entry.stepId);
      const done = new Set(ids.slice(0, ids.indexOf(last) + 1));
      return (stepId: string) => done.has(stepId);
    };
    const start = ledgerNow(run, season, "RED", () => false);
    expect(start.held).toBe(4);
    expect(start.hopper).toEqual(["pollen", "pollen", "pollen", "pollen"]);
    // The staged 3 nectar make the up cell tip at 3 pollen.
    expect(start.hive).toMatchObject({ pollen: 0, nectar: 3, needed: 3, neededWithout: 8, tips: 0 });
    expect(start.hive?.upCell.map((part) => [part.kind, part.count])).toEqual([["nectarRed", 3]]);

    const afterShot = ledgerNow(run, season, "RED", finishedUpTo("shootPreloads"));
    expect(afterShot.held).toBe(0);
    expect(afterShot.hive).toMatchObject({ pollen: 0, needed: 8, tips: 1 });

    const scored = ledgerNow(run, season, "RED", finishedUpTo("scoreFlowerPollen"));
    expect(scored.hive).toMatchObject({ pollen: 4, needed: 8, tips: 1 });
  });

  it("puts each step before, at or after the playhead, and every step idle with no playhead", () => {
    const spans = [
      { id: "a", startS: 0, endS: 1 },
      { id: "b", startS: 1, endS: 2 },
      { id: "c", startS: 2, endS: 3 },
    ];
    const at = stepPhases(spans, 1.5);
    expect(["a", "b", "c", "unknown"].map(at)).toEqual(["done", "now", "next", "idle"]);
    expect(stepPhases(spans, 2)("b")).toBe("done");
    expect(stepPhases(null, 1)("a")).toBe("idle");
    expect(stepPhases(spans, null)("a")).toBe("idle");
  });
});

describe("a shot that lands loose", () => {
  type State = { robot: Record<string, number>; loose: number; looseHolds?: Record<string, number> };
  const at = (state: State) => state as unknown as SeasonState;
  const season = {
    holds: (state: SeasonState) => ({ ...(state as unknown as State).robot }),
    locations: (state: SeasonState): LedgerLocation[] => [
      { id: "robot", label: "this robot", kind: "robot", count: 0, holds: (state as unknown as State).robot, atIn: null },
      {
        id: "loose",
        label: "loose",
        kind: "loose",
        count: (state as unknown as State).loose,
        ...((state as unknown as State).looseHolds === undefined ? {} : { holds: (state as unknown as State).looseHolds }),
        atIn: null,
      },
    ],
  } as unknown as SeasonRules;

  function entry(stepId: string, before: State, after: State, extra: Partial<LedgerEntry>): LedgerEntry {
    return {
      stepId,
      before: at(before),
      after: at(after),
      holds: after.robot,
      target: null,
      launched: 0,
      collected: null,
      tipped: null,
      transfer: null,
      branch: null,
      row: { stepId, label: stepId },
      ...extra,
    };
  }

  it("counts what went loose as missed and the rest as made", () => {
    const entries = [
      entry("half", { robot: { pollen: 4 }, loose: 0 }, { robot: {}, loose: 1 }, { launched: 4 }),
      entry(
        "wide",
        { robot: { nectarRed: 1 }, loose: 1, looseHolds: { pollen: 1 } },
        { robot: {}, loose: 2, looseHolds: { pollen: 1, nectarRed: 1 } },
        { launched: 1 },
      ),
    ];
    const run = {
      entries,
      byStepId: Object.fromEntries(entries.map((e) => [e.stepId, e])),
      rows: [],
      initialState: at({ robot: { pollen: 4 }, loose: 0 }),
      finalState: at({ robot: {}, loose: 2 }),
    } as LedgerRun;
    const [half, wide] = ledgerStepLines(run, season, "RED");
    // The loose place gives no split by kind in the first step, so the 3 that went in and the 1 that
    // missed are counted without one.
    expect(half?.flows.map((flow) => [flow.what, flow.from.label, flow.to.label, flow.count])).toEqual([
      ["score", "robot", "target", 3],
      ["miss", "robot", "missed", 1],
    ]);
    expect(wide?.flows.map((flow) => [flow.what, flow.to.label, flow.parts.map((part) => part.kind)])).toEqual([
      ["miss", "missed", ["nectarRed"]],
    ]);
  });
});

describe("nectar in the up cell", () => {
  /** RED's up cell faces south at kickoff and north after one tip (`nectar.test.ts`). */
  const south = { xIn: -40, yIn: -40, headingRad: 1.5708 };
  const north = { xIn: -40, yIn: 40, headingRad: -1.5708 };
  const up = "hiveRedUpCell";

  /** A run of steps, each its id, what it does to the state, and the counts and target it reports. */
  function runOf(steps: [string, (state: SeasonState) => SeasonState, Partial<LedgerEntry>][]): LedgerRun {
    const kickoff = initialBiobuzzState(field) as unknown as SeasonState;
    const initialState = biobuzzRules.start?.(kickoff, { pollen: 4 }, "RED") ?? kickoff;
    let state = initialState;
    const entries: LedgerEntry[] = [];
    for (const [stepId, act, extra] of steps) {
      const before = state;
      state = act(state);
      entries.push({
        stepId,
        before,
        after: state,
        holds: biobuzzRules.holds?.(state) ?? {},
        target: null,
        launched: 0,
        collected: null,
        tipped: null,
        transfer: null,
        branch: null,
        row: { stepId, label: stepId },
        ...extra,
      });
    }
    const byStepId = Object.fromEntries(entries.map((entry) => [entry.stepId, entry]));
    return { entries, byStepId, rows: [], initialState, finalState: state };
  }

  it("lowers the pollen it takes to tip, and the hive tips on that much", () => {
    const run = runOf([
      ["shoot", (state) => biobuzzRules.onLaunch(state, up, 4, south), { launched: 4, target: up }],
      [
        "pickNectar",
        (state) => biobuzzRules.onCollect(state, "floorRedGardenSide.nectar", 3, "RED"),
        { collected: { containerId: "floorRedGardenSide.nectar", count: 3 } },
      ],
      ["scoreNectar", (state) => biobuzzRules.onLaunch(state, up, 3, north), { launched: 3, target: up }],
      [
        "pickPollen",
        (state) => biobuzzRules.onCollect(state, "floorRedGardenSide", 3, "RED"),
        { collected: { containerId: "floorRedGardenSide", count: 3 } },
      ],
      ["scorePollen", (state) => biobuzzRules.onLaunch(state, up, 3, north), { launched: 3, target: up }],
    ]);
    const upTo = (last: string) => {
      const ids = run.entries.map((entry) => entry.stepId);
      return (stepId: string) => ids.indexOf(stepId) <= ids.indexOf(last);
    };
    // The first tip leaves the cell empty: 8 pollen to tip.
    expect(ledgerNow(run, biobuzzRules, "RED", upTo("shoot")).hive).toMatchObject({ nectar: 0, needed: 8, tips: 1 });
    // Three nectar in the cell: 3 pollen tip it, not 8.
    expect(ledgerNow(run, biobuzzRules, "RED", upTo("scoreNectar")).hive).toMatchObject({
      pollen: 0,
      nectar: 3,
      needed: 3,
      neededWithout: 8,
      tips: 1,
    });
    expect(ledgerNow(run, biobuzzRules, "RED", upTo("scorePollen")).hive).toMatchObject({ pollen: 0, nectar: 0, tips: 2 });

    expect(said(run, biobuzzRules)).toEqual([
      ["shoot", "score: robot > 4 pollen > hive, tip: hive > 4 pollen 3 nectarRed > floor, garden side"],
      ["pickNectar", "collect: floor, garden side > 3 nectarRed > robot"],
      ["scoreNectar", "score: robot > 3 nectarRed > hive"],
      ["pickPollen", "collect: floor, garden side > 3 pollen > robot"],
      ["scorePollen", "score: robot > 3 pollen > hive, tip: hive > 3 pollen 3 nectarRed > floor, loading side"],
    ]);
  });
});
