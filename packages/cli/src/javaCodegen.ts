import type { Plan, PlanStep, Pose } from "@horizon36596/zenith-core";
import type {
  BranchStep,
  CommandCall,
  CommandStep,
  Heading,
  ParallelStep,
  PathStep,
  Segment,
  WaitStep,
} from "@horizon36596/zenith-schema";
import { RUNTIME_PACKAGE, type CommandLibrary } from "./commandLibrary.js";

/**
 * `zenith codegen`: a readable Java class a student can read as the plan
 * (site/docs/robot-runtime.md, "Generated Java"). It is derived and never edited; the file
 * is the source of truth. It is an abstract subclass of the chosen runtime's `AutoFromFile`
 * (`deploy.commandLibrary`, which has no default) that overrides `startPose()` and `buildRoutine()`,
 * and every call here is against that runtime's real API (`PathMarkers`, `RobotTimeout`,
 * `WaitRobotTime`, `NamedCommands`, `DeferredPath`, and the `AutoContext` methods `step`, `alliance`,
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
 * but the start, a heading shared out by arc length) are the planned path's there, and the class
 * says so.
 *
 * Deterministic: every number in the plan is already resolved (waypoints included), so the same
 * auto and the same sha always produce byte-identical Java. No clock, no randomness.
 */

export interface CodegenOptions {
  /** Dotted Java package, e.g. `org.firstinspires.ftc.teamcode.opmode.Auto`. */
  packageName: string;
  /** Short hex digest of the source file's canonical bytes, printed in the header comment. */
  shaHex: string;
  /** The auto file's path as it should read in the header, e.g. `autos/first-auto.auto.json`. */
  sourcePath: string;
  /** `zenith.json` `deploy.commandLibrary`: which runtime the class is written against. */
  commandLibrary: CommandLibrary;
}

/** What differs between the SolversLib and Ivy forms of the generated class. */
interface Dialect {
  imports: string[];
  /** The pose type `startPose()` and the `pose(...)` helper return. */
  poseType: string;
  /** The body of the `pose(...)` helper. */
  newPose: string;
  /** A pose from `alliance(...)` as the Pedro pose `Paths` takes. */
  toPedro: (pose: string) => string;
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
    `import ${SOLVERSLIB_PACKAGE}.AutoFromFile;`,
    `import ${SOLVERSLIB_PACKAGE}.DeferredPath;`,
    `import ${SOLVERSLIB_PACKAGE}.NamedCommands;`,
    `import ${SOLVERSLIB_PACKAGE}.Parallel;`,
    `import ${SOLVERSLIB_PACKAGE}.PathMarkers;`,
    `import ${SOLVERSLIB_PACKAGE}.Poses;`,
    `import ${SOLVERSLIB_PACKAGE}.RobotTimeout;`,
    `import ${SOLVERSLIB_PACKAGE}.WaitRobotTime;`,
  ],
  poseType: "Pose2d",
  newPose: "new Pose2d(xIn, yIn, new Rotation2d(headingRad))",
  toPedro: (pose) => `Poses.toPedro(${pose})`,
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
    `import ${IVY_PACKAGE}.AutoFromFile;`,
    `import ${IVY_PACKAGE}.Branch;`,
    `import ${IVY_PACKAGE}.DeferredPath;`,
    `import ${IVY_PACKAGE}.NamedCommands;`,
    `import ${IVY_PACKAGE}.Parallel;`,
    `import ${IVY_PACKAGE}.PathMarkers;`,
    `import ${IVY_PACKAGE}.RobotTimeout;`,
    `import ${IVY_PACKAGE}.Sequence;`,
    `import ${IVY_PACKAGE}.WaitRobotTime;`,
  ],
  poseType: "Pose",
  newPose: "new Pose(xIn, yIn, headingRad)",
  toPedro: (pose) => pose,
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
  const from = dialect.toPedro(liveFrom ?? poseExpr(fromPose, fromComment(segment)));
  const to = dialect.toPedro(poseExpr(toPose, toComment(segment)));
  if (segment.kind === "line") return `Paths.line(${from}, ${to})`;
  const controls = segment.control.map((point) =>
    dialect.toPedro(poseExpr({ xIn: point.xIn, yIn: point.yIn, headingRad: point.headingRad ?? 0 })),
  );
  return `Paths.curve(${[from, ...controls, to].join(", ")})`;
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
 * The segment's own t is taken as its arc-length fraction here, which is exact for a line and a close
 * reading for a curve (the runtime maps through its chord table).
 */
function piecewiseExpr(
  dialect: Dialect,
  heading: Extract<Heading, { mode: "piecewise" }>,
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
    const localFrom = span <= 0 ? 0 : (from - startFraction) / span;
    const localTo = span <= 0 ? 1 : (to - startFraction) / span;
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
  heading: Heading | undefined,
  startFraction = 0,
  endFraction = 1,
): string {
  if (heading === undefined) return curve;
  switch (heading.mode) {
    case "piecewise":
      return `${curve}.heading(${piecewiseExpr(dialect, heading, startFraction, endFraction)})`;
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

interface Ctx {
  lines: string[];
  helpers: string[];
  usedNames: Set<string>;
  dialect: Dialect;
  /** Set once a step from `"current"` has been written, so the class imports `DeferredPath`. */
  deferred: { used: boolean };
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
  pushLines(ctx, indent, `return DeferredPath.of(${javaString(planStep.id)}, this, from -> ${buildName}(from)${markers});`);
}

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
 * Builds the `Command` for a path step's body, as the statements of a private helper method.
 * `liveFrom` is set for a step from `"current"`: the name of the parameter holding the live pose.
 */
function generatePathBody(ctx: Ctx, planStep: PlanStep, indent: string, liveFrom?: string): void {
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
    const withHeading = withHeadingExpr(ctx.dialect, curve, step.heading, startFraction, endFraction);
    const varName = `seg${String(index)}`;
    pushLines(ctx, indent, `Path ${varName} = ${withHeading};`);
    curveVars.push(varName);
  });
  const pathExpr = curveVars.length === 1 ? (curveVars[0] as string) : `Paths.path(${curveVars.join(", ")})`;
  pushLines(ctx, indent, `Path path = ${pathExpr};`);
  // No speedFraction in the file means the robot's own default, exactly as AutoBuilder reads it.
  const speed = step.speedFraction === undefined ? "defaultSpeedFraction()" : num(step.speedFraction);
  pushLines(ctx, indent, `Command drive = followPath(path, ${speed});`);
  if (step.endCondition !== undefined) {
    const until = ctx.dialect.waitUntil(`NamedCommands.condition(${javaString(step.endCondition.condition)})`);
    pushLines(ctx, indent, `drive = Parallel.race(drive, ${until});`);
  }
  const markers = step.markers ?? [];
  if (markers.length === 0) {
    pushLines(ctx, indent, "return drive;");
    return;
  }
  const totalLengthIn = planStep.lengthIn;
  const breaks = planStep.geometry?.breaks ?? [0, totalLengthIn];
  const segmentLengths = breaks.slice(1).map((end, index) => end - (breaks[index] ?? 0));
  pushLines(ctx, indent, `double[] segmentLengthsIn = { ${segmentLengths.map(num).join(", ")} };`);
  pushLines(ctx, indent, "java.util.List<PathMarkers.Marker> markers = new java.util.ArrayList<PathMarkers.Marker>();");
  for (const marker of markers) {
    const distanceIn =
      "t" in marker.at
        ? marker.at.t * totalLengthIn
        : "distanceIn" in marker.at
          ? marker.at.distanceIn
          : totalLengthIn - marker.at.distanceFromEndIn;
    pushLines(
      ctx,
      indent,
      `markers.add(new PathMarkers.Marker(${num(distanceIn)}, ${commandCallExpr(marker.command)}));`,
    );
  }
  pushLines(ctx, indent, "return PathMarkers.wrap(drive, segmentLengthsIn, markers, this);");
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

function generateParallelBody(ctx: Ctx, planStep: PlanStep, indent: string): void {
  const step = planStep.step as ParallelStep;
  const children = planStep.children ?? [];
  pushLines(ctx, indent, "java.util.List<Command> members = new java.util.ArrayList<Command>();");
  let deadlineVar: string | null = null;
  for (const child of children) {
    const name = stepCall(ctx, child);
    const varName = `m_${camelCase(child.id)}`;
    const memberVar = `member_${camelCase(child.id)}`;
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
        buildMethod = [
          `${INDENT}private Command ${buildName}(${ctx.dialect.poseType} from) {`,
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
  ctx.helpers.push(method.join("\n"));
  if (buildMethod !== undefined) ctx.helpers.push(buildMethod);
  return name;
}

/** Generates a step's method, wraps it in `RobotTimeout` when it has a `timeoutS`, and returns the
 * name of the method to call for its finished command (with or without the timeout wrapper). */
function stepCall(ctx: Ctx, planStep: PlanStep): string {
  const innerName = generateStepMethod(ctx, planStep);
  const timeoutS = (planStep.step as { timeoutS?: number }).timeoutS;
  if (timeoutS === undefined) return innerName;
  const wrapperName = uniqueName(ctx, `${innerName}WithTimeout`);
  ctx.helpers.push(
    [
      `${INDENT}private Command ${wrapperName}() {`,
      `${INDENT}${INDENT}return RobotTimeout.of(${innerName}(), ${num(timeoutS)}, this);`,
      `${INDENT}}`,
    ].join("\n"),
  );
  return wrapperName;
}

/** Renders the full generated class. Pure: every input is the plan's own numbers. */
export function generateAutoJava(plan: Plan, options: CodegenOptions): string {
  const className = `${pascalCase(plan.auto.name)}Generated`;
  const dialect = DIALECTS[options.commandLibrary];
  const ctx: Ctx = { lines: [], helpers: [], usedNames: new Set(), dialect, deferred: { used: false } };

  const topCalls = plan.steps.map((planStep) => {
    const called = stepCall(ctx, planStep);
    return `${INDENT}${INDENT}${INDENT}step(${javaString(planStep.id)}, ${called}())`;
  });

  const startPoseLine = `${INDENT}${INDENT}return ${poseExpr(plan.startPose)};`;

  const lines: string[] = [
    `/** GENERATED by zenith from ${options.sourcePath} (sha ${options.shaHex}). Do not edit; edit the file. */`,
    "",
    `package ${options.packageName};`,
    "",
    ...dialect.imports.filter((line) => ctx.deferred.used || !line.endsWith(".DeferredPath;")),
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
    startPoseLine,
    `${INDENT}}`,
    "",
    `${INDENT}@Override`,
    `${INDENT}protected Command buildRoutine() {`,
    `${INDENT}${INDENT}return new ${dialect.sequenceClass}(`,
    topCalls.join(",\n"),
    `${INDENT}${INDENT});`,
    `${INDENT}}`,
    "",
    `${INDENT}private static ${dialect.poseType} pose(double xIn, double yIn, double headingRad) {`,
    `${INDENT}${INDENT}return ${dialect.newPose};`,
    `${INDENT}}`,
    "",
    ctx.helpers.join("\n\n"),
    "}",
  ];
  return `${lines.join("\n")}\n`;
}
