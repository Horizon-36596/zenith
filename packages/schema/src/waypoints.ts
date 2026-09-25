import { z } from "zod";
import { provenanceSchema } from "./common.js";
import { formatVersionFor, schemaIdField } from "./ids.js";

/** One named pose the team measured, in the canonical alliance's frame. */
export const waypointSchema = z.object({
  xIn: z.number(),
  yIn: z.number(),
  headingRad: z.number(),
  provenance: provenanceSchema.optional(),
});

/**
 * `waypoints.json`: named poses shared across autos. Changing one changes every auto that
 * references it, which is the point (site/docs/file-format.md).
 */
export const waypointsSchema = z.object({
  $schema: schemaIdField("waypoints"),
  formatVersion: formatVersionFor("waypoints"),
  waypoints: z.record(z.string().min(1), waypointSchema),
});

export type Waypoint = z.infer<typeof waypointSchema>;
export type Waypoints = z.infer<typeof waypointsSchema>;
