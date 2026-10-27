/**
 * Contract between the editor shell (apps/web/src/state, panels) and the field canvas
 * (apps/web/src/canvas). Two agents build against this file concurrently; change it only by
 * appending, and say so in the commit message.
 */
import type { Auto, Field, Robot } from "@horizon36596/zenith-schema";
import type { LucideIcon } from "lucide-react";
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
  /**
   * Appended for the start-pose drag: the routine's start mark is selected, so the arrow keys and
   * the rotate key act on `auto.start.pose`. It is set on its own, with no `stepId` or `point`.
   */
  start?: boolean;
  /**
   * Appended for waypoint editing (issue #134): the name of the selected waypoint pin, which the
   * arrow keys nudge, the rotate key turns and the inspector shows. Set on its own, like `start`.
   */
  waypoint?: string;
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
  /**
   * Appended for spec 13 section 10: the 0-based index of the envelope corner under the pointer.
   * Nothing sets it since envelopes are edited as rectangles (issue #120; see `envelopeHandle`); it
   * stays because this contract is append-only.
   */
  envelopeCorner?: number;
  /**
   * Appended for the start-pose drag: the pointer is on the routine's start mark. The start belongs
   * to no step, so `stepId` is then the empty string and no other field is set.
   */
  start?: boolean;
  /**
   * Appended for the start-pose rotate handle: the pointer is on the start's heading knob. As with
   * `start`, `stepId` is then the empty string and no other field is set.
   */
  startKnob?: boolean;
  /**
   * Appended for rectangle envelopes (issue #120): the handle of the selected step's envelope under
   * the pointer, a corner or a side by compass direction in the file's own frame, or `"move"` for a
   * press inside it.
   */
  envelopeHandle?: import("../lib/envelopeRect.js").RectGrab;
  /**
   * Appended for waypoint editing (issue #134): the pointer is on this waypoint's pin, its ring, stem
   * or name. As with `start`, `stepId` is then the empty string and no other field is set.
   */
  waypoint?: string;
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
  /**
   * Start a new path with the previous path's end heading (`editing.newPathKeepsHeading`, issue
   * #435): the add-path preview and click then keep the heading the robot arrives with at the new
   * point, rather than the bearing it drives along.
   */
  keepNewPathHeading?: boolean;
  showGhosts: boolean;
  /** Estimated-time scrub position in seconds, or undefined when not scrubbing. */
  playbackS?: number;
  trace?: TraceOverlay | null;
  /** Static SVG from core.render, drawn under the live layer; null until M1 lands. */
  staticSvg?: string | null;

  onSelect(selection: Selection): void;
  onHover(hit: CanvasHit | null): void;
  onDragPose(stepId: string, target: PointTarget, pose: MovedPose): void;
  /**
   * The heading handle moved. `pose` (appended for v2) is the point's full pose with the new
   * heading and its position unchanged, so a handler can write it as it is: a heading drag never
   * moves the point (site/docs/editor.md; v1 wrote (0, 0) at `App.tsx:160`).
   */
  onDragHeading(stepId: string, target: PointTarget, headingRad: number, pose: Pose): void;
  /**
   * Tool "addPath": user clicked a new endpoint; the shell appends a segment or a new path step.
   *
   * Appended for issue #150: `pose` is snapped exactly as the add-path preview showed it, and
   * `waypoint` names the waypoint it snapped onto, which the new end then follows.
   */
  onAddPathPoint(pose: Pose, waypoint?: string): void;
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
   * Appended for issue #236: the waypoints whose pins this person hid (`state/waypointPins.ts`). A
   * hidden pin is not drawn, cannot be hovered or pressed and is no snap target; the selected one
   * still draws, faint and dashed, and can be dragged. Absent hides none.
   */
  hiddenWaypoints?: ReadonlySet<string>;

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
  /**
   * Appended for issue #151: names the auto the shell has open, such as its file name. When it
   * changes, another auto has been opened in the same canvas, and the canvas works out what a fit
   * frames for that auto and fits a view the user has not panned or zoomed to it. Absent, the auto
   * the canvas mounted with is the only one it shows.
   */
  openedAuto?: string | null;
  /** True while the shell is animating `playbackS`, so the hover outline does not compete with it. */
  playing?: boolean;
  /**
   * Kept so the callers still compile: the canvas draws no Play/Pause button of its own since issue
   * #412 (the toolbar's and the scrubber's play), so this is never called. `Space` stays the shell's.
   */
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
  /** How much of the field's grid the static layer draws. Absent means Tiles. A field picture draws no grid. */
  fieldGrid?: FieldGrid;
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

  // ---- Appended for spec 13 section 10 (envelope corners). ----

  /**
   * A corner of the selected step's envelope was dragged to `corner`, in field inches in the file's
   * own frame (the mirror is already off). The shell writes it with `setEnvelopeCorner`. A drag
   * calls it once per frame inside `onDragStart`/`onDragEnd`, so the whole drag is one undo step.
   * Without it the corners are drawn but cannot be dragged.
   */
  onDragEnvelopeCorner?(stepId: string, cornerIndex: number, corner: import("@horizon36596/zenith-core").Vec2): void;

  // ---- Appended for the ball ledger (site/docs/file-format.md, "Transfers"). ----

  /**
   * The ledger run and its season, at the playback time: the hives drawn from it (`hiveLayer.ts`),
   * which move whether or not the Ledger switch is on, and the count badges at every hive cell,
   * flower, floor quarter and loading zone (`ledgerBadges.ts`), which `showLedgerCounts` gates.
   * Absent or null draws no badges, and the hives as the field file stages them.
   */
  ledger?: import("./ledgerBadges.js").CanvasLedger | null;
  /** Whether to draw those counts. Absent means shown. */
  showLedgerCounts?: boolean;
  /**
   * Whether to draw the paths' markers and let them be hit. Absent means shown; false while the
   * Commands switch is off (`state/features.ts`).
   */
  showMarkers?: boolean;
  /**
   * Whether a path's right-click menu offers "Split heading here" on a path that is not piecewise
   * yet. Absent means offered; false while the Advanced heading switch is off
   * (`state/features.ts` `piecewiseOffered`). A piecewise path is offered it either way.
   */
  newPiecewise?: boolean;

  // ---- Appended for the alliance view (spec 13 section 9). ----

  /**
   * The alliance partners to draw at this moment (`alliance/model.ts` `buildPartnerScene`), in
   * the file's own alliance frame: each box, its trajectory and its active envelopes, painted
   * under the live layer. Absent or empty draws nothing.
   */
  partners?: readonly import("../alliance/model").PartnerDraw[];

  // ---- Appended for the clip ghosts. ----

  /**
   * Whether to draw the clip ghosts: the robot in red where a path clips the wall, a structure or a
   * keep-out zone (`clipGhosts.ts`). Absent means shown.
   */
  clipGhosts?: boolean;
  /**
   * Whether the robot outline at the playhead also draws its footprint grown by the robot's
   * clearance from field elements (`display.clearanceOutline`, owner ruling D8). Absent means hidden.
   */
  clearanceOutline?: boolean;
  /** `findingKey` of the finding the problems panel is hovering, whose ghost is emphasised. */
  hoveredFindingKey?: string | null;

  // ---- Appended for issue #230: the hive frame's legs. ----

  /**
   * Whether to draw the dashed outlines of structure the robot passes under: each whole hive frame
   * leg, the crossbar and an overhead hive envelope (`structureLayer.ts`). Absent means drawn. The
   * band of a leg below the robot's top is drawn either way.
   */
  overheadOutlines?: boolean;

  // ---- Appended for the start-pose drag. ----

  /**
   * The start mark was dragged with the select tool. `pose` is the new start in the file's own
   * alliance frame, with the heading the start had at the press. A drag calls it once per frame
   * inside `onDragStart`/`onDragEnd`, so the whole drag is one undo step. It is called for a start
   * that follows a waypoint too, which the shell then makes a pose of its own (issue #133). Without
   * it the start mark is drawn and hovered but cannot be dragged.
   *
   * Appended for issue #133: `carried` lists the path points that sat on the start when the drag
   * began (`pointsOnStart` in `scene.ts`), the same list every frame; the shell moves them with the
   * start, so the route stays joined to it.
   */
  onDragStartPose?(pose: Pose, carried?: readonly SelectedPoint[]): void;
  /**
   * Appended for the start-pose rotate handle: the start's heading knob was turned. `headingRad` is
   * the new start heading in the file's own alliance frame. Called once per frame inside
   * `onDragStart`/`onDragEnd`, so the whole turn is one undo step, for a start that follows a
   * waypoint too (issue #133). Without it no knob is drawn.
   */
  onTurnStartPose?(headingRad: number): void;

  // ---- Appended for rectangle envelopes (issue #120). ----

  /**
   * The selected step's envelope was resized or moved on the field: `polygon` is its new rectangle,
   * four corners counter-clockwise from the south-west one, in the file's own frame. The shell
   * writes it with `setEnvelope`, keeping the window and the provenance. Called once per frame
   * inside `onDragStart`/`onDragEnd`, so the whole drag is one undo step. Without it the handles
   * are drawn but cannot be dragged.
   */
  onSetEnvelopePolygon?(stepId: string, polygon: import("@horizon36596/zenith-core").Vec2[]): void;
  /**
   * The step whose new envelope the next drag on the field draws, from one corner to the opposite,
   * whatever the press lands on; null or absent when no envelope is being drawn.
   */
  drawEnvelopeFor?: string | null;
  /**
   * One frame of drawing that envelope: the rectangle so far, as `onSetEnvelopePolygon` gives it.
   * Called inside `onDragStart`/`onDragEnd`, so drawing it is one undo step.
   */
  onDrawEnvelope?(stepId: string, polygon: import("@horizon36596/zenith-core").Vec2[]): void;

  /**
   * True while the palette's Add waypoint is waiting for a click (issue #234): the field shows the
   * Add path preview, and the next click anywhere on it calls `onPlaceWaypoint` instead of doing
   * what the tool does. Absent or false otherwise.
   */
  placeWaypointArmed?: boolean;
  /**
   * That click: where an Add path click there would put its point, and the pin it snapped onto.
   * The pose is undefined where an Add path click would place nothing, so the shell can say why.
   */
  onPlaceWaypoint?(pose: Pose | undefined, waypoint?: string): void;

  // ---- Appended for waypoint editing (issue #134). ----

  /**
   * A waypoint pin was dragged with the select tool. `pose` is the waypoint's new pose, in the frame
   * the pins are drawn in (`waypoints.json`'s own, never mirrored), with the heading it had at the
   * press. Called once per frame inside `onDragStart`/`onDragEnd`, so the whole drag is one undo
   * step. Without it the pins are drawn but cannot be selected or dragged on the field.
   */
  onDragWaypoint?(name: string, pose: Pose): void;

  /**
   * The pins that take their first press as a select (decision D12, `app/pinProtection.ts`): a press
   * on one of these that is not the selected pin selects it and starts no drag, so the next
   * press-drag moves it. The canvas reads no setting; the shell lists the pins, none while the
   * setting is off.
   */
  protectedPins?: ReadonlySet<string>;

  /** A press only selected a protected pin: the shell selects it and says why it did not move. */
  onProtectedPinPress?(name: string): void;

  /**
   * Appended for issue #233: a waypoint pin was double-clicked with the select tool, which asks to
   * rename it without moving it. Without it a double-click on a pin does nothing.
   */
  onRenameWaypoint?(name: string): void;

  // ---- Appended for issue #148 (cancelling a press). ----

  /**
   * An edit drag was cancelled: Escape during it, or the browser cancelled its pointer or took its
   * capture away. It comes in place of `onDragEnd`, and the shell takes back everything the drag
   * did since `onDragStart`, pushing no undo entry. Without it the canvas calls `onDragEnd`, which
   * keeps the drag's edits as they stand.
   */
  onDragCancel?(): void;

  // ---- Appended for issue #308 (the Optimize card's preview). ----

  /**
   * While the Optimize card is open, what the field draws for it (`optimize/preview.ts`): the
   * proposed route as a second scene that nothing can press, its joints, the margin round nearby
   * structures and an infeasible run's clip ghost. Hovering the route moves the one robot outline
   * onto it. Absent or null draws nothing.
   */
  candidate?: CandidateOverlay | null;
}

/** Appended for issue #308: the Optimize card's preview, as the shell hands it to the canvas. */
export interface CandidateOverlay {
  stepId: string;
  /** The auto with the proposed route, planned; null while there is no route to show. */
  plan: Plan | null;
  jointsIn: readonly { xIn: number; yIn: number }[];
  marginOutlines: readonly { id: string; polygonIn: readonly { xIn: number; yIn: number }[] }[];
  ghostPoseIn: Pose | null;
}

/** Appended for the playback levels: where the playback robot comes from. */
export type PlaybackLevel = "ideal" | "instant" | "full";

/**
 * Appended for v2: one point moved by a multi-point drag. A Bezier control's pose carries no
 * heading: the runtime and Pedro ignore one, so writing it would only add noise to the file (N82).
 */
export interface PoseMove {
  stepId: string;
  target: PointTarget;
  pose: MovedPose;
  /**
   * Appended for issue #150: the waypoint the drag snapped this point onto, when it did. A path end
   * then follows it (`{ ref }`), and a Bezier handle, which cannot, takes its numbers with the
   * waypoint's provenance.
   */
  waypoint?: string;
}

/** Where a drag puts a point: an endpoint's pose, or a control point's position alone. */
export type MovedPose = Omit<Pose, "headingRad"> & { headingRad?: number };

/** Appended for v2: how the field is drawn under the routine. */
export type FieldView = "image" | "image+outlines" | "vector";

/** How much of the field's grid is drawn (`staticLayer.ts`, spec 15 section 10); the same union as `FieldGrid` in the preferences. */
export type FieldGrid = "off" | "tiles" | "12" | "6";

/** Appended for v2: what a right-click landed on, in world inches in the file's own alliance frame. */
export interface CanvasMenuTarget {
  /**
   * "waypoint" (a waypoint pin) and "start" (the routine's start mark) were appended for issue
   * #233; the canvas selects either before it asks for the menu.
   */
  kind: "point" | "path" | "marker" | "field" | "waypoint" | "start";
  /** For kind "waypoint": the name of the pin under the pointer. */
  waypoint?: string;
  /**
   * For a point or the start: the pins within reach of the pointer, nearest first, which the dot or
   * the start mark covers. The menu offers to select each, so a pin no point follows is reachable.
   */
  nearWaypoints?: string[];
  stepId?: string;
  point?: PointTarget;
  markerIndex?: number;
  /** Arc-length parameter along the step, for a path. */
  t?: number;
  atIn: { xIn: number; yIn: number };
  /**
   * Appended for issue #150, on the empty field: where an add-path click at `atIn` would put its
   * point, snapped the same way, and the waypoint it snapped onto, so "Add a path to here" writes
   * what the click would. Absent where a click would add nothing there.
   */
  snappedIn?: { xIn: number; yIn: number; headingRad: number; waypoint?: string };
}

/** Appended for v2: one context-menu item. */
export interface CanvasAction {
  id: string;
  label: string;
  /** Display form, from `keyLabel`, e.g. "Del" or "Ctrl D". */
  shortcut?: string;
  enabled: boolean;
  /** Shown as the item's tooltip when it is disabled: why it cannot run. */
  disabledReason?: string;
  /** What an enabled item does, for its tooltip, when its label alone does not say. */
  hint?: string;
  /** Draw a hairline above this item. */
  separatorBefore?: boolean;
  /**
   * Issue #412: a quiet label drawn above this item that names the group it starts, such as
   * "Waypoint scoreNorth" or "Pins". The items after it, up to the next separator, belong to it.
   */
  groupLabel?: string;
  /** Issue #412: a choice among several, drawn with a check when it is the current one. */
  checked?: boolean;
  /**
   * The item's 16 px glyph in the menu's leading column (UI_GUIDE 9.10), the same one its action
   * shows in the toolbar, the row menu and the palette. A choice shows its check there instead.
   */
  icon?: LucideIcon;
  run(): void;
}

/** Appended for v2: the shell's context-menu builder. */
export type CanvasActions = (target: CanvasMenuTarget) => CanvasAction[];
