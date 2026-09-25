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
| `onCollect(state, containerId, count)` | What happens when the robot picks up `count` pieces from a container or the floor, limited by what is there and what the robot has room for. |
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
| `targetPoint(state, target)` | Where a target sits on the field, for range and bearing checks. |
| `nearestLegalApproach(state, target, pose, robot)` | The closest legal pose, so a finding can offer a one-click fix. |
| `describe(before, after)` | A one-line description of what a step changed, for the ledger rows. |
| `mirrorId(id)` | The other alliance's name for a field id, so a routine can be mirrored. |

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
:   Containers that hand pollen out of an opening at their base. The field file lists which kinds the
    opening lets out; nectar is not one of them.

Hives
:   Each alliance has one. A hive has two cells on a pivot; one is up. Pollen launched into the up
    cell stays there. When the up cell holds as many pieces as the field file's `rules.tipTable` says,
    the hive tips: the cells swing, the up side flips, and what was in the old up cell spills onto the
    floor. The table has one entry per tip, so later tips can need fewer pieces.

Nectar
:   Locked inside the hive. There is no legal way to take it back out during auto, so a collect from
    a hive does nothing.

### What each method computes

- **`initialState`** reads the hives (pivot, which side is up, what each cell holds), the flowers and
  what they hold, the garden pieces, the tip table and the capacity from `field.json`.
- **`onLaunch`** moves pieces from the robot into the alliance's up cell, then checks the tip table.
  If the cell is full enough, the hive tips, and it keeps checking in case the new up cell is already
  over the next threshold.
- **`onCollect`** takes pieces from a flower, a garden line or the loose pile, never more than the
  container has or the robot has room for.
- **`currentTarget`** is the alliance's own hive's up cell.
- **`legalApproach`** allows a launch only from outboard of the up cell's outer face, by the margin
  the field file states, along the hive's swing axis and on the side the cell faces. After a tip the
  up side flips, so the legal side flips with it.
- **`startLegal`** checks the field file's `startRules` against the robot's footprint at the start
  pose: touching a wall, inside its own half, outside any forbidden zone, and not touching a flower.
  Each broken rule is a `START_ILLEGAL` error.
- **`summary`** prints what the robot holds, each hive's up side, tip count and up-cell count, what
  each flower and the garden have left, and how many pieces are loose.

### What it does not model

Where spilled pollen lands. After a tip, the spilled pieces are counted as loose with an unknown
position. A following "collect the nearest pollen" step then has an unknown time, which the estimate
shows as unknown instead of making one up.

!!! info "Field images"
    The BIOBUZZ field images in the editor are by Team Juice 16236, from their "BIOBUZZ custom field
    images (MeepMeep compatible)" post on r/FTC.

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
