import type { Auto, Field, Robot, Step, Waypoints } from "@horizon36596/zenith-schema";
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
  | "KEEPOUT"
  | "START_ILLEGAL"
  | "LEGAL_APPROACH"
  | "TURRET_RANGE"
  | "CAPACITY"
  | "EMPTY_SHOT"
  | "STRAFE_FRACTION"
  | "MOUTH_LEADING"
  | "SWEEP_SPEED"
  | "TIME_BUDGET"
  | "TIMEOUT_TIGHT"
  | "STATIONARY_MARKER"
  | "MOVES_ROBOT"
  | "PROVENANCE";

export type Severity = "error" | "warning" | "info";

/** What a finding points at on the field, when it points at anything. */
export interface FindingGeometry {
  pointIn?: Vec2;
  polygonIn?: Vec2[];
  obstacleId?: string;
  zoneId?: string;
  penetrationIn?: number;
}

/** The finding shape of site/docs/checks-and-findings.md. */
export interface Finding {
  severity: Severity;
  stepId: string;
  t?: number;
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

/** The five one-click fixes of `05` section 3, as data the editor can apply. */
export type FixKind =
  | "makeTangent"
  | "turnAtPreviousStop"
  | "slowSweep"
  | "moveToLegalApproach"
  | "splitSegment";

interface FixBase {
  /** The step the fix rewrites, which is not always the step the finding points at. */
  stepId: string;
  /** What the button says, in the words a person would use. */
  label: string;
}

export type Fix =
  | (FixBase & { kind: "makeTangent"; params: { reversed?: boolean } })
  | (FixBase & {
      kind: "turnAtPreviousStop";
      params: { headingRad: number; fromRad?: number; turnInStepId?: string };
    })
  | (FixBase & { kind: "slowSweep"; params: { speedFraction: number } })
  | (FixBase & {
      kind: "moveToLegalApproach";
      params: { xIn: number; yIn: number; headingRad?: number };
    })
  | (FixBase & { kind: "splitSegment"; params: { segmentIndex: number; u?: number } });

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
  /** Null when the step is a `movesRobot` command, whose end pose nobody can predict. */
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
  /** What that sideways driving costs against the same path driven nose-first, in seconds. */
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
   * For a path step, the cumulative seconds at each of the plan's samples, so a caller can turn a
   * time into a place on the path: the renderer's footprint ghosts and the editor's playback
   * scrubbing both need it, and both would otherwise have to redo the profile.
   */
  timeAtSampleS?: readonly number[];
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
