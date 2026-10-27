import { FORMAT_VERSIONS, parseAuto, SCHEMA_ID, type Auto, type Field, type Heading, type HeadingRange, type Pose, type Step } from "@horizon36596/zenith-schema";
import { ImportError } from "../errors.js";
import { wrap } from "../frame.js";
import { PROJECTION_RATE_HZ, readTrajectory, type ImportedProjection } from "./importTrajectory.js";

/**
 * A `trajectory.json` as an auto: what a team that paths on the fly, or plans in RoadRunner, imports
 * so that its routine can go into the team library and be shared like any other auto (spec 13
 * section 11). The trajectory is read the way the alliance view reads it (`readTrajectory`: the
 * season's frame, 10 Hz, 0.5 in and one degree), then cut where the robot stops:
 *
 * - a stretch where it drives becomes one `path` step of `line` segments through the samples,
 *   simplified until every sample lies within 0.5 in and 2 degrees of the result, with a
 *   `piecewise` heading that turns linearly along each segment (or a `constant` one when it never
 *   turns);
 * - a stretch where it stands still becomes a `wait` step of that length;
 * - a stretch where it turns without moving becomes a `path` step whose one line starts and ends
 *   at the same point, with a `linear` heading through the whole turn, and a warning.
 *
 * What an auto cannot carry is left out with a warning: the file's own timing (the planner times
 * an auto from `robot.json`), its phases, claims and envelopes. The robot's size is returned beside
 * the auto, never written into `robot.json`. Every pose carries `CARRIED OVER (trajectory.json
 * import)`.
 *
 * Pure. Throws `ImportError` naming every field that is wrong, like `readTrajectory`.
 */

/** The label every pose the importer writes carries (CLAUDE.md rule 4). */
export const TRAJECTORY_AUTO_PROVENANCE = "CARRIED OVER (trajectory.json import)";

/**
 * How far a sample may lie from the simplified path, in inches. SET BY HAND: the view projection's
 * own rounding, and the 0.5 in every import is held to (spec 13, M-C8).
 */
export const TRAJECTORY_AUTO_POSITION_TOLERANCE_IN = 0.5;

/**
 * How far a sample's heading may be from the simplified heading, in radians. SET BY HAND: two
 * degrees, twice the view projection's one-degree rounding, so the rounding alone never splits a
 * segment.
 */
export const TRAJECTORY_AUTO_HEADING_TOLERANCE_RAD = (2 * Math.PI) / 180;

/**
 * The shortest stop or turn in place that becomes a step of its own, in seconds. SET BY HAND:
 * three samples at 10 Hz. With positions rounded to 0.5 in, a robot below 5 in/s repeats a
 * sample for one or two rows as it pulls away or comes to rest; shorter repeats stay part of the
 * drive around them.
 */
export const TRAJECTORY_AUTO_MIN_STOP_S = 0.3;

/** The shape an auto's `name` must have (the CLI refuses anything else). */
const AUTO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface TrajectoryAutoOptions {
  /** The auto's `name`, also its file name. Default `imported-trajectory`. */
  name?: string;
  /** The auto's title. Default: the file's own `title`, when it has one. */
  title?: string;
}

export interface TrajectoryAutoResult {
  auto: Auto;
  /** The robot's size the file gives, in inches: reported, never written into `robot.json`. */
  robotFootprint: { lengthIn: number; widthIn: number };
  /** The trajectory's own length in time, in seconds, for comparing with the auto's estimate. */
  totalS: number;
  /** Full sentences: everything that was changed, left out or could not be checked. */
  warnings: string[];
}

type Row = [number, number, number];
type Kind = "drive" | "turn" | "still";

interface Run {
  kind: Kind;
  /** The index of the first and the last sample of the run; consecutive runs share a sample. */
  from: number;
  to: number;
}

const samePlace = (a: Row, b: Row): boolean => a[0] === b[0] && a[1] === b[1];

/** What the robot does between sample k and sample k + 1. */
function kindBetween(a: Row, b: Row): Kind {
  if (!samePlace(a, b)) return "drive";
  return wrap(b[2] - a[2]) === 0 ? "still" : "turn";
}

/** The time of sample k: k / 10 s, except the last, which is the trajectory's own end. */
const timeOf = (projection: ImportedProjection, k: number): number =>
  Math.min(k / PROJECTION_RATE_HZ, projection.totalS);

/**
 * The runs of one kind, with every stop or turn shorter than `TRAJECTORY_AUTO_MIN_STOP_S` that
 * touches a drive folded into it, and neighbours of the same kind joined.
 */
function runsOf(projection: ImportedProjection): Run[] {
  const rows = projection.trajectory.poses as Row[];
  const raw: Run[] = [];
  for (let k = 0; k + 1 < rows.length; k += 1) {
    const kind = kindBetween(rows[k] as Row, rows[k + 1] as Row);
    const last = raw[raw.length - 1];
    if (last !== undefined && last.kind === kind) last.to = k + 1;
    else raw.push({ kind, from: k, to: k + 1 });
  }
  const length = (run: Run): number => timeOf(projection, run.to) - timeOf(projection, run.from);
  const folded = raw.map((run, i) => {
    if (run.kind === "drive" || length(run) >= TRAJECTORY_AUTO_MIN_STOP_S - 1e-9) return run;
    const touchesDrive = raw[i - 1]?.kind === "drive" || raw[i + 1]?.kind === "drive";
    return touchesDrive ? { ...run, kind: "drive" as const } : run;
  });
  const joined: Run[] = [];
  for (const run of folded) {
    const last = joined[joined.length - 1];
    if (last !== undefined && last.kind === run.kind) last.to = run.to;
    else joined.push({ ...run });
  }
  return joined;
}

/** A drive's samples with the heading unwrapped, so a turn through pi reads as one smooth turn. */
function unwrapped(rows: readonly Row[]): Row[] {
  const out: Row[] = [];
  for (const row of rows) {
    const previous = out[out.length - 1];
    out.push(previous === undefined ? [row[0], row[1], row[2]] : [row[0], row[1], previous[2] + wrap(row[2] - previous[2])]);
  }
  return out;
}

/** The distance from p to the segment a-b, in inches. */
function distanceToSegment(p: Row, a: Row, b: Row): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * The samples a drive keeps: the first, the last, and every one the simplification needs so that
 * each sample between two kept ones lies within the position tolerance of the line between them
 * and within the heading tolerance of the heading turning linearly along it (Ramer-Douglas-Peucker,
 * with the heading as a second measure). `along` is each sample's distance along the samples.
 */
function keptSamples(rows: readonly Row[], along: readonly number[]): number[] {
  const keep = new Set<number>([0, rows.length - 1]);
  const stack: [number, number][] = [[0, rows.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop() as [number, number];
    const a = rows[i] as Row;
    const b = rows[j] as Row;
    const span = (along[j] as number) - (along[i] as number);
    let worst = 1;
    let worstAt = -1;
    for (let m = i + 1; m < j; m += 1) {
      const p = rows[m] as Row;
      const f = span === 0 ? 0 : ((along[m] as number) - (along[i] as number)) / span;
      const position = distanceToSegment(p, a, b) / TRAJECTORY_AUTO_POSITION_TOLERANCE_IN;
      const heading = Math.abs(p[2] - (a[2] + (b[2] - a[2]) * f)) / TRAJECTORY_AUTO_HEADING_TOLERANCE_RAD;
      const score = Math.max(position, heading);
      if (score > worst) {
        worst = score;
        worstAt = m;
      }
    }
    if (worstAt >= 0) {
      keep.add(worstAt);
      stack.push([i, worstAt], [worstAt, j]);
    }
  }
  return [...keep].sort((x, y) => x - y);
}

const pose = (row: Row): Pose => ({ xIn: row[0], yIn: row[1], provenance: TRAJECTORY_AUTO_PROVENANCE });

/** Rounds away floating-point noise in a fraction, and keeps it inside [0, 1]. */
const fraction = (value: number): number => Math.min(1, Math.max(0, Number(value.toFixed(6))));

/** One drive as a path step: its line segments and its heading. */
function driveStep(id: string, samples: readonly Row[], fromCurrent: boolean): Step {
  // Repeated samples add no length; keep the first of each, but the drive's own last heading.
  const distinct: Row[] = [];
  for (const row of samples) {
    const previous = distinct[distinct.length - 1];
    if (previous !== undefined && samePlace(previous, row)) continue;
    distinct.push(row);
  }
  const final = samples[samples.length - 1] as Row;
  distinct[distinct.length - 1] = final;
  const rows = unwrapped(distinct);
  const along: number[] = [0];
  for (let k = 1; k < rows.length; k += 1) {
    const a = rows[k - 1] as Row;
    const b = rows[k] as Row;
    along.push((along[k - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const kept = keptSamples(rows, along);
  const total = along[along.length - 1] as number;
  const segments = kept.slice(1).map((index, n) => {
    const from = rows[kept[n] as number] as Row;
    const to = rows[index] as Row;
    return { kind: "line" as const, from: n === 0 && fromCurrent ? ("current" as const) : pose(from), to: pose(to) };
  });

  const headings = kept.map((index) => (rows[index] as Row)[2]);
  const first = headings[0] as number;
  let heading: Heading;
  if (headings.every((value) => Math.abs(value - first) <= TRAJECTORY_AUTO_HEADING_TOLERANCE_RAD)) {
    heading = { mode: "constant", headingRad: wrap(first) };
  } else {
    const ranges: HeadingRange[] = kept.slice(1).map((index, n) => {
      const start = kept[n] as number;
      const fromRad = (rows[start] as Row)[2];
      return {
        startT: n === 0 ? 0 : fraction((along[start] as number) / total),
        endT: n === kept.length - 2 ? 1 : fraction((along[index] as number) / total),
        heading: { mode: "linear", fromRad, toRad: (rows[index] as Row)[2] },
      };
    });
    heading = ranges.length === 1 ? (ranges[0] as HeadingRange).heading : { mode: "piecewise", ranges };
  }
  return { id, kind: "path", segments, heading };
}

const degrees = (radians: number): string => `${String(Math.round((radians * 180) / Math.PI))} degrees`;
const seconds = (value: number): string => `${value.toFixed(1)} s`;

/**
 * Imports an interchange `trajectory.json` as an auto that can be edited, saved into the team
 * library and shared. See the file comment for how the trajectory is cut into steps.
 */
export function importTrajectoryAsAuto(json: unknown, field: Field, options: TrajectoryAutoOptions = {}): TrajectoryAutoResult {
  const name = options.name ?? "imported-trajectory";
  if (!AUTO_NAME_PATTERN.test(name)) {
    throw new ImportError("the trajectory file", [{ path: "", message: `the auto name ${JSON.stringify(name)} must use only letters, digits, ".", "_" and "-".` }]);
  }
  const read = readTrajectory(json, field);
  const { projection } = read;
  const warnings = [...read.warnings];
  const rows = projection.trajectory.poses as Row[];
  const start = rows[0] as Row;

  const counters = { drive: 0, turn: 0, wait: 0 };
  const steps: Step[] = [];
  let driven = false;
  for (const run of runsOf(projection)) {
    const fromS = timeOf(projection, run.from);
    const toS = timeOf(projection, run.to);
    if (run.kind === "still") {
      counters.wait += 1;
      steps.push({ id: `wait${String(counters.wait)}`, kind: "wait", seconds: Number((toS - fromS).toFixed(3)) });
      continue;
    }
    const samples = rows.slice(run.from, run.to + 1);
    if (run.kind === "drive") {
      counters.drive += 1;
      steps.push(driveStep(`drive${String(counters.drive)}`, samples, driven));
      driven = true;
      continue;
    }
    counters.turn += 1;
    const id = `turn${String(counters.turn)}`;
    const turnRows = unwrapped(samples);
    const fromRad = (turnRows[0] as Row)[2];
    const toRad = (turnRows[turnRows.length - 1] as Row)[2];
    const at = samples[0] as Row;
    steps.push({
      id,
      kind: "path",
      segments: [{ kind: "line", from: driven ? "current" : pose(at), to: pose(at) }],
      heading: { mode: "linear", fromRad, toRad },
    });
    driven = true;
    warnings.push(
      `From ${seconds(fromS)} to ${seconds(toS)} the robot turns ${degrees(toRad - fromRad)} without moving; it became the step ${id}, a path that starts and ends at the same point. Check it before you deploy it: the time estimate does not count the turn.`,
    );
  }
  if (steps.length === 0) {
    steps.push({ id: "wait1", kind: "wait", seconds: 0 });
    warnings.push("The trajectory never moves; the auto it makes is one wait.");
  }

  warnings.push(
    `The trajectory runs ${seconds(projection.totalS)}. The auto is timed from this project's robot.json, not from the file, so compare its estimate before you share it. To see the file's own timing beside your auto, load it in the Partners panel instead.`,
  );
  const phases = projection.phases.length;
  const claims = projection.claims.length;
  const envelopes = projection.envelopes.length;
  if (phases + claims + envelopes > 0) {
    const parts = [
      phases > 0 ? `${String(phases)} ${phases === 1 ? "phase" : "phases"}` : null,
      claims > 0 ? `${String(claims)} ${claims === 1 ? "claim" : "claims"}` : null,
      envelopes > 0 ? `${String(envelopes)} ${envelopes === 1 ? "envelope" : "envelopes"}` : null,
    ].filter((part): part is string => part !== null);
    warnings.push(
      `The file's ${parts.join(", ")} were not imported: an auto gets its phases and claims from its own steps and commands. Add the commands and envelopes your routine needs to the auto.`,
    );
  }
  const box = projection.boundingBox;
  warnings.push(
    `The file gives the robot's size as ${String(box.lengthIn)} in long and ${String(box.widthIn)} in wide; robot.json was not changed.`,
  );

  const file = json as { source?: { planner?: string } };
  const planner = file.source?.planner;
  const auto: Record<string, unknown> = { $schema: SCHEMA_ID.auto, formatVersion: FORMAT_VERSIONS.auto, name };
  const title = options.title ?? projection.title;
  if (title !== undefined) auto["title"] = title;
  auto["description"] = `Imported from a trajectory.json file${planner === undefined || planner === "" ? "" : ` written by ${planner}`}.`;
  auto["alliance"] = projection.alliance;
  auto["start"] = { pose: { xIn: start[0], yIn: start[1], headingRad: start[2], provenance: TRAJECTORY_AUTO_PROVENANCE } };
  auto["steps"] = steps;
  return {
    auto: parseAuto(auto),
    robotFootprint: { lengthIn: box.lengthIn, widthIn: box.widthIn },
    totalS: projection.totalS,
    warnings,
  };
}
