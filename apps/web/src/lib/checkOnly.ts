/**
 * The checks and nothing else, for an auto that is not the one on screen (issue #191): resolve, plan,
 * estimate and check, with the robot and field that auto is checked against. The editor's own
 * `derive` also builds the ledger and the static render for the open auto; a waypoint edit asks
 * what it does to every other auto that follows the waypoint, and only the findings answer that.
 */
import type { Finding } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import type { Auto, Field, Robot, Waypoints } from "@horizon36596/zenith-schema";
import { safeCheck, safeEstimate, safePlan, safeResolve, type Attempt } from "./coreSafe";

/** The findings of `auto` against `robot`, `field` and `waypoints`, or why they could not be made. */
export function checkOnly(auto: Auto, robot: Robot, field: Field, waypoints: Waypoints | undefined): Attempt<Finding[]> {
  const resolved = safeResolve(auto, waypoints, robot);
  if (!resolved.ok) return resolved;
  const planned = safePlan(resolved.value, robot, field);
  if (!planned.ok) return planned;
  const estimated = safeEstimate(planned.value, robot);
  return safeCheck(planned.value, estimated.ok ? estimated.value : null, robot, field, resolveSeason(field).rules);
}

const errorsOf = (findings: readonly Finding[]): Finding[] => findings.filter((finding) => finding.severity === "error");

/**
 * How many errors `after` has that `before` did not. An error counts as the same one when it has the
 * same check and the same step, however far along the step or whatever numbers its message names,
 * since a moved waypoint changes those; the same error twice in one step counts twice.
 */
export function newErrors(before: readonly Finding[], after: readonly Finding[]): number {
  const had = new Map<string, number>();
  for (const finding of errorsOf(before)) {
    const key = `${finding.code}|${finding.stepId}`;
    had.set(key, (had.get(key) ?? 0) + 1);
  }
  let fresh = 0;
  for (const finding of errorsOf(after)) {
    const key = `${finding.code}|${finding.stepId}`;
    const left = had.get(key) ?? 0;
    if (left > 0) had.set(key, left - 1);
    else fresh += 1;
  }
  return fresh;
}

/** The number of errors among `findings`. */
export const errorCountOf = (findings: readonly Finding[]): number => errorsOf(findings).length;
