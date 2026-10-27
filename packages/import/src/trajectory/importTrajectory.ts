import type { Field } from "@horizon36596/zenith-schema";
import { ImportError, jsonPath, type ImportIssue } from "../errors.js";
import {
  frameProblem,
  headingToField,
  pointToField,
  presetFrame,
  presetSeasonWarning,
  wrap,
  type FrameSpec,
} from "../frame.js";
import { MAX_TRAJECTORY_POSES_10HZ, trajectoryFileSchema, type TrajectoryFile, type TrajectoryFrame } from "./schema.js";

/** The rate a projection's trajectory is sampled at, in samples per second (spec 13 section 8.2). */
export const PROJECTION_RATE_HZ = 10;
/** The position rounding a view projection uses, in inches (section 8.2). */
export const DEFAULT_POSITION_QUANTUM_IN = 0.5;
/** The heading rounding a view projection uses: one degree, in radians (section 8.2). */
export const DEFAULT_HEADING_QUANTUM_RAD = Math.PI / 180;

export type PhaseLabel = "drive" | "score" | "collect" | "wait" | "park" | "other";

/** What another team's robot does, as the alliance view reads it: a view-level projection. */
export interface ImportedProjection {
  formatVersion: 1;
  kind: "projection";
  level: "view";
  season: string;
  alliance: "RED" | "BLUE";
  title?: string;
  /** The first pose of the trajectory, in the field frame. */
  startPose: { xIn: number; yIn: number; headingRad: number };
  /** In the robot's frame: `lengthIn` along its heading, `widthIn` side to side, centre offset forward and left. */
  boundingBox: { lengthIn: number; widthIn: number; centreOffsetIn: { xIn: number; yIn: number } };
  trajectory: {
    rateHz: 10;
    positionQuantumIn: number;
    headingQuantumRad: number;
    /** `[xIn, yIn, headingRad]` in the field frame, the k-th at k / 10 s, each rounded to its quantum. */
    poses: [number, number, number][];
  };
  phases: { startS: number; endS: number; label: PhaseLabel }[];
  claims: { elementId: string; action: "take" | "score"; atS: number }[];
  envelopes: { startS: number; endS: number; polygon: { xIn: number; yIn: number }[] }[];
  /** The trajectory's length in time, in seconds: the last input pose's time. */
  totalS: number;
}

export interface TrajectoryImportOptions {
  /** Rounding for positions, in inches. Default 0.5, the view projection's. */
  positionQuantumIn?: number;
  /** Rounding for headings, in radians. Default one degree, the view projection's. */
  headingQuantumRad?: number;
}

export interface TrajectoryImportResult {
  projection: ImportedProjection;
  warnings: string[];
}

/** The frame a file declares, resolved to every key: a preset with overrides, or all keys given. */
export function resolveFrame(declared: TrajectoryFrame): { frame: FrameSpec | null; issues: ImportIssue[] } {
  const issues: ImportIssue[] = [];
  const base: Partial<FrameSpec> = declared.preset === undefined ? {} : presetFrame(declared.preset);
  const merged: Partial<FrameSpec> = { ...base };
  if (declared.originIn !== undefined) merged.originIn = declared.originIn;
  if (declared.xAxis !== undefined) merged.xAxis = declared.xAxis;
  if (declared.yAxis !== undefined) merged.yAxis = declared.yAxis;
  if (declared.units !== undefined) merged.units = declared.units;
  if (declared.headingUnit !== undefined) merged.headingUnit = declared.headingUnit;
  if (declared.headingZero !== undefined) merged.headingZero = declared.headingZero;
  if (declared.headingPositive !== undefined) merged.headingPositive = declared.headingPositive;
  const required = ["originIn", "xAxis", "yAxis", "units", "headingUnit", "headingZero", "headingPositive"] as const;
  for (const key of required) {
    if (merged[key] === undefined) {
      issues.push({ path: `frame.${key}`, message: "is required when frame names no preset." });
    }
  }
  if (issues.length > 0) return { frame: null, issues };
  const frame = merged as FrameSpec;
  const problem = frameProblem(frame);
  if (problem !== null) return { frame: null, issues: [{ path: "frame.yAxis", message: problem }] };
  return { frame, issues };
}

const roundTo = (value: number, quantum: number): number => {
  const rounded = Math.round(value / quantum) * quantum;
  // Clean the last bit of floating-point noise, so 0.5-inch steps print as 12.5, not 12.500000000001.
  return Number(rounded.toFixed(10));
};

/**
 * Reads an interchange `trajectory.json` into a view projection in the season's field frame,
 * resampled to 10 Hz and rounded to the view projection's quanta, with warnings for anything that
 * was changed or could not be checked.
 *
 * Sample k is the pose at k / 10 s, found by linear interpolation between the file's two nearest
 * samples (the heading the short way round); the last sample is the file's last pose, at `totalS`,
 * even when that is not a multiple of 0.1 s.
 *
 * Pure. Throws `ImportError` with every schema problem named by its path.
 */
export function readTrajectory(json: unknown, field: Field, options: TrajectoryImportOptions = {}): TrajectoryImportResult {
  const parsed = trajectoryFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ImportError(
      "the trajectory file",
      parsed.error.issues.map((issue) => ({
        path: jsonPath(issue.path),
        message: issue.code === "unrecognized_keys" ? `${issue.message}; the trajectory format has no such field` : issue.message,
      })),
    );
  }
  const file: TrajectoryFile = parsed.data;
  const warnings: string[] = [];

  const { frame, issues } = resolveFrame(file.frame);
  if (frame === null) throw new ImportError("the trajectory file", issues);
  if (file.season !== field.season) {
    throw new ImportError("the trajectory file", [
      { path: "season", message: `is ${JSON.stringify(file.season)}, but the field is ${JSON.stringify(field.season)}; a trajectory only lines up on its own season's field.` },
    ]);
  }
  if (file.frame.preset !== undefined) {
    const warning = presetSeasonWarning(file.frame.preset, field);
    if (warning !== null) warnings.push(warning);
  }
  if (file.rateHz < PROJECTION_RATE_HZ) {
    warnings.push(
      `rateHz is ${String(file.rateHz)}, below the 10 Hz the interchange guidelines ask for; the poses between its samples were interpolated along straight lines.`,
    );
  }

  const positionQuantumIn = options.positionQuantumIn ?? DEFAULT_POSITION_QUANTUM_IN;
  const headingQuantumRad = options.headingQuantumRad ?? DEFAULT_HEADING_QUANTUM_RAD;

  // Every input pose in the field frame, before any resampling.
  const input = file.poses.map((row) => {
    const [x, y, h] = row as [number, number, number];
    return { ...pointToField(frame, x, y), headingRad: headingToField(frame, h) };
  });
  const totalS = (input.length - 1) / file.rateHz;
  const count = Math.max(1, Math.ceil(totalS * PROJECTION_RATE_HZ - 1e-9) + 1);
  if (count > MAX_TRAJECTORY_POSES_10HZ) {
    throw new ImportError("the trajectory file", [
      { path: "poses", message: `runs ${totalS.toFixed(1)} s, longer than the 300 s a projection may carry.` },
    ]);
  }

  const poses: [number, number, number][] = [];
  for (let k = 0; k < count; k += 1) {
    const t = Math.min(k / PROJECTION_RATE_HZ, totalS);
    const at = t * file.rateHz;
    const i = Math.min(Math.floor(at + 1e-9), input.length - 1);
    const a = input[i] as (typeof input)[number];
    const b = input[Math.min(i + 1, input.length - 1)] as (typeof input)[number];
    const f = Math.min(Math.max(at - i, 0), 1);
    const xIn = a.xIn + (b.xIn - a.xIn) * f;
    const yIn = a.yIn + (b.yIn - a.yIn) * f;
    const headingRad = wrap(a.headingRad + wrap(b.headingRad - a.headingRad) * f);
    poses.push([roundTo(xIn, positionQuantumIn), roundTo(yIn, positionQuantumIn), wrap(roundTo(headingRad, headingQuantumRad))]);
  }

  const beyond = (s: number): boolean => s > totalS + 1e-9;
  const phases = (file.phases ?? []).map((phase, i) => {
    if (beyond(phase.endS)) warnings.push(`phases[${String(i)}] ends at ${String(phase.endS)} s, after the trajectory's last pose at ${totalS.toFixed(2)} s.`);
    return { startS: phase.startS, endS: phase.endS, label: phase.label };
  });
  const elementIds = new Set((field.elements ?? []).map((element) => element.id));
  const claims = (file.claims ?? []).map((claim, i) => {
    if (!elementIds.has(claim.elementId)) {
      warnings.push(`claims[${String(i)}].elementId ${JSON.stringify(claim.elementId)} is not an element of the ${field.season} field; the alliance view cannot place it.`);
    }
    if (beyond(claim.atS)) warnings.push(`claims[${String(i)}].atS is ${String(claim.atS)} s, after the trajectory's last pose.`);
    return { elementId: claim.elementId, action: claim.action, atS: claim.atS };
  });
  const envelopes = (file.envelopes ?? []).map((envelope) => ({
    startS: envelope.startS,
    endS: envelope.endS,
    polygon: envelope.polygon.map((corner) => {
      const p = pointToField(frame, corner.x, corner.y);
      return { xIn: roundTo(p.xIn, positionQuantumIn), yIn: roundTo(p.yIn, positionQuantumIn) };
    }),
  }));

  const first = poses[0] as [number, number, number];
  const projection: ImportedProjection = {
    formatVersion: 1,
    kind: "projection",
    level: "view",
    season: field.season,
    alliance: file.alliance,
    ...(file.title === undefined ? {} : { title: file.title }),
    startPose: { xIn: first[0], yIn: first[1], headingRad: first[2] },
    boundingBox: {
      lengthIn: file.boundingBox.lengthIn,
      widthIn: file.boundingBox.widthIn,
      centreOffsetIn: file.boundingBox.centreOffsetIn ?? { xIn: 0, yIn: 0 },
    },
    trajectory: { rateHz: PROJECTION_RATE_HZ, positionQuantumIn, headingQuantumRad, poses },
    phases,
    claims,
    envelopes,
    totalS,
  };
  return { projection, warnings };
}

/** `readTrajectory` without the warnings: the projection alone. */
export function importTrajectory(json: unknown, field: Field, options: TrajectoryImportOptions = {}): ImportedProjection {
  return readTrajectory(json, field, options).projection;
}
