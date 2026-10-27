import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  check,
  estimate,
  ledgerLocations,
  ledgerStateAfter,
  loadAuto,
  loadField,
  loadRobot,
  loadWaypoints,
  mirrorAuto,
  plan,
  resolve,
  runLedger,
  simulate,
  type SeasonState,
} from "@horizon36596/zenith-core";
import { FORMAT_VERSIONS, SCHEMA_ID, type Auto, type Field, type Robot } from "@horizon36596/zenith-schema";
import { beforeAll, describe, expect, it } from "vitest";
import { biobuzzRules } from "./rules.js";
import { initialBiobuzzState, type BiobuzzState } from "./state.js";

/**
 * The ball ledger the owner asked for on 2026-09-30: counts in every hive cell, flower, floor
 * quarter, robot and loading zone; planner-only transfer steps with an expected and an actual
 * count; and conditions the preview answers from the ledger, so setting a partner's transfer to 0
 * makes the preview take the else side.
 */

const here = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8")) as unknown;

let field: Field;
let robot: Robot;

beforeAll(() => {
  field = loadField(json(here("../field/biobuzz.field.json")));
  // The starter robot, with the tipSeen condition a team adds to read the hive's tips from the
  // ledger (site/docs/file-format.md, `conditions[].ledger`).
  const starter = json(here("../../../examples/starter/autos/robot.json")) as { conditions?: unknown[] };
  robot = loadRobot({
    ...starter,
    conditions: [
      ...(starter.conditions ?? []),
      { name: "tipSeen", summary: "Our hive has tipped at least once.", ledger: { quantity: "hiveOwn.tips", min: 1 } },
    ],
  });
});

const plain = (state: SeasonState): BiobuzzState => state as unknown as BiobuzzState;

/**
 * A RED routine: the partner scores its preload into RED's up cell and this robot adds one, then a
 * branch on tipSeen. The up cell starts with 3 nectar and the field's tip table says 3 pollen tip
 * it, so the hive tips when the partner's 4 arrive. The cell that comes up faces north, and the
 * robot is still in the south quarter, so the robot's one lands loose.
 */
function autoWith(partnerActual: number | undefined): Auto {
  return loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: FORMAT_VERSIONS.auto,
    name: "partner-tip",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn: -63, headingRad: 1.5708 }, holds: { pollen: 4 } },
    steps: [
      {
        id: "partnerScores",
        kind: "transfer",
        from: "partner",
        to: "hiveRedUpCell",
        expectedCount: 4,
        ...(partnerActual === undefined ? {} : { actualCount: partnerActual }),
      },
      { id: "robotScores", kind: "transfer", from: "robot", to: "hiveRedUpCell", expectedCount: 1 },
      {
        id: "ifTipped",
        kind: "branch",
        condition: "tipSeen",
        then: [{ id: "thenWait", kind: "wait", seconds: 0.5 }],
        else: [
          {
            id: "elsePath",
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: -40, headingRad: 1.5708 } }],
            heading: { mode: "constant", headingRad: 1.5708 },
          },
        ],
      },
    ],
  });
}

const planned = (auto: Auto) => plan(resolve(auto, undefined, robot), robot, field);

describe("the BIOBUZZ ledger locations", () => {
  it("splits the floor into four quarters named for each alliance's garden and loading sides", () => {
    const floor = initialBiobuzzState(field).floor;
    expect(Object.keys(floor).sort()).toEqual([
      "floorBlueGardenSide",
      "floorBlueLoadingSide",
      "floorRedGardenSide",
      "floorRedLoadingSide",
    ]);
    // RED's garden lies along the audience wall in RED's half, so its garden side is x < 0, y < 0.
    expect(floor["floorRedGardenSide"]).toMatchObject({ minXIn: -72, maxXIn: 0, minYIn: -72, maxYIn: 0, holds: {} });
    // The point mirror puts BLUE's garden side in the opposite corner.
    expect(floor["floorBlueGardenSide"]).toMatchObject({ minXIn: 0, maxXIn: 72, minYIn: 0, maxYIn: 72 });
    expect(floor["floorRedLoadingSide"]).toMatchObject({ minXIn: -72, maxXIn: 0, minYIn: 0, maxYIn: 72 });
  });

  it("counts a loading zone for each zone the field file marks, and the partner's preload", () => {
    const start = initialBiobuzzState(field);
    expect(Object.keys(start.loadingZone).sort()).toEqual(["loadingZoneBlue", "loadingZoneRed"]);
    expect(start.loadingZone["loadingZoneRed"]).toMatchObject({ minXIn: -72, maxXIn: -61, holds: {} });
    // The partner starts with the preload every robot starts with, `startRules.holds`.
    expect(start.partnerHolds).toEqual({ pollen: 4 });
  });

  it("lists every location with a count and a place to draw it", () => {
    const locations = biobuzzRules.locations?.(initialBiobuzzState(field) as unknown as SeasonState, "RED") ?? [];
    const byId = new Map(locations.map((location) => [location.id, location]));
    expect(byId.get("robot")?.atIn).toBeNull();
    expect(byId.get("hiveRedUpCell")).toMatchObject({ kind: "hiveCell", count: 3, holds: { nectarRed: 3 } });
    // RED's up cell faces SOUTH at kickoff, so it is drawn south of the pivot and the down cell north.
    expect(byId.get("hiveRedUpCell")?.atIn?.yIn).toBeLessThan(0);
    expect(byId.get("hiveRedDownCell")?.atIn?.yIn).toBeGreaterThan(0);
    expect(byId.get("flower0")).toMatchObject({ kind: "flower", count: 4, atIn: { xIn: -69.46, yIn: -24 } });
    expect(byId.get("gardenRed")).toMatchObject({ kind: "garden", count: 4 });
    expect(byId.get("floorRedGardenSide")).toMatchObject({ kind: "floor", count: 0, atIn: { xIn: -36, yIn: -36 } });
    expect(byId.get("loadingZoneRed")).toMatchObject({ kind: "loadingZone", count: 0 });
    expect(byId.get("humanPlayerRed")).toMatchObject({ kind: "humanPlayer", count: null, holds: {}, atIn: null });
    expect(byId.get("offField")?.count).toBeNull();
  });
});

describe("transfer steps", () => {
  it("move the actual count, which defaults to the expected one, and tip the hive when it fills", () => {
    const run = runLedger(planned(autoWith(undefined)), field, biobuzzRules);
    const entry = run.byStepId["partnerScores"];
    expect(entry?.transfer).toMatchObject({ from: "partner", to: "hiveRedUpCell", expectedCount: 4, actualCount: 4, moved: 4, problem: null });
    const after = plain(entry!.after);
    expect(after.partnerHolds).toEqual({});
    // 3 nectar want 3 pollen, so the partner's 4 tip the hive and the whole cell is dumped onto the
    // floor quarter on its own side, the south one.
    expect(after.hives["hiveRed"]?.tips).toBe(1);
    expect(after.hives["hiveRed"]?.upCell).toEqual({});
    expect(after.floor["floorRedGardenSide"]?.holds).toEqual({ nectarRed: 3, pollen: 4 });
    expect(after.loose).toEqual({});
  });

  it("leave the ledger alone when the actual count is 0, whatever the expected count says", () => {
    const run = runLedger(planned(autoWith(0)), field, biobuzzRules);
    expect(run.byStepId["partnerScores"]?.transfer).toMatchObject({ expectedCount: 4, actualCount: 0, moved: 0 });
    expect(plain(run.byStepId["partnerScores"]!.after).hives["hiveRed"]?.upCell).toEqual({ nectarRed: 3 });
  });

  it("move only what the source holds, and TRANSFER says so", () => {
    const auto = autoWith(6);
    const p = planned(auto);
    const run = runLedger(p, field, biobuzzRules);
    expect(run.byStepId["partnerScores"]?.transfer?.moved).toBe(4);
    const findings = check(p, estimate(p, robot), robot, field, biobuzzRules).filter((f) => f.code === "TRANSFER");
    expect(findings).toEqual([
      expect.objectContaining({ severity: "warning", stepId: "partnerScores", message: expect.stringContaining("holds only 4") }),
    ]);
  });

  it("refuse a location the ledger does not count, with the list of ones it does", () => {
    const auto = autoWith(undefined);
    const step = auto.steps[0];
    if (step?.kind !== "transfer") throw new Error("unreachable");
    step.to = "hiveGreenUpCell";
    const p = planned(auto);
    const findings = check(p, estimate(p, robot), robot, field, biobuzzRules).filter((f) => f.code === "TRANSFER");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.message).toContain("floorRedGardenSide");
  });

  it("read Own and Opponent against the routine's alliance", () => {
    const state = initialBiobuzzState(field) as unknown as SeasonState;
    const moved = biobuzzRules.onTransfer?.(state, "offField", "hiveOwnUpCell", 2, "BLUE");
    expect(plain(moved!.state).hives["hiveBlue"]?.upCell).toEqual({ nectarBlue: 3, pollen: 2 });
    expect(biobuzzRules.measure?.(moved!.state, "hiveOwnUpCell", "BLUE")).toBe(5);
    expect(biobuzzRules.measure?.(moved!.state, "hiveOpponent.tips", "BLUE")).toBe(0);
  });

  it("carry pieces between the floor, the loading zone and the robot", () => {
    let state = initialBiobuzzState(field) as unknown as SeasonState;
    state = biobuzzRules.onTransfer!(state, "offField", "loadingZoneRed", 3, "RED").state;
    state = biobuzzRules.onTransfer!(state, "loadingZoneRed", "robot", 2, "RED").state;
    state = biobuzzRules.onTransfer!(state, "gardenRed", "floorRedGardenSide", 1, "RED").state;
    const after = plain(state);
    expect(after.loadingZone["loadingZoneRed"]?.holds).toEqual({ pollen: 1 });
    expect(after.robotHolds).toEqual({ pollen: 2 });
    expect(after.floor["floorRedGardenSide"]?.holds).toEqual({ pollen: 1 });
    expect(Object.values(after.garden).filter(Boolean)).toHaveLength(7);
  });

  it("mirror their locations with the routine", () => {
    const blue = mirrorAuto(autoWith(0), "pointSymmetry", biobuzzRules.mirrorId);
    const step = blue.steps[0];
    expect(step).toMatchObject({ kind: "transfer", from: "partner", to: "hiveBlueUpCell", expectedCount: 4, actualCount: 0 });
  });
});

describe("conditions the preview reads from the ledger", () => {
  it("take the then side when the partner's transfer tips the hive", () => {
    const auto = autoWith(undefined);
    const p = planned(auto);
    const run = runLedger(p, field, biobuzzRules);
    // The partner's 4 pollen reach the 3 the table asks for 3 nectar, so the hive has tipped and
    // tipSeen reads true.
    expect(plain(run.byStepId["robotScores"]!.after).hives["hiveRed"]?.tips).toBe(1);
    expect(run.byStepId["ifTipped"]?.branch).toEqual({ condition: "tipSeen", then: true, known: true, reason: null });
    expect(run.byStepId["thenWait"]).toBeDefined();
    expect(run.byStepId["elsePath"]).toBeUndefined();
    const trace = simulate(p, robot, field, { ledger: run, season: biobuzzRules });
    const ids = trace.steps.map((step) => step.id);
    expect(ids).toContain("thenWait");
    expect(ids).not.toContain("elsePath");
  });

  it("take the else side, in the ledger and in the preview, when the partner fails to tip", () => {
    const auto = autoWith(0);
    const p = planned(auto);
    const run = runLedger(p, field, biobuzzRules);
    expect(run.byStepId["ifTipped"]?.branch).toMatchObject({ then: false, known: true });
    expect(run.byStepId["elsePath"]).toBeDefined();
    expect(run.byStepId["thenWait"]).toBeUndefined();
    const trace = simulate(p, robot, field, { ledger: run, season: biobuzzRules });
    const ids = trace.steps.map((step) => step.id);
    expect(ids).toContain("elsePath");
    expect(ids).not.toContain("thenWait");
    const branch = trace.steps.find((step) => step.id === "ifTipped");
    expect(branch?.unknown).toBe(false);
    // The else side drives north, so the preview ends there rather than at the start.
    const last = trace.poses[trace.poses.length - 1];
    expect(last?.[2]).toBeGreaterThan(-45);
  });

  it("changes nothing the robot runs: the transfer is a zero-second step whatever its counts", () => {
    const tipped = planned(autoWith(undefined));
    const failed = planned(autoWith(0));
    expect(estimate(tipped, robot).byStepId["partnerScores"]?.nominalS).toBe(0);
    expect(estimate(failed, robot).byStepId["partnerScores"]?.nominalS).toBe(0);
  });

  it("gives the counts at a preview time from the steps that have finished", () => {
    const run = runLedger(planned(autoWith(undefined)), field, biobuzzRules);
    const before = ledgerLocations(ledgerStateAfter(run, () => false), biobuzzRules, "RED");
    const middle = ledgerLocations(ledgerStateAfter(run, (id) => id === "partnerScores"), biobuzzRules, "RED");
    const after = ledgerLocations(
      ledgerStateAfter(run, (id) => id === "partnerScores" || id === "robotScores"),
      biobuzzRules,
      "RED",
    );
    const count = (list: typeof before, id: string): number | null | undefined =>
      list.find((location) => location.id === id)?.count;
    expect(count(before, "partner")).toBe(4);
    expect(count(before, "robot")).toBe(4);
    expect(count(middle, "partner")).toBe(0);
    // The partner's 4 tipped the hive: its 7 pieces were dumped onto the south floor quarter and the
    // empty cell came up, facing north.
    expect(count(middle, "hiveRedUpCell")).toBe(0);
    expect(count(middle, "floorRedGardenSide")).toBe(7);
    // The robot is still at the start pose in the south quarter, so its piece misses the north cell
    // and lands loose.
    expect(count(after, "robot")).toBe(3);
    expect(count(after, "hiveRedUpCell")).toBe(0);
    expect(count(after, "loose")).toBe(1);
  });
});

describe("a transfer that changes a later shot's target", () => {
  /**
   * Issue #75, from the 2026-10-02 sweep (E2): the starter's collect-and-score auto with a transfer
   * from the partner into RED's up cell. The starter's shootPreloads already tips the hive, so the
   * north cell comes up empty and the robot scores it from scoreNorth. The transfer goes in after
   * shootPreloads and puts the partner's 4 into that north cell; an empty cell takes 8 pollen to
   * tip, so scoreFlowerPollen's 4 now tip the hive a second time, the south cell comes up, and
   * scoreGardenPollen shoots at the up cell from what is now its back. The finding is right; it has
   * to say which earlier steps moved the target, or nothing points back to the transfer.
   */
  const starterAuto = (withTransfer: boolean): Auto => {
    const raw = json(here("../../../examples/starter/autos/collect-and-score.auto.json")) as { steps: unknown[] };
    const transfer = { id: "transfer", kind: "transfer", from: "partner", to: "hiveRedUpCell", expectedCount: 4 };
    const steps = withTransfer ? [...raw.steps.slice(0, 2), transfer, ...raw.steps.slice(2)] : raw.steps;
    return loadAuto({ ...raw, steps });
  };
  const legalApproach = (auto: Auto) => {
    const waypoints = loadWaypoints(json(here("../../../examples/starter/autos/waypoints.json")));
    const p = plan(resolve(auto, waypoints, robot), robot, field);
    return check(p, estimate(p, robot), robot, field, biobuzzRules).filter((f) => f.code === "LEGAL_APPROACH");
  };

  it("has no LEGAL_APPROACH error without the transfer", () => {
    expect(legalApproach(starterAuto(false))).toEqual([]);
  });

  it("names the step that tipped the hive and the transfer that filled it", () => {
    const findings = legalApproach(starterAuto(true));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "error", stepId: "scoreGardenPollen" });
    const message = findings[0]?.message ?? "";
    expect(message).toContain("This step launches at hiveRedUpCell from a pose that is not a legal approach to it.");
    expect(message).toContain("It was legal until scoreFlowerPollen, after which the ledger says hiveRed tipped");
    expect(message).toContain("Before that, transfer step transfer moved 4 from partner to hiveRedUpCell.");
  });
});
