/**
 * Why the instant sim's total can be well under the estimate (W2-18 of the 0.1.2 sweep): it ran
 * only one side of a branch, a group ended before some of its steps started, a wait's condition
 * already held as it started, or the run stopped at the end of its time. The estimate counts none
 * of these, so the timeline says which happened, in the total's tooltip and in a quiet note under
 * the scrubber, instead of leaving "8.62 s" beside an estimate of 17.69 s unexplained.
 *
 * When none of those happened and the two totals still differ by `PLAIN_DIFFERENCE_S` or more, the
 * note says why in one plain sentence (0.1.2 UX review): the instant sim drives the plan within the
 * robot's limits, so it is longer or shorter than the Ideal plan by that much.
 */
import type { SimTrace } from "@horizon36596/zenith-core";
import type { StepEntry } from "../lib/stepOps";
import { seconds as fmtSeconds } from "../lib/format";

const steps = (count: number): string => `${String(count)} ${count === 1 ? "step" : "steps"}`;

/** The smallest difference between the two totals the note explains on its own, in seconds (SET BY HAND: 0.1.2 UX review). */
export const PLAIN_DIFFERENCE_S = 0.05;

/**
 * The note, in full sentences, or null when the instant sim ran every step the way the estimate
 * counts it. `estimateS` is the estimate's seconds by step id: the estimate costs a branch its
 * longer side, so a side not run is mentioned only when it is the one the estimate counted.
 * `totals` is the instant sim's total and the Ideal plan's, for the plain difference.
 */
export function instantSimNote(
  trace: Pick<SimTrace, "steps" | "completed" | "tickS">,
  entries: readonly StepEntry[],
  estimateS: ReadonlyMap<string, number | null>,
  totals: { instantS: number | null; idealS: number | null } | null = null,
): string | null {
  const ran = new Map(trace.steps.map((step) => [step.id, step]));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const sentences: string[] = [];

  // Steps that never started, put down to the branch side not taken or to the group that ended first.
  const skippedByBranch = new Map<string, { side: "then" | "else"; count: number }>();
  const skippedByGroup = new Map<string, number>();
  for (const entry of entries) {
    if (ran.has(entry.id)) continue;
    let child: StepEntry = entry;
    let parent = entry.parentId === undefined ? undefined : byId.get(entry.parentId);
    // The nearest group that did run is the one that decided this step would not.
    while (parent !== undefined && !ran.has(parent.id)) {
      child = parent;
      parent = parent.parentId === undefined ? undefined : byId.get(parent.parentId);
    }
    if (parent === undefined) continue;
    if (parent.step.kind === "branch" && child.arm !== undefined) {
      const taken = child.arm === "then" ? "else" : "then";
      const seen = skippedByBranch.get(parent.id);
      skippedByBranch.set(parent.id, { side: taken, count: (seen?.count ?? 0) + 1 });
    } else {
      skippedByGroup.set(parent.id, (skippedByGroup.get(parent.id) ?? 0) + 1);
    }
  }
  const sideS = (branchId: string, arm: "then" | "else"): number =>
    entries
      .filter((entry) => entry.parentId === branchId && entry.arm === arm)
      .reduce((sum, entry) => sum + (estimateS.get(entry.id) ?? 0), 0);
  for (const [id, { side, count }] of skippedByBranch) {
    const skipped = side === "then" ? "else" : "then";
    if (sideS(id, skipped) <= sideS(id, side)) continue;
    sentences.push(`The instant sim took the ${side} side of ${id}, so ${steps(count)} did not run.`);
  }
  for (const [id, count] of skippedByGroup) {
    sentences.push(`${id} ended before ${steps(count)} in it started.`);
  }

  // Waits whose condition already held, where the estimate gave them time (it gives a wait on a
  // condition none, unless it has a time limit to go by).
  const atOnce = entries.filter((entry) => {
    const record = ran.get(entry.id);
    return (
      entry.step.kind === "wait" &&
      record !== undefined &&
      record.conditionFired &&
      record.endS - record.startS <= trace.tickS + 1e-9 &&
      (estimateS.get(entry.id) ?? 0) > trace.tickS
    );
  });
  if (atOnce.length === 1 && atOnce[0] !== undefined) sentences.push(`${atOnce[0].id}'s condition already held, so it ended at once.`);
  else if (atOnce.length > 1) sentences.push(`${String(atOnce.length)} waits ended at once, their conditions already holding.`);

  if (!trace.completed) {
    const endS = trace.steps.reduce((latest, step) => Math.max(latest, step.endS), 0);
    sentences.push(`The instant sim stopped at ${fmtSeconds(endS)} s, before the routine ended.`);
  }
  // Nothing above explains it: the instant sim drives within the robot's limits, which the plan does not.
  if (sentences.length === 0 && totals !== null && totals.instantS !== null && totals.idealS !== null) {
    const diffS = totals.instantS - totals.idealS;
    if (Math.abs(diffS) >= PLAIN_DIFFERENCE_S) {
      sentences.push(`The instant sim drives the plan within the robot's limits: ${fmtSeconds(Math.abs(diffS))} s ${diffS > 0 ? "longer" : "shorter"}.`);
    }
  }
  return sentences.length === 0 ? null : sentences.join(" ");
}
