import type { Field, FieldElement, FieldTarget, Step, Waypoints } from "@horizon36596/zenith-schema";
import { markerT } from "./checks/intake.js";
import { fieldBounds } from "./footprint.js";
import { totalBound } from "./estimate.js";
import type { Vec2 } from "./geometry/vec.js";
import { robotHeightIn } from "./kinematics.js";
import { mirrorForField, mirrorHeadingRad, mirrorVec, shouldMirror } from "./mirror.js";
import { ALPHA, FONTS, severityColour, TOKENS } from "./tokens.js";
import type {
  Estimate,
  Finding,
  LedgerRow,
  Plan,
  PlanSample,
  PlanStep,
  RenderOptions,
} from "./types.js";

/**
 * `render`: one SVG string that the pull
 * request, the CLI's `--png` and the editor's static layer all share.
 *
 * Frame: `field.json` says the audience is at the bottom and +Y runs away from them, so the
 * drawing flips Y. Everything is in field inches until the last moment, where `at()` turns a point
 * into pixels.
 *
 * Colours are the literal hex of `tokens.ts`, not CSS custom properties, because an SVG that is
 * rasterised has no stylesheet to read them from.
 */

/** How far apart the footprint ghosts are in seconds of estimated time; density shows speed. */
export const GHOST_EVERY_S = 0.5;

/** How far apart they are in inches when there is no estimate to place them by. */
export const GHOST_EVERY_IN = 12;

const LEDGER_WIDTH_PX = 300;
const MARGIN_PX = 16;
const HEADER_PX = 34;

/** Two decimals, no exponent and no minus zero, so the same plan always writes the same bytes. */
const n = (value: number): string => {
  const rounded = Number(value.toFixed(2));
  return String(rounded === 0 ? 0 : rounded);
};

const escapeText = (value: string): string =>
  value
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;");

interface Frame {
  /** Field inches to pixels. */
  scale: number;
  at(point: Vec2): { x: number; y: number };
  fieldWidthPx: number;
  fieldHeightPx: number;
}

export function render(
  plan: Plan,
  estimateResult: Estimate | null,
  findings: readonly Finding[],
  ledgerRows: readonly LedgerRow[],
  options: RenderOptions = {},
): string {
  const field = plan.field;
  const bounds = fieldBounds(field);
  const fieldWidthIn = bounds.maxXIn - bounds.minXIn;
  const fieldHeightIn = bounds.maxYIn - bounds.minYIn;

  const showLedger = options.showLedger === true && ledgerRows.length > 0;
  const fieldPx = options.widthPx ?? 720;
  const scale = fieldPx / fieldWidthIn;
  const fieldHeightPx = fieldHeightIn * scale;

  // A file's poses are in its own alliance's frame, so the routine is mirrored only when it is viewed
  // as the other alliance, by the symmetry the field declares. `shouldMirror`/`mirrorForField` are
  // the shared rule: the editor's canvas asks the same two questions of the same two files and gets
  // the same answer, and both agree with the robot runtime. The field itself is never mirrored.
  const view = options.alliance ?? plan.auto.alliance;
  const mode = mirrorForField(field);
  const mirrorFor = (auto: Plan["auto"]): ((p: Vec2) => Vec2) =>
    shouldMirror(auto, field, view) ? (p) => mirrorVec(p, mode) : (p) => p;
  const mirrored = shouldMirror(plan.auto, field, view);
  const point = mirrorFor(plan.auto);
  const heading = (h: number): number => (mirrored ? mirrorHeadingRad(h, mode) : h);

  const frame: Frame = {
    scale,
    fieldWidthPx: fieldPx,
    fieldHeightPx,
    // +Y is up on screen because the audience is at the bottom, so the y axis is flipped here and
    // nowhere else.
    at: (p) => ({
      x: MARGIN_PX + (p.xIn - bounds.minXIn) * scale,
      y: HEADER_PX + (bounds.maxYIn - p.yIn) * scale,
    }),
  };

  const widthPx = MARGIN_PX * 2 + fieldPx + (showLedger ? LEDGER_WIDTH_PX : 0);
  const heightPx = options.heightPx ?? HEADER_PX + fieldHeightPx + MARGIN_PX;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(widthPx)}" height="${n(heightPx)}" viewBox="0 0 ${n(widthPx)} ${n(heightPx)}" font-family="${FONTS.ui}">`,
  );
  parts.push(`<rect width="${n(widthPx)}" height="${n(heightPx)}" fill="${TOKENS.bgCanvas}"/>`);
  parts.push(...drawHeader(plan, estimateResult, findings, widthPx, options));
  parts.push(...drawField(field, plan, frame, point, options));
  // The base version is in its own file's frame, which is not this one's when the change flipped
  // the alliance, so it is drawn for the same view by its own mirror.
  if (options.base !== undefined) parts.push(...drawBase(options.base, frame, mirrorFor(options.base.auto)));
  parts.push(...drawFindings(plan, findings, frame, point, options));
  parts.push(...drawPaths(plan, frame, point));
  parts.push(...drawGhosts(plan, estimateResult, frame, point, heading, options));
  parts.push(...drawMarkers(plan, frame, point));
  if (showLedger) {
    parts.push(...drawLedger(ledgerRows, MARGIN_PX + fieldPx, heightPx));
  }
  parts.push("</svg>");
  return `${parts.join("\n")}\n`;
}

/** The header's suffix for a total that is a bound (see `totalBound`). */
function boundSuffix(estimateResult: Estimate): string {
  const bound = totalBound(estimateResult);
  return bound === "lower" ? " at least" : bound === "upper" ? " at most" : "";
}

/** The title bar: the routine's name, its estimate and how many findings it has. */
function drawHeader(
  plan: Plan,
  estimateResult: Estimate | null,
  findings: readonly Finding[],
  widthPx: number,
  options: RenderOptions,
): string[] {
  const alliance = options.alliance ?? plan.auto.alliance;
  const title = options.title ?? plan.auto.title ?? plan.auto.name;
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.filter((finding) => finding.severity === "warning").length;

  const timing =
    estimateResult === null || estimateResult.nominalS === null
      ? "no estimate"
      : `${n(estimateResult.nominalS)} s (${n(estimateResult.lowS ?? 0)}-${n(estimateResult.highS ?? 0)})${boundSuffix(estimateResult)}`;
  const counts =
    errors + warnings === 0
      ? "no findings"
      : `${String(errors)} error${errors === 1 ? "" : "s"}, ${String(warnings)} warning${warnings === 1 ? "" : "s"}`;

  return [
    `<g id="header">`,
    `<text x="${n(MARGIN_PX)}" y="${n(HEADER_PX - 14)}" fill="${TOKENS.textHi}" font-size="15">${escapeText(title)}</text>`,
    `<text x="${n(widthPx - MARGIN_PX)}" y="${n(HEADER_PX - 14)}" fill="${TOKENS.textMid}" font-size="12" text-anchor="end" font-family="${FONTS.mono}">${escapeText(`${alliance} · ${timing} · ${counts}`)}</text>`,
    `</g>`,
  ];
}

/** The field itself: the grid, the perimeter, the zones, the obstacles, the elements and targets. */
function drawField(
  field: Field,
  plan: Plan,
  frame: Frame,
  point: (p: Vec2) => Vec2,
  options: RenderOptions,
): string[] {
  const bounds = fieldBounds(field);
  const parts: string[] = [`<g id="field">`];
  const image = drawFieldImage(field, frame, options);
  parts.push(...image);

  const line = (a: Vec2, b: Vec2, stroke: string, width: number): string => {
    const from = frame.at(a);
    const to = frame.at(b);
    return `<line x1="${n(from.x)}" y1="${n(from.y)}" x2="${n(to.x)}" y2="${n(to.y)}" stroke="${stroke}" stroke-width="${n(width)}"/>`;
  };

  // A 24 in tile grid, halved to 12 in so a pose can be read off by eye, with the axes brightest.
  // A field picture carries its own tiles, so the grid is left out under one.
  for (let xIn = bounds.minXIn; image.length === 0 && xIn <= bounds.maxXIn + 1e-9; xIn += 12) {
    const major = Math.abs(xIn % 24) < 1e-9;
    const axis = Math.abs(xIn) < 1e-9;
    parts.push(
      line(
        { xIn, yIn: bounds.minYIn },
        { xIn, yIn: bounds.maxYIn },
        axis ? TOKENS.gridAxis : major ? TOKENS.gridMajor : TOKENS.gridMinor,
        axis ? 1 : 0.5,
      ),
    );
  }
  for (let yIn = bounds.minYIn; image.length === 0 && yIn <= bounds.maxYIn + 1e-9; yIn += 12) {
    const major = Math.abs(yIn % 24) < 1e-9;
    const axis = Math.abs(yIn) < 1e-9;
    parts.push(
      line(
        { xIn: bounds.minXIn, yIn },
        { xIn: bounds.maxXIn, yIn },
        axis ? TOKENS.gridAxis : major ? TOKENS.gridMajor : TOKENS.gridMinor,
        axis ? 1 : 0.5,
      ),
    );
  }

  const corner = frame.at({ xIn: bounds.minXIn, yIn: bounds.maxYIn });
  parts.push(
    `<rect x="${n(corner.x)}" y="${n(corner.y)}" width="${n(frame.fieldWidthPx)}" height="${n(frame.fieldHeightPx)}" fill="none" stroke="${TOKENS.borderDefault}" stroke-width="1.5"/>`,
  );

  for (const zone of field.zones ?? []) {
    parts.push(
      boxRect(zone, frame, TOKENS.fieldZone, TOKENS.fieldZone, ALPHA.zoneFill, "4 4"),
      boxLabel(zone, zone.id, frame, TOKENS.fieldZone),
    );
  }

  // Obstacles are drawn by their z class: one the robot would hit is filled, because you cannot
  // drive there; one it passes under is an outline, because you can (`03` section 4, STRUCTURE).
  const heightIn = robotHeightIn(plan.robot);
  for (const obstacle of field.obstacles ?? []) {
    const blocks = (obstacle.solidToRobot ?? true) && obstacle.minZIn < heightIn;
    parts.push(
      blocks
        ? boxRect(obstacle, frame, TOKENS.fieldObstacle, TOKENS.fieldObstacleFill, 1)
        : boxRect(obstacle, frame, TOKENS.fieldObstacle, "none", 0, "3 3"),
    );
  }

  for (const element of field.elements ?? []) {
    parts.push(...drawElement(element, frame));
  }
  for (const target of field.targets ?? []) {
    parts.push(...drawTarget(target, field, frame));
  }
  if (options.waypoints !== undefined) {
    parts.push(...drawWaypoints(options.waypoints, frame, point));
  }

  parts.push(`</g>`);
  return parts;
}

/**
 * The field picture under the vector layer, placed the way site/docs/file-format.md says: crop
 * the stored image to `pxBoundsIn`, turn it clockwise on screen by `rotationDeg`, and stretch it
 * over the field's rectangle. SVG's `rotate` is clockwise on screen because its y axis points down,
 * so the angle goes in as it is written.
 */
function drawFieldImage(field: Field, frame: Frame, options: RenderOptions): string[] {
  const spec = field.image;
  const supplied = options.fieldImage;
  if (spec === undefined || supplied === undefined) return [];
  const bounds = fieldBounds(field);
  const corner = frame.at({ xIn: bounds.minXIn, yIn: bounds.maxYIn });
  const widthPx = frame.fieldWidthPx;
  const heightPx = frame.fieldHeightPx;
  const cx = corner.x + widthPx / 2;
  const cy = corner.y + heightPx / 2;
  const rotation = spec.rotationDeg ?? 0;
  const quarter = rotation === 90 || rotation === 270;
  // The box the crop fills before it is turned, so that it fills the field after.
  const w = quarter ? heightPx : widthPx;
  const h = quarter ? widthPx : heightPx;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const href = escapeText(supplied.href);
  const turn = rotation === 0 ? "" : ` transform="rotate(${String(rotation)} ${n(cx)} ${n(cy)})"`;

  if (spec.pxBoundsIn === "fullBleed") {
    return [
      `<image href="${href}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"${turn}/>`,
    ];
  }
  if (supplied.widthPx === undefined || supplied.heightPx === undefined) return [];
  const box = spec.pxBoundsIn;
  return [
    `<g${turn}>`,
    `<svg x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" viewBox="${n(box.left)} ${n(box.top)} ${n(box.right - box.left)} ${n(box.bottom - box.top)}" preserveAspectRatio="none">`,
    `<image href="${href}" width="${n(supplied.widthPx)}" height="${n(supplied.heightPx)}"/>`,
    `</svg>`,
    `</g>`,
  ];
}

interface Box {
  minXIn: number;
  maxXIn: number;
  minYIn: number;
  maxYIn: number;
}

function boxRect(
  box: Box,
  frame: Frame,
  stroke: string,
  fill: string,
  fillOpacity: number,
  dash?: string,
): string {
  const corner = frame.at({ xIn: box.minXIn, yIn: box.maxYIn });
  const width = (box.maxXIn - box.minXIn) * frame.scale;
  const height = (box.maxYIn - box.minYIn) * frame.scale;
  const dashAttribute = dash === undefined ? "" : ` stroke-dasharray="${dash}"`;
  const fillAttribute =
    fill === "none" ? ` fill="none"` : ` fill="${fill}" fill-opacity="${n(fillOpacity)}"`;
  return `<rect x="${n(corner.x)}" y="${n(corner.y)}" width="${n(width)}" height="${n(height)}"${fillAttribute} stroke="${stroke}" stroke-width="1"${dashAttribute}/>`;
}

function boxLabel(box: Box, text: string, frame: Frame, fill: string): string {
  const at = frame.at({ xIn: (box.minXIn + box.maxXIn) / 2, yIn: (box.minYIn + box.maxYIn) / 2 });
  return `<text x="${n(at.x)}" y="${n(at.y)}" fill="${fill}" font-size="9" text-anchor="middle" font-family="${FONTS.mono}" opacity="0.7">${escapeText(text)}</text>`;
}

/** A game element: a loose piece as a circle of its own radius, a container as a labelled ring. */
function drawElement(element: FieldElement, frame: Frame): string[] {
  const pivot = (element as Record<string, unknown>)["pivotIn"];
  const centre: Vec2 | null =
    element.xIn !== undefined && element.yIn !== undefined
      ? { xIn: element.xIn, yIn: element.yIn }
      : typeof pivot === "object" && pivot !== null
        ? {
            xIn: Number((pivot as Record<string, unknown>)["xIn"] ?? 0),
            yIn: Number((pivot as Record<string, unknown>)["yIn"] ?? 0),
          }
        : null;
  if (centre === null) return [];

  const at = frame.at(centre);
  const isContainer = element.container !== null && element.container !== undefined;
  const radiusIn = element.radiusIn ?? (isContainer ? 3 : 1.4);
  const radiusPx = radiusIn * frame.scale;

  const parts = [
    `<circle cx="${n(at.x)}" cy="${n(at.y)}" r="${n(radiusPx)}" fill="${TOKENS.fieldElement}" fill-opacity="${n(ALPHA.elementFill)}" stroke="${TOKENS.fieldElement}" stroke-width="1"${isContainer ? ' stroke-dasharray="2 2"' : ""}/>`,
  ];
  if (isContainer) {
    parts.push(
      `<text x="${n(at.x)}" y="${n(at.y - radiusPx - 3)}" fill="${TOKENS.fieldElement}" font-size="9" text-anchor="middle" font-family="${FONTS.mono}">${escapeText(element.id)}</text>`,
    );
  }
  return parts;
}

/** A scoring target as a reticle, placed on whatever element or hive it names. */
function drawTarget(target: FieldTarget, field: Field, frame: Frame): string[] {
  const row = target as Record<string, unknown>;
  const ofId = typeof row["element"] === "string" ? row["element"] : row["hive"];
  const element = (field.elements ?? []).find((candidate) => candidate.id === ofId);
  if (element === undefined) return [];

  const pivot = (element as Record<string, unknown>)["pivotIn"];
  const centre: Vec2 | null =
    element.xIn !== undefined && element.yIn !== undefined
      ? { xIn: element.xIn, yIn: element.yIn }
      : typeof pivot === "object" && pivot !== null
        ? {
            xIn: Number((pivot as Record<string, unknown>)["xIn"] ?? 0),
            yIn: Number((pivot as Record<string, unknown>)["yIn"] ?? 0),
          }
        : null;
  if (centre === null) return [];

  const at = frame.at(centre);
  const r = 5;
  return [
    `<g id="target-${escapeText(target.id)}" stroke="${TOKENS.fieldTarget}" stroke-width="1" fill="none">`,
    `<circle cx="${n(at.x)}" cy="${n(at.y)}" r="${n(r)}"/>`,
    `<line x1="${n(at.x - r - 3)}" y1="${n(at.y)}" x2="${n(at.x + r + 3)}" y2="${n(at.y)}"/>`,
    `<line x1="${n(at.x)}" y1="${n(at.y - r - 3)}" x2="${n(at.x)}" y2="${n(at.y + r + 3)}"/>`,
    `</g>`,
  ];
}

function drawWaypoints(waypoints: Waypoints, frame: Frame, point: (p: Vec2) => Vec2): string[] {
  const parts: string[] = [`<g id="waypoints">`];
  for (const [name, waypoint] of Object.entries(waypoints.waypoints)) {
    const at = frame.at(point({ xIn: waypoint.xIn, yIn: waypoint.yIn }));
    parts.push(
      `<circle cx="${n(at.x)}" cy="${n(at.y)}" r="2.5" fill="none" stroke="${TOKENS.fieldWaypoint}" stroke-width="1"/>`,
      `<text x="${n(at.x + 5)}" y="${n(at.y - 4)}" fill="${TOKENS.fieldWaypoint}" font-size="9" font-family="${FONTS.mono}">${escapeText(name)}</text>`,
    );
  }
  parts.push(`</g>`);
  return parts;
}

/** Every path step's polyline, in the plan's own order. */
function pathPoints(step: PlanStep, frame: Frame, point: (p: Vec2) => Vec2): string {
  return step.samples
    .map((sample) => {
      const at = frame.at(point(sample.pose));
      return `${n(at.x)},${n(at.y)}`;
    })
    .join(" ");
}

function drawPaths(plan: Plan, frame: Frame, point: (p: Vec2) => Vec2): string[] {
  const parts: string[] = [`<g id="paths" fill="none" stroke-linejoin="round" stroke-linecap="round">`];
  for (const step of flat(plan.steps)) {
    if (step.samples.length < 2) continue;
    parts.push(
      `<polyline id="path-${escapeText(step.id)}" points="${pathPoints(step, frame, point)}" stroke="${TOKENS.pathEstimated}" stroke-width="2"/>`,
    );
  }
  parts.push(`</g>`);
  return parts;
}

/** The plan being compared against, drawn dashed and dim underneath (`06` section 4, review mode). */
function drawBase(base: Plan, frame: Frame, point: (p: Vec2) => Vec2): string[] {
  const parts: string[] = [`<g id="base" fill="none" opacity="${n(ALPHA.pathGhost)}">`];
  for (const step of flat(base.steps)) {
    if (step.samples.length < 2) continue;
    parts.push(
      `<polyline points="${pathPoints(step, frame, point)}" stroke="${TOKENS.pathEstimated}" stroke-width="2" stroke-dasharray="4 4"/>`,
    );
  }
  parts.push(`</g>`);
  return parts;
}

/** The part of a path a finding points at, widened underneath it in the severity's colour. */
function drawFindings(
  plan: Plan,
  findings: readonly Finding[],
  frame: Frame,
  point: (p: Vec2) => Vec2,
  options: RenderOptions,
): string[] {
  if (options.showFindings === false) return [];
  const steps = new Map(flat(plan.steps).map((step) => [step.id, step]));
  const parts: string[] = [`<g id="findings" fill="none" stroke-linecap="round">`];

  for (const finding of findings) {
    if (finding.severity === "info") continue;
    const colour = severityColour(finding.severity);
    const step = steps.get(finding.stepId);

    if (step !== undefined && step.samples.length >= 2) {
      const around =
        finding.t === undefined
          ? step.samples
          : step.samples.filter((sample) => Math.abs(sample.t - (finding.t ?? 0)) <= 0.06);
      const chosen: PlanSample[] = around.length >= 2 ? around : step.samples;
      const points = chosen
        .map((sample) => {
          const at = frame.at(point(sample.pose));
          return `${n(at.x)},${n(at.y)}`;
        })
        .join(" ");
      parts.push(
        `<polyline points="${points}" stroke="${colour}" stroke-width="6" opacity="${n(ALPHA.findingHighlight)}"/>`,
      );
    }

    const spot = finding.geometry?.pointIn;
    if (spot !== undefined) {
      const at = frame.at(point(spot));
      parts.push(
        `<circle cx="${n(at.x)}" cy="${n(at.y)}" r="4" fill="none" stroke="${colour}" stroke-width="1.5"/>`,
      );
    }
  }
  parts.push(`</g>`);
  return parts;
}

/**
 * The footprint stamped every half second of estimated time, with a tick along the nose. Where the
 * robot is slow the stamps crowd together and where it is quick they spread out, so the picture
 * shows the speed without a single number on it.
 */
function drawGhosts(
  plan: Plan,
  estimateResult: Estimate | null,
  frame: Frame,
  point: (p: Vec2) => Vec2,
  heading: (h: number) => number,
  options: RenderOptions,
): string[] {
  const everyS = options.ghostEveryS ?? GHOST_EVERY_S;
  const everyIn = options.ghostEveryIn ?? GHOST_EVERY_IN;
  const parts: string[] = [`<g id="ghosts">`];

  for (const step of flat(plan.steps)) {
    if (step.samples.length < 2) continue;
    const times = estimateResult?.byStepId[step.id]?.timeAtSampleS;
    const chosen =
      times !== undefined && times.length === step.samples.length
        ? samplesEvery(step, times, everyS)
        : samplesEveryInch(step, everyIn);

    for (const sample of chosen) {
      const pose = { ...point(sample.pose), headingRad: heading(sample.pose.headingRad) };
      const corners = sample.footprintIn
        .map((cornerIn) => {
          const at = frame.at(point(cornerIn));
          return `${n(at.x)},${n(at.y)}`;
        })
        .join(" ");
      const at = frame.at(pose);
      const nose = frame.at({
        xIn: pose.xIn + Math.cos(pose.headingRad) * 6,
        yIn: pose.yIn + Math.sin(pose.headingRad) * 6,
      });
      parts.push(
        `<polygon points="${corners}" fill="${TOKENS.pathEstimated}" fill-opacity="${n(ALPHA.ghostFootprint)}" stroke="${TOKENS.pathEstimated}" stroke-width="0.5" stroke-opacity="0.5"/>`,
        `<line x1="${n(at.x)}" y1="${n(at.y)}" x2="${n(nose.x)}" y2="${n(nose.y)}" stroke="${TOKENS.handleHeading}" stroke-width="1"/>`,
      );
    }
  }
  parts.push(`</g>`);
  return parts;
}

/** The samples nearest each half second of the step's own estimated time, the first and last always. */
function samplesEvery(
  step: PlanStep,
  times: readonly number[],
  everyS: number,
): PlanSample[] {
  const last = times[times.length - 1] ?? 0;
  const chosen: PlanSample[] = [];
  const taken = new Set<number>();
  for (let at = 0; at <= last + 1e-9; at += everyS) {
    let best = 0;
    for (let i = 1; i < times.length; i += 1) {
      if (Math.abs((times[i] as number) - at) < Math.abs((times[best] as number) - at)) best = i;
    }
    if (!taken.has(best)) {
      taken.add(best);
      chosen.push(step.samples[best] as PlanSample);
    }
  }
  const end = step.samples.length - 1;
  if (!taken.has(end)) chosen.push(step.samples[end] as PlanSample);
  return chosen;
}

/** The fallback when there is no estimate: one footprint per foot of arc. */
function samplesEveryInch(step: PlanStep, everyIn: number): PlanSample[] {
  const chosen: PlanSample[] = [];
  let next = 0;
  for (const sample of step.samples) {
    if (sample.sIn + 1e-9 >= next) {
      chosen.push(sample);
      next = sample.sIn + everyIn;
    }
  }
  const end = step.samples[step.samples.length - 1];
  if (end !== undefined && chosen[chosen.length - 1] !== end) chosen.push(end);
  return chosen;
}

/** Every marker as a labelled pin at the point on the path it fires at. */
function drawMarkers(plan: Plan, frame: Frame, point: (p: Vec2) => Vec2): string[] {
  const parts: string[] = [`<g id="markers">`];
  for (const step of flat(plan.steps)) {
    if (step.step.kind !== "path") continue;
    const markers = (step.step as Extract<Step, { kind: "path" }>).markers ?? [];
    for (const marker of markers) {
      const t = markerT(marker.at, step.lengthIn);
      const where = step.geometry?.pointAt(t);
      if (where === undefined) continue;
      const at = frame.at(point(where));
      parts.push(
        `<line x1="${n(at.x)}" y1="${n(at.y)}" x2="${n(at.x)}" y2="${n(at.y - 12)}" stroke="${TOKENS.markerPin}" stroke-width="1"/>`,
        `<circle cx="${n(at.x)}" cy="${n(at.y - 14)}" r="3" fill="${TOKENS.markerPin}"/>`,
        `<text x="${n(at.x + 5)}" y="${n(at.y - 16)}" fill="${TOKENS.markerPin}" font-size="9" font-family="${FONTS.mono}">${escapeText(marker.command.name)}</text>`,
      );
    }
  }
  parts.push(`</g>`);
  return parts;
}

/** The ledger as a side table, the same rows the pull-request body prints. */
function drawLedger(rows: readonly LedgerRow[], leftPx: number, heightPx: number): string[] {
  const x = leftPx + MARGIN_PX;
  const parts: string[] = [
    `<g id="ledger">`,
    `<rect x="${n(leftPx)}" y="${n(HEADER_PX)}" width="${n(LEDGER_WIDTH_PX)}" height="${n(heightPx - HEADER_PX - MARGIN_PX)}" fill="${TOKENS.bgPanel}" stroke="${TOKENS.borderSubtle}" stroke-width="1"/>`,
    `<text x="${n(x)}" y="${n(HEADER_PX + 18)}" fill="${TOKENS.textHi}" font-size="12">Ledger</text>`,
  ];
  let y = HEADER_PX + 38;
  for (const row of rows) {
    if (y > heightPx - MARGIN_PX - 8) break;
    parts.push(
      `<text x="${n(x)}" y="${n(y)}" fill="${TOKENS.textMid}" font-size="11" font-family="${FONTS.mono}">${escapeText(row.label)}</text>`,
    );
    if (row.detail !== undefined) {
      parts.push(
        `<text x="${n(x)}" y="${n(y + 13)}" fill="${TOKENS.textLo}" font-size="10" font-family="${FONTS.mono}">${escapeText(row.detail)}</text>`,
      );
      y += 13;
    }
    y += 20;
  }
  parts.push(`</g>`);
  return parts;
}

/** Every step, parallel and branch children included, in order. */
function flat(steps: readonly PlanStep[]): PlanStep[] {
  const out: PlanStep[] = [];
  for (const step of steps) {
    out.push(step);
    if (step.children !== undefined) out.push(...flat(step.children));
  }
  return out;
}
