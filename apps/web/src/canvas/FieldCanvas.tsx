/**
 * The field canvas of the Zenith editor (site/docs/editor.md).
 *
 * One `<canvas>` element carrying two layers. The static layer is the field (the picture, its
 * outlines, or the vector field), painted into an offscreen canvas and repainted when the document,
 * the size, the theme, the field image or the view changes. A frame where only the live layer
 * changes (a drag, a hover, playback) blits the cached layer as it is. A pan, a zoom or a fit
 * repaints it at the new view in that same frame, so the whole field is there while the view moves
 * (issue #151); only a field picture whose paint measures slow blits the cached picture under the
 * new transform instead and is repainted sharp once the view settles. The live layer owns paths,
 * handles, markers, the robot outline, the readouts, the marquee and the measure overlay.
 *
 * Interaction, in one place (the table the tour and the help overlay read is `help.ts`):
 * - Click selects, Shift-click adds a point to the selection, a drag on empty field draws a marquee,
 *   dragging a selected point moves the whole selection, dragging any other point selects it, `Esc`
 *   clears. `Esc` during a drag cancels the drag instead, and so does a pointer the browser cancels.
 *   A press belongs to the pointer that started it; a second finger is ignored until it ends.
 * - Where steps overlap, a click, a hover, a double-click and the context menu all keep the selected
 *   step (`hit.ts`), and Alt+click with the select tool moves to the next step under the pointer.
 * - While dragging, Ctrl inverts snap, Alt turns off the quantising snaps, Shift constrains
 *   (`modifiers.ts`). The drag bubble next to the cursor says what is acting.
 * - Heading arrows turn the step's heading mode (spec 11 section 3, `headingHandles.ts`): a
 *   Constant's two arrows turn together, a Linear's start and end turn apart, Tangent arrows only
 *   show the way, a facing point drags. Ticks between piecewise ranges drag along the path.
 *   `onSetHeading` carries each frame's heading mode.
 * - Bezier nodes are smooth or corner (`bezier.ts`), toggled with `S`/`C` or the context menu.
 * - Right-click opens the context menu built from `canvasActions` plus the canvas's own items.
 * - Double-click a path to split it there; double-click empty field to fit the field and the
 *   routine (`fitBounds`); `F` zooms to the selection; the `measure` tool drags a dimension.
 *
 * Coordinates: world inches in, world inches out, in the frame of the file's own `alliance`. Screen
 * pixels exist only between `view.ts` and the painters. Viewed as its own alliance a file is drawn
 * as it is, where the robot drives it. Viewed as the other alliance it is drawn mirrored by the
 * field's own `frame.mirror` kind, and the pointer is un-mirrored on the way out (every mirror kind
 * is its own inverse), so the shell is still handed poses in the file's own frame and what is drawn
 * is what is stored. The field picture and its obstacles are never mirrored.
 */
import {
  fieldBounds,
  flattenSteps,
  idealPoseAt,
  idealTimeAt,
  idealTrajectory,
  jointTwin,
  mirrorForField,
  mirrorVec,
  resimulate,
  robotClearanceIn,
  robotHeightIn,
  shouldMirror,
  simPoseAt,
  simulateRun,
  waypointUses,
  type Box2,
  type MirrorMode,
  type PlanStep,
  type Pose,
  type SimRun,
  type Vec2,
} from "@horizon36596/zenith-core";
import { CornerDownRight, Maximize, Minus, Plus, Scissors, Spline, Split } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { effectiveNodeKind, nodesForTarget, type BezierNode, type NodeKind, nodeKey } from "./bezier.js";
import styles from "./canvas.module.css";
import { Tooltip } from "../components/Tooltip.js";
import { countOf } from "../lib/format.js";
import { clipGhosts, ghostsToDraw, outlinedObstacle } from "./clipGhosts.js";
import { candidateHoverPose, candidateOutlinePoses } from "./candidate.js";
import { ContextMenu } from "./ContextMenu.js";
import { CANVAS_ZOOM_EVENT, type CanvasZoom } from "./zoomRequest.js";
import { chooseImageSource, creditLine, readFieldImage, resolveImageUrl, type FieldImageSpec } from "./fieldImage.js";
import { bodyBoundsIn, draggedFootprintBounds, footprintBoundsIn, robotReachIn } from "./footprintBounds.js";
import { CANVAS_TOOLTIPS, DRAWING_TOOLS, mirrorBannerLine, toolHintLine } from "./help.js";
import {
  continueAngle,
  dragBoundary,
  handleLabel,
  handleValueRad,
  headingHandlesFor,
  moveFacingPoint,
  splitHeadingAt,
  turnHandle,
  type HeadingHandle,
} from "./headingHandles.js";
import {
  cursorForGrab,
  dragEnvelopeRect,
  drawEnvelopeRect,
  envelopeRectLines,
  envelopeRectOf,
  sceneEnvelopeOf,
  snapDrawStart,
} from "./envelopeDrag.js";
import { rectPolygon, type Rect, type RectGrab } from "../lib/envelopeRect.js";
import { hitTest, isMarkerOrLineHit, nearest, nextStepUnder, pinsNear, projectOntoPolyline, type HitScene } from "./hit.js";
import {
  drawLive,
  projectHeadingHandles,
  projectHitScene,
  projectMarqueeCandidates,
  projectPins,
  startMarkTone,
  type Bubble,
  type LiveLayerInput,
  type ReadoutState,
} from "./liveLayer.js";
import { constrainAngle, snapMeasureEnd, type Measurement } from "./measure.js";
import { heldKeys, NO_KEYS, resolveModifiers, type HeldKeys } from "./modifiers.js";
import { escapeCancelsDrag, releaseIsClick, spaceHeldAfter } from "./press.js";
import {
  headingDrag,
  placeAddPoint,
  planPointDrag,
  rayAnchorOf,
  rayConstraintLabel,
  resolveLeader,
  smoothNodeMoves,
  type StartPoint,
} from "./pointDrag.js";
import {
  buildScene,
  pointsOnStart,
  poseAtT,
  poseAtTime,
  routinePoints,
  splitLocation,
  timeAtT,
  traceTimeNear,
  type Scene,
} from "./scene.js";
import {
  isPointSelected,
  marqueeSelection,
  rectFrom,
  selectedPoints,
  stepsWithHandles,
  togglePoint,
  type ScreenRect,
} from "./selection.js";
import { snapLabel, snapWaypointsOf, type SnapContext, type SnapResult, type SnapWaypoint } from "./snap.js";
import { drawingFor } from "./seasonDrawing.js";
import { drawFieldImage, drawPerimeter, drawStatic, drawStaticImage, pictureOverlay, pinLabelBoxes, type StaticLayerInput } from "./staticLayer.js";
import { fallbackTheme, liveInk, observeTheme, readTheme, type CanvasTheme } from "./theme.js";
import { drawPartners } from "./partnerLayer.js";
import { openUnknownEnvelope, unknownLabel, unknownSpanAt, unknownSpans, unknownSteps, type UnknownSpan } from "./unknownPosition.js";
import { previewSimOptions } from "../state/ledgerRun.js";
import { bandSummary, blockingBands, drawHiveLevel } from "./structureLayer.js";
import { badgeSummary, ledgerBadgesAt } from "./ledgerBadges.js";
import { countLabelsSummary } from "./fieldCounts.js";
import type { Heading } from "@horizon36596/zenith-schema";
import type {
  CanvasAction,
  CanvasHit,
  CanvasMenuTarget,
  FieldCanvasProps,
  FieldView,
  PlaybackLevel,
  PointTarget,
  PoseMove,
  Selection,
  SelectedPoint,
  TraceOverlay,
} from "./types.js";
import {
  fitBounds,
  fitView,
  FIT_PADDING,
  layoutPane,
  orientationFor,
  panBy,
  screenToWorld,
  zoomAbout,
  type AudienceAt,
  type PaneSize,
  type ScreenVec,
  type View,
} from "./view.js";
import { selectionFrameBounds } from "./selectionFrame.js";
import { focusForInput } from "../components/inputModality.js";

/** Zoom to selection frames the points with this much room around them, and no tighter than this. */

/** A press that never travels this far is a click, not a drag. */
const CLICK_SLOP_PX = 3;
/**
 * Where the app's public assets are served, for `app:` image sources: Vite's `BASE_URL`, which is
 * `/` in the desktop app and `/zenith/app/` on the public site.
 */
const APP_BASE_URL = import.meta.env.BASE_URL;
/**
 * A field picture whose static layer took longer than this to paint, in milliseconds, is too slow to
 * repaint on every frame of a pan or zoom: half of a 60 Hz frame's 16.7 ms, which leaves the other
 * half for the live layer. Only then does a moving view blit the cached picture (issue #151).
 */
const SLOW_STATIC_PAINT_MS = 8;
/** For that slow picture, how long after the last pan or zoom frame the static layer is repainted sharp. */
const STATIC_SETTLE_MS = 110;

/** The playback level's name under the robot outline, and in running text in the hover readout. */
const LEVEL_LABEL: Readonly<Record<PlaybackLevel, string>> = {
  ideal: "Ideal",
  instant: "Instant sim",
  full: "Full sim",
};
/** Under the robot outline while it is on the Optimize card's proposed route: the planned pose there. */
const CANDIDATE_LABEL = "Proposed route";
/** The corner readout's words for an add-path or add-command preview: the snap, then Shift's ray. */
const addReadoutLabel = (snap: SnapResult | null): string | null => {
  if (snap === null) return null;
  const parts = [snapLabel(snap), snap.ray === undefined ? null : rayConstraintLabel(snap.ray)].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
};
const LEVEL_WORD: Readonly<Record<PlaybackLevel, string>> = {
  ideal: "ideal",
  instant: "instant sim",
  full: "full sim",
};

type Drag =
  | { kind: "pan"; lastXPx: number; lastYPx: number }
  | {
      kind: "points";
      leader: StartPoint;
      followers: StartPoint[];
      /** The plan's steps at the press, so a long drag computes from where it started. */
      steps: PlanStep[];
      polygons: Map<string, Vec2[][]>;
      isControl: boolean;
      /**
       * Where Shift's ray starts when the leader is a path end or node: the other end of its segment
       * at the press (`rayAnchorOf`). Null for a control point, which keeps the axis rule.
       */
      rayAnchorIn: Vec2 | null;
      /** The other end of each joint a moved point sits on, as the document stood at the press. */
      twinOf: (stepId: string, target: PointTarget) => PointTarget | null;
    }
  | {
      kind: "headingHandle";
      stepId: string;
      handle: HeadingHandle;
      /** The step's heading mode at the press: every frame edits this, so nothing drifts. */
      heading: Heading;
      /** The angle written last frame, so a turn past a half turn keeps going the same way. */
      lastRad: number;
    }
  | { kind: "rangeBoundary"; stepId: string; index: number; heading: Heading }
  | {
      kind: "envelopeRect";
      stepId: string;
      grab: RectGrab;
      /** The rectangle at the press, in the file's own frame: every frame measures from here. */
      startRect: Rect;
      /** Where the press landed, in the file's own frame, which a move measures from. */
      pressIn: Vec2;
    }
  /** Drawing a new envelope for a step, from its first corner, snapped, in the file's own frame. */
  | { kind: "envelopeDraw"; stepId: string; fromIn: Vec2 }
  | { kind: "marker"; stepId: string; markerIndex: number }
  /**
   * The routine's start mark, from its pose at the press, so a long drag computes from there, with
   * the path points that sat on it at the press, which it carries (issue #133).
   */
  | { kind: "start"; pose: Pose; carried: SelectedPoint[] }
  /** The start's heading knob, from the start pose at the press. */
  | { kind: "startHeading"; pose: Pose }
  /**
   * A waypoint pin (issue #134), from its pose at the press, in `waypoints.json`'s own frame, which
   * the pins are drawn in and never mirrored.
   */
  | { kind: "waypoint"; name: string; pose: Pose }
  | { kind: "marquee"; base: Selection; additive: boolean }
  | { kind: "measure"; fromIn: Vec2 };

/** The drags that edit the document, each bracketed in one undo transaction from press to release. */
const isEditDrag = (drag: Drag): boolean =>
  drag.kind === "points" ||
  drag.kind === "headingHandle" ||
  drag.kind === "rangeBoundary" ||
  drag.kind === "envelopeRect" ||
  drag.kind === "envelopeDraw" ||
  drag.kind === "marker" ||
  drag.kind === "start" ||
  drag.kind === "startHeading" ||
  drag.kind === "waypoint";

interface Press {
  xPx: number;
  yPx: number;
  moved: boolean;
  drag: Drag | null;
  hit: CanvasHit | null;
  shift: boolean;
  /** The mouse button that started the press: 0 edits, 1 and 2 (with Ctrl) pan. */
  button: number;
  /**
   * The pointer that started the press (issue #148). While it is down, every other pointer (a
   * second finger) is ignored, so the press ends only when this one goes up or is cancelled.
   */
  pointerId: number;
}

interface LoadedImage {
  spec: FieldImageSpec;
  image: HTMLImageElement;
}

interface CanvasState {
  view: View | null;
  /**
   * True once the user has panned or zoomed. Until then the view is the app's to choose, and it
   * re-fits whenever the element changes size. After it, the view is the user's and is only ever
   * panned to keep what was in the middle of the pane in the middle of it.
   */
  userAdjusted: boolean;
  /**
   * The pane size `view` was laid out for. It trails `widthPx`/`heightPx` while a press is down,
   * because the view holds still under a drag and catches up when the press ends (`layoutPane`).
   */
  laidOutAt: PaneSize | null;
  /**
   * What a fit frames: the field and its margin with the routine's drawn extent (`fitBounds`, issue
   * #151). Worked out at Zoom to fit and when an auto opens, then held, so a resize refits to the
   * same box and the view never jumps because the routine was edited. Null until it is next needed.
   */
  fitBoundsIn: Box2 | null;
  widthPx: number;
  heightPx: number;
  dpr: number;
  theme: CanvasTheme;
  staticCanvas: HTMLCanvasElement | null;
  staticImage: HTMLImageElement | null;
  fieldImage: LoadedImage | null;
  staticDirty: boolean;
  /**
   * The view the cached static layer was painted at. A frame at another view repaints it there,
   * unless the field picture paints slowly (`staticPaintMs`), which blits it transformed instead.
   */
  staticView: View | null;
  /** How long the last static paint took, in milliseconds. */
  staticPaintMs: number;
  staticTimer: number | null;
  hitScene: HitScene | null;
  hover: CanvasHit | null;
  press: Press | null;
  spaceHeld: boolean;
  /**
   * True from the end of a Ctrl + right drag that moved until the context menu event that follows
   * it, which Windows sends on release, so panning never opens a menu. A Ctrl + right-click that
   * did not move still opens one.
   */
  swallowMenu: boolean;
  keys: HeldKeys;
  pointerIn: Vec2 | null;
  pointerPx: ScreenVec | null;
  snapFeedback: SnapResult | null;
  /**
   * With the add-path or add-command tool and no press down, where a click at the pointer would put
   * its point, snapped as the click will snap it (issue #150): what the rubber band, the snap mark
   * and the corner readout show. Null otherwise.
   */
  addSnap: SnapResult | null;
  readoutHeadingRad: number | null;
  readoutLabel: string | null;
  bubble: Bubble | null;
  marquee: ScreenRect | null;
  measurement: Measurement | null;
  nodeKinds: Map<string, NodeKind>;
}

interface MenuState {
  xPx: number;
  yPx: number;
  items: CanvasAction[];
}

/** How far one press of the field's + or − zooms (issue #412). */
const ZOOM_STEP = 1.25;

/** Puts focus on the Inspector's Command field of a just-placed marker, once it has rendered (issue #412). */
function focusMarkerCommand(tries = 6): void {
  window.requestAnimationFrame(() => {
    const field = document.querySelector<HTMLElement>('[data-testid="inspector-marker-command"]');
    // The marker was dropped with the pointer, so the picker takes focus without a ring.
    if (field !== null) focusForInput(field, { preventScroll: false });
    else if (tries > 0) focusMarkerCommand(tries - 1);
  });
}

const HOST_STYLE = { position: "relative", width: "100%", height: "100%" } as const;
const CANVAS_STYLE = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  display: "block",
  background: "var(--bg-canvas)",
  touchAction: "none",
  outline: "none",
} as const;

function summarise(props: FieldCanvasProps, scene: Scene): string {
  const paths = scene.steps.length;
  const travelIn = scene.steps.reduce((sum, step) => sum + step.lengthIn, 0);
  const errors = props.findings.filter((finding) => finding.severity === "error").length;
  const warnings = props.findings.filter((finding) => finding.severity === "warning").length;
  return [
    `Field canvas for ${props.auto.name} on the ${props.alliance} alliance.`,
    `${countOf(props.auto.steps.length, "step")}, ${String(paths)} of them ${paths === 1 ? "a path" : "paths"},`,
    `${travelIn.toFixed(0)} inches of travel.`,
    `${countOf(errors, "error")} and ${countOf(warnings, "warning")}.`,
  ].join(" ");
}

const fmt = (value: number, places = 2): string => value.toFixed(places).replace("-", "−");
const poseLine = (pose: Pose): string =>
  `x ${fmt(pose.xIn)}  y ${fmt(pose.yIn)} in  h ${fmt((pose.headingRad * 180) / Math.PI, 1)}°`;

/**
 * A path point's line: where it is, and the heading the plan gives the robot there (issue #147), or
 * no heading at all for a control point or a point the plan has no sample at.
 */
const pointLine = (at: Vec2, plannedRad: number | null): string =>
  plannedRad === null ? `x ${fmt(at.xIn)}  y ${fmt(at.yIn)} in` : poseLine({ xIn: at.xIn, yIn: at.yIn, headingRad: plannedRad });

export function FieldCanvas(props: FieldCanvasProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  /** `updateAddSnap`, which is defined further down, for `draw` to call before it paints. */
  const updateAddSnapRef = useRef<() => void>(() => undefined);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  /** The zoom against a fit, in percent, for the field's corner readout (issue #412); null before the first layout. */
  const [zoomPct, setZoomPct] = useState<number | null>(null);
  /** Dev only: the `?fieldRef=1` alignment overlay (`fieldReference.ts`), loaded on demand. */
  const fieldReferenceRef = useRef<typeof import("./fieldReference.js") | null>(null);

  const stateRef = useRef<CanvasState>({
    view: null,
    userAdjusted: false,
    laidOutAt: null,
    fitBoundsIn: null,
    widthPx: 0,
    heightPx: 0,
    dpr: 1,
    theme: fallbackTheme(),
    staticCanvas: null,
    staticImage: null,
    fieldImage: null,
    staticDirty: true,
    staticView: null,
    staticPaintMs: 0,
    staticTimer: null,
    hitScene: null,
    hover: null,
    press: null,
    spaceHeld: false,
    swallowMenu: false,
    keys: NO_KEYS,
    pointerIn: null,
    pointerPx: null,
    snapFeedback: null,
    addSnap: null,
    readoutHeadingRad: null,
    readoutLabel: null,
    bubble: null,
    marquee: null,
    measurement: null,
    nodeKinds: new Map(),
  });

  const scene = useMemo(
    () =>
      buildScene({ plan: props.plan, findings: props.findings, estimate: props.estimate, showMarkers: props.showMarkers !== false }),
    [props.plan, props.findings, props.estimate, props.showMarkers],
  );
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  const ghosts = useMemo(
    () => clipGhosts(props.findings, props.field, robotHeightIn(props.robot)),
    [props.findings, props.field, props.robot],
  );
  const ghostsRef = useRef(ghosts);
  ghostsRef.current = ghosts;

  const flatSteps = useMemo(() => flattenSteps(props.plan.steps), [props.plan]);

  // The ideal level (site/docs/simulation.md, "Playback levels"): the planned path exactly, on the
  // estimate's clock, with a timed transition wherever a step starts away from where the robot is.
  const ideal = useMemo(() => {
    if (props.estimate === null) return null;
    try {
      return idealTrajectory(props.plan, props.estimate);
    } catch {
      return null;
    }
  }, [props.plan, props.estimate]);
  const idealRef = useRef(ideal);
  idealRef.current = ideal;

  // The instant sim (site/docs/simulation.md): the one robot outline, on hover and at the playback
  // time, follows the routine as the robot would run it. The shell may hand a trace in; otherwise
  // the canvas runs the sim itself, at most once per animation frame however fast edits arrive, and
  // resumes from the last checkpoint the edit left intact. A sim that throws leaves the kinematic
  // estimate as the timing source.
  const simRunRef = useRef<SimRun | null>(null);
  const simTraceRef = useRef<TraceOverlay | null>(null);
  const previewRef = useRef<TraceOverlay | null>(null);
  previewRef.current = props.previewTrace !== undefined ? props.previewTrace : simTraceRef.current;
  const flatStepsRef = useRef(flatSteps);
  flatStepsRef.current = flatSteps;
  // The steps whose position nobody can predict (`unknownPosition.ts`, issue #481).
  const unknown = useMemo(() => unknownSteps(props.plan, props.robot), [props.plan, props.robot]);
  const unknownRef = useRef(unknown);
  unknownRef.current = unknown;

  // Review mode's base version: the old shape, nothing more.
  const baseScene = useMemo(
    () =>
      props.basePlan === null || props.basePlan === undefined
        ? null
        : buildScene({ plan: props.basePlan, findings: [], estimate: null }),
    [props.basePlan],
  );
  const baseSceneRef = useRef(baseScene);
  baseSceneRef.current = baseScene;

  // The Optimize card's proposed route (issue #308): a second scene, drawn and never hit-tested.
  const candidateStep = useMemo(() => {
    const candidate = props.candidate ?? null;
    if (candidate === null || candidate.plan === null) return null;
    const built = buildScene({ plan: candidate.plan, findings: [], estimate: null, showMarkers: false });
    return built.steps.find((step) => step.stepId === candidate.stepId) ?? null;
  }, [props.candidate]);
  const candidateStepRef = useRef(candidateStep);
  candidateStepRef.current = candidateStep;

  const bounds = useMemo<Box2>(() => fieldBounds(props.field), [props.field]);
  const orientation = useMemo(
    () => orientationFor((props.field.frame.view?.audienceAt ?? "bottom") as AudienceAt),
    [props.field],
  );
  // The hidden pins as one string, so a new Set with the same names redraws nothing (issue #236).
  const hiddenKey = useMemo(() => [...(props.hiddenWaypoints ?? [])].sort().join("\n"), [props.hiddenWaypoints]);
  // Every pin as a snap target; `shownWaypoints` leaves out the hidden ones.
  const waypointList = useMemo<SnapWaypoint[]>(() => snapWaypointsOf(props.waypoints), [props.waypoints]);
  const waypointsRef = useRef(waypointList);
  waypointsRef.current = waypointList;
  // What the field hid when the current press began, kept until it ends (issues #211, #217): a drag
  // that takes a point off the waypoint it followed, with Waypoint pins on This auto's, leaves that pin
  // on the field, so the same drag can put it back.
  const heldHiddenRef = useRef<{ hidden: ReadonlySet<string> | undefined } | null>(null);
  /** The pins hidden now (issue #236): the shell's, less any shown when the current press began. */
  const hiddenNow = useCallback((): ReadonlySet<string> | undefined => {
    const hidden = propsRef.current.hiddenWaypoints;
    const held = heldHiddenRef.current;
    if (held === null || hidden === undefined) return hidden;
    const before = held.hidden;
    return before === undefined ? undefined : new Set([...hidden].filter((name) => before.has(name)));
  }, []);
  /**
   * The waypoints a point can snap onto (issue #236): the pins on the field now, the selected one
   * included even where it is hidden, as it is drawn and can be followed (issue #217).
   */
  const shownWaypoints = useCallback((): SnapWaypoint[] => {
    const selected = propsRef.current.selection.waypoint;
    const hidden = hiddenNow();
    return waypointsRef.current.filter((waypoint) => waypoint.name === selected || hidden?.has(waypoint.name) !== true);
  }, [hiddenNow]);

  // The waypoint each path end follows, for the hover bubble's "follows waypoint X" (issue #233).
  const followedWaypoints = useMemo(() => {
    const follows = new Map<string, string>();
    for (const use of waypointUses(props.auto)) {
      if (use.at === "point") follows.set(`${use.stepId}|${String(use.segmentIndex)}|${use.pointKind}`, use.ref);
    }
    return follows;
  }, [props.auto]);
  const followedWaypointsRef = useRef(followedWaypoints);
  followedWaypointsRef.current = followedWaypoints;

  // Mirrored iff the alliance being viewed is not the file's own, by the field's own `frame.mirror`
  // kind (`shouldMirror`, the rule `render` and the robot runtime follow); "none" makes `mirrorVec`
  // an identity.
  const mirrored = shouldMirror(props.auto, props.field, props.alliance);
  const mirrorMode: MirrorMode = mirrored ? mirrorForField(props.field) : "none";
  const mirrorRef = useRef(mirrorMode);
  mirrorRef.current = mirrorMode;
  /**
   * True while the view shows the other alliance (issue #412). The drawing tools are off then: the
   * shell disables their buttons, and a click or a press with one of them makes no edit here.
   */
  const mirroredRef = useRef(mirrored);
  mirroredRef.current = mirrored;
  const drawingOff = useCallback((): boolean => mirroredRef.current && DRAWING_TOOLS.has(propsRef.current.tool), []);
  // Review mode's base version is drawn for the same view by its own file's alliance.
  const baseMirrorMode: MirrorMode =
    props.basePlan !== null && props.basePlan !== undefined && shouldMirror(props.basePlan.auto, props.field, props.alliance)
      ? mirrorForField(props.field)
      : "none";
  const baseMirrorRef = useRef(baseMirrorMode);
  baseMirrorRef.current = baseMirrorMode;

  const fieldView: FieldView = props.fieldView ?? "image+outlines";

  // ---- drawing ---------------------------------------------------------------------------

  const staticInput = useCallback((mode?: "vector" | "outlines"): StaticLayerInput | null => {
    const state = stateRef.current;
    if (state.view === null) return null;
    return {
      field: propsRef.current.field,
      waypoints: propsRef.current.waypoints ?? null,
      ...(propsRef.current.selection.waypoint === undefined ? {} : { selectedWaypoint: propsRef.current.selection.waypoint }),
      ...(hiddenNow() === undefined ? {} : { hiddenWaypoints: hiddenNow() }),
      robotHeightIn: robotHeightIn(propsRef.current.robot),
      overheadOutlines: propsRef.current.overheadOutlines ?? true,
      fieldGrid: propsRef.current.fieldGrid ?? "tiles",
      view: state.view,
      theme: state.theme,
      widthPx: state.widthPx,
      heightPx: state.heightPx,
      ...(mode === undefined ? {} : { mode }),
    };
  }, [hiddenNow]);

  /** What the static layer shows: the picture only when it loaded, else the vector field. */
  const effectiveView = useCallback((): FieldView => {
    const state = stateRef.current;
    return state.fieldImage === null ? "vector" : (propsRef.current.fieldView ?? "image+outlines");
  }, []);

  /**
   * The pose a new path point continues from: the end of the step the shell is inserting after
   * (site/docs/editor.md, "The insert menu"), else the routine's last end pose. `anchorId` names
   * another step to insert after, as the field menu's "Add a path to here" does (issue #150).
   */
  const anchorEndPose = useCallback((anchorId: string | null | undefined = propsRef.current.insertAnchorStepId): Pose => {
    const current = propsRef.current;
    if (anchorId !== undefined && anchorId !== null) {
      const anchor = flatStepsRef.current.find((step) => step.id === anchorId);
      const end = anchor?.endPose ?? anchor?.samples[anchor.samples.length - 1]?.pose;
      if (end !== undefined && end !== null) return end;
    }
    const top = current.plan.steps;
    for (let index = top.length - 1; index >= 0; index -= 1) {
      const end = top[index]?.endPose;
      if (end !== undefined && end !== null) return end;
    }
    return sceneRef.current.startPose;
  }, []);

  /**
   * Whether the start's heading knob shows: the shell can turn the start, and the start is selected,
   * hovered, or being dragged or turned. A start that follows a waypoint has it too: turning it makes
   * the start a pose of its own (issue #133).
   */
  const showStartKnob = useCallback((): boolean => {
    const state = stateRef.current;
    const current = propsRef.current;
    if (current.onTurnStartPose === undefined) return false;
    const dragKind = state.press?.drag?.kind;
    return (
      current.selection.start === true ||
      state.hover?.start === true ||
      state.hover?.startKnob === true ||
      dragKind === "start" ||
      dragKind === "startHeading"
    );
  }, []);

  /**
   * The waypoint pin to draw in the handle colour (issue #134): the one being dragged, else the
   * selected one, else the one under the pointer.
   */
  const activePin = useCallback((): LiveLayerInput["activePin"] => {
    const state = stateRef.current;
    const current = propsRef.current;
    const drag = state.press?.drag;
    const dragged = drag?.kind === "waypoint" ? drag.name : undefined;
    // A pin hidden while the pointer rests on it stops drawing at once (issue #236).
    const hovered = state.hover?.waypoint;
    const name = dragged ?? current.selection.waypoint ?? (hovered !== undefined && hiddenNow()?.has(hovered) === true ? undefined : hovered);
    const waypoints = current.waypoints?.waypoints;
    if (name === undefined || waypoints === undefined || !Object.prototype.hasOwnProperty.call(waypoints, name)) return null;
    const waypoint = waypoints[name];
    if (waypoint === undefined) return null;
    const hidden = hiddenNow()?.has(name) === true;
    return { name, pose: waypoint, selected: dragged !== undefined || current.selection.waypoint === name, ...(hidden ? { hidden } : {}) };
  }, [hiddenNow]);

  /**
   * The waypoint pins the pointer can reach (issue #134): with the select tool and only where the
   * shell can move them, less the hidden ones but for the selected pin (issue #236).
   */
  const reachablePins = useCallback((view: View): HitScene["pins"] => {
    const current = propsRef.current;
    if (current.onDragWaypoint === undefined || current.tool !== "select") return undefined;
    return projectPins(current.waypoints, view, current.selection.waypoint, hiddenNow());
  }, [hiddenNow]);

  /**
   * The add-path tool's preview: from where the new path starts to where a click would end it. It
   * is drawn only to the snapped point, never to the raw pointer, so with no point for a click to
   * place there is no line (issue #150).
   */
  const rubberBand = useCallback((): { fromIn: Pose; toIn: Vec2 } | null => {
    const state = stateRef.current;
    const toIn = state.addSnap?.pose;
    if (propsRef.current.tool !== "addPath" || state.press !== null || toIn === undefined) return null;
    return { fromIn: anchorEndPose(), toIn };
  }, [anchorEndPose]);

  /**
   * The one robot outline: under the cursor on a path, else at the playback time (0 at rest), from
   * the playback level the shell chose, and labelled with it.
   */
  /**
   * The pose on the Optimize card's proposed route under the pointer, or null: only with no press,
   * no playback and no point or handle under the pointer, since the route itself takes no press.
   */
  const candidateHover = useCallback((): Pose | null => {
    const state = stateRef.current;
    const step = candidateStepRef.current;
    if (step === null || state.view === null || state.press !== null || propsRef.current.playing === true) return null;
    if (state.hover !== null && state.hover.t === undefined) return null;
    return candidateHoverPose(step, state.pointerPx, state.view, mirrorRef.current);
  }, []);

  /**
   * The stretches where the robot's position is a guess, on the clock of the playback level the
   * shell chose: the ideal spans, the instant sim's step records, or the recorded run's.
   */
  const unknownNow = useCallback((): UnknownSpan[] => {
    const current = propsRef.current;
    const steps = unknownRef.current;
    if (steps.size === 0) return [];
    const level: PlaybackLevel = current.playbackLevel ?? "ideal";
    if (level === "instant") {
      const preview = previewRef.current;
      return preview === null ? [] : unknownSpans(steps, { trace: preview });
    }
    if (level === "full") {
      const recorded = current.trace ?? null;
      return recorded === null ? [] : unknownSpans(steps, { trace: recorded });
    }
    const trajectory = idealRef.current;
    return trajectory === null ? [] : unknownSpans(steps, { ideal: trajectory });
  }, []);

  const robotPose = useCallback((): {
    poseIn: Pose;
    emphasis: "playback" | "hover";
    label: string;
    unknown?: boolean;
  } | null => {
    const state = stateRef.current;
    const current = propsRef.current;
    const level: PlaybackLevel = current.playbackLevel ?? "ideal";
    const label = LEVEL_LABEL[level];
    const recorded = current.trace !== null && current.trace !== undefined && current.trace.poses.length > 0 ? current.trace : null;
    const hover = state.hover;
    // Over the Optimize card's proposed route, the one outline is the robot on it (issue #308).
    const onCandidate = candidateHover();
    if (onCandidate !== null) return { poseIn: onCandidate, emphasis: "hover", label: CANDIDATE_LABEL };
    if (
      hover !== null &&
      hover.t !== undefined &&
      hover.point === undefined &&
      current.playing !== true &&
      state.press === null
    ) {
      const step = sceneRef.current.steps.find((candidate) => candidate.stepId === hover.stepId);
      if (step !== undefined) {
        // Ideal: the planned pose itself. A sim level: where that sim's robot is when it passes the
        // hovered point, else the planned pose.
        const planned = poseAtT(step, hover.t);
        const run = level === "instant" ? previewRef.current : level === "full" ? recorded : null;
        const atS = run === null ? null : traceTimeNear(run, hover.stepId, planned);
        const simulated = run === null || atS === null ? null : simPoseAt(run, atS);
        return { poseIn: simulated ?? planned, emphasis: "hover", label };
      }
    }
    const atS = current.playbackS ?? 0;
    const fallback = (): Pose => {
      const trajectory = idealRef.current;
      if (trajectory !== null) return idealPoseAt(trajectory, atS);
      return poseAtTime(sceneRef.current, atS) ?? sceneRef.current.startPose;
    };
    const preview = previewRef.current;
    const pose =
      level === "instant" && preview !== null && preview.poses.length > 0
        ? simPoseAt(preview, atS)
        : level === "full" && recorded !== null
          ? simPoseAt(recorded, atS)
          : fallback();
    if (pose === null) return null;
    // While a command that drives the robot by itself runs, the robot is a guess, drawn as one.
    if (unknownSpanAt(unknownNow(), atS) !== null) return { poseIn: pose, emphasis: "playback", label: unknownLabel(label), unknown: true };
    return { poseIn: pose, emphasis: "playback", label };
  }, [candidateHover, unknownNow]);

  const paintStatic = useCallback(() => {
    const state = stateRef.current;
    const staticCanvas = state.staticCanvas;
    if (staticCanvas === null || state.view === null) return;
    const ctx = staticCanvas.getContext("2d");
    if (ctx === null) return;
    const startedMs = performance.now();
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    const mode = effectiveView();
    const loaded = state.fieldImage;
    if (mode !== "vector" && loaded !== null) {
      const overlay = pictureOverlay(mode);
      const input = staticInput(overlay.staticMode);
      if (input === null) return;
      drawFieldImage(ctx, loaded.image, loaded.spec, input);
      if (overlay.drawsOutlines) drawStatic(ctx, input);
      else drawPerimeter(ctx, input);
    } else {
      const input = staticInput();
      if (input === null) return;
      // A season the canvas can draw is drawn here; the core.render picture is the fallback.
      if (state.staticImage !== null && drawingFor(input.field) === null) drawStaticImage(ctx, state.staticImage, input);
      else drawStatic(ctx, input);
      if (import.meta.env.DEV) fieldReferenceRef.current?.drawFieldReference(ctx, input);
    }
    // The pin names this paint drew, published on the element like the view, so a test can tell a
    // repaint that kept the selected pin's name from one that left old names in the cached layer.
    const labelled = staticInput();
    if (canvasRef.current !== null && labelled !== null) {
      canvasRef.current.dataset["pinLabels"] = [
        ...pinLabelBoxes(labelled.waypoints, labelled.view, labelled.selectedWaypoint).keys(),
      ].join(",");
    }
    state.staticDirty = false;
    state.staticView = state.view;
    state.staticPaintMs = performance.now() - startedMs;
  }, [effectiveView, staticInput]);

  /**
   * Whether a view that moved blits the cached static layer instead of repainting it (issue #151):
   * only for the field picture, and only once a paint of it has measured slow. The vector field
   * repaints in the same frame, so a pan or zoom never shows the well where the field was off screen.
   */
  const blitsWhileMoving = useCallback(
    (): boolean => effectiveView() !== "vector" && stateRef.current.staticPaintMs > SLOW_STATIC_PAINT_MS,
    [effectiveView],
  );

  const draw = useCallback(() => {
    const state = stateRef.current;
    const canvas = canvasRef.current;
    if (canvas === null || state.view === null || state.widthPx === 0) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    // The view, published on the element: a pointer test and a bug report both need to turn a
    // field inch into a CSS pixel, and the canvas is otherwise a black box from the outside.
    canvas.dataset["pxPerIn"] = state.view.pxPerIn.toFixed(6);
    canvas.dataset["originXPx"] = state.view.originXPx.toFixed(3);
    canvas.dataset["originYPx"] = state.view.originYPx.toFixed(3);
    // The zoom against what a fit at this size would show (issue #412), for the corner readout.
    if (state.fitBoundsIn !== null) {
      const fitted = fitView(state.fitBoundsIn, state.widthPx, state.heightPx, FIT_PADDING, state.view.orientation).pxPerIn;
      setZoomPct(Math.round((100 * state.view.pxPerIn) / fitted));
    }
    canvas.dataset["fieldView"] = effectiveView();
    canvas.dataset["fieldGrid"] = propsRef.current.fieldGrid ?? "tiles";
    // The pins the pointer can reach, by name, as the hit scene holds them (issue #236).
    canvas.dataset["pins"] = (reachablePins(state.view) ?? []).map((pin) => pin.name).join(",");

    // A frame where only the live layer changed reuses the cached field. A pan, a zoom or a fit
    // repaints it at the new view in this same frame, so what was off screen is drawn at once.
    const moved = state.staticView !== null && state.staticView !== state.view;
    if (state.staticDirty || state.staticView === null || (moved && !blitsWhileMoving())) paintStatic();

    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.widthPx, state.heightPx);
    const cached = state.staticView;
    if (state.staticCanvas !== null && cached !== null) {
      if (cached === state.view) {
        ctx.drawImage(state.staticCanvas, 0, 0, state.widthPx, state.heightPx);
      } else {
        // A slow field picture mid pan or zoom: the cached picture under the new transform,
        // sharpened once the view has settled (`setView`).
        const scale = state.view.pxPerIn / cached.pxPerIn;
        const dx = state.view.originXPx - scale * cached.originXPx;
        const dy = state.view.originYPx - scale * cached.originYPx;
        ctx.fillStyle = state.theme.bgCanvas;
        ctx.fillRect(0, 0, state.widthPx, state.heightPx);
        ctx.drawImage(state.staticCanvas, dx, dy, state.widthPx * scale, state.heightPx * scale);
      }
    }

    const current = propsRef.current;
    // The hives at the playback time (`hiveLayer.ts`), over the field and under every robot,
    // published on the element for tests and bug reports. Over them, the hive frame's legs: each
    // one's band below the robot's top, and the dashed overhead outlines (`structureLayer.ts`).
    const heightIn = robotHeightIn(current.robot);
    canvas.dataset["hive"] = drawHiveLevel(
      ctx,
      { ledger: current.ledger, trace: previewRef.current, field: current.field, timeS: current.playbackS, view: state.view, mirror: mirrorRef.current, theme: state.theme },
      { field: current.field, robotHeightIn: heightIn, view: state.view, theme: state.theme, overheadOutlines: current.overheadOutlines ?? true },
    );
    // The bands as drawn, in field inches, for tests and bug reports.
    canvas.dataset["strutBands"] = bandSummary(blockingBands(current.field, heightIn));
    // Alliance partners go under everything the live layer draws, so the user's own routine and
    // robot outline always read on top of them.
    const partners = current.partners ?? [];
    canvas.dataset["partners"] = partners.map((partner) => `${partner.id}@${partner.poseIn.xIn.toFixed(2)},${partner.poseIn.yIn.toFixed(2)}`).join(";");
    if (partners.length > 0) {
      const loadedField = state.fieldImage;
      const lightInk = loadedField !== null && effectiveView() !== "vector" && current.fieldImageVariant === "light";
      drawPartners(ctx, { partners, view: state.view, mirror: mirrorRef.current, theme: liveInk(state.theme, lightInk) });
    }
    // With the add-path or add-command tool and no press down, the preview is worked out here, as it
    // is painted, from the pointer's pixel under this frame's view. So whatever changed since the
    // last pointer move (Escape moving the insert anchor, a tool key, a zoom, a held modifier, an
    // edit), the dashed line, the snap mark and the readout show where a click there puts the point
    // (issue #150). The readout shows that point, snapped, or no point when a click would place none,
    // and never the raw pointer.
    if (state.press === null) updateAddSnapRef.current();
    const addSnap = state.addSnap;
    const previewing =
      state.press === null &&
      (current.tool === "addPath" || current.tool === "addCommand" || (current.placeWaypointArmed === true && current.onPlaceWaypoint !== undefined));
    const readout: ReadoutState = previewing
      ? { pointIn: addSnap?.pose ?? null, headingRad: addSnap?.pose.headingRad ?? null, snapLabel: state.readoutLabel }
      : { pointIn: state.pointerIn, headingRad: state.readoutHeadingRad, snapLabel: state.readoutLabel };
    // Published for tests and bug reports: the readout's numbers in full, and the snap it names.
    canvas.dataset["readoutPose"] =
      readout.pointIn === null
        ? ""
        : [readout.pointIn.xIn, readout.pointIn.yIn, readout.headingRad ?? ""].map((value) => String(value)).join(",");
    canvas.dataset["readoutSnap"] = readout.snapLabel ?? "";
    // And the dashed line's two ends, from where the new path starts to where it is drawn to.
    const band = rubberBand();
    canvas.dataset["rubberBand"] =
      band === null ? "" : [band.fromIn.xIn, band.fromIn.yIn, band.toIn.xIn, band.toIn.yIn].map((value) => String(value)).join(",");
    const trace = current.trace ?? null;
    const level: PlaybackLevel = current.playbackLevel ?? "ideal";
    const robot = robotPose();
    // Published for tests and bug reports: which level the robot is from, and exactly where it is.
    canvas.dataset["playbackLevel"] = level;
    if (robot === null) delete canvas.dataset["robotPose"];
    else canvas.dataset["robotPose"] = `${String(robot.poseIn.xIn)},${String(robot.poseIn.yIn)},${String(robot.poseIn.headingRad)}`;
    // Published for tests and bug reports: the step the robot is a guess during, and the step whose
    // envelope is hatched in the unknown colour (issue #481). Absent when there is none.
    const unknownSpansNow = unknownNow();
    const unknownRobot = robot?.unknown === true ? unknownSpanAt(unknownSpansNow, current.playbackS ?? 0)?.stepId ?? null : null;
    if (unknownRobot === null) delete canvas.dataset["robotUnknown"];
    else canvas.dataset["robotUnknown"] = unknownRobot;
    const unknownEnvelope = openUnknownEnvelope(unknownSpansNow, current.playbackS ?? 0);
    if (unknownEnvelope === null) delete canvas.dataset["unknownEnvelope"];
    else canvas.dataset["unknownEnvelope"] = unknownEnvelope;
    const trajectory = idealRef.current;
    // The ledger's counts at the playback time, from the steps the preview sim has finished by then.
    const badges =
      current.showLedgerCounts === false
        ? []
        : ledgerBadgesAt(current.ledger, previewRef.current, current.playbackS, current.auto.alliance);
    canvas.dataset["ledger"] = badgeSummary(badges);
    const drawnGhosts = ghostsToDraw(
      ghostsRef.current,
      current.clipGhosts ?? true,
      current.hoveredFindingKey ?? null,
      current.selection.stepId ?? null,
    );
    // How many ghosts this frame draws, for tests and bug reports (issue #412).
    canvas.dataset["ghosts"] = String(drawnGhosts.length);
    // The obstacle a hovered STRUCTURE row outlines (issue #152), for tests and bug reports.
    const outlined = outlinedObstacle(drawnGhosts);
    if (outlined === null) delete canvas.dataset["outlinedObstacle"];
    else canvas.dataset["outlinedObstacle"] = outlined;
    // How the start mark is drawn, "error" while START_ILLEGAL stands (issue #155), for tests and bug reports.
    canvas.dataset["startMark"] = startMarkTone(current.findings);
    // The clearance outline's margin while it draws (owner ruling D8), for tests and bug reports.
    const clearanceOutlineIn = current.clearanceOutline === true ? robotClearanceIn(current.robot) : null;
    if (clearanceOutlineIn === null || robot === null) delete canvas.dataset["clearanceOutline"];
    else canvas.dataset["clearanceOutline"] = String(clearanceOutlineIn);
    // The Optimize card's preview (issue #308), published for tests and bug reports: the step it
    // proposes a route for, how many joints and margin outlines it draws, and how many robot
    // outlines it accounts for, which is never more than one.
    const overlay = current.candidate ?? null;
    const candidate =
      overlay === null
        ? null
        : {
            step: candidateStepRef.current,
            jointsIn: overlay.jointsIn,
            marginOutlinesIn: overlay.marginOutlines.map((outline) => outline.polygonIn),
            ghostPoseIn: overlay.ghostPoseIn,
          };
    if (candidate === null) {
      for (const key of ["candidate", "candidateJoints", "candidateMargins", "candidateOutlines", "candidateGhost"]) delete canvas.dataset[key];
    } else {
      canvas.dataset["candidate"] = candidate.step === null ? "" : overlay?.stepId ?? "";
      canvas.dataset["candidateJoints"] = String(candidate.step === null ? 0 : candidate.jointsIn.length);
      canvas.dataset["candidateMargins"] = String(candidate.marginOutlinesIn.length);
      canvas.dataset["candidateOutlines"] = String(candidateOutlinePoses({ hoverPoseIn: candidateHover(), ghostPoseIn: candidate.ghostPoseIn }).length);
      if (candidate.ghostPoseIn === null) delete canvas.dataset["candidateGhost"];
      else canvas.dataset["candidateGhost"] = `${String(candidate.ghostPoseIn.xIn)},${String(candidate.ghostPoseIn.yIn)}`;
    }
    const loaded = state.fieldImage;
    // The printable light picture needs dark ink (theme.ts LIGHT_FIELD_INK), only while it shows.
    const lightField = loaded !== null && effectiveView() !== "vector" && current.fieldImageVariant === "light";
    drawLive(ctx, {
      candidate,
      scene: sceneRef.current,
      baseScene: baseSceneRef.current,
      view: state.view,
      theme: liveInk(state.theme, lightField),
      robot: current.robot,
      bounds: fieldBounds(current.field),
      mirror: mirrorRef.current,
      baseMirror: baseMirrorRef.current,
      selection: current.selection,
      hover: state.hover,
      findings: current.findings,
      trace,
      widthPx: state.widthPx,
      heightPx: state.heightPx,
      rubberBand: band,
      snapFeedback: state.snapFeedback,
      readout,
      nodeKinds: state.nodeKinds,
      robotPose: robot,
      unknownEnvelopeStepId: unknownEnvelope,
      clearanceOutlineIn,
      // At the full sim level the outline is the recorded pose already, so no second mark.
      traceMarker:
        trace !== null && current.playbackS !== undefined && level !== "full"
          ? simPoseAt(trace, current.playbackS)
          : null,
      transitions:
        level === "ideal" && trajectory !== null
          ? trajectory.transitions.map((transition) => ({ fromIn: transition.fromPose, toIn: transition.toPose }))
          : [],
      bubble: state.bubble,
      marquee: state.marquee,
      measurement: state.measurement,
      credit: loaded !== null && effectiveView() !== "vector" ? creditLine(loaded.spec) : null,
      highlightRange: current.highlightRange ?? null,
      clipGhosts: drawnGhosts,
      ledgerBadges: badges,
      alliance: current.auto.alliance,
      // The count chips as drawn, split by piece and with where each sits, for tests and bug reports.
      onFieldCounts: (labels) => {
        canvas.dataset["ledgerCounts"] = countLabelsSummary(labels);
      },
      activeHeadingHandle:
        state.press?.drag?.kind === "headingHandle"
          ? { stepId: state.press.drag.stepId, key: state.press.drag.handle.key }
          : null,
      activeEnvelopeHandle:
        state.press?.drag?.kind === "envelopeRect" && state.press.moved
          ? { stepId: state.press.drag.stepId, grab: state.press.drag.grab }
          : null,
      startKnob: showStartKnob()
        ? { active: state.hover?.startKnob === true || state.press?.drag?.kind === "startHeading" }
        : null,
      activePin: activePin(),
    });
  }, [activePin, blitsWhileMoving, candidateHover, effectiveView, paintStatic, reachablePins, robotPose, rubberBand, showStartKnob, unknownNow]);

  const requestDraw = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      draw();
    });
  }, [draw]);

  const markStaticDirty = useCallback(() => {
    stateRef.current.staticDirty = true;
    stateRef.current.hitScene = null;
  }, []);

  /** A press ended: the pins are drawn as the shell hides them now, without the held ones. */
  const releaseHeld = useCallback(() => {
    const held = heldHiddenRef.current;
    if (held === null) return;
    heldHiddenRef.current = null;
    const hidden = propsRef.current.hiddenWaypoints;
    if (hidden !== undefined && [...hidden].some((name) => held.hidden?.has(name) !== true)) {
      markStaticDirty();
      requestDraw();
    }
  }, [markStaticDirty, requestDraw]);

  /**
   * A new view, drawn on the next frame, which repaints the field at it. A field picture that paints
   * slowly is blitted under the new view instead and repainted sharp once the gesture has settled.
   */
  const setView = useCallback(
    (view: View) => {
      const state = stateRef.current;
      state.view = view;
      state.hitScene = null;
      if (state.staticTimer !== null) window.clearTimeout(state.staticTimer);
      state.staticTimer = null;
      if (blitsWhileMoving()) {
        state.staticTimer = window.setTimeout(() => {
          state.staticTimer = null;
          state.staticDirty = true;
          requestDraw();
        }, STATIC_SETTLE_MS);
      }
      requestDraw();
    },
    [blitsWhileMoving, requestDraw],
  );

  /**
   * What a fit frames now (issue #151): the field and its margin, and the routine where it is drawn,
   * with the robot's half-diagonal around it. Only Zoom to fit and an auto opening call this; the
   * box is then held in `fitBoundsIn`.
   */
  const routineFitBounds = useCallback(
    (): Box2 => fitBounds(bounds, routinePoints(sceneRef.current, mirrorRef.current), robotReachIn(propsRef.current.robot)),
    [bounds],
  );

  const fit = useCallback(() => {
    const state = stateRef.current;
    if (state.widthPx === 0) return;
    state.userAdjusted = false;
    state.laidOutAt = { widthPx: state.widthPx, heightPx: state.heightPx };
    state.fitBoundsIn = routineFitBounds();
    setView(fitView(state.fitBoundsIn, state.widthPx, state.heightPx, FIT_PADDING, orientation));
  }, [orientation, routineFitBounds, setView]);

  /**
   * Lays the view out for the pane's current size: refit, or re-centred once the user has moved it.
   * A no-op while a press is down, so a pane that resizes mid-drag (the status strip timing out)
   * never slides the field under the pointer; `finishPress` calls it again to catch up.
   */
  const layoutToPane = useCallback((): boolean => {
    const state = stateRef.current;
    const before = state.view;
    const layout = layoutPane(
      state.view === null || state.laidOutAt === null ? null : { view: state.view, laidOutAt: state.laidOutAt },
      { widthPx: state.widthPx, heightPx: state.heightPx },
      state.userAdjusted,
      state.press !== null,
      // The box held since the last fit, so a resize refits to it. The first layout of an auto
      // works it out, which is the fit when an auto opens.
      (size) => {
        state.fitBoundsIn ??= routineFitBounds();
        return fitView(state.fitBoundsIn, size.widthPx, size.heightPx, FIT_PADDING, orientation);
      },
    );
    state.view = layout.view;
    state.laidOutAt = layout.laidOutAt;
    return state.view !== before;
  }, [orientation, routineFitBounds]);

  /** `F`: frame the selected points, or the selected step, or the whole routine. */
  const zoomToSelection = useCallback(() => {
    const state = stateRef.current;
    if (state.widthPx === 0) return;
    const current = propsRef.current;
    // A pin is drawn in waypoints.json's own frame and never mirrored, so it is framed as it is.
    const pinName = current.selection.waypoint;
    const pin = pinName === undefined ? undefined : current.waypoints?.waypoints[pinName];
    const points: Vec2[] = pin === undefined ? [] : [{ xIn: pin.xIn, yIn: pin.yIn }];
    const chosen = selectedPoints(current.selection);
    for (const entry of chosen) {
      const step = sceneRef.current.steps.find((candidate) => candidate.stepId === entry.stepId);
      const handle = step?.handles.find(
        (candidate) =>
          candidate.target.segmentIndex === entry.point.segmentIndex &&
          candidate.target.pointKind === entry.point.pointKind,
      );
      const control = step?.controls.find(
        (candidate) =>
          candidate.target.segmentIndex === entry.point.segmentIndex &&
          (candidate.target.controlIndex ?? 0) === (entry.point.controlIndex ?? 0) &&
          entry.point.pointKind === "control",
      );
      if (handle !== undefined) points.push(handle.poseIn);
      else if (control !== undefined) points.push(control.pointIn);
    }
    if (points.length === 0 && current.selection.stepId !== undefined) {
      const step = sceneRef.current.steps.find((candidate) => candidate.stepId === current.selection.stepId);
      if (step !== undefined) points.push(...step.poses);
    }
    if (points.length === 0) {
      points.push(sceneRef.current.startPose);
      for (const step of sceneRef.current.steps) points.push(...step.poses);
    }
    state.userAdjusted = true;
    state.laidOutAt = { widthPx: state.widthPx, heightPx: state.heightPx };
    setView(
      fitView(
        selectionFrameBounds(points, pin !== undefined, mirrorRef.current),
        state.widthPx,
        state.heightPx,
        FIT_PADDING,
        orientation,
      ),
    );
  }, [orientation, setView]);

  // ---- element lifecycle -----------------------------------------------------------------

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (host === null || canvas === null) return;

    const state = stateRef.current;
    state.staticCanvas = document.createElement("canvas");
    state.theme = readTheme(document.documentElement);

    const applySize = (): void => {
      const rect = host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const widthPx = Math.max(1, Math.round(rect.width));
      const heightPx = Math.max(1, Math.round(rect.height));
      state.widthPx = widthPx;
      state.heightPx = heightPx;
      state.dpr = dpr;
      canvas.width = Math.round(widthPx * dpr);
      canvas.height = Math.round(heightPx * dpr);
      if (state.staticCanvas !== null) {
        state.staticCanvas.width = canvas.width;
        state.staticCanvas.height = canvas.height;
      }
      layoutToPane();
      markStaticDirty();
      draw();
    };

    // A new field or orientation re-fits a view the user has not moved, whatever the pane's size,
    // and what a fit frames is worked out again for it.
    state.fitBoundsIn = null;
    if (!state.userAdjusted) state.laidOutAt = null;
    applySize();
    const observer = new ResizeObserver(applySize);
    observer.observe(host);

    const stopTheme = observeTheme(document.documentElement, () => {
      state.theme = readTheme(document.documentElement);
      markStaticDirty();
      requestDraw();
    });

    const onWheel = (event: WheelEvent): void => {
      if (state.view === null) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchor = { xPx: event.clientX - rect.left, yPx: event.clientY - rect.top };
      // Lines, not pixels, from a notched wheel; a pinch arrives as a ctrl-wheel with small deltas.
      const deltaPx = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
      const rate = event.ctrlKey ? 0.01 : 0.0015;
      state.userAdjusted = true;
      setView(zoomAbout(state.view, anchor, Math.exp(-deltaPx * rate)));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // The middle button pans the field (issue #115). Chromium on Windows starts its autoscroll on
    // the middle button's mousedown, which swallows the moves the pan needs, and Linux pastes on its
    // auxclick, so the canvas cancels both. The side buttons are left to the app's navigation.
    const onMiddle = (event: MouseEvent): void => {
      if (event.button === 1) event.preventDefault();
    };
    canvas.addEventListener("mousedown", onMiddle);
    canvas.addEventListener("auxclick", onMiddle);
    // A Ctrl + right drag that ends off the canvas sends its context menu event to whatever is
    // under the pointer, so it is caught on the window, before anything else can open a menu.
    const onAnyContextMenu = (event: MouseEvent): void => {
      if (!state.swallowMenu) return;
      state.swallowMenu = false;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("contextmenu", onAnyContextMenu, true);

    return () => {
      observer.disconnect();
      stopTheme();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mousedown", onMiddle);
      canvas.removeEventListener("auxclick", onMiddle);
      window.removeEventListener("contextmenu", onAnyContextMenu, true);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      if (state.staticTimer !== null) window.clearTimeout(state.staticTimer);
      state.staticTimer = null;
    };
  }, [draw, layoutToPane, markStaticDirty, requestDraw, setView]);

  // The field, the named poses and the view mode are what the static layer reads.
  useEffect(() => {
    markStaticDirty();
    requestDraw();
  }, [
    props.field,
    props.waypoints,
    props.selection.waypoint,
    hiddenKey,
    fieldView,
    // The robot's height decides which boxes are overhead, and the option whether those are drawn.
    props.robot,
    props.overheadOutlines,
    // The Grid setting is drawn by the static layer, so a change repaints it.
    props.fieldGrid,
    markStaticDirty,
    requestDraw,
  ]);

  // Another auto opened in the same canvas (issue #151): what a fit frames is worked out again for
  // it, and a view the user has not moved is fitted to it, as the first auto was. A view the user
  // panned or zoomed stays where they put it until they next fit.
  const openedAuto = props.openedAuto;
  const openedAutoRef = useRef(openedAuto);
  useEffect(() => {
    if (openedAutoRef.current === openedAuto) return;
    openedAutoRef.current = openedAuto;
    const state = stateRef.current;
    state.fitBoundsIn = null;
    if (state.userAdjusted) return;
    state.laidOutAt = null;
    layoutToPane();
    markStaticDirty();
    requestDraw();
  }, [openedAuto, layoutToPane, markStaticDirty, requestDraw]);

  useEffect(() => {
    const state = stateRef.current;
    const svg = props.staticSvg;
    if (svg === undefined || svg === null || svg === "") {
      state.staticImage = null;
      markStaticDirty();
      requestDraw();
      return;
    }
    const image = new Image();
    image.onload = () => {
      state.staticImage = image;
      markStaticDirty();
      requestDraw();
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    return () => {
      image.onload = null;
    };
  }, [props.staticSvg, markStaticDirty, requestDraw]);

  // Written on import.meta.env.DEV so a production build has neither the overlay nor its switch.
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    let unwatch = (): void => undefined;
    let live = true;
    void import("./fieldReference.js").then((module) => {
      if (!live) return;
      fieldReferenceRef.current = module;
      const repaint = (): void => {
        markStaticDirty();
        requestDraw();
      };
      unwatch = module.watchFieldReference(repaint);
      repaint();
    });
    return () => {
      live = false;
      unwatch();
    };
  }, [markStaticDirty, requestDraw]);

  // The field picture (site/docs/editor.md). Absent or broken, the canvas draws the vector field.
  const imageSpec = useMemo(() => readFieldImage(props.field), [props.field]);
  const imageSrc =
    props.fieldImageSrc ??
    (imageSpec === null
      ? null
      : resolveImageUrl(chooseImageSource(imageSpec, props.fieldImageVariant), APP_BASE_URL));
  useEffect(() => {
    const state = stateRef.current;
    if (imageSpec === null || imageSrc === null || imageSrc === "") {
      state.fieldImage = null;
      markStaticDirty();
      requestDraw();
      return;
    }
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      state.fieldImage = { spec: imageSpec, image };
      markStaticDirty();
      requestDraw();
    };
    image.onerror = () => {
      state.fieldImage = null;
      markStaticDirty();
      requestDraw();
    };
    image.src = imageSrc;
    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [imageSpec, imageSrc, markStaticDirty, requestDraw]);

  useEffect(() => {
    if (props.previewTrace !== undefined) return;
    const plan = props.plan;
    const robot = props.robot;
    const field = props.field;
    const frame = requestAnimationFrame(() => {
      try {
        const previous = simRunRef.current;
        const options = previewSimOptions(plan, field);
        const run =
          previous === null
            ? simulateRun(plan, robot, field, options)
            : resimulate(previous, plan, robot, field, options);
        simRunRef.current = run;
        simTraceRef.current = run.trace;
      } catch {
        simRunRef.current = null;
        simTraceRef.current = null;
      }
      previewRef.current = simTraceRef.current;
      requestDraw();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [props.plan, props.robot, props.field, props.previewTrace, requestDraw]);

  // Anything the live layer reads redraws without touching the static layer.
  useEffect(() => {
    stateRef.current.hitScene = null;
    requestDraw();
  }, [
    scene,
    baseScene,
    candidateStep,
    props.candidate,
    props.selection,
    props.tool,
    props.alliance,
    props.findings,
    props.trace,
    props.previewTrace,
    props.playbackLevel,
    ideal,
    props.playbackS,
    props.playing,
    props.insertAnchorStepId,
    props.highlightRange,
    props.partners,
    props.clipGhosts,
    props.clearanceOutline,
    props.overheadOutlines,
    hiddenKey,
    props.ledger,
    props.showLedgerCounts,
    props.hoveredFindingKey,
    requestDraw,
  ]);

  // The measurement belongs to the measure tool: leaving the tool clears it.
  useEffect(() => {
    if (props.tool !== "measure" && stateRef.current.measurement !== null) {
      stateRef.current.measurement = null;
      requestDraw();
    }
  }, [props.tool, requestDraw]);

  // ---- pointer ---------------------------------------------------------------------------

  const hitScene = useCallback((): HitScene => {
    const state = stateRef.current;
    if (state.hitScene === null && state.view !== null) {
      state.hitScene = projectHitScene(
        sceneRef.current,
        state.view,
        mirrorRef.current,
        propsRef.current.selection,
        state.hover?.stepId ?? null,
        showStartKnob(),
        propsRef.current.onDragStartPose !== undefined,
      );
      const pins = reachablePins(state.view);
      if (pins !== undefined) state.hitScene.pins = pins;
    }
    return state.hitScene ?? { handles: [], markers: [], polylines: [], knobs: [] };
  }, [reachablePins, showStartKnob]);

  const localPoint = useCallback((event: { clientX: number; clientY: number }): ScreenVec => {
    const canvas = canvasRef.current;
    if (canvas === null) return { xPx: 0, yPx: 0 };
    const rect = canvas.getBoundingClientRect();
    return { xPx: event.clientX - rect.left, yPx: event.clientY - rect.top };
  }, []);

  /** Screen pixels to world inches in the file's own frame: the mirror comes off here and nowhere else. */
  const toWorld = useCallback((xPx: number, yPx: number): Vec2 => {
    const state = stateRef.current;
    if (state.view === null) return { xIn: 0, yIn: 0 };
    return mirrorVec(screenToWorld(state.view, { xPx, yPx }), mirrorRef.current);
  }, []);

  /** The snap context, with the wall rule's footprint supplied by the caller. */
  const snapContext = useCallback(
    (footprint: SnapContext["footprintBounds"], body?: SnapContext["bodyBounds"]): SnapContext => {
      const state = stateRef.current;
      const context: SnapContext = {
        enabled: propsRef.current.snap,
        altHeld: false,
        pxPerIn: state.view?.pxPerIn ?? 1,
        waypoints: shownWaypoints(),
        bounds,
        footprintBounds: footprint,
      };
      if (body !== undefined) context.bodyBounds = body;
      return context;
    },
    [bounds, shownWaypoints],
  );

  /**
   * Where an add-path or add-command click at `world` puts its point (issue #150): `placeAddPoint`
   * from the pose it continues from, with the canvas's snap rules and the wall rule against the
   * robot's footprint. The preview under the pointer, the click and the field menu's "Add a path to
   * here" all call it. `adding` defaults to what the tool adds, and `anchorId` to the shell's insert
   * anchor.
   */
  const addPointPose = useCallback(
    (world: Vec2, keys: HeldKeys, adding?: "path" | "command", anchorId?: string | null): SnapResult | null => {
      const current = propsRef.current;
      const robot = current.robot;
      return placeAddPoint({
        pointerIn: world,
        from: anchorEndPose(anchorId),
        adding: adding ?? (current.tool === "addCommand" ? "command" : "path"),
        modifiers: resolveModifiers(current.snap, keys),
        context: snapContext((pose) => footprintBoundsIn(pose, robot)),
        keepHeading: current.keepNewPathHeading === true,
      });
    },
    [anchorEndPose, snapContext],
  );

  /** True while the palette's Add waypoint waits for the click that picks the spot (issue #234). */
  const placingWaypoint = useCallback(
    (): boolean => propsRef.current.placeWaypointArmed === true && propsRef.current.onPlaceWaypoint !== undefined,
    [],
  );

  /**
   * Works out the add-path or add-command preview again (issue #150): with either tool, no press
   * down and the pointer on the field, where a click at the pointer's pixel would put its point,
   * else nothing; the snap mark and the readout's snap label follow it. `draw` calls it before every
   * frame it paints with no press down. A tool that adds nothing leaves the snap mark alone once its
   * preview is gone.
   */
  const updateAddSnap = useCallback(() => {
    const state = stateRef.current;
    if (state.press !== null) return;
    const tool = propsRef.current.tool;
    const adding = tool === "addPath" || tool === "addCommand" || placingWaypoint();
    if (!adding && state.addSnap === null) return;
    const at = state.pointerPx;
    state.addSnap = adding && at !== null && state.view !== null ? addPointPose(toWorld(at.xPx, at.yPx), state.keys) : null;
    state.snapFeedback = state.addSnap;
    state.readoutLabel = addReadoutLabel(state.addSnap);
  }, [addPointPose, placingWaypoint, toWorld]);
  updateAddSnapRef.current = updateAddSnap;

  // The preview follows what it is worked out from while the pointer holds still, because `draw`
  // works it out again: the tool, the step a new point continues from and the routine already
  // redraw the live layer, and so do the snap toggle, the waypoints and the robot (issue #150).
  useEffect(() => {
    requestDraw();
  }, [props.snap, props.waypoints, hiddenKey, props.robot, requestDraw]);

  const emitMoves = useCallback((moves: PoseMove[]) => {
    const current = propsRef.current;
    if (moves.length === 0) return;
    if (current.onDragPoses !== undefined) {
      current.onDragPoses(moves);
      return;
    }
    for (const move of moves) current.onDragPose(move.stepId, move.target, move.pose);
  }, []);

  /** A point's pose now, from the scene: an endpoint's resolved pose, or a control at heading 0. */
  const poseOfPoint = useCallback((stepId: string, target: PointTarget): Pose | null => {
    const step = sceneRef.current.steps.find((candidate) => candidate.stepId === stepId);
    if (step === undefined) return null;
    if (target.pointKind === "control") {
      const control = step.controls.find(
        (candidate) =>
          candidate.target.segmentIndex === target.segmentIndex &&
          (candidate.target.controlIndex ?? 0) === (target.controlIndex ?? 0),
      );
      return control === undefined ? null : { ...control.pointIn, headingRad: 0 };
    }
    const handle = step.handles.find(
      (candidate) =>
        candidate.target.segmentIndex === target.segmentIndex && candidate.target.pointKind === target.pointKind,
    );
    return handle?.poseIn ?? null;
  }, []);

  /**
   * The heading the plan gives the robot at an endpoint, from the scene: what the hover bubble and
   * the readout show (issue #147). Null for a control point, which has no heading.
   */
  const plannedHeadingOfPoint = useCallback((stepId: string, target: PointTarget): number | null => {
    if (target.pointKind === "control") return null;
    const step = sceneRef.current.steps.find((candidate) => candidate.stepId === stepId);
    const handle = step?.handles.find(
      (candidate) =>
        candidate.target.segmentIndex === target.segmentIndex && candidate.target.pointKind === target.pointKind,
    );
    return handle?.plannedHeadingRad ?? null;
  }, []);

  /** A heading handle of a step by its key, from the scene as it is now. */
  const headingHandleOf = useCallback((stepId: string, key: string): HeadingHandle | null => {
    const step = sceneRef.current.steps.find((candidate) => candidate.stepId === stepId);
    if (step === undefined) return null;
    return headingHandlesFor(step, step.heading).find((handle) => handle.key === key) ?? null;
  }, []);

  /** The waypoint the routine's start follows, or null when `auto.start.pose` is a pose of its own. */
  const startRef = useCallback((): string | null => {
    const pose = propsRef.current.auto.start.pose;
    return "ref" in pose ? pose.ref : null;
  }, []);

  /** Whether the next press draws a new envelope (the inspector's "Draw on the field"). */
  const drawingEnvelope = useCallback(
    (): boolean => (propsRef.current.drawEnvelopeFor ?? null) !== null && propsRef.current.onDrawEnvelope !== undefined,
    [],
  );

  const cursorFor = useCallback((hit: CanvasHit | null): string => {
    const state = stateRef.current;
    const tool = propsRef.current.tool;
    if (tool === "pan" || state.spaceHeld) return state.press === null ? "grab" : "grabbing";
    const dragKind = state.press?.drag?.kind;
    if (dragKind === "pan") return "grabbing";
    if (dragKind === "headingHandle" || dragKind === "rangeBoundary" || dragKind === "startHeading") return "grabbing";
    if (dragKind === "envelopeDraw" || (state.press === null && drawingEnvelope())) return "crosshair";
    if (state.press?.drag?.kind === "envelopeRect") return cursorForGrab(state.press.drag.grab, hitScene().envelopeHandles ?? []);
    if (hit?.rangeBoundary !== undefined) return "grab";
    if (hit?.envelopeHandle !== undefined && tool === "select" && propsRef.current.onSetEnvelopePolygon !== undefined) {
      return cursorForGrab(hit.envelopeHandle, hitScene().envelopeHandles ?? []);
    }
    if (hit?.headingHandle !== undefined) {
      const handle = headingHandleOf(hit.stepId, hit.headingHandle);
      return handle?.editable === true && propsRef.current.onSetHeading !== undefined ? "grab" : "not-allowed";
    }
    if (tool === "addPath" || tool === "addCommand" || tool === "marker" || tool === "measure" || placingWaypoint()) return "crosshair";
    if (hit === null) return "default";
    if (hit.waypoint !== undefined) return tool === "select" ? "move" : "default";
    if (hit.startKnob === true) return tool === "select" || tool === "heading" ? "grab" : "default";
    if (hit.start === true) {
      if (tool !== "select") return "default";
      // A start that follows a waypoint moves too: the drag makes it a pose of its own.
      return propsRef.current.onDragStartPose !== undefined ? "move" : "not-allowed";
    }
    if (hit.point !== undefined) return "move";
    if (hit.markerIndex !== undefined) return "ew-resize";
    return "pointer";
  }, [drawingEnvelope, headingHandleOf, hitScene, placingWaypoint]);

  /** The hover readout: the robot, t and time on a path; coordinates on a handle. */
  const hoverBubble = useCallback((hit: CanvasHit | null, at: ScreenVec): Bubble | null => {
    if (hit === null) return null;
    if (hit.envelopeHandle !== undefined) {
      // A command's envelope has handles but no path, so this comes before the path lookup. Inside
      // the envelope there is no bubble: it would follow the pointer over the whole rectangle.
      if (hit.envelopeHandle === "move" || propsRef.current.tool !== "select") return null;
      const envelope = sceneEnvelopeOf(sceneRef.current, hit.stepId);
      const rect = envelopeRectOf(sceneRef.current, hit.stepId);
      if (envelope === null || rect === null) return null;
      return {
        xPx: at.xPx,
        yPx: at.yPx,
        lines: envelopeRectLines(hit.stepId, rect, hit.envelopeHandle, null, envelope.maxDurationS),
      };
    }
    if (hit.waypoint !== undefined) {
      // Moving a waypoint moves every point that follows it (issue #134).
      const waypoint = propsRef.current.waypoints?.waypoints[hit.waypoint];
      if (waypoint === undefined) return null;
      const first = propsRef.current.protectedPins?.has(hit.waypoint) === true && propsRef.current.selection.waypoint !== hit.waypoint;
      return { xPx: at.xPx, yPx: at.yPx, lines: [poseLine(waypoint), `waypoint ${hit.waypoint} · ${first ? "press to select, then drag to move" : "drag to move"}`] };
    }
    if (hit.startKnob === true) {
      const headingRad = sceneRef.current.startPose.headingRad;
      const ref = startRef();
      // Turning a start that follows a waypoint unlinks it from the waypoint (issue #133).
      const note = ref === null ? "start heading · drag to turn" : `start heading · follows waypoint ${ref} · drag to turn and unlink`;
      return { xPx: at.xPx, yPx: at.yPx, lines: [`h ${fmt((headingRad * 180) / Math.PI, 1)}°`, note] };
    }
    if (hit.start === true) {
      const ref = startRef();
      const hiddenPin = ref !== null && hiddenNow()?.has(ref) === true ? " (hidden)" : "";
      const follows = ref === null ? "start" : `start · follows waypoint ${ref}${hiddenPin}`;
      // Dragging a start that follows a waypoint unlinks it from the waypoint (issue #133).
      const note =
        propsRef.current.onDragStartPose === undefined
          ? follows
          : ref === null
            ? "start · drag to move"
            : `${follows} · drag to move and unlink`;
      return { xPx: at.xPx, yPx: at.yPx, lines: [poseLine(sceneRef.current.startPose), note] };
    }
    const step = sceneRef.current.steps.find((candidate) => candidate.stepId === hit.stepId);
    if (step === undefined) return null;
    if (hit.headingHandle !== undefined) {
      const handle = headingHandleOf(hit.stepId, hit.headingHandle);
      if (handle === null) return null;
      const value =
        handle.role === "point"
          ? `x ${fmt(handle.poseIn.xIn)}  y ${fmt(handle.poseIn.yIn)} in`
          : `h ${fmt((handle.poseIn.headingRad * 180) / Math.PI, 1)}°`;
      return { xPx: at.xPx, yPx: at.yPx, lines: [value, handle.reason ?? handleLabel(handle)] };
    }
    if (hit.rangeBoundary !== undefined) {
      const heading = step.heading;
      const range = heading?.mode === "piecewise" ? heading.ranges[hit.rangeBoundary] : undefined;
      if (range === undefined) return null;
      return {
        xPx: at.xPx,
        yPx: at.yPx,
        lines: [`t ${range.endT.toFixed(2)} · boundary`, `ranges ${String(hit.rangeBoundary + 1)} and ${String(hit.rangeBoundary + 2)} · drag along the path`],
      };
    }
    if (hit.point !== undefined) {
      const pose = poseOfPoint(hit.stepId, hit.point);
      if (pose === null) return null;
      const name =
        hit.point.pointKind === "control"
          ? `${hit.stepId} · control`
          : `${hit.stepId} · ${hit.point.pointKind === "from" ? "start" : `point ${String(hit.point.segmentIndex + 1)}`}`;
      const follows = followedWaypointsRef.current.get(`${hit.stepId}|${String(hit.point.segmentIndex)}|${hit.point.pointKind}`);
      // A dot that follows a hidden pin still draws, and says the pin is hidden (issue #236).
      const hiddenPin = follows !== undefined && hiddenNow()?.has(follows) === true ? " (hidden)" : "";
      return {
        xPx: at.xPx,
        yPx: at.yPx,
        lines: [pointLine(pose, plannedHeadingOfPoint(hit.stepId, hit.point)), follows === undefined ? name : `${name} · follows waypoint ${follows}${hiddenPin}`],
      };
    }
    if (hit.t === undefined || hit.markerIndex !== undefined) return null;
    const pose = poseAtT(step, hit.t);
    // The time comes from the playback level, and says so: "1.24 s ideal", "1.31 s instant sim".
    const current = propsRef.current;
    const level: PlaybackLevel = current.playbackLevel ?? "ideal";
    const run =
      level === "instant" ? previewRef.current : level === "full" ? (current.trace ?? null) : null;
    const trajectory = idealRef.current;
    const seconds =
      level === "ideal"
        ? ((trajectory === null ? null : idealTimeAt(trajectory, hit.stepId, hit.t)) ?? timeAtT(step, hit.t))
        : ((run === null ? null : traceTimeNear(run, hit.stepId, pose)) ?? timeAtT(step, hit.t));
    const timeText = seconds === null ? "no estimate" : `${fmt(seconds)} s ${LEVEL_WORD[level]}`;
    return { xPx: at.xPx, yPx: at.yPx, lines: [`t ${hit.t.toFixed(2)} · ${timeText}`, hit.stepId] };
  }, [headingHandleOf, plannedHeadingOfPoint, poseOfPoint, startRef]);

  const updateHover = useCallback(
    (xPx: number, yPx: number) => {
      const state = stateRef.current;
      const hit = hitTest(hitScene(), xPx, yPx);
      const changed =
        hit?.stepId !== state.hover?.stepId ||
        hit?.markerIndex !== state.hover?.markerIndex ||
        hit?.headingHandle !== state.hover?.headingHandle ||
        hit?.rangeBoundary !== state.hover?.rangeBoundary ||
        hit?.envelopeHandle !== state.hover?.envelopeHandle ||
        hit?.start !== state.hover?.start ||
        hit?.startKnob !== state.hover?.startKnob ||
        hit?.waypoint !== state.hover?.waypoint ||
        hit?.point?.pointKind !== state.hover?.point?.pointKind ||
        hit?.point?.segmentIndex !== state.hover?.point?.segmentIndex ||
        hit?.point?.controlIndex !== state.hover?.point?.controlIndex;
      // The hovered step's control points are grabbable only while its dots are shown.
      if (hit?.stepId !== state.hover?.stepId) state.hitScene = null;
      // So is the start's heading knob, which shows while the start or the knob is hovered.
      const onStart = (candidate: CanvasHit | null): boolean => candidate?.start === true || candidate?.startKnob === true;
      if (onStart(hit) !== onStart(state.hover)) state.hitScene = null;
      state.hover = hit;
      state.readoutHeadingRad = null;
      if (hit !== null && hit.t !== undefined) {
        const step = sceneRef.current.steps.find((candidate) => candidate.stepId === hit.stepId);
        state.readoutHeadingRad = step === undefined ? null : poseAtT(step, hit.t).headingRad;
      } else if (hit?.point !== undefined && hit.point.pointKind !== "control") {
        state.readoutHeadingRad = plannedHeadingOfPoint(hit.stepId, hit.point);
      } else if (hit?.start === true || hit?.startKnob === true) {
        state.readoutHeadingRad = sceneRef.current.startPose.headingRad;
      } else if (hit?.waypoint !== undefined) {
        state.readoutHeadingRad = propsRef.current.waypoints?.waypoints[hit.waypoint]?.headingRad ?? null;
      }
      state.bubble = propsRef.current.tool === "measure" ? null : hoverBubble(hit, { xPx, yPx });
      if (changed) propsRef.current.onHover(hit);
      const canvas = canvasRef.current;
      if (canvas !== null) canvas.style.cursor = cursorFor(hit);
    },
    [cursorFor, hitScene, hoverBubble, plannedHeadingOfPoint],
  );

  // Alt+click changes the selection under a pointer that has not moved, and with it which of the
  // overlapping steps is on top there (issue #149). The hover is worked out again for the new
  // selection, so the bubble and the highlighted path name the step a click there now picks. It runs
  // only when the selection changes, not on every frame that hands the canvas a new callback.
  const hoveredSelectionRef = useRef(props.selection);
  useEffect(() => {
    if (hoveredSelectionRef.current === props.selection) return;
    hoveredSelectionRef.current = props.selection;
    const state = stateRef.current;
    if (state.press !== null || state.pointerPx === null || state.hover === null) return;
    state.hitScene = null;
    updateHover(state.pointerPx.xPx, state.pointerPx.yPx);
    requestDraw();
  }, [props.selection, requestDraw, updateHover]);

  /** Every point position the measure tool's ends can land on. */
  const measureCandidates = useCallback((): Vec2[] => {
    const out: Vec2[] = [];
    for (const step of sceneRef.current.steps) {
      for (const handle of step.handles) if (!handle.chained) out.push(handle.poseIn);
      for (const control of step.controls) out.push(control.pointIn);
    }
    for (const waypoint of shownWaypoints()) out.push(waypoint);
    out.push(sceneRef.current.startPose);
    return out;
  }, [shownWaypoints]);

  const beginDrag = useCallback(
    (xPx: number, yPx: number, keys: HeldKeys): Drag | null => {
      const state = stateRef.current;
      const current = propsRef.current;
      if (state.view === null) return null;
      if (current.tool === "pan" || state.spaceHeld) return { kind: "pan", lastXPx: xPx, lastYPx: yPx };
      // A click that picks the spot for a new waypoint starts no drag, whatever it lands on.
      if (placingWaypoint()) return null;
      if (drawingOff()) return null;

      if (current.tool === "measure") {
        const modifiers = resolveModifiers(current.snap, keys);
        const pointer = toWorld(xPx, yPx);
        const fromIn = modifiers.snap
          ? snapMeasureEnd(pointer, measureCandidates(), state.view.pxPerIn).pointIn
          : pointer;
        return { kind: "measure", fromIn };
      }

      // Drawing a new envelope takes the press wherever it lands, so the first corner can go on top
      // of a path or a dot.
      const drawFor = current.drawEnvelopeFor ?? null;
      if (drawFor !== null && current.onDrawEnvelope !== undefined) {
        const fromIn = snapDrawStart(toWorld(xPx, yPx), resolveModifiers(current.snap, keys), snapContext(() => null));
        return { kind: "envelopeDraw", stepId: drawFor, fromIn };
      }

      const hit = hitTest(hitScene(), xPx, yPx);

      // A heading handle turns the step's heading mode, through the shell's `onSetHeading`.
      const headingFrom = (stepId: string, key: string): Drag | null => {
        if (current.onSetHeading === undefined) return null;
        const handle = headingHandleOf(stepId, key);
        const heading = sceneRef.current.steps.find((step) => step.stepId === stepId)?.heading;
        if (handle === null || heading === undefined || !handle.editable) return null;
        return { kind: "headingHandle", stepId, handle, heading, lastRad: handleValueRad(heading, handle) ?? handle.poseIn.headingRad };
      };

      // A drag on a heading arrow or a range tick turns it in any tool. A click on one that does not
      // move is the tool's: in the Marker tool it drops a marker there (`clickAction`, issue #412).
      if (hit?.headingHandle !== undefined) return headingFrom(hit.stepId, hit.headingHandle);
      if (hit?.rangeBoundary !== undefined && current.onSetHeading !== undefined) {
        const heading = sceneRef.current.steps.find((step) => step.stepId === hit.stepId)?.heading;
        if (heading?.mode === "piecewise") return { kind: "rangeBoundary", stepId: hit.stepId, index: hit.rangeBoundary, heading };
      }
      if (hit?.envelopeHandle !== undefined && current.tool === "select" && current.onSetEnvelopePolygon !== undefined) {
        const startRect = envelopeRectOf(sceneRef.current, hit.stepId);
        if (startRect !== null) {
          return { kind: "envelopeRect", stepId: hit.stepId, grab: hit.envelopeHandle, startRect, pressIn: toWorld(xPx, yPx) };
        }
      }

      if (hit?.startKnob === true) {
        if ((current.tool !== "select" && current.tool !== "heading") || current.onTurnStartPose === undefined) return null;
        return { kind: "startHeading", pose: { ...sceneRef.current.startPose } };
      }

      if (hit?.waypoint !== undefined) {
        // A pin moves with the select tool, where the shell can move it (issue #134).
        const waypoint = current.waypoints?.waypoints[hit.waypoint];
        if (current.tool !== "select" || current.onDragWaypoint === undefined || waypoint === undefined) return null;
        // A measured pin that is not selected takes this press as a select, and the next press-drag
        // moves it (decision D12). No drag starts, so nothing is written and no undo step opens.
        if (current.protectedPins?.has(hit.waypoint) === true && current.selection.waypoint !== hit.waypoint) {
          current.onProtectedPinPress?.(hit.waypoint);
          return null;
        }
        return { kind: "waypoint", name: hit.waypoint, pose: { xIn: waypoint.xIn, yIn: waypoint.yIn, headingRad: waypoint.headingRad } };
      }

      if (current.tool === "heading") {
        // The heading tool turns whichever turnable heading arrow is nearest, wherever the press lands.
        const arrows = projectHeadingHandles(sceneRef.current, state.view, mirrorRef.current, current.selection).filter(
          (entry) => entry.editable,
        );
        const handle = nearest(arrows, xPx, yPx, Number.POSITIVE_INFINITY);
        return handle === null ? null : headingFrom(handle.stepId, handle.key);
      }

      if (hit?.point !== undefined) {
        const leaderPose = poseOfPoint(hit.stepId, hit.point);
        if (leaderPose === null) return null;
        const leaderPoint = { stepId: hit.stepId, point: hit.point };
        const inSelection = isPointSelected(current.selection, leaderPoint);
        const followers: StartPoint[] = [];
        // The whole selection moves whatever Shift says at the press: Shift only locks the axis
        // (issue #148), and a Shift-click that does not move still toggles the point.
        if (inSelection) {
          for (const entry of selectedPoints(current.selection)) {
            if (entry.stepId === hit.stepId && entry.point.pointKind === hit.point.pointKind &&
                entry.point.segmentIndex === hit.point.segmentIndex &&
                (entry.point.controlIndex ?? 0) === (hit.point.controlIndex ?? 0)) continue;
            const pose = poseOfPoint(entry.stepId, entry.point);
            if (pose !== null) followers.push({ ...entry, pose });
          }
        }
        const polygons = new Map<string, Vec2[][]>();
        for (const step of sceneRef.current.steps) polygons.set(step.stepId, step.polygons.map((polygon) => polygon.map((point) => ({ ...point }))));
        // Where one segment ends and the next starts is one point (issue #146): a drag of either end
        // brings the other, decided once here so the drag never picks up an end it passes over.
        const authored = new Map(flatStepsRef.current.map((step) => [step.id, step.step]));
        const waypoints = current.waypoints ?? undefined;
        const twinOf = (stepId: string, target: PointTarget): PointTarget | null => {
          const step = authored.get(stepId);
          return step?.kind === "path" ? jointTwin(step, target, waypoints) : null;
        };
        return {
          kind: "points",
          leader: { ...leaderPoint, pose: leaderPose },
          followers,
          steps: flatStepsRef.current,
          polygons,
          isControl: hit.point.pointKind === "control",
          rayAnchorIn: rayAnchorOf(polygons.get(hit.stepId) ?? [], hit.point),
          twinOf,
        };
      }
      if (hit?.markerIndex !== undefined) return { kind: "marker", stepId: hit.stepId, markerIndex: hit.markerIndex };
      if (hit?.start === true) {
        // The start moves with the select tool only. A start that follows a waypoint moves too: the
        // shell makes it a pose of its own and leaves the waypoint where it is (issue #133). The
        // path points that sit on the start at the press go with it, so the route stays joined.
        if (current.tool !== "select" || current.onDragStartPose === undefined) return null;
        return { kind: "start", pose: { ...sceneRef.current.startPose }, carried: pointsOnStart(sceneRef.current) };
      }
      if (current.tool === "select") return { kind: "marquee", base: current.selection, additive: keys.shift };
      return null;
    },
    [drawingOff, headingHandleOf, hitScene, measureCandidates, placingWaypoint, poseOfPoint, snapContext, toWorld],
  );

  /** One frame of whatever the press is doing, at a pointer position and a set of held keys. */
  const applyDrag = useCallback(
    (xPx: number, yPx: number, keys: HeldKeys) => {
      const state = stateRef.current;
      const current = propsRef.current;
      const press = state.press;
      if (press === null || press.drag === null || !press.moved) return;
      const drag = press.drag;
      const pointerIn = toWorld(xPx, yPx);
      const modifiers = resolveModifiers(current.snap, keys);

      if (drag.kind === "pan") {
        if (state.view !== null) {
          state.userAdjusted = true;
          setView(panBy(state.view, xPx - drag.lastXPx, yPx - drag.lastYPx));
          drag.lastXPx = xPx;
          drag.lastYPx = yPx;
        }
        return;
      }

      if (drag.kind === "points") {
        const { leader } = drag;
        const robot = current.robot;
        const context = snapContext(
          drag.isControl
            ? () => null
            : (pose) => draggedFootprintBounds(drag.steps, robot, leader.stepId, leader.point, pose, "all"),
          drag.isControl
            ? undefined
            : (pose) => draggedFootprintBounds(drag.steps, robot, leader.stepId, leader.point, pose, "body"),
        );
        const result = resolveLeader(leader.pose, pointerIn, modifiers, context, drag.rayAnchorIn ?? undefined);
        const moves = planPointDrag({
          leader,
          leaderPose: result.pose,
          followers: drag.followers,
          polygonsOf: (stepId) => drag.polygons.get(stepId) ?? null,
          nodeKinds: state.nodeKinds,
          breakMirror: modifiers.breakMirror,
          twinOf: drag.twinOf,
          // A point snapped onto a waypoint names it, so the shell makes a path end follow it (issue #150).
          ...(result.snap.kind === "waypoint" && result.snap.waypoint !== undefined ? { leaderWaypoint: result.snap.waypoint } : {}),
        });
        state.snapFeedback = result.snap;
        // The plan's heading at the point, not the one the pose carries, which turns nothing (issue #147).
        const plannedRad = plannedHeadingOfPoint(leader.stepId, leader.point);
        state.readoutHeadingRad = plannedRad;
        state.readoutLabel = result.label;
        const count = drag.followers.length + 1;
        const values = pointLine(result.pose, plannedRad);
        const notes = [result.label ?? "no snap"];
        if (count > 1) notes.push(`${String(count)} points`);
        state.bubble = { xPx, yPx, lines: [values, notes.join(" · ")] };
        emitMoves(moves);
        requestDraw();
        return;
      }

      if (drag.kind === "start") {
        // The start drags like an endpoint: the same snap rules, the same Shift axis, and the wall
        // snap against the robot's footprint at the start's own heading, which the drag keeps.
        const robot = current.robot;
        const context = snapContext(
          (pose) => footprintBoundsIn(pose, robot),
          (pose) => bodyBoundsIn(pose, robot),
        );
        const result = resolveLeader(drag.pose, pointerIn, modifiers, context);
        state.snapFeedback = result.snap;
        state.readoutHeadingRad = result.pose.headingRad;
        state.readoutLabel = result.label;
        state.bubble = { xPx, yPx, lines: [poseLine(result.pose), `start · ${result.label ?? "no snap"}`] };
        current.onDragStartPose?.(result.pose, drag.carried);
        requestDraw();
        return;
      }

      if (drag.kind === "waypoint") {
        // A pin drags like the start: the same snap rules (another waypoint, the grid, the wall
        // against the robot's footprint at the pin's heading, which the drag keeps) and the same
        // Shift axis. The pins are drawn in waypoints.json's own frame and never mirrored, so the
        // pointer is read in that frame too, and a mirrored view shows no snap mark.
        const robot = current.robot;
        const base = snapContext(
          (pose) => footprintBoundsIn(pose, robot),
          (pose) => bodyBoundsIn(pose, robot),
        );
        const context = { ...base, waypoints: base.waypoints.filter((waypoint) => waypoint.name !== drag.name) };
        const pointer = state.view === null ? pointerIn : screenToWorld(state.view, { xPx, yPx });
        const result = resolveLeader(drag.pose, pointer, modifiers, context);
        state.snapFeedback = mirrorRef.current === "none" ? result.snap : null;
        state.readoutHeadingRad = drag.pose.headingRad ?? null;
        state.readoutLabel = result.label;
        state.bubble = { xPx, yPx, lines: [poseLine(result.pose), `waypoint ${drag.name} · ${result.label ?? "no snap"}`] };
        current.onDragWaypoint?.(drag.name, { xIn: result.pose.xIn, yIn: result.pose.yIn, headingRad: drag.pose.headingRad ?? 0 });
        requestDraw();
        return;
      }

      if (drag.kind === "startHeading") {
        // The bearing from the start to the pointer, both in the file's own frame (`toWorld` took
        // the mirror off), snapped exactly as a step's heading arrow is: 15° steps, 45° with Shift,
        // free with Alt, and Ctrl flips the snap toggle.
        const result = headingDrag(drag.pose, pointerIn, modifiers, snapContext(() => null));
        state.readoutHeadingRad = result.headingRad;
        state.readoutLabel = result.label;
        state.snapFeedback = null;
        state.bubble = {
          xPx,
          yPx,
          lines: [`h ${fmt((result.headingRad * 180) / Math.PI, 1)}°`, `start heading · ${result.label ?? "no snap"}`],
        };
        current.onTurnStartPose?.(result.headingRad);
        requestDraw();
        return;
      }

      if (drag.kind === "headingHandle") {
        const { handle } = drag;
        if (handle.role === "point") {
          // A facing point moves like any point: the same snap rules, the same Shift axis.
          const result = resolveLeader(handle.poseIn, pointerIn, modifiers, snapContext(() => null));
          state.snapFeedback = result.snap;
          state.readoutHeadingRad = null;
          state.readoutLabel = result.label;
          state.bubble = {
            xPx,
            yPx,
            lines: [`x ${fmt(result.pose.xIn)}  y ${fmt(result.pose.yIn)} in`, `${handleLabel(handle)} · ${result.label ?? "no snap"}`],
          };
          current.onSetHeading?.(drag.stepId, moveFacingPoint(drag.heading, handle, result.pose));
        } else {
          const result = headingDrag(handle.poseIn, pointerIn, modifiers, snapContext(() => null));
          const valueRad = continueAngle(drag.lastRad, result.headingRad);
          drag.lastRad = valueRad;
          state.readoutHeadingRad = result.headingRad;
          state.readoutLabel = result.label;
          state.snapFeedback = null;
          state.bubble = {
            xPx,
            yPx,
            lines: [`h ${fmt((valueRad * 180) / Math.PI, 1)}°`, `${handleLabel(handle)} · ${result.label ?? "no snap"}`],
          };
          current.onSetHeading?.(drag.stepId, turnHandle(drag.heading, handle, valueRad));
        }
        requestDraw();
        return;
      }

      if (drag.kind === "rangeBoundary") {
        const polyline = hitScene().polylines.find((entry) => entry.stepId === drag.stepId);
        const projection = polyline === undefined ? null : projectOntoPolyline(polyline, xPx, yPx);
        if (projection !== null) {
          const next = dragBoundary(drag.heading, drag.index, projection.t);
          const at = next.mode === "piecewise" ? next.ranges[drag.index]?.endT : undefined;
          state.bubble = { xPx, yPx, lines: [`t ${(at ?? projection.t).toFixed(2)} · boundary`, drag.stepId] };
          current.onSetHeading?.(drag.stepId, next);
        }
        requestDraw();
        return;
      }

      if (drag.kind === "envelopeRect" || drag.kind === "envelopeDraw") {
        // A corner or a side snaps like a control point: waypoints and the grid, never the wall rule.
        const context = snapContext(() => null);
        const result =
          drag.kind === "envelopeRect"
            ? dragEnvelopeRect(drag.startRect, drag.grab, drag.pressIn, pointerIn, modifiers, context)
            : drawEnvelopeRect(drag.fromIn, pointerIn, modifiers, context);
        state.snapFeedback = result.snap;
        state.readoutHeadingRad = null;
        state.readoutLabel = result.label;
        const grab = drag.kind === "envelopeRect" ? drag.grab : "draw";
        state.bubble = { xPx, yPx, lines: envelopeRectLines(drag.stepId, result.rect, grab, { label: result.label }) };
        const polygon = rectPolygon(result.rect);
        if (drag.kind === "envelopeRect") current.onSetEnvelopePolygon?.(drag.stepId, polygon);
        else current.onDrawEnvelope?.(drag.stepId, polygon);
        requestDraw();
        return;
      }

      if (drag.kind === "marker") {
        const polyline = hitScene().polylines.find((entry) => entry.stepId === drag.stepId);
        if (polyline !== undefined) {
          const projection = projectOntoPolyline(polyline, xPx, yPx);
          if (projection !== null) {
            current.onDragMarker(drag.stepId, drag.markerIndex, projection.t);
            state.bubble = { xPx, yPx, lines: [`t ${projection.t.toFixed(2)}`, drag.stepId] };
          }
        }
        requestDraw();
        return;
      }

      if (drag.kind === "marquee") {
        state.marquee = rectFrom({ xPx: press.xPx, yPx: press.yPx }, { xPx, yPx });
        state.bubble = null;
        requestDraw();
        return;
      }

      // Measure: the far end snaps to a point, or swings to 45 degree steps with Shift.
      let toIn = pointerIn;
      if (modifiers.coarseHeading) toIn = constrainAngle(drag.fromIn, pointerIn);
      else if (modifiers.snap && state.view !== null) toIn = snapMeasureEnd(pointerIn, measureCandidates(), state.view.pxPerIn).pointIn;
      state.measurement = { fromIn: drag.fromIn, toIn };
      state.bubble = null;
      requestDraw();
    },
    [emitMoves, hitScene, measureCandidates, plannedHeadingOfPoint, requestDraw, setView, snapContext, toWorld],
  );

  /**
   * Ends the press without finishing it (issue #148): Escape during a drag, a stale press, or a
   * pointer the browser cancelled or took away. Nothing the press did stays. An edit drag's changes
   * go back through `onDragCancel` (without it, `onDragEnd` closes the drag as it stands), a marquee
   * selects nothing, a measure is cleared, and the release that follows is not a click.
   */
  const cancelPress = useCallback(() => {
    const state = stateRef.current;
    const press = state.press;
    if (press === null) return;
    state.press = null;
    releaseHeld();
    state.snapFeedback = null;
    state.readoutLabel = null;
    state.bubble = null;
    state.marquee = null;
    if (press.drag?.kind === "measure") state.measurement = null;
    if (layoutToPane()) {
      markStaticDirty();
      draw();
    }
    const canvas = canvasRef.current;
    if (canvas !== null && canvas.hasPointerCapture(press.pointerId)) canvas.releasePointerCapture(press.pointerId);
    const drag = press.drag;
    if (drag !== null && isEditDrag(drag)) {
      const current = propsRef.current;
      if (current.onDragCancel !== undefined) current.onDragCancel();
      else current.onDragEnd();
    }
    requestDraw();
  }, [draw, layoutToPane, markStaticDirty, releaseHeld, requestDraw]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (canvas === null) return;
      const state = stateRef.current;
      // One press at a time (issue #148): a second finger while one is down is ignored, so it can
      // neither replace the press nor leave the press's undo transaction open. The same pointer
      // going down again means its release never arrived, so that stale press is cancelled first.
      if (state.press !== null) {
        if (state.press.pointerId !== event.pointerId) return;
        cancelPress();
      }
      // Any new press ends a menu swallow that no context menu event came to clear.
      state.swallowMenu = false;
      // Onshape's pan (issue #115): a middle drag, or a right drag with Ctrl held. A plain right press
      // is the context menu's, which has its own handler. The side buttons are the app's navigation.
      const pan = event.button === 1 || (event.button === 2 && event.ctrlKey);
      if (event.button !== 0 && !pan) return;
      if (menuRef.current !== null) setMenu(null);
      focusForInput(canvas);
      const { xPx, yPx } = localPoint(event);
      const keys = heldKeys(event);
      state.keys = keys;
      // The add-path preview is for the pointer with no press down; a drag shows its own readout.
      state.addSnap = null;
      const drag = pan ? ({ kind: "pan", lastXPx: xPx, lastYPx: yPx } as Drag) : beginDrag(xPx, yPx, keys);
      state.press = {
        xPx,
        yPx,
        moved: false,
        drag,
        hit: hitTest(hitScene(), xPx, yPx),
        shift: keys.shift,
        button: event.button,
        pointerId: event.pointerId,
      };
      if (drag?.kind === "measure") state.measurement = { fromIn: drag.fromIn, toIn: drag.fromIn };
      heldHiddenRef.current = { hidden: propsRef.current.hiddenWaypoints };
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = cursorFor(state.press.hit);
      // A point, heading, start, envelope or marker drag brackets every edit it produces in one
      // undo transaction, no matter how many pointer-move frames land in between. A click opens and
      // closes an empty one.
      if (drag !== null && isEditDrag(drag)) {
        propsRef.current.onDragStart();
      }
    },
    [beginDrag, cancelPress, cursorFor, hitScene, localPoint],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const state = stateRef.current;
      // A second finger's moves do nothing while the first one's press is down (issue #148).
      if (state.press !== null && state.press.pointerId !== event.pointerId) return;
      const { xPx, yPx } = localPoint(event);
      state.pointerIn = toWorld(xPx, yPx);
      state.pointerPx = { xPx, yPx };
      state.keys = heldKeys(event);

      const press = state.press;
      if (press === null) {
        state.readoutLabel = null;
        updateHover(xPx, yPx);
        // The frame this asks for shows where a click here would land with the add tools, snapped
        // (issue #150): `draw` works it out.
        requestDraw();
        return;
      }
      if (!press.moved && Math.hypot(xPx - press.xPx, yPx - press.yPx) > CLICK_SLOP_PX) {
        press.moved = true;
        state.hover = null;
        // Dragging a point that is not selected selects it, and its step, as the drag begins, so one
        // gesture both picks the point and moves it, and the arrow keys and R then act on the point
        // that was dragged (issue #148). Selection is not in the undo history, so the drag's
        // transaction stays the only undo step.
        const drag = press.drag;
        const current = propsRef.current;
        if (drag?.kind === "points" && !isPointSelected(current.selection, drag.leader)) {
          current.onSelect({ stepId: drag.leader.stepId, point: drag.leader.point });
        }
        if ((drag?.kind === "start" || drag?.kind === "startHeading") && current.selection.start !== true) {
          current.onSelect({ start: true });
        }
        if (drag?.kind === "waypoint" && current.selection.waypoint !== drag.name) {
          current.onSelect({ waypoint: drag.name });
        }
      }
      if (!press.moved || press.drag === null) {
        requestDraw();
        return;
      }
      applyDrag(xPx, yPx, state.keys);
    },
    [applyDrag, localPoint, requestDraw, toWorld, updateHover],
  );

  const clickAction = useCallback(
    (xPx: number, yPx: number, hit: CanvasHit | null, shift: boolean, keys: HeldKeys) => {
      const current = propsRef.current;
      // A mirrored preview takes no edit from a drawing tool (issue #412).
      if (drawingOff()) return;

      if (placingWaypoint() && current.onPlaceWaypoint !== undefined) {
        // Where the Add path preview showed its point, and the pin it snapped onto (issue #234).
        // No spot (too close to the path end, or off the Shift ray) still reaches the shell, which says why.
        const placed = addPointPose(toWorld(xPx, yPx), keys);
        current.onPlaceWaypoint(placed?.pose, placed?.waypoint);
        return;
      }
      if (current.tool === "addPath" || current.tool === "addCommand") {
        // Exactly where the preview under the pointer showed it, and the waypoint it snapped onto,
        // which the new path's end then follows (issue #150).
        const placed = addPointPose(toWorld(xPx, yPx), keys);
        if (placed === null) return;
        if (current.tool === "addPath") current.onAddPathPoint(placed.pose, placed.waypoint);
        else current.onAddCommandAt(placed.pose);
        return;
      }
      if (current.tool === "marker") {
        // A click on a marker that is already there selects it, so the inspector opens it, rather
        // than doing nothing; a click on the path itself places a new one.
        if (hit?.markerIndex !== undefined) {
          current.onSelect({ stepId: hit.stepId, markerIndex: hit.markerIndex });
          return;
        }
        // A heading arrow or a range tick sits on the path, so a click on one drops the marker at
        // the nearest point of its path (issue #412), as a right-click there opens the path's menu.
        let at = hit !== null && hit.t !== undefined ? { stepId: hit.stepId, t: hit.t } : null;
        if (at === null && hit !== null && (hit.headingHandle !== undefined || hit.rangeBoundary !== undefined)) {
          const owner = hitScene().polylines.find((polyline) => polyline.stepId === hit.stepId);
          const projection = owner === undefined ? null : projectOntoPolyline(owner, xPx, yPx);
          if (projection !== null) at = { stepId: hit.stepId, t: projection.t };
        }
        if (at !== null) {
          current.onAddMarker(at.stepId, at.t);
          // The new marker is selected; its Command field takes focus so its command is the next choice.
          focusMarkerCommand();
        }
        return;
      }
      if (current.tool === "measure") return;
      if (current.tool === "select" && keys.alt && !shift && isMarkerOrLineHit(hit)) {
        // Alt+click reaches the steps under the selected one where steps overlap (issue #149). A plain
        // repeated click does not, so the two clicks of a double-click keep the step it splits. Only a
        // press that landed on a marker or a line walks them: a dot, the start mark or a pin on a line
        // keeps the press, so an Alt+click there (Alt is also the drag modifier) does what a click does.
        const next = nextStepUnder(hitScene(), xPx, yPx, current.selection.stepId);
        if (next !== null) {
          current.onSelect(next.markerIndex === undefined ? { stepId: next.stepId } : { stepId: next.stepId, markerIndex: next.markerIndex });
          return;
        }
      }
      if (hit === null) {
        current.onSelect({});
        return;
      }
      if (hit.start === true || hit.startKnob === true) {
        // Selected, the start is what the arrow keys nudge and the rotate key turns.
        current.onSelect({ start: true });
        return;
      }
      if (hit.waypoint !== undefined) {
        // So is a selected pin, which the inspector then shows (issue #134).
        current.onSelect({ waypoint: hit.waypoint });
        return;
      }
      if (hit.point !== undefined && !stepsWithHandles(current.selection).has(hit.stepId)) {
        // A click on a dot of a step that is not selected selects the step, as a click on its path does.
        current.onSelect({ stepId: hit.stepId });
        return;
      }
      if (hit.point !== undefined) {
        const point = { stepId: hit.stepId, point: hit.point };
        current.onSelect(shift ? togglePoint(current.selection, point) : { stepId: hit.stepId, point: hit.point });
        return;
      }
      current.onSelect({ stepId: hit.stepId, markerIndex: hit.markerIndex });
    },
    [addPointPose, drawingOff, hitScene, placingWaypoint, toWorld],
  );

  const finishPress = useCallback(
    (xPx: number, yPx: number) => {
      const state = stateRef.current;
      const press = state.press;
      state.press = null;
      releaseHeld();
      state.snapFeedback = null;
      state.readoutLabel = null;
      state.bubble = null;
      // The marquee is in the screen pixels of the view it was drawn in, so what it holds is picked
      // in that view, before a resize held back during the press moves the field (issue #402).
      const drag = press?.drag ?? null;
      const marqueed =
        press !== null && drag?.kind === "marquee" && press.moved && state.marquee !== null && state.view !== null
          ? marqueeSelection(drag.base, projectMarqueeCandidates(sceneRef.current, state.view, mirrorRef.current, drag.base), state.marquee, drag.additive)
          : null;
      // A pane resize that arrived during the press was held back; lay the view out for it now, and
      // draw at once so the view the element publishes is never a frame behind the one in use.
      if (layoutToPane()) {
        markStaticDirty();
        draw();
      }
      if (press === null) return;
      if (drag !== null && isEditDrag(drag)) {
        propsRef.current.onDragEnd();
      }
      if (marqueed !== null) propsRef.current.onSelect(marqueed);
      state.marquee = null;
      if (drag?.kind === "measure" && !press.moved) state.measurement = null;
      // A pan is never a click, a click while an envelope is being drawn does nothing else either
      // (`releaseIsClick`), and a Ctrl + right drag that moved opens no menu as it ends.
      if (releaseIsClick(press, drag?.kind)) clickAction(xPx, yPx, press.hit, press.shift, state.keys);
      if (press.moved && press.button === 2) state.swallowMenu = true;
      updateHover(xPx, yPx);
      // With the press gone, the next frame shows the add tools' preview again (`draw`).
      requestDraw();
    },
    [clickAction, draw, layoutToPane, markStaticDirty, releaseHeld, requestDraw, updateHover],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const state = stateRef.current;
      // A second finger going up leaves the first one's press alone (issue #148).
      if (state.press !== null && state.press.pointerId !== event.pointerId) return;
      const { xPx, yPx } = localPoint(event);
      state.keys = heldKeys(event);
      // The press finishes before the capture is let go, so the lost capture that follows finds no
      // press to cancel.
      finishPress(xPx, yPx);
      const canvas = canvasRef.current;
      if (canvas !== null && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    },
    [finishPress, localPoint],
  );

  /**
   * The browser cancelled the press's pointer, or the canvas lost its capture of it (issue #148):
   * the press is cancelled, never finished as a release, so it runs no click and keeps no edit.
   */
  const onPointerAbort = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const press = stateRef.current.press;
      if (press === null || press.pointerId !== event.pointerId) return;
      cancelPress();
    },
    [cancelPress],
  );

  /** The node the keyboard's `S`/`C` and the menu's smooth/corner items act on. */
  const targetNode = useCallback((stepId: string | undefined, point: PointTarget | undefined): BezierNode | null => {
    if (stepId === undefined || point === undefined) return null;
    const step = sceneRef.current.steps.find((candidate) => candidate.stepId === stepId);
    if (step === undefined) return null;
    return nodesForTarget(step.nodes, point).find((node) => node.incoming !== undefined && node.outgoing !== undefined) ?? null;
  }, []);

  const setNodeKind = useCallback(
    (stepId: string, node: BezierNode, kind: NodeKind) => {
      const state = stateRef.current;
      state.nodeKinds.set(nodeKey(stepId, node.index), kind);
      if (kind === "smooth") {
        const step = sceneRef.current.steps.find((candidate) => candidate.stepId === stepId);
        if (step !== undefined) {
          const moves = smoothNodeMoves(stepId, step.polygons, node.index);
          if (moves.length > 0) {
            propsRef.current.onDragStart();
            emitMoves(moves);
            propsRef.current.onDragEnd();
          }
        }
      }
      requestDraw();
    },
    [emitMoves, requestDraw],
  );

  const splitAt = useCallback((stepId: string, t: number) => {
    const current = propsRef.current;
    if (current.onSplitAt === undefined) return;
    const planStep = flatStepsRef.current.find((step) => step.id === stepId);
    const geometry = planStep?.geometry;
    if (geometry === undefined) return;
    current.onSplitAt(stepId, t, splitLocation(geometry, t));
  }, []);

  const onDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      const current = propsRef.current;
      if (current.tool !== "select") return;
      const { xPx, yPx } = localPoint(event);
      const hit = hitTest(hitScene(), xPx, yPx);
      if (hit === null) {
        fit();
        return;
      }
      // A pin asks to be renamed, and stays where it is: the two clicks only selected it (issue #233).
      if (hit.waypoint !== undefined) {
        current.onRenameWaypoint?.(hit.waypoint);
        return;
      }
      // Two quick Alt+clicks walk the steps under the pointer twice (issue #149); they split nothing.
      if (event.altKey) return;
      if (hit.t !== undefined && hit.point === undefined && hit.markerIndex === undefined) splitAt(hit.stepId, hit.t);
    },
    [fit, hitScene, localPoint, splitAt],
  );

  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      const state = stateRef.current;
      if (state.press !== null) return;
      const current = propsRef.current;
      const { xPx, yPx } = localPoint(event);
      let hit = hitTest(hitScene(), xPx, yPx);
      // A heading handle has no menu of its own, so the right-click goes to the path that owns it, at
      // the point of the path nearest the pointer (issue #320).
      if (hit?.headingHandle !== undefined) {
        const owner = hitScene().polylines.find((polyline) => polyline.stepId === hit?.stepId);
        const projection = owner === undefined ? null : projectOntoPolyline(owner, xPx, yPx);
        if (projection !== null) hit = { stepId: hit.stepId, t: projection.t };
      }
      const atIn = toWorld(xPx, yPx);
      let target: CanvasMenuTarget;
      if (hit?.waypoint !== undefined) {
        // A pin has its own menu, and the right-click selects it first, as it does a point (issue #233).
        target = { kind: "waypoint", waypoint: hit.waypoint, atIn };
        if (current.selection.waypoint !== hit.waypoint) current.onSelect({ waypoint: hit.waypoint });
      } else if (hit?.point !== undefined) {
        target = { kind: "point", stepId: hit.stepId, point: hit.point, atIn };
        // Right-click acts on what it lands on: select it first, unless it is already in the set.
        if (!isPointSelected(current.selection, { stepId: hit.stepId, point: hit.point })) {
          current.onSelect({ stepId: hit.stepId, point: hit.point });
        }
      } else if (hit?.markerIndex !== undefined) {
        target = { kind: "marker", stepId: hit.stepId, markerIndex: hit.markerIndex, atIn };
        current.onSelect({ stepId: hit.stepId, markerIndex: hit.markerIndex });
      } else if (hit !== null && hit.t !== undefined) {
        target = { kind: "path", stepId: hit.stepId, t: hit.t, atIn };
        if (current.selection.stepId !== hit.stepId) current.onSelect({ stepId: hit.stepId });
      } else {
        // The start mark keeps the field's items and adds its own about the waypoint it follows. It
        // is not selected by the right-click, so the step "Add a path to here" continues from stays.
        target = { kind: hit?.start === true || hit?.startKnob === true ? "start" : "field", atIn };
        // Where an Add path click here would put its point (issue #150), continuing from the step
        // "Add a path to here" inserts after, the selected one, so the two write the same end. The
        // menu event's position is whole pixels where the pointer's own can be a fraction of one,
        // so on the pointer's pixel the pointer's own position is used, as a click there would,
        // under the view as it is now, as the preview is.
        const pointer = state.pointerPx;
        const onPointer = pointer !== null && Math.hypot(pointer.xPx - xPx, pointer.yPx - yPx) < 1;
        const placed = addPointPose(onPointer ? toWorld(pointer.xPx, pointer.yPx) : atIn, heldKeys(event), "path", current.selection.stepId ?? null);
        if (placed !== null) {
          const { xIn, yIn, headingRad } = placed.pose;
          target.snappedIn = placed.waypoint === undefined ? { xIn, yIn, headingRad } : { xIn, yIn, headingRad, waypoint: placed.waypoint };
        }
      }

      // A dot or the start mark can cover pins no point follows, so the menu names those too (issue #233).
      if (target.kind === "start" || (target.kind === "point" && target.point?.pointKind !== "control")) {
        const near = pinsNear(hitScene(), xPx, yPx);
        if (near.length > 0) target.nearWaypoints = near;
      }

      const shellItems = current.canvasActions?.(target) ?? [];
      const own: CanvasAction[] = [];
      if (target.kind === "point") {
        const node = targetNode(target.stepId, target.point);
        if (node !== null && target.stepId !== undefined) {
          const stepId = target.stepId;
          const kind = effectiveNodeKind(state.nodeKinds, stepId, node);
          // Only the one that changes the point (issue #412): Make corner on a smooth point, and back.
          const to: NodeKind = kind === "smooth" ? "corner" : "smooth";
          const tip = to === "smooth" ? CANVAS_TOOLTIPS.smooth : CANVAS_TOOLTIPS.corner;
          own.push({
            id: `canvas.node.${to}`,
            label: tip.label,
            icon: to === "smooth" ? Spline : CornerDownRight,
            shortcut: tip.shortcut,
            enabled: true,
            run: () => {
              setNodeKind(stepId, node, to);
            },
          });
        }
      }
      if (target.kind === "path" && target.stepId !== undefined && target.t !== undefined && current.onSplitAt !== undefined) {
        const { stepId, t } = target;
        own.push({
          id: "canvas.split",
          label: "Split path here",
          icon: Scissors,
          // No "Double-click" in the shortcut column (issue #412): it means three things on the field.
          enabled: current.tool === "select" || current.tool === "addPath",
          run: () => {
            splitAt(stepId, t);
          },
        });
      }
      const headingStep =
        target.kind === "path" && target.stepId !== undefined ? sceneRef.current.steps.find((candidate) => candidate.stepId === target.stepId) : undefined;
      // With Advanced heading off, only a path that is piecewise already is split (spec 15 section 4.1).
      const splitsHeading = current.newPiecewise !== false || headingStep?.heading?.mode === "piecewise";
      if (target.kind === "path" && target.stepId !== undefined && target.t !== undefined && current.onSetHeading !== undefined && splitsHeading) {
        const { stepId, t } = target;
        const step = headingStep;
        const split = splitHeadingAt(step?.heading, t, step?.polygons);
        own.push({
          id: "canvas.splitHeading",
          label: "Split heading here",
          icon: Split,
          enabled: split !== null && step?.kind === "path",
          disabledReason: "Too close to a range end: a heading range must be at least 2% of the path.",
          run: () => {
            if (split !== null) propsRef.current.onSetHeading?.(stepId, split);
          },
        });
      }
      // No zoom rows (issue #412): F, a double-click and the field's corner controls zoom.
      if (shellItems.length > 0 && own[0] !== undefined) own[0] = { ...own[0], separatorBefore: true };
      state.hover = null;
      state.bubble = null;
      if (shellItems.length + own.length === 0) {
        requestDraw();
        return;
      }
      // Placed in the window, where the pointer is (issue #412), not inside the canvas host.
      setMenu({ xPx: event.clientX, yPx: event.clientY, items: [...shellItems, ...own] });
      requestDraw();
    },
    [addPointPose, hitScene, localPoint, requestDraw, setNodeKind, splitAt, targetNode, toWorld],
  );

  const onPointerLeave = useCallback(() => {
    const state = stateRef.current;
    if (state.press !== null) return;
    state.pointerIn = null;
    state.pointerPx = null;
    state.readoutHeadingRad = null;
    state.bubble = null;
    // Off the field, there is nowhere for an add-path click to land (issue #150).
    state.addSnap = null;
    state.snapFeedback = null;
    state.readoutLabel = null;
    if (state.hover !== null) {
      state.hover = null;
      propsRef.current.onHover(null);
    }
    requestDraw();
  }, [requestDraw]);

  // ---- keyboard --------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const state = stateRef.current;

    // Keys the canvas owns while it has focus. Each one it handles stops there, so the shell's
    // window-level map (where S is snap and C is the command tool) does not also act on it.
    const onCanvasKey = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const current = propsRef.current;
      const key = event.key.toLowerCase();
      const consume = (): void => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.key === "Escape") {
        // Escape during a marquee, a measure or an edit drag (a point, a heading arrow, a range tick,
        // the start, a pin, a marker, an envelope) cancels it, and only that: the key stops here, so
        // the shell's Escape does not also clear the selection (issues #148, #402).
        const drag = state.press?.drag ?? null;
        if (drag !== null && escapeCancelsDrag(drag.kind, isEditDrag(drag))) {
          cancelPress();
          consume();
          return;
        }
        if (state.measurement !== null) {
          state.measurement = null;
          requestDraw();
          consume();
          return;
        }
        // With a tool other than Select on, Esc leaves the tool for Select and keeps the selection,
        // which the shell's own Escape does (issue #412): the selected step is Add path's anchor.
        if (current.tool !== "select") return;
        current.onSelect({});
        return;
      }
      if (key === "f") {
        zoomToSelection();
        consume();
        return;
      }
      if (key === "s" || key === "c") {
        const node = targetNode(current.selection.stepId, current.selection.point);
        if (node === null || current.selection.stepId === undefined) return;
        setNodeKind(current.selection.stepId, node, key === "s" ? "smooth" : "corner");
        consume();
      }
    };
    canvas.addEventListener("keydown", onCanvasKey);

    // Held modifiers change what a drag does the moment they change, not on the next pointer move.
    const onModifier = (event: KeyboardEvent): void => {
      if (event.code === "Space") {
        state.spaceHeld = spaceHeldAfter(state.spaceHeld, event);
        if (event.type === "keydown" && document.activeElement === canvas) event.preventDefault();
        return;
      }
      if (event.key !== "Control" && event.key !== "Alt" && event.key !== "Shift" && event.key !== "Meta") return;
      state.keys = heldKeys(event);
      if (state.press !== null) {
        // Alt would otherwise focus the browser menu mid-drag.
        if (event.key === "Alt") event.preventDefault();
        const at = state.pointerPx;
        if (at !== null) applyDrag(at.xPx, at.yPx, state.keys);
      } else if (state.addSnap !== null || propsRef.current.tool === "addPath" || propsRef.current.tool === "addCommand") {
        // So does the add tools' preview, which `draw` works out again: Ctrl lets the point go where
        // the pointer is (issue #150).
        requestDraw();
      }
    };
    // Escape keeps the add tools' preview, since the tool and the pointer stay: the selection it
    // clears moves the insert anchor, and the frame that follows shows the point from the new one.
    window.addEventListener("keydown", onModifier);
    window.addEventListener("keyup", onModifier);
    // A Space let go in another window never reaches this one, so leaving the window lets it go
    // (issue #402); otherwise every press would pan, under a grab cursor, until Space came back.
    const onBlur = (event: FocusEvent): void => {
      if (!state.spaceHeld) return;
      state.spaceHeld = spaceHeldAfter(state.spaceHeld, event);
      if (state.press === null) canvas.style.cursor = cursorFor(state.hover);
    };
    window.addEventListener("blur", onBlur);
    return () => {
      canvas.removeEventListener("keydown", onCanvasKey);
      window.removeEventListener("keydown", onModifier);
      window.removeEventListener("keyup", onModifier);
      window.removeEventListener("blur", onBlur);
    };
  }, [applyDrag, cancelPress, cursorFor, requestDraw, setNodeKind, targetNode, zoomToSelection]);

  // The Inspector's ⋯ menu on a waypoint row ends with these same zooms (issue #245).
  useEffect(() => {
    const onZoom = (event: Event): void => {
      const to = (event as CustomEvent<CanvasZoom>).detail;
      if (to === "selection") zoomToSelection();
      else if (to === "fit") fit();
    };
    window.addEventListener(CANVAS_ZOOM_EVENT, onZoom);
    return () => {
      window.removeEventListener(CANVAS_ZOOM_EVENT, onZoom);
    };
  }, [fit, zoomToSelection]);

  const closeMenu = useCallback(() => {
    setMenu(null);
    focusForInput(canvasRef.current);
  }, []);

  /** The corner's + and −: zoom about the middle of the well (issue #412). */
  const zoomBy = useCallback(
    (factor: number) => {
      const state = stateRef.current;
      if (state.view === null || state.widthPx === 0) return;
      state.userAdjusted = true;
      setView(zoomAbout(state.view, { xPx: state.widthPx / 2, yPx: state.heightPx / 2 }, factor));
    },
    [setView],
  );

  // The one line at the top of the well (issue #412): what the tool does and how to leave it, and,
  // while the view shows the other alliance, which auto an edit goes to. A drawing tool is off then,
  // so it has no hint of its own.
  const hint = mirrored && DRAWING_TOOLS.has(props.tool) ? null : toolHintLine(
        props.tool,
        props.tool === "addPath" ? (props.insertAnchorStepId ?? null) : null,
        props.placeWaypointArmed === true && props.onPlaceWaypoint !== undefined,
      );
  const banner = mirrored ? mirrorBannerLine(props.auto.alliance) : null;
  const zoomTips = [
    { id: "fit", tip: CANVAS_TOOLTIPS.zoomFit, icon: Maximize, run: fit },
    { id: "in", tip: CANVAS_TOOLTIPS.zoomIn, icon: Plus, run: () => zoomBy(ZOOM_STEP) },
    { id: "out", tip: CANVAS_TOOLTIPS.zoomOut, icon: Minus, run: () => zoomBy(1 / ZOOM_STEP) },
  ] as const;
  return (
    <div ref={hostRef} style={HOST_STYLE}>
      <canvas
        ref={canvasRef}
        role="img"
        tabIndex={0}
        data-testid="field-canvas"
        aria-label={summarise(props, scene)}
        style={CANVAS_STYLE}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerAbort}
        onLostPointerCapture={onPointerAbort}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      {/* The field has no Play of its own since issue #412: the toolbar's and the scrubber's play. */}
      {hint === null && banner === null ? null : (
        <div className={styles["topLines"]}>
          {banner === null ? null : (
            <div className={styles["topLine"]} data-kind="mirror" role="status" data-testid="canvas-mirror-banner">
              {banner}
            </div>
          )}
          {hint === null ? null : (
            <div className={styles["topLine"]} data-kind="tool" role="status" data-testid="canvas-tool-hint">
              {hint}
            </div>
          )}
        </div>
      )}
      <div className={styles["zoom"]} role="group" aria-label="Zoom" data-testid="canvas-zoom">
        {zoomTips.map((entry) => (
          <Tooltip key={entry.id} label={entry.tip.label} hint={entry.tip.detail} side="top">
            <button
              type="button"
              className={styles["zoomButton"]}
              aria-label={entry.tip.label}
              data-testid={`canvas-zoom-${entry.id}`}
              onClick={() => {
                entry.run();
              }}
            >
              <entry.icon size={16} strokeWidth={1.75} aria-hidden />
            </button>
          </Tooltip>
        ))}
        <span className={styles["zoomPct"]} data-testid="canvas-zoom-pct" aria-label="Zoom level">
          {zoomPct === null ? "" : `${String(zoomPct)}%`}
        </span>
      </div>
      {menu === null ? null : <ContextMenu xPx={menu.xPx} yPx={menu.yPx} items={menu.items} onClose={closeMenu} />}
    </div>
  );
}

export default FieldCanvas;
