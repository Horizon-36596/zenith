/**
 * The partner's shared structure as an auto the editor can draw and edit
 * (spec 13 section 14, the proposer's side).
 *
 * A propose projection carries the partner's step structure with every pose resolved, every
 * command as an opaque token (`cmd3`) and every condition as a token (`cond1`). The canvas, the
 * planner and the instant sim all read an `Auto` and a `Robot`, so the proposer's editor builds a
 * **synthetic** pair from the projection: an auto whose step ids are the opaque ids (`s1` to `sN`)
 * and whose commands are named by their tokens, and a robot whose command registry holds one entry
 * per token with only the three things the share says about it (its estimated time, whether it is
 * stationary, whether it moves the robot). Nothing here ever reaches a file: the synthetic pair
 * exists only to draw the partner's routine and to time the proposed version of it.
 *
 * The synthetic robot borrows its drive limits from the proposer's own `robot.json`, because the
 * share never carries the partner's (section 8.2). That is an approximation, which is why the timed
 * preview in `timing.ts` rescales the drive time to the partner's own shared total.
 *
 * Pure: no DOM, no clock, no store.
 */
import {
  FORMAT_VERSIONS,
  SCHEMA_ID,
  type Auto,
  type CommandSpec,
  type ConditionSpec,
  type Envelope,
  type Heading,
  type PoseSource,
  type Projection,
  type ProjectionHeading,
  type ProjectionSegment,
  type ProjectionStep,
  type ProjectionStructure,
  type Robot,
  type Segment,
  type Step,
} from "@horizon36596/zenith-schema";

/** What the share says about one command token. */
export interface TokenFacts {
  token: string;
  /** Seconds, or null when the sharer's robot file does not know. */
  estimateS: number | null;
  stationary: boolean;
  movesRobot: boolean;
}

/** Every command token the structure holds, with its facts, and every condition token, in order. */
export function tokensOf(structure: ProjectionStructure): { commands: Map<string, TokenFacts>; conditions: string[] } {
  const commands = new Map<string, TokenFacts>();
  const conditions: string[] = [];
  const condition = (token: string): void => {
    if (!conditions.includes(token)) conditions.push(token);
  };
  const command = (facts: TokenFacts): void => {
    if (!commands.has(facts.token)) commands.set(facts.token, facts);
  };
  const visit = (steps: readonly ProjectionStep[]): void => {
    for (const step of steps) {
      switch (step.kind) {
        case "command":
          command({ token: step.token, estimateS: step.estimateS, stationary: step.stationary, movesRobot: step.movesRobot });
          break;
        case "path":
          // A marker's command is not a step, so the share carries no facts for it: it runs while
          // the robot drives and takes no time of its own.
          for (const marker of step.markers ?? []) command({ token: marker.token, estimateS: 0, stationary: false, movesRobot: false });
          if (step.endCondition !== undefined) condition(step.endCondition.token);
          break;
        case "wait":
          if (step.until !== undefined) condition(step.until.token);
          break;
        case "branch":
          condition(step.condition.token);
          visit(step.then);
          visit(step.else ?? []);
          break;
        case "sequence":
        case "parallel":
          visit(step.steps);
          break;
      }
    }
  };
  visit(structure.steps);
  return { commands, conditions };
}

/** The provenance every synthetic number carries: it is borrowed or derived, never measured. */
export const SYNTHETIC_PROVENANCE = "APPROX: the partner's shared projection, timed with your own robot's drive limits";

/**
 * A robot for the partner's structure: the proposer's own robot file for everything the share does
 * not carry (drive limits, follower), the partner's one shared bounding box as its footprint, no
 * mouths (the box already holds them), and one command per token.
 */
export function syntheticRobot(template: Robot, projection: Pick<Projection, "boundingBox" | "structure">): Robot {
  const box = projection.boundingBox;
  const tokens = tokensOf(projection.structure ?? { steps: [] });
  const commands: CommandSpec[] = [...tokens.commands.values()].map((facts) => ({
    name: facts.token,
    summary: "A command of the partner's, shared only as a token.",
    estimateS: facts.estimateS === null ? "unknown" : String(facts.estimateS),
    stationary: facts.stationary,
    movesRobot: facts.movesRobot,
  }));
  const conditions: ConditionSpec[] = tokens.conditions.map((token) => ({
    name: token,
    summary: "A condition of the partner's, shared only as a token.",
  }));
  const { mouths: _mouths, capacity: _capacity, shooter: _shooter, ...rest } = template;
  return {
    ...rest,
    name: "Partner (from the share)",
    footprint: {
      startIn: { lengthIn: box.lengthIn, widthIn: box.widthIn, provenance: SYNTHETIC_PROVENANCE },
      expandedIn: { lengthIn: box.lengthIn, widthIn: box.widthIn, provenance: SYNTHETIC_PROVENANCE },
      // The box's centre sits at `centreOffsetIn` from the point the path follows, which is the
      // centre of rotation, so the centre of rotation sits at minus that inside the box.
      centreOfRotationIn: { xIn: -box.centreOffsetIn.xIn, yIn: -box.centreOffsetIn.yIn, provenance: SYNTHETIC_PROVENANCE },
    },
    mouths: [],
    commands,
    conditions,
  };
}

/** An auto heading from a projection heading: the same shape, copied key by key. */
export function headingFromProjection(heading: ProjectionHeading): Heading {
  return JSON.parse(JSON.stringify(heading)) as Heading;
}

/**
 * A projection heading from an auto heading, keeping only the keys a projection allows, so the
 * strict proposal schema accepts it.
 */
export function headingToProjection(heading: Heading): ProjectionHeading {
  const range = (value: Heading): ProjectionHeading => {
    switch (value.mode) {
      case "tangent":
      case "tangentReversed":
        return { mode: value.mode };
      case "constant":
        return { mode: "constant", headingRad: value.headingRad };
      case "linear":
        return { mode: "linear", fromRad: value.fromRad, toRad: value.toRad };
      case "facePoint":
        return {
          mode: "facePoint",
          xIn: value.xIn,
          yIn: value.yIn,
          ...(value.offsetRad === undefined ? {} : { offsetRad: value.offsetRad }),
        };
      case "piecewise":
        return {
          mode: "piecewise",
          ranges: value.ranges.map((entry) => ({
            startT: entry.startT,
            endT: entry.endT,
            heading: range(entry.heading as Heading) as Exclude<ProjectionHeading, { mode: "piecewise" }>,
          })),
        };
    }
  };
  return range(heading);
}

const TOLERANCE = 1e-3;

/** How far apart two headings are, the short way round, so pi and -pi are the same heading. */
const headingGap = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

const samePose = (a: { xIn: number; yIn: number; headingRad?: number }, b: { xIn: number; yIn: number; headingRad?: number }): boolean =>
  Math.abs(a.xIn - b.xIn) < TOLERANCE &&
  Math.abs(a.yIn - b.yIn) < TOLERANCE &&
  headingGap(a.headingRad ?? 0, b.headingRad ?? 0) < TOLERANCE;

/** `s3:0`: segment 0 of step `s3`, the key `linkedStarts` uses. */
export const segmentKey = (stepId: string, segmentIndex: number): string => `${stepId}:${String(segmentIndex)}`;

/**
 * The segment starts of the share that begin exactly where the robot was: the first segment of a
 * path that starts where the step before it ended, and each later segment that starts where the
 * one before it ended. In the partner's own file these were almost certainly `"current"`, which a
 * projection writes out as a pose, so the editor draws them as `"current"` again: moving the end of
 * one step then moves the start of the next, just as it will on the owner's side.
 */
export function linkedStarts(structure: ProjectionStructure, startPose: { xIn: number; yIn: number; headingRad: number }): Set<string> {
  const linked = new Set<string>();
  type At = { xIn: number; yIn: number; headingRad: number } | null;
  const endOf = (steps: readonly ProjectionStep[], entry: At, together: boolean): At => {
    let current = entry;
    let groupEnd = entry;
    for (const step of steps) {
      if (together) current = entry;
      let end: At = current;
      switch (step.kind) {
        case "path": {
          step.segments.forEach((segment, index) => {
            const before: At = index === 0 ? current : (step.segments[index - 1]?.to ?? null);
            if (before !== null && samePose(segment.from, before)) linked.add(segmentKey(step.id, index));
          });
          end = step.segments[step.segments.length - 1]?.to ?? current;
          break;
        }
        case "command":
          end = step.movesRobot ? null : current;
          break;
        case "sequence":
          end = endOf(step.steps, current, false);
          break;
        case "parallel": {
          end = endOf(step.steps, current, true);
          break;
        }
        case "branch": {
          const then = endOf(step.then, current, false);
          endOf(step.else ?? [], current, false);
          end = then;
          break;
        }
        default:
          break;
      }
      if (together) {
        if (step.kind === "path" || end !== entry) groupEnd = end;
      } else current = end;
    }
    return together ? groupEnd : current;
  };
  endOf(structure.steps, startPose, false);
  return linked;
}

/** How a structure becomes an auto: which starts to write as `"current"`, and envelopes to add. */
export interface SyntheticOptions {
  /** Segment starts to write as `"current"` (`linkedStarts` of the share's own structure). */
  linked?: ReadonlySet<string>;
  /**
   * The share's own structure, so a linked start the proposal has moved is written as the pose it
   * was moved to rather than as `"current"`.
   */
  base?: ProjectionStructure;
  /** Envelopes the proposal sets, by step id; null removes one. */
  envelopes?: ReadonlyMap<string, Envelope | null>;
}

function baseSegments(base: ProjectionStructure | undefined): Map<string, ProjectionSegment[]> {
  const map = new Map<string, ProjectionSegment[]>();
  const visit = (steps: readonly ProjectionStep[]): void => {
    for (const step of steps) {
      if (step.kind === "path") map.set(step.id, step.segments);
      if (step.kind === "sequence" || step.kind === "parallel") visit(step.steps);
      if (step.kind === "branch") {
        visit(step.then);
        visit(step.else ?? []);
      }
    }
  };
  if (base !== undefined) visit(base.steps);
  return map;
}

/**
 * The synthetic auto for a structure: the same steps, in the same order, with the opaque ids as
 * step ids and the tokens as command and condition names. Every pose is literal, as the share has
 * it, except the linked starts, which are `"current"`.
 */
export function structureToAuto(
  structure: ProjectionStructure,
  projection: Pick<Projection, "alliance" | "startPose" | "title">,
  options: SyntheticOptions = {},
): Auto {
  const linked = options.linked ?? new Set<string>();
  const original = baseSegments(options.base);
  const envelopes = options.envelopes ?? new Map<string, Envelope | null>();

  const envelopeOf = (id: string): { envelope?: Envelope } => {
    const envelope = envelopes.get(id);
    return envelope === undefined || envelope === null ? {} : { envelope };
  };

  const segmentOf = (stepId: string, segment: ProjectionSegment, index: number): Segment => {
    const baseFrom = original.get(stepId)?.[index]?.from;
    const unmoved = baseFrom === undefined ? options.base === undefined : samePose(baseFrom, segment.from);
    const from: PoseSource = linked.has(segmentKey(stepId, index)) && unmoved ? "current" : { ...segment.from };
    if (segment.kind === "line") return { kind: "line", from, to: { ...segment.to } };
    return { kind: "bezier", from, control: segment.control.map((point) => ({ ...point })), to: { ...segment.to } };
  };

  const stepOf = (node: ProjectionStep): Step => {
    switch (node.kind) {
      case "path":
        return {
          id: node.id,
          kind: "path",
          ...(node.timeoutS === undefined ? {} : { timeoutS: node.timeoutS }),
          segments: node.segments.map((segment, index) => segmentOf(node.id, segment, index)),
          ...(node.heading === undefined ? {} : { heading: headingFromProjection(node.heading) }),
          ...(node.speedFraction === undefined ? {} : { speedFraction: node.speedFraction }),
          ...(node.markers === undefined
            ? {}
            : { markers: node.markers.map((marker) => ({ at: { ...marker.at }, command: { name: marker.token } })) }),
          ...(node.endCondition === undefined ? {} : { endCondition: { condition: node.endCondition.token } }),
          ...envelopeOf(node.id),
        } as Step;
      case "command":
        return {
          id: node.id,
          kind: "command",
          name: node.token,
          ...(node.timeoutS === undefined ? {} : { timeoutS: node.timeoutS }),
          ...envelopeOf(node.id),
        };
      case "wait":
        return {
          id: node.id,
          kind: "wait",
          ...(node.until === undefined ? { seconds: node.seconds ?? 0 } : { until: node.until.token }),
          ...(node.timeoutS === undefined ? {} : { timeoutS: node.timeoutS }),
          ...envelopeOf(node.id),
        } as Step;
      case "sequence":
        return { id: node.id, kind: "sequence", steps: node.steps.map(stepOf) } as Step;
      case "parallel":
        return {
          id: node.id,
          kind: "parallel",
          mode: node.mode,
          ...(node.deadline === undefined ? {} : { deadline: node.deadline }),
          steps: node.steps.map(stepOf),
        } as Step;
      case "branch":
        return {
          id: node.id,
          kind: "branch",
          condition: node.condition.token,
          then: node.then.map(stepOf),
          ...(node.else === undefined ? {} : { else: node.else.map(stepOf) }),
        } as Step;
    }
  };

  return {
    $schema: SCHEMA_ID.auto,
    formatVersion: FORMAT_VERSIONS.auto,
    name: "partner-proposal",
    ...(projection.title === undefined ? {} : { title: projection.title }),
    alliance: projection.alliance,
    start: { pose: { ...projection.startPose } },
    steps: structure.steps.map(stepOf),
  } as Auto;
}

/** Every step of a structure by id, depth first, with the list that holds it and its place there. */
export interface StructureSlot {
  node: ProjectionStep;
  list: readonly ProjectionStep[];
  index: number;
  parent: ProjectionStep | null;
  depth: number;
}

export function slotsOfStructure(structure: ProjectionStructure): Map<string, StructureSlot> {
  const slots = new Map<string, StructureSlot>();
  const visit = (list: readonly ProjectionStep[], parent: ProjectionStep | null, depth: number): void => {
    list.forEach((node, index) => {
      if (!slots.has(node.id)) slots.set(node.id, { node, list, index, parent, depth });
      if (node.kind === "sequence" || node.kind === "parallel") visit(node.steps, node, depth + 1);
      if (node.kind === "branch") {
        visit(node.then, node, depth + 1);
        visit(node.else ?? [], node, depth + 1);
      }
    });
  };
  visit(structure.steps, null, 0);
  return slots;
}
