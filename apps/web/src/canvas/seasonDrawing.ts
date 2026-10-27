/**
 * The season extras the static layer draws the field with: alliance tape, gardens, alliance areas,
 * the hives' cells and the tiles' tab edge (`@horizon36596/zenith-season-biobuzz` `fieldDrawing`). Everything else comes
 * from the field file itself, so a field of a season this build does not know is still drawn, just
 * without the extras.
 */
import { fieldDrawing, seasonId as biobuzzSeasonId, type FieldDrawing } from "@horizon36596/zenith-season-biobuzz";
import type { Field } from "@horizon36596/zenith-schema";

export type { DrawingAlliance, DrawingArea, DrawingHive, DrawingRect, FieldDrawing, TileSeamProfile } from "@horizon36596/zenith-season-biobuzz";

/** The extras for the field's season, or null for a season without any. */
export function drawingFor(field: Field): FieldDrawing | null {
  return field.season === biobuzzSeasonId ? fieldDrawing : null;
}
