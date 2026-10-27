# Bring paths from other planners

A path planned somewhere else can come into Zenith in two ways:

- as **your own auto**, a starting point you edit like any other: from a Pedro Pathing Visualizer
  project (`.pp`), from any planner that writes the interchange `path.json`, or from a
  `trajectory.json`;
- as a **partner trajectory**, which the alliance view shows beside your auto: from MeepMeep through
  a small exporter class, or from any planner that writes the interchange `trajectory.json`.

A team that does not plan in Zenith joins an alliance the same way as one that does: one member
imports the team's file as an auto, saves it, and gives partners a share file (**Download share
file**), like any other auto.

Zenith never runs another planner's code. A planner writes a file, and Zenith reads only files that
pass its schema. Every pose in an imported auto is labelled `CARRIED OVER`, so nobody mistakes an
imported pose for a measured one.

## Import in the editor

With a project open, choose **Import from another planner…**. It is in the command palette
(`Ctrl K`, then type "import") and in the **Open project** dialog.

1. Pick a `.pp` project, a `path.json` or a `trajectory.json` file.
2. Zenith imports it against the project's field and opens it as a new auto named after the file,
   such as `score-and-park.auto.json`. If the project already has an auto of that name, the new one
   is `score-and-park-2.auto.json`. In a folder, Zenith looks at the autos folder as it is now, so a
   file added since the project opened counts too.
3. The auto is not saved yet: the title bar shows the unsaved dot. A notice at the bottom right of
   the field lists every warning the importer gave. It does not block the editor, so you can read a
   warning and look at the path it is about at the same time. **Copy these lines** copies the notice,
   and **Dismiss** closes it.
4. Fix what the problems panel reports, then save. Save writes the auto into the project's autos
   folder, like any other auto.

If the file cannot be imported, nothing opens, and the notice names every field that is wrong.

A file larger than 16 MB is refused before it is read, with a notice that says so. This file-size
limit applies in addition to each format's entry limits, such as the 300,000-row cap for a
`trajectory.json`. A file can meet the row limit and still be too large.

### A `trajectory.json` as an auto

A `trajectory.json` holds poses over time, not an editable path, so the import cuts it where the
robot stops:

- each stretch where the robot drives becomes a `path` step of `line` segments, called `drive1`,
  `drive2` and so on. Every sample of the file lies within 0.5 in and 2 degrees of it, and its
  heading turns along each segment as the file's does;
- each stretch where it stands still for 0.3 s or more becomes a `wait` step, `wait1` and so on;
- each stretch where it turns without moving becomes a `path` step that starts and ends at the same
  point with a `linear` heading, `turn1` and so on, with a warning: check it before you deploy it,
  because the time estimate does not count the turn.

The notice also says:

- how long the file's own trajectory runs. The auto is timed from your `robot.json`, not from the
  file, so compare the estimate before you share it;
- that the file's phases, claims and envelopes were left out. An auto gets its phases and claims
  from its own steps and commands, so add the commands your routine runs;
- the robot's size from the file's `boundingBox`. `robot.json` is not changed.

Every pose is labelled `CARRIED OVER (trajectory.json import)`.

## Load a partner's `trajectory.json`

To show a partner's routine beside yours with its own timing, without making it an auto, load the
`trajectory.json` in the **Partners** panel, the same way as a share file: drop it on the panel or
choose it with **Load share file…**. It is read against the field of the auto you have open, turned
into a view projection at 10 Hz, and checked by the same schema as any projection. With no auto open
it is refused, because there is no field to read it against. A partner's file may be at most 16 MB.

## Import from the command line

```powershell
zenith import score-and-park.pp --out autos/score-and-park.auto.json
zenith import partner.path.json --out autos/partner.auto.json
zenith import partner.trajectory.json --out partners/partner.projection.json
zenith import our-roadrunner.trajectory.json --as-auto --out autos/our-roadrunner.auto.json
```

A `trajectory.json` becomes a projection that `zenith alliance` reads, or, with `--as-auto`, an auto
cut into steps the way the editor does it.

`zenith import` checks an imported auto against the project's robot and field and prints the
findings with the warnings. The [CLI reference](cli-reference.md#zenith-import) lists every option.

## Pedro Pathing Visualizer (`.pp`)

A `.pp` file is the project file the Pedro Pathing Visualizer saves. It is JSON. Zenith reads the
format the visualizer writes at project version 1.5.0, and files from older versions the way the
visualizer itself reads them.

The importer is tested on files the visualizer really saved: projects built in the visualizer at
project version 1.5.0 and at 1.3.0 and saved from it, and a file rebuilt by hand in the shape of a
public 1.2.1 file. For each one, Zenith's tests hold every imported point to within 0.05 in, and
every heading to within 1.5 degrees, of what the visualizer draws along the path.

### What maps

| in the `.pp` file | in the auto |
|---|---|
| `startPoint` | the start pose |
| each top-level path in `lines` | one `path` step, named after the path |
| a compound path (a group) | one `path` step, with one segment per curve |
| a path with no control points | a `line` segment |
| a path with one to three control points | a `bezier` segment |
| a path with more than three control points | several cubic `bezier` segments that stay within 0.05 in of it |
| `tangential` heading | `tangent`, or `tangentReversed` when reversed |
| `constant` heading | `constant` |
| `linear` heading | `linear`, turning the short way, as the visualizer does |
| a `linear` heading of exactly half a turn | two `linear` ranges of a quarter turn each, turning the way the visualizer draws it |
| `piecewise` heading | `piecewise`, range by range |
| a `facing-point` range | a `facePoint` range |
| a group's own heading | the heading of the whole step, in place of its children's |
| `sequence` order | the order of the steps |
| a `wait` in the sequence | a `wait` step, in seconds |
| a sequence item of a kind Zenith does not know | a placeholder command `imported1`, `imported2` and so on |
| `settings.rWidth` and `settings.rHeight` | the robot's size, reported beside the auto |

An auto file allows at most three Bézier control points, so a longer curve is split. A placeholder
command stays a `SCHEMA` finding until you replace it with one of your robot's commands: the auto
cannot be deployed with a command that does nothing. The robot's size is reported, not written into
`robot.json`, because `robot.json` holds your robot's measured numbers.

### What is warned about

Each of these is left out or changed, with a warning that says so:

- `waitAfterMs` and `waitBeforeMs` on a path. The visualizer uses them for playback only and leaves
  them out of its own code export. Add a `wait` step if the robot should stop there.
- `throughPoints`. Zenith builds the one Bézier curve through them that Pedro's own
  `BezierCurve.through` builds. The visualizer draws a different spline through the same points, so
  check the curve.
- A reversed `linear` range. The visualizer draws it turning the long way round, and so does the
  import, as two ranges, or three when the long way round is within about a degree of a whole turn.
- A `linear` heading of exactly half a turn, such as 90 to -90 degrees. The visualizer draws it
  counter-clockwise or clockwise depending on which angle is larger once both are put between 0
  and 360 degrees: 90 to -90 turns counter-clockwise, -90 to 90 clockwise. One half-turn heading has
  no direction of its own on the robot (Pedro turns it clockwise), so the import writes it as two
  quarter turns that turn the way the visualizer draws it.
- A reversed `facing-point` range. It becomes `facePoint` with an offset of half a turn, which the
  planner draws but the robot runtime does not apply yet.
- `shapes`, `fieldPoints` and the motion settings (`xVelocity`, `maxVelocity` and the rest). The
  season's field file is where obstacles come from, and Zenith times a path from `robot.json`.
- A path that is not in the sequence, or a sequence item that names no path.
- A file saved by a newer visualizer, and every key Zenith does not know.
- A file from a visualizer up to 1.3.0: headings kept on the end points (one warning names every
  path), a `startPoint` with no `headingDeg`, the `pathChains` list, and a piecewise heading whose
  `scope` is `"chain"`. The current visualizer ignores path chains and applies each heading to its
  own path, and so does the import. A pause in the older `waitAfter` object is warned about like
  `waitAfterMs`.
- A `sequence` that names none of the paths in `lines`. The visualizer's code export then drives
  every path in `lines` order, and so does the import.
- A field image other than BIOBUZZ's.
- The alliance. A `.pp` file does not say which alliance it was drawn for, so the import uses the
  field's own alliance. `zenith import --alliance BLUE` chooses the other one; in the editor, the
  import notice has an **Import for BLUE** button (or **Import for RED**) that imports the file again
  for the other alliance.

The visualizer's heading picker changes a heading's type in place and keeps the fields of the type
it had before, so a saved heading can read `{ "type": "constant", "reverse": true, "degrees": 45 }`.
Zenith, like the visualizer, reads only the fields of the heading's own type, and does not warn about
the others. The display settings older versions saved, `theme` and `penToolAccuracy`, are ignored in
the same way.

### Limits

A `.pp` file is held to the same limits as a `path.json`: no list longer than 200 entries, no
string longer than 200 characters, and no nesting deeper than 64 levels. A file over a limit is
refused whole, with each value over it named by its JSON path. The two images a project can embed,
`settings.customFieldImage` and `settings.robotImage`, may be longer, because Zenith never reads
them. Every file the visualizer writes is far inside these limits.

### The frame

The visualizer measures from the bottom-left corner of its field, in inches, with headings in degrees
counter-clockwise from +x. For BIOBUZZ its axes point the same way as the field frame Zenith uses
(origin at the centre, +x to the audience's right, +y away from the audience), so a point converts by
a translation alone:

```text
xIn = x - 70.75
yIn = y - 70.75
headingRad = headingDeg * pi / 180
```

A visualizer inch stays a Zenith inch, so path lengths do not change.

!!! note "Why 70.75 and not 72"
    The visualizer's field is 141.5 in across, and its own mirror export mirrors about 70.75 in, so
    70.75 is where it puts the centre. Some teams place their points as if the centre were at
    (72, 72). If that is how your points were placed, import with the centre at 72:

    ```powershell
    zenith import score-and-park.pp --pedro-centre 72
    ```

    Every imported point then moves 1.25 in towards the audience-left corner. From code, pass
    `centreIn: 72` to `importPedroProject`.

This translation was checked for the BIOBUZZ field image only. For a `.pp` file drawn over another
season's image the import warns you to check where the path sits.

## RoadRunner and MeepMeep

RoadRunner has no path file. A RoadRunner auto is Java or Kotlin that builds its trajectories when
it runs, and MeepMeep draws them by running that code. So instead of reading your source, Zenith ships
a copy-in exporter class. One line where MeepMeep runs your trajectory writes it to a
`trajectory.json`, which you import as a partner trajectory.

It writes the trajectory only, not an editable path, because RoadRunner's splines do not map exactly
onto Bézier segments. It supports RoadRunner 1.0 through MeepMeep 0.1.7. RoadRunner 0.5 is not
supported.

### Copy it in

1. Download
   [`robot/meepmeep-export/ZenithTrajectoryExport.java`](https://github.com/Horizon-36596/zenith/blob/main/robot/meepmeep-export/ZenithTrajectoryExport.java)
   from the Zenith repository. It is MIT licensed.
2. Put it in your MeepMeep module (the `MeepMeepTesting` module the MeepMeep instructions set up).
   Keep its package, `org.horizon36596.zenith.meepmeep`, or change the `package` line to one of
   yours.
3. After `myBot.runAction(...)`, add one line:

    ```java
    ZenithTrajectoryExport.write(myBot, java.nio.file.Paths.get("trajectory.json"),
            new ZenithTrajectoryExport.Options("biobuzz", "RED", 18, 18));
    ```

    The two numbers are the robot's length along its heading and its width, in inches. They are the
    `height` and the `width` you gave `setDimensions`, in that order.

4. Run MeepMeep. `trajectory.json` appears in the module's working directory. Import it as your
   own auto with **Import from another planner…** in the editor, or `zenith import trajectory.json
   --as-auto`, to save it and share it as a file. A partner can also load it straight
   into the Partners panel.

The file holds the pose every 0.1 s, in MeepMeep's coordinates, with `"frame": { "preset":
"roadrunner" }`. Waits and turns come out the way MeepMeep plays them. After the last trajectory
MeepMeep draws the robot at (0, 0); the exporter holds the last pose instead.

!!! warning "Not yet compiled against the real libraries"
    The exporter was written against the MeepMeep 0.1.7 and RoadRunner 1.0.1 sources and compiled
    against stand-in classes with the same signatures, because the libraries themselves could not be
    downloaded where it was built. Its arithmetic is tested; its fit to the real jars is not. If it
    does not compile in your MeepMeep project, please
    [open an issue](https://github.com/Horizon-36596/zenith/issues) with the compiler's error.

### The RoadRunner frame

For BIOBUZZ, MeepMeep's frame is the FTC Field Coordinate System: origin at the centre, +x toward the
audience, +y away from the Red Wall, inches, radians counter-clockwise. That is a quarter turn from
Zenith's field frame:

```text
xIn = y
yIn = -x
headingRad = heading - pi / 2
```

This depends on where the season puts the Red Wall, so the import warns when the `roadrunner` preset
is used for a season it was not checked against. A file can always declare its frame key by key
instead.

## The interchange formats, for planner authors

If you write a planner, you can make its paths importable into Zenith by writing one of two files.
Neither needs any Zenith code: write the JSON, check it with `zenith validate`, and ship it.

| file | `kind` | becomes | write it when |
|---|---|---|---|
| `path.json` | `"path"` | an auto that can be edited | your planner has lines, Bézier curves and headings a person would want to keep editing |
| `trajectory.json` | `"trajectory"` | a partner trajectory in the alliance view, or an auto cut into line segments | your planner only has poses over time, or its curves are not Béziers |

Zenith tells the two apart by the `kind` key, the same key every Zenith file uses to say what it is.
Both are strict: a key the format does not know is refused with its path, never silently dropped.

### The frame block

Write poses in your planner's own coordinates, and say what they are in `frame`. Zenith converts.
Name a preset, or give every key, or name a preset and override some of its keys.

| preset | origin | axes | units |
|---|---|---|---|
| `zenith` | the field centre | the field frame | inches, radians counter-clockwise from +x |
| `pedro` | the Pedro Visualizer's corner, the centre at (70.75, 70.75) | the field frame's, for BIOBUZZ | inches, degrees counter-clockwise from +x |
| `roadrunner` | the field centre | MeepMeep's: +x toward the audience, +y away from the Red Wall, for BIOBUZZ | inches, radians counter-clockwise from +x |

The field frame is the frame of the season's `field.json`. For BIOBUZZ its origin is the field
centre, +x points to the audience's right, +y away from the audience, and headings are
counter-clockwise from +x.

| key | value |
|---|---|
| `preset` | `zenith`, `pedro` or `roadrunner` |
| `originIn` | `{ "xIn", "yIn" }`: where your (0, 0) is, in field-frame inches |
| `xAxis` | the field-frame direction your +x points along: `+x`, `-x`, `+y` or `-y` |
| `yAxis` | the field-frame direction your +y points along; it must be perpendicular to `xAxis` |
| `units` | the unit of your positions: `in`, `mm`, `cm` or `m` |
| `headingUnit` | `rad` or `deg` |
| `headingZero` | the axis of yours a heading of zero points along: `+x` or `+y` |
| `headingPositive` | which way a positive heading turns, seen from above in your own axes: `ccw` or `cw` |

Without a preset, every key but `preset` is required. A mirrored frame (one whose axes are
left-handed against the field's) is allowed, and headings and turns in it convert the right way.

### `trajectory.json`

Served at `https://libraries.horizon36596.org/zenith/schema/v1/trajectory.json`.

| key | required | value |
|---|---|---|
| `$schema` | no | the served id above |
| `formatVersion` | yes | `1` |
| `kind` | yes | `"trajectory"` |
| `season` | yes | the season id of the field the routine was planned on, such as `"biobuzz"` |
| `alliance` | yes | `"RED"` or `"BLUE"` |
| `title` | no | a name for the alliance view, up to 200 characters |
| `source` | no | `{ "planner", "exporter" }`: what wrote the file |
| `frame` | yes | the frame block |
| `rateHz` | yes | samples per second, above 0 and at most 1000; 10 or better |
| `poses` | yes | `[x, y, heading]` rows in the frame's units; row i is at i / `rateHz` seconds |
| `boundingBox` | yes | `lengthIn` along the heading and `widthIn` side to side, in inches; optional `centreOffsetIn` (`{ "xIn", "yIn" }`, forward and left) and `provenance` |
| `phases` | no | `{ "startS", "endS", "label" }`, seconds, with `label` one of `drive`, `score`, `collect`, `wait`, `park`, `other` |
| `claims` | no | `{ "elementId", "action", "atS" }`: a field element id, `take` or `score`, and the second it happens |
| `envelopes` | no | `{ "startS", "endS", "polygon" }`: a window in seconds and at least three `{ "x", "y" }` corners in the frame's units, which the robot stays inside |

Zenith resamples the poses to 10 Hz, between your samples along straight lines with the heading
turning the short way, and rounds them to 0.5 in and one degree, which is what the alliance view
carries. The longest trajectory is 300 s.

### `path.json`

Served at `https://libraries.horizon36596.org/zenith/schema/v1/path.json`.

`path.json` has the structure Zenith uses when it shares a routine for another team to change, with
the commands taken out. A command is a name in one team's own robot code and means nothing in another
planner, so command steps, markers, end conditions, branches and groups are not part of it.

| key | required | value |
|---|---|---|
| `$schema` | no | the served id above |
| `formatVersion` | yes | `1` |
| `kind` | yes | `"path"` |
| `season` | yes | the season id, such as `"biobuzz"` |
| `alliance` | yes | `"RED"` or `"BLUE"` |
| `title` | no | the auto's title, up to 200 characters |
| `source` | no | `{ "planner", "exporter" }`: what wrote the file |
| `frame` | yes | the frame block |
| `startPose` | yes | `{ "x", "y", "heading" }` in the frame's units |
| `steps` | yes | one to 200 steps, in order |

A step is a path step or a wait step. Both take an optional `id`, which the auto keeps; ids must be
unique.

| path step key | required | value |
|---|---|---|
| `kind` | yes | `"path"` |
| `segments` | yes | one to 200 segments; each starts where the one before it ends |
| `heading` | no | a heading mode, below; without one the robot faces along the path |
| `speedFraction` | no | a fraction of the robot's top speed, above 0 and at most 1 |
| `timeoutS` | no | seconds before the step gives up, above 0 |

| wait step key | required | value |
|---|---|---|
| `kind` | yes | `"wait"` |
| `seconds` | yes | seconds to wait, 0 or more |

A segment is `{ "kind": "line", "from", "to" }` or `{ "kind": "bezier", "from", "control", "to" }`.
`from` and `to` are `{ "x", "y" }` with an optional `heading`, and `control` is one to three
`{ "x", "y" }` points. Positions are in the frame's `units` and headings in its `headingUnit`, which
is why these keys carry no unit in their names.

| heading `mode` | other keys | the robot |
|---|---|---|
| `tangent` | | faces along the path |
| `tangentReversed` | | faces backwards along the path |
| `constant` | `heading` | holds one heading |
| `linear` | `from`, `to` | turns from `from` to `to` across the step, exactly as written: 90 to 270 degrees is half a turn counter-clockwise, not the short way |
| `facePoint` | `x`, `y`, optional `offset` | faces a point, turned by `offset` |
| `piecewise` | `ranges` | follows one mode per range: `{ "startT", "endT", "heading" }`, where `startT` and `endT` are fractions of the step's length that run from 0 to 1 with no gap and no overlap |

### A worked example

A planner whose frame is millimetres from the audience-left corner of the field, with its x along the
field's +y and its y along the field's +x, and headings in degrees clockwise from its own +y, writes
this for a BLUE robot that drives 27 in towards the audience, waits a second and slides 28 in to the
right while turning a quarter turn:

```json
{
  "$schema": "https://libraries.horizon36596.org/zenith/schema/v1/path.json",
  "formatVersion": 1,
  "kind": "path",
  "season": "biobuzz",
  "alliance": "BLUE",
  "title": "Explicit millimetre frame",
  "frame": {
    "originIn": { "xIn": -72, "yIn": -72 },
    "xAxis": "+y",
    "yAxis": "+x",
    "units": "mm",
    "headingUnit": "deg",
    "headingZero": "+y",
    "headingPositive": "cw"
  },
  "startPose": { "x": 3429.0, "y": 2133.6, "heading": 270 },
  "steps": [
    {
      "kind": "path",
      "segments": [
        { "kind": "line", "from": { "x": 3429.0, "y": 2133.6 }, "to": { "x": 2743.2, "y": 2133.6 } }
      ],
      "heading": { "mode": "constant", "heading": 270 }
    },
    { "kind": "wait", "seconds": 1 },
    {
      "kind": "path",
      "segments": [
        { "kind": "line", "from": { "x": 2743.2, "y": 2133.6 }, "to": { "x": 2743.2, "y": 2844.8 } }
      ],
      "heading": { "mode": "linear", "from": 270, "to": 360 }
    }
  ]
}
```

Zenith reads it as an auto that starts at (12, 63) in the field frame facing the audience, drives to
(12, 36), waits, and drives to (40, 36) while turning from facing the audience to facing +x. This file
is one of the fixtures, `explicit-millimetres.path.json`.

### Checklist

- **Write your frame.** Name a preset only if your coordinates are exactly that preset's; otherwise
  give every key. A wrong frame imports cleanly and lands in the wrong place.
- **Sample at 10 Hz or better** in a `trajectory.json`. Below that the import still works, with a
  warning, but the poses between your samples are straight-line guesses.
- **Round no coarser than 0.5 in**, and a heading no coarser than one degree. Zenith rounds to that
  itself, so anything coarser loses what the alliance view shows.
- Make the segments of a path step join, and a `piecewise` heading's ranges run from 0 to 1.
- Use the season id of the field the routine was planned on. A file for another season is refused.
- Write the robot's real size in a `trajectory.json`'s `boundingBox`, with a `provenance` saying
  where the numbers came from.
- Run `zenith validate` on every file you write, and fix everything it reports.

### Fixtures

The repository keeps example files for both formats in
[`packages/import/fixtures/`](https://github.com/Horizon-36596/zenith/tree/main/packages/import/fixtures),
and the `@horizon36596/zenith-import` npm package ships the same folder:

- `path/`: `path.json` files in the Pedro, RoadRunner and an explicit millimetre frame;
- `trajectory/`: `trajectory.json` files, including the MeepMeep exporter's own output;
- `pedro/`: `.pp` projects. `visualizer-1.5.0-*.pp` and `visualizer-1.3.0-*.pp` were saved by the
  visualizer itself, and `visualizer-drawn.json` records the points and headings the visualizer
  draws for every `.pp` fixture, which the tests compare the import with;
- each `broken/` folder: files that must fail, each with one thing wrong, which `zenith validate`
  names by its field.

Zenith's own tests hold every good `.pp` and `path.json` fixture to the rule that its imported path
lies within 0.5 in of the file's own path, and the MeepMeep export to within 0.5 in of its samples.

### Validate a file

`zenith validate` takes an interchange file the same way it takes an auto. It does not need a
project: outside one, it reads the file against the field the season's package ships.

```powershell
zenith validate my-path.path.json
```

```text
my-path.path.json
  error  SCHEMA  (file)  steps[2].heading.ranges[1].startT: is 0.5; it must be where ranges[0] ends (0.4), so the ranges leave no gap and do not overlap.
1 error, 0 warnings
```

Every problem is a `SCHEMA` finding that starts with the JSON path of the value it is about. The
importer's warnings, such as a sample rate below 10 Hz or a claim on an element the field does not
have, are `warning` findings. `zenith validate` exits `1` on any error and `0` otherwise, so it fits
in a planner's own test suite. With `--json` each finding carries the path on its own, in `field`:

```powershell
zenith validate my-path.path.json --json
```

```json
{
  "project": null,
  "files": [
    {
      "path": "my-path.path.json",
      "kind": "path",
      "findings": [
        {
          "severity": "error",
          "stepId": "(file)",
          "code": "SCHEMA",
          "message": "steps[2].heading.ranges[1].startT: is 0.5; it must be where ranges[0] ends (0.4), so the ranges leave no gap and do not overlap.",
          "field": "steps[2].heading.ranges[1].startT"
        }
      ],
      "seasonWarnings": []
    }
  ],
  "errors": 1
}
```

Inside a project, the file is read against the project's own field. An agent can do the same through
the MCP server's `zenith.validate` tool, with the file's path as `auto` (see
[Agents and MCP](agents-mcp.md)).

The JSON Schemas can also check a file in any JSON Schema validator, or in an editor that reads
`$schema`, but they cannot check everything: a frame whose axes are not perpendicular, segments that
do not join and ranges with a gap pass the schema and fail the import. `zenith validate` checks both.
