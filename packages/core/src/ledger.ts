import type { CommandSpec, Field, Robot, Step } from "@horizon36596/zenith-schema";
import { noSeasonRules, type SeasonRules, type SeasonState, type TargetId } from "./season.js";
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
  collected: { containerId: string; count: number } | null;
  tipped: "own" | "opponent" | null;
  /** The row this step contributes to the panel, or null when it changed nothing. */
  row: LedgerRow | null;
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
 * command's own parameters, and `expect.count` overrides both.
 */
function launchCount(
  spec: CommandSpec | undefined,
  args: Readonly<Record<string, string | number | boolean>> | undefined,
  expected: number | undefined,
): number | null {
  if (expected !== undefined) return expected;
  const hint = spec?.ledger?.["launches"];
  if (hint === undefined) return null;
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

/** Steps the auto once and returns every transition, for the panel, the checks and the PR body. */
export function runLedger(
  plan: Plan,
  field: Field,
  season: SeasonRules = noSeasonRules,
): LedgerRun {
  const robot: Robot = plan.robot;
  const alliance = plan.auto.alliance;
  const specOf = (name: string): CommandSpec | undefined =>
    robot.commands.find((command) => command.name === name);

  const initialState = season.initialState(field);
  let state =
    season.start === undefined
      ? initialState
      : season.start(initialState, plan.auto.start.holds ?? {});
  const withStart = state;

  const entries: LedgerEntry[] = [];
  const byStepId: Record<string, LedgerEntry> = {};

  const apply = (step: PlanStep): void => {
    const before = state;
    const target = season.currentTarget(state, alliance);
    const expect = "expect" in step.step ? step.step.expect : undefined;

    let launched = 0;
    let collected: { containerId: string; count: number } | null = null;
    let tipped: "own" | "opponent" | null = null;

    if (step.step.kind === "command") {
      const call = step.step as Extract<Step, { kind: "command" }>;
      const spec = specOf(call.name);
      const count = launchCount(spec, call.args, expect?.count);
      if (count !== null && count > 0) {
        launched = count;
        state = season.onLaunch(state, expect?.launchesInto ?? target ?? "", count, step.startPose);
      }
      tipped = expect?.tip ?? tipHint(spec);
    } else {
      if (expect?.launchesInto !== undefined && (expect.count ?? 0) > 0) {
        launched = expect.count ?? 0;
        state = season.onLaunch(state, expect.launchesInto, launched, step.startPose);
      }
      tipped = expect?.tip ?? null;
    }

    if (expect?.collectFrom !== undefined) {
      const count = expect.count ?? 1;
      collected = { containerId: expect.collectFrom, count };
      state = season.onCollect(state, expect.collectFrom, count);
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
          label: describeStep(step, launched, collected, tipped),
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
      collected,
      tipped,
      row,
    };
    entries.push(entry);
    byStepId[step.id] = entry;
  };

  const walk = (steps: readonly PlanStep[]): void => {
    for (const step of steps) {
      apply(step);
      if (step.children === undefined) continue;
      if (step.step.kind === "branch") {
        // Only one side of a branch runs, and `resolve` already takes the `then` side as the one
        // that defines where the robot ends up, so the ledger follows the same side.
        walk(step.children.slice(0, step.step.then.length));
        continue;
      }
      walk(step.children);
    }
  };

  walk(plan.steps);

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
): string {
  const parts: string[] = [];
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
