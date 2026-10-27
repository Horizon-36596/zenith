/**
 * The wait step's Wait for choice in the inspector (issue #144). A wait waits for a number of
 * seconds or for a condition, never both, so switching from one to the other replaces it: one undo
 * step, and a status line that says what the wait waited for before and how to get it back.
 */
import { setWait } from "@horizon36596/zenith-core";
import type { WaitStep } from "@horizon36596/zenith-schema";
import { findEntry } from "../lib/stepOps";
import { getState, setStatus } from "../state/store";
import { tryEdit } from "./edits";
import { keyOr } from "./shortcuts";

/** How long a wait that switches to a time waits when the step has no timeout to start from. */
export const WAIT_TIME_START_S = 0.5;

/** The wait step with this id in the open auto, or null when there is none. */
function waitStep(stepId: string): WaitStep | null {
  const auto = getState().auto;
  const step = auto === null ? undefined : findEntry(auto, stepId)?.step;
  return step?.kind === "wait" ? step : null;
}

/**
 * Makes a wait that waits for a condition wait for a time instead: as long as its timeout, which
 * is the longest it could wait before, or half a second when it has none. The timeout stays.
 */
export function waitForTime(stepId: string): void {
  const before = getState().auto;
  const step = waitStep(stepId);
  if (step === null || step.until === undefined) return;
  const seconds = step.timeoutS ?? WAIT_TIME_START_S;
  tryEdit((auto) => setWait(auto, stepId, { seconds }));
  if (getState().auto === before) return;
  setStatus(
    "ok",
    `${stepId} now waits ${seconds.toFixed(2)} s instead of until ${step.until}. ${keyOr("undo", "Undo")} puts the condition back.`,
  );
}

/**
 * Makes a wait that waits for a time wait for `condition` instead, the first condition robot.json
 * declares. Without one there is nothing to wait for, and the status line says so.
 */
export function waitForCondition(stepId: string, condition: string | undefined): void {
  const before = getState().auto;
  const step = waitStep(stepId);
  if (step === null || step.until !== undefined) return;
  if (condition === undefined) {
    setStatus("error", "robot.json declares no conditions, so there is nothing to wait for. Add one there, or keep waiting a time.");
    return;
  }
  tryEdit((auto) => setWait(auto, stepId, { until: condition }));
  if (getState().auto === before) return;
  const was = step.seconds === undefined ? "" : ` instead of ${step.seconds.toFixed(2)} s`;
  setStatus("ok", `${stepId} now waits until ${condition}${was}. ${keyOr("undo", "Undo")} puts the time back.`);
}
