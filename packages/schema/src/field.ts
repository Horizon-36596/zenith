import { z } from "zod";
import { provenanceSchema } from "./common.js";
import { formatVersionFor, schemaIdField } from "./ids.js";

/** An axis-aligned box the robot may not drive through, with a z range. */
export const obstacleSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("box"),
  minXIn: z.number(),
  maxXIn: z.number(),
  minYIn: z.number(),
  maxYIn: z.number(),
  minZIn: z.number(),
  maxZIn: z.number(),
  solidToRobot: z.boolean().optional(),
  provenance: provenanceSchema.optional(),
});

/** An axis-aligned rectangle a rule talks about (a loading zone, a parking zone). */
export const zoneSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("rect"),
  minXIn: z.number(),
  maxXIn: z.number(),
  minYIn: z.number(),
  maxYIn: z.number(),
  rule: z.string().optional(),
  appliesInAuto: z.boolean().optional(),
  provenance: provenanceSchema.optional(),
});

/**
 * A game element or container. Seasons differ wildly here, so the known keys are optional and
 * unknown ones survive a round trip: the season plugin reads what it put there.
 */
export const elementSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    container: z.union([z.string(), z.null()]).optional(),
    xIn: z.number().optional(),
    yIn: z.number().optional(),
    radiusIn: z.number().optional(),
    holds: z.array(z.string()).optional(),
    provenance: provenanceSchema.optional(),
  })
  .passthrough();

/** Something the robot aims at. Same openness as elements. */
export const targetSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    provenance: provenanceSchema.optional(),
  })
  .passthrough();

/**
 * Where the field perimeter sits in the image, in image pixels (x right, y down from the image's
 * top-left corner). The canvas maps this box onto the field's `sizeIn` in the declared frame.
 */
export const imagePxBoundsSchema = z
  .object({
    left: z.number().nonnegative(),
    top: z.number().nonnegative(),
    right: z.number().positive(),
    bottom: z.number().positive(),
  })
  .refine((box) => box.right > box.left && box.bottom > box.top, {
    message: "pxBoundsIn needs right > left and bottom > top: it is the perimeter's box in the image",
  });

/** One named look of the same picture, such as a dark or a printable light background. */
export const fieldImageVariantSchema = z.object({
  name: z.string().min(1),
  src: z.string().min(1),
});

/**
 * An optional picture of the field drawn under the vector layer (format version 2;
 * site/docs/file-format.md has the exact mapping).
 *
 * - `src`: a path relative to the field file, or `app:<path>` for an asset the app ships (resolved
 *   against the app's public root, so `app:fields/biobuzz/biobuzz-dark.webp` is
 *   `apps/web/public/fields/biobuzz/biobuzz-dark.webp`).
 * - `pxBoundsIn`: the box in the stored image, in image pixels, that the field perimeter occupies,
 *   or `"fullBleed"` when the perimeter is the image's own edge.
 * - `rotationDeg`: how far the cropped image is turned **clockwise as seen on screen** before it is
 *   laid over the field in the field's default view; absent means 0.
 * - `variants`: other looks of the same picture (same geometry, same credit), by name, for a
 *   field-style setting; `src` is the one drawn when nothing else is chosen.
 *
 * The image is only a picture: no check reads it, and the vector geometry stays the truth.
 */
export const fieldImageSchema = z.object({
  src: z.string().min(1),
  credit: z.string().min(1),
  pxBoundsIn: z.union([z.literal("fullBleed"), imagePxBoundsSchema]),
  rotationDeg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  variants: z
    .array(fieldImageVariantSchema)
    .min(1)
    .refine((variants) => new Set(variants.map((variant) => variant.name)).size === variants.length, {
      message: "every image variant needs its own name",
    })
    .optional(),
  provenance: provenanceSchema.optional(),
});

/**
 * `*.field.json`: the season, as vector geometry in the declared frame
 * (site/docs/file-format.md). Key declaration order is the canonical file order.
 */
export const fieldSchema = z.object({
  $schema: schemaIdField("field"),
  formatVersion: formatVersionFor("field"),
  season: z.string().min(1),
  name: z.string().min(1),
  frame: z.object({
    origin: z.enum(["centre", "corner"]),
    xAxis: z.string().min(1),
    yAxis: z.string().min(1),
    headingZero: z.enum(["+x", "+y"]),
    headingPositive: z.enum(["ccw", "cw"]),
    units: z.enum(["in"]),
    canonicalAlliance: z.enum(["RED", "BLUE"]),
    mirror: z.enum(["pointSymmetry", "mirrorX", "mirrorY", "none"]),
    view: z
      .object({
        audienceAt: z.enum(["bottom", "top", "left", "right"]),
      })
      .optional(),
  }),
  sizeIn: z.object({
    xIn: z.number().positive(),
    yIn: z.number().positive(),
  }),
  image: fieldImageSchema.optional(),
  periods: z
    .object({
      autoS: z.number().positive(),
      teleopS: z.number().positive(),
    })
    .optional(),
  obstacles: z.array(obstacleSchema).optional(),
  zones: z.array(zoneSchema).optional(),
  elements: z.array(elementSchema).optional(),
  targets: z.array(targetSchema).optional(),
  startRules: z
    .object({
      touchingWall: z.boolean().optional(),
      ownHalf: z.boolean().optional(),
      notInZones: z.array(z.string()).optional(),
      notTouchingContainers: z.array(z.string()).optional(),
      holds: z.record(z.string(), z.number()).optional(),
    })
    .passthrough()
    .optional(),
  rules: z
    .object({
      plugin: z.string().min(1),
    })
    .passthrough()
    .optional(),
});

export type Obstacle = z.infer<typeof obstacleSchema>;
export type Zone = z.infer<typeof zoneSchema>;
export type FieldElement = z.infer<typeof elementSchema>;
export type FieldTarget = z.infer<typeof targetSchema>;
export type FieldImage = z.infer<typeof fieldImageSchema>;
export type FieldImageVariant = z.infer<typeof fieldImageVariantSchema>;
export type ImagePxBounds = z.infer<typeof imagePxBoundsSchema>;
export type Field = z.infer<typeof fieldSchema>;
