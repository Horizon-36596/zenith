/**
 * Contract between the editor shell (apps/web/src/state, panels) and the field canvas
 * (apps/web/src/canvas). Two agents build against this file concurrently; change it only by
 * appending, and say so in the commit message.
 */
import type { Auto, Field, Robot } from "@horizon36596/zenith-schema";
import type {
  Estimate,
  Finding,
  Plan,
  Pose,
  ResolvedAuto,
  TracePoseRow,
  TraceStep,
} from "@horizon36596/zenith-core";

export type Tool =
  | "select"
  | "addPath"
  | "addCommand"
  | "marker"
  | "heading"
  | "pan"
  /** Appended for v2 (site/docs/editor.md): click-drag measures a distance and an angle; key `U`. */
  | "measure";
export type Alliance = "RED" | "BLUE";
export type PointKind = "from" | "to" | "control";

/** Which draggable thing on a path step is meant. */
export interface PointTarget {
  segmentIndex: number;
  pointKind: PointKind;
  /** Index into `control[]` when pointKind is "control". */
  controlIndex?: number;
}

export interface Selection {
  stepId?: string;
  point?: PointTarget;
  markerIndex?: number;
  /**
   * Appended for v2 multi-selection (site/docs/editor.md): every selected point, across steps, when
   * more than one is selected by Shift-click or by a marquee. `point` stays the primary (last
   * clicked) point so single-point code keeps working; absent or empty means only `point`.
   */
  points?: SelectedPoint[];
}

/** Appended for v2: one member of a multi-point selection. */
export interface SelectedPoint {
  stepId: string;
  point: PointTarget;
}

export interface CanvasHit {
  stepId: string;
  /** Arc-length parameter 0..1 along the whole step at the hover point, when on a path. */
  t?: number;
  point?: PointTarget;
  markerIndex?: number;
  /**
   * Appended for v2: the pointer is on the heading knob of `point`, not on the point itself. The
   * knob is gone since spec 11 section 3 (it wrote a pose heading no mode reads); nothing sets this
   * any more, and it stays only because this contract is append-only.
   */
  headingKnob?: boolean;
  /** Appended for spec 11 section 3: the key of the heading handle under the pointer (`headingHandles.ts`). */
  headingHandle?: string;
  /** Appended for spec 11 section 3a: the boundary after this range of a piecewise heading. */
  rangeBoundary?: number;
}

/**
 * What the canvas draws of a recorded run: the two parts of `core.Trace` (site/docs/simulation.md)
 * it reads. A whole `Trace` satisfies it, which is what the editor passes; a test can pass just
 * these two.
 */
export interface TraceOverlay {
  /** [timeS, xIn, yIn, headingRad] rows, in the auto's own alliance frame, drawn with its mirror. */
  poses: readonly TracePoseRow[];
  steps: readonly TraceStep[];
  /**
   * Appended for v2: seconds per row, which a whole `Trace` already carries. The canvas uses it to
   * tell a localizer reset (a jump no robot could drive) from a fast move; absent, it uses the time
   * between the two rows.
   */
  tickS?: number;
}

export interface FieldCanvasProps {
  field: Field;
  robot: Robot;
  auto: Auto;
  resolved: ResolvedAuto;
  plan: Plan;
  estimate: Estimate | null;
  findings: Finding[];
  selection: Selection;
  tool: Tool;
  /**
   * The alliance being viewed. The file's own alliance draws its poses as they are; the other one
   * draws them mirrored by the field's `frame.mirror`, and every edit made there is un-mirrored on
   * the way back, so the document stays in its own alliance's frame either way.
   */
  alliance: Alliance;
  snap: boolean;
  showGhosts: boolean;
  /** Estimated-time scrub position in seconds, or undefined when not scrubbing. */
  playbackS?: number;
  trace?: TraceOverlay | null;
  /** Static SVG from core.render, drawn under the live layer; null until M1 lands. */
  staticSvg?: string | null;

  onSelect(selection: Selection): void;
  onHover(hit: CanvasHit | null): void;
  onDragPose(stepId: string, target: PointTarget, pose: Pose): void;
  /**
   * The heading handle moved. `pose` (appended for v2) is the point's full pose with the new
   * heading and its position unchanged, so a handler can write it as it is: a heading drag never
   * moves the point (site/docs/editor.md; v1 wrote (0, 0) at `App.tsx:160`).
   */
  onDragHeading(stepId: string, target: PointTarget, headingRad: number, pose: Pose): void;
  /** Tool "addPath": user clicked a new endpoint; the shell appends a segment or a new path step. */
  onAddPathPoint(pose: Pose): void;
  /** Tool "marker": user clicked on a path at t. */
  onAddMarker(stepId: string, t: number): void;
  onDragMarker(stepId: string, markerIndex: number, t: number): void;
  /** Tool "addCommand": user clicked at a pose; the shell opens the command picker. */
  onAddCommandAt(pose: Pose): void;

  /**
   * Appended by the canvas agent: `waypoints.json`, for the named pins the static layer draws and
   * for the first snap rule (`snap.ts`). Optional, so the shell can mount the canvas without it;
   * without it there are no pins and no waypoint snapping, and nothing else changes.
   */
  waypoints?: import("@horizon36596/zenith-schema").Waypoints | null;

  /**
   * Review mode only (site/docs/github.md): the base version's plan, drawn under the head as a
   * dashed `--path-ghost` polyline so the two routines read as one picture. Optional, and null in
   * every other mode: without it nothing extra is drawn and nothing else changes.
   */
  basePlan?: import("@horizon36596/zenith-core").Plan | null;

  /**
   * Appended for the drag-undo fix: the canvas calls `onDragStart` once a pose, heading or marker
   * drag actually begins (not for a plain click, and not for a pan) and `onDragEnd` when that
   * pointer is released, so the shell can bracket the whole drag in one undo transaction regardless
   * of how long it runs. A mere click still calls these two with no edit between them, which is a
   * no-op for the shell's transaction.
   */
  onDragStart(): void;
  onDragEnd(): void;

  // ---- Appended for v2 by the canvas agent (site/docs/editor.md). ----

  /**
   * The instant preview sim's trace (`core.simulate`, site/docs/simulation.md), the pose and timing
   * source for the playback robot and the hover outline. Absent (undefined), the canvas runs the sim
   * itself on every plan change, debounced to one animation frame. Null means "no sim": the canvas
   * then times the robot from `estimate.timeAtSampleS`, which is also the fallback when the sim
   * throws. Distinct from `trace`, which is a recorded run.
   */
  previewTrace?: TraceOverlay | null;
  /** True while the shell is animating `playbackS`, so the hover outline does not compete with it. */
  playing?: boolean;
  /** The canvas's Play/Pause button. Without it no button is drawn; `Space` stays the shell's. */
  onTogglePlay?(): void;
  /**
   * Several points moved in one frame: a group drag of a multi-selection, or an endpoint carrying
   * its Bezier handles, or a smooth node mirroring its opposite handle. Apply them as one edit.
   * Without it the canvas calls `onDragPose` once per move, in order.
   */
  onDragPoses?(moves: PoseMove[]): void;
  /**
   * Double-click on a path: split the segment under the pointer at the step's arc-length `t`.
   * `at` is the same place as a segment index and that segment's own curve parameter `u`, which is
   * what `core.applyFix({ kind: "splitSegment" })` takes.
   */
  onSplitAt?(stepId: string, t: number, at: { segmentIndex: number; u: number }): void;
  /**
   * The right-click menu's items, built by the shell from the same action table as the shortcuts
   * and the palette. The canvas renders the menu and appends a few of its own (smooth or corner
   * node, split here, zoom). Without it the menu carries only the canvas's own items.
   */
  canvasActions?: CanvasActions;
  /**
   * Inserting in the middle (site/docs/editor.md): when set, the addPath rubber band starts from
   * this step's end pose instead of the routine's last pose, and so does the pose `onAddPathPoint`
   * reports continuing from.
   */
  insertAnchorStepId?: string | null;
  /** The field image layer (site/docs/editor.md). Defaults to "image+outlines". */
  fieldView?: FieldView;
  /**
   * The URL to load `field.image.src` from, resolved by the shell (relative to the field file or
   * an app asset). Without it the canvas uses `field.image.src` as it is. A missing or broken
   * image always falls back to the vector field.
   */
  fieldImageSrc?: string | null;
  /**
   * The field style: a `field.image.variants` name ("dark", "black", "light" for BIOBUZZ). Absent,
   * or a name the field does not list, draws `field.image.src`, which is the dark picture.
   * `fieldImageSrc`, when set, wins over both.
   */
  fieldImageVariant?: string | null;
  /**
   * Which level the playback robot comes from (site/docs/simulation.md, "Playback levels").
   * `ideal`, the default, is the planned path exactly on the estimate's clock
   * (`core.idealTrajectory`); `instant` is the instant sim's `previewTrace`; `full` is the recorded
   * `trace`. The robot outline is labelled with it, and the canvas publishes it and the robot's
   * pose on the element (`data-playback-level`, `data-robot-pose`).
   */
  playbackLevel?: PlaybackLevel;

  // ---- Appended for spec 11 sections 3 and 3a (heading handles). ----

  /**
   * A heading handle, a range boundary or "Split heading here" changed a step's heading mode. The
   * shell writes it the way the inspector does (`writeHeadingMode`). A drag calls it once per frame
   * inside `onDragStart`/`onDragEnd`, so the whole drag is one undo step. Without it the heading
   * handles are drawn but cannot be dragged.
   */
  onSetHeading?(stepId: string, heading: import("@horizon36596/zenith-schema").Heading): void;
  /** A stretch of one step to highlight: the inspector's hovered heading range. */
  highlightRange?: { stepId: string; startT: number; endT: number } | null;
}

/** Appended for the playback levels: where the playback robot comes from. */
export type PlaybackLevel = "ideal" | "instant" | "full";

/** Appended for v2: one point moved by a multi-point drag. */
export interface PoseMove {
  stepId: string;
  target: PointTarget;
  pose: Pose;
}

/** Appended for v2: how the field is drawn under the routine. */
export type FieldView = "image" | "image+outlines" | "vector";

/** Appended for v2: what a right-click landed on, in world inches in the file's own alliance frame. */
export interface CanvasMenuTarget {
  kind: "point" | "path" | "marker" | "field";
  stepId?: string;
  point?: PointTarget;
  markerIndex?: number;
  /** Arc-length parameter along the step, for a path. */
  t?: number;
  atIn: { xIn: number; yIn: number };
}

/** Appended for v2: one context-menu item. */
export interface CanvasAction {
  id: string;
  label: string;
  /** Display form, from `SHORTCUTS`, e.g. "Del" or "Ctrl D". */
  shortcut?: string;
  enabled: boolean;
  /** Shown as the item's tooltip when it is disabled: why it cannot run. */
  disabledReason?: string;
  /** Draw a hairline above this item. */
  separatorBefore?: boolean;
  run(): void;
}

/** Appended for v2: the shell's context-menu builder. */
export type CanvasActions = (target: CanvasMenuTarget) => CanvasAction[];
