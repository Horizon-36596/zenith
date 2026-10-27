import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import {
  canonicalize,
  CENTRE_LINE_KEEPOUT_ID,
  runOptimize as coreRunOptimize,
  setRoute,
  type BeforeAfter,
  type Finding,
  type MovedMarker,
  type OptimizedRoute,
  type OptimizeMode,
  type OptimizeOptions,
  type OptimizeResult,
} from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { loadAutoAndPlan, resolveAutoPath } from "../autoLoad.js";
import { tryCore } from "../coreGate.js";
import { formatFindingsTable, type FileFindings } from "../findings.js";
import { loadProject, ProjectError } from "../project.js";

/**
 * `zenith optimize` (issue #303): the command-line surface of Optimize path. It loads one auto, runs
 * the core search on one path step, prints what it found and, only with `--write`, saves the pick
 * through `setRoute` in canonical form.
 *
 * Exit codes are this verb's own, as the spec gives them: 0 for improved or no better, 2 for
 * infeasible, 1 for any error (a usage error, an auto that does not load, a step that is not a path).
 * The CLI has no clock: the search always runs its whole budget, a count of evaluations.
 *
 * A step that check() finds going through a structure, past the wall, into a keep-out or over the
 * centre line (issue #388) gets the fastest clear route even when it is slower, and the card's first sentence
 * says what the original goes through; with no clear route it is infeasible and exits 2.
 */

/** The values of `--mode`, and the optimizer's mode each one names. */
export const OPTIMIZE_CLI_MODES = ["both", "route", "heading"] as const;
export type OptimizeCliMode = (typeof OPTIMIZE_CLI_MODES)[number];

const MODE_OF: Record<OptimizeCliMode, OptimizeMode> = {
  both: "routeAndHeading",
  route: "routeOnly",
  heading: "headingOnly",
};

export interface OptimizeCommandOptions {
  cwd?: string;
  project?: string;
  /** The effective id of the path step, at any depth. */
  step: string;
  marginIn?: number;
  budget?: number;
  score?: "sim" | "estimate";
  mode?: OptimizeCliMode;
  /** False for `--no-split`: keep the route to one path. */
  split?: boolean;
  /** False for `--no-ranges`: keep the heading to one mode. */
  ranges?: boolean;
  maxPaths?: number;
  /** `--hold-start-in`: hold the start heading over the first this many inches; 0 or absent is off (issue #448). */
  holdStartIn?: number;
  /** `--hold-end-in`: hold the end heading over the last this many inches; 0 or absent is off (issue #448). */
  holdEndIn?: number;
  write?: boolean;
  json?: boolean;
}

/** The exit codes of spec 16 section 8.2. */
export const OPTIMIZE_EXIT = { ok: 0, error: 1, infeasible: 2 } as const;

const slash = (path: string): string => path.split("\\").join("/");
const pad = (text: string, width: number): string => (text.length >= width ? text : text + " ".repeat(width - text.length));
const seconds = (value: number): string => `${value.toFixed(2)} s`;
const inches = (value: number): string => `${String(Math.round(value * 1000) / 1000)} in`;
const point = (value: { xIn: number; yIn: number }): string => `(${value.xIn.toFixed(2)}, ${value.yIn.toFixed(2)})`;

function fail(options: OptimizeCommandOptions, message: string): number {
  if (options.json === true) process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
  else process.stderr.write(`${message}\n`);
  return OPTIMIZE_EXIT.error;
}

// ---------------------------------------------------------------------------------------------
// The diff of the step
// ---------------------------------------------------------------------------------------------

type DiffLine = { kind: " " | "-" | "+"; text: string };

/** A line diff by longest common subsequence, after the shared head and tail are cut off. */
function lineDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      (lengths[i] as number[])[j] = a[i] === b[j] ? ((lengths[i + 1] as number[])[j + 1] as number) + 1 : Math.max((lengths[i + 1] as number[])[j] as number, (lengths[i] as number[])[j + 1] as number);
    }
  }
  const out: DiffLine[] = before.slice(0, head).map((text): DiffLine => ({ kind: " ", text }));
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] as string });
      i += 1;
      j += 1;
    } else if (i < a.length && (j === b.length || ((lengths[i + 1] as number[])[j] as number) >= ((lengths[i] as number[])[j + 1] as number))) {
      // Removed lines come before the lines that replace them.
      out.push({ kind: "-", text: a[i] as string });
      i += 1;
    } else {
      out.push({ kind: "+", text: b[j] as string });
      j += 1;
    }
  }
  for (const text of before.slice(before.length - tail)) out.push({ kind: " ", text });
  return out;
}

/** The changed lines with two lines of context, gaps marked with "...". Exported for its tests. */
export function formatDiff(before: string, after: string): string[] {
  const lines = lineDiff(before.split("\n"), after.split("\n"));
  const near = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === " ") return;
    for (let k = Math.max(0, index - 2); k <= Math.min(lines.length - 1, index + 2); k += 1) near.add(k);
  });
  const out: string[] = [];
  let previous = -2;
  for (const index of [...near].sort((x, y) => x - y)) {
    if (index !== previous + 1) out.push("  ...");
    const line = lines[index] as DiffLine;
    out.push(`${line.kind} ${line.text}`);
    previous = index;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The text card
// ---------------------------------------------------------------------------------------------

const describeFinding = (finding: Finding): string => `${finding.code} (${finding.severity}) on ${JSON.stringify(finding.stepId)}: ${finding.message}`;

function timeRows(route: OptimizedRoute): string[] {
  const row = (label: string, times: BeforeAfter | null): string => {
    if (times === null) return `  ${pad(label, 12)}not used for this run`;
    const own = `${seconds(times.before.ownS)} -> ${seconds(times.after.ownS)}`;
    const window = `${seconds(times.before.windowEndS)} -> ${seconds(times.after.windowEndS)}`;
    return `  ${pad(label, 12)}${pad(own, 22)}${window}`;
  };
  return [`  ${pad("", 12)}${pad("the step", 22)}where its window ends`, row("instant sim", route.t1), row("estimate", route.t0)];
}

function markerLines(markers: readonly MovedMarker[]): string[] {
  if (markers.length === 0) return [];
  return [
    "",
    'Markers that move on the field (each keeps its "at" as written):',
    ...markers.map((marker) => `  ${String(marker.index + 1)}. ${marker.name}: ${point(marker.fromIn)} -> ${point(marker.toIn)}, ${inches(marker.movedIn)}`),
  ];
}

/**
 * How the card names what a route comes closest to: the field wall, the centre line (a keep-out
 * with no id of its own, which was printed as `""`, issue #434), or a keep-out or structure by id.
 */
export function thingWords(kind: "wall" | "keepOut" | "structure", id: string | null): string {
  if (kind === "wall" || id === null) return "the field wall";
  if (kind === "keepOut") return id === CENTRE_LINE_KEEPOUT_ID ? "the centre line" : `the keep-out ${JSON.stringify(id)}`;
  return `the structure ${JSON.stringify(id)}`;
}

function routeLines(route: OptimizedRoute): string[] {
  const lines = [...timeRows(route)];
  // Round an original that goes through something, the fastest clear route may be slower (issue #388).
  if (route.gainS !== null) lines.push(`  ${seconds(Math.abs(route.gainS))} ${route.gainS < 0 ? "slower" : "faster"} under the scorer.`);
  if (route.closest !== null) {
    lines.push(`  Closest it comes to ${thingWords(route.closest.kind, route.closest.id)}: ${inches(route.closest.clearanceIn)}.`);
  }
  if (route.note !== null) lines.push(`  ${route.note}`);
  return lines;
}

/** The dry run's card (and the card after a write): what the search found and what it would change. */
export function formatOptimizeCard(
  result: OptimizeResult,
  context: { autoPath: string; marginFromFlag: boolean; diff: string[]; written: boolean },
): string {
  const lines: string[] = [];
  lines.push(`Optimize path: ${result.stepId} in ${context.autoPath}`);
  const scored = result.scorer === "sim" ? "the instant sim" : "the estimate";
  lines.push(`Result: ${result.status}. Scored by ${scored}, ${String(result.evaluations)} of ${String(result.budget)} evaluations.`);
  lines.push(`Margin: ${inches(result.marginIn)} to structures (${context.marginFromFlag ? "set by --margin-in" : "the robot's clearance"}).`);
  lines.push("");
  for (const sentence of result.changes) lines.push(sentence);
  for (const note of result.notes) lines.push(note);

  const pick = result.pick;
  if (pick !== null) {
    // Round a blocked original the pick may be faster only in the instant sim, and says so (PR #395).
    lines.push("", pick.label === null ? "Before and after:" : `Before and after (${pick.label}):`, ...routeLines(pick));
    lines.push(...markerLines(result.movedMarkers));
    if (result.findingsRemoved.length > 0) lines.push("", "Findings it removes:", ...result.findingsRemoved.map((finding) => `  ${describeFinding(finding)}`));
    if (result.findingsAdded.length > 0) lines.push("", "Findings it adds:", ...result.findingsAdded.map((finding) => `  ${describeFinding(finding)}`));
  }
  if (result.alternatives.length > 0) {
    lines.push("", "Alternatives:");
    result.alternatives.forEach((alternative, index) => {
      lines.push(`  ${String(index + 1)}. ${alternative.label ?? "Another route that passes the final check"}`);
      lines.push(...routeLines(alternative).map((line) => `  ${line}`));
      for (const sentence of alternative.changes) lines.push(`       ${sentence}`);
    });
  }
  if (result.closest !== null) {
    const thing = thingWords(result.closest.kind, result.closest.id);
    lines.push("", `Closest attempt: the robot at ${point(result.closest.pose)} falls ${inches(result.closest.shortfallIn)} short of ${thing}.`);
  }
  if (pick !== null && context.diff.length > 0) {
    lines.push("", `Changes to step "${result.stepId}" (the lines --write would change in ${context.autoPath}):`, ...context.diff);
  }
  lines.push("");
  if (context.written) {
    lines.push(`Wrote ${context.autoPath} in canonical form.`);
  } else if (pick !== null) {
    lines.push("Nothing was written. Run again with --write to save this route.");
  } else {
    lines.push("Nothing was written.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------------------------

/**
 * `zenith optimize <auto> --step <id> [--margin-in <in>] [--budget N] [--score sim|estimate]
 * [--mode both|route|heading] [--no-split] [--no-ranges] [--max-paths N] [--hold-start-in <in>]
 * [--hold-end-in <in>] [--write] [--json]`.
 * A dry run unless `--write` is named; `--write` saves only an improved route.
 */
export function runOptimize(autoArg: string, options: OptimizeCommandOptions): number {
  const cwd = options.cwd ?? process.cwd();
  let project;
  try {
    project = loadProject(cwd, options.project, autoArg);
  } catch (error) {
    if (error instanceof ProjectError) return fail(options, error.message);
    throw error;
  }
  const path = resolveAutoPath(cwd, project, autoArg);
  const relPath = slash(relative(project.root, path));
  const loaded = loadAutoAndPlan(path, project);
  if (!loaded.ok) {
    const files: FileFindings[] = [{ path: relPath, findings: loaded.findings }];
    if (options.json === true) process.stdout.write(`${JSON.stringify({ project: slash(project.root), files, error: `${relPath} does not load.` }, null, 2)}\n`);
    else process.stdout.write(`${formatFindingsTable(files)}\n`);
    return OPTIMIZE_EXIT.error;
  }
  const { auto, robot, field, seasonWarnings } = loaded.loaded;

  const coreOptions: OptimizeOptions = {
    ...(options.marginIn === undefined ? {} : { marginIn: options.marginIn }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.score === undefined ? {} : { scorer: options.score }),
    ...(options.mode === undefined ? {} : { mode: MODE_OF[options.mode] }),
    ...(options.split === false ? { allowSplit: false } : {}),
    ...(options.ranges === false ? { allowRanges: false } : {}),
    ...(options.maxPaths === undefined ? {} : { maxPaths: options.maxPaths }),
    ...(options.holdStartIn === undefined || options.holdStartIn === 0 ? {} : { holdStartHeadingIn: options.holdStartIn }),
    ...(options.holdEndIn === undefined || options.holdEndIn === 0 ? {} : { holdEndHeadingIn: options.holdEndIn }),
  };

  let outcome;
  try {
    outcome = tryCore(() =>
      coreRunOptimize({ auto, robot, field, waypoints: project.waypoints, season: resolveSeason(field).rules, stepId: options.step }, coreOptions),
    );
  } catch (error) {
    return fail(options, error instanceof Error ? error.message : String(error));
  }
  if (!outcome.ok) return fail(options, outcome.message);
  const result = outcome.value;

  // Only an improved route is ever written, and only on `--write`. The route goes in through
  // `setRoute`, which refuses a moved end, and the file is saved in canonical form.
  let proposed: string | null = null;
  if (result.step !== null && result.step.heading !== undefined) {
    try {
      proposed = canonicalize("auto", setRoute(auto, options.step, result.step.segments, result.step.heading));
    } catch (error) {
      return fail(options, error instanceof Error ? error.message : String(error));
    }
  }
  let written = false;
  if (options.write === true && proposed !== null) {
    try {
      writeFileSync(path, proposed, "utf8");
    } catch (error) {
      // A failed save is an error (exit 1), never the infeasible code 2, and with --json it still
      // prints {error}.
      return fail(options, `Could not write ${relPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    written = true;
  }

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ project: slash(project.root), auto: relPath, written, ...result }, null, 2)}\n`);
  } else {
    for (const warning of seasonWarnings) process.stderr.write(`warning: ${relPath}: ${warning}\n`);
    const diff = proposed === null ? [] : formatDiff(canonicalize("auto", auto), proposed);
    process.stdout.write(`${formatOptimizeCard(result, { autoPath: relPath, marginFromFlag: options.marginIn !== undefined, diff, written })}\n`);
  }
  return result.status === "infeasible" ? OPTIMIZE_EXIT.infeasible : OPTIMIZE_EXIT.ok;
}
