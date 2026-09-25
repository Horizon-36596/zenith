import type { Auto, CommandCall } from "@horizon36596/zenith-schema";
import { EditError } from "./errors.js";
import { finish } from "./finish.js";
import { updateStep } from "./tree.js";

/** Replaces a `command` step's arguments outright. */
export function setCommandArgs(auto: Auto, stepId: string, args: CommandCall["args"]): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => {
    if (step.kind !== "command") {
      throw new EditError(`Step ${JSON.stringify(stepId)} is a ${step.kind} step, not a command.`);
    }
    return { ...step, args };
  });
  if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return finish({ ...auto, steps: result.steps });
}
