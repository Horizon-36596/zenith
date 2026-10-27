/**
 * The Settings window's Robot and Commands sections (issue #100), as pure logic: which of the open
 * project's `robot.json` values they show, how an edit changes the robot, why a project's robot
 * cannot be changed here, and how a command typed into the form becomes a registry entry.
 *
 * The robot and its commands belong to the project (owner ruling 2026-10-03), so they stay in
 * `robot.json`; these sections only make that file easy to read and change. Every number keeps its
 * unit in the file (inches, radians, seconds; CLAUDE.md rule 3) and its provenance (rule 4): typing a
 * new number keeps the label it had, and the chip changes the label. (The Inspector's poses and
 * waypoints differ in one case: a number typed over MEASURED or CALIBRATED FROM ROBOT relabels it
 * SET FROM EDITOR, issue #273; no ruling covers the robot's numbers.)
 */
import { DEFAULT_CLEARANCE_IN, EDITOR_PROVENANCE, NO_PROVENANCE, PEDRO_DEFAULTS, robotClearanceIn, simFollowerParams } from "@horizon36596/zenith-core";
import { estimateExpressionNames, parseEstimateExpression, parseRobot, isEstimateExpression, type CommandParam, type CommandSpec, type Robot } from "@horizon36596/zenith-schema";
import { splitProvenance } from "../lib/provenance";
import type { HostView } from "../state/store";
import { projectKey, type Project, type ProjectSource } from "../project/types";

/* ---- Read only ----------------------------------------------------------------------------- */

/**
 * Why the robot of a project from `source` cannot be changed here, or null when it can. `host` is
 * the host session in host mode, whose robot comes from the host app.
 */
export function whyRobotIsReadOnly(source: ProjectSource, host: Pick<HostView, "name" | "readOnlyRobot"> | null): string | null {
  switch (source.kind) {
    case "example":
      return "The example project is read only. Open your own robot project to change its robot.";
    case "files":
      return "These files were opened one at a time, so Zenith cannot write robot.json. Open the project folder instead.";
    case "github":
      return "This project was opened from GitHub. Change robot.json on a branch, then open a pull request.";
    case "host":
      return host?.readOnlyRobot === true
        ? `This robot comes from your ${host.name} build. Change it in ${host.name}'s robot builder.`
        : `The app that opened this auto${host === null ? "" : `, ${host.name},`} owns its robot, so change it there.`;
    case "directory":
    case "desktop":
      return null;
  }
}

/**
 * The reason for `project`, after the source's own: `canWrite` says whether its backend can write
 * `robot.json` at all (an older desktop build cannot).
 */
export function robotReadOnlyReason(
  project: Project,
  host: Pick<HostView, "name" | "readOnlyRobot"> | null,
  canWrite: boolean,
): string | null {
  return (
    whyRobotIsReadOnly(project.source, host) ??
    (canWrite ? null : "This version of the desktop app cannot write robot.json. Update it, or change the file by hand.")
  );
}

/* ---- The numbers ----------------------------------------------------------------------------- */

/** How a value in the file is shown: inches, inches per second, degrees for radians, and so on. */
export interface Unit {
  /** The suffix beside the input. */
  label: string;
  /** File value to shown value. */
  toShown: (value: number) => number;
  /** Shown value to file value. */
  toFile: (value: number) => number;
}

const same = (label: string): Unit => ({ label, toShown: (value) => value, toFile: (value) => value });
const DEG_PER_RAD = 180 / Math.PI;

export const UNITS = {
  in: same("in"),
  inPerS: same("in/s"),
  inPerS2: same("in/s²"),
  s: same("s"),
  perS: same("/s"),
  fraction: same("×"),
  /**
   * A fraction in the file, a percent on screen, as the Inspector shows a path's speed (0.1.2 UX
   * sweep, W1-16). Both ways round off float noise, so 35 % is written as 0.35, not 0.35000000000000003.
   */
  percent: {
    label: "%",
    toShown: (value: number) => Math.round(value * 10000) / 100,
    toFile: (value: number) => Math.round(value * 100) / 10000,
  },
  count: same(""),
  /** Radians in the file, degrees on screen (CLAUDE.md rule 3). */
  degPerS: { label: "°/s", toShown: (value: number) => value * DEG_PER_RAD, toFile: (value: number) => value / DEG_PER_RAD },
} as const satisfies Record<string, Unit>;

/**
 * Where one number lives in the robot: the path to the number, and the path to the object that
 * holds its provenance. A footprint box's length and width share the box's one provenance.
 */
export interface RobotNumber {
  id: string;
  label: string;
  /** One line for the tooltip: what the number does. */
  hint: string;
  path: readonly string[];
  provenancePath: readonly string[];
  unit: Unit;
  digits: number;
  step: number;
  min?: number;
  max?: number;
  /** An optional key the file may leave out; empty means "not set" rather than a number. */
  optional?: boolean;
}

export interface RobotGroup {
  id: string;
  title: string;
  numbers: readonly RobotNumber[];
}

/** `{ value, provenance }` numbers: the number at `value`, the provenance beside it. */
const valued = (
  id: string,
  label: string,
  hint: string,
  base: readonly string[],
  unit: Unit,
  options: { digits?: number; step?: number; min?: number; max?: number; optional?: boolean } = {},
): RobotNumber => ({
  id,
  label,
  hint,
  path: [...base, "value"],
  provenancePath: base,
  unit,
  digits: options.digits ?? 1,
  step: options.step ?? 0.5,
  ...(options.min === undefined ? {} : { min: options.min }),
  ...(options.max === undefined ? {} : { max: options.max }),
  ...(options.optional === true ? { optional: true } : {}),
});

/** A plain number inside an object whose `provenance` covers it. */
const plain = (
  id: string,
  label: string,
  hint: string,
  holder: readonly string[],
  key: string,
  unit: Unit,
  options: { digits?: number; step?: number; min?: number; max?: number } = {},
): RobotNumber => ({
  id,
  label,
  hint,
  path: [...holder, key],
  provenancePath: holder,
  unit,
  digits: options.digits ?? 1,
  step: options.step ?? 0.5,
  ...(options.min === undefined ? {} : { min: options.min }),
  ...(options.max === undefined ? {} : { max: options.max }),
});

/**
 * The ceilings a robot number is held under (issue #502), in the units the row shows. They are not
 * measurements: each is well past any FTC robot, so a slip of the keyboard, such as a top speed of
 * 99999999 in/s, is refused with the range instead of saved. A size is held to the field's side.
 */
const MAX_SIZE_IN = 144;
const MAX_SPEED_IN_PER_S = 300;
const MAX_ACCEL_IN_PER_S2 = 2000;
const MAX_TURN_DEG_PER_S = 3600;
const MAX_SETTLE_S = 30;

/** Everything the Robot section edits, grouped as `robot.json` groups it. Mouths are listed apart. */
export const ROBOT_GROUPS: readonly RobotGroup[] = [
  {
    id: "footprint",
    title: "Size",
    numbers: [
      plain("startLength", "Start length", "Along the nose, at the start of the match.", ["footprint", "startIn"], "lengthIn", UNITS.in, { min: 0.1, max: MAX_SIZE_IN }),
      plain("startWidth", "Start width", "Across the nose, at the start of the match.", ["footprint", "startIn"], "widthIn", UNITS.in, { min: 0.1, max: MAX_SIZE_IN }),
      plain("expandedLength", "Expanded length", "Along the nose, with every mechanism out.", ["footprint", "expandedIn"], "lengthIn", UNITS.in, { min: 0.1, max: MAX_SIZE_IN }),
      plain("expandedWidth", "Expanded width", "Across the nose, with every mechanism out.", ["footprint", "expandedIn"], "widthIn", UNITS.in, { min: 0.1, max: MAX_SIZE_IN }),
      plain("corX", "Turning centre x", "Where the robot turns about, forward of the footprint's centre.", ["footprint", "centreOfRotationIn"], "xIn", UNITS.in),
      plain("corY", "Turning centre y", "Where the robot turns about, left of the footprint's centre.", ["footprint", "centreOfRotationIn"], "yIn", UNITS.in),
      valued("height", "Height", "How tall the robot stands, for the structure check. It decides which part of the slanted legs the robot hits.", ["heightIn"], UNITS.in, { min: 0.1, max: MAX_SIZE_IN, optional: true }),
    ],
  },
  {
    id: "speeds",
    title: "Speeds",
    numbers: [
      valued("maxForward", "Top speed forward", "The fastest the robot drives forward.", ["kinematics", "maxForwardVelInPerS"], UNITS.inPerS, { min: 0.1, max: MAX_SPEED_IN_PER_S }),
      valued("maxStrafe", "Top speed sideways", "The fastest the robot strafes.", ["kinematics", "maxStrafeVelInPerS"], UNITS.inPerS, { min: 0.1, max: MAX_SPEED_IN_PER_S }),
      valued("accel", "Acceleration", "How quickly the robot gets up to speed.", ["kinematics", "accelInPerS2"], UNITS.inPerS2, { min: 0.1, max: MAX_ACCEL_IN_PER_S2 }),
      valued("forwardDecel", "Braking forward", "How quickly the robot slows while driving forward.", ["kinematics", "forwardDecelInPerS2"], UNITS.inPerS2, { min: 0.1, max: MAX_ACCEL_IN_PER_S2 }),
      valued("strafeDecel", "Braking sideways", "How quickly the robot slows while strafing.", ["kinematics", "strafeDecelInPerS2"], UNITS.inPerS2, { min: 0.1, max: MAX_ACCEL_IN_PER_S2 }),
      valued("maxTurn", "Top turning speed", "The fastest the robot turns on the spot.", ["kinematics", "maxAngularVelRadPerS"], UNITS.degPerS, { digits: 0, step: 5, min: 1, max: MAX_TURN_DEG_PER_S }),
      valued("speedFraction", "Default path speed", "The share of top speed a path drives at unless it says otherwise. The robot applies it only if its ZenithRobot implements atSpeed.", ["kinematics", "defaultPathSpeedFraction"], UNITS.percent, { digits: 0, step: 5, min: 5, max: 100 }),
      valued("settle", "Settle time", "Seconds the follower spends settling at the end of a path.", ["kinematics", "settleS"], UNITS.s, { digits: 2, step: 0.05, min: 0, max: MAX_SETTLE_S, optional: true }),
    ],
  },
  {
    id: "drivetrain",
    title: "Drivetrain",
    numbers: [
      valued("trackWidth", "Track width", "Distance between the left and right wheels.", ["kinematics", "drivetrain", "trackWidthIn"], UNITS.in, { min: 0.1, max: MAX_SIZE_IN, optional: true }),
      valued("wheelBase", "Wheel base", "Distance between the front and back wheels.", ["kinematics", "drivetrain", "wheelBaseIn"], UNITS.in, { min: 0.1, max: MAX_SIZE_IN, optional: true }),
      valued("wheelResponse", "Wheel response", "How quickly the wheels reach a new speed, for the instant sim.", ["kinematics", "drivetrain", "wheelResponseRatePerS"], UNITS.perS, { digits: 1, step: 0.5, min: 0.1, optional: true }),
    ],
  },
];

/** The capacity row: how many game pieces the robot may hold. Shown with the ledger switch. */
export const CAPACITY: RobotNumber = plain("capacity", "Holds at most", "The most game pieces the robot may hold at once.", ["capacity"], "max", UNITS.count, { digits: 0, step: 1, min: 0 });

/**
 * What Optimize path does with the margin: it reads this clearance, and because Pedro's follower may
 * drift further off the path than the default margin, it also tests the instant sim's own motion
 * against it. How far it may drift is the robot's own
 * `kinematics.follower.translationalDeviationToleranceIn`, the number the instant sim reads; while
 * robot.json leaves it out, that is Pedro's default, 2.5 in (CARRIED OVER: `sim/params.ts`). With no
 * robot the sentence gives the default and says so.
 */
export function optimizeMarginNote(robot: Robot | null): string {
  const set = robot?.kinematics.follower.translationalDeviationToleranceIn !== undefined;
  const inches = robot === null ? PEDRO_DEFAULTS.translationalDeviationToleranceIn : simFollowerParams(robot).translationalDeviationToleranceIn;
  const drift = `${String(Math.round(inches * 100) / 100)} in${set ? " on this robot" : " by default"}`;
  return `Pedro's follower may drift up to ${drift} off its path, so Optimize path also checks the instant sim's own motion against this margin.`;
}

/**
 * The clearance from field elements (owner ruling D8): how close the robot may pass a structure before
 * the CLEARANCE warning. It belongs to the robot, so it is the one key a Settings row writes into a
 * project file. While robot.json leaves it out, the row shows Zenith's default and a Set button
 * (`setClearance`) rather than an empty number. Its help adds the Optimize path sentence only while
 * that switch is on (`clearanceRow`).
 */
export const CLEARANCE: RobotNumber = valued(
  "clearance",
  "Clearance from field elements",
  "How close the robot may pass a structure before Zenith warns. Walls and keep-out zones do not count. 0 turns the warning off.",
  ["footprint", "clearanceIn"],
  UNITS.in,
  { digits: 2, step: 0.25, min: 0, optional: true },
);

/**
 * The clearance row for this robot: `CLEARANCE`, and while Optimize path is on, the sentence on what
 * the optimizer does with the margin. With the switch off nothing points at a feature the person has
 * turned off.
 */
export function clearanceRow(robot: Robot | null, optimizer: boolean): RobotNumber {
  return optimizer ? { ...CLEARANCE, hint: `${CLEARANCE.hint} ${optimizeMarginNote(robot)}` } : CLEARANCE;
}

/** The provenance Set writes: the person chose the number, so SET BY HAND (D8), with where. */
export const CLEARANCE_SET_PROVENANCE = "SET BY HAND: chosen in Settings, Robot";

/**
 * `robot` with `footprint.clearanceIn` written at Zenith's default and SET BY HAND, ready for the
 * person to change; the same robot when the file has the key already.
 */
export function setClearance(robot: Robot): Robot {
  if (robot.footprint.clearanceIn !== undefined) return robot;
  return { ...robot, footprint: { ...robot.footprint, clearanceIn: { value: DEFAULT_CLEARANCE_IN, provenance: CLEARANCE_SET_PROVENANCE } } };
}

/** The clearance in force, as a number and its unit: `1 in`. Zenith's default stands in while the file leaves it out. */
export function clearanceValueText(robot: Robot): string {
  return `${String(Math.round(robotClearanceIn(robot) * 100) / 100)} in`;
}

/** What the clearance row says: the number robot.json gives, or the default and that it is one. */
export function clearanceSummary(robot: Robot): string {
  return robot.footprint.clearanceIn === undefined ? `${clearanceValueText(robot)} (default)` : clearanceValueText(robot);
}

/**
 * How far a value is from being settled (issue #414): a `placeholder` is a stand-in somebody typed
 * until it is measured, and a value that `needs` measuring says so or has no label at all. Every other
 * label, MEASURED and SET BY HAND included, is settled.
 */
export type Settled = "placeholder" | "needs" | "settled";

export function settledOf(provenance: string | undefined): Settled {
  const label = splitProvenance(provenance ?? NO_PROVENANCE).label;
  if (label === "PLACEHOLDER") return "placeholder";
  if (label === null || label === "NEEDS MEASUREMENT") return "needs";
  return "settled";
}

/**
 * How many of the robot's values are placeholders and how many need measuring, among the numbers
 * Robot lists that the file has a value for, for the line at the top of Robot.
 */
export function unsettledCounts(robot: Robot, numbers: readonly RobotNumber[]): { placeholders: number; needMeasuring: number } {
  let placeholders = 0;
  let needMeasuring = 0;
  for (const entry of numbers) {
    if (numberOf(robot, entry) === null) continue;
    const settled = settledOf(provenanceOf(robot, entry));
    if (settled === "placeholder") placeholders += 1;
    else if (settled === "needs") needMeasuring += 1;
  }
  return { placeholders, needMeasuring };
}

/** "12 values are placeholders and 4 need measuring", or just one half of it; null when nothing is left to do. */
export function unsettledLine(counts: { placeholders: number; needMeasuring: number }): string | null {
  const { placeholders, needMeasuring } = counts;
  const holders = placeholders === 1 ? "1 value is a placeholder" : `${String(placeholders)} values are placeholders`;
  const needs = needMeasuring === 1 ? "1 needs measuring" : `${String(needMeasuring)} need measuring`;
  if (placeholders > 0 && needMeasuring > 0) return `${holders} and ${needs}`;
  if (placeholders > 0) return holders;
  if (needMeasuring > 0) return needMeasuring === 1 ? "1 value needs measuring" : `${String(needMeasuring)} values need measuring`;
  return null;
}

/** The shooter's settle time, when the robot has a shooter. */
export const SHOOTER_SETTLE: RobotNumber = valued("shooterSettle", "Shooter settle time", "Seconds the robot waits to settle before it launches.", ["shooter", "settleS"], UNITS.s, { digits: 2, step: 0.05, min: 0, optional: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at `path`, or undefined. */
export function valueAt(robot: Robot, path: readonly string[]): unknown {
  let at: unknown = robot;
  for (const key of path) {
    if (!isRecord(at)) return undefined;
    at = at[key];
  }
  return at;
}

/** The number `entry` reads in the file, or null when the file leaves it out. */
export function numberOf(robot: Robot, entry: RobotNumber): number | null {
  const value = valueAt(robot, entry.path);
  // An older file's bare `heightIn` reads as the number itself.
  if (typeof value === "number") return value;
  if (entry.path[entry.path.length - 1] === "value") {
    const bare = valueAt(robot, entry.path.slice(0, -1));
    if (typeof bare === "number") return bare;
  }
  return null;
}

export function provenanceOf(robot: Robot, entry: RobotNumber): string | undefined {
  const holder = valueAt(robot, entry.provenancePath);
  return isRecord(holder) && typeof holder["provenance"] === "string" ? holder["provenance"] : undefined;
}

/** A copy of `value` with `update` applied at `path`, creating plain objects on the way down. */
function setIn(value: unknown, path: readonly string[], update: (old: unknown) => unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return update(value);
  const object = isRecord(value) ? value : {};
  return { ...object, [head]: setIn(object[head], rest, update) };
}

/** A copy of `value` without the key at `path`; a parent left empty by it is dropped too. */
function deleteIn(value: unknown, path: readonly string[]): unknown {
  const [head, ...rest] = path;
  if (head === undefined || !isRecord(value) || !(head in value)) return value;
  const copy = { ...value };
  if (rest.length === 0) {
    delete copy[head];
    return copy;
  }
  const child = deleteIn(copy[head], rest);
  if (isRecord(child) && Object.keys(child).length === 0) delete copy[head];
  else copy[head] = child;
  return copy;
}

/**
 * `robot` with `entry` set to `shown` (in the unit on screen), or cleared when `shown` is null and
 * the key is optional. The value keeps its provenance; a value the file did not have yet is labelled
 * SET FROM EDITOR, since it was typed here, never left with none (rule 4).
 */
export function setRobotNumber(robot: Robot, entry: RobotNumber, shown: number | null): Robot {
  if (shown === null) {
    if (entry.optional !== true) return robot;
    return deleteIn(robot, entry.provenancePath) as Robot;
  }
  const value = entry.unit.toFile(shown);
  const holderPath = entry.provenancePath;
  const holder = valueAt(robot, holderPath);
  if (entry.path[entry.path.length - 1] === "value" && !isRecord(holder)) {
    // A new optional number, or an older file's bare one: written as `{ value, provenance }`.
    const provenance = typeof holder === "number" ? undefined : EDITOR_PROVENANCE;
    return setIn(robot, holderPath, () => (provenance === undefined ? { value } : { value, provenance })) as Robot;
  }
  return setIn(robot, entry.path, () => value) as Robot;
}

/** `robot` with the provenance that covers `entry` set to `provenance`. */
export function setRobotProvenance(robot: Robot, entry: RobotNumber, provenance: string): Robot {
  const holder = valueAt(robot, entry.provenancePath);
  if (typeof holder === "number") {
    return setIn(robot, entry.provenancePath, () => ({ value: holder, provenance })) as Robot;
  }
  if (!isRecord(holder)) return robot;
  return setIn(robot, entry.provenancePath, (old) => ({ ...(old as Record<string, unknown>), provenance })) as Robot;
}

/** `robot` with its name set. */
export const setRobotName = (robot: Robot, name: string): Robot => ({ ...robot, name: name.trim() === "" ? robot.name : name.trim() });

/** One mouth's numbers, by the field that holds each, for the mouths list. */
export const MOUTH_NUMBERS = [
  { key: "x", label: "Forward", hint: "How far forward of the footprint's centre the mouth sits." },
  { key: "y", label: "Left", hint: "How far left of the footprint's centre the mouth sits." },
  { key: "widthIn", label: "Width", hint: "How wide the mouth is." },
  { key: "depthIn", label: "Depth", hint: "How deep the mouth reaches into the robot." },
] as const;

export type MouthNumberKey = (typeof MOUTH_NUMBERS)[number]["key"];

/** `robot` with one number of the mouth at `index` set, in inches. */
export function setMouthNumber(robot: Robot, index: number, key: MouthNumberKey, value: number): Robot {
  const mouths = robot.mouths ?? [];
  const mouth = mouths[index];
  if (mouth === undefined) return robot;
  const next =
    key === "x"
      ? { ...mouth, offsetIn: { ...mouth.offsetIn, xIn: value } }
      : key === "y"
        ? { ...mouth, offsetIn: { ...mouth.offsetIn, yIn: value } }
        : { ...mouth, [key]: value };
  return { ...robot, mouths: mouths.map((old, at) => (at === index ? next : old)) };
}

export function setMouthProvenance(robot: Robot, index: number, provenance: string): Robot {
  const mouths = robot.mouths ?? [];
  if (mouths[index] === undefined) return robot;
  return { ...robot, mouths: mouths.map((old, at) => (at === index ? { ...old, provenance } : old)) };
}

export const mouthNumber = (mouth: NonNullable<Robot["mouths"]>[number], key: MouthNumberKey): number =>
  key === "x" ? mouth.offsetIn.xIn : key === "y" ? mouth.offsetIn.yIn : mouth[key];

/**
 * Checks an edited robot against the schema, so a draft that would not load is never written.
 * Returns the problem as one sentence, or null when it loads.
 */
export function robotProblem(robot: Robot): string | null {
  try {
    parseRobot(JSON.parse(JSON.stringify(robot)));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/* ---- Commands -------------------------------------------------------------------------------- */

/** The parameter kinds the registry allows, in the order the form offers them. */
export const PARAM_TYPES = ["integer", "number", "enum", "boolean", "string"] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

/** One parameter as the form holds it: every field as typed. */
export interface ParamDraft {
  name: string;
  type: ParamType;
  min: string;
  max: string;
  /** For an enum, the values separated by commas. */
  values: string;
  default: string;
}

/** One command as the form holds it. */
export interface CommandDraft {
  name: string;
  summary: string;
  estimateS: string;
  /** Subsystems separated by commas. */
  requires: string;
  stationary: boolean;
  movesRobot: boolean;
  params: ParamDraft[];
}

export const EMPTY_PARAM: ParamDraft = { name: "", type: "number", min: "", max: "", values: "", default: "" };

export const EMPTY_COMMAND: CommandDraft = {
  name: "",
  summary: "",
  estimateS: "unknown",
  requires: "",
  stationary: false,
  movesRobot: false,
  params: [],
};

const text = (value: number | string | boolean | undefined): string => (value === undefined ? "" : String(value));

/** The form's fields for an existing command. */
export function draftOf(command: CommandSpec): CommandDraft {
  return {
    name: command.name,
    summary: command.summary ?? "",
    estimateS: command.estimateS,
    requires: (command.requires ?? []).join(", "),
    stationary: command.stationary === true,
    movesRobot: command.movesRobot === true,
    params: Object.entries(command.params ?? {}).map(([name, param]) => ({
      name,
      type: param.type,
      min: "min" in param ? text(param.min) : "",
      max: "max" in param ? text(param.max) : "",
      values: param.type === "enum" ? param.values.join(", ") : "",
      default: text(param.default),
    })),
  };
}

/** A command name the robot code can register: a Java identifier, the same rule the import uses. */
export const COMMAND_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const list = (value: string): string[] =>
  value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

const numberOrUndefined = (value: string): number | undefined | "bad" => {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : "bad";
};

export type CommandFromDraft = { ok: true; command: CommandSpec } | { ok: false; problem: string };

/**
 * The registry entry the form describes, or the first problem with it. `others` are the names the
 * robot already has besides this one, so two commands never share a name. `previous` is the
 * command being edited, whose keys the form does not show (its ledger effects, its provenance) are
 * kept.
 */
export function commandFromDraft(draft: CommandDraft, others: readonly string[], previous?: CommandSpec): CommandFromDraft {
  const name = draft.name.trim();
  if (name === "") return { ok: false, problem: "Give the command a name." };
  if (!COMMAND_NAME.test(name)) return { ok: false, problem: "A command name is one word of letters, digits and underscores, as the robot code registers it." };
  if (others.includes(name)) return { ok: false, problem: `The robot already has a command named ${name}.` };
  const estimateS = draft.estimateS.trim() === "" ? "unknown" : draft.estimateS.trim();
  if (!isEstimateExpression(estimateS)) {
    return { ok: false, problem: 'The time must be a number of seconds, an expression over the arguments such as "0.5 + count * 0.5", or "unknown".' };
  }
  // Own keys only: `in` and a plain lookup also find what every object inherits, so an argument named
  // constructor or toString was called a duplicate of itself, and __proto__ set no argument (issue #403).
  const built: Array<[string, CommandParam]> = [];
  const names = new Set<string>();
  const before = previous?.params ?? {};
  for (const param of draft.params) {
    const key = param.name.trim();
    if (key === "") return { ok: false, problem: "Give every argument a name." };
    if (!COMMAND_NAME.test(key)) return { ok: false, problem: `${key} is not an argument name: use one word of letters, digits and underscores.` };
    if (names.has(key)) return { ok: false, problem: `Two arguments are named ${key}.` };
    const one = paramFromDraft(param, Object.hasOwn(before, key) ? before[key] : undefined);
    if (typeof one === "string") return { ok: false, problem: `${key}: ${one}` };
    names.add(key);
    built.push([key, one]);
  }
  const params: Record<string, CommandParam> = Object.fromEntries(built);
  // A name in the time is one of the arguments, so the editor can work the time out for each call.
  const unknown = estimateExpressionNames(parseEstimateExpression(estimateS)).find((used) => !names.has(used));
  if (unknown !== undefined) return { ok: false, problem: `The time uses ${unknown}, which is not one of the arguments.` };
  const requires = list(draft.requires);
  const summary = draft.summary.trim();
  const command: CommandSpec = {
    name,
    ...(summary === "" ? {} : { summary }),
    ...(Object.keys(params).length === 0 ? {} : { params }),
    estimateS,
    ...(requires.length === 0 ? {} : { requires }),
    ...(draft.stationary || previous?.stationary !== undefined ? { stationary: draft.stationary } : {}),
    ...(draft.movesRobot || previous?.movesRobot !== undefined ? { movesRobot: draft.movesRobot } : {}),
    ...(previous?.ledger === undefined ? {} : { ledger: previous.ledger }),
    ...(previous?.provenance === undefined ? {} : { provenance: previous.provenance }),
  };
  return { ok: true, command };
}

function paramFromDraft(draft: ParamDraft, previous: CommandParam | undefined): CommandParam | string {
  const provenance = previous?.provenance === undefined ? {} : { provenance: previous.provenance };
  switch (draft.type) {
    case "integer":
    case "number": {
      const min = numberOrUndefined(draft.min);
      const max = numberOrUndefined(draft.max);
      const fallback = numberOrUndefined(draft.default);
      if (min === "bad" || max === "bad" || fallback === "bad") return "the lowest, highest and default values must be numbers.";
      if (draft.type === "integer" && [min, max, fallback].some((value) => value !== undefined && !Number.isInteger(value))) {
        return "a whole-number argument takes whole numbers.";
      }
      if (min !== undefined && max !== undefined && min > max) return "the lowest value is above the highest.";
      if (fallback !== undefined && ((min !== undefined && fallback < min) || (max !== undefined && fallback > max))) {
        return "the default is outside the range.";
      }
      return {
        type: draft.type,
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
        ...(fallback === undefined ? {} : { default: fallback }),
        ...provenance,
      };
    }
    case "enum": {
      const values = list(draft.values);
      if (values.length === 0) return "list at least one value, separated by commas.";
      const fallback = draft.default.trim();
      if (fallback !== "" && !values.includes(fallback)) return "the default must be one of the values.";
      return { type: "enum", values, ...(fallback === "" ? {} : { default: fallback }), ...provenance };
    }
    case "boolean": {
      const fallback = draft.default.trim().toLowerCase();
      if (fallback !== "" && fallback !== "true" && fallback !== "false") return "the default is true or false.";
      return { type: "boolean", ...(fallback === "" ? {} : { default: fallback === "true" }), ...provenance };
    }
    case "string":
      return { type: "string", ...(draft.default === "" ? {} : { default: draft.default }), ...provenance };
  }
}

/** `robot` with `command` added at the end of the registry. */
export const addCommand = (robot: Robot, command: CommandSpec): Robot => ({ ...robot, commands: [...robot.commands, command] });

/** `robot` with the command named `name` replaced by `command`, in the same place. */
export const replaceCommand = (robot: Robot, name: string, command: CommandSpec): Robot => ({
  ...robot,
  commands: robot.commands.map((old) => (old.name === name ? command : old)),
});

/** `robot` without the command named `name`. Autos that call it keep the call and show an error. */
export const removeCommand = (robot: Robot, name: string): Robot => ({
  ...robot,
  commands: robot.commands.filter((old) => old.name !== name),
});

/** One parameter as the list shows it: `count: whole number 1 to 4, default 1`. */
export function describeParam(name: string, param: CommandParam): string {
  const range = (min: number | undefined, max: number | undefined): string =>
    min !== undefined && max !== undefined
      ? ` ${String(min)} to ${String(max)}`
      : min !== undefined
        ? ` from ${String(min)}`
        : max !== undefined
          ? ` up to ${String(max)}`
          : "";
  const fallback = param.default === undefined ? "" : `, default ${String(param.default)}`;
  switch (param.type) {
    case "integer":
      return `${name}: whole number${range(param.min, param.max)}${fallback}`;
    case "number":
      return `${name}: number${range(param.min, param.max)}${fallback}`;
    case "enum":
      return `${name}: one of ${param.values.join(", ")}${fallback}`;
    case "boolean":
      return `${name}: true or false${fallback}`;
    case "string":
      return `${name}: text${fallback}`;
  }
}

/** What the time column says: seconds, the expression, or "Time unknown". */
export const describeEstimate = (estimateS: string): string => (estimateS === "unknown" ? "Time unknown" : `${estimateS} s`);

/* ---- The Robot section's unsaved draft (RobotPanes.tsx) ------------------------------------- */

/** The robot a Robot draft would save: its edits, with the commands and conditions as they are now. */
export const withCurrentCommands = (edited: Robot, current: Robot): Robot => {
  const merged: Robot = { ...edited, commands: current.commands };
  if (current.conditions === undefined) delete merged.conditions;
  else merged.conditions = current.conditions;
  return merged;
};

export const sameRobot = (a: Robot, b: Robot): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The project an unsaved Robot draft belongs to: where the project was opened from (`projectKey`)
 * and the robot file it names. The project's name alone was shared by two clones of one repository
 * or two copies of the starter, so the second one opened showed the first one's edits as its own
 * unsaved changes, and Save wrote them to its robot.json (issue #403).
 */
export const robotDraftKey = (project: Pick<Project, "source" | "name" | "link">): string =>
  `${projectKey(project)}#${project.link.robot}`;

/**
 * The draft left once `written` has been saved. A Save takes a while (a permission prompt, a GitHub
 * commit) and the numbers stay editable meanwhile, so a draft edited during the save is kept: only a
 * draft that still holds what was written goes (issue #403).
 */
export function draftAfterSave<T extends { robot: Robot }>(now: T | null, written: Robot): T | null {
  return now === null || sameRobot(withCurrentCommands(now.robot, written), written) ? null : now;
}
