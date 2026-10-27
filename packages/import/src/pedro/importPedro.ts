import { makePath, STEP_ID_MAX } from "@horizon36596/zenith-core";
import {
  FORMAT_VERSIONS,
  parseAuto,
  SCHEMA_ID,
  type Auto,
  type Field,
  type Heading,
  type HeadingRange,
  type RangeHeading,
  type Segment,
  type Step,
} from "@horizon36596/zenith-schema";
import { interpolateThrough, reduceDegree, type Point } from "../bezier.js";
import { ImportError, type ImportIssue } from "../errors.js";
import {
  headingToField,
  PEDRO_VISUALIZER_CENTRE_IN,
  pointToField,
  presetFrame,
  presetSeasonWarning,
  turnToField,
  wrap,
  type FrameSpec,
} from "../frame.js";
import {
  ANY_HEADING_KEYS,
  END_POINT_KEYS,
  HEADING_KEYS,
  LEGACY_TOP_LEVEL_KEYS,
  isNewerVersion,
  MOTION_SETTING_KEYS,
  PATH_KEYS,
  PEDRO_PROJECT_VERSION,
  pedroSizeIssues,
  PIECEWISE_HEADING_KEYS,
  PIECEWISE_PARAMETER_KEYS,
  PIECEWISE_SEGMENT_KEYS,
  POINT_KEYS,
  SEQUENCE_KEYS,
  SETTINGS_KEYS,
  START_POINT_KEYS,
  TOP_LEVEL_KEYS,
  VERIFIED_FIELD_MAP,
} from "./format.js";

/** The label every number the `.pp` importer writes carries (CLAUDE.md rule 4). */
export const PEDRO_PROVENANCE = "CARRIED OVER (Pedro Visualizer import)";

/** The prefix of the placeholder commands a sequence item of an unknown kind becomes. */
export const PLACEHOLDER_COMMAND_PREFIX = "imported";

/** The shape an auto's `name` must have (the CLI refuses anything else, `autoLoad.ts`). */
const AUTO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface PedroImportOptions {
  /** The auto's `name`, also its file name. Default `imported-pedro`. */
  name?: string;
  title?: string;
  /** The alliance the path was drawn for. Default: the field's canonical alliance, with a warning. */
  alliance?: "RED" | "BLUE";
  /** Written as the auto's `robot` and `field` paths when given. */
  robotPath?: string;
  fieldPath?: string;
  /**
   * The visualizer's field centre in its own inches. Default 70.75, half its 141.5 in field
   * (ADR 0008 section 2); a team that treats (72, 72) as the centre passes 72.
   */
  centreIn?: number;
}

export interface PedroImportResult {
  auto: Auto;
  /** From `settings.rWidth` (along the heading) and `settings.rHeight` (side to side), when the file has them. */
  robotFootprint?: { lengthIn: number; widthIn: number; provenance: string };
  /** Full sentences, in file order: everything that was changed, approximated, left out or not understood. */
  warnings: string[];
  /**
   * The alliance the auto was written for when the caller passed none: the field's canonical
   * alliance, which `assumedAllianceWarning` names among the warnings. Absent when the caller chose.
   */
  assumedAlliance?: "RED" | "BLUE";
}

/**
 * The warning for a `.pp` file imported with no alliance given, since the format does not record
 * one. It says how the command line and the MCP tool choose the other alliance; the editor, which
 * offers its own choice, puts its own sentence in its place.
 */
export const assumedAllianceWarning = (alliance: "RED" | "BLUE"): string =>
  `A .pp file does not say which alliance it is for; the auto was written for ${alliance}. Pass the alliance if the path was drawn for the other one.`;

type Json = Record<string, unknown>;

interface PedroPoint {
  x: number;
  y: number;
}

interface PiecewisePart {
  startProgress: number;
  endProgress: number;
  type: "linear" | "constant" | "tangential" | "facing-point";
  reversed: boolean;
  continueFromPrevious: boolean;
  startDeg: number;
  endDeg: number;
  degrees: number;
  point: PedroPoint;
}

type PedroHeading =
  | { type: "linear"; startDeg: number; endDeg: number }
  | { type: "constant"; degrees: number }
  | { type: "tangential"; reverse: boolean }
  | { type: "piecewise"; parts: PiecewisePart[] };

interface AtomicNode {
  kind: "atomic";
  id: string;
  name: string;
  where: string;
  end: PedroPoint;
  controls: PedroPoint[];
  through: PedroPoint[];
  heading: PedroHeading;
}

interface CompoundNode {
  kind: "compound";
  id: string;
  name: string;
  where: string;
  children: PathNode[];
  heading: PedroHeading | undefined;
}

type PathNode = AtomicNode | CompoundNode;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Reads a `.pp` document, collecting issues that stop the import and warnings that do not. */
class Reader {
  readonly issues: ImportIssue[] = [];
  readonly warnings: string[] = [];
  /** The paths whose heading is in the form of versions up to 1.3.0, reported in one warning. */
  readonly legacyHeadings: string[] = [];
  private generatedIds = 0;

  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  unknownKeys(value: Json, known: readonly string[], where: string): void {
    const extra = Object.keys(value).filter((key) => !known.includes(key));
    for (const key of extra) {
      const at = where === "" ? key : `${where}.${key}`;
      this.warn(`${at} is not a field Pedro Visualizer ${PEDRO_PROJECT_VERSION} writes; it was not imported.`);
    }
  }

  number(value: Json, key: string, where: string, fallback?: number): number {
    const raw = value[key];
    if (isFiniteNumber(raw)) return raw;
    const at = `${where}.${key}`;
    if (raw === undefined && fallback !== undefined) return fallback;
    if (raw === undefined) this.fail(at, "must be a number, and it is missing.");
    else this.fail(at, `must be a finite number; got ${JSON.stringify(raw)}.`);
    return fallback ?? 0;
  }

  point(value: unknown, where: string, known: readonly string[] = POINT_KEYS): PedroPoint {
    if (!isObject(value)) {
      this.fail(where, value === undefined ? "must be a point { x, y }, and it is missing." : "must be a point { x, y }.");
      return { x: 0, y: 0 };
    }
    this.unknownKeys(value, known, where);
    return { x: this.number(value, "x", where), y: this.number(value, "y", where) };
  }

  points(value: unknown, where: string): PedroPoint[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.fail(where, "must be a list of points.");
      return [];
    }
    return value.map((item, i) => this.point(item, `${where}[${String(i)}]`));
  }

  freshId(): string {
    this.generatedIds += 1;
    return `line-${String(this.generatedIds)}`;
  }

  heading(raw: unknown, where: string, legacySource: Json | undefined): PedroHeading {
    if (isObject(raw) && typeof raw["type"] === "string") return this.headingObject(raw, where);
    // Older files: a bare string here and the numbers on the end point, or everything on the end
    // point (`normalizeHeading` in the visualizer).
    const legacy: Json = { ...(legacySource ?? {}) };
    if (typeof raw === "string") legacy["heading"] = raw;
    const kind = legacy["heading"];
    if (kind === undefined) {
      if (raw !== undefined) this.fail(where, "must be a heading object with a type.");
      else this.warn(`${where} is missing; the visualizer draws such a path with a tangential heading, and so does the import.`);
      return { type: "tangential", reverse: false };
    }
    this.legacyHeadings.push(where);
    switch (kind) {
      case "linear":
        return { type: "linear", startDeg: this.number(legacy, "startDeg", where, 0), endDeg: this.number(legacy, "endDeg", where, 0) };
      case "constant":
        return { type: "constant", degrees: this.number(legacy, "degrees", where, 0) };
      case "tangential":
        return { type: "tangential", reverse: legacy["reverse"] === true };
      case "piecewise":
        return isObject(legacy["piecewiseHeading"])
          ? this.headingObject({ type: "piecewise", piecewiseHeading: legacy["piecewiseHeading"] }, where)
          : { type: "tangential", reverse: false };
      default:
        this.fail(where, `names the heading ${JSON.stringify(kind)}, which is not linear, constant, tangential or piecewise.`);
        return { type: "tangential", reverse: false };
    }
  }

  private headingObject(raw: Json, where: string): PedroHeading {
    const type = raw["type"] as string;
    const known = HEADING_KEYS[type];
    if (known === undefined) {
      this.fail(`${where}.type`, `must be linear, constant, tangential or piecewise; got ${JSON.stringify(type)}.`);
      return { type: "tangential", reverse: false };
    }
    // Keys of another heading type are the picker's leftovers (ANY_HEADING_KEYS), not unknown fields.
    this.unknownKeys(raw, ANY_HEADING_KEYS, where);
    switch (type) {
      case "linear":
        return { type, startDeg: this.number(raw, "startDeg", where), endDeg: this.number(raw, "endDeg", where) };
      case "constant":
        return { type, degrees: this.number(raw, "degrees", where) };
      case "tangential":
        return { type, reverse: raw["reverse"] === true };
      default:
        return { type: "piecewise", parts: this.piecewise(raw["piecewiseHeading"], `${where}.piecewiseHeading`) };
    }
  }

  private piecewise(raw: unknown, where: string): PiecewisePart[] {
    if (!isObject(raw) || !Array.isArray(raw["segments"])) {
      this.fail(`${where}.segments`, "must be a list of heading segments.");
      return [];
    }
    this.unknownKeys(raw, PIECEWISE_HEADING_KEYS, where);
    if (raw["scope"] === "chain") {
      this.warn(
        `${where}.scope is "chain": visualizer versions up to 1.3.0 spread this heading over the whole path chain. The current visualizer applies it to this path alone, and so does the import; check the heading.`,
      );
    }
    const parts: PiecewisePart[] = [];
    raw["segments"].forEach((item, i) => {
      const at = `${where}.segments[${String(i)}]`;
      if (!isObject(item)) {
        this.fail(at, "must be a heading segment object.");
        return;
      }
      this.unknownKeys(item, PIECEWISE_SEGMENT_KEYS, at);
      const type = item["interpolationType"] ?? "linear";
      if (type !== "linear" && type !== "constant" && type !== "tangential" && type !== "facing-point") {
        this.fail(`${at}.interpolationType`, `must be linear, constant, tangential or facing-point; got ${JSON.stringify(type)}.`);
        return;
      }
      const parameters: Json = isObject(item["parameters"]) ? item["parameters"] : {};
      if (isObject(item["parameters"])) this.unknownKeys(parameters, PIECEWISE_PARAMETER_KEYS, `${at}.parameters`);
      const missing = (key: string): void =>
        this.warn(`${at}.parameters.${key} is missing; the visualizer uses 0, and so does the import.`);
      if (type === "linear" && !isFiniteNumber(parameters["startDeg"])) missing("startDeg");
      if (type === "linear" && !isFiniteNumber(parameters["endDeg"])) missing("endDeg");
      if (type === "constant" && !isFiniteNumber(parameters["degrees"])) missing("degrees");
      let point: PedroPoint = { x: 0, y: 0 };
      if (type === "facing-point") {
        if (parameters["point"] === undefined) {
          this.warn(`${at}.parameters.point is missing; the visualizer faces (0, 0), and so does the import.`);
        } else {
          point = this.point(parameters["point"], `${at}.parameters.point`);
        }
      }
      parts.push({
        startProgress: isFiniteNumber(item["startProgress"]) ? item["startProgress"] : 0,
        endProgress: isFiniteNumber(item["endProgress"]) ? item["endProgress"] : 1,
        type,
        reversed: type !== "constant" && item["reversed"] === true,
        continueFromPrevious: (type === "linear" || type === "constant") && item["continueFromPrevious"] === true,
        startDeg: isFiniteNumber(parameters["startDeg"]) ? parameters["startDeg"] : 0,
        endDeg: isFiniteNumber(parameters["endDeg"]) ? parameters["endDeg"] : 0,
        degrees: isFiniteNumber(parameters["degrees"]) ? parameters["degrees"] : 0,
        point,
      });
    });
    return repairPiecewise(parts, where, this);
  }

  path(raw: unknown, where: string, depth: number): PathNode | null {
    if (!isObject(raw)) {
      this.fail(where, "must be a path object.");
      return null;
    }
    this.unknownKeys(raw, PATH_KEYS, where);
    const id = typeof raw["id"] === "string" && raw["id"] !== "" ? raw["id"] : this.freshId();
    const name = typeof raw["name"] === "string" ? raw["name"] : "";
    // The visualizer takes a path's pause from `waitAfterMs`, or, in older files, from the
    // `waitAfter` object (`normalizeCommon`); the same for `waitBeforeMs` and `waitBefore`.
    const pause = (msKey: string, objectKey: string): { ms: number; at: string } | null => {
      if (raw[msKey] !== undefined) return isFiniteNumber(raw[msKey]) && raw[msKey] > 0 ? { ms: raw[msKey], at: `${where}.${msKey}` } : null;
      const object = raw[objectKey];
      const ms = isObject(object) ? object["durationMs"] : undefined;
      return isFiniteNumber(ms) && ms > 0 ? { ms, at: `${where}.${objectKey}.durationMs` } : null;
    };
    const after = pause("waitAfterMs", "waitAfter");
    if (after !== null) {
      this.warn(
        `${after.at} (${String(after.ms)} ms) is a pause the visualizer shows in playback only and leaves out of its code export; it was not imported. Add a wait step if the robot should stop there.`,
      );
    }
    const before = pause("waitBeforeMs", "waitBefore");
    if (before !== null) {
      this.warn(`${before.at} (${String(before.ms)} ms) is not used by the visualizer; it was not imported.`);
    }
    const isCompound = raw["kind"] === "compound" || (raw["kind"] === undefined && Array.isArray(raw["segments"]));
    if (isCompound) {
      if (!Array.isArray(raw["segments"])) {
        this.fail(`${where}.segments`, "must be a list of paths in a compound path.");
        return null;
      }
      if (depth > 8) {
        this.fail(where, "nests compound paths more than eight deep.");
        return null;
      }
      const children = raw["segments"]
        .map((child, i) => this.path(child, `${where}.segments[${String(i)}]`, depth + 1))
        .filter((child): child is PathNode => child !== null);
      if (children.length === 0) {
        this.fail(`${where}.segments`, "holds no paths.");
        return null;
      }
      const heading = raw["heading"] === undefined ? undefined : this.heading(raw["heading"], `${where}.heading`, undefined);
      return { kind: "compound", id, name, where, children, heading };
    }
    if (raw["kind"] !== undefined && raw["kind"] !== "atomic") {
      this.fail(`${where}.kind`, `must be atomic or compound; got ${JSON.stringify(raw["kind"])}.`);
      return null;
    }
    const endRaw = raw["endPoint"];
    const end = this.point(endRaw, `${where}.endPoint`, END_POINT_KEYS);
    const controls = this.points(raw["controlPoints"], `${where}.controlPoints`);
    const through = this.points(raw["throughPoints"], `${where}.throughPoints`);
    const heading = this.heading(raw["heading"], `${where}.heading`, isObject(endRaw) ? endRaw : undefined);
    return { kind: "atomic", id, name, where, end, controls, through, heading };
  }
}

/**
 * The visualizer's own repair of a piecewise heading (`normalizePiecewiseHeadingInterpolation`):
 * sorted by start, each starting where the one before ended, the first at 0, the last at 1, and no
 * stretch shorter than 0.0001. A file that needed repairing gets a warning, since the visualizer
 * shows the repaired ranges, not the stored ones.
 */
function repairPiecewise(parts: PiecewisePart[], where: string, reader: Reader): PiecewisePart[] {
  const sorted = [...parts].sort((a, b) => a.startProgress - b.startProgress);
  const repaired: PiecewisePart[] = [];
  let cursor = 0;
  sorted.forEach((part, index) => {
    const isLast = index === sorted.length - 1;
    const start = index === 0 ? 0 : cursor;
    if (index > 0 && start >= 1) return;
    const desired = isLast ? 1 : Math.max(part.endProgress, start + 0.0001);
    const end = Math.min(Math.max(desired, start + 0.0001), 1);
    repaired.push({ ...part, startProgress: start, endProgress: end, continueFromPrevious: index > 0 && part.continueFromPrevious });
    cursor = end;
  });
  const changed =
    repaired.length !== parts.length ||
    repaired.some((part, i) => part.startProgress !== parts[i]?.startProgress || part.endProgress !== parts[i]?.endProgress);
  if (changed && repaired.length > 0) {
    reader.warn(`${where}.segments leave a gap, overlap or do not run from 0 to 1; they were closed up the way the visualizer closes them.`);
  }
  if (repaired.length === 0) {
    reader.warn(`${where}.segments is empty; the visualizer uses one linear segment from 0 to 0 degrees, and so does the import.`);
    return [
      { startProgress: 0, endProgress: 1, type: "linear", reversed: false, continueFromPrevious: false, startDeg: 0, endDeg: 0, degrees: 0, point: { x: 0, y: 0 } },
    ];
  }
  return repaired;
}

/** The field-frame geometry of a run of control polygons, for headings that depend on it. */
interface Geometry {
  polygons: Point[][];
  lengthIn: number;
  pointAt(t: number): Point;
  /** Direction of travel at arc-length fraction t, field-frame radians. */
  tangentRadAt(t: number): number;
}

function geometryOf(polygons: Point[][]): Geometry {
  const path = makePath(polygons);
  return {
    polygons,
    lengthIn: path.lengthIn,
    pointAt: (t) => path.pointAt(t),
    tangentRadAt: (t) => {
      const v = path.tangentAt(t);
      return Math.atan2(v.yIn, v.xIn);
    },
  };
}

interface Leaf {
  node: AtomicNode;
  start: Point;
  polygons: Point[][];
  lengthIn: number;
}

/** A stretch of a step, in inches along it, with the heading that applies across it. */
interface HeadingSpan {
  startIn: number;
  endIn: number;
  heading: Heading;
}

const sameHeading = (a: Heading, b: Heading): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The turn from `startDeg` to `endDeg` the visualizer draws for a linear heading, in its degrees:
 * `getAngularDifference` in its `src/utils/math.ts`, reproduced exactly. It is the short way round,
 * and an exact half turn goes counter-clockwise when the end's angle in [0, 360) is the larger one
 * and clockwise otherwise, so 90 to -90 turns +180 and -90 to 90 turns -180.
 */
export function visualizerTurnDeg(startDeg: number, endDeg: number): number {
  const start = (startDeg + 360) % 360;
  const end = (endDeg + 360) % 360;
  let turn = end - start;
  if (turn > 180) turn -= 360;
  else if (turn < -180) turn += 360;
  return turn;
}

/** A turn of at least half a turn, which one linear range cannot hold with its direction. */
const isHalfTurnOrMore = (turnRad: number): boolean => Math.abs(turnRad) >= Math.PI - 1e-9;

/**
 * How far short of half a turn each piece of a cut turn stays, in radians. Canonical form rounds
 * radians to four decimals, so a piece of exactly half a turn could be written a hair either side
 * of pi and turn either way; one of a whole turn's two halves is exactly that.
 */
const PIECE_MARGIN_RAD = 0.01;

/**
 * A turn of `turnRad` from `fromRad` over [startT, endT] as equal linear ranges, two of them, or
 * three for a turn too close to a whole turn for two halves to stay clear of half a turn each.
 * Zenith's linear range, like Pedro's, turns the short way, so a turn of half a turn or more keeps
 * its direction only when it is cut, and each piece must stay short of half a turn after rounding.
 */
function splitTurn(startT: number, endT: number, fromRad: number, turnRad: number): HeadingRange[] {
  const count = Math.max(2, Math.ceil(Math.abs(turnRad) / (Math.PI - PIECE_MARGIN_RAD)));
  const ranges: HeadingRange[] = [];
  for (let k = 0; k < count; k += 1) {
    ranges.push({
      startT: startT + ((endT - startT) * k) / count,
      endT: k === count - 1 ? endT : startT + ((endT - startT) * (k + 1)) / count,
      heading: { mode: "linear", fromRad: fromRad + (turnRad * k) / count, toRad: fromRad + (turnRad * (k + 1)) / count },
    });
  }
  return ranges;
}

/** An angle in degrees wrapped to (-180, 180], as the visualizer's `normalizeAngleDegrees` does. */
function normalizeDeg(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

/** Converts `.pp` content to Zenith's frame and step list. */
class Converter {
  private readonly frame: FrameSpec;

  constructor(
    private readonly reader: Reader,
    centreIn: number,
  ) {
    this.frame = presetFrame("pedro", centreIn);
  }

  point(p: PedroPoint): Point {
    return pointToField(this.frame, p.x, p.y);
  }

  headingRad(deg: number): number {
    return headingToField(this.frame, deg);
  }

  /** One leaf's control polygons: through points solved the way Pedro does, and degree kept within the format. */
  leaf(node: AtomicNode, start: Point): Leaf {
    let polygon: Point[];
    if (node.through.length > 0) {
      if (node.controls.length > 0) {
        this.reader.warn(`${node.where} has both controlPoints and throughPoints; the visualizer uses the through points, and so does the import.`);
      }
      polygon = interpolateThrough([start, ...node.through.map((p) => this.point(p)), this.point(node.end)]);
      this.reader.warn(
        `${node.where}.throughPoints (the visualizer's experimental curve-through) was imported as the single Bézier curve Pedro's BezierCurve.through builds through those points. The visualizer draws a Catmull-Rom spline through them instead, so the two can differ between the points; check the curve in the editor.`,
      );
    } else {
      polygon = [start, ...node.controls.map((p) => this.point(p)), this.point(node.end)];
    }
    const { polygons, maxErrorIn } = reduceDegree(polygon);
    if (polygons.length > 1) {
      this.reader.warn(
        `${node.where} is a Bézier curve with ${String(polygon.length - 2)} control points, and an auto file allows at most three; it was replaced by ${String(polygons.length)} cubic curves that stay within ${maxErrorIn.toFixed(3)} in of it.`,
      );
    }
    return { node, start, polygons, lengthIn: geometryOf(polygons).lengthIn };
  }

  /**
   * A `.pp` heading as a Zenith heading over the geometry it applies to. Only a piecewise heading
   * reads the geometry, for a range that continues from a tangential or facing-point one.
   */
  heading(heading: PedroHeading, geometry: Geometry, where: string): Heading {
    switch (heading.type) {
      case "tangential":
        return { mode: heading.reverse ? "tangentReversed" : "tangent" };
      case "constant":
        return { mode: "constant", headingRad: this.headingRad(heading.degrees) };
      case "linear": {
        // The visualizer turns the short way; Zenith's linear turns from fromRad to toRad as written.
        const fromRad = this.headingRad(heading.startDeg);
        const turnRad = turnToField(this.frame, visualizerTurnDeg(heading.startDeg, heading.endDeg));
        if (!isHalfTurnOrMore(turnRad)) return { mode: "linear", fromRad, toRad: fromRad + turnRad };
        this.halfTurnWarning(where, heading.startDeg, heading.endDeg, turnRad);
        return { mode: "piecewise", ranges: splitTurn(0, 1, fromRad, turnRad) };
      }
      case "piecewise":
        return { mode: "piecewise", ranges: this.ranges(heading.parts, geometry, where) };
    }
  }

  private halfTurnWarning(where: string, startDeg: number, endDeg: number, turnRad: number): void {
    this.reader.warn(
      `${where} turns exactly half a turn, from ${String(Number(startDeg.toFixed(1)))} to ${String(Number(endDeg.toFixed(1)))} degrees, which the visualizer draws turning ${turnRad > 0 ? "counter-clockwise" : "clockwise"}. A single half-turn heading has no direction of its own (Pedro turns it clockwise, and rounding can flip it), so the import writes it as two quarter turns that turn the way the visualizer draws it.`,
    );
  }

  private partEndRad(parts: readonly PiecewisePart[], index: number, geometry: Geometry): number {
    const part = parts[index] as PiecewisePart;
    switch (part.type) {
      case "linear":
        return this.headingRad(part.endDeg);
      case "constant":
        return part.continueFromPrevious && index > 0 ? this.partEndRad(parts, index - 1, geometry) : this.headingRad(part.degrees);
      case "tangential":
        return wrap(geometry.tangentRadAt(part.endProgress) + (part.reversed ? Math.PI : 0));
      case "facing-point": {
        const at = geometry.pointAt(part.endProgress);
        const target = this.point(part.point);
        return wrap(Math.atan2(target.yIn - at.yIn, target.xIn - at.xIn) + (part.reversed ? Math.PI : 0));
      }
    }
  }

  /**
   * The angle part `index` ends on in the visualizer's own degrees (`piecewiseSegmentEndAngle`),
   * which a continued linear part turns from. A linear or constant end is kept in degrees rather
   * than taken back from radians, since that round trip can move an exact half turn a hair either
   * way and flip its direction. The Pedro frame's headings are the field frame's (ADR 0008 section
   * 2), so an end read from the geometry is the same angle in degrees.
   */
  private partEndDeg(parts: readonly PiecewisePart[], index: number, geometry: Geometry): number {
    const part = parts[index] as PiecewisePart;
    switch (part.type) {
      case "linear":
        return normalizeDeg(part.endDeg);
      case "constant":
        return part.continueFromPrevious && index > 0 ? this.partEndDeg(parts, index - 1, geometry) : normalizeDeg(part.degrees);
      default:
        return (this.partEndRad(parts, index, geometry) * 180) / Math.PI;
    }
  }

  private ranges(parts: readonly PiecewisePart[], geometry: Geometry, where: string): HeadingRange[] {
    const ranges: HeadingRange[] = [];
    parts.forEach((part, index) => {
      const startT = part.startProgress;
      const endT = part.endProgress;
      const linked = part.continueFromPrevious && index > 0 ? this.partEndRad(parts, index - 1, geometry) : null;
      const at = `${where}.segments[${String(index)}]`;
      switch (part.type) {
        case "tangential":
          ranges.push({ startT, endT, heading: { mode: part.reversed ? "tangentReversed" : "tangent" } });
          return;
        case "constant":
          ranges.push({ startT, endT, heading: { mode: "constant", headingRad: linked ?? this.headingRad(part.degrees) } });
          return;
        case "facing-point": {
          const target = this.point(part.point);
          const heading: RangeHeading = part.reversed
            ? { mode: "facePoint", xIn: target.xIn, yIn: target.yIn, offsetRad: Math.PI }
            : { mode: "facePoint", xIn: target.xIn, yIn: target.yIn };
          if (part.reversed) {
            this.reader.warn(
              `${at} faces away from its point (reversed). It was imported as facePoint with offsetRad pi, which the planner draws; the robot runtime does not apply offsetRad yet, so check this range before running it.`,
            );
          }
          ranges.push({ startT, endT, heading });
          return;
        }
        case "linear": {
          const fromRad = linked ?? this.headingRad(part.startDeg);
          const fromDeg = linked === null ? part.startDeg : this.partEndDeg(parts, index - 1, geometry);
          const shortest = turnToField(this.frame, visualizerTurnDeg(fromDeg, part.endDeg));
          if (!part.reversed) {
            if (!isHalfTurnOrMore(shortest)) {
              ranges.push({ startT, endT, heading: { mode: "linear", fromRad, toRad: fromRad + shortest } });
              return;
            }
            ranges.push(...splitTurn(startT, endT, fromRad, shortest));
            this.halfTurnWarning(at, fromDeg, part.endDeg, shortest);
            return;
          }
          // Reversed: the visualizer turns the long way round (`reversedRotation`). Zenith's linear
          // turns the short way within a range, so the long turn is cut into two or three ranges.
          const longWay = shortest >= 0 ? shortest - 2 * Math.PI : shortest + 2 * Math.PI;
          ranges.push(...splitTurn(startT, endT, fromRad, longWay));
          this.reader.warn(
            `${at} is a reversed linear heading. The visualizer draws it turning the long way round, and the import does the same, as two ranges (three for nearly a whole turn); the visualizer's own code export writes it as linear(...).reverse(), which instead adds half a turn.`,
          );
          return;
        }
      }
    });
    return ranges;
  }

  /** The heading spans of one top-level path, with each group heading replacing its children's. */
  spans(node: PathNode, leaves: readonly Leaf[], offsetIn: { value: number }): HeadingSpan[] {
    const leavesOf = (n: PathNode): Leaf[] => leaves.filter((leaf) => isInside(leaf.node, n));
    if (node.kind === "atomic") {
      const leaf = leaves.find((l) => l.node === node);
      if (leaf === undefined) return [];
      const startIn = offsetIn.value;
      offsetIn.value += leaf.lengthIn;
      return [{ startIn, endIn: offsetIn.value, heading: this.heading(node.heading, geometryOf(leaf.polygons), `${node.where}.heading`) }];
    }
    if (node.heading !== undefined) {
      const mine = leavesOf(node);
      if (mine.length === 0) return [];
      const startIn = offsetIn.value;
      const lengthIn = mine.reduce((sum, leaf) => sum + leaf.lengthIn, 0);
      offsetIn.value += lengthIn;
      const geometry = geometryOf(mine.flatMap((leaf) => leaf.polygons));
      return [{ startIn, endIn: offsetIn.value, heading: this.heading(node.heading, geometry, `${node.where}.heading`) }];
    }
    return node.children.flatMap((child) => this.spans(child, leaves, offsetIn));
  }
}

function isInside(leaf: AtomicNode, node: PathNode): boolean {
  if (node === leaf) return true;
  return node.kind === "compound" && node.children.some((child) => isInside(leaf, child));
}

function flattenLeaves(node: PathNode): AtomicNode[] {
  return node.kind === "atomic" ? [node] : node.children.flatMap(flattenLeaves);
}

/**
 * One step's heading from its spans: a single span's heading as it is; several that all agree on a
 * heading that does not depend on where it starts (tangent, reverse tangent or one constant angle)
 * as that one heading; anything else as a piecewise heading over the spans' shares of the step's
 * length, with a piecewise span's own ranges scaled into its share.
 */
function stepHeading(spans: readonly HeadingSpan[], totalIn: number): Heading {
  const first = spans[0] as HeadingSpan;
  if (spans.length === 1) return first.heading;
  const uniform = first.heading.mode === "tangent" || first.heading.mode === "tangentReversed" || first.heading.mode === "constant";
  if (uniform && spans.every((span) => sameHeading(span.heading, first.heading))) return first.heading;
  const ranges: HeadingRange[] = [];
  spans.forEach((span, i) => {
    const s0 = span.startIn / totalIn;
    const s1 = i === spans.length - 1 ? 1 : span.endIn / totalIn;
    if (s1 <= s0) return;
    const local = span.heading.mode === "piecewise" ? span.heading.ranges : [{ startT: 0, endT: 1, heading: span.heading as RangeHeading }];
    for (const range of local) {
      ranges.push({ startT: s0 + range.startT * (s1 - s0), endT: s0 + range.endT * (s1 - s0), heading: range.heading });
    }
  });
  // Close the seams exactly, so floating-point sums cannot leave a gap HEADING_RANGES would report.
  ranges.forEach((range, i) => {
    if (i === 0) range.startT = 0;
    else range.startT = (ranges[i - 1] as HeadingRange).endT;
  });
  const last = ranges[ranges.length - 1];
  if (last !== undefined) last.endT = 1;
  return { mode: "piecewise", ranges };
}

/**
 * A step id from a path's name: letters and digits, lower camel case, or null when nothing is left.
 * It is cut short enough that the `_2` a repeated name gets still leaves it inside `STEP_ID_MAX`, so
 * every id the importer writes follows the step id rule.
 */
function idFromName(name: string): string | null {
  const words = name.match(/[A-Za-z0-9]+/g);
  if (words === null) return null;
  const id = words.map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1))).join("");
  return /^[A-Za-z]/.test(id) ? id.slice(0, STEP_ID_MAX - 8) : null;
}

const provenanced = (p: Point): { xIn: number; yIn: number; provenance: string } => ({ xIn: p.xIn, yIn: p.yIn, provenance: PEDRO_PROVENANCE });

function toSegments(polygons: readonly Point[][]): Segment[] {
  return polygons.map((polygon) => {
    const from = provenanced(polygon[0] as Point);
    const to = provenanced(polygon[polygon.length - 1] as Point);
    const controls = polygon.slice(1, -1);
    return controls.length === 0
      ? { kind: "line", from, to }
      : { kind: "bezier", from, control: controls.map(provenanced), to };
  });
}

/**
 * Imports a Pedro Pathing Visualizer project (`.pp`) as an auto in the season's field frame
 * (ADR 0008).
 *
 * - Each top-level path becomes one `path` step, in `sequence` order; a compound path is one step
 *   with one segment per curve. Straight paths become `line` segments and curves `bezier` ones;
 *   a curve with more control points than the file format allows is replaced by cubic pieces within
 *   0.05 in, with a warning.
 * - Headings map one to one onto ADR 0006's modes: tangential to `tangent` or `tangentReversed`,
 *   constant to `constant`, linear to `linear` (the short way, as the visualizer turns), piecewise to
 *   `piecewise`, facing-point ranges to `facePoint`.
 * - Sequence waits become `wait` steps. A sequence item of any other kind (the visualizer at 1.5.0
 *   has none) becomes a placeholder `command` named `imported1`, `imported2` and so on, with a
 *   warning asking the user to map it to a command of their own.
 * - Every pose carries `CARRIED OVER (Pedro Visualizer import)`.
 *
 * Pure: no clock, no randomness, no file access. Throws `ImportError` naming every field that makes
 * the file unusable; everything else is a warning.
 */
export function importPedroProject(json: unknown, field: Field, options: PedroImportOptions = {}): PedroImportResult {
  const reader = new Reader();
  if (!isObject(json)) throw new ImportError("the Pedro Visualizer project", [{ path: "", message: "must be a JSON object." }]);
  const tooLarge = pedroSizeIssues(json);
  if (tooLarge.length > 0) throw new ImportError("the Pedro Visualizer project", tooLarge);

  const version = json["version"];
  if (typeof version === "string") {
    if (isNewerVersion(version)) {
      reader.warn(
        `This file was saved by Pedro Visualizer project version ${version}; the importer understands ${PEDRO_PROJECT_VERSION}. Fields added after ${PEDRO_PROJECT_VERSION} are listed below as unknown and were not imported.`,
      );
    }
  } else if (version !== undefined) {
    reader.warn(`version is ${JSON.stringify(version)}, not a version string; it was ignored.`);
  }
  reader.unknownKeys(json, [...TOP_LEVEL_KEYS, ...LEGACY_TOP_LEVEL_KEYS], "");
  if (Array.isArray(json["pathChains"]) && json["pathChains"].length > 0) {
    reader.warn(
      `pathChains (${json["pathChains"].length === 1 ? "one path chain" : `${String(json["pathChains"].length)} path chains`}, from a visualizer version up to 1.3.0) ${json["pathChains"].length === 1 ? "was" : "were"} not imported: the current visualizer ignores them too, and drives the paths in sequence order.`,
    );
  }

  const name = options.name ?? "imported-pedro";
  if (!AUTO_NAME_PATTERN.test(name)) {
    throw new ImportError("the Pedro Visualizer project", [
      { path: "", message: `the auto name ${JSON.stringify(name)} must use only letters, digits, ".", "_" and "-".` },
    ]);
  }
  const centreIn = options.centreIn ?? PEDRO_VISUALIZER_CENTRE_IN;
  const seasonWarning = presetSeasonWarning("pedro", field);
  if (seasonWarning !== null) reader.warn(seasonWarning);

  // The start pose.
  const startRaw = json["startPoint"];
  let startPedro: PedroPoint = { x: 0, y: 0 };
  let startHeadingDeg = 0;
  if (!isObject(startRaw)) {
    reader.fail("startPoint", startRaw === undefined ? "is required: the pose the path starts from." : "must be an object { x, y, headingDeg }.");
  } else {
    reader.unknownKeys(startRaw, START_POINT_KEYS, "startPoint");
    startPedro = { x: reader.number(startRaw, "x", "startPoint"), y: reader.number(startRaw, "y", "startPoint") };
    if (isFiniteNumber(startRaw["headingDeg"])) startHeadingDeg = startRaw["headingDeg"];
    else if (startRaw["headingDeg"] !== undefined) reader.fail("startPoint.headingDeg", "must be a finite number.");
    else {
      const legacy = startRaw["heading"];
      startHeadingDeg =
        legacy === "constant" && isFiniteNumber(startRaw["degrees"])
          ? startRaw["degrees"]
          : legacy === "linear" && isFiniteNumber(startRaw["startDeg"])
            ? startRaw["startDeg"]
            : 0;
      reader.warn(`startPoint.headingDeg is missing; the start heading was taken as ${String(startHeadingDeg)} degrees, the way the visualizer reads older files.`);
    }
  }

  // The paths.
  const linesRaw = json["lines"];
  const nodes: PathNode[] = [];
  if (!Array.isArray(linesRaw)) {
    reader.fail("lines", linesRaw === undefined ? "is required: the list of paths." : "must be a list of paths.");
  } else {
    linesRaw.forEach((raw, i) => {
      const node = reader.path(raw, `lines[${String(i)}]`, 0);
      if (node !== null) nodes.push(node);
    });
    if (linesRaw.length === 0) reader.fail("lines", "is empty: the project has no path to import.");
  }
  if (reader.legacyHeadings.length > 0) {
    reader.warn(
      `${reader.legacyHeadings.join(", ")} ${reader.legacyHeadings.length === 1 ? "is" : "are"} in the form visualizer versions up to 1.3.0 wrote (a heading name with its numbers on the end point); read the way the current visualizer reads ${reader.legacyHeadings.length === 1 ? "it" : "them"}.`,
    );
  }

  // The settings: the robot's size, and a note that the motion estimates stay behind.
  let robotFootprint: PedroImportResult["robotFootprint"];
  const settings = json["settings"];
  if (isObject(settings)) {
    reader.unknownKeys(settings, SETTINGS_KEYS, "settings");
    const rWidth = settings["rWidth"];
    const rHeight = settings["rHeight"];
    if (isFiniteNumber(rWidth) && isFiniteNumber(rHeight) && rWidth > 0 && rHeight > 0) {
      robotFootprint = {
        lengthIn: rWidth,
        widthIn: rHeight,
        provenance: `${PEDRO_PROVENANCE}: settings.rWidth ${String(rWidth)} in along the heading, settings.rHeight ${String(rHeight)} in side to side`,
      };
    } else if (rWidth !== undefined || rHeight !== undefined) {
      reader.warn("settings.rWidth and settings.rHeight must both be positive numbers for the robot's size to be imported; it was not.");
    }
    const motion = MOTION_SETTING_KEYS.filter((key) => settings[key] !== undefined);
    if (motion.length > 0) {
      reader.warn(
        `settings.${motion.join(", settings.")} are the visualizer's own playback estimates ("UI Settings Only"); they were not imported, because Zenith times a path from robot.json.`,
      );
    }
    const fieldMap = settings["fieldMap"];
    if (typeof fieldMap === "string" && fieldMap !== VERIFIED_FIELD_MAP) {
      reader.warn(
        `settings.fieldMap is ${JSON.stringify(fieldMap)}; the Pedro frame conversion was checked against ${VERIFIED_FIELD_MAP} only, so check that the path sits where it should on ${field.season}.`,
      );
    }
  } else if (settings !== undefined) {
    reader.warn("settings is not an object; it was ignored.");
  }
  if (Array.isArray(json["shapes"]) && json["shapes"].length > 0) {
    reader.warn(`shapes (${String(json["shapes"].length)} ${json["shapes"].length === 1 ? "obstacle drawing" : "obstacle drawings"}) were not imported: the season's field file is where Zenith's obstacles come from.`);
  }
  if (Array.isArray(json["fieldPoints"]) && json["fieldPoints"].length > 0) {
    reader.warn(`fieldPoints (${String(json["fieldPoints"].length)} ${json["fieldPoints"].length === 1 ? "marker" : "markers"}) were not imported; add a waypoint for any you want to keep.`);
  }

  if (reader.issues.length > 0) throw new ImportError("the Pedro Visualizer project", reader.issues);

  // Geometry, chained in `lines` order the way the visualizer chains it.
  const converter = new Converter(reader, centreIn);
  const startPoint = converter.point(startPedro);
  const leaves: Leaf[] = [];
  const nodeStart = new Map<PathNode, Point>();
  let cursor = startPoint;
  for (const node of nodes) {
    nodeStart.set(node, cursor);
    for (const leafNode of flattenLeaves(node)) {
      const leaf = converter.leaf(leafNode, cursor);
      leaves.push(leaf);
      cursor = converter.point(leafNode.end);
    }
  }

  // Ids: every segment id names its top-level path.
  const topOfLeaf = new Map<string, number>();
  nodes.forEach((node, index) => {
    for (const leaf of flattenLeaves(node)) {
      if (topOfLeaf.has(leaf.id)) reader.warn(`${leaf.where}.id ${JSON.stringify(leaf.id)} is used by more than one path; the sequence reaches only the first.`);
      else topOfLeaf.set(leaf.id, index);
    }
  });

  // The order: sequence items, or every path when there is no sequence.
  type Item = { kind: "path"; index: number } | { kind: "wait"; seconds: number; name: string } | { kind: "placeholder"; itemKind: string; where: string; name: string };
  const items: Item[] = [];
  const sequence = json["sequence"];
  if (Array.isArray(sequence) && sequence.length > 0) {
    let previousPath: number | null = null;
    sequence.forEach((raw, i) => {
      const where = `sequence[${String(i)}]`;
      if (!isObject(raw)) {
        reader.warn(`${where} is not an object; it was skipped.`);
        return;
      }
      const kind = typeof raw["kind"] === "string" ? raw["kind"] : "(none)";
      const known = SEQUENCE_KEYS[kind];
      if (known !== undefined) reader.unknownKeys(raw, known, where);
      if (kind === "path") {
        const index = typeof raw["lineId"] === "string" ? topOfLeaf.get(raw["lineId"]) : undefined;
        if (index === undefined) {
          reader.warn(`${where}.lineId ${JSON.stringify(raw["lineId"])} names no path in lines; the visualizer skips it, and so does the import.`);
          return;
        }
        // A compound path is one call however many of its segments the sequence lists in a row.
        if (index === previousPath) return;
        items.push({ kind: "path", index });
        previousPath = index;
        return;
      }
      previousPath = null;
      const itemName = typeof raw["name"] === "string" ? raw["name"] : "";
      if (kind === "wait") {
        const ms = raw["durationMs"];
        if (!isFiniteNumber(ms) || ms < 0) {
          reader.warn(`${where}.durationMs must be a number of milliseconds, zero or more; the wait was imported as 0 s.`);
        }
        items.push({ kind: "wait", seconds: isFiniteNumber(ms) && ms > 0 ? ms / 1000 : 0, name: itemName });
        return;
      }
      items.push({ kind: "placeholder", itemKind: kind, where, name: itemName });
    });
    // The visualizer's code export drives every path in lines order when no sequence item names
    // one it has (`buildSequence`), so a sequence left pointing at old ids still drives the paths.
    if (items.length === 0) {
      reader.warn("sequence names none of the paths in lines; the visualizer's code export then drives every path in lines order, and so does the import.");
      nodes.forEach((_, index) => items.push({ kind: "path", index }));
    }
  } else {
    nodes.forEach((_, index) => items.push({ kind: "path", index }));
  }
  nodes.forEach((node, index) => {
    if (!items.some((item) => item.kind === "path" && item.index === index)) {
      reader.warn(`${node.where}${node.name === "" ? "" : ` ("${node.name}")`} is not in the sequence, so the visualizer's code export never drives it; it was not imported.`);
    }
  });

  // Steps.
  const usedIds = new Set<string>();
  const claimId = (wanted: string | null, fallback: string): string => {
    let base = wanted ?? fallback;
    if (usedIds.has(base)) base = fallback;
    let id = base;
    for (let n = 2; usedIds.has(id); n += 1) id = `${base}_${String(n)}`;
    usedIds.add(id);
    return id;
  };
  const steps: Step[] = [];
  let placeholders = 0;
  let waits = 0;
  let previousEnd: Point | null = startPoint;
  let pathSteps = 0;
  for (const item of items) {
    if (item.kind === "wait") {
      waits += 1;
      const step: Step = { id: claimId(null, `wait${String(waits)}`), kind: "wait", seconds: item.seconds };
      if (item.name !== "") step.notes = `Pedro Visualizer wait "${item.name}".`;
      steps.push(step);
      continue;
    }
    if (item.kind === "placeholder") {
      placeholders += 1;
      const id = `${PLACEHOLDER_COMMAND_PREFIX}${String(placeholders)}`;
      usedIds.add(id);
      steps.push({
        id,
        kind: "command",
        name: id,
        notes: `Placeholder for the Pedro Visualizer sequence item ${item.where} of kind "${item.itemKind}"${item.name === "" ? "" : ` named "${item.name}"`}. Replace it with one of your robot's commands.`,
      });
      reader.warn(
        `${item.where} is an item of kind "${item.itemKind}", which Pedro Visualizer ${PEDRO_PROJECT_VERSION} does not define; it was imported as the placeholder command ${id}. Map it to a command in robot.json, or delete it.`,
      );
      continue;
    }
    const node = nodes[item.index] as PathNode;
    const mine = leaves.filter((leaf) => isInside(leaf.node, node) && leaf.lengthIn > 1e-9);
    const zero = leaves.filter((leaf) => isInside(leaf.node, node) && leaf.lengthIn <= 1e-9);
    for (const leaf of zero) reader.warn(`${leaf.node.where} has no length (it ends where it starts); it was left out.`);
    if (mine.length === 0) {
      reader.warn(`${node.where} has no length; it was not imported as a step.`);
      continue;
    }
    const polygons = mine.flatMap((leaf) => leaf.polygons);
    const segments = toSegments(polygons);
    const start = nodeStart.get(node) as Point;
    const first = segments[0] as Segment;
    if (previousEnd !== null && pathSteps > 0 && Math.hypot(start.xIn - previousEnd.xIn, start.yIn - previousEnd.yIn) < 1e-6) {
      first.from = "current";
    } else if (previousEnd !== null && Math.hypot(start.xIn - previousEnd.xIn, start.yIn - previousEnd.yIn) >= 1e-6) {
      reader.warn(
        `${node.where} starts ${Math.hypot(start.xIn - previousEnd.xIn, start.yIn - previousEnd.yIn).toFixed(2)} in from where the step before it ends, because the sequence runs the paths in a different order from lines; the planner will report the jump.`,
      );
    }
    const totalIn = mine.reduce((sum, leaf) => sum + leaf.lengthIn, 0);
    const spans = converter.spans(node, leaves.filter((leaf) => leaf.lengthIn > 1e-9), { value: 0 });
    pathSteps += 1;
    const step: Step = {
      id: claimId(idFromName(node.name), `path${String(item.index + 1)}`),
      kind: "path",
      segments,
      heading: stepHeading(spans, totalIn),
    };
    if (node.name !== "") step.notes = `Pedro Visualizer path "${node.name}".`;
    steps.push(step);
    const lastPolygon = polygons[polygons.length - 1] as Point[];
    previousEnd = lastPolygon[lastPolygon.length - 1] as Point;
  }
  if (steps.length === 0) throw new ImportError("the Pedro Visualizer project", [{ path: "lines", message: "has no path with any length to import." }]);

  let alliance = options.alliance;
  const assumedAlliance = alliance === undefined ? field.frame.canonicalAlliance : undefined;
  if (alliance === undefined) {
    alliance = field.frame.canonicalAlliance;
    reader.warn(assumedAllianceWarning(alliance));
  }

  const auto: Record<string, unknown> = {
    $schema: SCHEMA_ID.auto,
    formatVersion: FORMAT_VERSIONS.auto,
    name,
  };
  if (options.title !== undefined) auto["title"] = options.title;
  auto["description"] = `Imported from a Pedro Pathing Visualizer project${typeof version === "string" ? ` (project version ${version})` : ""}.`;
  if (options.robotPath !== undefined) auto["robot"] = options.robotPath;
  if (options.fieldPath !== undefined) auto["field"] = options.fieldPath;
  auto["alliance"] = alliance;
  auto["start"] = {
    pose: { xIn: startPoint.xIn, yIn: startPoint.yIn, headingRad: converter.headingRad(startHeadingDeg), provenance: PEDRO_PROVENANCE },
  };
  auto["steps"] = steps;

  const result: PedroImportResult = { auto: parseAuto(auto), warnings: reader.warnings };
  if (robotFootprint !== undefined) result.robotFootprint = robotFootprint;
  if (assumedAlliance !== undefined) result.assumedAlliance = assumedAlliance;
  return result;
}

