# BIOBUZZ field transcription

`biobuzz.field.json` transcribes the BIOBUZZ (FTC 2026-27) field into Zenith's `*.field.json`
format. This note says which public material it was transcribed from, how the frame was fixed,
where the sources disagree (the values are never averaged), and which numbers still need a
measurement. Every object in the file carries its own provenance string with the section or figure
it came from.

## Sources

1. **The BIOBUZZ Competition Manual V1** (FIRST, 173 pages): §9 (the arena: §9.2 field and tiles,
   §9.3 zones, §9.6 hive structure, §9.7 flowers, §9.8 scoring elements), §10.3 (staging),
   §10.5 (scoring) and §11 (game rules, G304 start position and G407 control limit). Every field
   drawing in §9 is a vector figure; a dimension read off one is labelled APPROX.
2. **FIRST's 2026-27 Event Field Setup Guide V1.0**: §8 (tape layout, the loading zone's 11 in
   depth) and §12 (hive calibration, the two tip loads it specifies).
3. **FIRST's BIOBUZZ field CAD** (STEP v26-27.2): used to cross-check the manual's figures. Where
   it disagrees, the disagreement is recorded below and in the object's provenance, not applied.
   Where the manual gives no number at all, the hive frame's legs, foot bars and crossbar, the
   numbers come from the CAD, extracted as "Hive frame" below says, and are labelled SPEC with the
   CAD part they come from (issue #229). So does the tiles' interlocking tab edge, which only the
   editor's drawing uses ("Tile seams" below, issue #428). The owner ruled on 2026-10-10 that the
   CAD may fill such gaps. The label is `SPEC (FIRST's BIOBUZZ field CAD, STEP v26-27.2, sha256 …:
   part …)`: it cites FIRST and the CAD zip's sha only, never DSim, and every frame provenance, the
   inherited mirror ones too, carries it.

No field coordinate was read off a picture of the field. The editor draws the field from this file
and from `src/drawing.ts`, which adds what the editor needs to draw it and the file does not carry
(the alliance tape, the gardens, the alliance areas and the plan shape of a hive's cells), each with
its own provenance.

## Frame

Centre origin, inches, **+X = audience right (BLUE side)**, **+Y = away from the audience**,
heading in radians CCW from +X. RED is x < 0 and BLUE is x > 0: the manual puts RED on tile
columns A to C (G304, Fig 9-5). The layout is **point-symmetric** about the centre, not mirrored
(Fig 9-2), so the alliance mirror is `(x, y, h) -> (-x, -y, h + π)`. At the start the red hive's up
cell is the south one (y < 0) and the blue hive's is the north one (Fig 10-2); they swap every tip.

## Hive frame

The hives hang from a frame of two triangular A-frames joined at their tops by a crossbar
(Competition Manual V1 §9.6.1, Figs 9-8 and 9-10). The manual gives only its base, 49.46 in wide
and 38.95 in deep, so its legs, foot bars and crossbar come from FIRST's BIOBUZZ field CAD
(issue #229). The CAD agrees with every number the manual does give.

**Source.** FIRST's BIOBUZZ field CAD, STEP v26-27.2, as downloaded: `field-cad-step.zip`, sha256
`5e768b731f1ec8dcd14debba53225c43718877923c351ce08504305f68f7fe00`. The STEP file inside it,
`field-cad-step.step`, has sha256 `05b35961c7df847741031f00fda73ddd068537f809e92a11b1cd59a94bcc8331`.
Provenance strings cite the zip's sha as `5e768b73…fe00`.

**Method.** The STEP was read with OpenCascade's XCAF reader (the `OCP` Python bindings,
cadquery-ocp 7.9.3), walking the assembly tree and composing each instance's location. For every
instance of parts am-5875, am-5876, am-5878 and am-5879, the located solid was meshed at a 0.05 mm
linear deflection, and each mesh node and vertex was taken into the field frame: the CAD is in
millimetres with Y up and its origin at the field centre on the tiles, so x = X / 25.4,
y = -Z / 25.4 and z = Y / 25.4. Every part here is symmetric about both x = 0 and y = 0, so the
signs of x and y change no value. For each part the extraction reports its bounding box; for a leg
it also reports the centroids of its two planar end faces (the two farthest apart) and the largest
distance of any point of the part from the segment between them. The fasteners below were read
from the same walk's bounding boxes.

**What it found.**

| Part | CAD | In the field file |
|---|---|---|
| am-5876 A-Frame Leg, four of them | a 1 in square tube, 45.75 in long, cut square at both ends, rising at 62.4 degrees. End-face centres: foot (±23.8105 east, ±23.7957 west, ±18.5614, 0.5315), top (±12.7426 east, ±12.7277 west, ±0.5060, 41.0848). Every point lies within 0.7071 in of the segment between them, the half diagonal of its section | `frameLegNorthEast`, `frameLegSouthEast`, `frameLegNorthWest` and `frameLegSouthWest`, struts from (±23.80, ±18.56, 0.53) to (±12.74, ±0.51, 41.08) with `radiusIn` 0.73. East and west differ by 0.015 in in x, so each value is the mean over the point mirror, rounded to 0.01 in; that moves an end by at most 0.014 in, and 0.7071 + 0.014 rounded up is 0.73 |
| am-5878 Sheet Metal Foot Bar, two of them | x 22.750 to 24.735, \|y\| up to 19.472, z 0 to 2.148 | `frameBarEast` and its mirror `frameBarWest`: x 22.54 to 24.76, \|y\| up to 19.48, z 0 to 2.15 |
| am-5879-A and am-5879-B Frame Foot, on the bar's ends | x 22.783 to 24.652, \|y\| 17.195 to 19.477, z 0.015 to 2.128 | inside the foot bar's box |
| Fasteners at the feet (#10-32 cap screws and nuts, 1/4-20 elevator bolts and wing nuts) | screw heads reach x 22.548 and 24.754, all below z 2.0 | inside the foot bar's box |
| am-5875 A-Frame Top Bar, the crossbar | a 1 in square bar on y = 0, z 40.95 to 41.95, 24.00 in long, centred on x = 0 to within 0.01 in | drawn as the dashed `hiveAxle` from x = -12 to +12 (`src/drawing.ts`); no obstacle, since no robot reaches it |

The foot bar's box is the bar's own box widened to hold the feet and their fasteners, rounded
outward to 0.01 in, so the box never lets a robot through where a screw head stands. Its outer face
at 24.735 in agrees with the manual's 49.46 / 2 = 24.73 in, and its ends at 19.472 in with
38.95 / 2 = 19.475 in. Before issue #229 the bars were APPROX boxes at x = ±24 to ±25 with a 2 in
NEEDS MEASUREMENT height, 1.25 in too far out.

**Nothing else is low.** In the CAD, no other part of the hive structure comes below 30.6 in: the
lowest are the Goal Rib at 30.65 in, the Basket Base Tube from 30.87 in and the ACM panel and
AprilTag plates from 34 in. So a robot within R105's 29 in limit can touch only the four legs, the
two foot bars and what is fixed to them. The legs are why a taller robot needs more room under a
hive: each leg's shadow on the floor below a robot's top grows toward the hive's pivot with the
robot's height, and core's `STRUCTURE` check tests that shadow.

## Tile seams

The floor is 36 interlocking soft foam TILES, FIRST Tech Challenge Field Soft Tiles (am-2499)
(Competition Manual V1 §9.2), and §9.4 Fig 9-4 shows where their tabs interlock: on the five seams
inside the wall each way, at the 24 in tile lines. The figure is a picture too coarse to show a
tab, so the shape of the edge comes from the CAD (issue #428). It is drawing data only, in
`src/drawing.ts` (`ftcTileSeam`), not in the field file.

**Source.** The same CAD file as "Hive frame", cited the same way.

**Method.** No CAD kernel was needed: the tile edge is all lines and circles, so the STEP file was
read as text. Every entity of its DATA section was parsed, and each product named `am-2499-Center`,
`am-2499-Side` and `am-2499-Corner` was followed through its product definition, its shape
definition representation and the shape representation relationship to its
`ADVANCED_BREP_SHAPE_REPRESENTATION` and its one `MANIFOLD_SOLID_BREP`. The tile's top face is the
planar face at Y = 7.918 mm with its normal up (+Y); its outer loop's edges were listed in order,
each a line or a circle with its end vertices, in millimetres (the file's unit is the metre). The
36 instances were placed from their `NEXT_ASSEMBLY_USAGE_OCCURRENCE`s' item-defined
transformations: every one is upright and turned only about the vertical, so no tile is flipped,
and the loop was taken into the field frame as "Hive frame" says (x = X, y = -Z, after each
instance's placement). Each edge between two seam crossings was then written as distance along the
seam and offset across it to the left of the way it runs (south to north, west to east), and each
pair of straight edges in a row was extended to meet, which gives the sharp corners a circle
between them rounds.

**What it found.**

| | CAD | In `ftcTileSeam` |
|---|---|---|
| Tile edge, crossing to crossing | 596.952 mm; the 36 tiles sit on 596.952 mm centres | `edgeIn` 23.502 |
| Tab pitch | the tabs' sides cross the seam's centre line every 30.085 mm, so two tabs pointing the same way are 60.170 mm apart | `pitchIn` 2.3689 |
| Tab depth | 20.585 mm, the tab ends and slot bottoms 10.292 mm either side of the centre line | `depthIn` 0.8104 |
| Tab width | 43.226 mm at its end and 16.944 mm at its root, between sharp corners: a dovetail, its sides leaning 32.55 degrees from square | `tabWidthIn` 1.7018 (the root is the pitch less it) |
| Fillets | every corner where a side meets a tab's end or a slot's bottom is rounded to 3.167 mm | `filletRadiusIn` 0.1247 |
| Tabs per edge | 18 sides, so 8 whole tabs each way, and a part-tab at the middle and at each end | rebuilt by `tileSeamOutline` |
| The middle and the ends | a 45 degree step 20.585 mm along the seam takes the middle side's place, and a 45 degree half step joins each end to its crossing | rebuilt by `tileSeamOutline` |

The edge is point-symmetric about its middle and the same on all four sides of a tile, so two
tiles mate whichever way each is turned; the CAD's four edges of a centre tile give one outline to
0.01 mm, and the inner edges of the side and corner tiles give it again to within 0.01 mm. The
editor's test (`apps/web/src/canvas/tileSeam.test.ts`) rebuilds the outline from the five numbers
and checks every one of its 42 corners against the CAD's to 0.001 in. Along the wall the side and
corner tiles are cut 1.989 mm past their outer seam line, so the tile layer is 3585.71 mm across,
which is the 6 × 23.528 in of Disagreement 2 below; their outer edges are not tab edges, and the
editor draws the wall there, with straight seams under it.

**Drawing.** The field file uses the manual's nominal 24 in tiles, so the editor scales the
outline by 24 / 23.502 (2.1 %) onto each tile edge between seam crossings. When a tab would be
under 2 px deep on screen it draws the straight seams instead.

## Disagreements between the manual and the CAD (not averaged)

1. **Down-hive clearance: 25.5 in (used) against 31.981 in (CAD).** Fig 9-10 prints the bottom of
   the down hive at 25.5 in, and R105 allows a robot 29 in tall, which would not fit under it. The
   CAD puts the down-cell floor at 31.981 in and the lowest hive structure at rest at 30.652 in.
   The two figures cannot both hold on one rigid bar at 30 degrees, and the CAD's up-cell opening
   (53.375 to 65.497 in) matches the manual's printed 53.5 to 65.6 in. The file keeps the manual's
   25.5 in, which is the conservative choice: a planner may reject under-hive travel the real field
   allows, but it will not allow travel the real field blocks.
2. **Field span: 144 by 144 in (used) against 141.348 by 141.348 in (CAD).** The manual's field is
   36 tiles at 24 in (§9.2). Real soft tiles are 23.528 in on centre in the CAD, so everything
   placed from a tile seam or a wall face moves with it: the flower stations (±23.392 instead of
   ±24), the loading zones and the gardens (up to 1.9 in tighter). The file uses the manual's
   nominal frame throughout, so every coordinate in it is consistent with one frame.
3. **Flower top-ring hole: 4.0 in (used) against 4.171 in (CAD).** A small but real difference,
   recorded on every `flowerNTop` target.
4. **Flower foot: 6 by 4.9 in (used) against 5.951 by 5.013 in (CAD).** Within 0.11 in, so a
   refinement rather than a disagreement; recorded on every `flowerNFoot` obstacle.
5. **Flower ring stand-off: 2.54 in off the wall (used) against 2.629 in (CAD).** Recorded on every
   flower.

## Values that are not in any public figure

- **The hive frame's legs, foot bars and crossbar.** No public figure gives them; they come from
  the CAD, as "Hive frame" above says. That closes two items this list used to hold: the base bar's
  height, once a 2 in NEEDS MEASUREMENT, is the CAD's 2.148 in, and the hive pivot support is the
  frame itself, whose parts below 30.6 in are only the legs, the foot bars and the feet.
- **Legal approach margin (6 in).** `legalApproach.outboardOfOuterFaceByIn` on the hive up-cell
  targets is a planning choice, labelled SET BY HAND, not a game figure.
- **Tip table.** `rules.tipTable` is the pollen needed to tip a hive for 0 to 5 nectar already in
  the up cell: 8, 7, 6, 3, 1, 0. The Event Field Setup Guide §12.3 specifies two rows, 8 pollen with
  no nectar and 3 pollen with 3 nectar. The other four rows were measured on a real hive by
  Horizon (FTC 36596); no public document gives them.
- **Human player.** `rules.humanPlayer` gives the human player's 5 nectar (Competition Manual V1
  §10.3.1 B.ii) and its allowance of one per tip of its own hive (§10.1 and G426.A). It places them
  on its own loading zone's tiles (G427.C). The release of the rest at 60 s or less (G426.B) is
  TELEOP only, so the ledger does not carry it.
- **Loading-zone tape edge.** Which side of the tile seams the tape sits on is not fixed by the
  drawings. The loading zones are APPROX to about half an inch.

## Modelling choices

- The `hiveRedPivotBar` and `hiveBluePivotBar` boxes are an axis-aligned envelope over both cells'
  full swing footprint, not a model of the 30 degree bar as it rotates. A tighter obstacle would
  let a planner find paths this file forbids.
- Each frame leg is a `strut`: its centreline with a round envelope that holds the square tube.
  The check takes the rectangle round the part of that envelope below the robot's top, which is at
  most about 0.4 in larger than the tube's own shadow, so it errs the same way as the envelope boxes.
- Garden pollen are placed as a line of touching balls from the alliance's corner along the wall
  (§10.3.1), each 2.8 in across (§9.8).
