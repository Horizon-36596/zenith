import type { Field, Robot } from "@horizon36596/zenith-schema";
import type { Pose, Vec2 } from "./geometry/vec.js";
import type { Finding, LedgerRow } from "./types.js";

/**
 * Whatever the season plugin wants to remember between steps. The core never looks inside it: it
 * only threads it through the ledger (site/docs/seasons.md).
 */
export type SeasonState = Readonly<Record<string, unknown>>;

export type TargetId = string;

/** The plugin interface of site/docs/seasons.md. `season-biobuzz` implements it in M1. */
export interface SeasonRules {
  /** The `rules.plugin` name in `field.json` that selects this implementation. */
  readonly id: string;
  initialState(field: Field): SeasonState;
  onLaunch(state: SeasonState, target: TargetId, count: number, pose: Pose): SeasonState;
  onCollect(state: SeasonState, containerId: string, count: number): SeasonState;
  currentTarget(state: SeasonState, alliance: "RED" | "BLUE"): TargetId | null;
  legalApproach(state: SeasonState, target: TargetId, pose: Pose, robot: Robot): boolean;
  startLegal(field: Field, pose: Pose, robot: Robot): Finding[];
  summary(state: SeasonState): LedgerRow[];

  /**
   * Optional, and the one addition to the interface as `03` section 6 draws it: the auto says what
   * the robot starts holding (`start.holds`), and the ledger has to get that into the state before
   * the first step runs. A plugin that tracks nothing can leave it out.
   */
  start?(state: SeasonState, holds: Readonly<Record<string, number>>): SeasonState;

  /** Optional: what the robot is holding now, which the CAPACITY and EMPTY_SHOT checks read. */
  holds?(state: SeasonState): Record<string, number>;

  /**
   * Optional: the author asserting a tip happened, from a command whose registry entry carries
   * `ledger: { tip: "own" }` or from a step's `expect.tip`. It is trusted over whatever the
   * plugin's own model of the season predicted.
   */
  onTip?(state: SeasonState, which: "own" | "opponent", alliance: "RED" | "BLUE"): SeasonState;

  /** Optional: where on the field a target sits, so TURRET_RANGE can work out the bearing to it. */
  targetPoint?(state: SeasonState, target: TargetId): Vec2 | null;

  /**
   * Optional: the closest pose to this one that `legalApproach` would accept, so LEGAL_APPROACH can
   * offer a "move to legal approach" fix with real coordinates rather than a shrug.
   */
  nearestLegalApproach?(
    state: SeasonState,
    target: TargetId,
    pose: Pose,
    robot: Robot,
  ): Pose | null;

  /** Optional: a one-line description of what a step did to the state, for the ledger's rows. */
  describe?(before: SeasonState, after: SeasonState): string | null;

  /**
   * Optional: the other alliance's name for a field id, so a mirrored routine expects the hive and
   * the flowers it will actually be in front of. `mirrorAuto` asks this about every id a step's
   * `expect` names; returning `null` means the id has no counterpart and the routine cannot be
   * mirrored, which is refused rather than silently kept.
   */
  mirrorId?(id: string): string | null;
}

/**
 * The rules used when no season plugin is loaded: nothing is illegal, nothing is tracked. M0's
 * START_ILLEGAL check goes through `startLegal`, so a season package can add the real rule without
 * the core learning anything about the game.
 */
export const noSeasonRules: SeasonRules = {
  id: "none",
  initialState: () => ({}),
  onLaunch: (state) => state,
  onCollect: (state) => state,
  currentTarget: () => null,
  legalApproach: () => true,
  startLegal: () => [],
  summary: () => [],
};
