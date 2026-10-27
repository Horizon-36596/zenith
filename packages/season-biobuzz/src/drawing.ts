/**
 * What the editor needs to draw the BIOBUZZ field that `field/biobuzz.field.json` does not carry:
 * which alliance owns each zone and hive, the tape the zones are marked with, the gardens, the
 * alliance areas outside the perimeter, the axle the hives turn on, and the interlocking tab edge
 * the floor's tiles meet along. The hives' cells, their
 * swing and their pieces are drawn from `hiveMotion.ts` and the ledger.
 *
 * Everything the field file already has (the perimeter, the loading zones, the hive envelopes, the
 * frame bars, the flowers, the pollen) is read from the file, so a team that corrects its own copy
 * sees the correction drawn. These are only the extras, in the field file's own frame (centre
 * origin, inches, +X to audience right, +Y away from the audience, RED at x < 0), each with its
 * source (CLAUDE.md rule 4). Like the field file, they use the manual's nominal 24 in tiles; where
 * FIRST's field CAD differs, the provenance says by how much.
 */

/** An axis-aligned rectangle in field inches. */
export interface DrawingRect {
  readonly minXIn: number;
  readonly maxXIn: number;
  readonly minYIn: number;
  readonly maxYIn: number;
}

export type DrawingAlliance = "RED" | "BLUE";

/** A taped area of floor that belongs to one alliance. */
export interface DrawingArea extends DrawingRect {
  readonly id: string;
  readonly alliance: DrawingAlliance;
  readonly provenance: string;
}

/** One hive, as the field file names it, and the alliance it scores for. The editor draws it moving. */
export interface DrawingHive {
  /** The hive's `elements` id, which carries its pivot, its up side and what it holds. */
  readonly element: string;
  /** The `obstacles` id whose box is the hive's plan envelope, drawn as the hive's body, not a box. */
  readonly envelope: string;
  readonly alliance: DrawingAlliance;
}

/**
 * The edge an FTC soft foam tile has along every seam it shares with another: interlocking dovetail
 * tabs. It is the same edge on all four sides of every tile and in every season, so it is drawn on
 * every seam inside the wall. The outline runs from one seam crossing to the next and is
 * point-symmetric about the edge's middle, so two tiles mate whichever way each is turned. Along the
 * edge, a tab's two sides cross the seam's centre line every half pitch, leaning back from square,
 * so each tab is wider at its end than at its root; where a side would cross at the edge's middle, a
 * 45 degree step across the seam takes its place, and a 45 degree half step joins each end to its
 * crossing (`tileSeamOutline` in the editor rebuilds the outline from these numbers). The numbers are
 * the CAD tile's, which is 23.502 in; the editor draws the field on the manual's nominal 24 in tiles,
 * so it scales the outline by 24 / `edgeIn`.
 */
export interface TileSeamProfile {
  /** The tile's edge along the seam's centre line, from one crossing to the next. */
  readonly edgeIn: number;
  /** How far apart two tabs that point the same way are, along the seam. */
  readonly pitchIn: number;
  /** Across the seam, from the bottom of a slot to the end of the tab in it. */
  readonly depthIn: number;
  /** A tab's width at its end, between the sharp corners its sides would make without their fillets. */
  readonly tabWidthIn: number;
  /** The radius every corner where a tab's side meets a tab's end or a slot's bottom is rounded to. */
  readonly filletRadiusIn: number;
  readonly provenance: string;
}

/** FIRST Tech Challenge Field Soft Tiles (am-2499), the tiles every FTC field is laid with. */
export const ftcTileSeam: TileSeamProfile = {
  edgeIn: 23.502,
  pitchIn: 2.3689,
  depthIn: 0.8104,
  tabWidthIn: 1.7018,
  filletRadiusIn: 0.1247,
  provenance:
    "SPEC (FIRST's BIOBUZZ field CAD, STEP v26-27.2, sha256 5e768b73…fe00: parts am-2499-Center, am-2499-Side and am-2499-Corner, FIRST Tech Challenge Field Soft Tiles, whose inner edges are one outline): on each 596.952 mm (23.502 in) edge, 18 tab sides lean 32.55 degrees from square and cross the seam's centre line every 30.085 mm, so the tabs repeat every 60.170 mm (2.3689 in), 8 whole ones each way; a tab is 20.585 mm (0.8104 in) deep, 43.226 mm (1.7018 in) wide at its end and 16.944 mm (0.6671 in) at its root between sharp corners, which are rounded to 3.167 mm (0.1247 in). A 45 degree step takes the middle side's place, and a 45 degree half step joins each end to its crossing. BIOBUZZ Competition Manual V1 §9.2 names the tiles (36 interlocking soft foam TILES, am-2499), and §9.4 Fig 9-4 shows where their tabs interlock, on every seam inside the wall. See TRANSCRIPTION.md, Tile seams.",
};

export interface FieldDrawing {
  /** Floor tape width, for every taped edge on the field. */
  readonly tapeWidthIn: number;
  readonly tapeProvenance: string;
  /** Zones (by `zones` id) marked with alliance tape. The side on the wall carries no tape. */
  readonly tapedZones: Readonly<Record<string, DrawingAlliance>>;
  /** The gardens: a band of two tapes along a wall, closed by the walls at the corner. */
  readonly gardens: readonly DrawingArea[];
  /** Where each alliance's drivers and human player stand, on the floor outside the perimeter. */
  readonly allianceAreas: readonly DrawingArea[];
  readonly hives: readonly DrawingHive[];
  /** The frame's crossbar both hives pivot by, high overhead, between the tops of its two A-frames. */
  readonly hiveAxle: { readonly fromXIn: number; readonly toXIn: number; readonly yIn: number; readonly provenance: string };
  /** The tiles' interlocking tab edge, drawn on every tile seam inside the wall (issue #428). */
  readonly tileSeam: TileSeamProfile;
}

export const fieldDrawing: FieldDrawing = {
  tapeWidthIn: 1,
  tapeProvenance:
    "SPEC (FIRST's 2026-27 Event Field Setup Guide V1.0 §8.1, which allows 1 in or 2 in gaffer tape): 1 in, the width every strip has in FIRST's BIOBUZZ field CAD (STEP v26-27.2).",
  tapedZones: { loadingZoneRed: "RED", loadingZoneBlue: "BLUE" },
  gardens: [
    {
      id: "gardenRed",
      alliance: "RED",
      minXIn: -72,
      maxXIn: -48,
      minYIn: -72,
      maxYIn: -70,
      provenance:
        "APPROX (BIOBUZZ Competition Manual V1 §9.3 and §10.5.3, Figs 9-2 and 9-3; FIRST's Event Field Setup Guide §8.4): two 1 in tapes along the audience wall from the red corner to the x = -48 tile seam, so a 2 in band. FIRST's BIOBUZZ field CAD (STEP v26-27.2) has the same two strips on its 23.528 in tiles, ending at x = -47.409.",
    },
    {
      id: "gardenBlue",
      alliance: "BLUE",
      minXIn: 48,
      maxXIn: 72,
      minYIn: 70,
      maxYIn: 72,
      provenance: "APPROX, inherited from gardenRed: its point mirror, along the rear wall from the blue corner (Fig 9-2).",
    },
  ],
  allianceAreas: [
    {
      id: "allianceAreaRed",
      alliance: "RED",
      minXIn: -126,
      maxXIn: -72,
      minYIn: -48,
      maxYIn: 48,
      provenance:
        "APPROX (BIOBUZZ Competition Manual V1 Fig 9-2; FIRST's Event Field Setup Guide §8.5): taped on the floor outside the x = -72 wall, two tiles either side of the centre line. FIRST's BIOBUZZ field CAD (STEP v26-27.2) puts its tape at y = ±48.41 and 54 in deep, from 0.98 in to 54.98 in outside the wall.",
    },
    {
      id: "allianceAreaBlue",
      alliance: "BLUE",
      minXIn: 72,
      maxXIn: 126,
      minYIn: -48,
      maxYIn: 48,
      provenance: "APPROX, inherited from allianceAreaRed: its point mirror, outside the x = +72 wall.",
    },
  ],
  hives: [
    { element: "hiveRed", envelope: "hiveRedPivotBar", alliance: "RED" },
    { element: "hiveBlue", envelope: "hiveBluePivotBar", alliance: "BLUE" },
  ],
  hiveAxle: {
    fromXIn: -12,
    toXIn: 12,
    yIn: 0,
    provenance:
      "SPEC (FIRST's BIOBUZZ field CAD, STEP v26-27.2, sha256 5e768b73…fe00: part am-5875 A-Frame Top Bar, a 1 in square bar on y = 0 at z 40.95 to 41.95 in, is 24.00 in long and centred on x = 0 to within 0.01 in, so it spans x = ±12). It joins the tops of the frame's two A-frames, just inboard of the pivots at x = ±12.75 (BIOBUZZ Competition Manual V1 §9.6.1, Figs 9-8 and 9-10). See TRANSCRIPTION.md, Hive frame.",
  },
  tileSeam: ftcTileSeam,
};
