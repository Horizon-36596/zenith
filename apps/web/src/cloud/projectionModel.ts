/**
 * The projection a share sends, built on this computer from the editor's plan and its instant-sim
 * trace (spec 13 section 8.2), and the arithmetic "See it as they will"
 * needs to show it. There is no React and no DOM in this file, so all of it is tested in node.
 *
 * The share dialog, the request it stores and the follow-latest hook all build the projection
 * through `buildProjection`, so what the preview shows is byte for byte what is sent.
 */
import {
  angleDelta,
  canonicalize,
  PROJECTION_COARSE_QUANTA,
  projectShare,
  runLedger,
  type Plan,
  type Trace,
} from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import type {
  Field,
  Projection,
  ProjectionNamedCommand,
  ProjectionPhaseLabel,
  ProjectionPose,
  ProjectionStep,
} from "@horizon36596/zenith-schema";
import type { Level, SharerChoice } from "./types";

/** What a projection is built from: the editor's plan and the instant sim's trace of that plan. */
export interface ProjectionSource {
  plan: Plan;
  trace: Pick<Trace, "poses" | "steps" | "simTimeS">;
}

/** The choices in the share dialog that change the projection. */
export interface ProjectionChoice {
  level: Level;
  /** The Coarsen checkbox: 2 in, 5 degrees and 0.25 s instead of 0.5 in, 1 degree and 1 ms. */
  coarsen: boolean;
  /**
   * The "Include command names" checkbox: the projection also names each command and its
   * arguments. Absent means off, the default, and the projection is then exactly what it was
   * before the option existed.
   */
  includeCommands?: boolean;
  /**
   * The auto's name, when the sharer ticked "Include the auto's name" (spec 13 section 8.2: "the
   * auto's title if the sharer keeps it"). Absent means off, the default: the projection then has
   * no title and the partner sees the auto under the sharing team's name.
   */
  title?: string;
}

export type BuiltProjection =
  | {
      ok: true;
      projection: Projection;
      /** The projection in canonical form: exactly the text that is sent. */
      canonical: string;
      /** The size of `canonical` in UTF-8, in bytes. */
      bytes: number;
    }
  | { ok: false; reason: string };

/**
 * Built projections, keyed on the trace object and then on the choice. The sim hands out a new
 * trace object only when it has run again, so a dialog that re-renders, or a second caller for the
 * same version, reuses the projection instead of building it again. The plan is kept beside it,
 * because a trace belongs to exactly one plan and a stale pairing must never be served.
 */
const built = new WeakMap<object, { plan: Plan; byChoice: Map<string, BuiltProjection> }>();

const choiceKey = (choice: ProjectionChoice): string =>
  `${choice.level}|${choice.coarsen ? "coarse" : "fine"}|${choice.includeCommands === true ? "names" : "tokens"}|${JSON.stringify(choice.title ?? null)}`;

/** How many times `buildProjection` has really built one, for the memoisation test. */
let buildCount = 0;
export const projectionBuildCount = (): number => buildCount;

/**
 * The projection of `source` at `choice`, with its canonical text and size, or the reason there is
 * none (for example a run over 300 s, which the projection schema refuses).
 *
 * The ledger is run with the season the field names, the same as the editor's own ledger, so a
 * launch claims the target the season says it scores into. A title is passed only when the choice
 * carries one: the auto's name is the sharer's own words, and core carries one only when handed it.
 */
export function buildProjection(source: ProjectionSource, choice: ProjectionChoice): BuiltProjection {
  let entry = built.get(source.trace);
  if (entry === undefined || entry.plan !== source.plan) {
    entry = { plan: source.plan, byChoice: new Map() };
    built.set(source.trace, entry);
  }
  const key = choiceKey(choice);
  const hit = entry.byChoice.get(key);
  if (hit !== undefined) return hit;

  buildCount += 1;
  let result: BuiltProjection;
  try {
    const { plan } = source;
    const ledger = runLedger(plan, plan.field, resolveSeason(plan.field).rules);
    const projection = projectShare(
      { plan, trace: source.trace, robot: plan.robot, field: plan.field, ledger },
      {
        level: choice.level,
        coarsen: choice.coarsen,
        ...(choice.includeCommands === true ? { includeCommands: true } : {}),
        ...(choice.title === undefined ? {} : { title: choice.title }),
      },
    );
    const canonical = canonicalize("projection", projection);
    result = { ok: true, projection, canonical, bytes: new TextEncoder().encode(canonical).length };
  } catch (error) {
    result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  entry.byChoice.set(key, result);
  return result;
}

/** "3.4 KB": a size in kilobytes (1024 bytes), to one decimal. */
export const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

/**
 * Whether a stored projection was coarsened, read from its own trajectory quantum: what the Sharing
 * page and the tests describe a projection by. A rebuild reads the sharer's choices instead.
 */
export function isCoarsened(canonical: string): boolean {
  try {
    const parsed = JSON.parse(canonical) as { trajectory?: { positionQuantumIn?: unknown } };
    return parsed.trajectory?.positionQuantumIn === PROJECTION_COARSE_QUANTA.positionIn;
  } catch {
    return false;
  }
}

/**
 * Whether a stored projection names its commands ("Include command names"), read from the
 * projection itself: it carries a `commands` list only when the sharer chose it. The Sharing page
 * marks a share by it; like `isCoarsened`, a rebuild never reads it.
 */
export function includesCommands(canonical: string): boolean {
  try {
    return Array.isArray((JSON.parse(canonical) as { commands?: unknown }).commands);
  } catch {
    return false;
  }
}

/**
 * The auto's name a stored projection carries ("Include the auto's name"), or null when the sharer
 * left it out, read from the projection itself.
 */
export function projectionTitle(canonical: string): string | null {
  try {
    const title = (JSON.parse(canonical) as { title?: unknown }).title;
    return typeof title === "string" && title.trim() !== "" ? title : null;
  } catch {
    return null;
  }
}

/**
 * The choice a stored projection shows it was built with, at `level`: its coarseness, whether it
 * names its commands and whether it keeps the auto's name, read from the projection itself. It
 * describes a projection; it never decides a rebuild, which reads the sharer's own choices instead
 * (`rebuildChoice`), since a projection can be changed by a team that opens it.
 */
export function storedChoice(canonical: string, level: Level): ProjectionChoice {
  const title = projectionTitle(canonical);
  return {
    level,
    coarsen: isCoarsened(canonical),
    ...(includesCommands(canonical) ? { includeCommands: true } : {}),
    ...(title === null ? {} : { title }),
  };
}

/**
 * The sharer's choices as the text the cloud seals for the sharing team: a JSON object with its
 * three keys in a fixed order, so the same choices are always the same text.
 */
export function encodeSharerChoice(choice: SharerChoice): string {
  return JSON.stringify({ coarsen: choice.coarsen, includeCommands: choice.includeCommands, title: choice.title });
}

/**
 * The sharer's choices read back from the text `encodeSharerChoice` wrote, or null when the text is
 * not exactly that shape. A title must be a non-empty string of at most 200 characters.
 */
export function readSharerChoice(text: string): SharerChoice | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "coarsen,includeCommands,title") return null;
  const { coarsen, includeCommands, title } = record;
  if (typeof coarsen !== "boolean" || typeof includeCommands !== "boolean") return null;
  if (title !== null && (typeof title !== "string" || title.trim() === "" || title.length > 200)) return null;
  return { coarsen, includeCommands, title };
}

/** The choices a share gets when the sharer's own were never kept or cannot be read: the most private. */
export const MOST_PRIVATE_CHOICE: SharerChoice = { coarsen: true, includeCommands: false, title: null };

/**
 * The choice a share's projection is rebuilt with, at the level the share has now: the options the
 * sharer chose, as the cloud keeps them sealed for the sharing team. Every rebuild of a share (a
 * change of level, a follow-latest publish, Update share) goes through this, never through the
 * projection the share carries, because a team the share is made to can open that projection, and a
 * projection it changed must not decide what the next one shows. A share with no choices kept is
 * rebuilt with the most private options. The name is the one the sharer kept; a rebuild from a
 * revision whose auto has a title of its own uses that one instead (`revisionProjection.ts`).
 */
export function rebuildChoice(share: { choice?: SharerChoice | undefined }, level: Level): ProjectionChoice {
  const choice = share.choice ?? MOST_PRIVATE_CHOICE;
  return {
    level,
    coarsen: choice.coarsen,
    ...(choice.includeCommands ? { includeCommands: true } : {}),
    ...(choice.title === null ? {} : { title: choice.title }),
  };
}

/** The level a stored projection was built at. */
export function levelOf(canonical: string): Level | null {
  try {
    const level = (JSON.parse(canonical) as { level?: unknown }).level;
    return level === "view" || level === "propose" ? level : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// Playback of a projection, as the other team's view plays it
// ------------------------------------------------------------------------------------------------

/** How long the projection runs, in seconds: its total time, or its last row if that is later. */
export function projectionEndS(projection: Projection): number {
  const rows = projection.trajectory.poses.length;
  return Math.max(projection.totalS, (rows - 1) / projection.trajectory.rateHz);
}

/**
 * The pose at `atS`, read off the 10 Hz trajectory: the two rows either side, blended linearly,
 * the heading the short way round. Before the start it is the first row, after the end the last.
 */
export function projectionPoseAt(projection: Projection, atS: number): ProjectionPose {
  const { poses, rateHz } = projection.trajectory;
  const last = poses.length - 1;
  const at = Math.min(Math.max(atS * rateHz, 0), last);
  const index = Math.floor(at);
  const from = poses[index] ?? poses[0];
  const to = poses[Math.min(index + 1, last)] ?? from;
  if (from === undefined || to === undefined) return projection.startPose;
  const u = at - index;
  return {
    xIn: from[0] + (to[0] - from[0]) * u,
    yIn: from[1] + (to[1] - from[1]) * u,
    headingRad: from[2] + angleDelta(from[2], to[2]) * u,
  };
}

/** The phase running at `atS`, or null between phases. */
export function phaseAt(projection: Projection, atS: number): ProjectionPhaseLabel | null {
  for (const phase of projection.phases) if (atS >= phase.startS && atS < phase.endS) return phase.label;
  return null;
}

/** The phase labels in the words the preview shows. */
export const PHASE_WORDS: Readonly<Record<ProjectionPhaseLabel, string>> = {
  drive: "Drive",
  score: "Score",
  collect: "Collect",
  wait: "Wait",
  park: "Park",
  other: "Other",
};

/**
 * The corners of the projection's one bounding box at a pose, in field inches, in order round the
 * box. The box is in the robot frame (length along the heading), with its centre offset from the
 * point the path follows.
 */
export function boxCornersAt(projection: Projection, pose: ProjectionPose): Array<{ xIn: number; yIn: number }> {
  const { lengthIn, widthIn, centreOffsetIn } = projection.boundingBox;
  const cos = Math.cos(pose.headingRad);
  const sin = Math.sin(pose.headingRad);
  const local: Array<[number, number]> = [
    [centreOffsetIn.xIn + lengthIn / 2, centreOffsetIn.yIn + widthIn / 2],
    [centreOffsetIn.xIn + lengthIn / 2, centreOffsetIn.yIn - widthIn / 2],
    [centreOffsetIn.xIn - lengthIn / 2, centreOffsetIn.yIn - widthIn / 2],
    [centreOffsetIn.xIn - lengthIn / 2, centreOffsetIn.yIn + widthIn / 2],
  ];
  return local.map(([x, y]) => ({ xIn: pose.xIn + x * cos - y * sin, yIn: pose.yIn + x * sin + y * cos }));
}

/**
 * Where a claimed element sits on the public field, for the marker the preview draws: the element,
 * container or target with that id, or the middle of the row of elements whose ids start with it
 * (how a ledger names a row, such as `gardenRed`). Null when the field gives it no position.
 */
export function claimPointIn(field: Field, elementId: string): { xIn: number; yIn: number } | null {
  const positioned = (item: Record<string, unknown>): { xIn: number; yIn: number } | null =>
    typeof item["xIn"] === "number" && typeof item["yIn"] === "number" ? { xIn: item["xIn"], yIn: item["yIn"] } : null;
  const exact = [...(field.elements ?? []), ...(field.targets ?? [])].find((item) => item.id === elementId);
  const exactPoint = exact === undefined ? null : positioned(exact as Record<string, unknown>);
  if (exactPoint !== null) return exactPoint;
  const members = (field.elements ?? [])
    .filter((element) => element.container === elementId || element.id.startsWith(elementId))
    .map((element) => positioned(element as Record<string, unknown>))
    .filter((point): point is { xIn: number; yIn: number } => point !== null);
  if (members.length > 0) {
    return {
      xIn: members.reduce((sum, point) => sum + point.xIn, 0) / members.length,
      yIn: members.reduce((sum, point) => sum + point.yIn, 0) / members.length,
    };
  }
  const zone = (field.zones ?? []).find((each) => each.id === elementId);
  return zone === undefined ? null : { xIn: (zone.minXIn + zone.maxXIn) / 2, yIn: (zone.minYIn + zone.maxYIn) / 2 };
}

// ------------------------------------------------------------------------------------------------
// The structure, as the propose level shows it
// ------------------------------------------------------------------------------------------------

/** One line of the structure list: an opaque step id, its kind and what the projection says of it. */
export interface StructureRow {
  /** Nesting depth, 0 at the top level. */
  depth: number;
  /** The opaque step id (`s3`), or the arm name ("then", "else") on an arm's own line. */
  id: string;
  kind: ProjectionStep["kind"] | "arm";
  words: string;
}

const secondsWords = (value: number): string => `${String(Number(value.toFixed(2)))} s`;

/**
 * A named command as the partner reads it: its name, then its arguments in the order the auto
 * gives them, such as `score (count 4)` or `intakeOn`.
 */
export function namedCommandWords(entry: Pick<ProjectionNamedCommand, "name" | "args">): string {
  const args = Object.entries(entry.args ?? {});
  if (args.length === 0) return entry.name;
  return `${entry.name} (${args.map(([key, value]) => `${key} ${String(value)}`).join(", ")})`;
}

/**
 * How a command token reads: its real name and arguments when the projection names its commands,
 * else the token itself. The one lookup every view of a received projection uses.
 */
export function commandNamer(projection: Pick<Projection, "commands">): (token: string) => string {
  const byToken = new Map((projection.commands ?? []).map((entry) => [entry.token, namedCommandWords(entry)] as const));
  return (token) => byToken.get(token) ?? token;
}

/** A named command that ran, in the partner's words, over the span its step ran, in seconds. */
export interface TimedCommand {
  words: string;
  startS: number;
  endS: number;
}

/**
 * The named commands that ran, in token order: what a partner's alliance lane lists under each
 * phase. Empty when the projection does not name its commands.
 */
export function timedCommands(projection: Pick<Projection, "commands">): TimedCommand[] {
  const timed: TimedCommand[] = [];
  for (const entry of projection.commands ?? []) {
    if (entry.startS === undefined || entry.endS === undefined) continue;
    timed.push({ words: namedCommandWords(entry), startS: entry.startS, endS: entry.endS });
  }
  return timed;
}

function stepWords(step: ProjectionStep, name: (token: string) => string): string {
  switch (step.kind) {
    case "path": {
      const parts = [`${String(step.segments.length)} ${step.segments.length === 1 ? "path" : "paths"}`];
      if (step.heading !== undefined) parts.push(`heading ${step.heading.mode}`);
      if (step.speedFraction !== undefined) parts.push(`speed ${String(step.speedFraction)}`);
      for (const marker of step.markers ?? []) {
        const at =
          "t" in marker.at
            ? `t ${String(marker.at.t)}`
            : "distanceIn" in marker.at
              ? `${String(marker.at.distanceIn)} in`
              : `${String(marker.at.distanceFromEndIn)} in from the end`;
        parts.push(`${name(marker.token)} at ${at}`);
      }
      if (step.endCondition !== undefined) parts.push(`ends on ${step.endCondition.token}`);
      if (step.timeoutS !== undefined) parts.push(`timeout ${secondsWords(step.timeoutS)}`);
      return parts.join(", ");
    }
    case "command": {
      const parts = [name(step.token), step.estimateS === null ? "time unknown" : `about ${secondsWords(step.estimateS)}`];
      if (step.stationary) parts.push("stationary");
      if (step.movesRobot) parts.push("moves the robot");
      if (step.timeoutS !== undefined) parts.push(`timeout ${secondsWords(step.timeoutS)}`);
      return parts.join(", ");
    }
    case "wait": {
      const parts: string[] = [];
      if (step.seconds !== undefined) parts.push(secondsWords(step.seconds));
      if (step.until !== undefined) parts.push(`until ${step.until.token}`);
      if (step.timeoutS !== undefined) parts.push(`timeout ${secondsWords(step.timeoutS)}`);
      return parts.join(", ");
    }
    case "sequence":
      return `${String(step.steps.length)} in order`;
    case "parallel":
      return step.deadline === undefined ? `${step.mode}, ${String(step.steps.length)} together` : `deadline ${step.deadline}, ${String(step.steps.length)} together`;
    case "branch":
      return `if ${step.condition.token}`;
  }
}

/**
 * The structure of a propose projection, one row per step, depth first; empty at the view level.
 * A command reads by its real name when the projection names its commands, else by its token.
 */
export function structureRows(projection: Projection): StructureRow[] {
  const rows: StructureRow[] = [];
  const name = commandNamer(projection);
  const walk = (steps: readonly ProjectionStep[], depth: number): void => {
    for (const step of steps) {
      rows.push({ depth, id: step.id, kind: step.kind, words: stepWords(step, name) });
      if (step.kind === "sequence" || step.kind === "parallel") walk(step.steps, depth + 1);
      if (step.kind === "branch") {
        rows.push({ depth: depth + 1, id: "then", kind: "arm", words: "" });
        walk(step.then, depth + 2);
        if (step.else !== undefined) {
          rows.push({ depth: depth + 1, id: "else", kind: "arm", words: "" });
          walk(step.else, depth + 2);
        }
      }
    }
  };
  walk(projection.structure?.steps ?? [], 0);
  return rows;
}
