/**
 * The derived view of one document: resolve, plan, estimate, check, ledger and the static render,
 * memoised on the identity of the four files they read. Editing a step replaces the `Auto` object,
 * which is the cache key, so a drag recomputes exactly once per document
 * (site/docs/editor.md).
 */
import type { Estimate, Finding, LedgerRow, Plan, ResolvedAuto } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import type { Auto, Field, Robot, Waypoints } from "@horizon36596/zenith-schema";
import {
  safeCheck,
  safeEstimate,
  safeLedger,
  safePlan,
  safeRender,
  safeResolve,
} from "../lib/coreSafe";

export interface Derived {
  resolved: ResolvedAuto | null;
  plan: Plan | null;
  estimate: Estimate | null;
  /** Why there is no estimate, when there is none. Shown in place of the numbers. */
  estimateReason: string | null;
  findings: Finding[];
  findingsReason: string | null;
  ledger: LedgerRow[];
  ledgerReason: string | null;
  staticSvg: string | null;
  /** How long the whole routine takes, or null while the estimator is unavailable. */
  totalS: number | null;
  /**
   * What the season plugin named by `field.json` could not do, in full sentences: empty when the
   * plugin is one this build carries, and one line naming it when it is not.
   */
  seasonWarnings: readonly string[];
}

const EMPTY: Derived = {
  resolved: null,
  plan: null,
  estimate: null,
  estimateReason: null,
  findings: [],
  findingsReason: null,
  ledger: [],
  ledgerReason: null,
  staticSvg: null,
  totalS: null,
  seasonWarnings: [],
};

interface CacheEntry {
  robot: Robot;
  field: Field;
  waypoints: Waypoints | undefined;
  derived: Derived;
}

const cache = new WeakMap<Auto, CacheEntry>();

export function derive(
  auto: Auto | null,
  robot: Robot | null,
  field: Field | null,
  waypoints: Waypoints | undefined,
): Derived {
  if (auto === null || robot === null || field === null) return EMPTY;

  const hit = cache.get(auto);
  if (hit !== undefined && hit.robot === robot && hit.field === field && hit.waypoints === waypoints) {
    return hit.derived;
  }

  const season = resolveSeason(field);

  const resolvedAttempt = safeResolve(auto, waypoints);
  if (!resolvedAttempt.ok) {
    const derived: Derived = {
      ...EMPTY,
      findingsReason: resolvedAttempt.reason,
      seasonWarnings: season.warnings,
    };
    cache.set(auto, { robot, field, waypoints, derived });
    return derived;
  }
  const resolved = resolvedAttempt.value;

  const planAttempt = safePlan(resolved, robot, field);
  if (!planAttempt.ok) {
    const derived: Derived = {
      ...EMPTY,
      resolved,
      findingsReason: planAttempt.reason,
      seasonWarnings: season.warnings,
    };
    cache.set(auto, { robot, field, waypoints, derived });
    return derived;
  }
  const planned = planAttempt.value;

  const estimateAttempt = safeEstimate(planned, robot);
  const estimate = estimateAttempt.ok ? estimateAttempt.value : null;
  const estimateReason = estimateAttempt.ok ? null : estimateAttempt.reason;

  const checkAttempt = safeCheck(planned, estimate, robot, field, season.rules);
  const ledgerAttempt = safeLedger(planned, field, season.rules);
  const renderAttempt = safeRender(
    planned,
    estimate,
    checkAttempt.ok ? checkAttempt.value : [],
    ledgerAttempt.ok ? ledgerAttempt.value : [],
  );

  const findings: Finding[] = checkAttempt.ok ? checkAttempt.value : planned.findings;
  const ledger: LedgerRow[] = ledgerAttempt.ok ? ledgerAttempt.value : [];

  const derived: Derived = {
    resolved,
    plan: planned,
    estimate,
    estimateReason,
    findings,
    findingsReason: checkAttempt.ok ? null : checkAttempt.reason,
    ledger,
    ledgerReason: ledgerAttempt.ok ? null : ledgerAttempt.reason,
    staticSvg: renderAttempt.ok ? renderAttempt.value : null,
    totalS: estimate?.nominalS ?? null,
    seasonWarnings: season.warnings,
  };
  cache.set(auto, { robot, field, waypoints, derived });
  return derived;
}

/** Counts by severity, for the findings panel header and the toolbar badge. */
export function severityCounts(findings: readonly Finding[]): {
  error: number;
  warning: number;
  info: number;
} {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** The findings that belong to one step, in severity order. */
const RANK = { error: 0, warning: 1, info: 2 } as const;

export const sortFindings = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]);

export function findingsByStep(findings: readonly Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = map.get(finding.stepId);
    if (list === undefined) map.set(finding.stepId, [finding]);
    else list.push(finding);
  }
  return map;
}

/**
 * The per-step nominal duration by step id, including the children of parallel and branch steps,
 * or an empty map while the estimator is unavailable.
 */
export function estimateByStep(estimate: Estimate | null): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const [id, step] of Object.entries(estimate?.byStepId ?? {})) map.set(id, step.nominalS);
  return map;
}

export type { LedgerRow };
