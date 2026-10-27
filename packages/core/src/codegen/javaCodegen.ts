import type {
  BranchStep,
  CommandCall,
  CommandStep,
  Heading,
  ParallelStep,
  PathStep,
  Segment,
  TransferStep,
  WaitStep,
} from "@horizon36596/zenith-schema";
import type { Pose } from "../geometry/vec.js";
import { makeSimCurve, type SimCurve, type XY } from "../sim/curves.js";
import { buildSimPath, parameterAtFraction } from "../sim/pedroPath.js";
import { TURN_IN_PLACE_MAX_IN } from "../turnInPlace.js";
import type { Plan, PlanStep } from "../types.js";

/**
 * The command library the robot runtime builds on, from `zenith.json` `deploy.commandLibrary`
 * (site/docs/command-libraries.md). Neither library is a default: every command that writes Java
 * refuses until the project names one.
 */
export type CommandLibrary = "solverslib" | "ivy";

/** Both libraries, in the order Zenith lists them. Neither is a default. */
export const LIBRARIES: readonly CommandLibrary[] = ["solverslib", "ivy"];

/** The Java package each library's runtime classes live in. */
export const RUNTIME_PACKAGE: Readonly<Record<CommandLibrary, string>> = {
  solverslib: "org.horizon36596.zenith.solverslib",
  ivy: "org.horizon36596.zenith.ivy",
};

/** The name a person reads, for CLI output, the desktop deploy preview and the editor. */
export const LIBRARY_LABEL: Readonly<Record<CommandLibrary, string>> = {
  solverslib: "SolversLib",
  ivy: "Ivy",
};

/**
 * What `zenith codegen` says when `zenith.json` names no command library, so the CLI and the
 * editor's Code tab refuse in the same words.
 */
export const NO_COMMAND_LIBRARY_MESSAGE =
  'zenith.json does not say which command library your robot code uses, and Zenith does not pick one. ' +
  'Add "commandLibrary": "solverslib" or "commandLibrary": "ivy" to its "deploy" section. ' +
  "See https://libraries.horizon36596.org/zenith/command-libraries/.";

/**
 * The `codegen` section `zenith init` writes, and the one the editor's Code tab tells a project with
 * none to add: Zenith's Java goes in a `zenith` package of its own inside TeamCode, the FTC SDK's
 * module for a team's code, as in the starter example.
 */
export const STARTER_CODEGEN_SECTION: Readonly<{ package: string; dir: string }> = {
  package: "org.firstinspires.ftc.teamcode.zenith",
  dir: "TeamCode/src/main/java",
};

/** What `zenith codegen` says when `zenith.json` has no `codegen` section to name the package. */
export const NO_CODEGEN_SECTION_MESSAGE =
  'zenith.json has no "codegen" section (package and dir); add one before running zenith codegen.';

/**
 * What `zenith codegen` says, under the findings table, when the auto has errors and it writes
 * nothing. The editor's Code tab says it in its own words, with a way to the errors.
 */
export function codegenBlockedMessage(errorCount: number): string {
  const errors = `${String(errorCount)} error${errorCount === 1 ? "" : "s"}`;
  return `zenith codegen writes no Java while the auto has ${errors}. Fix ${errorCount === 1 ? "it" : "them"} first.`;
}

/**
 * `zenith codegen`: a readable Java class a student can read as the plan
 * (site/docs/robot-runtime.md, "Generated Java"). It is derived and never edited; the file
 * is the source of truth. It is an abstract subclass of the chosen runtime's `AutoFromFile`
 * (`deploy.commandLibrary`, which has no default) that overrides `startPose()` and `buildRoutine()`,
 * and every call here is against that runtime's real API (`PathMarkers`, `RobotTimeout`,
 * `WaitRobotTime`, `NamedCommands`, `DeferredPath`, `TurnInPlace` for a path step short enough to be a
 * turn on the spot, and the `AutoContext` methods `step`, `alliance`,
 * `followPath` and `defaultSpeedFraction`, and `AutoFromFile`'s `headingRad` and `turnRad`), so a
 * reader who goes looking for `PathMarkers.wrap` or `NamedCommands.build` finds them. Every pose goes
 * through `alliance(...)` and every heading through `headingRad` and `turnRad`, so the class mirrors a
 * file run as the other alliance exactly as the runtime's AutoBuilder does.
 *
 * The two forms build the same tree as their runtime's AutoBuilder. The SolversLib form
 * (`org.horizon36596.zenith.solverslib`) uses SolversLib's `Pose2d`, converted with `Poses.toPedro`, and its
 * `SequentialCommandGroup`, `ConditionalCommand`, `WaitUntilCommand` and `InstantCommand`. The Ivy
 * form (`org.horizon36596.zenith.ivy`) uses Pedro's `Pose`, the runtime's `Sequence` and `Branch`, and
 * Ivy's `Commands.waitUntil` and `Commands.instant`.
 *
 * A path whose first segment starts from `"current"` is written as `DeferredPath.of`, the call the
 * runtime's AutoBuilder makes for such a step, so it is built when the step starts from the live pose.
 * Only the numbers that come from the path's length (the segment lengths that place a marker anywhere
 * but the start, a heading shared out by arc length) are the planned path's there, and the class says
 * so. A step planned as a turn on the spot measures its live path with `PedroPaths.lengthIn` and
 * follows it instead when it is longer, as AutoBuilder does, and its end condition is looked up at
 * init and handed to the method that builds it.
 *
 * Deterministic: every number in the plan is already resolved (waypoints included), so the same
 * auto and the same sha always produce byte-identical Java. No clock, no randomness.
 *
 * It lives in core, not the CLI, because it is pure: the CLI writes its output to a file, and the
 * editor's Code tab runs the same function in the browser to show the class as the auto changes.
 */

export interface JavaCodegenOptions {
  /** Dotted Java package, e.g. `org.firstinspires.ftc.teamcode.opmode.Auto`. */
  packageName: string;
  /** Short hex digest of the source file's canonical bytes, printed in the header comment. */
  shaHex: string;
  /** The auto file's path as it should read in the header, e.g. `autos/first-auto.auto.json`. */
  sourcePath: string;
  /** `zenith.json` `deploy.commandLibrary`: which runtime the class is written against. */
  commandLibrary: CommandLibrary;
  /**
   * Set to write the exported form (`zenith codegen --export`, issue #535) instead of the reference
   * class: a concrete `@Autonomous` OpMode the team owns, which reads no auto file. Left out, the
   * reference class is written, byte for byte as before.
   */
  exported?: ExportOptions;
}

/**
 * What the exported form needs besides the routine, all from `zenith.json` `deploy`: the robot it
 * constructs and the TeleOp the Driver Station preselects after it.
 */
export interface ExportOptions {
  /** `deploy.robotClass`: the team's `ZenithRobot`, fully qualified. */
  robotClass: string;
  /** `deploy.preselectTeleOp`; the annotation leaves it out when unset. */
  preselectTeleOp?: string;
}

/** Which of the two classes a run writes, for the editor's Code tab. */
export type CodegenForm = "reference" | "export";

/**
 * What `zenith codegen --export` and the Code tab's Export say when `zenith.json` names no robot
 * class: the exported OpMode constructs one, and Zenith never invents a class name.
 */
export const NO_ROBOT_CLASS_EXPORT_MESSAGE =
  'zenith.json has no "deploy.robotClass", and the exported OpMode constructs your robot. Set it to your ' +
  'ZenithRobot class, fully qualified (for example "org.firstinspires.ftc.teamcode.zenith.MyRobot").';

/** The exported class's name: `first-auto` -> `FirstAutoExported`. */
export const exportedClassName = (autoName: string): string => `${pascalCase(autoName)}Exported`;

/** The reference class's name: `first-auto` -> `FirstAutoGenerated`. */
export const generatedClassName = (autoName: string): string => `${pascalCase(autoName)}Generated`;

/** What differs between the SolversLib and Ivy forms of the generated class. */
interface Dialect {
  imports: string[];
  /** What the exported form imports besides `imports`: the annotation, the in-code spec, the robot. */
  exportImports: string[];
  /** The type `loadSpec()` returns, and the class whose `inCode` builds it. */
  specType: string;
  /** The pose type `startPose()` and the `pose(...)` helper return. */
  poseType: string;
  /** The body of the `pose(...)` helper. */
  newPose: string;
  /** A pose from `alliance(...)` as the Pedro pose `Paths` takes. */
  toPedro: (pose: string) => string;
  /** Pedro's pose class, as the class names it: `TurnInPlace` holds one. */
  pedroPose: string;
  waitUntil: (condition: string) => string;
  /** The sequential group class, written `new <it>(members...)`. */
  sequenceClass: string;
  emptyArm: string;
  branch: (thenArm: string, elseArm: string, condition: string) => string;
}

const SOLVERSLIB_PACKAGE = RUNTIME_PACKAGE.solverslib;

const SOLVERSLIB: Dialect = {
  imports: [
    "import com.pedropathing.api.Paths;",
    "import com.pedropathing.paths.Path;",
    "import com.seattlesolvers.solverslib.command.Command;",
    "import com.seattlesolvers.solverslib.command.ConditionalCommand;",
    "import com.seattlesolvers.solverslib.command.InstantCommand;",
    "import com.seattlesolvers.solverslib.command.SequentialCommandGroup;",
    "import com.seattlesolvers.solverslib.command.WaitUntilCommand;",
    "import com.seattlesolvers.solverslib.geometry.Pose2d;",
    "import com.seattlesolvers.solverslib.geometry.Rotation2d;",
    "",
    "import org.horizon36596.zenith.Args;",
    "import org.horizon36596.zenith.PedroPaths;",
    `import ${SOLVERSLIB_PACKAGE}.AutoFromFile;`,
    `import ${SOLVERSLIB_PACKAGE}.DeferredPath;`,
    `import ${SOLVERSLIB_PACKAGE}.NamedCommands;`,
    `import ${SOLVERSLIB_PACKAGE}.Parallel;`,
    `import ${SOLVERSLIB_PACKAGE}.PathMarkers;`,
    `import ${SOLVERSLIB_PACKAGE}.Poses;`,
    `import ${SOLVERSLIB_PACKAGE}.RobotTimeout;`,
    `import ${SOLVERSLIB_PACKAGE}.TurnInPlace;`,
    `import ${SOLVERSLIB_PACKAGE}.WaitRobotTime;`,
  ],
  exportImports: [
    "import com.qualcomm.robotcore.eventloop.opmode.Autonomous;",
    `import ${SOLVERSLIB_PACKAGE}.AutoSpec;`,
    `import ${SOLVERSLIB_PACKAGE}.ZenithRobot;`,
  ],
  specType: "AutoSpec",
  poseType: "Pose2d",
  newPose: "new Pose2d(xIn, yIn, new Rotation2d(headingRad))",
  toPedro: (pose) => `Poses.toPedro(${pose})`,
  pedroPose: "com.pedropathing.math.Pose",
  waitUntil: (condition) => `new WaitUntilCommand(${condition})`,
  sequenceClass: "SequentialCommandGroup",
  emptyArm: "new InstantCommand()",
  branch: (thenArm, elseArm, condition) => `new ConditionalCommand(${thenArm}, ${elseArm}, ${condition})`,
};

const IVY_PACKAGE = RUNTIME_PACKAGE.ivy;

const IVY: Dialect = {
  imports: [
    "import com.pedropathing.api.Paths;",
    "import com.pedropathing.ivy.Command;",
    "import com.pedropathing.ivy.commands.Commands;",
    "import com.pedropathing.math.Pose;",
    "import com.pedropathing.paths.Path;",
    "",
    "import org.horizon36596.zenith.Args;",
    "import org.horizon36596.zenith.PedroPaths;",
    `import ${IVY_PACKAGE}.AutoFromFile;`,
    `import ${IVY_PACKAGE}.Branch;`,
    `import ${IVY_PACKAGE}.DeferredPath;`,
    `import ${IVY_PACKAGE}.NamedCommands;`,
    `import ${IVY_PACKAGE}.Parallel;`,
    `import ${IVY_PACKAGE}.PathMarkers;`,
    `import ${IVY_PACKAGE}.RobotTimeout;`,
    `import ${IVY_PACKAGE}.Sequence;`,
    `import ${IVY_PACKAGE}.TurnInPlace;`,
    `import ${IVY_PACKAGE}.WaitRobotTime;`,
  ],
  exportImports: [
    "import com.qualcomm.robotcore.eventloop.opmode.Autonomous;",
    "import org.horizon36596.zenith.AutoFile;",
    `import ${IVY_PACKAGE}.ZenithRobot;`,
  ],
  specType: "AutoFile",
  poseType: "Pose",
  newPose: "new Pose(xIn, yIn, headingRad)",
  toPedro: (pose) => pose,
  pedroPose: "Pose",
  waitUntil: (condition) => `Commands.waitUntil(${condition})`,
  sequenceClass: "Sequence",
  // Never Command.NOOP, which never finishes.
  emptyArm: "Commands.instant(() -> { })",
  branch: (thenArm, elseArm, condition) => `Branch.of(${condition}, ${thenArm}, ${elseArm})`,
};

const DIALECTS: Readonly<Record<CommandLibrary, Dialect>> = { solverslib: SOLVERSLIB, ivy: IVY };

const INDENT = "    ";

/** `first-auto` -> `FirstAuto`; the class is `<Pascal>Generated`. */
export function pascalCase(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** `first-auto` -> `firstAuto`, for a private helper method name. */
function camelCase(name: string): string {
  const pascal = pascalCase(name);
  return pascal.length === 0 ? "step" : pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** A Java double literal: always carries a decimal point, four places, no trailing noise. */
function num(value: number): string {
  const rounded = Number(value.toFixed(4));
  const text = (rounded === 0 ? 0 : rounded).toString();
  return text.includes(".") || text.includes("e") ? text : `${text}.0`;
}

function javaString(value: string): string {
  return JSON.stringify(value);
}

function poseExpr(pose: Pose, comment?: string): string {
  const base = `alliance(pose(${num(pose.xIn)}, ${num(pose.yIn)}, ${num(pose.headingRad)}))`;
  return comment === undefined ? base : `${base} /* ${comment} */`;
}

function argsExpr(args: CommandCall["args"]): string {
  const entries = Object.entries(args ?? {});
  // Args.of, not Map.of: Map.of is Android API 30 and a Control Hub runs API 24.
  if (entries.length === 0) return "Args.of()";
  const parts = entries.map(([key, value]) => {
    const javaValue =
      typeof value === "string" ? javaString(value) : typeof value === "boolean" ? String(value) : num(value);
    return `${javaString(key)}, ${javaValue}`;
  });
  return `Args.of(${parts.join(", ")})`;
}

function commandCallExpr(call: CommandCall): string {
  return `NamedCommands.build(${javaString(call.name)}, ${argsExpr(call.args)}, this)`;
}

/** The raw `from` a segment names, for a short comment: a waypoint ref, "current", or nothing. */
function fromComment(segment: Segment): string | undefined {
  if (segment.from === "current") return "current";
  if (typeof segment.from === "object" && "ref" in segment.from) return `ref: ${segment.from.ref}`;
  return undefined;
}

function toComment(segment: Segment): string | undefined {
  if (typeof segment.to === "object" && "ref" in segment.to) return `ref: ${segment.to.ref}`;
  return undefined;
}

/**
 * One segment's bare curve, no heading yet: `Paths.line(...)` or `Paths.curve(...)`. `liveFrom` names
 * the variable holding the robot's pose when the step starts, for a first segment from `"current"`.
 */
function curveExpr(dialect: Dialect, segment: Segment, fromPose: Pose, toPose: Pose, liveFrom?: string): string {
  const points = pointExprs(dialect, segment, fromPose, toPose, liveFrom);
  return segment.kind === "line" ? `Paths.line(${points.join(", ")})` : `Paths.curve(${points.join(", ")})`;
}

/** One segment's control polygon as Pedro poses in Java: its start, any control points, its end. */
function pointExprs(dialect: Dialect, segment: Segment, fromPose: Pose, toPose: Pose, liveFrom?: string): string[] {
  const from = dialect.toPedro(liveFrom ?? poseExpr(fromPose, fromComment(segment)));
  const to = dialect.toPedro(poseExpr(toPose, toComment(segment)));
  if (segment.kind === "line") return [from, to];
  const controls = segment.control.map((point) =>
    dialect.toPedro(poseExpr({ xIn: point.xIn, yIn: point.yIn, headingRad: point.headingRad ?? 0 })),
  );
  return [from, ...controls, to];
}

/**
 * A heading the file wrote, in the running alliance's frame: `AutoFromFile.headingRad`, which mirrors
 * it through the same `alliance(...)` the poses go through, so a file run as the other alliance faces
 * the other alliance's way.
 */
const headingExpr = (rad: number): string => `headingRad(${num(rad)})`;

/**
 * A heading reached by turning `turn` from `rad`, in the running alliance's frame: the start through
 * `headingRad`, the turn through `turnRad`, which keeps its size and reverses it under a reflection.
 * `turnExpr` is Java, so a range can turn by an expression in t.
 */
const turnedExpr = (rad: number, turnExpr: string | null): string =>
  turnExpr === null ? headingExpr(rad) : `${headingExpr(rad)} + turnRad(${turnExpr})`;

/** A point a `facePoint` heading faces, through `alliance(...)` like every other pose. */
const pointExpr = (dialect: Dialect, xIn: number, yIn: number): string =>
  dialect.toPedro(poseExpr({ xIn, yIn, headingRad: 0 }));

/** Pedro's own interpolator for one range's mode, or a range-local turn for `linear`. */
function rangeInterpolatorExpr(
  dialect: Dialect,
  range: Extract<Heading, { mode: "piecewise" }>["ranges"][number],
  from: number,
  to: number,
  localFrom: number,
  localTo: number,
): string {
  const interpolator = "com.pedropathing.paths.interpolator.Interpolator";
  const inner = range.heading;
  switch (inner.mode) {
    case "tangent":
      return `${interpolator}.tangent`;
    case "tangentReversed":
      return `${interpolator}.tangent.reverse()`;
    case "constant":
      return `${interpolator}.constant(${headingExpr(inner.headingRad)})`;
    case "facePoint":
      return `${interpolator}.facingPoint(${pointExpr(dialect, inner.xIn, inner.yIn)})`;
    case "linear": {
      // Pedro's Interpolator.linear runs over the whole of t, so a range turns over its own stretch
      // with a small lambda, the short way, as PathBuilder.rangeInterpolator does.
      const span = range.endT - range.startT;
      const raw = inner.toRad - inner.fromRad;
      const wrapped = ((((raw + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
      const at = (fraction: number): number =>
        inner.fromRad + wrapped * (span <= 0 ? 1 : (fraction - range.startT) / span);
      const start = at(from);
      const delta = at(to) - start;
      const localSpan = localTo - localFrom;
      const progress = `Math.min(1, Math.max(0, (t - ${num(localFrom)}) / ${num(localSpan > 0 ? localSpan : 1)}))`;
      const already = start - inner.fromRad;
      const turn = `${Number(num(already)) === 0 ? "" : `${num(already)} + `}${num(delta)} * ${progress}`;
      return `(curve, t) -> ${turnedExpr(inner.fromRad, turn)}`;
    }
  }
}

/**
 * A `piecewise` heading on one segment, clipped to it the way `PathBuilder.piecewiseFor` clips it.
 * Each clipped end is turned from its arc-length fraction into the segment's own t through the
 * runtime's chord table (`parameterAtFraction`, `PedroPaths.parameterAt`), as the runtime does, so a
 * range ends where it does on the robot even on a lopsided curve.
 */
function piecewiseExpr(
  dialect: Dialect,
  heading: Extract<Heading, { mode: "piecewise" }>,
  curve: SimCurve,
  startFraction: number,
  endFraction: number,
): string {
  const span = endFraction - startFraction;
  const pieces: { end: number; expr: string }[] = [];
  let previous = 0;
  heading.ranges.forEach((range, index) => {
    const from = Math.max(range.startT, startFraction);
    const to = Math.min(range.endT, endFraction);
    if (to <= from && !(span <= 0 && index === heading.ranges.length - 1)) return;
    const localFrom = span <= 0 ? 0 : parameterAtFraction(curve, (from - startFraction) / span);
    const localTo = span <= 0 ? 1 : parameterAtFraction(curve, (to - startFraction) / span);
    if (localTo <= previous) return;
    pieces.push({ end: localTo, expr: rangeInterpolatorExpr(dialect, range, from, to, localFrom, localTo) });
    previous = localTo;
  });
  const last = pieces[pieces.length - 1];
  if (last !== undefined) last.end = 1;
  const untils = pieces.map((piece) => `.until(${num(piece.end)}, ${piece.expr})`).join("");
  return `com.pedropathing.paths.interpolator.Interpolator.piecewise()${untils}`;
}

/**
 * Attaches the step's heading mode to one segment's curve. Mirrors `PedroPaths.withHeading`, with the
 * heading in the running alliance's frame as `AllianceFrame` puts it there: every heading through
 * `headingRad`, every turn through `turnRad`, every point through `alliance(...)`.
 */
function withHeadingExpr(
  dialect: Dialect,
  curve: string,
  shape: SimCurve,
  heading: Heading | undefined,
  startFraction = 0,
  endFraction = 1,
): string {
  if (heading === undefined) return curve;
  switch (heading.mode) {
    case "piecewise":
      return `${curve}.heading(${piecewiseExpr(dialect, heading, shape, startFraction, endFraction)})`;
    case "tangent":
      return `${curve}.tangent()`;
    case "tangentReversed":
      return `${curve}.reverseTangent()`;
    case "constant":
      return `${curve}.constant(${headingExpr(heading.headingRad)})`;
    case "linear": {
      // One sweep across the whole step, cut into the share this segment owns by arc length, as
      // PedroPaths.withHeading cuts it, so a two-segment path turns half way by the join. The sweep
      // is a turn, so the other alliance turns it the mirrored way.
      const sweep = heading.toRad - heading.fromRad;
      const turn = (fraction: number): string | null => {
        const turned = num(sweep * fraction);
        return Number(turned) === 0 ? null : turned;
      };
      return `${curve}.linear(${turnedExpr(heading.fromRad, turn(startFraction))}, ${turnedExpr(heading.fromRad, turn(endFraction))})`;
    }
    case "facePoint":
      return `${curve}.facingPoint(${pointExpr(dialect, heading.xIn, heading.yIn)})`;
  }
}

/** One private method of the class and the step that wrote it. */
interface Helper {
  stepId: string;
  text: string;
}

interface Ctx {
  lines: string[];
  /** Each private method in the order it is written, with the id of the step it belongs to. */
  helpers: Helper[];
  usedNames: Set<string>;
  dialect: Dialect;
  /** Set once a step from `"current"` has been written, so the class imports `DeferredPath`. */
  deferred: { used: boolean };
  /** Set once a turn on the spot has been written, so the class imports `TurnInPlace`. */
  turned: { used: boolean };
  /** Set once a step measures its live path, so the class imports `PedroPaths`. */
  measured: { used: boolean };
}

/**
 * A unique, readable method name for a step, so two steps that share an id never collide. Prefixed
 * with `step` so a step called `drive`, `follower` or `run` cannot shadow a method the class inherits
 * from `AutoFromFile`, its `AutoContext` or the SDK's OpMode, which would not compile.
 */
function methodName(ctx: Ctx, id: string): string {
  return uniqueName(ctx, `step${pascalCase(id) || "Unnamed"}`);
}

/** `base`, or `base` with the first free number after it, reserved so no later method takes it. */
function uniqueName(ctx: Ctx, base: string): string {
  let candidate = base;
  let suffix = 2;
  while (ctx.usedNames.has(candidate)) {
    candidate = `${base}${String(suffix)}`;
    suffix += 1;
  }
  ctx.usedNames.add(candidate);
  return candidate;
}

function pushLines(ctx: Ctx, indent: string, text: string): void {
  ctx.lines.push(`${indent}${text}`);
}

/** True when the step's first segment starts from `"current"`, which the runtime builds when the step starts. */
function startsFromCurrent(planStep: PlanStep): boolean {
  return planStep.kind === "path" && (planStep.step as PathStep).segments[0]?.from === "current";
}

/**
 * The body of a path step that starts from `"current"`: `DeferredPath.of`, the runtime's own call for
 * such a step, which builds the path from the live pose when the step starts by calling `buildName`.
 * The marker commands are built here, at init, as the runtime builds them, for their requirements.
 */
function generateDeferredPathBody(ctx: Ctx, planStep: PlanStep, buildName: string, indent: string): void {
  const step = planStep.step as PathStep;
  const markers = (step.markers ?? []).map((marker) => `, ${commandCallExpr(marker.command)}`).join("");
  pushLines(ctx, indent, `// Starts from "current": built when the step starts, from where the robot is then.`);
  let args = "from";
  if (step.endCondition !== undefined) {
    // Looked up now, at init, as AutoBuilder looks it up: a condition nobody registered throws on the
    // tile, not when the step starts mid-match.
    pushLines(
      ctx,
      indent,
      `${END_CONDITION_TYPE} ${END_CONDITION_VAR} = NamedCommands.condition(${javaString(step.endCondition.condition)});`,
    );
    args = `from, ${END_CONDITION_VAR}`;
  }
  pushLines(ctx, indent, `return DeferredPath.of(${javaString(planStep.id)}, this, from -> ${buildName}(${args})${markers});`);
}

/** The end condition of a step from `"current"`, looked up at init and handed to the method that builds it. */
const END_CONDITION_TYPE = "java.util.function.BooleanSupplier";
const END_CONDITION_VAR = "endCondition";

/**
 * True when some number in a path step's Java comes from the step's length, which for a step from
 * `"current"` is the planned one here and the live one on the robot: a marker anywhere but the start,
 * or a heading shared out between segments by arc length.
 */
function dependsOnLength(step: PathStep): boolean {
  // Progress along the path is measured against the segment lengths, so only a marker at its very
  // start fires in the same place whatever the length.
  const markers = (step.markers ?? []).some(
    (marker) => !(("t" in marker.at && marker.at.t === 0) || ("distanceIn" in marker.at && marker.at.distanceIn === 0)),
  );
  const heading =
    step.heading?.mode === "piecewise" || (step.heading?.mode === "linear" && step.segments.length > 1);
  return markers || heading;
}

/**
 * Races `drive` against the step's `endCondition`, as AutoBuilder does, when it has one. A step from
 * `"current"` (`live`) races the supplier its builder was handed, looked up at init.
 */
function pushEndCondition(ctx: Ctx, step: PathStep, indent: string, live = false): void {
  if (step.endCondition === undefined) return;
  const until = ctx.dialect.waitUntil(
    live ? END_CONDITION_VAR : `NamedCommands.condition(${javaString(step.endCondition.condition)})`,
  );
  pushLines(ctx, indent, `drive = Parallel.race(drive, ${until});`);
}

/**
 * The heading a turn on the spot holds, as Java in the running alliance's frame. `headingRad` of the
 * file's end heading (`turnHeading`), since a rigid mirror turns the end heading of every mode exactly
 * as it turns a constant one. The one exception is a tangent with no direction at all, which
 * `PedroPaths.turnHeading` reads as 0 (or pi, reversed) in whatever frame it runs in, so it is
 * written as that number and not mirrored.
 */
function turnHeadingExpr(step: PathStep, polygons: readonly XY[][], fileRad: number): string {
  const heading = step.heading;
  const mode = heading?.mode === "piecewise" ? heading.ranges[heading.ranges.length - 1]?.heading.mode : heading?.mode;
  if (mode === "tangent" || mode === "tangentReversed") {
    const last = polygons[polygons.length - 1] ?? [];
    const end = last[last.length - 1];
    const before = last[last.length - 2];
    const first = last[0];
    if (end !== undefined && before !== undefined && first !== undefined) {
      const direction =
        Math.hypot(end.x - before.x, end.y - before.y) > 1e-9
          ? Math.hypot(end.x - before.x, end.y - before.y)
          : Math.hypot(end.x - first.x, end.y - first.y);
      if (direction <= 1e-9) return num(mode === "tangent" ? 0 : Math.PI);
    }
  }
  return headingExpr(fileRad);
}

/**
 * The heading a turn on the spot from `"current"` holds, as Java: a tangent reads the live `polygons`,
 * as `PedroPaths.turnHeading` does, and every other mode ends where `turnHeadingExpr` says, since
 * the step's end point is the file's.
 */
function liveTurnHeadingExpr(step: PathStep, polygons: readonly XY[][], fileRad: number): string {
  const heading = step.heading;
  const mode = heading?.mode === "piecewise" ? heading.ranges[heading.ranges.length - 1]?.heading.mode : heading?.mode;
  if (mode === "tangent") return "PedroPaths.normalize(PedroPaths.endTangentRad(polygons))";
  if (mode === "tangentReversed") return "PedroPaths.normalize(PedroPaths.endTangentRad(polygons) + Math.PI)";
  return turnHeadingExpr(step, polygons, fileRad);
}

/**
 * The body of a path step no longer than `TURN_IN_PLACE_MAX_IN`, which AutoBuilder runs as a turn on
 * the spot (decision D10): `TurnInPlace` holds the step's end point at its end heading until it
 * settles, and is never handed to `followPath`. Its markers start with the turn and end with it,
 * through `PathMarkers` with every marker at 0.
 */
function generateTurnBody(
  ctx: Ctx,
  planStep: PlanStep,
  polygons: readonly XY[][],
  turn: { x: number; y: number; heading: number },
  indent: string,
  live = false,
): void {
  const step = planStep.step as PathStep;
  const pedroPose = ctx.dialect.pedroPose;
  ctx.turned.used = true;
  pushLines(
    ctx,
    indent,
    `// At most ${String(TURN_IN_PLACE_MAX_IN)} in long: a turn on the spot, held at its end pose until it settles, never handed to followPath.`,
  );
  const last = step.segments[step.segments.length - 1];
  const endPose = ctx.dialect.toPedro(
    poseExpr({ xIn: turn.x, yIn: turn.y, headingRad: 0 }, last === undefined ? undefined : toComment(last)),
  );
  pushLines(ctx, indent, `${pedroPose} end = ${endPose};`);
  pushLines(
    ctx,
    indent,
    `Command drive = new TurnInPlace(this, new ${pedroPose}(end.x(), end.y(), ${live ? liveTurnHeadingExpr(step, polygons, turn.heading) : turnHeadingExpr(step, polygons, turn.heading)}));`,
  );
  const markers = step.markers ?? [];
  if (markers.length > 0) {
    // Every marker sits at 0 and starts with the turn, through the same runner a path's markers use,
    // so two that need one subsystem take turns; the end condition races the turn and its markers.
    pushLines(ctx, indent, "double[] segmentLengthsIn = { 0.0 };");
    pushLines(ctx, indent, "java.util.List<PathMarkers.Marker> markers = new java.util.ArrayList<PathMarkers.Marker>();");
    for (const marker of markers) {
      pushLines(ctx, indent, `markers.add(new PathMarkers.Marker(0.0, ${commandCallExpr(marker.command)}));`);
    }
    pushLines(ctx, indent, "drive = PathMarkers.wrap(drive, segmentLengthsIn, markers, this);");
  }
  pushEndCondition(ctx, step, indent, live);
  pushLines(ctx, indent, "return drive;");
}

/**
 * Builds the `Command` for a path step's body, as the statements of a private helper method.
 * `liveFrom` is set for a step from `"current"`: the name of the parameter holding the live pose.
 */
function generatePathBody(ctx: Ctx, planStep: PlanStep, indent: string, liveFrom?: string): void {
  const step = planStep.step as PathStep;
  const segments = planStep.segments ?? [];
  // Each segment's control polygon as the file wrote it. A rigid mirror keeps every length and every
  // segment's t, so the runtime's measurements on the mirrored path are these.
  const polygons: XY[][] = segments.map((segment, index) => [
    { x: segment.fromPose.xIn, y: segment.fromPose.yIn },
    ...(step.segments[index]?.kind === "bezier"
      ? (step.segments[index] as Extract<Segment, { kind: "bezier" }>).control.map((point) => ({
          x: point.xIn,
          y: point.yIn,
        }))
      : []),
    { x: segment.toPose.xIn, y: segment.toPose.yIn },
  ]);
  const fallbackRad = segments[segments.length - 1]?.toPose.headingRad ?? 0;
  const turn = polygons.length === 0 ? null : buildSimPath(polygons, step.heading, fallbackRad).turn;
  if (turn === null) {
    generateFollowBody(ctx, planStep, polygons, indent, liveFrom);
    return;
  }
  if (liveFrom === undefined) {
    generateTurnBody(ctx, planStep, polygons, turn, indent);
    return;
  }
  // From "current", AutoBuilder measures the path it builds from the live pose and turns on the spot
  // only when that is still this short; the generated class measures the same path and decides the same.
  ctx.measured.used = true;
  const pedroPose = ctx.dialect.pedroPose;
  pushLines(
    ctx,
    indent,
    `// At most ${String(TURN_IN_PLACE_MAX_IN)} in long as planned. The live path decides, as in AutoBuilder: longer, and it is followed.`,
  );
  pushLines(ctx, indent, `java.util.List<${pedroPose}[]> polygons = new java.util.ArrayList<${pedroPose}[]>();`);
  segments.forEach((segment, index) => {
    const raw = step.segments[index];
    if (raw === undefined) return;
    const points = pointExprs(ctx.dialect, raw, segment.fromPose, segment.toPose, index === 0 ? liveFrom : undefined);
    pushLines(ctx, indent, `polygons.add(new ${pedroPose}[] { ${points.join(", ")} });`);
  });
  pushLines(ctx, indent, "if (PedroPaths.lengthIn(polygons) > PedroPaths.TURN_IN_PLACE_MAX_IN) {");
  generateFollowBody(ctx, planStep, polygons, indent + INDENT, liveFrom);
  pushLines(ctx, indent, "}");
  generateTurnBody(ctx, planStep, polygons, turn, indent, true);
}

/** The body of a path step Pedro follows: its segments, `followPath`, its end condition and markers. */
function generateFollowBody(
  ctx: Ctx,
  planStep: PlanStep,
  polygons: readonly XY[][],
  indent: string,
  liveFrom?: string,
): void {
  const step = planStep.step as PathStep;
  const segments = planStep.segments ?? [];
  const curveVars: string[] = [];
  if (liveFrom !== undefined && dependsOnLength(step)) {
    pushLines(
      ctx,
      indent,
      "// The lengths, marker distances and heading splits below are the planned path's; the runtime measures the live one.",
    );
  }
  segments.forEach((segment, index) => {
    const raw = step.segments[index];
    if (raw === undefined) {
      throw new Error(
        `codegen: step "${planStep.id}" segment ${String(index)} has no source segment; plan() and the file disagree on segment count.`,
      );
    }
    const curve = curveExpr(ctx.dialect, raw, segment.fromPose, segment.toPose, index === 0 ? liveFrom : undefined);
    const breaks = planStep.geometry?.breaks;
    const total = planStep.geometry?.lengthIn ?? 0;
    const startFraction = breaks === undefined || total === 0 ? 0 : (breaks[index] ?? 0) / total;
    const endFraction = breaks === undefined || total === 0 ? 1 : (breaks[index + 1] ?? total) / total;
    const shape = makeSimCurve(polygons[index] as XY[]);
    const withHeading = withHeadingExpr(ctx.dialect, curve, shape, step.heading, startFraction, endFraction);
    const varName = `seg${String(index)}`;
    pushLines(ctx, indent, `Path ${varName} = ${withHeading};`);
    curveVars.push(varName);
  });
  const pathExpr = curveVars.length === 1 ? (curveVars[0] as string) : `Paths.path(${curveVars.join(", ")})`;
  pushLines(ctx, indent, `Path path = ${pathExpr};`);
  // No speedFraction in the file means the robot's own default, exactly as AutoBuilder reads it.
  const speed = step.speedFraction === undefined ? "defaultSpeedFraction()" : num(step.speedFraction);
  pushLines(ctx, indent, `Command drive = followPath(path, ${speed});`);
  const markers = step.markers ?? [];
  if (markers.length === 0) {
    pushEndCondition(ctx, step, indent, liveFrom !== undefined);
    pushLines(ctx, indent, "return drive;");
    return;
  }
  const totalLengthIn = planStep.lengthIn;
  const breaks = planStep.geometry?.breaks ?? [0, totalLengthIn];
  const segmentLengths = breaks.slice(1).map((end, index) => end - (breaks[index] ?? 0));
  pushLines(ctx, indent, `double[] segmentLengthsIn = { ${segmentLengths.map(num).join(", ")} };`);
  pushLines(ctx, indent, "java.util.List<PathMarkers.Marker> markers = new java.util.ArrayList<PathMarkers.Marker>();");
  for (const marker of markers) {
    // A distance from either end is clamped to the path, so a path shortened after its marker was
    // set never emits a negative distance or one past its end (W2-11).
    const distanceIn =
      "t" in marker.at
        ? marker.at.t * totalLengthIn
        : "distanceIn" in marker.at
          ? Math.min(totalLengthIn, marker.at.distanceIn)
          : Math.max(0, totalLengthIn - marker.at.distanceFromEndIn);
    pushLines(
      ctx,
      indent,
      `markers.add(new PathMarkers.Marker(${num(distanceIn)}, ${commandCallExpr(marker.command)}));`,
    );
  }
  if (step.endCondition === undefined) {
    pushLines(ctx, indent, "return PathMarkers.wrap(drive, segmentLengthsIn, markers, this);");
    return;
  }
  // The end condition races the path together with its markers, as AutoBuilder builds it, so a path
  // cut short ends its marker runner on the same loop.
  pushLines(ctx, indent, "drive = PathMarkers.wrap(drive, segmentLengthsIn, markers, this);");
  pushEndCondition(ctx, step, indent, liveFrom !== undefined);
  pushLines(ctx, indent, "return drive;");
}

function generateCommandBody(ctx: Ctx, planStep: PlanStep, indent: string): void {
  const step = planStep.step as CommandStep;
  pushLines(ctx, indent, `return ${commandCallExpr({ name: step.name, args: step.args })};`);
}

function generateWaitBody(ctx: Ctx, planStep: PlanStep, indent: string): void {
  const step = planStep.step as WaitStep;
  if (step.until !== undefined) {
    pushLines(ctx, indent, `return ${ctx.dialect.waitUntil(`NamedCommands.condition(${javaString(step.until)})`)};`);
    return;
  }
  pushLines(ctx, indent, `return new WaitRobotTime(${String(Math.round((step.seconds ?? 0) * 1000))}, this);`);
}

/**
 * A planner-only transfer: the robot does nothing, so the generated code is what the runtime runs
 * in its place, a wait of zero seconds, with the transfer written above it as a comment only. The
 * ids are quoted as JSON so no id can end the comment early.
 */
function generateTransferBody(ctx: Ctx, planStep: PlanStep, indent: string): void {
  const step = planStep.step as TransferStep;
  const actual = step.actualCount === undefined ? "" : `, actual ${String(step.actualCount)}`;
  pushLines(
    ctx,
    indent,
    `// Planner-only transfer: ${String(step.expectedCount)} expected${actual}, from ${JSON.stringify(step.from)} to ${JSON.stringify(step.to)}. The robot does nothing here.`,
  );
  pushLines(ctx, indent, "return new WaitRobotTime(0, this);");
}

function generateParallelBody(ctx: Ctx, planStep: PlanStep, indent: string): void {
  const step = planStep.step as ParallelStep;
  const children = planStep.children ?? [];
  pushLines(ctx, indent, "java.util.List<Command> members = new java.util.ArrayList<Command>();");
  let deadlineVar: string | null = null;
  // Two ids can read the same in camelCase (`arm-1` and `arm1`), so a later one takes the first free
  // number after it, as a method name does, and no local is declared twice.
  const locals = new Set<string>();
  for (const child of children) {
    const name = stepCall(ctx, child);
    const base = camelCase(child.id);
    let local = base;
    for (let suffix = 2; locals.has(local); suffix += 1) local = `${base}${String(suffix)}`;
    locals.add(local);
    const varName = `m_${local}`;
    const memberVar = `member_${local}`;
    pushLines(ctx, indent, `Command ${varName} = ${name}();`);
    // The wrapped command is hoisted into its own local exactly once, then both added to members
    // and (when this is the deadline child) reused as `deadline` — the same object, not a second
    // `step(...)` call building a fresh wrapper WPILib would reject as "added to more than one
    // CommandGroup" (finding 7).
    pushLines(ctx, indent, `Command ${memberVar} = step(${javaString(child.id)}, ${varName});`);
    pushLines(ctx, indent, `members.add(${memberVar});`);
    if (child.id === step.deadline) deadlineVar = memberVar;
  }
  if (step.mode === "all") {
    pushLines(ctx, indent, "return Parallel.all(members.toArray(new Command[0]));");
  } else if (step.mode === "race") {
    pushLines(ctx, indent, "return Parallel.race(members.toArray(new Command[0]));");
  } else {
    if (deadlineVar === null) {
      // Silently falling back to members.get(0) would run the group against a deadline the auto
      // file never named, disagreeing with whatever packages/core's estimator assumed (finding 6);
      // failing loudly here, naming the step, is the only sound choice codegen can make on its own.
      const names = children.map((child) => child.id).join(", ") || "(no children)";
      throw new Error(
        `codegen: parallel step ${javaString(planStep.id)} has mode "deadline" but its deadline ` +
          `(${JSON.stringify(step.deadline ?? null)}) names no direct child; it must be one of: ${names}.`,
      );
    }
    pushLines(ctx, indent, `Command deadline = ${deadlineVar};`);
    pushLines(ctx, indent, "members.remove(deadline);");
    pushLines(ctx, indent, "return Parallel.deadline(deadline, members.toArray(new Command[0]));");
  }
}

/**
 * A `sequence` step is a `SequentialCommandGroup` (on Ivy, the runtime's `Sequence`) of its members, each wrapped in `step(...)` like
 * the top level's, so the trace names every member and a timeout on a member still applies.
 */
function generateSequenceBody(ctx: Ctx, planStep: PlanStep, indent: string): void {
  const names = (planStep.children ?? []).map((child) => {
    const name = stepCall(ctx, child);
    return `step(${javaString(child.id)}, ${name}())`;
  });
  pushLines(ctx, indent, `return new ${ctx.dialect.sequenceClass}(${names.join(", ")});`);
}

function generateBranchBody(ctx: Ctx, planStep: PlanStep, indent: string): void {
  const step = planStep.step as BranchStep;
  const children = planStep.children ?? [];
  // `resolve()` lays a branch's children out as [...then, ...else] in file order
  // (packages/core/src/resolve.ts), so a slice by count is exact where matching by id would miss a step with no
  // explicit id (resolve gives those an auto id that does not appear in the raw file at all).
  const thenSteps = children.slice(0, step.then.length);
  const elseSteps = children.slice(step.then.length, step.then.length + (step.else?.length ?? 0));
  const sequence = (label: string, steps: PlanStep[]): string => {
    if (steps.length === 0) return ctx.dialect.emptyArm;
    const names = steps.map((child) => {
      const name = stepCall(ctx, child);
      return `step(${javaString(child.id)}, ${name}())`;
    });
    pushLines(ctx, indent, `Command ${label} = new ${ctx.dialect.sequenceClass}(${names.join(", ")});`);
    return label;
  };
  const thenVar = sequence("thenBranch", thenSteps);
  const elseVar = step.else === undefined ? ctx.dialect.emptyArm : sequence("elseBranch", elseSteps);
  pushLines(
    ctx,
    indent,
    `return ${ctx.dialect.branch(thenVar, elseVar, `NamedCommands.condition(${javaString(step.condition)})`)};`,
  );
}

/**
 * Generates one step's private helper method (recursing into `sequence`, `parallel` and `branch`
 * children first).
 */
function generateStepMethod(ctx: Ctx, planStep: PlanStep): string {
  const name = methodName(ctx, planStep.id);
  const body: string[] = [];
  const inner: Ctx = { ...ctx, lines: body };
  const indent = INDENT + INDENT;
  // A step from "current" also gets the method that builds its path, written after its own.
  let buildMethod: string | undefined;
  switch (planStep.kind) {
    case "path":
      if (startsFromCurrent(planStep)) {
        const buildName = uniqueName(ctx, `${name}From`);
        ctx.deferred.used = true;
        generateDeferredPathBody(inner, planStep, buildName, indent);
        const buildBody: string[] = [];
        generatePathBody({ ...inner, lines: buildBody }, planStep, indent, "from");
        const endParam =
          (planStep.step as PathStep).endCondition === undefined ? "" : `, ${END_CONDITION_TYPE} ${END_CONDITION_VAR}`;
        buildMethod = [
          `${INDENT}private Command ${buildName}(${ctx.dialect.poseType} from${endParam}) {`,
          ...buildBody,
          `${INDENT}}`,
        ].join("\n");
      } else {
        generatePathBody(inner, planStep, indent);
      }
      break;
    case "command":
      generateCommandBody(inner, planStep, indent);
      break;
    case "wait":
      generateWaitBody(inner, planStep, indent);
      break;
    case "transfer":
      generateTransferBody(inner, planStep, indent);
      break;
    case "sequence":
      generateSequenceBody(inner, planStep, indent);
      break;
    case "parallel":
      generateParallelBody(inner, planStep, indent);
      break;
    case "branch":
      generateBranchBody(inner, planStep, indent);
      break;
  }
  const method = [
    `${INDENT}private Command ${name}() {`,
    ...body,
    `${INDENT}}`,
  ];
  ctx.helpers.push({ stepId: planStep.id, text: method.join("\n") });
  if (buildMethod !== undefined) ctx.helpers.push({ stepId: planStep.id, text: buildMethod });
  return name;
}

/** Generates a step's method, wraps it in `RobotTimeout` when it has a `timeoutS`, and returns the
 * name of the method to call for its finished command (with or without the timeout wrapper). */
function stepCall(ctx: Ctx, planStep: PlanStep): string {
  const innerName = generateStepMethod(ctx, planStep);
  const timeoutS = (planStep.step as { timeoutS?: number }).timeoutS;
  if (timeoutS === undefined) return innerName;
  const wrapperName = uniqueName(ctx, `${innerName}WithTimeout`);
  ctx.helpers.push({
    stepId: planStep.id,
    text: [
      `${INDENT}private Command ${wrapperName}() {`,
      `${INDENT}${INDENT}return RobotTimeout.of(${innerName}(), ${num(timeoutS)}, this);`,
      `${INDENT}}`,
    ].join("\n"),
  });
  return wrapperName;
}

/**
 * The lines of the generated class that one step wrote, 1-based and inclusive: its call in
 * `buildRoutine()`, its own private method, the method that builds a path from `"current"`, or its
 * timeout wrapper. A step usually has several; a group's members have their own.
 */
export interface JavaStepLines {
  stepId: string;
  startLine: number;
  endLine: number;
}

/** The generated class and, from the same run, which lines each step wrote. */
export interface GeneratedJava {
  text: string;
  /** In line order. Ranges never overlap. */
  stepLines: JavaStepLines[];
}

/**
 * The reference class down to `buildRoutine()`: the licence-free header, its imports, the class comment
 * and `startPose()`. Byte for byte what `zenith codegen` has always written.
 */
function referenceHead(plan: Plan, options: JavaCodegenOptions, className: string, imports: string[]): string[] {
  const dialect = DIALECTS[options.commandLibrary];
  return [
    `/** GENERATED by zenith from ${options.sourcePath} (sha ${options.shaHex}). Do not edit; edit the file. */`,
    "",
    `package ${options.packageName};`,
    "",
    ...imports,
    "",
    "/**",
    ` * GENERATED by zenith from ${options.sourcePath} (sha ${options.shaHex}). Do not edit; edit the file.`,
    " *",
    " * Reads as the plan: one private method per step, called in file order from buildRoutine().",
    " * Abstract, and never referenced by an {@code @Autonomous} OpMode; {@code zenith deploy} writes the",
    " * class that actually runs on the robot.",
    " */",
    `public abstract class ${className} extends AutoFromFile {`,
    "",
    `${INDENT}@Override`,
    `${INDENT}protected ${dialect.poseType} startPose() {`,
    `${INDENT}${INDENT}return ${poseExpr(plan.startPose)};`,
    `${INDENT}}`,
    "",
  ];
}

/**
 * The imports with the exported form's added, each group (third-party, then Zenith) kept in
 * alphabetical order.
 */
function withExportImports(imports: string[], dialect: Dialect): string[] {
  const all = [...imports, ...dialect.exportImports];
  const zenith = all.filter((line) => line.startsWith("import org.horizon36596.")).sort();
  const others = all.filter((line) => line !== "" && !line.startsWith("import org.horizon36596.")).sort();
  return [...others, "", ...zenith];
}

/**
 * The exported OpMode down to `buildRoutine()` (issue #535): a concrete `@Autonomous` class the team
 * owns, which reads no auto file. `loadSpec()` returns the in-code spec, which carries the alliance the
 * poses are written for, the start pose (mirrored like every other pose by `startPose()`, which the
 * class leaves to `AutoFromFile`) and the default path speed `robot.json` gives, since no `robot.json`
 * is read either.
 */
function exportedHead(
  plan: Plan,
  options: JavaCodegenOptions,
  exported: ExportOptions,
  className: string,
  imports: string[],
): string[] {
  const dialect = DIALECTS[options.commandLibrary];
  const auto = plan.auto;
  const title = auto.title ?? auto.name;
  const annotation = [`name = ${javaString(`${title} (exported)`)}`, `group = "Exported"`];
  if (exported.preselectTeleOp !== undefined) {
    annotation.push(`preselectTeleOp = ${javaString(exported.preselectTeleOp)}`);
  }
  const start = plan.startPose;
  const speed = plan.robot.kinematics.defaultPathSpeedFraction.value;
  const library = LIBRARY_LABEL[options.commandLibrary];
  return [
    `/* EXPORTED by zenith from ${options.sourcePath} (sha ${options.shaHex}). This copy is yours to edit. */`,
    "",
    `package ${options.packageName};`,
    "",
    ...imports,
    "",
    "/**",
    ` * EXPORTED by zenith from ${options.sourcePath} (sha ${options.shaHex}), for the ${library} runtime.`,
    " *",
    " * <p>This is the whole auto as Java, and it is the code that runs: it reads no auto file. It is yours",
    " * to edit, to add logging, vision or anything else the auto file cannot hold. Your own code can also",
    " * go in your robot's {@code onStart}, {@code periodic}, {@code afterLoop} and {@code onStop}.",
    " *",
    " * <p><b>Not recommended.</b> Zenith no longer tracks this routine. A change made here is not in the",
    " * auto file, so the editor, its checks and its sim do not see it, and exporting again overwrites",
    " * this file. Keep the auto file as the routine, deployed with {@code zenith deploy}, unless you need",
    " * code it cannot hold. Delete the generated OpMode for the same auto, or the Driver Station lists both.",
    " *",
    " * <p>One private method per step, called in file order from buildRoutine(). It still needs the",
    " * Zenith runtime library and your ZenithRobot.",
    " */",
    `@Autonomous(${annotation.join(", ")})`,
    `public class ${className} extends AutoFromFile {`,
    "",
    `${INDENT}@Override`,
    `${INDENT}protected String autoName() {`,
    `${INDENT}${INDENT}return ${javaString(auto.name)};`,
    `${INDENT}}`,
    "",
    `${INDENT}@Override`,
    `${INDENT}protected ZenithRobot createRobot() {`,
    `${INDENT}${INDENT}return new ${exported.robotClass}();`,
    `${INDENT}}`,
    "",
    `${INDENT}/**`,
    `${INDENT} * No file: the alliance these poses are written for, the start pose in that alliance's frame`,
    `${INDENT} * (mirrored for the other alliance like every pose below), and the speed a path with no speed of`,
    `${INDENT} * its own drives at, from robot.json when this was exported.`,
    `${INDENT} */`,
    `${INDENT}@Override`,
    `${INDENT}protected ${dialect.specType} loadSpec() {`,
    `${INDENT}${INDENT}return ${dialect.specType}.inCode(${javaString(auto.name)}, ${javaString(title)}, ${javaString(auto.alliance)},`,
    `${INDENT}${INDENT}${INDENT}${INDENT}${num(start.xIn)}, ${num(start.yIn)}, ${num(start.headingRad)}, ${num(speed)});`,
    `${INDENT}}`,
    "",
  ];
}

/** Renders the full generated class. Pure: every input is the plan's own numbers. */
export function generateAutoJava(plan: Plan, options: JavaCodegenOptions): string {
  return generateAutoJavaWithMap(plan, options).text;
}

/**
 * Renders the full generated class, byte for byte what `generateAutoJava` returns, together with
 * the lines each step wrote, so the editor can show a step's code without guessing it from the text.
 */
export function generateAutoJavaWithMap(plan: Plan, options: JavaCodegenOptions): GeneratedJava {
  const exported = options.exported;
  const className = exported === undefined ? generatedClassName(plan.auto.name) : exportedClassName(plan.auto.name);
  const dialect = DIALECTS[options.commandLibrary];
  const ctx: Ctx = {
    lines: [],
    helpers: [],
    usedNames: new Set(),
    dialect,
    deferred: { used: false },
    turned: { used: false },
    measured: { used: false },
  };

  const topCalls = plan.steps.map((planStep) => {
    const called = stepCall(ctx, planStep);
    return `${INDENT}${INDENT}${INDENT}step(${javaString(planStep.id)}, ${called}())`;
  });

  const imports = dialect.imports.filter(
    (line) =>
      (ctx.deferred.used || !line.endsWith(".DeferredPath;")) &&
      (ctx.turned.used || !line.endsWith(".TurnInPlace;")) &&
      (ctx.measured.used || !line.endsWith(".PedroPaths;")),
  );
  const head: string[] = [
    ...(exported === undefined
      ? referenceHead(plan, options, className, imports)
      : exportedHead(plan, options, exported, className, withExportImports(imports, dialect))),
    `${INDENT}@Override`,
    `${INDENT}protected Command buildRoutine() {`,
    `${INDENT}${INDENT}return new ${dialect.sequenceClass}(`,
  ];
  const helpers = ctx.helpers.map((helper) => helper.text).join("\n\n");
  const lines: string[] = [
    ...head,
    topCalls.join(",\n"),
    `${INDENT}${INDENT});`,
    `${INDENT}}`,
    "",
    `${INDENT}private static ${dialect.poseType} pose(double xIn, double yIn, double headingRad) {`,
    `${INDENT}${INDENT}return ${dialect.newPose};`,
    `${INDENT}}`,
    "",
    helpers,
    "}",
  ];

  // Every entry of `lines` is one line except the joined top calls, right after `head`, and the
  // joined helpers, second to last, so a line number counts the entries and newlines before it.
  const lineOf = (entryIndex: number): number =>
    lines.slice(0, entryIndex).reduce((line, entry) => line + entry.split("\n").length, 1);
  const stepLines: JavaStepLines[] = [];
  const topStart = lineOf(head.length);
  plan.steps.forEach((planStep, index) => {
    stepLines.push({ stepId: planStep.id, startLine: topStart + index, endLine: topStart + index });
  });
  let helperLine = lineOf(lines.length - 2);
  for (const helper of ctx.helpers) {
    const count = helper.text.split("\n").length;
    stepLines.push({ stepId: helper.stepId, startLine: helperLine, endLine: helperLine + count - 1 });
    // One blank line between methods.
    helperLine += count + 1;
  }
  return { text: `${lines.join("\n")}\n`, stepLines };
}