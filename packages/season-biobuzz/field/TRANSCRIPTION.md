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
4. **The field image by Team Juice 16236** (`apps/web/public/fields/biobuzz/SOURCE.md`): only the
   image's own placement (`image.provenance`) was set from it. It was checked against the
   transcribed loading zone, flowers and hive, and no field coordinate was read off it.

## Frame

Centre origin, inches, **+X = audience right (BLUE side)**, **+Y = away from the audience**,
heading in radians CCW from +X. RED is x < 0 and BLUE is x > 0: the manual puts RED on tile
columns A to C (G304, Fig 9-5). The layout is **point-symmetric** about the centre, not mirrored
(Fig 9-2), so the alliance mirror is `(x, y, h) -> (-x, -y, h + π)`. At the start the red hive's up
cell is the south one (y < 0) and the blue hive's is the north one (Fig 10-2); they swap every tip.

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

- **Frame base bar height (2 in): NEEDS MEASUREMENT.** No public drawing gives it.
- **Hive pivot support.** No obstacle models the region near each pivot, between the two cells'
  inner faces. There is almost certainly a mount there. It needs a measurement or a CAD extract
  before an auto plans a path directly under a hive's pivot line.
- **Legal approach margin (6 in).** `legalApproach.outboardOfOuterFaceByIn` on the hive up-cell
  targets is a planning choice, labelled SET BY HAND, not a game figure.
- **Tip table.** `rules.tipTable` is the pollen needed to tip a hive for 0 to 5 nectar already in
  the up cell: 8, 7, 6, 3, 1, 0. The Event Field Setup Guide §12.3 specifies two rows, 8 pollen with
  no nectar and 3 pollen with 3 nectar. The other four rows were measured on a real hive by
  Horizon (FTC 36596); no public document gives them.
- **Loading-zone tape edge.** Which side of the tile seams the tape sits on is not fixed by the
  drawings. The loading zones are APPROX to about half an inch.

## Modelling choices

- The `hiveRedPivotBar` and `hiveBluePivotBar` boxes are an axis-aligned envelope over both cells'
  full swing footprint, not a model of the 30 degree bar as it rotates. A tighter obstacle would
  let a planner find paths this file forbids.
- Garden pollen are placed as a line of touching balls from the alliance's corner along the wall
  (§10.3.1), each 2.8 in across (§9.8).
