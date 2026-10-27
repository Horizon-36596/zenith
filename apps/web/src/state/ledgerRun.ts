/**
 * The ledger run of one plan, memoised on the plan, with the season plugin it ran with. The
 * ledger panel, the field's count badges, the inspector and the preview sim all read this one run,
 * so the counts on the field, the rows in the panel and the side a branch takes in the preview can
 * never disagree.
 */
import {
  runLedger,
  type LedgerRun,
  type Plan,
  type SeasonRules,
  type SimOptions,
} from "@horizon36596/zenith-core";
import { seasonFor } from "@horizon36596/zenith-seasons";
import type { Field } from "@horizon36596/zenith-schema";

export interface LedgerView {
  run: LedgerRun | null;
  season: SeasonRules;
  /** Why there is no run, when the ledger failed. */
  reason: string | null;
}

const cache = new WeakMap<Plan, { field: Field; view: LedgerView }>();

/** The ledger for this plan against this field, computed once per plan. */
export function ledgerFor(plan: Plan, field: Field): LedgerView {
  const hit = cache.get(plan);
  if (hit !== undefined && hit.field === field) return hit.view;
  const season = seasonFor(field);
  let view: LedgerView;
  try {
    view = { run: runLedger(plan, field, season), season, reason: null };
  } catch (error) {
    view = { run: null, season, reason: `The ledger failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  cache.set(plan, { field, view });
  return view;
}

/**
 * The options the editor's preview sim runs with: the ledger and its season, so a branch or a wait
 * on a condition `robot.json` says the ledger can answer follows the ledger (a transfer whose actual
 * count is 0 makes the preview take the else side). Empty when the ledger failed, which is the sim's
 * old behaviour.
 */
export function previewSimOptions(plan: Plan, field: Field): SimOptions {
  const view = ledgerFor(plan, field);
  return view.run === null ? {} : { ledger: view.run, season: view.season };
}
