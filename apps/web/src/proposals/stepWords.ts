/**
 * How the proposer's editor describes one of the partner's steps, in the share's words. Pure, so it
 * is tested in `stepWords.test.ts`.
 */
import type { ProjectionStep } from "@horizon36596/zenith-schema";

/**
 * What a step is, in the share's words: kind, commands and times. `name` reads a command token: its
 * real name and arguments when the share includes command names (`commandNamer`), else the token.
 */
export function stepWords(step: ProjectionStep, name: (token: string) => string = (token) => token): string {
  switch (step.kind) {
    case "path": {
      const parts = [`${String(step.segments.length)} ${step.segments.length === 1 ? "path" : "paths"}`];
      if (step.speedFraction !== undefined) parts.push(`speed ${String(step.speedFraction)}`);
      for (const marker of step.markers ?? []) parts.push(name(marker.token));
      if (step.endCondition !== undefined) parts.push(`ends on ${step.endCondition.token}`);
      return parts.join(" · ");
    }
    case "command": {
      const parts = [name(step.token), step.estimateS === null ? "time unknown" : `${step.estimateS.toFixed(1)} s`];
      if (step.stationary) parts.push("stationary");
      if (step.movesRobot) parts.push("moves the robot");
      return parts.join(" · ");
    }
    case "wait":
      return step.until !== undefined ? `until ${step.until.token}` : `${(step.seconds ?? 0).toFixed(1)} s`;
    case "sequence":
      return step.steps.length === 1 ? "1 step" : `${String(step.steps.length)} steps in order`;
    case "parallel":
      return `${step.mode}${step.deadline === undefined ? "" : `, ends with ${step.deadline}`}`;
    case "branch":
      return `if ${step.condition.token}`;
  }
}
