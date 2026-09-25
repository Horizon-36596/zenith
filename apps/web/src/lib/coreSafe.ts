/**
 * `estimate`, `ledger`, `render` and `diff` in `@horizon36596/zenith-core` throw NotImplementedError until M1
 * fills them in (packages/core/src/unimplemented.ts). The editor is built against their final
 * signatures and degrades rather than crashing: an unavailable estimate hatches every bar and says
 * so, an unavailable ledger shows its empty state, an unavailable render leaves the canvas to draw
 * the field itself. Nothing here invents a number (CLAUDE.md rule 4).
 */
import {
  check,
  diff,
  estimate,
  hasErrors,
  ledger,
  noSeasonRules,
  plan,
  render,
  resolve,
  type AutoDiff,
  type Estimate,
  type Finding,
  type LedgerRow,
  type Plan,
  type RenderOptions,
  type ResolvedAuto,
  type SeasonRules,
} from "@horizon36596/zenith-core";
import type { Auto, Field, Robot, Waypoints } from "@horizon36596/zenith-schema";

export type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

const failed = (what: string, error: unknown): { ok: false; reason: string } => ({
  ok: false,
  reason:
    error instanceof Error && error.name === "NotImplementedError"
      ? `${what} is not available yet: @horizon36596/zenith-core builds it in M1.`
      : `${what} failed: ${error instanceof Error ? error.message : String(error)}`,
});

function attempt<T>(what: string, run: () => T): Attempt<T> {
  try {
    return { ok: true, value: run() };
  } catch (error) {
    return failed(what, error);
  }
}

export const safeResolve = (auto: Auto, waypoints?: Waypoints): Attempt<ResolvedAuto> =>
  attempt("Resolving the auto", () => resolve(auto, waypoints));

export const safePlan = (resolved: ResolvedAuto, robot: Robot, field: Field): Attempt<Plan> =>
  attempt("Planning the auto", () => plan(resolved, robot, field));

export const safeEstimate = (planned: Plan, robot: Robot): Attempt<Estimate> =>
  attempt("The estimate", () => estimate(planned, robot));

export const safeCheck = (
  planned: Plan,
  estimated: Estimate | null,
  robot: Robot,
  field: Field,
  season: SeasonRules = noSeasonRules,
): Attempt<Finding[]> =>
  attempt("Validation", () => check(planned, estimated, robot, field, season));

export const safeLedger = (
  planned: Plan,
  field: Field,
  season: SeasonRules = noSeasonRules,
): Attempt<LedgerRow[]> => attempt("The ledger", () => ledger(planned, field, season));

export const safeRender = (
  planned: Plan,
  estimated: Estimate | null,
  findings: readonly Finding[],
  rows: readonly LedgerRow[],
  options: RenderOptions = {},
): Attempt<string> =>
  attempt("The static field render", () => render(planned, estimated, findings, rows, options));

export const safeDiff = (a: Auto, b: Auto): Attempt<AutoDiff> =>
  attempt("The diff", () => diff(a, b));

export { hasErrors };
