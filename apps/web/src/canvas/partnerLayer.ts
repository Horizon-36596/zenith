/**
 * The alliance view's layer on the field (spec 13 section 9): each visible
 * partner's trajectory as a faint polyline, its active envelopes hatched, and its robot's bounding
 * box at the scrubber's time with a heading tick and its name. Painted over the static field and
 * under the live layer, so the user's own paths, handles and robot outline always sit on top.
 *
 * Partner geometry arrives in the user's own alliance frame (`alliance/model.ts`), so it goes
 * through the same view mirror as everything else in the live layer.
 */
import { mirrorHeadingRad, mirrorVec, type MirrorMode, type Vec2 } from "@horizon36596/zenith-core";
import type { PartnerDraw } from "../alliance/model.js";
import type { CanvasTheme } from "./theme.js";
import { headingToScreenAngle, worldToScreen, type ScreenVec, type View } from "./view.js";

export interface PartnerLayerInput {
  partners: readonly PartnerDraw[];
  view: View;
  mirror: MirrorMode;
  theme: CanvasTheme;
}

/** The gap between an envelope's hatch lines, in screen pixels, the same as the user's own. */
const HATCH_PX = 8;

/** The colour a partner is drawn in, from its colour index. */
export function partnerInk(theme: CanvasTheme, colour: number): string {
  const inks = [theme.partner1, theme.partner2, theme.partner3];
  return inks[((colour % inks.length) + inks.length) % inks.length] as string;
}

const project = (input: PartnerLayerInput, point: Vec2): ScreenVec =>
  worldToScreen(input.view, mirrorVec(point, input.mirror));

function tracePolygon(ctx: CanvasRenderingContext2D, input: PartnerLayerInput, corners: readonly Vec2[]): void {
  ctx.beginPath();
  corners.forEach((corner, index) => {
    const screen = project(input, corner);
    if (index === 0) ctx.moveTo(screen.xPx, screen.yPx);
    else ctx.lineTo(screen.xPx, screen.yPx);
  });
  ctx.closePath();
}

function drawEnvelope(ctx: CanvasRenderingContext2D, input: PartnerLayerInput, polygon: readonly Vec2[], ink: string): void {
  if (polygon.length < 3) return;
  const screen = polygon.map((corner) => project(input, corner));
  const minX = Math.min(...screen.map((point) => point.xPx));
  const maxX = Math.max(...screen.map((point) => point.xPx));
  const minY = Math.min(...screen.map((point) => point.yPx));
  const maxY = Math.max(...screen.map((point) => point.yPx));
  ctx.save();
  tracePolygon(ctx, input, polygon);
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.06;
  ctx.fill();
  ctx.clip();
  ctx.beginPath();
  const heightPx = maxY - minY;
  for (let offset = 0; offset <= maxX - minX + heightPx; offset += HATCH_PX) {
    ctx.moveTo(minX + offset, minY);
    ctx.lineTo(minX + offset - heightPx, maxY);
  }
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.35;
  ctx.stroke();
  ctx.restore();
  tracePolygon(ctx, input, polygon);
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.7;
  ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

function drawTrajectory(ctx: CanvasRenderingContext2D, input: PartnerLayerInput, points: readonly Vec2[], ink: string): void {
  if (points.length < 2) return;
  ctx.beginPath();
  points.forEach((point, index) => {
    const screen = project(input, point);
    if (index === 0) ctx.moveTo(screen.xPx, screen.yPx);
    else ctx.lineTo(screen.xPx, screen.yPx);
  });
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** A label's box on screen, in pixels, for keeping partner names off each other. */
export interface LabelRect {
  xPx: number;
  yPx: number;
  widthPx: number;
  heightPx: number;
}

const LABEL_LINE_PX = 12;
const LABEL_GAP_PX = 4;

const overlaps = (a: LabelRect, b: LabelRect): boolean =>
  a.xPx < b.xPx + b.widthPx && b.xPx < a.xPx + a.widthPx && a.yPx < b.yPx + b.heightPx && b.yPx < a.yPx + a.heightPx;

/**
 * Where a partner's name goes: above its box, so it never lands on the editor's own robot label,
 * which sits under that robot; a line higher for each name already there; and under the box
 * instead when there is no room above it at the top of the field.
 */
export function placeLabel(
  box: { topPx: number; bottomPx: number; midXPx: number },
  widthPx: number,
  placed: readonly LabelRect[],
): LabelRect {
  const xPx = box.midXPx - widthPx / 2;
  const at = (yPx: number): LabelRect => ({ xPx, yPx, widthPx, heightPx: LABEL_LINE_PX });
  let rect = at(box.topPx - LABEL_GAP_PX - LABEL_LINE_PX);
  while (placed.some((other) => overlaps(rect, other))) rect = at(rect.yPx - LABEL_LINE_PX);
  if (rect.yPx >= 0) return rect;
  rect = at(box.bottomPx + LABEL_GAP_PX);
  while (placed.some((other) => overlaps(rect, other))) rect = at(rect.yPx + LABEL_LINE_PX);
  return rect;
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  input: PartnerLayerInput,
  partner: PartnerDraw,
  ink: string,
  placed: LabelRect[],
): void {
  tracePolygon(ctx, input, partner.boxIn);
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.1;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "miter";
  // A partner still waiting out its start offset is dashed: it is there, but not yet moving.
  if (partner.waiting) ctx.setLineDash([4, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  // The heading tick, from the pose out past the front edge, in the partner's own ink.
  const centre = project(input, partner.poseIn);
  const angle = headingToScreenAngle(input.view, mirrorHeadingRad(partner.poseIn.headingRad, input.mirror));
  const screen = partner.boxIn.map((corner) => project(input, corner));
  const reachPx = Math.max(...screen.map((point) => Math.hypot(point.xPx - centre.xPx, point.yPx - centre.yPx)));
  ctx.beginPath();
  ctx.moveTo(centre.xPx, centre.yPx);
  ctx.lineTo(centre.xPx + Math.cos(angle) * reachPx * 0.85, centre.yPx + Math.sin(angle) * reachPx * 0.85);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // The partner's name over the box, with a keyline so it reads over the field picture. The editor's
  // own robot is labelled under its outline, so two robots side by side keep their names apart.
  const topPx = Math.min(...screen.map((point) => point.yPx));
  const bottomPx = Math.max(...screen.map((point) => point.yPx));
  const midXPx = screen.reduce((sum, point) => sum + point.xPx, 0) / Math.max(1, screen.length);
  ctx.font = `10px ${input.theme.fontMono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeStyle = input.theme.bgCanvas;
  const label = partner.waiting ? `${partner.label} · waiting` : partner.label;
  const rect = placeLabel({ topPx, bottomPx, midXPx }, ctx.measureText(label).width + 4, placed);
  placed.push(rect);
  const yPx = Math.round(rect.yPx);
  ctx.strokeText(label, Math.round(midXPx), yPx);
  ctx.fillStyle = ink;
  ctx.fillText(label, Math.round(midXPx), yPx);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

/** Paints every partner: trajectories first, then envelopes, then the boxes on top. */
export function drawPartners(ctx: CanvasRenderingContext2D, input: PartnerLayerInput): void {
  if (input.partners.length === 0) return;
  ctx.save();
  for (const partner of input.partners) drawTrajectory(ctx, input, partner.trajectoryIn, partnerInk(input.theme, partner.colour));
  for (const partner of input.partners) {
    for (const polygon of partner.envelopesIn) drawEnvelope(ctx, input, polygon, partnerInk(input.theme, partner.colour));
  }
  const placed: LabelRect[] = [];
  for (const partner of input.partners) drawBox(ctx, input, partner, partnerInk(input.theme, partner.colour), placed);
  ctx.restore();
}
