import type { Field, Robot } from "@horizon36596/zenith-schema";
import type { Pose, Vec2 } from "./geometry/vec.js";
import type { Finding, LedgerRow } from "./types.js";

/**
 * Whatever the season plugin wants to remember between steps. The core never looks inside it: it
 * only threads it through the ledger (site/docs/seasons.md).
 */
export type SeasonState = Readonly<Record<string, unknown>>;

export type TargetId = string;

/**
 * One place the ledger keeps a count of game pieces: the robot, the alliance partner, a hive cell,
 * a flower, a floor quadrant, a loading zone. A transfer step names two of them, and the
 * editor draws each one's count on the field.
 */
export interface LedgerLocation {
  /** The id a transfer step names, such as `robot`, `partner`, `hiveRedUpCell` or `flower0`. */
  id: string;
  /** How the editor names it, in a few words. */
  label: string;
  /**
   * What kind of place it is, for the editor's styling: `robot`, `partner`, `hiveCell`,
   * `flower`, `garden`, `floor`, `loadingZone`, `loose` (on the floor, place unknown),
   * `humanPlayer` (pieces a human player brings into play) or `offField`, which is not counted.
   */
  kind: string;
  /** How many pieces are there, or null for a place the ledger does not count. */
  count: number | null;
  /**
   * Optional: the same count split by element kind, such as `{ pollen: 2, nectarRed: 3 }`, for a
   * season with more than one kind of piece. Left out, every piece is the season's one kind.
   */
  holds?: Readonly<Record<string, number>>;
  /** Where on the field to draw the count, or null for a place that moves or is off the field. */
  atIn: Vec2 | null;
}

/** What a transfer did: the new state, and how many pieces actually moved. */
export interface TransferResult {
  state: SeasonState;
  /** How many moved, which is fewer than asked when the source ran out. */
  moved: number;
  /** A sentence saying why the transfer could not be made at all, when it could not. */
  problem?: string;
}

/** The plugin interface of site/docs/seasons.md. `season-biobuzz` implements it in M1. */
export interface SeasonRules {
  /** The `rules.plugin` name in `field.json` that selects this implementation. */
  readonly id: string;
  initialState(field: Field): SeasonState;
  onLaunch(state: SeasonState, target: TargetId, count: number, pose: Pose): SeasonState;
  /**
   * `alliance` is the routine's, so a plugin can read `Own` and `Opponent` in the container id; it
   * is optional so a plugin written before it existed still type-checks.
   */
  onCollect(state: SeasonState, containerId: string, count: number, alliance?: "RED" | "BLUE"): SeasonState;
  currentTarget(state: SeasonState, alliance: "RED" | "BLUE"): TargetId | null;
  legalApproach(state: SeasonState, target: TargetId, pose: Pose, robot: Robot): boolean;
  /**
   * The start rules, for a start pose in the frame of `alliance`, the file's own alliance.
   * `field.json`'s `startRules` are written for `field.frame.canonicalAlliance`; a plugin reads them
   * for the other alliance through its own counterparts (its own half, its own loading zone).
   * `alliance` is optional so a plugin written before it existed still type-checks; left out, it
   * means the canonical alliance.
   */
  startLegal(field: Field, pose: Pose, robot: Robot, alliance?: "RED" | "BLUE"): Finding[];
  summary(state: SeasonState): LedgerRow[];

  /**
   * Optional, and the one addition to the interface as `03` section 6 draws it: the auto says what
   * the robot starts holding (`start.holds`), and the ledger has to get that into the state before
   * the first step runs. A plugin that tracks nothing can leave it out. `alliance` is the routine's,
   * so a plugin can follow its own alliance's pieces through `onLaunch` and `onCollect`, which are
   * not given it; it is optional so a plugin written before it existed still type-checks.
   */
  start?(state: SeasonState, holds: Readonly<Record<string, number>>, alliance?: "RED" | "BLUE"): SeasonState;

  /** Optional: what the robot is holding now, which the CAPACITY and EMPTY_SHOT checks read. */
  holds?(state: SeasonState): Record<string, number>;

  /**
   * Optional: the author asserting a tip happened, from a command whose registry entry carries
   * `ledger: { tip: "own" }` or from a step's `expect.tip`. It is trusted over whatever the
   * plugin's own model of the season predicted.
   */
  onTip?(state: SeasonState, which: "own" | "opponent", alliance: "RED" | "BLUE"): SeasonState;

  /**
   * Optional: whether `target` names something on the field a robot can launch into, so
   * LAUNCH_TARGET can report an `expect.launchesInto` that names nothing. Left out, every name is
   * taken on trust.
   */
  knowsTarget?(state: SeasonState, target: TargetId): boolean;

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

  /**
   * Optional: the physical place a robot at `pose` takes from or scores into when its ledger names
   * `elementId`, for an id that names different places over a match. A BIOBUZZ hive's up cell is one
   * target id for two cells, and the other cell is up after every tip, so two robots scoring into
   * the up cell from opposite quarters score into different cells. The alliance checks ask this so
   * ALLIANCE_ELEMENT_CONFLICT compares places, not ids. The result is a few words naming the place
   * ("the north cell"), which the finding's message shows. Null when the id always names one place,
   * or when the pose does not say which; left out, every id is one place.
   */
  claimPlace?(field: Field, elementId: string, pose: Pose): string | null;

  /**
   * Optional: every place the ledger counts pieces, with the count in `state`. A transfer step's
   * `from` and `to` must be one of these ids (TRANSFER_LOCATION), and the editor draws the counts
   * on the field. `alliance` is the routine's, so a plugin can label its own side.
   */
  locations?(state: SeasonState, alliance: "RED" | "BLUE"): LedgerLocation[];

  /**
   * Optional: a transfer step, `count` pieces from one location to another, as the author says
   * happens (a partner scoring, the human player entering pieces through the loading zone). A
   * plugin moves at most what the source holds and applies its own consequences, such as a hive
   * tipping once its cell is full enough. `pose` is where the robot is when the step runs, for a
   * rule that depends on it (BIOBUZZ: this robot only scores into a hive cell in the cell's own
   * quarter of the field); it is optional so a plugin written before it existed still type-checks.
   */
  onTransfer?(
    state: SeasonState,
    from: string,
    to: string,
    count: number,
    alliance: "RED" | "BLUE",
    pose?: Pose,
  ): TransferResult;

  /**
   * Optional: a number the ledger keeps, for a condition's `{ quantity, min, max }` test in
   * `robot.json`: a location's count, or a counter of the plugin's own (BIOBUZZ: `<hive>.tips`).
   * `Own` and `Opponent` in the quantity stand for `alliance` and the other one. Null when the
   * plugin keeps no such number.
   */
  measure?(state: SeasonState, quantity: string, alliance: "RED" | "BLUE"): number | null;

  /**
   * Optional: what a person calls a field file obstacle, such as "the west base bar of the hive
   * frame" for `frameBarWest`, so a STRUCTURE message names something a student can find on the
   * field. The message keeps the id after it in brackets. `field` is the field file the obstacle is
   * in, for a plugin that words the label from where the obstacle sits. Null, or left out, and the
   * message names the id alone.
   */
  obstacleLabel?(id: string, field?: Field): string | null;

  /**
   * Optional: the side of the field the routine's robot has to stay on during auto, for
   * OPPONENT_SIDE (issue #365), in the frame of `alliance`, the file's own. The season decides where
   * the centre line is, which side is the alliance's own and how far past it a footprint may go, so
   * the core learns nothing about the game. Null, or left out, and nothing is checked.
   */
  ownSide?(field: Field, alliance: "RED" | "BLUE"): OwnSide | null;
}

/**
 * The line a robot may not cross during auto, and the rule that says so (`SeasonRules.ownSide`).
 * The line is `x = lineIn` when `axis` is `"x"`, and `y = lineIn` when it is `"y"`.
 */
export interface OwnSide {
  axis: "x" | "y";
  /** Where the line is, in inches along `axis`. */
  lineIn: number;
  /** 1 when the alliance's own side is where the coordinate is above `lineIn`, -1 when below. */
  ownSign: 1 | -1;
  /** How far past the line a footprint corner may go before it is over, in inches. */
  toleranceIn: number;
  /**
   * The rule and what breaking it costs, as a sentence that ends the finding's message, such as
   * "G402 (BIOBUZZ Competition Manual V1, §11.4.1): a MAJOR FOUL, and a YELLOW CARD if seen as
   * STRATEGIC."
   */
  rule: string;
}

/**
 * How far `point` is past the line into the other side, in inches: positive over the line, zero
 * on it and negative on the alliance's own side. START_ILLEGAL's own-half test and OPPONENT_SIDE
 * both measure with it, so the two can never disagree about where the line is.
 */
export const pastLineIn = (point: Vec2, side: Pick<OwnSide, "axis" | "lineIn" | "ownSign">): number =>
  (side.lineIn - (side.axis === "x" ? point.xIn : point.yIn)) * side.ownSign;

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
