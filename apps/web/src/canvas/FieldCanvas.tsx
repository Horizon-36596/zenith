/**
 * The field canvas of the Zenith editor (site/docs/editor.md).
 *
 * One `<canvas>` element carrying two layers. The static layer is the field (the picture, its
 * outlines, or the vector field), painted into an offscreen canvas and only repainted when the
 * document, the size, the theme or the field image changes, or once a pan or zoom settles; while
 * the view is moving, the frame blits the cached layer under the new transform instead, which is
 * what keeps pan and zoom at 60 fps. The live layer owns paths, handles, markers, the robot outline,
 * the readouts, the marquee and the measure overlay.
 *
 * Interaction, in one place (the table the tour and the help overlay read is `help.ts`):
 * - Click selects, Shift-click adds a point to the selection, a drag on empty field draws a marquee,
 *   dragging a selected point moves the whole selection, `Esc` clears.
 * - While dragging, Ctrl inverts snap, Alt turns off the quantising snaps, Shift constrains
 *   (`modifiers.ts`). The drag bubble next to the cursor says what is acting.
 * - Heading arrows turn the step's heading mode (spec 11 section 3, `headingHandles.ts`): a
 *   Constant's two arrows turn together, a Linear's start and end turn apart, Tangent arrows only
 *   show the way, a facing point drags. Ticks between piecewise ranges drag along the path.
 *   `onSetHeading` carries each frame's heading mode.
 * - Bezier nodes are smooth or corner (`bezier.ts`), toggled with `S`/`C` or the context menu.
 * - Right-click opens the context menu built from `canvasActions` plus the canvas's own items.
 * - Double-click a path to split it there; double-click empty field to fit; `F` zooms to the
 *   selection; the `measure` tool drags a dimension.
 *
 * Coordinates: world inches in, world inches out. Screen pixels exist only between `view.ts` and
 * the painters. A BLUE alliance draws the routine mirrored by the field's own `frame.mirror` kind
 * but still reports canonical RED poses to the shell, because the pointer is un-mirrored on the way
 * out (every mirror kind is its own inverse, finding 21/22).
 */
import {
  fieldBounds,
  flattenSteps,
  idealPoseAt,
  idealTimeAt,
  idealTrajectory,
  mirrorForField,
  mirrorVec,
  resimulate,
  robotHeightIn,
  shouldMirror,
  simPoseAt,
  simulateRun,
  type Box2,
  type MirrorMode,
  type PlanStep,
  type Pose,
  type SimRun,
  type Vec2,
} from "@horizon36596/zenith-core";
import { Pause, Play } from "lucide-react";
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
import { ContextMenu } from "./ContextMenu.js";
import { chooseImageSource, creditLine, readFieldImage, resolveImageUrl, type FieldImageSpec } from "./fieldImage.js";
import { draggedFootprintBounds, footprintBoundsIn } from "./footprintBounds.js";
import { CANVAS_TOOLTIPS } from "./help.js";
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
import { hitTest, nearest, projectOntoPolyline, type HitScene } from "./hit.js";
import {
  drawLive,
  projectHeadingHandles,
  projectHitScene,
  projectMarqueeCandidates,
  type Bubble,
  type ReadoutState,
} from "./liveLayer.js";
import { constrainAngle, snapMeasureEnd, type Measurement } from "./measure.js";
import { heldKeys, NO_KEYS, resolveModifiers, type HeldKeys } from "./modifiers.js";
import { headingDrag, planPointDrag, resolveLeader, smoothNodeMoves, type StartPoint } from "./pointDrag.js";
import {
  buildScene,
  poseAtT,
  poseAtTime,
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
import { snapPose, type SnapContext, type SnapResult, type SnapWaypoint } from "./snap.js";
import { drawFieldImage, drawPerimeter, drawStatic, drawStaticImage, type StaticLayerInput } from "./staticLayer.js";
import { fallbackTheme, liveInk, observeTheme, readTheme, type CanvasTheme } from "./theme.js";
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
  TraceOverlay,
} from "./types.js";
import {
  expandBounds,
  fitView,
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

/** Padding, in CSS pixels, between the fitted area and the edge of the element. */
const FIT_PADDING_PX = 16;
/**
 * How far past the field perimeter a fit keeps visible, in inches. A start pose against the wall
 * puts half a robot outside the 144 in square, and the robot outline must not be cropped.
 */
const FIT_MARGIN_IN = 10;
/** Zoom to selection frames the points with this much room around them, and no tighter than this. */
const SELECTION_MARGIN_IN = 12;
const SELECTION_MIN_SPAN_IN = 30;

const withMargin = (bounds: Box2): Box2 => expandBounds(bounds, FIT_MARGIN_IN);
/** A press that never travels this far is a click, not a drag. */
const CLICK_SLOP_PX = 3;
/** An addPath click this close to the pose it would continue from adds nothing (a double-click). */
const ADD_POINT_MIN_IN = 0.75;
/**
 * Where the app's public assets are served, for `app:` image sources: Vite's `BASE_URL`, which is
 * `/` in the desktop app and `/zenith/app/` on the public site.
 */
const APP_BASE_URL = import.meta.env.BASE_URL;
/** How long after the last pan or zoom frame the static layer is repainted sharp. */
const STATIC_SETTLE_MS = 110;

/** The playback level's name under the robot outline, and in running text in the hover readout. */
const LEVEL_LABEL: Readonly<Record<PlaybackLevel, string>> = {
  ideal: "Ideal",
  instant: "Instant sim",
  full: "Full sim",
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
  | { kind: "marker"; stepId: string; markerIndex: number }
  | { kind: "marquee"; base: Selection; additive: boolean }
  | { kind: "measure"; fromIn: Vec2 };

interface Press {
  xPx: number;
  yPx: number;
  moved: boolean;
  drag: Drag | null;
  hit: CanvasHit | null;
  shift: boolean;
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
  widthPx: number;
  heightPx: number;
  dpr: number;
  theme: CanvasTheme;
  staticCanvas: HTMLCanvasElement | null;
  staticImage: HTMLImageElement | null;
  fieldImage: LoadedImage | null;
  staticDirty: boolean;
  /** The view the cached static layer was painted at; a different view blits it transformed. */
  staticView: View | null;
  staticTimer: number | null;
  hitScene: HitScene | null;
  hover: CanvasHit | null;
  press: Press | null;
  spaceHeld: boolean;
  keys: HeldKeys;
  pointerIn: Vec2 | null;
  pointerPx: ScreenVec | null;
  snapFeedback: SnapResult | null;
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
    `${String(props.auto.steps.length)} steps, ${String(paths)} of them paths,`,
    `${travelIn.toFixed(0)} inches of travel.`,
    `${String(errors)} errors and ${String(warnings)} warnings.`,
  ].join(" ");
}

const fmt = (value: number, places = 2): string => value.toFixed(places).replace("-", "−");
const poseLine = (pose: Pose): string =>
  `x ${fmt(pose.xIn)}  y ${fmt(pose.yIn)} in  h ${fmt((pose.headingRad * 180) / Math.PI, 1)}°`;

export function FieldCanvas(props: FieldCanvasProps): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;

  const stateRef = useRef<CanvasState>({
    view: null,
    userAdjusted: false,
    laidOutAt: null,
    widthPx: 0,
    heightPx: 0,
    dpr: 1,
    theme: fallbackTheme(),
    staticCanvas: null,
    staticImage: null,
    fieldImage: null,
    staticDirty: true,
    staticView: null,
    staticTimer: null,
    hitScene: null,
    hover: null,
    press: null,
    spaceHeld: false,
    keys: NO_KEYS,
    pointerIn: null,
    pointerPx: null,
    snapFeedback: null,
    readoutHeadingRad: null,
    readoutLabel: null,
    bubble: null,
    marquee: null,
    measurement: null,
    nodeKinds: new Map(),
  });

  const scene = useMemo(
    () => buildScene({ plan: props.plan, findings: props.findings, estimate: props.estimate }),
    [props.plan, props.findings, props.estimate],
  );
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

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

  const bounds = useMemo<Box2>(() => fieldBounds(props.field), [props.field]);
  const orientation = useMemo(
    () => orientationFor((props.field.frame.view?.audienceAt ?? "bottom") as AudienceAt),
    [props.field],
  );
  const waypointList = useMemo<SnapWaypoint[]>(
    () =>
      Object.entries(props.waypoints?.waypoints ?? {}).map(([name, waypoint]) => ({
        name,
        xIn: waypoint.xIn,
        yIn: waypoint.yIn,
      })),
    [props.waypoints],
  );
  const waypointsRef = useRef(waypointList);
  waypointsRef.current = waypointList;

  // Findings 21/22: mirrored iff the alliance being viewed differs from the field's canonical one,
  // by the field's own `frame.mirror` kind; "none" makes `mirrorVec` an identity.
  const mirrored = shouldMirror(props.auto, props.field, props.alliance);
  const mirrorMode: MirrorMode = mirrored ? mirrorForField(props.field) : "none";
  const mirrorRef = useRef(mirrorMode);
  mirrorRef.current = mirrorMode;

  const fieldView: FieldView = props.fieldView ?? "image+outlines";

  // ---- drawing ---------------------------------------------------------------------------

  const staticInput = useCallback((mode?: "vector" | "outlines"): StaticLayerInput | null => {
    const state = stateRef.current;
    if (state.view === null) return null;
    return {
      field: propsRef.current.field,
      waypoints: propsRef.current.waypoints ?? null,
      robotHeightIn: robotHeightIn(propsRef.current.robot),
      view: state.view,
      theme: state.theme,
      widthPx: state.widthPx,
      heightPx: state.heightPx,
      ...(mode === undefined ? {} : { mode }),
    };
  }, []);

  /** What the static layer shows: the picture only when it loaded, else the vector field. */
  const effectiveView = useCallback((): FieldView => {
    const state = stateRef.current;
    return state.fieldImage === null ? "vector" : (propsRef.current.fieldView ?? "image+outlines");
  }, []);

  /**
   * The pose a new path point continues from: the end of the step the shell is inserting after
   * (site/docs/editor.md, "The insert menu"), else the routine's last end pose.
   */
  const anchorEndPose = useCallback((): Pose => {
    const current = propsRef.current;
    const anchorId = current.insertAnchorStepId;
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

  const rubberBand = useCallback((): { fromIn: Pose; toIn: Vec2 } | null => {
    const state = stateRef.current;
    if (propsRef.current.tool !== "addPath" || state.pointerIn === null || state.press !== null) return null;
    return { fromIn: anchorEndPose(), toIn: state.pointerIn };
  }, [anchorEndPose]);

  /**
   * The one robot outline: under the cursor on a path, else at the playback time (0 at rest), from
   * the playback level the shell chose, and labelled with it.
   */
  const robotPose = useCallback((): {
    poseIn: Pose;
    emphasis: "playback" | "hover";
    label: string;
  } | null => {
    const state = stateRef.current;
    const current = propsRef.current;
    const level: PlaybackLevel = current.playbackLevel ?? "ideal";
    const label = LEVEL_LABEL[level];
    const recorded = current.trace !== null && current.trace !== undefined && current.trace.poses.length > 0 ? current.trace : null;
    const hover = state.hover;
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
    return pose === null ? null : { poseIn: pose, emphasis: "playback", label };
  }, []);

  const paintStatic = useCallback(() => {
    const state = stateRef.current;
    const staticCanvas = state.staticCanvas;
    if (staticCanvas === null || state.view === null) return;
    const ctx = staticCanvas.getContext("2d");
    if (ctx === null) return;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    const mode = effectiveView();
    const loaded = state.fieldImage;
    if (mode !== "vector" && loaded !== null) {
      const input = staticInput(mode === "image+outlines" ? "outlines" : undefined);
      if (input === null) return;
      drawFieldImage(ctx, loaded.image, loaded.spec, input);
      if (mode === "image+outlines") drawStatic(ctx, input);
      else drawPerimeter(ctx, input);
    } else {
      const input = staticInput();
      if (input === null) return;
      if (state.staticImage !== null) drawStaticImage(ctx, state.staticImage, input);
      else drawStatic(ctx, input);
    }
    state.staticDirty = false;
    state.staticView = state.view;
  }, [effectiveView, staticInput]);

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
    canvas.dataset["fieldView"] = effectiveView();

    if (state.staticDirty || state.staticView === null) paintStatic();

    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.clearRect(0, 0, state.widthPx, state.heightPx);
    const cached = state.staticView;
    if (state.staticCanvas !== null && cached !== null) {
      if (cached === state.view) {
        ctx.drawImage(state.staticCanvas, 0, 0, state.widthPx, state.heightPx);
      } else {
        // Mid pan or zoom: the cached field under the new transform, sharpened once it settles.
        const scale = state.view.pxPerIn / cached.pxPerIn;
        const dx = state.view.originXPx - scale * cached.originXPx;
        const dy = state.view.originYPx - scale * cached.originYPx;
        ctx.fillStyle = state.theme.bgCanvas;
        ctx.fillRect(0, 0, state.widthPx, state.heightPx);
        ctx.drawImage(state.staticCanvas, dx, dy, state.widthPx * scale, state.heightPx * scale);
      }
    }

    const current = propsRef.current;
    const readout: ReadoutState = {
      pointIn: state.pointerIn,
      headingRad: state.readoutHeadingRad,
      snapLabel: state.readoutLabel,
    };
    const trace = current.trace ?? null;
    const level: PlaybackLevel = current.playbackLevel ?? "ideal";
    const robot = robotPose();
    // Published for tests and bug reports: which level the robot is from, and exactly where it is.
    canvas.dataset["playbackLevel"] = level;
    if (robot === null) delete canvas.dataset["robotPose"];
    else canvas.dataset["robotPose"] = `${String(robot.poseIn.xIn)},${String(robot.poseIn.yIn)},${String(robot.poseIn.headingRad)}`;
    const trajectory = idealRef.current;
    const loaded = state.fieldImage;
    // The printable light picture needs dark ink (theme.ts LIGHT_FIELD_INK), only while it shows.
    const lightField = loaded !== null && effectiveView() !== "vector" && current.fieldImageVariant === "light";
    drawLive(ctx, {
      scene: sceneRef.current,
      baseScene: baseSceneRef.current,
      view: state.view,
      theme: liveInk(state.theme, lightField),
      robot: current.robot,
      bounds: fieldBounds(current.field),
      mirror: mirrorRef.current,
      selection: current.selection,
      hover: state.hover,
      findings: current.findings,
      trace,
      widthPx: state.widthPx,
      heightPx: state.heightPx,
      rubberBand: rubberBand(),
      snapFeedback: state.snapFeedback,
      readout,
      nodeKinds: state.nodeKinds,
      robotPose: robot,
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
      activeHeadingHandle:
        state.press?.drag?.kind === "headingHandle"
          ? { stepId: state.press.drag.stepId, key: state.press.drag.handle.key }
          : null,
    });
  }, [effectiveView, paintStatic, robotPose, rubberBand]);

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

  /** A new view: blit now, repaint the field sharp once the gesture has settled. */
  const setView = useCallback(
    (view: View) => {
      const state = stateRef.current;
      state.view = view;
      state.hitScene = null;
      if (state.staticTimer !== null) window.clearTimeout(state.staticTimer);
      state.staticTimer = window.setTimeout(() => {
        state.staticTimer = null;
        state.staticDirty = true;
        requestDraw();
      }, STATIC_SETTLE_MS);
      requestDraw();
    },
    [requestDraw],
  );

  const fit = useCallback(() => {
    const state = stateRef.current;
    if (state.widthPx === 0) return;
    state.userAdjusted = false;
    state.laidOutAt = { widthPx: state.widthPx, heightPx: state.heightPx };
    setView(fitView(withMargin(bounds), state.widthPx, state.heightPx, FIT_PADDING_PX, orientation));
  }, [bounds, orientation, setView]);

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
      (size) => fitView(withMargin(bounds), size.widthPx, size.heightPx, FIT_PADDING_PX, orientation),
    );
    state.view = layout.view;
    state.laidOutAt = layout.laidOutAt;
    return state.view !== before;
  }, [bounds, orientation]);

  /** `F`: frame the selected points, or the selected step, or the whole routine. */
  const zoomToSelection = useCallback(() => {
    const state = stateRef.current;
    if (state.widthPx === 0) return;
    const current = propsRef.current;
    const mirror = mirrorRef.current;
    const points: Vec2[] = [];
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
    const drawn = points.map((point) => mirrorVec(point, mirror));
    const xs = drawn.map((point) => point.xIn);
    const ys = drawn.map((point) => point.yIn);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const halfX = Math.max((Math.max(...xs) - Math.min(...xs)) / 2 + SELECTION_MARGIN_IN, SELECTION_MIN_SPAN_IN / 2);
    const halfY = Math.max((Math.max(...ys) - Math.min(...ys)) / 2 + SELECTION_MARGIN_IN, SELECTION_MIN_SPAN_IN / 2);
    state.userAdjusted = true;
    state.laidOutAt = { widthPx: state.widthPx, heightPx: state.heightPx };
    setView(
      fitView(
        { minXIn: cx - halfX, maxXIn: cx + halfX, minYIn: cy - halfY, maxYIn: cy + halfY },
        state.widthPx,
        state.heightPx,
        FIT_PADDING_PX,
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

    // A new field or orientation re-fits a view the user has not moved, whatever the pane's size.
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

    return () => {
      observer.disconnect();
      stopTheme();
      canvas.removeEventListener("wheel", onWheel);
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
  }, [props.field, props.waypoints, fieldView, markStaticDirty, requestDraw]);

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
        const run = previous === null ? simulateRun(plan, robot, field) : resimulate(previous, plan, robot, field);
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
      );
    }
    return state.hitScene ?? { handles: [], markers: [], polylines: [], knobs: [] };
  }, []);

  const localPoint = useCallback((event: { clientX: number; clientY: number }): ScreenVec => {
    const canvas = canvasRef.current;
    if (canvas === null) return { xPx: 0, yPx: 0 };
    const rect = canvas.getBoundingClientRect();
    return { xPx: event.clientX - rect.left, yPx: event.clientY - rect.top };
  }, []);

  /** Screen pixels to canonical world inches: the mirror comes off here and nowhere else. */
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
        waypoints: waypointsRef.current,
        bounds,
        footprintBounds: footprint,
      };
      if (body !== undefined) context.bodyBounds = body;
      return context;
    },
    [bounds],
  );

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

  /** A heading handle of a step by its key, from the scene as it is now. */
  const headingHandleOf = useCallback((stepId: string, key: string): HeadingHandle | null => {
    const step = sceneRef.current.steps.find((candidate) => candidate.stepId === stepId);
    if (step === undefined) return null;
    return headingHandlesFor(step, step.heading).find((handle) => handle.key === key) ?? null;
  }, []);

  const cursorFor = useCallback((hit: CanvasHit | null): string => {
    const state = stateRef.current;
    const tool = propsRef.current.tool;
    if (tool === "pan" || state.spaceHeld) return state.press === null ? "grab" : "grabbing";
    const dragKind = state.press?.drag?.kind;
    if (dragKind === "headingHandle" || dragKind === "rangeBoundary") return "grabbing";
    if (hit?.rangeBoundary !== undefined) return "grab";
    if (hit?.headingHandle !== undefined) {
      const handle = headingHandleOf(hit.stepId, hit.headingHandle);
      return handle?.editable === true && propsRef.current.onSetHeading !== undefined ? "grab" : "not-allowed";
    }
    if (tool === "addPath" || tool === "addCommand" || tool === "marker" || tool === "measure") return "crosshair";
    if (hit === null) return "default";
    if (hit.point !== undefined) return "move";
    if (hit.markerIndex !== undefined) return "ew-resize";
    return "pointer";
  }, [headingHandleOf]);

  /** The hover readout: the robot, t and time on a path; coordinates on a handle. */
  const hoverBubble = useCallback((hit: CanvasHit | null, at: ScreenVec): Bubble | null => {
    if (hit === null) return null;
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
      return {
        xPx: at.xPx,
        yPx: at.yPx,
        lines: [hit.point.pointKind === "control" ? `x ${fmt(pose.xIn)}  y ${fmt(pose.yIn)} in` : poseLine(pose), name],
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
  }, [headingHandleOf, poseOfPoint]);

  const updateHover = useCallback(
    (xPx: number, yPx: number) => {
      const state = stateRef.current;
      const hit = hitTest(hitScene(), xPx, yPx);
      const changed =
        hit?.stepId !== state.hover?.stepId ||
        hit?.markerIndex !== state.hover?.markerIndex ||
        hit?.headingHandle !== state.hover?.headingHandle ||
        hit?.rangeBoundary !== state.hover?.rangeBoundary ||
        hit?.point?.pointKind !== state.hover?.point?.pointKind ||
        hit?.point?.segmentIndex !== state.hover?.point?.segmentIndex ||
        hit?.point?.controlIndex !== state.hover?.point?.controlIndex;
      // The hovered step's control points are grabbable only while its dots are shown.
      if (hit?.stepId !== state.hover?.stepId) state.hitScene = null;
      state.hover = hit;
      state.readoutHeadingRad = null;
      if (hit !== null && hit.t !== undefined) {
        const step = sceneRef.current.steps.find((candidate) => candidate.stepId === hit.stepId);
        state.readoutHeadingRad = step === undefined ? null : poseAtT(step, hit.t).headingRad;
      } else if (hit?.point !== undefined && hit.point.pointKind !== "control") {
        state.readoutHeadingRad = poseOfPoint(hit.stepId, hit.point)?.headingRad ?? null;
      }
      state.bubble = propsRef.current.tool === "measure" ? null : hoverBubble(hit, { xPx, yPx });
      if (changed) propsRef.current.onHover(hit);
      const canvas = canvasRef.current;
      if (canvas !== null) canvas.style.cursor = cursorFor(hit);
    },
    [cursorFor, hitScene, hoverBubble, poseOfPoint],
  );

  /** Every point position the measure tool's ends can land on. */
  const measureCandidates = useCallback((): Vec2[] => {
    const out: Vec2[] = [];
    for (const step of sceneRef.current.steps) {
      for (const handle of step.handles) if (!handle.chained) out.push(handle.poseIn);
      for (const control of step.controls) out.push(control.pointIn);
    }
    for (const waypoint of waypointsRef.current) out.push(waypoint);
    out.push(sceneRef.current.startPose);
    return out;
  }, []);

  const beginDrag = useCallback(
    (xPx: number, yPx: number, keys: HeldKeys): Drag | null => {
      const state = stateRef.current;
      const current = propsRef.current;
      if (state.view === null) return null;
      if (current.tool === "pan" || state.spaceHeld) return { kind: "pan", lastXPx: xPx, lastYPx: yPx };

      if (current.tool === "measure") {
        const modifiers = resolveModifiers(current.snap, keys);
        const pointer = toWorld(xPx, yPx);
        const fromIn = modifiers.snap
          ? snapMeasureEnd(pointer, measureCandidates(), state.view.pxPerIn).pointIn
          : pointer;
        return { kind: "measure", fromIn };
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

      if (hit?.headingHandle !== undefined) return headingFrom(hit.stepId, hit.headingHandle);
      if (hit?.rangeBoundary !== undefined && current.onSetHeading !== undefined) {
        const heading = sceneRef.current.steps.find((step) => step.stepId === hit.stepId)?.heading;
        if (heading?.mode === "piecewise") return { kind: "rangeBoundary", stepId: hit.stepId, index: hit.rangeBoundary, heading };
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
        if (inSelection && !keys.shift) {
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
        return {
          kind: "points",
          leader: { ...leaderPoint, pose: leaderPose },
          followers,
          steps: flatStepsRef.current,
          polygons,
          isControl: hit.point.pointKind === "control",
        };
      }
      if (hit?.markerIndex !== undefined) return { kind: "marker", stepId: hit.stepId, markerIndex: hit.markerIndex };
      if (current.tool === "select") return { kind: "marquee", base: current.selection, additive: keys.shift };
      return null;
    },
    [headingHandleOf, hitScene, measureCandidates, poseOfPoint, toWorld],
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
        const result = resolveLeader(leader.pose, pointerIn, modifiers, context);
        const moves = planPointDrag({
          leader,
          leaderPose: result.pose,
          followers: drag.followers,
          polygonsOf: (stepId) => drag.polygons.get(stepId) ?? null,
          nodeKinds: state.nodeKinds,
          breakMirror: modifiers.breakMirror,
        });
        state.snapFeedback = result.snap;
        state.readoutHeadingRad = drag.isControl ? null : result.pose.headingRad;
        state.readoutLabel = result.label;
        const count = drag.followers.length + 1;
        const values = drag.isControl ? `x ${fmt(result.pose.xIn)}  y ${fmt(result.pose.yIn)} in` : poseLine(result.pose);
        const notes = [result.label ?? "no snap"];
        if (count > 1) notes.push(`${String(count)} points`);
        state.bubble = { xPx, yPx, lines: [values, notes.join(" · ")] };
        emitMoves(moves);
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
    [emitMoves, hitScene, measureCandidates, requestDraw, setView, snapContext, toWorld],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (canvas === null) return;
      if (event.button === 2) return; // The context menu has its own handler.
      if (menuRef.current !== null) setMenu(null);
      canvas.focus();
      const { xPx, yPx } = localPoint(event);
      const keys = heldKeys(event);
      const state = stateRef.current;
      state.keys = keys;
      const drag = event.button === 1 ? ({ kind: "pan", lastXPx: xPx, lastYPx: yPx } as Drag) : beginDrag(xPx, yPx, keys);
      state.press = { xPx, yPx, moved: false, drag, hit: hitTest(hitScene(), xPx, yPx), shift: keys.shift };
      if (drag?.kind === "measure") state.measurement = { fromIn: drag.fromIn, toIn: drag.fromIn };
      canvas.setPointerCapture(event.pointerId);
      canvas.style.cursor = cursorFor(state.press.hit);
      // A point, heading or marker drag brackets every edit it produces in one undo transaction, no
      // matter how many pointer-move frames land in between. A click opens and closes an empty one.
      if (drag !== null && (drag.kind === "points" || drag.kind === "headingHandle" || drag.kind === "rangeBoundary" || drag.kind === "marker")) {
        propsRef.current.onDragStart();
      }
    },
    [beginDrag, cursorFor, hitScene, localPoint],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const state = stateRef.current;
      const { xPx, yPx } = localPoint(event);
      state.pointerIn = toWorld(xPx, yPx);
      state.pointerPx = { xPx, yPx };
      state.keys = heldKeys(event);

      const press = state.press;
      if (press === null) {
        state.readoutLabel = null;
        updateHover(xPx, yPx);
        requestDraw();
        return;
      }
      if (!press.moved && Math.hypot(xPx - press.xPx, yPx - press.yPx) > CLICK_SLOP_PX) {
        press.moved = true;
        state.hover = null;
        // Pressing a dot of a step that is not selected selects that step as the drag begins, so one
        // gesture both picks the step and moves its point. Selection is not in the undo history, so
        // the drag's transaction stays the only undo step.
        const drag = press.drag;
        const current = propsRef.current;
        if (drag?.kind === "points" && !stepsWithHandles(current.selection).has(drag.leader.stepId)) {
          current.onSelect({ stepId: drag.leader.stepId });
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
      const world = toWorld(xPx, yPx);
      const modifiers = resolveModifiers(current.snap, keys);

      if (current.tool === "addPath" || current.tool === "addCommand") {
        const from = anchorEndPose();
        const away = Math.hypot(world.xIn - from.xIn, world.yIn - from.yIn);
        if (current.tool === "addPath" && away < ADD_POINT_MIN_IN) return;
        const headingRad =
          current.tool === "addCommand" || away < 1e-6 ? from.headingRad : Math.atan2(world.yIn - from.yIn, world.xIn - from.xIn);
        const robot = current.robot;
        const context = snapContext((pose) => footprintBoundsIn(pose, robot));
        const snapped = snapPose({ ...world, headingRad }, { ...context, enabled: modifiers.snap, altHeld: !modifiers.quantise });
        if (current.tool === "addPath") current.onAddPathPoint(snapped.pose);
        else current.onAddCommandAt(snapped.pose);
        return;
      }
      if (current.tool === "marker") {
        if (hit !== null && hit.t !== undefined) current.onAddMarker(hit.stepId, hit.t);
        return;
      }
      if (current.tool === "measure") return;
      if (hit === null) {
        current.onSelect({});
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
    [anchorEndPose, snapContext, toWorld],
  );

  const finishPress = useCallback(
    (xPx: number, yPx: number, button: number) => {
      const state = stateRef.current;
      const press = state.press;
      state.press = null;
      state.snapFeedback = null;
      state.readoutLabel = null;
      state.bubble = null;
      // A pane resize that arrived during the press was held back; lay the view out for it now, and
      // draw at once so the view the element publishes is never a frame behind the one in use.
      if (layoutToPane()) {
        markStaticDirty();
        draw();
      }
      if (press === null) return;
      const drag = press.drag;
      if (drag !== null && (drag.kind === "points" || drag.kind === "headingHandle" || drag.kind === "rangeBoundary" || drag.kind === "marker")) {
        propsRef.current.onDragEnd();
      }
      if (drag?.kind === "marquee" && press.moved && state.marquee !== null && state.view !== null) {
        const candidates = projectMarqueeCandidates(sceneRef.current, state.view, mirrorRef.current, drag.base);
        propsRef.current.onSelect(marqueeSelection(drag.base, candidates, state.marquee, drag.additive));
      }
      state.marquee = null;
      if (drag?.kind === "measure" && !press.moved) state.measurement = null;
      if (!press.moved && button !== 1) clickAction(xPx, yPx, press.hit, press.shift, state.keys);
      updateHover(xPx, yPx);
      requestDraw();
    },
    [clickAction, draw, layoutToPane, markStaticDirty, requestDraw, updateHover],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (canvas !== null && canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      const { xPx, yPx } = localPoint(event);
      stateRef.current.keys = heldKeys(event);
      finishPress(xPx, yPx, event.button);
    },
    [finishPress, localPoint],
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
      const hit = hitTest(hitScene(), xPx, yPx);
      const atIn = toWorld(xPx, yPx);
      let target: CanvasMenuTarget;
      if (hit?.point !== undefined) {
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
        target = { kind: "field", atIn };
      }

      const shellItems = current.canvasActions?.(target) ?? [];
      const own: CanvasAction[] = [];
      if (target.kind === "point") {
        const node = targetNode(target.stepId, target.point);
        if (node !== null && target.stepId !== undefined) {
          const stepId = target.stepId;
          const kind = effectiveNodeKind(state.nodeKinds, stepId, node);
          own.push({
            id: "canvas.node.smooth",
            label: CANVAS_TOOLTIPS.smooth.label,
            shortcut: CANVAS_TOOLTIPS.smooth.shortcut,
            enabled: kind !== "smooth",
            disabledReason: "This point is already smooth.",
            run: () => {
              setNodeKind(stepId, node, "smooth");
            },
          });
          own.push({
            id: "canvas.node.corner",
            label: CANVAS_TOOLTIPS.corner.label,
            shortcut: CANVAS_TOOLTIPS.corner.shortcut,
            enabled: kind !== "corner",
            disabledReason: "This point is already a corner.",
            run: () => {
              setNodeKind(stepId, node, "corner");
            },
          });
        }
      }
      if (target.kind === "path" && target.stepId !== undefined && target.t !== undefined && current.onSplitAt !== undefined) {
        const { stepId, t } = target;
        own.push({
          id: "canvas.split",
          label: "Split path here",
          shortcut: "Double-click",
          enabled: current.tool === "select" || current.tool === "addPath",
          run: () => {
            splitAt(stepId, t);
          },
        });
      }
      if (target.kind === "path" && target.stepId !== undefined && target.t !== undefined && current.onSetHeading !== undefined) {
        const { stepId, t } = target;
        const step = sceneRef.current.steps.find((candidate) => candidate.stepId === stepId);
        const split = splitHeadingAt(step?.heading, t);
        const before = step?.heading?.mode === "piecewise" ? step.heading.ranges.length : 1;
        const splits = split.mode === "piecewise" && split.ranges.length > before;
        own.push({
          id: "canvas.splitHeading",
          label: "Split heading here",
          enabled: splits && step?.kind === "path",
          disabledReason: "Too close to a range end: a heading range must be at least 2% of the path.",
          run: () => {
            propsRef.current.onSetHeading?.(stepId, split);
          },
        });
      }
      own.push({
        id: "canvas.zoomSelection",
        label: CANVAS_TOOLTIPS.zoomSelection.label,
        shortcut: CANVAS_TOOLTIPS.zoomSelection.shortcut,
        enabled: true,
        run: zoomToSelection,
      });
      own.push({ id: "canvas.fit", label: "Zoom to fit", shortcut: "Double-click", enabled: true, run: fit });
      if (shellItems.length > 0 && own[0] !== undefined) own[0] = { ...own[0], separatorBefore: true };
      state.hover = null;
      state.bubble = null;
      setMenu({ xPx, yPx, items: [...shellItems, ...own] });
      requestDraw();
    },
    [fit, hitScene, localPoint, requestDraw, setNodeKind, splitAt, targetNode, toWorld, zoomToSelection],
  );

  const onPointerLeave = useCallback(() => {
    const state = stateRef.current;
    if (state.press !== null) return;
    state.pointerIn = null;
    state.pointerPx = null;
    state.readoutHeadingRad = null;
    state.bubble = null;
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
        if (state.press?.drag?.kind === "marquee") {
          state.press = null;
          state.marquee = null;
          requestDraw();
          consume();
          return;
        }
        if (state.measurement !== null) {
          state.measurement = null;
          requestDraw();
          consume();
          return;
        }
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
        state.spaceHeld = event.type === "keydown";
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
      }
    };
    window.addEventListener("keydown", onModifier);
    window.addEventListener("keyup", onModifier);
    return () => {
      canvas.removeEventListener("keydown", onCanvasKey);
      window.removeEventListener("keydown", onModifier);
      window.removeEventListener("keyup", onModifier);
    };
  }, [applyDrag, requestDraw, setNodeKind, targetNode, zoomToSelection]);

  const closeMenu = useCallback(() => {
    setMenu(null);
    canvasRef.current?.focus();
  }, []);

  const playTip = CANVAS_TOOLTIPS.playPause;
  const playing = props.playing === true;
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
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      {props.onTogglePlay === undefined ? null : (
        <Tooltip
          label={playing ? "Pause" : "Play"}
          shortcut={playTip.shortcut}
          hint={playing ? "Stop the routine where it is." : playTip.detail}
          side="right"
        >
          <button
            type="button"
            className={styles["play"]}
            aria-label={playing ? "Pause" : "Play"}
            data-testid="canvas-play"
            onClick={() => {
              props.onTogglePlay?.();
            }}
          >
            {playing ? (
              <Pause size={16} strokeWidth={1.5} aria-hidden />
            ) : (
              <Play size={16} strokeWidth={1.5} aria-hidden />
            )}
          </button>
        </Tooltip>
      )}
      {menu === null ? null : <ContextMenu xPx={menu.xPx} yPx={menu.yPx} items={menu.items} onClose={closeMenu} />}
    </div>
  );
}

export default FieldCanvas;
