# @horizon36596/zenith-import

Bring paths from other planners into [Zenith](https://libraries.horizon36596.org/zenith/), the FTC
autonomous planner by Horizon (FTC 36596). Licence: MIT.

```
npm install @horizon36596/zenith-import
```

## Package reference

Pure, like `@horizon36596/zenith-core`: no DOM, no clock, no randomness, no Node APIs. Reading the
file is the caller's job; `zenith import` in `@horizon36596/zenith-cli` does it for you.

- `importPedroProject(json, field, options?)` turns a Pedro Pathing Visualizer project (`.pp`) into an
  auto in the season's frame, and returns `{ auto, robotFootprint?, warnings }`. Paths become `path`
  steps, headings keep Pedro's names, sequence waits become `wait` steps, and any sequence item of a
  kind the importer does not know becomes a placeholder command `imported1`, `imported2` and so on, to
  map to one of your robot's commands. Every pose carries `CARRIED OVER (Pedro Visualizer import)`.
- `importTrajectory(json, field)` turns an interchange `trajectory.json` into a view projection:
  poses at 10 Hz in the season's frame, rounded to 0.5 in and one degree. `readTrajectory` returns the
  same with its warnings.
- `importPath(json, field, options?)` turns an interchange `path.json` into an auto that can be
  edited, and returns `{ auto, warnings }`. Every pose carries `CARRIED OVER (path.json import)`.
- `interchangeKindOf(doc)` says which interchange file a document is, by its `kind` key
  (`"trajectory"` or `"path"`), and `checkInterchange(kind, doc, field)` checks it the way importing
  it would, returning `{ kind, errors, warnings }`. This is what `zenith validate` reports.
- `scanCommands(sources)` reads a robot's `NamedCommands.register` and `registerCondition` calls
  out of its Java or Kotlin source text (`{ path, text }[]`), with each command's arguments from its
  `argInt`, `argDouble`, `argString` and `argEnum` calls, and lists what it could not read as
  `issues` with the file and line. `checkCommandRegistry(robot, scan)` compares the result with
  `robot.json`, and `mergeCommandScan(robot, scan)` adds the commands, conditions and params
  `robot.json` lacks without changing anything already there. `zenith import-commands` does it for
  you. `diffLines` and `formatDiff` preview the change as a line diff.
- All three importers throw `ImportError`, whose `issues` name every field that is wrong by its JSON
  path.

The frames, file formats and APIs these rest on were read from source and are recorded in
Zenith's ADR 0008, in the repository's decision records.

## `trajectory.json`

The JSON Schema is `json/trajectory.json`, served at
`https://libraries.horizon36596.org/zenith/schema/v1/trajectory.json`. A planner writes its poses in
its own coordinates and declares the frame, either by preset or key by key:

| preset | origin | axes | units |
|---|---|---|---|
| `zenith` | field centre | the season's field frame | inches, radians counter-clockwise from +x |
| `pedro` | the Pedro Visualizer's corner, centre at (70.75, 70.75) | the field frame's, for BIOBUZZ | inches, degrees counter-clockwise from +x |
| `roadrunner` | field centre | MeepMeep's: +x toward the audience, +y away from the Red Wall, for BIOBUZZ | inches, radians counter-clockwise from +x |

Keys given beside a preset override it. Without a preset every key is required: `originIn` (where
the planner's origin is, in field-frame inches), `xAxis` and `yAxis` (the field-frame direction,
`+x`, `-x`, `+y` or `-y`, each planner axis points along), `units` (`in`, `mm`, `cm` or `m`),
`headingUnit` (`rad` or `deg`), `headingZero` (`+x` or `+y`, of the planner's axes) and
`headingPositive` (`ccw` or `cw`).

The rest of the file: `formatVersion: 1`, `kind: "trajectory"`, `season`, `alliance`, optional
`title` and `source`, `rateHz` (samples per second; 10 or better), `poses` (`[x, y, heading]`, the
i-th at i / rateHz seconds), `boundingBox` (`lengthIn` along the heading, `widthIn`, optional
`centreOffsetIn` forward and left, optional `provenance`), and the optional `phases` (`startS`,
`endS`, `label` from `drive`, `score`, `collect`, `wait`, `park`, `other`), `claims` (`elementId`,
`action` `take` or `score`, `atS`) and `envelopes` (`startS`, `endS`, `polygon` of `{ x, y }` in the
declared frame). Unknown keys are refused, with their path.

`robot/meepmeep-export/` has a copy-in class that writes this file from MeepMeep.

## `path.json`

The JSON Schema is `json/path.json`, served at
`https://libraries.horizon36596.org/zenith/schema/v1/path.json`. It is the structure of a
propose-level projection with the commands taken out, and the same `frame` block as
`trajectory.json`: `formatVersion: 1`, `kind: "path"`, `season`, `alliance`, optional `title` and
`source`, `frame`, `startPose` (`{ x, y, heading }`) and `steps`. A step is a path step (`kind:
"path"`, optional `id`, `segments` of `line` or `bezier` with one to three `control` points,
optional `heading`, `speedFraction` and `timeoutS`) or a wait step (`kind: "wait"`, optional `id`,
`seconds`). Heading modes are Zenith's: `tangent`, `tangentReversed`, `constant` (`heading`),
`linear` (`from`, `to`, turning from one to the other as written), `facePoint` (`x`, `y`, optional
`offset`) and `piecewise` (`ranges` of `{ startT, endT, heading }` running from 0 to 1). Positions
and headings are in the declared frame's units, which is why their keys carry no unit suffix.

## Fixtures

`fixtures/pedro/` holds `.pp` projects in the visualizer's 1.5.0 format (and one saved by a newer,
imagined 1.7.0, with an `event` item), `fixtures/trajectory/` interchange files, and each `broken/`
folder files that must fail with a named field. `fixtures/path/` holds `path.json` files in the
Pedro, RoadRunner and an explicit millimetre frame, with its own `broken/` folder. The tests hold every good `.pp` fixture to the
milestone's contract: the imported auto loads, and its path lies within 0.5 in of the visualizer's.
The `path.json` fixtures are held to the same: each imports to an auto with no error finding whose
path lies within 0.5 in of the file's own.
