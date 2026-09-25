import { z } from "zod";

/**
 * Provenance is a plain string, using the biobuzz vocabulary (MEASURED, SET BY HAND, SPEC, NEEDS
 * MEASUREMENT, CARRIED OVER, PLACEHOLDER, APPROX, SET FROM SIM, SET FROM EDITOR, CALIBRATED FROM
 * SIM, CALIBRATED FROM ROBOT). It is not an enum: the label is followed by the reason, and the
 * rule that matters (CLAUDE.md rule 4) is that a number carries one at all.
 */
export const provenanceSchema = z.string().min(1);

/** A number that came from somewhere, with the label saying where. */
export const valuedNumberSchema = z.object({
  value: z.number(),
  provenance: provenanceSchema.optional(),
});

/** A pose in the field frame. `headingRad` is optional where a heading mode supplies it. */
export const poseSchema = z.object({
  xIn: z.number(),
  yIn: z.number(),
  headingRad: z.number().optional(),
  provenance: provenanceSchema.optional(),
});

/** A reference to a named pose in `waypoints.json`. */
export const poseRefSchema = z.object({
  ref: z.string().min(1),
});

/**
 * Where a segment starts or ends: an inline pose, a waypoint reference, or the string `"current"`,
 * meaning the pose the previous step ended at.
 */
export const poseSourceSchema = z.union([z.literal("current"), poseRefSchema, poseSchema]);

export type Provenance = z.infer<typeof provenanceSchema>;
export type ValuedNumber = z.infer<typeof valuedNumberSchema>;
export type Pose = z.infer<typeof poseSchema>;
export type PoseRef = z.infer<typeof poseRefSchema>;
export type PoseSource = z.infer<typeof poseSourceSchema>;
