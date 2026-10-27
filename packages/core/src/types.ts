import type { Auto, Field, Heading, Robot, Segment, Step, Waypoints } from "@horizon36596/zenith-schema";
import type { PathGeometry } from "./geometry/path.js";
import type { Pose, Vec2 } from "./geometry/vec.js";
import type { ResolvedSegment } from "./resolve.js";

/** Every check code of site/docs/checks-and-findings.md. M0 raises a subset. */
export type FindingCode =
  | "SCHEMA"
  | "CONTINUITY"
  | "HEADING_MISSING"
  | "HEADING"
  | "HEADING_RANGES"
  | "PERIMETER"
  | "STRUCTURE"
  | "CLEARANCE"
  | "KEEPOUT"
  // Issue #365: the robot crosses the centre line into the other alliance's side during auto.
  | "OPPONENT_SIDE"
  | "START_ILLEGAL"
  | "LEGAL_APPROACH"
  | "TURRET_RANGE"
  | "CAPACITY"
  | "EMPTY_SHOT"
  | "LAUNCH_TARGET"
  | "STRAFE_FRACTION"
  | "MOUTH_LEADING"
  | "SWEEP_SPEED"
  | "TIME_BUDGET"
  | "TIMEOUT_TIGHT"
  | "WAIT_NO_TIMEOUT"
  | "STATIONARY_MARKER"
  | "MOVES_ROBOT"
  | "PROVENANCE"
  | "ENVELOPE_SHAPE"
  | "TRANSFER"
  // An explicit step id outside the step id rule (`STEP_ID_NAME_PATTERN`), from a file written before it.
  | "STEP_ID"
  // The alliance checks of spec 13 section 9. `checkAlliance` raises them,
  // never `check`, so they never change what `zenith validate` says about an auto.
  | "ALLIANCE_COLLISION"
  | "ALLIANCE_NEAR_MISS"
  | "ALLIANCE_START_OVERLAP"
  | "ALLIANCE_ELEMENT_CONFLICT"
  | "ALLIANCE_ENVELOPE"
  // The proposal checks of spec 13 section 14. `validateProposal` and
  // `applyProposalToAuto` raise them, never `check`, so they never change what `zenith validate`
  // says about an auto.
  | "PROPOSAL_SHARE"
  | "PROPOSAL_STALE"
  | "PROPOSAL_TOKEN"
  | "PROPOSAL_CHANGE"
  | "PROPOSAL_CONFLICT"
  // robot.json against the robot's Java (Zenith's ADR 0014). Only
  // `zenith validate --java` and `zenith import-commands` raise it, never `check`.
  | "REGISTRY";

export type Severity = "error" | "warning" | "info";

/** What a finding points at on the field, when it points at anything. */
export interface FindingGeometry {
  pointIn?: Vec2;
  polygonIn?: Vec2[];
  obstacleId?: string;
  zoneId?: string;
  penetrationIn?: number;
  /** For CLEARANCE: how far the robot stays from the obstacle where it comes nearest, in inches. */
  gapIn?: number;
  /**
   * For a footprint finding along a path (PERIMETER, STRUCTURE, CLEARANCE, KEEPOUT, OPPONENT_SIDE): the robot's pose at the
   * sample where the violation is worst, the farthest outside the field or the deepest into the
   * obstacle or zone. It is the pose at the finding's `t`.
   */
  poseIn?: Pose;
  /**
   * The footprint polygons the check tested at `poseIn`, body first and then one per mouth, so a
   * consumer can draw the robot where it clips without knowing which footprint the plan used.
   */
  footprintIn?: Vec2[][];
  /** Which polygon of `footprintIn` is the one that went out the farthest or in the deepest. */
  worstPolygonIndex?: number;
  /**
   * For STRUCTURE along a path: the stretch of the step, as `[startT, endT]`, over which the robot
   * stays in contact with the obstacle without a break, the one that holds the finding's `t`; for
   * OPPONENT_SIDE, the stretch it stays over the centre line; for STRAFE_FRACTION, which has no
   * `t`, from the first sample driven sideways to the last. The editor tints all of it. Both ends are the same `t` when only one sample touches.
   */
  tRange?: [number, number];
  /**
   * For STRAFE_FRACTION only, when the robot drives sideways in more than one stretch: each stretch,
   * as `[startT, endT]` in order, which `tRange` spans. The editor tints each one.
   */
  tRanges?: [number, number][];
  /** How far the robot drives in contact over `tRange`, in inches of arc length; 0 for one sample. */
  contactIn?: number;
}

/** The finding shape of site/docs/checks-and-findings.md. */
export interface Finding {
  severity: Severity;
  stepId: string;
  /**
   * For a finding about the whole routine, whose `stepId` is `"total"`: the steps its message
   * names, in the order it names them. The editor selects the first one when the finding is opened.
   */
  stepIds?: string[];
  t?: number;
  /**
   * Seconds from the start of the auto, for a finding about a moment rather than a place along a
   * path: the alliance checks set it, since they compare two robots in time. `t` stays the path
   * fraction it is everywhere else.
   */
  timeS?: number;
  code: FindingCode;
  message: string;
  geometry?: FindingGeometry;
  /**
   * The one-click fixes the editor offers on this finding (site/docs/editor.md). Each one is
   * structured, so `applyFix` can carry it out on the document without the editor knowing anything
   * about the check that raised it.
   */
  fixes?: Fix[];
}

/** The one-click fixes of `05` section 3, as data the editor can apply. */
export type FixKind =
  // Added for issue #146: a segment that starts away from the end of the segment before it.
  | "joinSegments"
  | "raiseTimeout"
  | "focusTimeout"
  | "makeTangent"
  | "turnAtPreviousStop"
  | "slowSweep"
  | "moveToLegalApproach"
  | "splitSegment"
  | "linearHeading"
  // Added for issue #186: the fixes the help text promised and no check offered.
  | "splitHeadingRange"
  | "startFromCurrent"
  | "pushBack"
  // Added for Optimize path: a whole new route, and the way to ask for one.
  | "replaceRoute"
  | "optimizeRoute"
  // Added for STEP_ID: an old id renamed to one inside the rule, with every reference to it.
  | "renameStep";

interface FixBase {
  /** The step the fix rewrites, which is not always the step the finding points at. */
  stepId: string;
  /** What the button says, in the words a person would use. */
  label: string;
}

export type Fix =
  /** Sets segment `segmentIndex`'s `from` to the `to` of the segment before it. */
  | (FixBase & { kind: "joinSegments"; params: { segmentIndex: number } })
  /** Sets the step's `timeoutS` (TIMEOUT_TIGHT). */
  | (FixBase & { kind: "raiseTimeout"; params: { timeoutS: number } })
  /**
   * Points the editor at the step's Timeout field and writes no number, because only the person
   * knows how long the robot may wait (WAIT_NO_TIMEOUT). `applyFix` leaves the document as it is.
   */
  | (FixBase & { kind: "focusTimeout"; params: Record<string, never> })
  | (FixBase & { kind: "makeTangent"; params: { reversed?: boolean } })
  | (FixBase & {
      kind: "turnAtPreviousStop";
      params: { headingRad: number; fromRad?: number; turnInStepId?: string };
    })
  | (FixBase & { kind: "slowSweep"; params: { speedFraction: number } })
  | (FixBase & {
      kind: "moveToLegalApproach";
      /**
       * Where the leg's end moves to, the heading it carries, and, when the leg's own heading would
       * not keep the same side of the robot toward the target from there, the heading the leg gets
       * instead. `aim` says how the heading was chosen: `"fixed"` keeps the same side of a fixed
       * launcher toward the target, `"turret"` puts the target in the turret's range.
       * `addsWarning` is the message of the warning the move adds, set only when no spot nearby moves
       * the end without adding one. `applyFix` ignores both.
       */
      params: { xIn: number; yIn: number; headingRad?: number; heading?: Heading; aim?: "fixed" | "turret"; addsWarning?: string };
    })
  /**
   * Cuts segment `segmentIndex` in two at its own curve parameter `u` (0.5 when left out), or into
   * several pieces at `atFractions`, ascending fractions of the segment's arc length in (0, 1). The
   * new points carry SET FROM EDITOR, and so do the handles a curve's pieces get. Splitting needs the
   * segment's ends as numbers, so for an end that is `"current"` or a waypoint, `fromIn` and `toIn`
   * carry where it resolved to; the pieces still start and end at the original `from` and `to`.
   */
  | (FixBase & {
      kind: "splitSegment";
      params: { segmentIndex: number; u?: number; atFractions?: number[]; fromIn?: Vec2; toIn?: Vec2 };
    })
  /**
   * Cuts range `rangeIndex` of a `piecewise` heading into `parts` ranges of equal width. A `linear`
   * range is cut at the headings its sweep passes through, so each piece turns its share of it.
   */
  | (FixBase & { kind: "splitHeadingRange"; params: { rangeIndex: number; parts: number } })
  /**
   * Sets the step's first segment to start from `"current"`, where the robot is
   * (`repairContinuity`): CONTINUITY at the start of a step, and MOVES_ROBOT.
   */
  | (FixBase & { kind: "startFromCurrent"; params: Record<string, never> })
  /**
   * Moves the end of the step's last segment, an inline pose, to (`xIn`, `yIn`) and keeps its
   * heading: PERIMETER or STRUCTURE where the robot is deepest at the path's end. `clearOf` names
   * the obstacle the end moves clear of, the way the season names it; it is left out for the wall,
   * and `applyFix` ignores it.
   */
  | (FixBase & { kind: "pushBack"; params: { xIn: number; yIn: number; clearOf?: string } })
  /**
   * Gives the path a `linear` heading from `fromRad` to `toRad`, so the robot turns gradually while
   * it drives instead of on the spot where the path starts (PERIMETER where a path turns against
   * the wall it starts on).
   */
  | (FixBase & { kind: "linearHeading"; params: { fromRad: number; toRad: number } })
  /**
   * Replaces a path step's `segments` and `heading` with a route the optimizer found, and nothing
   * else: it is `setRoute` (`edit/path.ts`), so it keeps the step's first `from` and last `to`. A
   * route that would move an end leaves the document as it is.
   */
  | (FixBase & { kind: "replaceRoute"; params: { segments: Segment[]; heading: Heading } })
  /**
   * Asks the editor to open Optimize path on the step. Without `mode` it opens in Route around mode
   * (STRUCTURE, CLEARANCE, PERIMETER, KEEPOUT), aimed at `obstacleId` or `zoneId` when the finding
   * names one. With `mode: "headingOnly"` it opens as Find a faster heading (STRAFE_FRACTION), which
   * keeps the path's segments as written. It writes nothing: `applyFix` leaves the document as it
   * is, as it does for `focusTimeout`, because the route is the person's to preview and apply.
   */
  | (FixBase & { kind: "optimizeRoute"; params: { obstacleId?: string; zoneId?: string; mode?: "headingOnly" } })
  /**
   * Renames the step to `newId`, an id inside the step id rule, the way `renameStep` does, so a
   * parallel group's `deadline` that named the old id names the new one (STEP_ID). A `newId` that is
   * taken by then leaves the document as it is.
   */
  | (FixBase & { kind: "renameStep"; params: { newId: string } });

/** One place along a path step where the robot's pose and footprint were worked out. */
export interface PlanSample {
  /** Arc length along this step, in inches. */
  sIn: number;
  /** Arc length normalised over the whole step, in [0, 1]; the same t markers use. */
  t: number;
  pose: Pose;
  /** The expanded footprint, four corners counter-clockwise. */
  footprintIn: Vec2[];
  /** One polygon per mouth in `robot.json`. */
  mouthsIn: Vec2[][];
}

export interface PlanStep {
  id: string;
  kind: Step["kind"];
  step: Step;
  startPose: Pose;
  /**
   * Where the step leaves the robot. For a `movesRobot` command, whose end nobody can predict, it is
   * the next path's rejoin pose when one applies (the intended end the drift moves to, `drift.ts`),
   * else where the step started. Null only where a planner has no pose at all.
   */
  endPose: Pose | null;
  lengthIn: number;
  samples: PlanSample[];
  geometry?: PathGeometry;
  /** The resolved segments of a path step, for the continuity check and the inspector. */
  segments?: ResolvedSegment[];
  /** Parallel and branch steps carry their children here. */
  children?: PlanStep[];
}

export interface Plan {
  auto: Auto;
  robot: Robot;
  field: Field;
  startPose: Pose;
  steps: PlanStep[];
  /** Findings raised while resolving and planning: SCHEMA, CONTINUITY, HEADING_MISSING. */
  findings: Finding[];
}

/** Per-step timing from the estimate's time model (`estimate.ts`). */
export interface StepEstimate {
  stepId: string;
  kind: Step["kind"];
  /** Seconds, or null when the step's duration cannot be predicted. */
  nominalS: number | null;
  lowS: number | null;
  highS: number | null;
  /** The share of a path step's arc length driven more sideways than forwards, in [0, 1]. */
  strafeFraction: number | null;
  /**
   * What that sideways driving costs against the same path driven nose-first, in seconds, each with
   * the turn on the spot it opens with; 0 when driving it nose-first would not be faster.
   */
  strafeCostS: number | null;
  /**
   * True when the seconds are not a prediction: either the step has no predictable duration at all
   * (`nominalS` is null and it counts as zero in the total, making the total a lower bound), or it
   * ends on a sensor and `nominalS` is the upper bound of driving the whole path.
   */
  unknown: boolean;
  /** How fast the robot is still moving as the step ends; the next step accelerates from it. */
  exitVelocityInPerS: number;
  /**
   * True when `nominalS` is the step's envelope window (`envelope.maxDurationS`) because the step
   * has no estimate of its own: the longest it runs, as its author declared, not a prediction.
   */
  fromEnvelope?: boolean;
  /**
   * True when, as well, the envelope's what-if `actualDurationS` is what `nominalS` reads: how long
   * the author previews the step running this time, shorter than the window (issue #481).
   */
  fromActualDuration?: boolean;
  /**
   * For a path step, the cumulative seconds at each of the plan's samples, so a caller can turn a
   * time into a place on the path: the renderer's footprint ghosts and the editor's playback
   * scrubbing both need it, and both would otherwise have to redo the profile.
   */
  timeAtSampleS?: readonly number[];
  /**
   * For a path step that starts where the robot is but facing another way, the seconds it turns in
   * place before it drives (the joint turn, `03` section 3 step 8), already inside `nominalS`. The
   * drive, and so `timeAtSampleS`, starts this long after the step does. Absent when there is none.
   */
  turnS?: number;
  /**
   * For a step whose `timeoutS` is shorter than its estimate, the seconds it would take without the
   * timeout. The robot stops it when the timeout runs out, so `nominalS` and `highS` are the timeout
   * (TIMEOUT_TIGHT reads this to say where it stops). Absent when the timeout does not cut it short.
   */
  uncappedS?: number;
  /** Parallel and branch children, in the order they appear in the file. */
  children?: StepEstimate[];
}

export interface Estimate {
  steps: StepEstimate[];
  /** Every step including parallel and branch children, by id, for the editor and the checks. */
  byStepId: Readonly<Record<string, StepEstimate>>;
  nominalS: number | null;
  lowS: number | null;
  highS: number | null;
  /** True when at least one step's estimate is `unknown`, so the total is a bound, not a number. */
  hasUnknown: boolean;
  /** The half-width of the band as a fraction of nominal: 0.2 until `07` fits a recorded run. */
  bandFraction: number;
  /** The assumptions behind the numbers, for `zenith estimate --explain`. */
  assumptions: string[];
  /** The same sentences as `assumptions`, under the name `zenith estimate --explain` prints. */
  explain: string[];
}

/** One row of the ledger panel and of the pull-request body (site/docs/seasons.md). */
export interface LedgerRow {
  stepId: string;
  label: string;
  detail?: string;
  holds?: Record<string, number>;
}

export interface RenderOptions {
  /** The field's own width in pixels; the picture is wider than this when the ledger is shown. */
  widthPx?: number;
  heightPx?: number;
  /** Draw the routine for this alliance, mirroring it when it is not the one the file is in. */
  alliance?: "RED" | "BLUE";
  showFindings?: boolean;
  showLedger?: boolean;
  /** Seconds of estimated time between footprint ghosts; the default is 0.5. */
  ghostEveryS?: number;
  /** Inches between footprint ghosts when there is no estimate; the default is 12. */
  ghostEveryIn?: number;
  /** A second plan to ghost underneath, for reviewing a change (`06` section 4). */
  base?: Plan;
  /** The named poses to pin, when the caller has them. */
  waypoints?: Waypoints;
  /**
   * Names of `waypoints` to leave out of the picture, so the editor's export shows the pins its
   * field shows (web issue #236). Absent pins every one.
   */
  hiddenWaypoints?: readonly string[];
  /** Overrides the title in the picture's header. */
  title?: string;
  /**
   * The picture `field.image` names, already read by the caller (core reads no files): an `href`
   * such as a `data:` URI, and the stored image's size in pixels, which a `pxBoundsIn` crop needs.
   * When it is absent, or the field has no image, or a crop is asked for without the size, the
   * field is drawn as vector alone.
   */
  fieldImage?: { href: string; widthPx?: number; heightPx?: number };
}

export type AutoDiffChangeKind = "added" | "removed" | "changed" | "moved";

/** How far one pose moved between two versions of a step. */
export interface PoseDelta {
  /** Where the pose sits in the step, such as `segments[0].to` or `segments[1].control[0]`. */
  where: string;
  dxIn: number;
  dyIn: number;
  /** The short-way heading change, or null when neither version names a heading. */
  dHeadingRad: number | null;
  distanceIn: number;
}

export interface AutoDiffChange {
  kind: AutoDiffChangeKind;
  stepId: string;
  /** One sentence naming what happened to this step. */
  summary: string;
  /** For a changed step, the keys that differ, in the schema's own order. */
  fields?: string[];
  /** For a changed path step, how far each pose moved. */
  poseDeltas?: PoseDelta[];
  /** Where the step sat in each version, for a move. */
  fromIndex?: number;
  toIndex?: number;
}

export interface AutoDiff {
  changes: AutoDiffChange[];
  /** Keys of the document itself that differ: name, title, description, alliance, start. */
  header: string[];
  identical: boolean;
}
