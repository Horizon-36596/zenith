# BIOBUZZ field ledger (2026-27)

Everything an auto plan needs for its arithmetic on the BIOBUZZ field, with the source of each number
named so a stale one can be found: FIRST's field CAD, the TU01 game manual, or the DSim field model
(APPROX, where the manual gives no number). What belongs to one robot - its speeds, its mouths, its sim
harness - is in that robot repository's `references/robot.md`, not here.

Inches and the FIELD frame throughout: origin at field centre, +X toward the audience's right and toward
BLUE, +Y away from the audience, headings counter-clockwise from +X. The inner walls are at +/-70.674 in
(CAD; a real field is 141.35 in inside, not 144), so an 18 in robot touching a wall has its centre at
+/-61.674.

**Zenith's own BIOBUZZ field file (`biobuzz.field.json` in its BIOBUZZ example) is partly behind this
ledger.** It has the hive frame's four legs and two foot bars from the CAD (issue #229), but still marks
the hive cells solid from the manual's 25.5 in up, not the CAD's 30.652 in (see "What stops the robot"),
so its `STRUCTURE` findings under a hive are conservative for a robot taller than 25.5 in. A robot's own
field constants may lag the CAD too; its `references/robot.md` says where. Where a model disagrees with
a headless run on the CAD field, the run is the authority.

## Where the pollen is at kickoff

40 pollen, and at kickoff **none of them are loose on the open field except the garden lines and the
loading zones**. Source: the manual's match setup.

| Where | How many | Position |
|---|---|---|
| Flowers, 4 of them | 16, four per flower | stacked inside the flower on its lower plate, entered through a hole 21.4 in up; the bottom one comes out through the retrieval opening (below) |
| Garden lines | 8, four per alliance | RED's four step from the (-70.674, -70.674) corner along +X, one ball diameter apart, against the wall; BLUE is the point mirror |
| Your robot's preload | 4 | aboard |
| Absent robots' preloads | 12 | in the loading zones at y = +/-36, against the side walls |

**The flowers are a pollen source, from the bottom** (manual G418.B). A running intake mouth against a
flower's retrieval opening (0.354 to 3.904 in above the tiles, CAD) pulls the bottom pollen out, the column
dropping each time; DSim allows one every 0.15 s. A nectar at the bottom locks the flower. The chassis stops
at the flower's foot (5.013 in off the wall), so the approach is nose (or tail) to the wall, centred on the
flower along it. Whether a given intake can reach through the opening is a fact about that robot - check
its `references/robot.md`. So 40 pollen are reachable before the first spill: 16 in the flowers, 8 on the
garden lines, 12 in the loading zones and the 4 preloaded. The flowers are the nearest source to a
wall-side start.

Nectar: 3 per alliance staged in that alliance's up cell, and 5 more with its human player (manual
§10.3.1 B; DSim has 8 per alliance in all). Nectar is a ball like pollen (owner ruling,
2026-10-03): it is not locked in the hive. A tip dumps it with the pollen onto the floor on the old up
cell's side, and the robot can intake, carry, launch and drop it; it counts toward the robot's
capacity. **Only your own alliance's nectar**: a robot may not control the other alliance's (G408;
DSim), and only your own goes into your hive (DSim). A nectar
launched back into the up cell lowers the next tip's cost (the tip table below).

**The human player** may bring in one nectar for each tip of your own hive, at any time, up to its 5
(§10.1 and G426.A; DSim). It places it by hand, with no tool, on the tiles of your own
LOADING ZONE, touching the tiles before any robot or field element (G427.C); DSim drops it at the middle
of the zone against the side wall (). In the ledger that is a transfer from
`humanPlayerOwn` to `loadingZoneOwn`; asking for more than the tips allow moves what is allowed and says
why. The release of everything left at 60 s or less (G426.B) is TELEOP only.

**Flower centres** (CAD): 0 at (-68.045, -23.392), 1 at (-23.392,
68.045), 2 at (68.045, 23.392), 3 at (23.392, -68.045). Each has a solid 5.951 x 5.013 in foot against
the wall that stops the chassis, so a flower is an obstacle as well as a target.

**Your partner's preloads.** The standing assumption is that they have four and are out of the way. That is
an assumption about a real alliance partner, so it is the human's to confirm per match.

## What stops the robot

From the CAD, what a chassis cannot drive through:

- the perimeter;
- **the hive frame's two foot bars** (am-5878), x = +/-22.75..24.735, y = -19.472..19.472, 2.148 in
  tall; Zenith's box adds the feet and their screw heads, x = +/-22.54..24.76 and y = -19.48..19.48 -
  **a straight path that crosses them with |y| < 19.5 is blocked**, and the follower then pushes against
  the bar until the buzzer;
- **the hive frame's four legs** (am-5876), 1 in square tubes from a foot at (+/-23.80, +/-18.56, 0.53)
  up to the frame's top at (+/-12.74, +/-0.51, 41.08), sloping in toward the hive's pivot;
- the four flower feet.

A robot under 30 in tall drives **under** the hive cells, whose lowest point at rest is 30.652 in up (the
Goal Rib, CAD); Zenith's field file marks them solid from 25.5 in, the manual's figure. Nothing else of
the hive structure comes below 30.6 in, but the legs do, and **how much of the floor a leg blocks
depends on the robot's height**: the part of the leg below the robot's top casts a shadow that reaches
further in toward the pivot the taller the robot is.

**The leg corridor rule.** Under the RED hive the west legs' shadow at a robot's height has its inner
edge at x = -21.75 for a 6 in robot, -20.11 at 12 in, -18.48 at 18 in, -16.84 at 24 in and -15.47 at
29 in, and it runs in from |y| = 19.07 as far as |y| = 15.58 at 6 in, 10.23 at 18 in and 5.34 at 29 in
(CAD hull). Zenith's `STRUCTURE` check adds up to about 0.6 in to it. So a robot driving north or south under the hive keeps its west side east of that edge: an 18 in
wide robot that is 18 in tall needs its centre east of about x = -9. It also has to keep its east side
on RED's side of the centre line, x = 0, during AUTO (G402, `OPPONENT_SIDE`, an error), so an 18 in
robot has a fraction of an inch between the two and a wider one has none: the starter autos go round
the west side of the frame instead, with their start and scoring spots on x = -13, 4 in clear of the
line. A taller robot meets the legs further east still. BLUE is the point mirror. `STRUCTURE` reads the robot's `heightIn` for this, so set it from the real robot;
the starter's 18 in is a PLACEHOLDER.

## The hive and the tip

The RED hive pivots at (-12.75, 0); BLUE at (+12.75, 0). One cell is up and one is down; a tip swings them
over and the up cell comes down.

**Tip table** (DSim; the manual gives none, §9.6), indexed by how
many nectar are in the up cell. A cell tips once its pollen reaches the entry, and past 5 nectar the last
entry holds (, `hiveWillTip`):

| Nectar in cell | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| Pollen needed | 8 | 7 | 6 | 3 | 1 | 0 |

At kickoff the up cell holds 3 nectar, so **the 4 preload pollen tip it** (3 would). The cell that comes
up is empty, so if nobody adds nectar every tip after the first costs **8**: **a second volley of 4 does
not tip it**, two do. 5 nectar tip a cell with no pollen. Three tips is therefore 3 + 8 + 8 = 19 pollen;
at 4 pollen aboard that is five volleys.

**Score from the up cell's quarter.** Your launch goes into the up cell only when your robot is in the
floor quarter the cell is over (owner ruling, 2026-10-03, issue #95): for RED, x < 0 and y < 0 while the
cell faces SOUTH, x < 0 and y > 0 while it faces NORTH. From anywhere else the balls land loose on the
floor, and the ledger reports `LEGAL_APPROACH`. A launch at the other alliance's hive scores nothing for
you either.

**Nothing comes back out of a cell but a tip** (G417: launching into the up cell is the only legal hive
interaction; DSim's intake takes only ground elements). The down cell is
always empty.

**The swing** takes 4 s at exactly the tip load and runs faster when the cell is overloaded (0.35x per
ball over, up to 3x). The cell empties half way, when the bar passes level: its whole contents, pollen and
nectar alike, are dumped from under the hive (z 32 in), thrown outboard at 30..62 in/s within +/-40
degrees, from a seeded random generator (, `spillPoses`), on the emptying cell's own
side. The ledger counts the dump in that side's floor quarter (`floorRedGardenSide` for RED's first tip).
So a spill does not land on a line, and a fixed sweep line after a tip is a guess; label it `SET FROM SIM`
and say so. **The hive keeps taking balls through the swing**: into
the loaded cell until it empties, then into the rising one, and what lands in the rising one is still there
when it is up. A ball shot during the swing is never wasted, but after the cell has emptied it counts
toward the NEXT tip. All of it is DSim's APPROX; watch a real tip.

**When a tip counts as AUTO** (manual 10.5.B): it has to complete before TELEOP starts, at 38 s (30 s of
AUTO plus the 8 s transition). A tip started at 36 s still counts if the swing finishes by 38 s.

**Legal approach:** a shot into a cell has to come from outboard of the cell's outer face (18.528 in from
the hive pivot along the cell's mouth direction, CAD). For a SOUTH up cell that is y < -18.528, plus
whatever margin the robot's own check adds (`references/robot.md`); NORTH is the mirror. Beside the hive,
under it, or on the far side, there is no legal approach at all.
