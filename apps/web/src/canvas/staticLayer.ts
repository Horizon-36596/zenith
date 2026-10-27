/**
 * The static layer: the field itself, painted into an offscreen canvas. A frame where only the live
 * layer changes (a drag, a hover, playback) blits that canvas as it is, so nothing here runs while
 * an endpoint is being dragged. It is redrawn when the document, the size or the theme changes,
 * and on every frame of a pan, a zoom or a fit, at the new view, so the parts of the field that
 * were off screen when the view started moving are drawn at once (issue #151). The one exception
 * is a field picture whose paint measures slow (`FieldCanvas.tsx` `blitsWhileMoving`): while its
 * view moves the canvas blits the cached picture under the new transform and repaints it once the
 * view has settled.
 *
 * When the shell passes `staticSvg` (from `core.render`) that is rasterised and
 * used instead; this drawing is what the canvas falls back to until M1 lands that function, and it
 * reads the same `field.json` vector geometry the renderer will.
 *
 * Style follows UI_GUIDE section 4: static field furniture is warm or neutral, authored geometry is
 * cool, which is why a path never disappears into the field under it.
 *
 * The whole field is drawn here, from the field file and the season's drawing extras
 * (`seasonDrawing.ts`): the floor and its tile seams, the alliance areas outside the wall, the taped
 * zones and gardens in their alliance's colour, the obstacles and the hive frame's crossbar, the
 * flowers and the staged game pieces, then the wall. The hives themselves move, so `hiveLayer.ts`
 * draws them over this layer at the playback time, and the hive frame's slanted legs, whose bands
 * lie under the hives' bodies, are drawn over the hives (`structureLayer.ts`). No picture is needed;
 * a field file may still
 * name one (`field.image`), which the canvas draws under the outlines instead.
 */
import { fieldBounds, type Box2, type Vec2 } from "@horizon36596/zenith-core";
import type { Field, FieldElement, FieldTarget, Obstacle, Waypoints, Zone } from "@horizon36596/zenith-schema";
import { imageToScreen, pixelBox, type FieldImageSpec } from "./fieldImage.js";
import { PIN_STEM_PX } from "./hit.js";
import { drawHivePivot } from "./hiveOutline.js";
import { pieceEdge, pieceInk, type NectarKinds } from "./pieceColours.js";
import { drawingFor, type DrawingAlliance, type DrawingRect, type FieldDrawing, type TileSeamProfile } from "./seasonDrawing.js";
import type { CanvasTheme } from "./theme.js";
import { tileSeamOutline, type SeamCorner } from "./tileSeam.js";
import type { FieldGrid } from "./types.js";
import { worldToScreen, type View } from "./view.js";

/**
 * Grid spacings, in inches: FTC tiles are 24 in, and the finer lines split a tile into halves (12 in)
 * or quarters (6 in). The 24 in and 12 in spacings are CARRIED OVER from the field as it was drawn
 * before the Grid setting; the 6 in spacing is SET BY HAND (owner ruling D11).
 */
const MAJOR_IN = 24;
/** UI_GUIDE section 8.8: finer lines drop out below 2.5 px per spacing rather than moire (CARRIED OVER). */
const MINOR_MIN_PX = 2.5;

/**
 * The spacings the Grid setting draws: the tile seams, and the finer lines between them where the
 * choice has any. Null for Off, which draws the floor alone.
 */
export function gridLineSpacingsIn(grid: FieldGrid): { seamIn: number; lineIn: number | null } | null {
  switch (grid) {
    case "off":
      return null;
    case "tiles":
      return { seamIn: MAJOR_IN, lineIn: null };
    case "12":
      return { seamIn: MAJOR_IN, lineIn: 12 };
    case "6":
      return { seamIn: MAJOR_IN, lineIn: 6 };
  }
}

/**
 * What the static layer draws over a field picture, for each way of drawing it (spec 15 section 10):
 * the picture alone draws only the perimeter, and the picture with outlines draws `drawStatic` in its
 * "outlines" mode, which paints no floor and no grid. So a field picture never gets grid lines,
 * whatever the Grid setting says. `FieldCanvas` takes both its input mode and its choice of drawing
 * from here, so a test can hold the rule without a canvas.
 */
export function pictureOverlay(view: "image" | "image+outlines"): { staticMode: "outlines" | undefined; drawsOutlines: boolean } {
  return view === "image+outlines" ? { staticMode: "outlines", drawsOutlines: true } : { staticMode: undefined, drawsOutlines: false };
}

export interface StaticLayerInput {
  field: Field;
  waypoints: Waypoints | null;
  /** The selected waypoint pin, which always keeps its name when two names would overlap (issue #235). */
  selectedWaypoint?: string;
  /**
   * The waypoints whose pins are hidden (issue #236), which are not drawn here. A hidden selected pin
   * is drawn by the live layer instead, faint and dashed, and keeps its name's place.
   */
  hiddenWaypoints?: ReadonlySet<string>;
  /** Obstacles whose underside clears this are drawn as overhead, not as walls. */
  robotHeightIn: number;
  /**
   * Whether to draw the dashed outlines of structure the robot passes under: an overhead box and the
   * hive frame's crossbar (issue #230, the `overheadOutlines` preference). Absent means drawn. A
   * blocking obstacle is drawn whatever this says.
   */
  overheadOutlines?: boolean;
  view: View;
  theme: CanvasTheme;
  widthPx: number;
  heightPx: number;
  /**
   * How much of the field's grid is drawn (spec 15 section 10): the floor only, the floor and the
   * 24 in tile seams, or the seams and lines every 12 or 6 in. Absent means Tiles, the default every
   * preset has. The "outlines" mode, which sits over a field picture, draws no grid whatever this says.
   */
  fieldGrid?: FieldGrid;
  /**
   * "outlines" draws the vector field as strokes only, with no background, grid or fills, over the
   * field picture (site/docs/editor.md, "image + outlines"). Absent means the full vector field.
   */
  mode?: "vector" | "outlines";
}

/** Waypoint names are hidden at a fitted zoom (UI_GUIDE 9.11) and appear once zoomed well in. */
export const WAYPOINT_LABEL_MIN_PX_PER_IN = 8;
/** Where a pin's name is drawn: this far right of its spot, centred this far above it. */
export const WAYPOINT_LABEL_DX_PX = 6;
export const WAYPOINT_LABEL_DY_PX = 10;

/** A rough width of one character of a pin's 11 px bold mono name, for its box. */
export const WAYPOINT_LABEL_CHAR_PX = 6.7;

export interface PinLabelBox {
  x0Px: number;
  y0Px: number;
  x1Px: number;
  y1Px: number;
}

/**
 * The boxes of the pin names to draw, by name (issue #235). Empty below the label zoom. The selected
 * pin's name always stays; otherwise names are taken in name order, and a name whose box overlaps one
 * already kept is dropped, so two pins an inch apart show one name and the result never depends on
 * the order of the file. The static layer draws these and `projectPins` hits on them. A hidden pin
 * (issue #236) has no name and takes no room, unless it is the selected one.
 */
export function pinLabelBoxes(
  waypoints: Waypoints | null | undefined,
  view: View,
  selected: string | undefined,
  hidden?: ReadonlySet<string>,
): Map<string, PinLabelBox> {
  const kept = new Map<string, PinLabelBox>();
  if (view.pxPerIn < WAYPOINT_LABEL_MIN_PX_PER_IN) return kept;
  const all = waypoints?.waypoints ?? {};
  const boxOf = (name: string, waypoint: { xIn: number; yIn: number }): PinLabelBox => {
    const at = worldToScreen(view, waypoint);
    const x0Px = at.xPx + WAYPOINT_LABEL_DX_PX;
    const yPx = at.yPx - WAYPOINT_LABEL_DY_PX;
    return { x0Px: x0Px - 1, y0Px: yPx - 7, x1Px: x0Px + name.length * WAYPOINT_LABEL_CHAR_PX + 1, y1Px: yPx + 7 };
  };
  const clear = (box: PinLabelBox): boolean =>
    [...kept.values()].every((other) => box.x0Px >= other.x1Px || other.x0Px >= box.x1Px || box.y0Px >= other.y1Px || other.y0Px >= box.y1Px);
  const chosen = selected === undefined ? undefined : all[selected];
  if (selected !== undefined && chosen !== undefined) kept.set(selected, boxOf(selected, chosen));
  for (const name of Object.keys(all).sort()) {
    if (name === selected || hidden?.has(name) === true) continue;
    const waypoint = all[name];
    if (waypoint === undefined) continue;
    const box = boxOf(name, waypoint);
    if (clear(box)) kept.set(name, box);
  }
  return kept;
}

const crisp = (valuePx: number): number => Math.round(valuePx) + 0.5;

const point = (view: View, xIn: number, yIn: number): { xPx: number; yPx: number } =>
  worldToScreen(view, { xIn, yIn });

function tracePolygon(ctx: CanvasRenderingContext2D, view: View, corners: readonly Vec2[]): void {
  ctx.beginPath();
  for (const [index, corner] of corners.entries()) {
    const screen = worldToScreen(view, corner);
    if (index === 0) ctx.moveTo(screen.xPx, screen.yPx);
    else ctx.lineTo(screen.xPx, screen.yPx);
  }
  ctx.closePath();
}

const boxCornersIn = (box: Box2): Vec2[] => [
  { xIn: box.minXIn, yIn: box.minYIn },
  { xIn: box.maxXIn, yIn: box.minYIn },
  { xIn: box.maxXIn, yIn: box.maxYIn },
  { xIn: box.minXIn, yIn: box.maxYIn },
];

const traceBox = (ctx: CanvasRenderingContext2D, view: View, box: Box2): void =>
  tracePolygon(ctx, view, boxCornersIn(box));

function line(ctx: CanvasRenderingContext2D, a: { xPx: number; yPx: number }, b: { xPx: number; yPx: number }): void {
  ctx.beginPath();
  ctx.moveTo(a.xPx, a.yPx);
  ctx.lineTo(b.xPx, b.yPx);
  ctx.stroke();
}

/** An axis-aligned 1 px line, put on one row of pixels so it reads as a hairline, not a smear. */
function hairline(ctx: CanvasRenderingContext2D, a: { xPx: number; yPx: number }, b: { xPx: number; yPx: number }): void {
  const vertical = Math.abs(a.xPx - b.xPx) < 0.5;
  const horizontal = Math.abs(a.yPx - b.yPx) < 0.5;
  if (!vertical && !horizontal) {
    line(ctx, a, b);
    return;
  }
  ctx.beginPath();
  if (vertical) {
    ctx.moveTo(crisp(a.xPx), a.yPx);
    ctx.lineTo(crisp(a.xPx), b.yPx);
  } else {
    ctx.moveTo(a.xPx, crisp(a.yPx));
    ctx.lineTo(b.xPx, crisp(a.yPx));
  }
  ctx.stroke();
}

/** Layer 1: the floor fill, under the grid, the zones and the outlines. */
function drawFloor(ctx: CanvasRenderingContext2D, input: StaticLayerInput, bounds: Box2): void {
  traceBox(ctx, input.view, bounds);
  ctx.fillStyle = input.theme.fieldFloor;
  ctx.fill();
}

/**
 * One series of lines across the field, every `stepIn` inches, in `colour`. The lines at 0 are the
 * axis, drawn on their own; with `skipSeams` the lines on a 24 in tile seam are left to the seams.
 */
function drawSeries(
  ctx: CanvasRenderingContext2D,
  input: StaticLayerInput,
  bounds: Box2,
  stepIn: number,
  colour: string,
  skipSeams: boolean,
): void {
  const { view } = input;
  ctx.strokeStyle = colour;
  const startX = Math.ceil(bounds.minXIn / stepIn) * stepIn;
  for (let xIn = startX; xIn <= bounds.maxXIn + 1e-6; xIn += stepIn) {
    if (Math.abs(xIn) < 1e-6) continue;
    if (skipSeams && Math.abs(xIn % MAJOR_IN) < 1e-6) continue;
    hairline(ctx, point(view, xIn, bounds.minYIn), point(view, xIn, bounds.maxYIn));
  }
  const startY = Math.ceil(bounds.minYIn / stepIn) * stepIn;
  for (let yIn = startY; yIn <= bounds.maxYIn + 1e-6; yIn += stepIn) {
    if (Math.abs(yIn) < 1e-6) continue;
    if (skipSeams && Math.abs(yIn % MAJOR_IN) < 1e-6) continue;
    hairline(ctx, point(view, bounds.minXIn, yIn), point(view, bounds.maxXIn, yIn));
  }
}

/**
 * A tab narrower than this, in screen pixels across the seam, reads as a smudge, so below it the
 * seams are drawn as the straight lines they were before issue #428. SET BY HAND (issue #428, "about
 * 2 px"). A fitted field in an editor pane is well above it; a small preview is below it.
 */
export const TAB_MIN_PX = 2;

/** Each profile's corners, worked out once: the static layer is redrawn on every frame of a pan. */
const outlines = new WeakMap<TileSeamProfile, readonly SeamCorner[]>();

function outlineOf(profile: TileSeamProfile): readonly SeamCorner[] {
  let outline = outlines.get(profile);
  if (outline === undefined) {
    outline = tileSeamOutline(profile);
    outlines.set(profile, outline);
  }
  return outline;
}

/** The scale from the profile's tile to the field's: the manual's nominal 24 in over the CAD's edge. */
const seamScale = (profile: TileSeamProfile, seamIn: number): number => seamIn / profile.edgeIn;

/** Whether the seams draw their tabs at this zoom: a tab's depth on screen of at least `TAB_MIN_PX`. */
export function drawsTabs(profile: TileSeamProfile | undefined, seamIn: number, pxPerIn: number): profile is TileSeamProfile {
  return profile !== undefined && profile.depthIn * seamScale(profile, seamIn) * pxPerIn >= TAB_MIN_PX;
}

/**
 * One seam inside the wall, from `fromIn` to `toIn` along it, as one stroked path through the tab
 * edge of every tile it passes (`tileSeam.ts`). `place` puts a point given along the seam and across
 * it, to the left of the way it runs, on the field. The line's corners are put on whole pixels
 * across the seam, its centre line on a pixel's middle like a hairline's, so the tabs' ends and the
 * slots' bottoms draw as crisp 1 px lines, never as 2 px smears. A seam that does not start or end
 * on a tile crossing (a field not a whole number of tiles wide) is straight past its last crossing.
 */
function drawTabbedSeam(
  ctx: CanvasRenderingContext2D,
  view: View,
  profile: TileSeamProfile,
  seamIn: number,
  fromIn: number,
  toIn: number,
  place: (alongIn: number, acrossIn: number) => Vec2,
): void {
  const a = worldToScreen(view, place(fromIn, 0));
  const b = worldToScreen(view, place(toIn, 0));
  const firstIn = Math.ceil(fromIn / seamIn - 1e-9) * seamIn;
  const lastIn = Math.floor(toIn / seamIn + 1e-9) * seamIn;
  if (lastIn - firstIn < seamIn - 1e-6) {
    hairline(ctx, a, b);
    return;
  }
  const scale = seamScale(profile, seamIn);
  const corners = outlineOf(profile);
  const points: { at: Vec2; rounded: boolean }[] = [];
  if (firstIn > fromIn + 1e-6) points.push({ at: place(fromIn, 0), rounded: false });
  for (let startIn = firstIn; startIn + seamIn <= lastIn + 1e-6; startIn += seamIn) {
    for (const [index, corner] of corners.entries()) {
      if (index === 0 && points.length > 0) continue;
      points.push({ at: place(startIn + corner.alongIn * scale, corner.acrossIn * scale), rounded: corner.filletIn > 0 });
    }
  }
  if (lastIn < toIn - 1e-6) points.push({ at: place(toIn, 0), rounded: false });

  const vertical = Math.abs(a.xPx - b.xPx) < 0.5;
  const horizontal = Math.abs(a.yPx - b.yPx) < 0.5;
  const screen = points.map(({ at, rounded }) => {
    const p = worldToScreen(view, at);
    if (vertical) return { xPx: crisp(a.xPx) + Math.round(p.xPx - a.xPx), yPx: p.yPx, rounded };
    if (horizontal) return { xPx: p.xPx, yPx: crisp(a.yPx) + Math.round(p.yPx - a.yPx), rounded };
    return { ...p, rounded };
  });
  const radiusPx = profile.filletRadiusIn * scale * view.pxPerIn;
  ctx.beginPath();
  for (const [index, p] of screen.entries()) {
    const next = screen[index + 1];
    if (index === 0) ctx.moveTo(p.xPx, p.yPx);
    else if (p.rounded && next !== undefined) ctx.arcTo(p.xPx, p.yPx, next.xPx, next.yPx, radiusPx);
    else ctx.lineTo(p.xPx, p.yPx);
  }
  ctx.stroke();
}

/**
 * The 24 in seams with the tiles' interlocking tabs (issue #428): every seam inside the wall, the
 * centre lines too, is one path through the tab edge; the seams on the wall, where the tiles are cut
 * straight, stay hairlines. The lines run west to east and south to north, x seams first, the
 * order `drawSeries` draws the straight ones in.
 */
function drawTabbedSeams(ctx: CanvasRenderingContext2D, input: StaticLayerInput, bounds: Box2, seamIn: number, profile: TileSeamProfile): void {
  const { view } = input;
  ctx.strokeStyle = input.theme.gridMajor;
  const startX = Math.ceil(bounds.minXIn / seamIn) * seamIn;
  for (let xIn = startX; xIn <= bounds.maxXIn + 1e-6; xIn += seamIn) {
    if (onWall(xIn, bounds.minXIn, bounds.maxXIn)) hairline(ctx, point(view, xIn, bounds.minYIn), point(view, xIn, bounds.maxYIn));
    // Running south to north, the left is west.
    else drawTabbedSeam(ctx, view, profile, seamIn, bounds.minYIn, bounds.maxYIn, (alongIn, acrossIn) => ({ xIn: xIn - acrossIn, yIn: alongIn }));
  }
  const startY = Math.ceil(bounds.minYIn / seamIn) * seamIn;
  for (let yIn = startY; yIn <= bounds.maxYIn + 1e-6; yIn += seamIn) {
    if (onWall(yIn, bounds.minYIn, bounds.maxYIn)) hairline(ctx, point(view, bounds.minXIn, yIn), point(view, bounds.maxXIn, yIn));
    // Running west to east, the left is north.
    else drawTabbedSeam(ctx, view, profile, seamIn, bounds.minXIn, bounds.maxXIn, (alongIn, acrossIn) => ({ xIn: alongIn, yIn: yIn + acrossIn }));
  }
}

/**
 * Layer 2: the grid, as far as the Grid setting draws it (spec 15 section 10). The finer lines come
 * first and the 24 in seams over them, as the field has always been drawn, so where a finer line
 * crosses a seam the seam's pixel wins. The seams carry the tiles' tabs (`drawTabbedSeams`) unless a
 * tab would be under `TAB_MIN_PX` or the season has no tile edge, and then they are the straight
 * lines of before, which skip the centre lines: zoomed that far out the 12 in choice is pixel for
 * pixel the field of before the Grid setting. The axis is last, a straight line over the centre
 * seams. Off draws none of it. The finer lines use `gridMinor`, the seams `gridMajor`.
 */
function drawGrid(ctx: CanvasRenderingContext2D, input: StaticLayerInput, bounds: Box2, drawing: FieldDrawing | null): void {
  const spacings = gridLineSpacingsIn(input.fieldGrid ?? "tiles");
  if (spacings === null) return;
  const { view, theme } = input;
  ctx.lineWidth = 1;

  if (spacings.lineIn !== null && view.pxPerIn * spacings.lineIn >= MINOR_MIN_PX) {
    drawSeries(ctx, input, bounds, spacings.lineIn, theme.gridMinor, true);
  }
  const profile = drawing?.tileSeam;
  if (drawsTabs(profile, spacings.seamIn, view.pxPerIn)) drawTabbedSeams(ctx, input, bounds, spacings.seamIn, profile);
  else drawSeries(ctx, input, bounds, spacings.seamIn, theme.gridMajor, false);

  ctx.strokeStyle = theme.gridAxis;
  hairline(ctx, point(view, 0, bounds.minYIn), point(view, 0, bounds.maxYIn));
  hairline(ctx, point(view, bounds.minXIn, 0), point(view, bounds.maxXIn, 0));
}

/** Diagonal hatching inside the current path, at 45 degrees, clipped to it. */
function hatch(ctx: CanvasRenderingContext2D, box: Box2, view: View, colour: string): void {
  const corners = boxCornersIn(box).map((corner) => worldToScreen(view, corner));
  const minX = Math.min(...corners.map((c) => c.xPx));
  const maxX = Math.max(...corners.map((c) => c.xPx));
  const minY = Math.min(...corners.map((c) => c.yPx));
  const maxY = Math.max(...corners.map((c) => c.yPx));
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const span = maxX - minX + (maxY - minY);
  for (let offset = 0; offset <= span; offset += 8) {
    ctx.moveTo(minX + offset, minY);
    ctx.lineTo(minX + offset - (maxY - minY), maxY);
  }
  ctx.stroke();
  ctx.restore();
}

const allianceInk = (theme: CanvasTheme, alliance: DrawingAlliance): string =>
  alliance === "RED" ? theme.allianceRed : theme.allianceBlue;

/** True when the line `valueIn` lies on one of the perimeter's sides along the same axis. */
const onWall = (valueIn: number, minIn: number, maxIn: number): boolean =>
  Math.abs(valueIn - minIn) < 0.01 || Math.abs(valueIn - maxIn) < 0.01;

/**
 * A taped rectangle: a faint fill in the alliance's colour and a strip of tape along every side
 * that is not on the wall (the wall is the fourth side, untaped). Outlines only, over a picture.
 */
function drawTapedRect(
  ctx: CanvasRenderingContext2D,
  input: StaticLayerInput,
  rect: DrawingRect,
  ink: string,
  tapeIn: number,
  fillAlpha: number,
): void {
  const { view } = input;
  const bounds = fieldBounds(input.field);
  traceBox(ctx, view, rect);
  if (input.mode === "outlines") {
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.stroke();
    return;
  }
  ctx.fillStyle = ink;
  ctx.globalAlpha = fillAlpha;
  ctx.fill();
  ctx.globalAlpha = 1;
  const strips: Box2[] = [];
  if (!onWall(rect.minXIn, bounds.minXIn, bounds.maxXIn)) strips.push({ ...rect, maxXIn: rect.minXIn + tapeIn });
  if (!onWall(rect.maxXIn, bounds.minXIn, bounds.maxXIn)) strips.push({ ...rect, minXIn: rect.maxXIn - tapeIn });
  if (!onWall(rect.minYIn, bounds.minYIn, bounds.maxYIn)) strips.push({ ...rect, maxYIn: rect.minYIn + tapeIn });
  if (!onWall(rect.maxYIn, bounds.minYIn, bounds.maxYIn)) strips.push({ ...rect, minYIn: rect.maxYIn - tapeIn });
  ctx.fillStyle = ink;
  for (const strip of strips) {
    traceBox(ctx, view, strip);
    ctx.fill();
  }
}

function drawZones(
  ctx: CanvasRenderingContext2D,
  input: StaticLayerInput,
  zones: readonly Zone[],
  drawing: FieldDrawing | null,
): void {
  const { view, theme } = input;
  const outlines = input.mode === "outlines";
  for (const zone of zones) {
    // A zone the season tapes in an alliance's colour is drawn as the tape on the floor.
    const alliance = drawing?.tapedZones[zone.id];
    if (alliance !== undefined && drawing !== null) {
      drawTapedRect(ctx, input, zone, allianceInk(theme, alliance), drawing.tapeWidthIn, 0.14);
      continue;
    }
    if (!outlines) {
      traceBox(ctx, view, zone);
      ctx.fillStyle = theme.fieldZoneFill;
      ctx.fill();
      hatch(ctx, zone, view, theme.fieldZoneFill);
    }
    traceBox(ctx, view, zone);
    ctx.strokeStyle = theme.fieldZone;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** The gardens: a band of solid tape in the alliance's colour, closed by the walls at the corner. */
function drawGardens(ctx: CanvasRenderingContext2D, input: StaticLayerInput, drawing: FieldDrawing): void {
  for (const garden of drawing.gardens) {
    const ink = allianceInk(input.theme, garden.alliance);
    traceBox(ctx, input.view, garden);
    if (input.mode === "outlines") {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillStyle = ink;
      ctx.fill();
    }
  }
}

/** The axle both hives turn on, high overhead: dashed, so it never reads as something to hit. */
function drawHiveAxle(ctx: CanvasRenderingContext2D, input: StaticLayerInput, drawing: FieldDrawing): void {
  const { view, theme } = input;
  const axle = drawing.hiveAxle;
  ctx.strokeStyle = theme.fieldObstacle;
  ctx.lineWidth = Math.max(1, Math.min(3, view.pxPerIn * 0.5));
  ctx.setLineDash([6, 4]);
  line(ctx, point(view, axle.fromXIn, axle.yIn), point(view, axle.toXIn, axle.yIn));
  ctx.setLineDash([]);
}

/**
 * The perimeter wall, as a schematic band just outside the field's edge (no public drawing gives the
 * wall's thickness, so it is a width on screen, not a dimension).
 */
function drawWall(ctx: CanvasRenderingContext2D, input: StaticLayerInput, bounds: Box2): void {
  const { view, theme } = input;
  const corners = boxCornersIn(bounds).map((corner) => worldToScreen(view, corner));
  const minX = Math.min(...corners.map((c) => c.xPx));
  const maxX = Math.max(...corners.map((c) => c.xPx));
  const minY = Math.min(...corners.map((c) => c.yPx));
  const maxY = Math.max(...corners.map((c) => c.yPx));
  const widthPx = Math.max(2, Math.min(5, Math.round(view.pxPerIn)));
  ctx.strokeStyle = theme.fieldObstacle;
  ctx.lineWidth = widthPx;
  ctx.strokeRect(minX - widthPx / 2, minY - widthPx / 2, maxX - minX + widthPx, maxY - minY + widthPx);
}

function drawObstacles(
  ctx: CanvasRenderingContext2D,
  input: StaticLayerInput,
  obstacles: readonly Obstacle[],
): void {
  const { view, theme } = input;
  for (const obstacle of obstacles) {
    // A strut, a slanted leg of the hive frame, is drawn over the hives (`structureLayer.ts`).
    if (obstacle.kind !== "box") continue;
    // An obstacle whose underside clears the robot is something to drive beneath, not a wall, so it
    // is drawn as an outline only, and only while overhead outlines are shown. Anything the
    // footprint can reach is filled opaque.
    const overhead = obstacle.minZIn >= input.robotHeightIn;
    if (overhead && input.overheadOutlines === false) continue;
    traceBox(ctx, view, obstacle);
    if (overhead || input.mode === "outlines") {
      ctx.strokeStyle = theme.fieldObstacle;
      ctx.lineWidth = 1;
      if (overhead) ctx.setLineDash([2, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = theme.fieldObstacleFill;
      ctx.fill();
      ctx.strokeStyle = theme.fieldObstacle;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

const numberProp = (source: Record<string, unknown>, key: string): number | null => {
  const value = source[key];
  return typeof value === "number" ? value : null;
};

const stringProp = (source: Record<string, unknown>, key: string): string | null => {
  const value = source[key];
  return typeof value === "string" ? value : null;
};

function elementCentre(element: FieldElement): Vec2 | null {
  if (element.xIn !== undefined && element.yIn !== undefined) {
    return { xIn: element.xIn, yIn: element.yIn };
  }
  const pivot = (element as unknown as Record<string, unknown>)["pivotIn"];
  if (typeof pivot === "object" && pivot !== null) {
    const record = pivot as Record<string, unknown>;
    const xIn = numberProp(record, "xIn");
    const yIn = numberProp(record, "yIn");
    if (xIn !== null && yIn !== null) return { xIn, yIn };
  }
  return null;
}

/** The radius of the hole a container's top target names (a flower's top ring), if any. */
function holeRadiusIn(element: FieldElement, targets: readonly FieldTarget[]): number | null {
  for (const target of targets) {
    const record = target as unknown as Record<string, unknown>;
    if (stringProp(record, "element") !== element.id) continue;
    const radiusIn = numberProp(record, "radiusIn");
    if (radiusIn !== null && radiusIn > 0) return radiusIn;
  }
  return null;
}

/** Each alliance's nectar kind, from what the season's hives hold, for the piece colours. */
function nectarKinds(field: StaticLayerInput["field"], drawing: FieldDrawing | null): NectarKinds {
  const kinds: { RED: string | null; BLUE: string | null } = { RED: null, BLUE: null };
  for (const hive of drawing?.hives ?? []) {
    const element = (field.elements ?? []).find((candidate) => candidate.id === hive.element);
    kinds[hive.alliance] = element?.holds?.find((kind) => kind.startsWith("nectar")) ?? null;
  }
  return kinds;
}

function drawElements(ctx: CanvasRenderingContext2D, input: StaticLayerInput, drawing: FieldDrawing | null): void {
  const { view, theme, field } = input;
  const nectar = nectarKinds(field, drawing);
  ctx.lineWidth = 1;
  for (const element of field.elements ?? []) {
    const centre = elementCentre(element);
    if (centre === null) continue;
    const screen = worldToScreen(view, centre);

    if (element.container === "hive") {
      // A hive the season draws moves, so hiveLayer.ts draws it over this layer; others get a pivot.
      if (drawing?.hives.some((hive) => hive.element === element.id) !== true) drawHivePivot(ctx, view, theme, element);
      continue;
    }

    if (element.container !== null && element.container !== undefined) {
      // A container the robot collects from (a flower): its top ring, as the field file sizes it.
      const radiusIn = holeRadiusIn(element, field.targets ?? []) ?? 3;
      ctx.beginPath();
      ctx.arc(screen.xPx, screen.yPx, Math.max(3, radiusIn * view.pxPerIn), 0, Math.PI * 2);
      if (input.mode !== "outlines") {
        ctx.fillStyle = theme.fieldElementFill;
        ctx.fill();
      }
      ctx.strokeStyle = theme.fieldElement;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
      continue;
    }

    // A staged piece, in the colour every piece on the field takes (`pieceColours.ts`).
    const radiusIn = element.radiusIn ?? 1.4;
    const ink = pieceInk(theme, element.kind, nectar);
    ctx.beginPath();
    ctx.arc(screen.xPx, screen.yPx, Math.max(1.5, radiusIn * view.pxPerIn), 0, Math.PI * 2);
    if (input.mode !== "outlines") {
      ctx.fillStyle = ink;
      ctx.fill();
    }
    ctx.strokeStyle = input.mode === "outlines" ? ink : pieceEdge(theme);
    ctx.stroke();
  }
}

export function drawWaypoints(ctx: CanvasRenderingContext2D, input: StaticLayerInput): void {
  const { view, theme, waypoints } = input;
  if (waypoints === null) return;
  const hidden = input.hiddenWaypoints;
  const labels = pinLabelBoxes(waypoints, view, input.selectedWaypoint, hidden);
  for (const [name, waypoint] of Object.entries(waypoints.waypoints)) {
    if (hidden?.has(name) === true) continue;
    const screen = worldToScreen(view, waypoint);
    ctx.strokeStyle = theme.fieldWaypoint;
    ctx.lineWidth = 1;
    // A pin: a small ring on the pose with a stem, so the name never covers the point itself.
    ctx.beginPath();
    ctx.arc(screen.xPx, screen.yPx, 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(screen.xPx, screen.yPx - 3);
    ctx.lineTo(screen.xPx, screen.yPx - PIN_STEM_PX);
    ctx.stroke();
  }
  if (labels.size === 0) return;
  // Pin names are bold italic in the waypoint colour with a halo in the floor colour, which the step
  // names (plain, text-mid) are not, so 'scoreSouth' beside a step's name does not read as a step.
  ctx.font = `italic 600 11px ${theme.fontMono}`;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  for (const [name, box] of labels) {
    if (hidden?.has(name) === true) continue;
    const x = box.x0Px + 1;
    const y = (box.y0Px + box.y1Px) / 2;
    ctx.strokeStyle = theme.fieldFloor;
    ctx.strokeText(name, x, y);
    ctx.fillStyle = theme.fieldWaypoint;
    ctx.fillText(name, x, y);
  }
}

/** Paint the whole static layer into a context already sized and scaled to CSS pixels. */
export function drawStatic(ctx: CanvasRenderingContext2D, input: StaticLayerInput): void {
  const { field, view, theme } = input;
  const bounds = fieldBounds(field);
  const drawing = drawingFor(field);
  const outlines = input.mode === "outlines";

  if (!outlines) {
    ctx.clearRect(0, 0, input.widthPx, input.heightPx);
    ctx.fillStyle = theme.bgCanvas;
    ctx.fillRect(0, 0, input.widthPx, input.heightPx);
    for (const area of drawing?.allianceAreas ?? []) {
      drawTapedRect(ctx, input, area, allianceInk(theme, area.alliance), drawing?.tapeWidthIn ?? 1, 0.05);
    }
    drawFloor(ctx, input, bounds);
    drawGrid(ctx, input, bounds, drawing);
  }

  drawZones(ctx, input, field.zones ?? [], drawing);
  if (drawing !== null) drawGardens(ctx, input, drawing);
  // A hive's envelope is drawn as the hive's body, so it is not drawn again as a plain box.
  const envelopes = new Set(drawing?.hives.map((hive) => hive.envelope) ?? []);
  drawObstacles(ctx, input, (field.obstacles ?? []).filter((obstacle) => !envelopes.has(obstacle.id)));
  if (drawing !== null && input.overheadOutlines !== false) drawHiveAxle(ctx, input, drawing);
  drawElements(ctx, input, drawing);
  drawWaypoints(ctx, input);

  if (outlines) {
    traceBox(ctx, view, bounds);
    ctx.strokeStyle = theme.gridAxis;
    ctx.lineWidth = 1;
    ctx.stroke();
  } else {
    drawWall(ctx, input, bounds);
  }
}

/**
 * The field picture, mapped by `field.image` onto the perimeter (`fieldImage.ts`), over the canvas
 * ground. The image-pixel to screen-pixel map is one affine transform composed on top of the CSS
 * pixel scale the static canvas already carries.
 */
export function drawFieldImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  spec: FieldImageSpec,
  input: StaticLayerInput,
): void {
  const bounds = fieldBounds(input.field);
  ctx.clearRect(0, 0, input.widthPx, input.heightPx);
  ctx.fillStyle = input.theme.bgCanvas;
  ctx.fillRect(0, 0, input.widthPx, input.heightPx);
  const m = imageToScreen(spec, image.naturalWidth, image.naturalHeight, bounds, (world) =>
    worldToScreen(input.view, world),
  );
  const box = pixelBox(spec, image.naturalWidth, image.naturalHeight);
  const widthPx = box.right - box.left;
  const heightPx = box.bottom - box.top;
  ctx.save();
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, box.left, box.top, widthPx, heightPx, box.left, box.top, widthPx, heightPx);
  ctx.restore();
}

/** Only the perimeter, for the "image" view: the picture carries the rest. */
export function drawPerimeter(ctx: CanvasRenderingContext2D, input: StaticLayerInput): void {
  traceBox(ctx, input.view, fieldBounds(input.field));
  ctx.strokeStyle = input.theme.gridAxis;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/**
 * Draw a rasterised `core.render` SVG over the field's own rectangle. The image carries the whole
 * field, so it is mapped onto the screen box the perimeter occupies.
 */
export function drawStaticImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  input: StaticLayerInput,
): void {
  const bounds = fieldBounds(input.field);
  const corners = boxCornersIn(bounds).map((corner) => worldToScreen(input.view, corner));
  const minX = Math.min(...corners.map((c) => c.xPx));
  const maxX = Math.max(...corners.map((c) => c.xPx));
  const minY = Math.min(...corners.map((c) => c.yPx));
  const maxY = Math.max(...corners.map((c) => c.yPx));
  ctx.clearRect(0, 0, input.widthPx, input.heightPx);
  ctx.fillStyle = input.theme.bgCanvas;
  ctx.fillRect(0, 0, input.widthPx, input.heightPx);
  ctx.drawImage(image, minX, minY, maxX - minX, maxY - minY);
}
