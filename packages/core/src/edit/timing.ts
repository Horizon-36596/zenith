import type { Auto } from "@horizon36596/zenith-schema";
import { EditError } from "./errors.js";
import { finish } from "./finish.js";
import { updateStep } from "./tree.js";

/**
 * Sets or clears a step's `timeoutS`. Only `path`, `command` and `wait` steps carry one; a
 * `parallel` or `branch` step has no timeout of its own (site/docs/file-format.md, step kinds).
 *
 * Named to match the other edit primitives; it shadows the global
 * `setTimeout` only within this module, and this package never schedules a timer (CLAUDE.md
 * rule 1: no clock in `packages/core`).
 */
export function setTimeout(auto: Auto, stepId: string, timeoutS: number | undefined): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => {
    if (step.kind !== "path" && step.kind !== "command" && step.kind !== "wait") {
      throw new EditError(
        `Step ${JSON.stringify(stepId)} is a ${step.kind} step, which has no timeoutS.`,
      );
    }
    return { ...step, timeoutS };
  });
  if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return finish({ ...auto, steps: result.steps });
}
