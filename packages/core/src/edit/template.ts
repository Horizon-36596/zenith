import { FORMAT_VERSION, SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { finish } from "./finish.js";

export interface AutoTemplate {
  alliance: "RED" | "BLUE";
  /** The same shape as `Auto["start"]`: a pose (or a waypoint ref) and optionally what it holds. */
  start: Auto["start"];
  /** Overrides the project's `zenith.json` robot file, the way `auto.robot` does. */
  robotPath?: string;
  /** Overrides the project's `zenith.json` field file, the way `auto.field` does. */
  fieldPath?: string;
}

/**
 * Builds a new auto from scratch: `name`, the template's alliance and start, and one placeholder
 * leg so the file is valid immediately (the schema requires at least one step). The leg starts
 * from `"current"`, which resolves against `start` the same way the first step of any auto does
 * (`packages/core/src/resolve.ts`), so there is nothing to fill in before this validates.
 */
export function newAutoFromTemplate(name: string, template: AutoTemplate): Auto {
  return finish({
    $schema: SCHEMA_ID.auto,
    formatVersion: FORMAT_VERSION,
    name,
    title: name,
    robot: template.robotPath,
    field: template.fieldPath,
    alliance: template.alliance,
    start: template.start,
    steps: [
      {
        id: "leg1",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 24 } }],
        heading: { mode: "tangent" },
        notes: "Replace this leg with the real opening move.",
      },
    ],
  });
}
