import type { Envelope } from "@horizon36596/zenith-schema";
import { envelopeOf } from "../envelope.js";
import { cross, dot, sub, type Vec2 } from "../geometry/vec.js";
import type { Finding, PlanStep } from "../types.js";

/**
 * ENVELOPE_SHAPE: an envelope whose polygon does not enclose one simple area (spec 13 section 10).
 * The schema already bounds the corner count; this is the part it cannot express.
 */

/**
 * Two corners closer than this, in inches, are the same corner. It is far below anything a person
 * would draw on purpose and far above floating-point noise, and canonical form writes three
 * decimals, so no two distinct written corners are this close.
 */
const SAME_CORNER_IN = 1e-6;

/** Twice the signed area below which the corners are taken to lie on one line, in square inches. */
const NO_AREA_IN2 = 1e-6;

/** What is wrong with an envelope's polygon, and where, or null when it is a simple polygon. */
export interface EnvelopeShapeProblem {
  message: string;
  /** Where two edges cross, when that is the problem. */
  pointIn?: Vec2;
}

/** The corners with any repeat of the one before it (and a last corner equal to the first) dropped. */
function distinctCorners(polygon: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const corner of polygon) {
    const previous = out[out.length - 1];
    if (previous !== undefined && Math.hypot(corner.xIn - previous.xIn, corner.yIn - previous.yIn) < SAME_CORNER_IN) {
      continue;
    }
    out.push(corner);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first !== undefined && last !== undefined) {
    if (Math.hypot(first.xIn - last.xIn, first.yIn - last.yIn) < SAME_CORNER_IN) out.pop();
  }
  return out;
}

/** Twice the signed area (the shoelace sum), positive for counter-clockwise corners. */
function twiceArea(corners: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i] as Vec2;
    const b = corners[(i + 1) % corners.length] as Vec2;
    sum += cross(a, b);
  }
  return sum;
}

/** Where the segments ab and cd meet, when they do, touching included; null when they do not. */
function segmentsMeet(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denominator = cross(r, s);
  const ac = sub(c, a);
  if (Math.abs(denominator) < 1e-12) {
    // Parallel. They meet only if they lie on one line and overlap along it.
    if (Math.abs(cross(ac, r)) > 1e-9) return null;
    const rr = dot(r, r);
    if (rr < 1e-12) return null;
    const t0 = dot(ac, r) / rr;
    const t1 = t0 + dot(s, r) / rr;
    const low = Math.max(0, Math.min(t0, t1));
    const high = Math.min(1, Math.max(t0, t1));
    if (low > high) return null;
    return { xIn: a.xIn + r.xIn * low, yIn: a.yIn + r.yIn * low };
  }
  const t = cross(ac, s) / denominator;
  const u = cross(ac, r) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { xIn: a.xIn + r.xIn * t, yIn: a.yIn + r.yIn * t };
}

/**
 * Why a polygon is not a simple polygon, or null when it is: fewer than three distinct corners, no
 * area at all, an edge that doubles straight back along the one before it, or two edges that
 * cross or touch anywhere but the corner they share.
 */
export function envelopeShapeProblem(polygon: readonly Vec2[]): EnvelopeShapeProblem | null {
  const corners = distinctCorners(polygon);
  const count = corners.length;
  if (count < 3) {
    return {
      message: `The envelope has ${String(count)} distinct corner${count === 1 ? "" : "s"}; a polygon needs at least three.`,
    };
  }
  const first = corners[0] as Vec2;
  const direction = sub(corners[1] as Vec2, first);
  if (corners.every((corner) => Math.abs(cross(direction, sub(corner, first))) < NO_AREA_IN2)) {
    return { message: "The envelope's corners all lie on one line, so it encloses no area." };
  }

  const edge = (i: number): [Vec2, Vec2] => [corners[i] as Vec2, corners[(i + 1) % count] as Vec2];
  for (let i = 0; i < count; i += 1) {
    // Neighbouring edges share a corner and meet there by construction; they are only wrong when
    // the second runs back along the first.
    const [a, b] = edge(i);
    const [, c] = edge((i + 1) % count);
    const ab = sub(b, a);
    const bc = sub(c, b);
    if (Math.abs(cross(ab, bc)) < 1e-9 && dot(ab, bc) < 0) {
      return {
        message: `Edge ${String(((i + 1) % count) + 1)} of the envelope runs back along edge ${String(i + 1)}, so the polygon folds over itself.`,
        pointIn: b,
      };
    }
  }
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 2; j < count; j += 1) {
      // The last edge and the first share corner 0.
      if (i === 0 && j === count - 1) continue;
      const [a, b] = edge(i);
      const [c, d] = edge(j);
      const meet = segmentsMeet(a, b, c, d);
      if (meet !== null) {
        return {
          message: `Edges ${String(i + 1)} and ${String(j + 1)} of the envelope cross, so it does not enclose one area; reorder the corners so they run round the outside.`,
          pointIn: meet,
        };
      }
    }
  }
  // With no two edges crossing, the shoelace sum is the enclosed area; before that test, a bowtie's
  // two halves cancel and would read as no area at all.
  if (Math.abs(twiceArea(corners)) < NO_AREA_IN2) {
    return { message: "The envelope's corners all lie on one line, so it encloses no area." };
  }
  return null;
}

/** ENVELOPE_SHAPE over every step that carries an envelope, groups' members included. */
export function checkEnvelopes(steps: readonly PlanStep[]): Finding[] {
  const findings: Finding[] = [];
  for (const step of steps) {
    const envelope: Envelope | undefined = envelopeOf(step.step);
    if (envelope === undefined) continue;
    const problem = envelopeShapeProblem(envelope.polygon);
    if (problem === null) continue;
    findings.push({
      severity: "error",
      stepId: step.id,
      code: "ENVELOPE_SHAPE",
      message: problem.message,
      geometry: {
        polygonIn: envelope.polygon.map((corner) => ({ xIn: corner.xIn, yIn: corner.yIn })),
        ...(problem.pointIn === undefined ? {} : { pointIn: problem.pointIn }),
      },
    });
  }
  return findings;
}
