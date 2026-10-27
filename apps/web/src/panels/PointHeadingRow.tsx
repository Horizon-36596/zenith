/**
 * The heading row of the selected path point in the inspector (issues #147, #241 and #409). A path
 * point's own `headingRad` turns nothing: the step's heading mode alone decides which way the robot
 * faces. The Heading section is the one place a heading is shown and edited, so only the primary
 * selected end draws this row, read only: the angle alone, `180.0°`, with the mode that decides it
 * in the value's tooltip and in the row's hint. A pencil at the row's end takes the person to the
 * Heading section's field for that angle, switching to Linear first where the path decides it
 * (Tangent, Reverse tangent and Facing point). The routine's start keeps its own heading field,
 * since its heading is the one the robot sets up at.
 */
import { flattenSteps, radToDeg, wrapAngle, type PlanStep } from "@horizon36596/zenith-core";
import type { Heading } from "@horizon36596/zenith-schema";
import { Pencil } from "lucide-react";
import { writeHeadingMode } from "../app/edits";
import { FieldRow } from "../components/fields";
import { forgetPendingFold, openFoldForNow, rangeFoldId } from "../components/foldMemory";
import { RowButton } from "../components/primitives";
import { Tooltip } from "../components/Tooltip";
import { DESCRIPTIONS } from "../help/descriptions";
import {
  headingForMode,
  headingModeInfo,
  pathPlaceOf,
  plannedHeadingAt,
  pointHeadingRule,
  type PathPlace,
  type PointHeadingRule,
} from "../lib/headingModes";
import { findEntry } from "../lib/stepOps";
import { useDerived, useSelector, type State } from "../state/store";
import styles from "./Inspector.module.css";

const selectAuto = (value: State): State["auto"] => value.auto;

/**
 * A heading as the Inspector draws it (issue #409): wrapped to (-180, 180], one decimal, and the
 * degree sign tight against the number, so -π and π both read `180.0°` and a value just past -180
 * that rounds to it does too. Never `-0.0°`.
 */
export function formatHeading(rad: number): string {
  let tenths = Math.round(radToDeg(wrapAngle(rad)) * 10);
  if (tenths <= -1800) tenths += 3600;
  if (tenths === 0) tenths = 0;
  return `${(tenths / 10).toFixed(1)}°`;
}

/** What decides the heading at this point, as the first sentence of the row's hint. */
export function headingSourceLine(rule: PointHeadingRule): string {
  switch (rule.kind) {
    case "none":
      return "This path has no heading mode yet. Choose one under Heading.";
    case "joint":
      return `Set by Heading: ${rule.label}, where two paths meet.`;
    case "path":
    case "value":
      return `Set by Heading: ${rule.label}.`;
  }
}

/** The row's hint: what decides the heading here, then what the modes do (rewrite row 12). */
export const headingRowHint = (rule: PointHeadingRule): string =>
  `${headingSourceLine(rule)} ${DESCRIPTIONS["inspector.pointHeading"].more}`;

/**
 * The Heading section's field that holds the angle deciding the heading at `place`, by its test id,
 * or null where no field does: a joint, a heading with no mode, or a piecewise range the path
 * decides. Under Tangent, Reverse tangent or Facing point it is Linear's field, which a switch to
 * Linear makes.
 */
export function headingFieldFor(heading: Heading | undefined, place: PathPlace): string | null {
  const rule = pointHeadingRule(heading ?? { mode: "tangent" }, place);
  if (rule.kind === "joint" || rule.kind === "none") return null;
  const end = place === "first" ? "from" : "to";
  if (rule.kind === "path") return rule.rangeIndex === null ? `inspector-heading-${end}` : null;
  const inner = rule.rangeIndex === null ? heading : heading?.mode === "piecewise" ? heading.ranges[rule.rangeIndex]?.heading : undefined;
  const prefix = rule.rangeIndex === null ? "inspector-heading" : `heading-range-${String(rule.rangeIndex)}`;
  if (inner?.mode === "constant") return `${prefix}-constant`;
  return `${prefix}-${end}`;
}

/**
 * Focuses a field of the Heading section once it is drawn, opening a folded section for now without
 * changing its remembered fold, and, for a field of a piecewise range, that range's rows too.
 */
export function focusHeadingField(testId: string): void {
  openFoldForNow("path.heading");
  const range = /^heading-range-(\d+)-/.exec(testId)?.[1];
  // A range's rows mount only after Heading opens, so the range takes its open when it mounts.
  const rangeFold = range === undefined ? null : rangeFoldId(Number(range));
  if (rangeFold !== null) openFoldForNow(rangeFold, { untilMounted: true });
  let tries = 0;
  const attempt = (): void => {
    const field = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (field !== null) {
      field.focus();
      if (field instanceof HTMLInputElement) field.select();
    } else {
      tries += 1;
      if (tries < 20) {
        requestAnimationFrame(attempt);
        return;
      }
    }
    // Drawn or given up on, the open must not open a range of some later path.
    if (rangeFold !== null) forgetPendingFold(rangeFold);
  };
  requestAnimationFrame(attempt);
}

/** The planned headings at a path's two ends, which a switch to Linear keeps. */
function plannedEnds(planned: PlanStep | undefined): { startRad: number; endRad: number } | null {
  const startRad = planned?.startPose.headingRad;
  const endRad = planned?.endPose?.headingRad;
  return startRad === undefined || endRad === undefined ? null : { startRad, endRad };
}

export function PointHeadingRow({
  stepId,
  segmentIndex,
  pointKind,
}: {
  stepId: string;
  segmentIndex: number;
  pointKind: "from" | "to";
}) {
  const auto = useSelector(selectAuto);
  const derived = useDerived();
  const step = auto === null ? undefined : findEntry(auto, stepId)?.step;
  if (step === undefined || step.kind !== "path") return null;

  const end = { segmentIndex, pointKind };
  const place = pathPlaceOf(step.segments.length, end);
  const rule = pointHeadingRule(step.heading, place);
  const planned = derived.plan === null ? undefined : flattenSteps(derived.plan.steps).find((candidate) => candidate.id === stepId);
  const plannedRad = planned === undefined ? null : plannedHeadingAt(planned, end);
  const id = `${pointKind}-${String(segmentIndex)}`;
  const mode = step.heading === undefined ? "No heading mode" : headingModeInfo(step.heading.mode).label;
  const field = headingFieldFor(step.heading, place);
  // Where the path decides the heading, the pencil switches to Linear first, keeping the headings.
  const derivedMode = rule.kind === "path" || rule.kind === "none";

  return (
    <FieldRow
      label="Heading"
      describe="inspector.pointHeading"
      hint={headingRowHint(rule)}
      testId={`inspector-${id}-heading-row`}
      // The pencil is the row's one action, at its right edge (issue #431).
      action={
        field === null ? undefined : (
          <RowButton
            icon={Pencil}
            label="Edit this heading"
            hint={
              derivedMode
                ? "Switches the path to Linear, which keeps its headings, and opens the angle under Heading."
                : `Opens ${rule.kind === "value" ? rule.label : "the angle"} under Heading.`
            }
            testId={`inspector-${id}-heading-edit`}
            onClick={() => {
              if (derivedMode) writeHeadingMode(stepId, headingForMode("linear", step.heading, plannedEnds(planned)));
              focusHeadingField(field);
            }}
          />
        )
      }
    >
      <Tooltip label={mode} hint={headingSourceLine(rule)}>
        <span className={styles.readout} data-testid={`inspector-${id}-heading`} tabIndex={0}>
          {plannedRad === null ? "not planned yet" : formatHeading(plannedRad)}
        </span>
      </Tooltip>
    </FieldRow>
  );
}
