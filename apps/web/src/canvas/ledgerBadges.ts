/**
 * The ledger's counts at the playback time, for the field: every counted place, with its count split
 * by piece. A step changes them once it has finished in the preview sim. `fieldCounts.ts` lays them
 * out and draws them as chips (issue #118). Pure.
 */
import {
  ledgerLocations,
  ledgerStateAfter,
  type LedgerLocation,
  type LedgerRun,
  type SeasonRules,
} from "@horizon36596/zenith-core";
import type { TraceOverlay } from "./types.js";

/** The ledger the shell hands the canvas: the run and the season it ran with. */
export interface CanvasLedger {
  run: LedgerRun;
  season: SeasonRules;
}

/** How long past a step's end, in seconds, still counts as the end, for float noise in the clock. */
const END_SLOP_S = 1e-6;

/**
 * Every counted location at `timeS`: the ledger state once every step the trace says has ended by
 * then has run. Without a trace nothing has run yet, which is the kickoff state plus the start's
 * holds. A location the ledger does not count (off the field) is left out.
 */
export function ledgerBadgesAt(
  ledger: CanvasLedger | null | undefined,
  trace: TraceOverlay | null,
  timeS: number | undefined,
  alliance: "RED" | "BLUE",
): LedgerLocation[] {
  if (ledger === null || ledger === undefined) return [];
  const ends = new Map<string, number>();
  for (const step of trace?.steps ?? []) ends.set(step.id, step.endS);
  const at = timeS ?? 0;
  const state = ledgerStateAfter(ledger.run, (stepId) => {
    const end = ends.get(stepId);
    return end !== undefined && end <= at + END_SLOP_S;
  });
  return ledgerLocations(state, ledger.season, alliance).filter((location) => location.count !== null);
}

/** `id=count` for every badge, which the canvas publishes on its element for tests and bug reports. */
export const badgeSummary = (badges: readonly LedgerLocation[]): string =>
  badges.map((badge) => `${badge.id}=${String(badge.count ?? "")}`).join(";");

/** The parts of `TextMetrics` that place a glyph's ink, all in CSS pixels from the text's origin. */
export type GlyphMetrics = Pick<
  TextMetrics,
  "width" | "actualBoundingBoxLeft" | "actualBoundingBoxRight" | "actualBoundingBoxAscent" | "actualBoundingBoxDescent"
>;

/**
 * Where to draw a string, with `textAlign = "left"` and `textBaseline = "alphabetic"`, so the box
 * around its ink is centred on `centre`. Centring the em box instead (`"center"` and `"middle"`)
 * leaves digits low and to one side in most fonts, because a digit has no descender and its ink is
 * not the middle of the em box. The result is not rounded, so a count stays centred on the chip
 * drawn around it at every zoom and device pixel ratio. `scale` converts the metrics to the drawn
 * size when they were measured at a larger one (`fieldCounts.ts` measures at ten times, because
 * Chromium rounds the ink box out to whole pixels). Metrics a browser does not report (a non-finite value) fall back to the
 * advance width for the sides and to the baseline for the top and bottom, which the painter then
 * corrects with `"middle"`.
 */
export function glyphCentredOrigin(
  metrics: GlyphMetrics,
  centre: { xPx: number; yPx: number },
  scale = 1,
): { xPx: number; yPx: number; inkMeasured: boolean } {
  const finite = (value: number): boolean => Number.isFinite(value);
  const sidesKnown = finite(metrics.actualBoundingBoxLeft) && finite(metrics.actualBoundingBoxRight);
  const left = (sidesKnown ? metrics.actualBoundingBoxLeft : 0) * scale;
  const right = (sidesKnown ? metrics.actualBoundingBoxRight : metrics.width) * scale;
  const inkMeasured = finite(metrics.actualBoundingBoxAscent) && finite(metrics.actualBoundingBoxDescent);
  const ascent = inkMeasured ? metrics.actualBoundingBoxAscent * scale : 0;
  const descent = inkMeasured ? metrics.actualBoundingBoxDescent * scale : 0;
  // The ink spans [x - left, x + right] across and [y - ascent, y + descent] down from the origin.
  return {
    xPx: centre.xPx - (right - left) / 2,
    yPx: centre.yPx + (ascent - descent) / 2,
    inkMeasured,
  };
}
