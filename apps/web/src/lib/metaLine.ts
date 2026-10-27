/**
 * The estimate in the Inspector's selection header (issues #239 and #431), such as `1.59 s`, with
 * what it leaves out in its hint. It replaces the Estimated and Strafe fraction rows, and it never
 * reads a dash followed by a unit: a step the plan cannot time says so in words, and one only its
 * Timeout bounds reads that bound.
 */
import type { StepEstimate } from "@horizon36596/zenith-core";
import { DESCRIPTIONS, descriptionHint, type DescriptionId } from "../help/descriptions";

/** A value the line leaves out, named in its hint by its description entry: `Strafe fraction 0.25`. */
export interface MetaDetail {
  value: string;
  describe: DescriptionId;
}

/** The line for one step's estimate, or for a step the plan has no row for. */
export function metaLineText(estimate: StepEstimate | undefined): string {
  if (estimate === undefined) return "no estimate";
  if (estimate.nominalS !== null) {
    // A what-if run time (the envelope's Actual, issue #481) says it is one; the window says "at most".
    const qualifier = estimate.fromActualDuration === true ? "what-if " : estimate.fromEnvelope === true ? "at most " : "";
    return `${qualifier}${estimate.nominalS.toFixed(2)} s`;
  }
  // A wait for a condition with a Timeout ends by then at the latest.
  if (estimate.highS !== null) return `≤ ${estimate.highS.toFixed(2)} s`;
  return "no estimate";
}

/**
 * The line's hint: what the line is, from its own entry, then each detail as its label, its value
 * and its description, such as `Strafe fraction 0.25: how much of this path the robot drives sideways.`
 */
export function metaLineHint(describe: DescriptionId, details: readonly MetaDetail[] = []): string {
  const parts = [descriptionHint(DESCRIPTIONS[describe])];
  for (const detail of details) {
    const entry = DESCRIPTIONS[detail.describe];
    const hint = descriptionHint(entry);
    parts.push(`${entry.label} ${detail.value}: ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`);
  }
  return parts.join(" ");
}
