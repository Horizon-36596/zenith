import {
  FORMAT_VERSIONS,
  parseAuto,
  SCHEMA_ID,
  type Auto,
  type Field,
  type Heading,
  type HeadingRange,
  type Pose,
  type RangeHeading,
  type Segment,
  type Step,
} from "@horizon36596/zenith-schema";
import { stepIdFrom, stepIdProblem } from "@horizon36596/zenith-core";
import { ImportError, jsonPath, type ImportIssue } from "../errors.js";
import { headingToField, pointToField, presetSeasonWarning, turnToField, type FrameSpec } from "../frame.js";
import { resolveFrame } from "../trajectory/importTrajectory.js";
import {
  pathFileSchema,
  type PathFile,
  type PathFileHeading,
  type PathFilePose,
  type PathFileRangeHeading,
  type PathFileSegment,
} from "./schema.js";

/** The label every pose the `path.json` importer writes carries (CLAUDE.md rule 4). */
export const PATH_PROVENANCE = "CARRIED OVER (path.json import)";

/** How far apart two points may be, in field inches, and still count as the same point. */
const SAME_POINT_IN = 1e-6;
/** How far a piecewise range boundary may miss its neighbour, as a fraction of the step. */
const RANGE_TOLERANCE = 1e-9;

/** The shape an auto's `name` must have (the CLI refuses anything else). */
const AUTO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface PathImportOptions {
  /** The auto's `name`, also its file name. Default `imported-path`. */
  name?: string;
  /** The auto's title. Default: the file's own `title`, when it has one. */
  title?: string;
  /** Written as the auto's `robot` and `field` paths when given. */
  robotPath?: string;
  fieldPath?: string;
}

export interface PathImportResult {
  auto: Auto;
  /** Full sentences, in file order: everything that was changed or could not be checked. */
  warnings: string[];
}

interface FieldPoint {
  xIn: number;
  yIn: number;
}

const gap = (a: FieldPoint, b: FieldPoint): number => Math.hypot(a.xIn - b.xIn, a.yIn - b.yIn);

/** Converts one file's contents into the season's field frame. */
class Converter {
  constructor(private readonly frame: FrameSpec) {}

  point(p: { x: number; y: number }): FieldPoint {
    return pointToField(this.frame, p.x, p.y);
  }

  pose(p: PathFilePose): Pose {
    const at = this.point(p);
    return p.heading === undefined
      ? { xIn: at.xIn, yIn: at.yIn, provenance: PATH_PROVENANCE }
      : { xIn: at.xIn, yIn: at.yIn, headingRad: headingToField(this.frame, p.heading), provenance: PATH_PROVENANCE };
  }

  control(p: { x: number; y: number }): Pose {
    const at = this.point(p);
    return { xIn: at.xIn, yIn: at.yIn, provenance: PATH_PROVENANCE };
  }

  segment(segment: PathFileSegment): Segment {
    return segment.kind === "line"
      ? { kind: "line", from: this.pose(segment.from), to: this.pose(segment.to) }
      : { kind: "bezier", from: this.pose(segment.from), control: segment.control.map((p) => this.control(p)), to: this.pose(segment.to) };
  }

  rangeHeading(heading: PathFileRangeHeading): RangeHeading {
    switch (heading.mode) {
      case "tangent":
      case "tangentReversed":
        return { mode: heading.mode };
      case "constant":
        return { mode: "constant", headingRad: headingToField(this.frame, heading.heading) };
      case "linear": {
        // Zenith's linear turns from fromRad to toRad as written, so the turn is carried over as a
        // turn (its size and direction), not as a second heading that could wrap the other way.
        const fromRad = headingToField(this.frame, heading.from);
        return { mode: "linear", fromRad, toRad: fromRad + turnToField(this.frame, heading.to - heading.from) };
      }
      case "facePoint": {
        const at = this.point(heading);
        return heading.offset === undefined
          ? { mode: "facePoint", xIn: at.xIn, yIn: at.yIn }
          : { mode: "facePoint", xIn: at.xIn, yIn: at.yIn, offsetRad: turnToField(this.frame, heading.offset) };
      }
    }
  }

  heading(heading: PathFileHeading): Heading {
    if (heading.mode !== "piecewise") return this.rangeHeading(heading);
    const ranges: HeadingRange[] = heading.ranges.map((range) => ({
      startT: range.startT,
      endT: range.endT,
      heading: this.rangeHeading(range.heading),
    }));
    return { mode: "piecewise", ranges };
  }
}

/**
 * The problems that make a file's structure unusable even though every value has the right type:
 * a step id used twice, a path step whose segments do not join, and piecewise ranges that do not
 * run from 0 to 1 in order with no gap and no overlap.
 */
function structureIssues(file: PathFile, converter: Converter): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const seen = new Map<string, number>();
  file.steps.forEach((step, i) => {
    const at = `steps[${String(i)}]`;
    if (step.id !== undefined) {
      const first = seen.get(step.id);
      if (first !== undefined) issues.push({ path: `${at}.id`, message: `${JSON.stringify(step.id)} is already the id of steps[${String(first)}]; step ids must be unique.` });
      else seen.set(step.id, i);
    }
    if (step.kind !== "path") return;
    step.segments.forEach((segment, k) => {
      if (k === 0) return;
      const previous = step.segments[k - 1] as PathFileSegment;
      const distance = gap(converter.point(previous.to), converter.point(segment.from));
      if (distance > SAME_POINT_IN) {
        issues.push({
          path: `${at}.segments[${String(k)}].from`,
          message: `must be where segments[${String(k - 1)}] ends; it is ${distance.toFixed(3)} in away. The segments of one path step must join.`,
        });
      }
    });
    if (step.heading?.mode !== "piecewise") return;
    const ranges = step.heading.ranges;
    ranges.forEach((range, j) => {
      const where = `${at}.heading.ranges[${String(j)}]`;
      const expectedStart = j === 0 ? 0 : (ranges[j - 1] as { endT: number }).endT;
      if (Math.abs(range.startT - expectedStart) > RANGE_TOLERANCE) {
        issues.push({
          path: `${where}.startT`,
          message:
            j === 0
              ? `is ${String(range.startT)}; the first range must start at 0.`
              : `is ${String(range.startT)}; it must be where ranges[${String(j - 1)}] ends (${String(expectedStart)}), so the ranges leave no gap and do not overlap.`,
        });
      }
      if (range.endT <= range.startT) {
        issues.push({ path: `${where}.endT`, message: `is ${String(range.endT)}; it must be after startT (${String(range.startT)}).` });
      }
      if (j === ranges.length - 1 && Math.abs(range.endT - 1) > RANGE_TOLERANCE) {
        issues.push({ path: `${where}.endT`, message: `is ${String(range.endT)}; the last range must end at 1.` });
      }
    });
  });
  return issues;
}

/**
 * Imports an interchange `path.json` as an auto in the season's field frame.
 *
 * - The file's frame is resolved the way `trajectory.json`'s is (a preset, a preset with keys
 *   overridden, or every key given), and every point, heading and turn is converted from it.
 * - Each path step becomes a `path` step with the same segments and heading mode; each wait step a
 *   `wait` step. A path step that starts where the step before it ended starts from `"current"`,
 *   the way the editor writes it.
 * - Every pose carries `CARRIED OVER (path.json import)`.
 *
 * Pure: no clock, no randomness, no file access. Throws `ImportError` naming every field that makes
 * the file unusable; everything else is a warning.
 */
export function importPath(json: unknown, field: Field, options: PathImportOptions = {}): PathImportResult {
  const parsed = pathFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ImportError(
      "the path file",
      parsed.error.issues.map((issue) => ({
        path: jsonPath(issue.path),
        message: issue.code === "unrecognized_keys" ? `${issue.message}; the path format has no such field` : issue.message,
      })),
    );
  }
  const file: PathFile = parsed.data;
  const warnings: string[] = [];

  const { frame, issues } = resolveFrame(file.frame);
  if (frame === null) throw new ImportError("the path file", issues);
  if (file.season !== field.season) {
    throw new ImportError("the path file", [
      { path: "season", message: `is ${JSON.stringify(file.season)}, but the field is ${JSON.stringify(field.season)}; a path only lines up on its own season's field.` },
    ]);
  }
  const name = options.name ?? "imported-path";
  if (!AUTO_NAME_PATTERN.test(name)) {
    throw new ImportError("the path file", [{ path: "", message: `the auto name ${JSON.stringify(name)} must use only letters, digits, ".", "_" and "-".` }]);
  }
  if (file.frame.preset !== undefined) {
    const warning = presetSeasonWarning(file.frame.preset, field);
    if (warning !== null) warnings.push(warning);
  }

  const converter = new Converter(frame);
  const problems = structureIssues(file, converter);
  if (problems.length > 0) throw new ImportError("the path file", problems);

  // Ids: the file's own where it gives them, and path1, wait1 and so on where it does not, never
  // taking an id the file uses for another step.
  const given = new Set(file.steps.flatMap((step) => (step.id === undefined ? [] : [step.id])));
  const counters = { path: 0, wait: 0 };
  const freshId = (kind: "path" | "wait"): string => {
    let id: string;
    do {
      counters[kind] += 1;
      id = `${kind}${String(counters[kind])}`;
    } while (given.has(id));
    given.add(id);
    return id;
  };

  const start = converter.point(file.startPose);
  let previousEnd: FieldPoint = start;
  let pathSteps = 0;
  // An id outside the step id rule, which the editor's rename refuses, is given one inside it
  // (`stepIdFrom`: `shoot preload` becomes `shootPreload`), so the auto opens without a STEP_ID
  // warning. A path.json file has no groups, so nothing else names a step by its id.
  const ownId = (id: string, i: number): string => {
    if (stepIdProblem(id) === null) return id;
    const fresh = stepIdFrom(id, given);
    given.add(fresh);
    warnings.push(`steps[${String(i)}].id ${JSON.stringify(id)} is not an id a step can have, so the step was imported as ${fresh}.`);
    return fresh;
  };
  const steps: Step[] = file.steps.map((step, i) => {
    const id = step.id === undefined ? freshId(step.kind) : ownId(step.id, i);
    if (step.kind === "wait") return { id, kind: "wait", seconds: step.seconds };

    const segments = step.segments.map((segment) => converter.segment(segment));
    const first = step.segments[0] as PathFileSegment;
    const distance = gap(converter.point(first.from), previousEnd);
    if (distance <= SAME_POINT_IN) {
      if (pathSteps > 0) (segments[0] as Segment).from = "current";
    } else {
      const before = pathSteps === 0 ? "startPose" : "where the path step before it ends";
      warnings.push(`steps[${String(i)}].segments[0].from is ${distance.toFixed(2)} in from ${before}; it was imported as written, and the planner will report the jump.`);
    }
    const last = step.segments[step.segments.length - 1] as PathFileSegment;
    previousEnd = converter.point(last.to);
    pathSteps += 1;

    const out: Step = { id, kind: "path", segments };
    if (step.timeoutS !== undefined) out.timeoutS = step.timeoutS;
    if (step.heading !== undefined) out.heading = converter.heading(step.heading);
    if (step.speedFraction !== undefined) out.speedFraction = step.speedFraction;
    return out;
  });
  if (pathSteps === 0) warnings.push("The file has no path step, only waits; the auto it makes does not drive.");

  const planner = file.source?.planner;
  const auto: Record<string, unknown> = {
    $schema: SCHEMA_ID.auto,
    formatVersion: FORMAT_VERSIONS.auto,
    name,
  };
  const title = options.title ?? file.title;
  if (title !== undefined) auto["title"] = title;
  auto["description"] = `Imported from a path.json file${planner === undefined || planner === "" ? "" : ` written by ${planner}`}.`;
  if (options.robotPath !== undefined) auto["robot"] = options.robotPath;
  if (options.fieldPath !== undefined) auto["field"] = options.fieldPath;
  auto["alliance"] = file.alliance;
  auto["start"] = {
    pose: { xIn: start.xIn, yIn: start.yIn, headingRad: headingToField(frame, file.startPose.heading), provenance: PATH_PROVENANCE },
  };
  auto["steps"] = steps;
  return { auto: parseAuto(auto), warnings };
}
