/**
 * The static layer: the field itself. Redrawn only when the document, the view, the size or the
 * theme changes, into an offscreen canvas that a drag frame simply blits, so nothing here ever runs
 * while an endpoint is being dragged.
 *
 * When the shell passes `staticSvg` (from `core.render`) that is rasterised and
 * used instead; this drawing is what the canvas falls back to until M1 lands that function, and it
 * reads the same `field.json` vector geometry the renderer will.
 *
 * Style follows UI_GUIDE section 4: static field furniture is warm or neutral, authored geometry is
 * cool, which is why a path never disappears into the field under it.
 */
import { fieldBounds, type Box2, type Vec2 } from "@horizon36596/zenith-core";
import type { Field, FieldElement, FieldTarget, Obstacle, Waypoints, Zone } from "@horizon36596/zenith-schema";
import { imageToScreen, pixelBox, type FieldImageSpec } from "./fieldImage.js";
import type { CanvasTheme } from "./theme.js";
import { worldToScreen, type View } from "./view.js";

/** Grid spacings, in inches: FTC tiles are 24 in and the minor line splits one in half. */
const MAJOR_IN = 24;
const MINOR_IN = 12;
/** UI_GUIDE section 8.8: minor lines drop out below 2.5 px per 12 in rather than moire. */
const MINOR_MIN_PX = 2.5;

export interface StaticLayerInput {
  field: Field;
  waypoints: Waypoints | null;
  /** Obstacles whose underside clears this are drawn as overhead, not as walls. */
  robotHeightIn: number;
  view: View;
  theme: CanvasTheme;
  widthPx: number;
  heightPx: number;
  /**
   * "outlines" draws the vector field as strokes only, with no background, grid or fills, over the
   * field picture (site/docs/editor.md, "image + outlines"). Absent means the full vector field.
   */
  mode?: "vector" | "outlines";
}

/** Waypoint names are hidden at a fitted zoom (UI_GUIDE 9.11) and appear once zoomed well in. */
const WAYPOINT_LABEL_MIN_PX_PER_IN = 8;

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

function drawGrid(ctx: CanvasRenderingContext2D, input: StaticLayerInput, bounds: Box2): void {
  const { view, theme } = input;
  ctx.lineWidth = 1;

  const drawSeries = (stepIn: number, colour: string, skipMajor: boolean): void => {
    ctx.strokeStyle = colour;
    const startX = Math.ceil(bounds.minXIn / stepIn) * stepIn;
    for (let xIn = startX; xIn <= bounds.maxXIn + 1e-6; xIn += stepIn) {
      if (Math.abs(xIn) < 1e-6) continue;
      if (skipMajor && Math.abs(xIn % MAJOR_IN) < 1e-6) continue;
      hairline(ctx, point(view, xIn, bounds.minYIn), point(view, xIn, bounds.maxYIn));
    }
    const startY = Math.ceil(bounds.minYIn / stepIn) * stepIn;
    for (let yIn = startY; yIn <= bounds.maxYIn + 1e-6; yIn += stepIn) {
      if (Math.abs(yIn) < 1e-6) continue;
      if (skipMajor && Math.abs(yIn % MAJOR_IN) < 1e-6) continue;
      hairline(ctx, point(view, bounds.minXIn, yIn), point(view, bounds.maxXIn, yIn));
    }
  };

  if (view.pxPerIn * MINOR_IN >= MINOR_MIN_PX) drawSeries(MINOR_IN, theme.gridMinor, true);
  drawSeries(MAJOR_IN, theme.gridMajor, false);

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

function drawZones(ctx: CanvasRenderingContext2D, input: StaticLayerInput, zones: readonly Zone[]): void {
  const { view, theme } = input;
  const outlines = input.mode === "outlines";
  for (const zone of zones) {
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

function drawObstacles(
  ctx: CanvasRenderingContext2D,
  input: StaticLayerInput,
  obstacles: readonly Obstacle[],
): void {
  const { view, theme } = input;
  for (const obstacle of obstacles) {
    // An obstacle whose underside clears the robot is something to drive beneath, not a wall, so it
    // is drawn as an outline only. Anything the footprint can reach is filled opaque.
    const overhead = obstacle.minZIn >= input.robotHeightIn;
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

const UP_SIDE_DIRECTION: Readonly<Record<string, Vec2>> = {
  NORTH: { xIn: 0, yIn: 1 },
  SOUTH: { xIn: 0, yIn: -1 },
  EAST: { xIn: 1, yIn: 0 },
  WEST: { xIn: -1, yIn: 0 },
};

function drawElements(
  ctx: CanvasRenderingContext2D,
  input: StaticLayerInput,
  elements: readonly FieldElement[],
): void {
  const { view, theme } = input;
  ctx.lineWidth = 1;
  for (const element of elements) {
    const centre = elementCentre(element);
    if (centre === null) continue;
    const screen = worldToScreen(view, centre);
    const record = element as unknown as Record<string, unknown>;

    if (element.container === "hive") {
      // The hive: its pivot, and a tick to the side whose cell is up.
      const radiusPx = Math.max(4, 3 * view.pxPerIn);
      ctx.strokeStyle = theme.fieldTarget;
      ctx.beginPath();
      ctx.arc(screen.xPx, screen.yPx, radiusPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(screen.xPx - 3, screen.yPx);
      ctx.lineTo(screen.xPx + 3, screen.yPx);
      ctx.moveTo(screen.xPx, screen.yPx - 3);
      ctx.lineTo(screen.xPx, screen.yPx + 3);
      ctx.stroke();
      const up = UP_SIDE_DIRECTION[stringProp(record, "upSide") ?? ""];
      if (up !== undefined) {
        const tip = worldToScreen(view, { xIn: centre.xIn + up.xIn * 9, yIn: centre.yIn + up.yIn * 9 });
        ctx.strokeStyle = theme.fieldTarget;
        ctx.lineWidth = 2;
        line(ctx, screen, tip);
        ctx.lineWidth = 1;
      }
      continue;
    }

    if (element.container !== null && element.container !== undefined) {
      // A container the robot collects from: a filled rose disc with its opening ring.
      const radiusPx = Math.max(3, 3 * view.pxPerIn);
      ctx.beginPath();
      ctx.arc(screen.xPx, screen.yPx, radiusPx, 0, Math.PI * 2);
      if (input.mode !== "outlines") {
        ctx.fillStyle = theme.fieldElementFill;
        ctx.fill();
      }
      ctx.strokeStyle = theme.fieldElement;
      ctx.stroke();
      continue;
    }

    const radiusIn = element.radiusIn ?? 1.4;
    ctx.beginPath();
    ctx.arc(screen.xPx, screen.yPx, Math.max(1.5, radiusIn * view.pxPerIn), 0, Math.PI * 2);
    if (input.mode !== "outlines") {
      ctx.fillStyle = theme.fieldElementFill;
      ctx.fill();
    }
    ctx.strokeStyle = theme.fieldElement;
    ctx.stroke();
  }
}

function targetCentre(target: FieldTarget, elements: readonly FieldElement[]): Vec2 | null {
  const record = target as unknown as Record<string, unknown>;
  const ownX = numberProp(record, "xIn");
  const ownY = numberProp(record, "yIn");
  if (ownX !== null && ownY !== null) return { xIn: ownX, yIn: ownY };
  const ref = stringProp(record, "element") ?? stringProp(record, "hive");
  if (ref === null) return null;
  const element = elements.find((candidate) => candidate.id === ref);
  return element === undefined ? null : elementCentre(element);
}

function drawTargets(
  ctx: CanvasRenderingContext2D,
  input: StaticLayerInput,
  targets: readonly FieldTarget[],
  elements: readonly FieldElement[],
): void {
  const { view, theme } = input;
  ctx.strokeStyle = theme.fieldTarget;
  ctx.lineWidth = 1;
  for (const target of targets) {
    const centre = targetCentre(target, elements);
    if (centre === null) continue;
    const screen = worldToScreen(view, centre);
    // A reticle: two rings and four ticks, so a scoring target reads differently from an element.
    for (const radiusPx of [5, 9]) {
      ctx.beginPath();
      ctx.arc(screen.xPx, screen.yPx, radiusPx, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(screen.xPx - 12, screen.yPx);
    ctx.lineTo(screen.xPx - 9, screen.yPx);
    ctx.moveTo(screen.xPx + 9, screen.yPx);
    ctx.lineTo(screen.xPx + 12, screen.yPx);
    ctx.moveTo(screen.xPx, screen.yPx - 12);
    ctx.lineTo(screen.xPx, screen.yPx - 9);
    ctx.moveTo(screen.xPx, screen.yPx + 9);
    ctx.lineTo(screen.xPx, screen.yPx + 12);
    ctx.stroke();
  }
}

function drawWaypoints(ctx: CanvasRenderingContext2D, input: StaticLayerInput): void {
  const { view, theme, waypoints } = input;
  if (waypoints === null) return;
  ctx.font = `11px ${theme.fontMono}`;
  ctx.textBaseline = "middle";
  for (const [name, waypoint] of Object.entries(waypoints.waypoints)) {
    const screen = worldToScreen(view, waypoint);
    ctx.fillStyle = theme.fieldWaypoint;
    ctx.strokeStyle = theme.fieldWaypoint;
    ctx.lineWidth = 1;
    // A pin: a small ring on the pose with a stem, so the name never covers the point itself.
    ctx.beginPath();
    ctx.arc(screen.xPx, screen.yPx, 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(screen.xPx, screen.yPx - 3);
    ctx.lineTo(screen.xPx, screen.yPx - 9);
    ctx.stroke();
    if (view.pxPerIn >= WAYPOINT_LABEL_MIN_PX_PER_IN) ctx.fillText(name, screen.xPx + 6, screen.yPx - 10);
  }
}

/** Paint the whole static layer into a context already sized and scaled to CSS pixels. */
export function drawStatic(ctx: CanvasRenderingContext2D, input: StaticLayerInput): void {
  const { field, view, theme } = input;
  const bounds = fieldBounds(field);

  if (input.mode !== "outlines") {
    ctx.clearRect(0, 0, input.widthPx, input.heightPx);
    ctx.fillStyle = theme.bgCanvas;
    ctx.fillRect(0, 0, input.widthPx, input.heightPx);
    drawGrid(ctx, input, bounds);
  }

  drawZones(ctx, input, field.zones ?? []);
  drawObstacles(ctx, input, field.obstacles ?? []);
  drawElements(ctx, input, field.elements ?? []);
  drawTargets(ctx, input, field.targets ?? [], field.elements ?? []);
  drawWaypoints(ctx, input);

  traceBox(ctx, view, bounds);
  ctx.strokeStyle = theme.gridAxis;
  ctx.lineWidth = input.mode === "outlines" ? 1 : 2;
  ctx.stroke();
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
