/**
 * The BIOBUZZ hives, drawn from the ledger at the playback time: the body each hive's cells ride on, which cell is up, what is in it, and a tip as the
 * swing it is, with the load fading out of the cell that goes down as the bar passes level.
 *
 * The dumped pieces are not drawn on the floor. They land in a floor quarter the ledger counts, and
 * that quarter's count chip (`fieldCounts.ts`) is how the field shows them; a drawn spot for each
 * piece would claim a place on the floor the ledger does not know.
 *
 * Modelled on DSim's top-down view of the hive. The bar does not rotate in plan: both cells keep
 * their places, and a tip shows as the bar reaching out a little as it comes level (every plan
 * length is a true length times the cosine of the tilt, which runs from 30 degrees through 0 to -30)
 * and the "up" look moving from one cell to the other, swapping fastest at level, which is also the
 * instant the load leaves the cell. The up cell is filled in its alliance's colour, the down cell is a dashed
 * outline, the closed end by the pivot is a heavy edge and the open outer end a thin one. Pieces
 * take the shared colours in `pieceColours.ts`: pollen gold, nectar its alliance's colour.
 *
 * Everything moves on the playback clock, never the wall clock, so a scrub to a time always draws
 * the same frame. Without playback the time is 0, which is the kickoff state. This module draws the
 * whole hive from geometry and the ledger, over the drawn field (`staticLayer.ts`), which leaves the
 * hives to it and draws only the foot bars and the crossbar under them. The frame's slanted legs are
 * drawn over the hives (`structureLayer.ts` `drawHiveLevel`), because their bands lie under the
 * hives' bodies. With the
 * ledger switched off there is nothing to tip it, so the hive is drawn as the field file stages it.
 *
 * Pure except for the painter: `hiveTimeline` and `hiveFrameAt` are plain functions of their inputs.
 */
import type { LedgerRun, MirrorMode } from "@horizon36596/zenith-core";
import {
  asBiobuzzState,
  cellRow,
  hiveBodies,
  hiveTipsBetween,
  biobuzzRules,
  HIVE_REST_TILT_RAD,
  initialBiobuzzState,
  isNectar,
  loadSeason,
  type BiobuzzState,
  type HiveBody,
  type HiveState,
} from "@horizon36596/zenith-season-biobuzz";
import type { Field } from "@horizon36596/zenith-schema";
import { pieceEdge, pieceInk } from "./pieceColours.js";
import type { CanvasTheme } from "./theme.js";
import type { TraceOverlay } from "./types.js";
import type { View } from "./view.js";

/** How long past a step's end, in seconds, still counts as the end, as `ledgerBadges.ts` has it. */
const END_SLOP_S = 1e-6;

/**
 * A cell's depth along the bar in plan, in inches: DSim's 11.75 in cell depth seen from above with
 * the bar at its 30 degree rest tilt. The cell sits flush with the hive's outer face, which the
 * field file gives.
 */
const CELL_DEPTH_IN = 11.75 * Math.cos(HIVE_REST_TILT_RAD);

/** A pollen's radius comes from the field's garden elements; nectar is larger (DSim `BB_NECTAR_R`). */
const NECTAR_RADIUS_IN = 1.8;
const FALLBACK_POLLEN_RADIUS_IN = 1.4;

/** DSim's clearances for a cell's row of pieces: off the open edge, and off the long sides. */
const ROW_OFF_EDGE_IN = 0.7;
const ROW_PAD_IN = 0.9;

/** The rounded corner of the body and its cells, in inches (DSim `HIVE_R`). */
const CORNER_IN = 2;

/** One tip on the playback clock: when it starts, how long it swings and what it dumps. */
export interface HiveTipEvent {
  hiveId: string;
  startS: number;
  swingS: number;
  fromSide: string;
  toSide: string;
  /** The cell's pieces as they swing down, in row order. */
  row: readonly string[];
}

/** The ledger's states on the playback clock, and the tips between them. Built once per run and trace. */
export interface HiveTimeline {
  /** The kickoff state first (at minus infinity), then the state after each step, by the time it ends. */
  keyframes: ReadonlyArray<{ atS: number; state: BiobuzzState; rows: Readonly<Record<string, readonly string[]>> }>;
  tips: readonly HiveTipEvent[];
  bodies: Readonly<Record<string, HiveBody>>;
  pollenRadiusIn: number;
}

const rowsOf = (state: BiobuzzState): Record<string, readonly string[]> => {
  const rows: Record<string, readonly string[]> = {};
  for (const hive of Object.values(state.hives)) rows[hive.id] = cellRow(state, hive.upCell);
  return rows;
};

/**
 * The hive timeline for a ledger run, with each step's state placed at the time the trace says the
 * step ended. A step the trace never finishes has no place on the clock, the way the count badges
 * treat it. Without a run (the ledger switched off) it is the kickoff state alone, for a BIOBUZZ
 * field. Null when the field or the run is not BIOBUZZ.
 */
export function hiveTimeline(run: LedgerRun | null, trace: TraceOverlay | null, field: Field): HiveTimeline | null {
  const initial =
    run === null
      ? loadSeason(field) === biobuzzRules
        ? initialBiobuzzState(field)
        : null
      : asBiobuzzState(run.initialState);
  if (initial === null || Object.keys(initial.hives).length === 0) return null;
  const ends = new Map<string, number>();
  for (const step of trace?.steps ?? []) ends.set(step.id, step.endS);

  const keyframes: Array<HiveTimeline["keyframes"][number]> = [
    { atS: Number.NEGATIVE_INFINITY, state: initial, rows: rowsOf(initial) },
  ];
  const tips: HiveTipEvent[] = [];
  const pollenRadiusIn =
    (field.elements ?? []).find((element) => (element.container === null || element.container === undefined) && element.kind === initial.elementKind)
      ?.radiusIn ?? FALLBACK_POLLEN_RADIUS_IN;
  for (const entry of run?.entries ?? []) {
    const endS = ends.get(entry.stepId);
    const before = asBiobuzzState(entry.before);
    const after = asBiobuzzState(entry.after);
    if (endS === undefined || before === null || after === null) continue;
    keyframes.push({ atS: endS, state: after, rows: rowsOf(after) });
    for (const tip of hiveTipsBetween(before, after)) {
      if (before.hives[tip.hiveId] === undefined) continue;
      tips.push({
        hiveId: tip.hiveId,
        startS: endS,
        swingS: tip.swingS,
        fromSide: tip.fromSide,
        toSide: tip.toSide,
        row: cellRow(before, tip.dumped),
      });
    }
  }
  // The clock is the trace's; the ledger runs the steps in order, and so does the trace.
  keyframes.sort((a, b) => a.atS - b.atS);
  tips.sort((a, b) => a.startS - b.startS);
  return { keyframes, tips, bodies: hiveBodies(field, initial), pollenRadiusIn };
}

/** The bar's look at a point in a swing, from DSim's `tipProjection`. */
export function swingPose(progress: number): { proj: number; up: number } {
  const p = Math.min(1, Math.max(0, progress));
  const tilt = HIVE_REST_TILT_RAD * (1 - 2 * p);
  return {
    // Every plan length is the true length times cos(tilt), so it reaches out as the bar comes level.
    proj: Math.cos(tilt) / Math.cos(HIVE_REST_TILT_RAD),
    // How high the cell that started up is: 1 at its rest, 0 once it is down, fastest at level.
    up: (Math.sin(tilt) + Math.sin(HIVE_REST_TILT_RAD)) / (2 * Math.sin(HIVE_REST_TILT_RAD)),
  };
}

/** One hive as it is drawn at one time. */
export interface HiveFrame {
  hive: HiveState;
  /** The cell drawn as up at rest, or the cell swinging down during a tip. */
  upSide: string;
  /** How up that cell looks, 1 at rest and falling to 0 across a swing. */
  up: number;
  /** The plan foreshortening, 1 at rest. */
  proj: number;
  /** The swing in progress, if any, and how far through it is (0 to 1). */
  swing: { tip: HiveTipEvent; progress: number } | null;
  /** The row of pieces drawn, which cell it is in, and how strongly it shows. */
  row: readonly string[];
  rowSide: string;
  rowAlpha: number;
}

const opposite = (side: string): string =>
  side === "NORTH" ? "SOUTH" : side === "SOUTH" ? "NORTH" : side === "EAST" ? "WEST" : side === "WEST" ? "EAST" : side;

/** The ledger's state at a time: the keyframe of the last step that has ended by then. */
function keyframeAt(timeline: HiveTimeline, timeS: number): HiveTimeline["keyframes"][number] {
  let found = timeline.keyframes[0]!;
  for (const keyframe of timeline.keyframes) {
    if (keyframe.atS <= timeS + END_SLOP_S) found = keyframe;
    else break;
  }
  return found;
}

/**
 * Each hive at `timeS`. A hive is mid-swing from the end of the step that tipped it until its swing
 * time has passed; the load rides the cell that is swinging down, fading with it, until the bar is
 * level. From then on the pieces are the floor quarter's count, not anything drawn here.
 */
export function hiveFrameAt(timeline: HiveTimeline, timeS: number): { hives: HiveFrame[] } {
  const keyframe = keyframeAt(timeline, timeS);
  const hives: HiveFrame[] = [];
  for (const hive of Object.values(keyframe.state.hives)) {
    let active: HiveTipEvent | null = null;
    for (const tip of timeline.tips) {
      if (tip.hiveId !== hive.id || tip.startS > timeS + END_SLOP_S) continue;
      active = timeS < tip.startS + tip.swingS ? tip : null;
    }
    const restRow = keyframe.rows[hive.id] ?? [];
    if (active === null) {
      hives.push({ hive, upSide: hive.upSide, up: 1, proj: 1, swing: null, row: restRow, rowSide: hive.upSide, rowAlpha: 1 });
      continue;
    }
    const progress = (timeS - active.startS) / active.swingS;
    const { proj, up } = swingPose(progress);
    const beforeLevel = progress < 0.5;
    hives.push({
      hive,
      upSide: active.fromSide,
      up,
      proj,
      swing: { tip: active, progress },
      // Before level the load is still in the cell going down; after it, the cell coming up holds
      // whatever the ledger has put in it since.
      row: beforeLevel ? active.row : restRow,
      rowSide: beforeLevel ? active.fromSide : opposite(active.fromSide),
      rowAlpha: beforeLevel ? up : 1 - up,
    });
  }

  return { hives };
}

/** `hiveRed:up=SOUTH,cell=3` per hive, with the swing when one is under way, for tests and bug reports. */
export function hiveSummary(frame: { hives: readonly HiveFrame[] }): string {
  return frame.hives
    .map((entry) => {
      const swing =
        entry.swing === null ? "" : `,swing=${entry.swing.tip.fromSide}>${entry.swing.tip.toSide}@${entry.swing.progress.toFixed(2)}`;
      return `${entry.hive.id}:up=${entry.hive.upSide},cell=${String(entry.row.length)}${swing}`;
    })
    .join(";");
}

// ---- The painter ---------------------------------------------------------------------------

/** The last timeline built, so a frame reuses it until the run, the trace or the field changes. */
let cached: { run: LedgerRun | null; trace: TraceOverlay | null; field: Field; timeline: HiveTimeline | null } | null = null;

function timelineFor(run: LedgerRun | null, trace: TraceOverlay | null, field: Field): HiveTimeline | null {
  if (cached !== null && cached.run === run && cached.trace === trace && cached.field === field) return cached.timeline;
  const timeline = hiveTimeline(run, trace, field);
  cached = { run, trace, field, timeline };
  return timeline;
}

/** A field point, mirrored and on screen, written into `out` so a ball costs no allocation. */
interface Screen {
  xPx: number;
  yPx: number;
}

export interface HiveDrawInput {
  ledger: { run: LedgerRun } | null | undefined;
  trace: TraceOverlay | null;
  field: Field;
  timeS: number | undefined;
  view: View;
  mirror: MirrorMode;
  theme: CanvasTheme;
}

/**
 * Draws every hive at the playback time and returns `hiveSummary` for the canvas to
 * publish. Draws nothing, and returns "", when the field is not a BIOBUZZ one.
 */
export function drawHives(ctx: CanvasRenderingContext2D, input: HiveDrawInput): string {
  const timeline = timelineFor(input.ledger?.run ?? null, input.trace, input.field);
  if (timeline === null) return "";
  const frame = hiveFrameAt(timeline, input.timeS ?? 0);
  const { view, theme, mirror } = input;
  const state = keyframeAt(timeline, input.timeS ?? 0).state;

  // The mirror as two signs, and the screen transform written out, so a point costs no object.
  const sx = mirror === "pointSymmetry" || mirror === "mirrorY" ? -1 : 1;
  const sy = mirror === "pointSymmetry" || mirror === "mirrorX" ? -1 : 1;
  const { xAxis, yAxis } = view.orientation;
  const toScreen = (xIn: number, yIn: number, out: Screen): Screen => {
    const x = xIn * sx;
    const y = yIn * sy;
    out.xPx = view.originXPx + view.pxPerIn * (xAxis.xPx * x + yAxis.xPx * y);
    out.yPx = view.originYPx + view.pxPerIn * (xAxis.yPx * x + yAxis.yPx * y);
    return out;
  };
  const a: Screen = { xPx: 0, yPx: 0 };
  const b: Screen = { xPx: 0, yPx: 0 };
  // Mirrored, the routine is drawn as the other alliance's, so its hive takes that alliance's colour.
  const inkOf = (alliance: "RED" | "BLUE"): string =>
    (alliance === "RED") === (mirror === "none") ? theme.allianceRed : theme.allianceBlue;
  const kindInk = (kind: string): string => pieceInk(theme, kind, state.nectarKind, mirror !== "none");
  const radiusOf = (kind: string): number => (isNectar(state, kind) ? NECTAR_RADIUS_IN : timeline.pollenRadiusIn);
  const cornerPx = Math.max(1, CORNER_IN * view.pxPerIn);

  /** A field box as a rounded screen rectangle, whichever way the view and the mirror turn it. */
  const boxPath = (minXIn: number, minYIn: number, maxXIn: number, maxYIn: number): void => {
    toScreen(minXIn, minYIn, a);
    toScreen(maxXIn, maxYIn, b);
    const left = Math.min(a.xPx, b.xPx);
    const top = Math.min(a.yPx, b.yPx);
    const width = Math.abs(a.xPx - b.xPx);
    const height = Math.abs(a.yPx - b.yPx);
    ctx.beginPath();
    ctx.roundRect(left, top, width, height, Math.min(cornerPx, width / 2, height / 2));
  };
  /** A field segment as a screen line. */
  const segment = (x0: number, y0: number, x1: number, y1: number): void => {
    toScreen(x0, y0, a);
    toScreen(x1, y1, b);
    ctx.beginPath();
    ctx.moveTo(a.xPx, a.yPx);
    ctx.lineTo(b.xPx, b.yPx);
    ctx.stroke();
  };
  const ball = (xIn: number, yIn: number, kind: string, alpha: number): void => {
    toScreen(xIn, yIn, a);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = kindInk(kind);
    ctx.beginPath();
    ctx.arc(a.xPx, a.yPx, Math.max(1.5, radiusOf(kind) * view.pxPerIn), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  };

  ctx.save();
  for (const entry of frame.hives) {
    const { hive, proj } = entry;
    const body = timeline.bodies[hive.id];
    if (body === undefined) continue;
    const ink = inkOf(hive.alliance);
    // Along is the swing axis, across the other; both in field inches about the pivot.
    const alongY = hive.axis === "y";
    const pivotAlong = alongY ? hive.pivotIn.yIn : hive.pivotIn.xIn;
    const acrossMin = alongY ? body.minXIn : body.minYIn;
    const acrossMax = alongY ? body.maxXIn : body.maxYIn;
    const box = (along0: number, along1: number): void =>
      alongY
        ? boxPath(acrossMin, pivotAlong + along0, acrossMax, pivotAlong + along1)
        : boxPath(pivotAlong + along0, acrossMin, pivotAlong + along1, acrossMax);
    const edge = (along: number): void =>
      alongY
        ? segment(acrossMin + CORNER_IN, pivotAlong + along, acrossMax - CORNER_IN, pivotAlong + along)
        : segment(pivotAlong + along, acrossMin + CORNER_IN, pivotAlong + along, acrossMax - CORNER_IN);

    // The body the cells ride on, opaque, so the axle and the floor under it never show through.
    const reach = hive.outerFaceIn * proj;
    ctx.globalAlpha = 1;
    box(-reach, reach);
    ctx.fillStyle = theme.fieldObstacleFill;
    ctx.fill();
    ctx.strokeStyle = theme.fieldObstacle;
    ctx.lineWidth = 1;
    ctx.stroke();

    const depth = CELL_DEPTH_IN * proj;
    for (const side of [entry.upSide, opposite(entry.upSide)]) {
      const sign = side === "SOUTH" || side === "WEST" ? -1 : 1;
      const outer = sign * reach;
      const inner = sign * (reach - depth);
      const lo = Math.min(outer, inner);
      const hi = Math.max(outer, inner);
      const k = side === entry.upSide ? entry.up : 1 - entry.up;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      if (k > 0.01) {
        // Up: filled in the alliance's colour.
        box(lo, hi);
        ctx.globalAlpha = 0.45 * k;
        ctx.fillStyle = ink;
        ctx.fill();
        ctx.globalAlpha = k;
        ctx.stroke();
      }
      if (k < 0.99) {
        // Down: a dashed outline, structure overhead with the floor showing through.
        box(lo, hi);
        ctx.globalAlpha = 1 - k;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // The closed end by the pivot is heavy and the open outer end thin, whichever cell is up.
      ctx.globalAlpha = 1;
      ctx.lineCap = "round";
      ctx.lineWidth = 2.5;
      edge(inner);
      ctx.lineWidth = 1;
      edge(outer);
      ctx.lineCap = "butt";

      // The pieces: one row against the open edge, oldest first, overlapping rather than shrinking
      // when the row is longer than the cell is wide.
      if (side !== entry.rowSide || entry.row.length === 0 || entry.rowAlpha <= 0.01) continue;
      let want = 0;
      let biggest = 0;
      for (const kind of entry.row) {
        const r = radiusOf(kind);
        want += 2 * r;
        if (r > biggest) biggest = r;
      }
      const span = acrossMax - acrossMin - 2 * ROW_PAD_IN;
      const pitch = want > span ? span / want : 1;
      const rowAlong = pivotAlong + outer - sign * (biggest + ROW_OFF_EDGE_IN);
      let t = acrossMin + ROW_PAD_IN + Math.max(0, (span - want) / 2);
      ctx.strokeStyle = pieceEdge(theme);
      ctx.lineWidth = 1;
      for (const kind of entry.row) {
        const r = radiusOf(kind);
        t += r * pitch;
        if (alongY) ball(t, rowAlong, kind, entry.rowAlpha);
        else ball(rowAlong, t, kind, entry.rowAlpha);
        t += r * pitch;
      }
    }
  }

  ctx.restore();
  return hiveSummary(frame);
}
