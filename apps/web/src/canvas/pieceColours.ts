/**
 * The colours game pieces are drawn in on the field, shared by everything that draws one (the hives,
 * the count labels), so a piece is the same colour wherever it appears.
 *
 * Pollen is gold, `--field-pollen` (`theme.fieldPollen`): yellow, as the pieces are, and warmer than
 * the lemon of the tape lines and rule zones, so a piece on a line still reads as a piece. Nectar is
 * its alliance's colour. A piece is outlined in the well colour, so it keeps its edge on a cell
 * filled in the same colour.
 */
import type { CanvasTheme } from "./theme.js";

/** Each alliance's nectar kind, as the field file stages it (`BiobuzzState.nectarKind`). */
export type NectarKinds = Readonly<Record<"RED" | "BLUE", string | null>>;

/**
 * The fill for a piece of `kind`. Mirrored, the routine is drawn as the other alliance's, so a
 * nectar takes the other alliance's colour, as its hive does.
 */
export function pieceInk(theme: CanvasTheme, kind: string, nectar: NectarKinds, mirrored = false): string {
  const alliance = kind === nectar.RED ? "RED" : kind === nectar.BLUE ? "BLUE" : null;
  if (alliance === null) return theme.fieldPollen;
  return (alliance === "RED") !== mirrored ? theme.allianceRed : theme.allianceBlue;
}

/** The outline round every piece: the well colour, so it reads on any fill under it. */
export const pieceEdge = (theme: CanvasTheme): string => theme.bgCanvas;
