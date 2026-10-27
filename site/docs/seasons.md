# Seasons

The path, timing and collision checks in Zenith work for any FTC season. What changes each year is
the game: what the robot carries, where it scores, and what makes a start pose legal. That part lives
in a **season plugin**. This page explains how a plugin works, then walks through the BIOBUZZ plugin
as an example.

## How a field picks its plugin

A season is described by its `field.json`. Its `rules.plugin` field names the plugin that judges it:

```json
{
  "season": "biobuzz",
  "rules": {
    "plugin": "season-biobuzz"
  }
}
```

The `@horizon36596/zenith-seasons` package holds the one registry that turns a field file into a
plugin. It looks up `rules.plugin` first, then falls back to `season`. The editor, the CLI and the MCP
server all use the same registry, so they never disagree about which season a project is.

### When there is no plugin

If a field names no plugin, or names one this build does not carry, Zenith uses empty rules:

- The routine still loads, plans, estimates and validates.
- Paths, headings, timing, perimeter and obstacle checks all run as normal.
- The season-dependent checks and the ledger rows are **absent**. They are not wrong and they do not
  pass; they simply do not run.
- A warning explains why, in a full sentence, and lists the plugins this build knows. The CLI prints
  it to stderr, and `--json` output carries it in a `seasonWarnings` array.

So a team can plan paths for a new season on day one, before anyone writes its plugin.

## The `SeasonRules` interface

A plugin is one object that implements `SeasonRules`. The core never looks inside the plugin's
state; it only passes it from one step to the next. That running state is the **ledger**.

| method | what it answers |
|---|---|
| `initialState(field)` | What the field looks like at the start: every game piece and scoring element, read from `field.json`. |
| `onLaunch(state, target, count, pose)` | What happens when the robot scores `count` pieces at `target` from `pose`: the robot holds fewer, the target holds more, and anything the game triggers as a result. |
| `onCollect(state, containerId, count, alliance)` | What happens when the robot picks up `count` pieces from a container or the floor, limited by what is there and what the robot has room for. `alliance` is the routine's, for an id that says `Own` or `Opponent`. |
| `currentTarget(state, alliance)` | Where this alliance should score right now, given the state so far. |
| `legalApproach(state, target, pose, robot)` | Whether scoring at `target` from `pose` is allowed by the game rules. |
| `startLegal(field, pose, robot, alliance)` | Whether the start pose is legal, as a list of findings. An empty list means legal. The pose is in the frame of `alliance`, the file's own; `field.json`'s `startRules` are written for the canonical alliance, and the plugin reads them for the other one through their counterparts. |
| `summary(state)` | The rows shown in the ledger panel and in the pull request body at the end of the routine. |

Optional methods add detail when a season needs it:

| method | what it adds |
|---|---|
| `start(state, holds)` | Loads what the auto says the robot starts holding. |
| `holds(state)` | What the robot is holding now, for the capacity and empty-shot checks. |
| `onTip(state, which, alliance)` | Applies an event the author asserts happened, trusted over the plugin's own prediction. |
| `knowsTarget(state, target)` | Whether a name is a target a robot can launch into, for the `LAUNCH_TARGET` check. |
| `targetPoint(state, target)` | Where a target sits on the field, for range and bearing checks. |
| `nearestLegalApproach(state, target, pose, robot)` | The closest legal pose, so a finding can offer a one-click fix. |
| `describe(before, after)` | A one-line description of what a step changed, for the ledger rows. |
| `mirrorId(id)` | The other alliance's name for a field id, so a routine can be mirrored. |
| `claimPlace(field, elementId, pose)` | The physical place a robot at `pose` takes from or scores into, in a few words such as "the north cell", for an id that names different places over a match. BIOBUZZ's hive target always names the cell that is up, so it answers with the cell over the floor quarter the robot is in. [`ALLIANCE_ELEMENT_CONFLICT`](checks-and-findings.md#alliance_element_conflict) then compares places, not ids. Left out, or null, and the id is one place. |
| `obstacleLabel(id, field)` | What a person calls an obstacle of the field file, such as "the west base bar of the hive frame" for `frameBarWest`, so a `STRUCTURE` message names something a student can find. The message keeps the id after it. |
| `ownSide(field, alliance)` | The side of the field the routine's robot stays on during auto: the line (`axis`, `lineIn`), which side is the alliance's own (`ownSign`), how far past it a corner may go (`toleranceIn`) and the rule's sentence for the message (`rule`). [`OPPONENT_SIDE`](checks-and-findings.md#opponent_side) reports a footprint past it, and the optimizer keeps routes off the other side. Left out, or null, and nothing is checked. |
| `locations(state, alliance)` | Every place the ledger counts pieces, with its count and where to draw it, for [transfer steps](file-format.md#transfers) and the count badges on the field. |
| `onTransfer(state, from, to, count, alliance)` | A transfer step: up to `count` pieces from one place to another, with whatever the game triggers as a result. |
| `measure(state, quantity, alliance)` | A number the ledger keeps, for a condition's `{ quantity, min, max }` test in `robot.json`. |

Two rules every plugin follows:

- **The field file is the season.** Every number the plugin uses comes from `field.json`, not from
  constants typed into the plugin. A team that corrects a measurement in its own copy of the field
  file gets corrected rules with it.
- **Never invent a number.** If the plugin cannot know something, it says so. An unknown becomes an
  unknown in the estimate, not a guess.

## Example: BIOBUZZ

`@horizon36596/zenith-season-biobuzz` is the reference plugin, for the 2026-27 game BIOBUZZ presented
by RTX. The game rules and field are public FTC information; the plugin models only the parts that
decide what an autonomous routine can do.

### What the plugin tracks

Pollen
:   The game piece the robot carries and launches. The plugin counts what the robot holds, up to the
    `rules.capacity` in the field file.

Garden
:   Pollen lying on the floor at the start. Each garden element is one piece, present until
    collected.

Flowers
:   Containers that hand pieces out of an opening at their base, from the bottom of the column. The
    field file lists which kinds the opening lets out; nectar is not one of them, so a nectar at the
    bottom of a flower locks it until the nectar is gone.

Hives
:   Each alliance has one. A hive has two cells on a pivot; one is up, and the one that is down is
    always empty. Pieces launched into the up cell stay there, and nothing takes them out but a tip
    (manual G417; DSim). The field file's `rules.tipTable` is the pollen it takes
    to tip the hive, indexed by how many nectar are in the up cell, with the last row holding past
    its end: 8, 7, 6, 3, 1, 0 for 0 to 5 nectar (DSim; the
    manual gives no table). At kickoff the up cell holds 3 nectar, so the 4 preload pollen tip it.
    When the up cell holds enough pollen, the hive tips: the cells swing, the up side flips, and
    everything in the old up cell, nectar and pollen alike, is dumped onto the floor quarter on that
    cell's own side (DSim). The cell that comes up is empty,
    so the next tip takes 8 pollen, and a second cycle of 4 does not tip it. 5 nectar tip a cell
    alone.

Scoring from the right quarter
:   This robot's pieces go into the up cell only when the robot is in the floor quarter the cell is
    over; from anywhere else they land loose, and
    LEGAL_APPROACH reports the step. Only the routine's own hive is followed: Zenith edits one
    alliance's auto at a time, so the ledger lists and summarises that alliance's hive and human
    player, and a launch at the other hive lands loose.

Nectar
:   A game piece like pollen. Each alliance's 3 start staged in its up
    cell. A tip dumps it with the pollen; the robot can intake, carry, launch and drop it, and it
    counts toward the robot's capacity. Only the alliance's own nectar goes into its robot or its
    hive (G408; DSim). Nectar launched into an up cell makes
    the next tip cheaper.

The human player
:   Starts with 5 nectar (manual §10.3.1 B.ii) and may bring in one for each tip of its own hive, at
    any time (§10.1 and G426.A; DSim), onto the tiles of its own loading zone
    (G427.C; DSim). The field file carries both numbers in `rules.humanPlayer`. A
    transfer from `humanPlayerOwn` that asks for more moves what is allowed and says why. The
    release of the rest at 60 s or less (G426.B) is TELEOP only, so an auto never sees it.

The partner, the floor and the loading zones
:   What the alliance partner carries (the field's preload, `startRules.holds`, until a transfer
    says otherwise), the pieces on each quarter of the floor, and the pieces in each alliance's
    loading zone, the zone the field file marks `ledger: "loadingZone"`, where the human player
    enters pieces. Only [transfer steps](file-format.md#transfers) change them:
    the plugin does not plan the partner's routine or the human player's.

### What each method computes

- **`initialState`** reads the hives (pivot, which side is up, what each cell holds), the flowers and
  what they hold, the garden pieces, the tip table and the capacity from `field.json`.
- **`onLaunch`** takes pieces off the top of the robot's hopper, last in first out (DSim). From the up cell's quarter they go into the alliance's up cell, and
  the tip table is checked at the nectar in the cell; if the cell holds enough pollen, the hive tips,
  and it keeps checking in case the new up cell already holds enough. From anywhere else, or at
  something that is not a hive cell, they land loose.
- **`onCollect`** takes pieces, nectar the same as pollen, from a flower, a garden line, a floor
  quarter, a loading zone or the loose pile, never more than the place has or the robot has room
  for, and never the other alliance's nectar. A hive cell gives nothing. A flower gives only from
  the bottom of its column, and only the kinds its opening lets out (G418.B; DSim). An id ending in `.nectar` or `.pollen` (`loose.nectar`) takes only that kind;
  without one, pollen comes first, because neither the manual nor DSim says which ball on the floor
  an intake reaches first. `Own` and `Opponent` in the id stand for the routine's alliance and the
  other one (`loadingZoneOwn`), as in a transfer.
- **`onTip`**, an author's `assumeTipped` or `expect.tip`, swings the hive. When the tip table had
  already predicted a tip the author has not confirmed, the assertion confirms that one instead of
  swinging the hive a second time.
- **`currentTarget`** is the alliance's own hive's up cell.
- **`legalApproach`** allows a launch only from the up cell's floor quarter, and there only from
  outboard of the up cell's outer face, by the margin the field file states, along the hive's swing
  axis and on the side the cell faces. After a tip the up side flips, so the legal side flips with
  it.
- **`startLegal`** checks the field file's `startRules` against the robot's footprint at the start
  pose: touching a wall, inside its own half, outside any forbidden zone, and not touching a flower.
  Each broken rule is a `START_ILLEGAL` error.
- **`ownSide`** is G402 (manual V1 §11.4.1): during AUTO the robot stays on its own alliance's side,
  columns A to C for red and D to F for blue (Figure 9-5). The line is x = 0 and the own side is the
  half the alliance's own hive is in, the same line and the same 0.05 in tolerance as `startLegal`'s
  own half, read from one function so the two never disagree. The message ends with the penalty, a
  MAJOR FOUL, and a YELLOW CARD if the referees see it as STRATEGIC.
- **`summary`** prints what the robot holds, the routine's own hive's up side, tip count, what its
  up cell holds by kind and the pollen it still takes to tip, what each flower and the garden have
  left, what is loose, any floor quarter or loading zone holding pieces, and what the routine's own
  human player has brought in and has left.
- **`onTransfer`** moves up to the step's count from one place to another, never more than the
  source holds. Pieces put into the own hive's up cell go through the tip table exactly as a launch
  does; from this robot they go in only from the up cell's quarter. A garden line is only ever a
  source. A hive cell is never a source, the down cell and the other alliance's hive are never a
  destination, and the human player is held to its stock and its one per tip.
- **`measure`** reads a place's count, one kind's count there (`hiveOwnUpCell.nectar`), or
  `<hive>.tips`, how many times a hive has tipped.

### What it does not model

Where in its floor quarter a tip's dump lands. DSim throws it outboard at random speeds and angles,
and some of it can roll on; the ledger counts it in the quarter and does not place it closer.
Where a launch that did not go in lands: it is counted as loose with an unknown position. A
following "collect the nearest pollen" step then has an unknown time, which the estimate shows as
unknown instead of making one up.

Which ball an intake reaches first on the floor, in a loading zone or from the partner. Neither the
manual nor DSim gives an order, so the ledger takes pollen first unless the id names a kind.

The partner's quarter. A transfer from the partner into the up cell is taken at the author's word,
wherever the partner is.

## Writing a plugin for a new season

1. Write the season's `field.json`: field elements, obstacles, zones, targets, `startRules` and a
   `rules` block with `plugin` set to your plugin's id. Give every number a provenance label.
2. Create a package that exports a `SeasonRules` object and a `loadSeason(field)` function. Use
   `packages/season-biobuzz` as the template.
3. Register it in `packages/seasons/src/index.ts`: one entry with its `plugin` name, its `season`
   name, a label and its `load` function, plus a dependency in that package's `package.json`.
4. Add tests: the kickoff state from the field file, a launch, a collect, the approach rule on both
   sides, and each start rule.

If you are not ready to write one yourself, open a season request on the issue tracker with the game
manual link and the field dimensions.
