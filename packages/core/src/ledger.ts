import {
  transferCount,
  type CommandSpec,
  type Field,
  type Robot,
  type Step,
  type Waypoint,
} from "@horizon36596/zenith-schema";
import { markerT } from "./checks/intake.js";
import { estimate } from "./estimate.js";
import type { Pose } from "./geometry/vec.js";
import { conditionTestOf, describeLedgerTest, evaluateLedgerTest } from "./ledgerConditions.js";
import { plan as planResolved } from "./plan.js";
import { resolve } from "./resolve.js";
import {
  noSeasonRules,
  type LedgerLocation,
  type SeasonRules,
  type SeasonState,
  type TargetId,
} from "./season.js";
import type { LedgerRow, Plan, PlanStep } from "./types.js";

/**
 * The ledger of site/docs/seasons.md: what the robot holds, where
 * every element is and what the season's own state is, stepped through the auto once.
 *
 * Transitions come from three places, in this order of trust:
 *
 *   1. `field.json` elements at kickoff, through `SeasonRules.initialState`.
 *   2. Registry `ledger` hints on commands in `robot.json` (`launches: "count"`, `tip: "own"`).
 *   3. A step's `expect` annotations (`collectFrom`, `launchesInto`, `tip`), which are the author
 *      telling the planner something the files cannot work out, and so win where they disagree.
 *   4. Transfer steps (format version 4): the author saying pieces move between two locations
 *      that the robot does not act on, such as the partner scoring or the human player entering
 *      pieces through the loading zone. The ledger moves `actualCount`, which defaults to
 *      `expectedCount`.
 *
 * A branch follows the side its condition picks when `robot.json` says how the ledger reads that
 * condition (`conditions[].ledger`), and the `then` side otherwise, as the instant sim does. When
 * the ledger runs a branch's `else` side, the steps after the branch start where that side leaves
 * the robot, not where the plan's `then` side does: the ledger resolves the auto again with that
 * side taken, so a launch after it is judged from where the robot really is.
 *
 * A path step's markers run their commands in the order they sit along the path, at the pose the
 * plan has there. A member of a `deadline` or `race` group that the estimate says starts only once
 * the group has ended is cancelled before it starts, so it changes nothing and has no entry.
 *
 * The core knows nothing about the game: everything below turns a step into a call on the season
 * plugin and records what came back.
 */

/** One step's effect on the ledger, which is what the checks read. */
export interface LedgerEntry {
  stepId: string;
  /** The state as the step begins, which is what LEGAL_APPROACH and EMPTY_SHOT ask about. */
  before: SeasonState;
  after: SeasonState;
  /** What the robot holds once the step has run, when the plugin tracks it. */
  holds: Record<string, number>;
  /** The target the ledger says is current while the step runs. */
  target: TargetId | null;
  /** How many pieces this step launched, and at what. */
  launched: number;
  /**
   * Where the robot was when this step launched, when it did: the step's start pose as the ledger
   * walked it (after a branch's `else` side this can differ from the plan's), or the first launching
   * marker's place along a path. Absent for a step that launched nothing.
   */
  launchPose?: Pose;
  /** True when the launch came from a marker along a path rather than where the step started. */
  launchedFromMarker?: boolean;
  collected: { containerId: string; count: number } | null;
  tipped: "own" | "opponent" | null;
  /** What a transfer step did, or null for every other step. */
  transfer: LedgerTransfer | null;
  /** Which side a branch step took, or null for every other step. */
  branch: LedgerBranch | null;
  /** The row this step contributes to the panel, or null when it changed nothing. */
  row: LedgerRow | null;
}

/** A transfer step as the ledger ran it. */
export interface LedgerTransfer {
  from: string;
  to: string;
  expectedCount: number;
  /** What the ledger was told to move: `actualCount`, or `expectedCount` when that is absent. */
  actualCount: number;
  /** What it could move, which is fewer when the source held fewer. */
  moved: number;
  /** Why the transfer could not be made, when it could not (an unknown location, no plugin). */
  problem: string | null;
}

/** A branch step as the ledger ran it. */
export interface LedgerBranch {
  condition: string;
  /** True when the `then` side ran. */
  then: boolean;
  /** True when the ledger read the condition; false when it could not and took `then`. */
  known: boolean;
  /** Why the ledger could not read the condition, when it could not. */
  reason: string | null;
}

export interface LedgerRun {
  entries: LedgerEntry[];
  byStepId: Readonly<Record<string, LedgerEntry>>;
  rows: LedgerRow[];
  initialState: SeasonState;
  finalState: SeasonState;
}

const toNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * How many pieces a command launches: the registry hint names either a number or one of the
 * command's own parameters, and `expect.count` overrides both. Without a hint, a command launches
 * only when its `expect` says where (`launchesInto`), and then `expect.count` pieces: a count beside
 * `collectFrom` alone is how many the step collects, not a launch.
 */
function launchCount(
  spec: CommandSpec | undefined,
  args: Readonly<Record<string, string | number | boolean>> | undefined,
  expected: { count?: number | undefined; launchesInto?: string | undefined } | undefined,
): number | null {
  const hint = spec?.ledger?.["launches"];
  if (hint === undefined) {
    return expected?.launchesInto !== undefined && expected.count !== undefined ? expected.count : null;
  }
  if (expected?.count !== undefined) return expected.count;
  if (typeof hint === "number") return hint;
  const fromArgs = toNumber(args?.[hint]);
  if (fromArgs !== null) return fromArgs;
  const param = spec?.params?.[hint];
  if (param !== undefined && "default" in param) {
    const fallback = toNumber(param.default);
    if (fallback !== null) return fallback;
  }
  return toNumber(Number(hint));
}

const tipHint = (spec: CommandSpec | undefined): "own" | "opponent" | null => {
  const hint = spec?.ledger?.["tip"];
  return hint === "own" || hint === "opponent" ? hint : null;
};

/**
 * The most times the ledger resolves the auto again for the `else` sides it ran. Each pass can
 * only add or drop a branch whose condition reads differently from the poses the last pass gave,
 * so a few passes settle it; the cap keeps a pathological flip-flop from looping.
 */
const MAX_BRANCH_PASSES = 8;

/** Steps the auto once and returns every transition, for the panel, the checks and the PR body. */
export function runLedger(
  plan: Plan,
  field: Field,
  season: SeasonRules = noSeasonRules,
): LedgerRun {
  let run = walkLedger(plan, field, season);
  // A branch whose `else` side ran leaves the robot somewhere other than the plan's `then` side
  // does, so the steps after it are walked again from poses resolved with that side taken.
  let elseBranches = new Set<string>();
  for (let pass = 0; pass < MAX_BRANCH_PASSES; pass += 1) {
    const taken = new Set(
      run.entries.flatMap((entry) => (entry.branch?.known === true && !entry.branch.then ? [entry.stepId] : [])),
    );
    if (taken.size === elseBranches.size && [...taken].every((id) => elseBranches.has(id))) break;
    elseBranches = taken;
    run = walkLedger(replanWithElse(plan, elseBranches), field, season);
  }
  return run;
}

/**
 * The plan again, with the `else` side of each branch in `elseBranches` deciding where the branch
 * ends. The waypoints are the poses the plan already resolved each reference to, so nothing is
 * read again from a file.
 */
function replanWithElse(original: Plan, elseBranches: ReadonlySet<string>): Plan {
  const named: Record<string, Waypoint> = {};
  const record = (source: unknown, pose: Pose | undefined): void => {
    if (pose === undefined || typeof source !== "object" || source === null || !("ref" in source)) return;
    const ref = (source as { ref: unknown }).ref;
    if (typeof ref !== "string" || Object.hasOwn(named, ref)) return;
    named[ref] = { xIn: pose.xIn, yIn: pose.yIn, headingRad: pose.headingRad };
  };
  record(original.auto.start.pose, original.startPose);
  const visit = (steps: readonly PlanStep[]): void => {
    for (const step of steps) {
      if (step.step.kind === "path") {
        for (const [index, segment] of step.step.segments.entries()) {
          record(segment.from, step.segments?.[index]?.fromPose);
          record(segment.to, step.segments?.[index]?.toPose);
        }
      }
      if (step.children !== undefined) visit(step.children);
    }
  };
  visit(original.steps);
  const resolved = resolve(original.auto, { formatVersion: 1, waypoints: named }, original.robot, { elseBranches });
  return planResolved(resolved, original.robot, original.field);
}

/** True when a step, or any step inside it, is a `deadline` or `race` group, which can cancel members. */
const cancels = (steps: readonly PlanStep[]): boolean =>
  steps.some(
    (step) =>
      (step.step.kind === "parallel" && step.step.mode !== "all") ||
      (step.children !== undefined && cancels(step.children)),
  );

/** Where the plan has the robot at fraction `t` of a path step: the first sample at or past it. */
function poseAlong(step: PlanStep, t: number): Pose {
  const sample = step.samples.find((candidate) => candidate.t >= t - 1e-9) ?? step.samples[step.samples.length - 1];
  return sample?.pose ?? step.startPose;
}

/** One walk of the ledger over a plan's steps, which `runLedger` repeats for the `else` sides it ran. */
function walkLedger(plan: Plan, field: Field, season: SeasonRules): LedgerRun {
  const robot: Robot = plan.robot;
  const alliance = plan.auto.alliance;
  const specOf = (name: string): CommandSpec | undefined =>
    robot.commands.find((command) => command.name === name);

  const initialState = season.initialState(field);
  let state =
    season.start === undefined
      ? initialState
      : season.start(initialState, plan.auto.start.holds ?? {}, alliance);
  const withStart = state;

  // The times a `deadline` or `race` group cancels its members by, which only such a group needs.
  const timing = cancels(plan.steps) ? estimate(plan, robot) : null;
  const durationOf = (step: PlanStep): number | null => timing?.byStepId[step.id]?.nominalS ?? null;

  const entries: LedgerEntry[] = [];
  const byStepId: Record<string, LedgerEntry> = {};

  const readBranch = (condition: string): LedgerBranch => {
    const test = conditionTestOf(robot, condition);
    if (test === null) {
      return {
        condition,
        then: true,
        known: false,
        reason: `robot.json does not say how the ledger reads "${condition}", so the then side is taken.`,
      };
    }
    const value = evaluateLedgerTest(test, state, season, robot, alliance);
    if (value === null) {
      return {
        condition,
        then: true,
        known: false,
        reason: `The ledger cannot tell whether ${describeLedgerTest(test)}, so the then side is taken.`,
      };
    }
    return { condition, then: value, known: true, reason: null };
  };

  const apply = (step: PlanStep): LedgerEntry => {
    const before = state;
    const target = season.currentTarget(state, alliance);
    const expect = "expect" in step.step ? step.step.expect : undefined;

    let launched = 0;
    let collected: { containerId: string; count: number } | null = null;
    let tipped: "own" | "opponent" | null = null;
    let transfer: LedgerTransfer | null = null;
    let launchPose: Pose | undefined;
    let launchedFromMarker = false;
    const branch = step.step.kind === "branch" ? readBranch(step.step.condition) : null;

    if (step.step.kind === "transfer") {
      const authored = step.step;
      const actualCount = transferCount(authored);
      const result =
        season.onTransfer === undefined
          ? { state, moved: 0, problem: "No season plugin that tracks locations is loaded, so the transfer changes nothing." }
          : season.onTransfer(state, authored.from, authored.to, actualCount, alliance, step.startPose);
      state = result.state;
      transfer = {
        from: authored.from,
        to: authored.to,
        expectedCount: authored.expectedCount,
        actualCount,
        moved: result.moved,
        problem: result.problem ?? null,
      };
    } else if (step.step.kind === "command") {
      const call = step.step as Extract<Step, { kind: "command" }>;
      const spec = specOf(call.name);
      const count = launchCount(spec, call.args, expect);
      if (count !== null && count > 0) {
        launched = count;
        launchPose = step.startPose;
        state = season.onLaunch(state, expect?.launchesInto ?? target ?? "", count, step.startPose);
      }
      tipped = expect?.tip ?? tipHint(spec);
    } else {
      // A path's markers run their commands as the robot passes them, in the order they sit
      // along it, each launching at the target that is current by then.
      let markerTip: "own" | "opponent" | null = null;
      if (step.step.kind === "path") {
        const markers = (step.step.markers ?? [])
          .map((marker, index) => ({ marker, index, t: markerT(marker.at, step.lengthIn) }))
          .sort((a, b) => a.t - b.t || a.index - b.index);
        for (const { marker, t } of markers) {
          const spec = specOf(marker.command.name);
          const count = launchCount(spec, marker.command.args, undefined);
          if (count !== null && count > 0) {
            const pose = poseAlong(step, t);
            if (launchPose === undefined) {
              launchPose = pose;
              launchedFromMarker = true;
            }
            launched += count;
            state = season.onLaunch(state, season.currentTarget(state, alliance) ?? "", count, pose);
          }
          markerTip = tipHint(spec) ?? markerTip;
        }
      }
      if (expect?.launchesInto !== undefined && (expect.count ?? 0) > 0) {
        const count = expect.count ?? 0;
        if (launchPose === undefined) launchPose = step.startPose;
        launched += count;
        state = season.onLaunch(state, expect.launchesInto, count, step.startPose);
      }
      tipped = expect?.tip ?? markerTip;
    }

    if (expect?.collectFrom !== undefined) {
      const count = expect.count ?? 1;
      collected = { containerId: expect.collectFrom, count };
      state = season.onCollect(state, expect.collectFrom, count, alliance);
    }

    if (tipped !== null && season.onTip !== undefined) {
      state = season.onTip(state, tipped, alliance);
    }

    const holds = season.holds === undefined ? {} : season.holds(state);
    const detail = season.describe === undefined ? null : season.describe(before, state);
    const changed = before !== state;
    const row: LedgerRow | null = changed
      ? {
          stepId: step.id,
          label: describeStep(step, launched, collected, tipped, transfer),
          ...(detail === null ? {} : { detail }),
          holds,
        }
      : null;

    const entry: LedgerEntry = {
      stepId: step.id,
      before,
      after: state,
      holds,
      target,
      launched,
      ...(launchPose === undefined ? {} : { launchPose }),
      ...(launchedFromMarker ? { launchedFromMarker } : {}),
      collected,
      tipped,
      transfer,
      branch,
      row,
    };
    entries.push(entry);
    byStepId[step.id] = entry;
    return entry;
  };

  /** The earlier of two cut-off times, where null is "never". */
  const earlier = (a: number | null, b: number | null): number | null =>
    a === null ? b : b === null ? a : Math.min(a, b);

  /**
   * When a `deadline` or `race` group ends, in seconds from its start, by the estimate: its
   * deadline member's time, or the race's quickest known member. Null for an `all` group, or when
   * the estimate cannot say. `setters` are the members whose own end is the group's end: the
   * deadline, or the race members that take that quickest time. They run to their own end, so the
   * group's end never cuts them, not even a zero-second step at their very end.
   */
  const groupEnd = (step: PlanStep): { endS: number | null; setters: ReadonlySet<string> } => {
    const none = { endS: null, setters: new Set<string>() };
    const group = step.step;
    if (group.kind !== "parallel" || group.mode === "all") return none;
    const members = step.children ?? [];
    if (group.mode === "deadline") {
      const deadline = members.find((member) => member.id === group.deadline);
      return deadline === undefined ? none : { endS: durationOf(deadline), setters: new Set([deadline.id]) };
    }
    const known = members.map(durationOf).filter((value): value is number => value !== null);
    if (known.length === 0) return none;
    const endS = Math.min(...known);
    return { endS, setters: new Set(members.filter((member) => durationOf(member) === endS).map((member) => member.id)) };
  };

  /**
   * Walks steps that run one after another. `cutoffS` is how long after the first of them starts
   * an enclosing `deadline` or `race` group ends and cancels whatever is still running, or null
   * when nothing cancels them. A step the estimate says starts only once the group has ended never
   * runs, so it is skipped; one whose start the estimate cannot place runs, as it always did.
   */
  const walk = (steps: readonly PlanStep[], cutoffS: number | null): void => {
    let elapsedS: number | null = 0;
    for (const step of steps) {
      if (cutoffS !== null && elapsedS !== null && elapsedS > 0 && elapsedS >= cutoffS - 1e-9) return;
      const leftS = cutoffS === null ? null : elapsedS === null ? null : cutoffS - elapsedS;
      const entry = apply(step);
      if (step.children !== undefined) {
        if (step.step.kind === "branch") {
          // Only one side of a branch runs: the one the condition picks when the ledger can read
          // it, and the `then` side otherwise. `runLedger` resolves the poses again for an `else`.
          const thenCount = step.step.then.length;
          walk(entry.branch?.then === false ? step.children.slice(thenCount) : step.children.slice(0, thenCount), leftS);
        } else if (step.step.kind === "parallel") {
          // Every member starts with the group; each is cut off when the group ends, apart from
          // the members whose own end is that end.
          const { endS, setters } = groupEnd(step);
          for (const member of step.children) walk([member], setters.has(member.id) ? leftS : earlier(leftS, endS));
        } else {
          walk(step.children, leftS);
        }
      }
      const tookS = durationOf(step);
      elapsedS = elapsedS === null || tookS === null ? null : elapsedS + tookS;
    }
  };

  walk(plan.steps, null);

  return {
    entries,
    byStepId,
    rows: [...entries.flatMap((entry) => (entry.row === null ? [] : [entry.row])), ...season.summary(state)],
    initialState: withStart,
    finalState: state,
  };
}

/** What the step did, in the words the ledger panel prints in its first column. */
function describeStep(
  step: PlanStep,
  launched: number,
  collected: { containerId: string; count: number } | null,
  tipped: "own" | "opponent" | null,
  transfer: LedgerTransfer | null,
): string {
  const parts: string[] = [];
  if (transfer !== null) {
    const asked =
      transfer.actualCount === transfer.expectedCount
        ? String(transfer.actualCount)
        : `${String(transfer.actualCount)} (expected ${String(transfer.expectedCount)})`;
    parts.push(`moved ${asked} from ${transfer.from} to ${transfer.to}`);
  }
  if (launched > 0) parts.push(`launched ${String(launched)}`);
  if (collected !== null) {
    parts.push(`collected ${String(collected.count)} from ${collected.containerId}`);
  }
  if (tipped !== null) parts.push(`tipped the ${tipped} hive`);
  return parts.length === 0 ? step.id : `${step.id}: ${parts.join(", ")}`;
}

/** The ledger rows of `03` section 6, for the panel and the pull-request body. */
export const ledger = (plan: Plan, field: Field, season: SeasonRules = noSeasonRules): LedgerRow[] =>
  runLedger(plan, field, season).rows;

/**
 * The ledger state once every step `finished` says has run, in the ledger's own order: the state
 * after the last such step, or the state at the start when none has. The editor reads the counts
 * at the preview time this way; a step that has not finished yet has not changed them.
 */
export function ledgerStateAfter(run: LedgerRun, finished: (stepId: string) => boolean): SeasonState {
  let state = run.initialState;
  for (const entry of run.entries) {
    if (finished(entry.stepId)) state = entry.after;
  }
  return state;
}

/** Every location the season counts, at one ledger state, for the field's count badges. */
export const ledgerLocations = (
  state: SeasonState,
  season: SeasonRules,
  alliance: "RED" | "BLUE",
): LedgerLocation[] => season.locations?.(state, alliance) ?? [];
