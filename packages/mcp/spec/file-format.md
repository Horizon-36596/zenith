# File format reference

Zenith keeps everything in plain JSON files inside your robot repository. Five kinds of file:

!!! note "Keep the editor, CLI and runtime on compatible versions"
    These formats describe the source version of this guide. A development branch can write newer
    formats than the latest published runtime accepts. Use the documentation and tools from the
    same release when running an auto on the robot. An older runtime can reject a file saved by a
    newer editor; changing `formatVersion` by hand does not convert it.

| file | what it holds | current `formatVersion` | JSON Schema |
|---|---|---|---|
| `zenith.json` | the link file: where everything else lives, how to run the sim | 1 | [`link.json`](https://libraries.horizon36596.org/zenith/schema/v1/link.json) |
| `robot.json` | one robot: footprint, speeds, intake mouths, commands, conditions | 1 | [`robot.json`](https://libraries.horizon36596.org/zenith/schema/v1/robot.json) |
| `*.field.json` | one season's field: walls, obstacles, zones, game elements, start rules | 3 | [`field.json`](https://libraries.horizon36596.org/zenith/schema/v1/field.json) |
| `waypoints.json` | named poses shared by every auto | 1 | [`waypoints.json`](https://libraries.horizon36596.org/zenith/schema/v1/waypoints.json) |
| `*.auto.json` | one autonomous routine | 4 | [`auto.json`](https://libraries.horizon36596.org/zenith/schema/v1/auto.json) |

Two more kinds of file travel between teams instead of living in your repository. They are
described at the end of this page:

| file | what it holds | current `formatVersion` | JSON Schema |
|---|---|---|---|
| [`*.projection.json`](#projectionjson) | what another team receives when you share an auto | 1 | [`projection.json`](https://libraries.horizon36596.org/zenith/schema/v1/projection.json) |
| [`*.proposal.json`](#proposaljson) | the changes a team proposes to an auto shared with it | 1 | [`proposal.json`](https://libraries.horizon36596.org/zenith/schema/v1/proposal.json) |

A typical layout:

```text
<robot repo>/
  zenith.json                   link file
  autos/
    robot.json                  this robot
    field/biobuzz.field.json    the season's field
    waypoints.json              named poses
    first-auto.auto.json        one routine
    collect-and-score.auto.json another routine
```

The starter example, `examples/starter` in the Zenith repository, is laid out the same way. The
examples on this page are its files.

Some code blocks show one property, such as `"sim": { ... }`, rather than a whole file. Insert that
property into the surrounding JSON object, keeping its other properties and the commas between
them. Complete file examples include the outer braces and `formatVersion`.

`zenith init` writes `zenith.json`, a skeleton `robot.json` and `waypoints.json`, and a copy of the
BIOBUZZ field. `zenith new <name>` adds an auto.

## Units

Files use **inches, radians and seconds**. Every numeric key names its unit in a suffix:

| suffix | unit | examples |
|---|---|---|
| `In` | inches | `xIn`, `widthIn`, `distanceIn` |
| `Rad` | radians | `headingRad`, `fromRad`, `minRad` |
| `S` | seconds | `timeoutS`, `settleS`, `autoS` |
| `InPerS` | inches per second | `maxForwardVelInPerS` |
| `InPerS2` | inches per second squared | `accelInPerS2` |
| `RadPerS` | radians per second | `maxAngularVelRadPerS` |

The editor shows degrees and converts at the boundary. Files never hold degrees, with one exception:
the field image's `rotationDeg`, which is a quarter-turn setting, not a measurement.

## The field frame

All poses are in one frame, fixed by the field file:

- The origin is the **centre** of the field.
- **+X** points to the audience's right.
- **+Y** points away from the audience.
- Heading 0 points along +X, and a positive heading turns **counter-clockwise**.
- Headings are wrapped to (−π, π].

An auto's poses are in the frame of its own `alliance`: a RED file's poses are where the robot
drives as RED, and a BLUE file's poses are where it drives as BLUE. The editor draws a file as its
own alliance by default, so what you draw is what the robot drives. Autos are usually written for
the **RED** alliance, the canonical alliance, and Zenith produces the BLUE version by mirroring. For BIOBUZZ the mirror is a **point symmetry** through the field centre:
a RED pose (x, y, h) becomes the BLUE pose (−x, −y, h + π). Named field elements swap to their
other-alliance counterparts, so a mirrored routine expects the hive and flowers it will really face.
Headings mirror with the poses. A `linear` sweep keeps its size and the way it turns, so its `toRad`
can land outside (−π, π]; under a reflection the sweep turns the other way. The robot runtime mirrors a
file run as the other alliance the same way.

In the robot frame, the nose points along +x and the robot's left along +y.

## Canonical form

Zenith writes every file the same way, byte for byte. A file loaded and saved without changes comes
back identical. That keeps git diffs of an auto small and pull requests readable.

- UTF-8, LF line endings, a trailing newline.
- Two-space indent.
- Object keys in **schema order**, not alphabetical: `name` before `steps`, `kind` before
  `segments`. The order in the examples below is the canonical order.
- Numbers rounded by the unit of the key that holds them:

| key ends in | decimals | examples |
|---|---|---|
| `Rad` | 4 | `headingRad`, `fromRad` |
| `In` | 3 | `xIn`, `lengthIn` |
| `S` or `S2` | 3 | `timeoutS`, `maxForwardVelInPerS`, `accelInPerS2`, `maxAngularVelRadPerS` |

The suffix at the very end decides, so `maxAngularVelRadPerS` ends in `S` and rounds to 3 decimals.

Rounding applies **only to the key that names the unit**. An array under such a key rounds its
elements the same way. A number inside an object under such a key names no unit of its own and keeps
full precision. So in

```json
"maxForwardVelInPerS": { "value": 60.12345, "provenance": "MEASURED: velocity tuner" }
```

`value` is written as `60.12345`, not rounded to 3 decimals. A measured constant keeps every digit
it was measured to.

A number that must be over 0, such as a `timeoutS`, never rounds down to 0: a `timeoutS` of
`0.0004` is written as `0.001`, so the saved file still loads. A number that may be 0, such as a
coordinate, rounds to 0 as usual.

## Provenance labels

Every constant in `robot.json` and `field.json` should say where it came from. Poses in
`waypoints.json` should too. The label goes first, then the reason:

```json
"accelInPerS2": { "value": 60, "provenance": "PLACEHOLDER: until calibrated" }
```

| label | use it for | trust |
|---|---|---|
| `MEASURED` | measured on the real robot or field | measured |
| `SPEC` | taken from the game manual or a part's datasheet | measured |
| `CALIBRATED FROM ROBOT` | fitted by `zenith calibrate` from real-robot recordings | measured |
| `SET BY HAND` | chosen deliberately, such as a speed limit | derived |
| `SET FROM EDITOR` | placed by dragging or typing in the editor | derived |
| `SET FROM SIM` | read off a simulator run | derived |
| `CALIBRATED FROM SIM` | fitted by `zenith calibrate` from simulator traces | derived |
| `CARRIED OVER` | copied from an older robot or season | derived |
| `NEEDS MEASUREMENT` | known to be wrong or missing; measure it | unverified |
| `PLACEHOLDER` | a stand-in so the file works | unverified |
| `APPROX` | an estimate, close but not measured | unverified |

The editor shows each label as a chip and sorts it into one of the three trust tiers. A label that
names two tiers, such as `SET FROM SIM; PLACEHOLDER until measured`, counts as the weaker one. A
measured or derived label counts only as whole words, so `UNMEASURED` and `SPECIFICATION` are not
`MEASURED` or `SPEC`, and `NOT MEASURED` is unverified. A number with no label, or with text that
names no label, is treated as `NEEDS MEASUREMENT`.

## Format versions and migration

Every file carries a `formatVersion`. Each kind of file is versioned on its own, and the version
goes up only for a change that breaks older readers.

| file | current | history |
|---|---|---|
| `*.auto.json` | 4 | 2 added the [`sequence`](step-kinds.md#sequence) step. 3 added the [`piecewise`](#piecewise-heading) heading mode. 4 added the planner-only [`transfer`](#transfers) step. |
| `*.field.json` | 3 | 2 added the optional [`image`](#field-image). 3 added the [`strut`](#obstacles) obstacle. |
| `robot.json` | 1 | unchanged |
| `waypoints.json` | 1 | unchanged |
| `zenith.json` | 1 | unchanged |
| `*.projection.json` | 1 | new. The optional `commands` list was added without a new version, since every earlier projection is still valid. |
| `*.proposal.json` | 1 | new |

- Zenith **loads older versions** and migrates them in memory. The editor, the CLI and the MCP
  server all do this.
- Zenith **always writes the current version**. A version 1, 2 or 3 auto comes back from its first
  save as version 4, and a version 1 or 2 field as version 3, otherwise unchanged. The editor says
  so when it opens one, since an older Zenith cannot open the new version.
- The robot runtime **refuses a newer version** than it knows, at init, and the message names both
  versions. Update the runtime when you update the app.

The `$schema` URLs keep `v1` in their path. The URL names the kind of file; `formatVersion` says
which revision of that kind it is.

## JSON Schemas

The schemas are JSON Schema draft 2020-12, served from the docs site:

- `zenith.json`: <https://libraries.horizon36596.org/zenith/schema/v1/link.json>
- `robot.json`: <https://libraries.horizon36596.org/zenith/schema/v1/robot.json>
- `*.field.json`: <https://libraries.horizon36596.org/zenith/schema/v1/field.json>
- `waypoints.json`: <https://libraries.horizon36596.org/zenith/schema/v1/waypoints.json>
- `*.auto.json`: <https://libraries.horizon36596.org/zenith/schema/v1/auto.json>
- `*.projection.json`: <https://libraries.horizon36596.org/zenith/schema/v1/projection.json>
- `*.proposal.json`: <https://libraries.horizon36596.org/zenith/schema/v1/proposal.json>
- `*.trajectory.json`: <https://libraries.horizon36596.org/zenith/schema/v1/trajectory.json>, the
  interchange trajectory (see [Bring paths from other planners](import.md))
- `*.path.json`: <https://libraries.horizon36596.org/zenith/schema/v1/path.json>, the interchange path
  (see [Bring paths from other planners](import.md))

Put the URL in a file's `$schema` key and editors such as VS Code will complete and check it as you
type. `$schema` is optional when reading; Zenith writes it on every save. The same schemas ship in
the `@horizon36596/zenith-schema` npm package, with TypeScript types; the two interchange schemas
ship in `@horizon36596/zenith-import`.

## `zenith.json`

The link file at the root of the robot repository. It tells Zenith where the other files are. This
is the starter example's, `examples/starter/zenith.json`:

```json
{
  "$schema": "https://libraries.horizon36596.org/zenith/schema/v1/link.json",
  "formatVersion": 1,
  "autosDir": "autos",
  "robot": "autos/robot.json",
  "field": "autos/field/biobuzz.field.json",
  "waypoints": "autos/waypoints.json",
  "deploy": {
    "kind": "androidAssets",
    "dir": "TeamCode/src/main/assets/autos",
    "commandLibrary": "solverslib",
    "robotClass": "org.firstinspires.ftc.teamcode.zenith.MyRobot"
  },
  "sim": {
    "command": "./gradlew :TeamCode:testDebugUnitTest --tests \"*ZenithAutoHeadlessTest*\" -Dzenith.auto={auto}",
    "trace": "TeamCode/build/sim/{auto}.trace.json"
  },
  "codegen": { "package": "org.firstinspires.ftc.teamcode.zenith", "dir": "TeamCode/src/main/java" }
}
```

| key | required | meaning |
|---|---|---|
| `autosDir` | yes | the folder holding `*.auto.json` files |
| `robot` | yes | path to `robot.json` |
| `field` | yes | path to the field file |
| `waypoints` | no | path to `waypoints.json` |
| `deploy` | no | where `zenith deploy` copies autos. `kind` is `androidAssets` (the runtime reads them from the APK's assets) or `directory`. `commandLibrary` is `ivy` or `solverslib`: which runtime the generated OpModes and `zenith codegen` classes use ([Choosing a command library](command-libraries.md)). It has no default, and `zenith deploy`, `zenith codegen` and the desktop app's Deploy refuse to write Java until it is set; the schema accepts a file without it, so an older `zenith.json` still opens and validates. `robotClass` is the robot class the generated OpModes build. `opModeBase`, optional, is your own abstract subclass of your library's `AutoFromFile`, fully qualified, which the generated OpModes extend in place of `AutoFromFile`. |
| `sim` | no | how to run the [high-fidelity sim](simulation.md#high-fidelity-sim): `command`, `trace` and, optionally, `server`. [`sim`](#sim) below has the keys. |
| `codegen` | no | the Java package and source folder `zenith codegen` writes to |
| `javaDir` | no | where the robot's Java or Kotlin is: one folder, or a list of them. When it is set, [`zenith validate`](cli-reference.md#zenith-validate) also checks `robot.json`'s commands against the `NamedCommands` registrations there, with no `--java` flag, and [`zenith import-commands`](cli-reference.md#zenith-import-commands) and the editor's Import commands from Java scan it by default. It may point outside this folder, such as `../robot/TeamCode/src/main/java`, since it is only read; a folder that is not there is a warning. |

All paths are relative to the folder holding `zenith.json`.

### `sim`

```json
"sim": {
  "command": "./gradlew :TeamCode:testDebugUnitTest --tests \"*ZenithAutoHeadlessTest*\" -Dzenith.auto={auto}",
  "trace": "TeamCode/build/sim/{auto}.trace.json",
  "server": {
    "prepare": "./gradlew <your prepare task>",
    "args": "TeamCode/build/sim/server.args",
    "cwd": "TeamCode",
    "watch": ["TeamCode/src", "TeamCode/build.gradle"]
  }
}
```

| key | required | meaning |
|---|---|---|
| `command` | yes | the command that runs one auto in the sim. `{auto}` is replaced with the auto's name. It is split into words and run with no shell; `./gradlew` works on Windows too. |
| `trace` | yes | where that run writes its [trace](simulation.md#the-trace). `{auto}` is replaced with the auto's name. |
| `server` | no | a sim server for the desktop app's [Full sim speed](full-sim-simloop.md#full-sim-speed). Without it, a project runs only Basic. |
| `server.prepare` | yes, in `server` | builds what the server needs and writes the `args` file. It runs like `command`, in the folder `zenith.json` is in, and must exit with 0. |
| `server.args` | yes, in `server` | the Java argument file the server is started with: `java @<args>`. |
| `server.cwd` | no | the server's working folder. The folder `zenith.json` is in when it is not set. |
| `server.watch` | no | files and folders whose change means the robot code changed. The server is then stopped, and the next run prepares and starts it again. `.` is the whole repository. |

Every `server` path is relative to the folder `zenith.json` is in, written with `/`, and must stay
inside it: `zenith validate` refuses one that starts with `/` or a drive letter, or has a `..` part.
The desktop app checks again before it runs anything. `./` and `.` parts are ignored, so `./TeamCode/`
is `TeamCode`, and on Windows case does not matter.

Some changes inside a watched folder never count as robot code: the `args` file's folder, the folder
`trace` writes into, the folder the server says it wrote a trace into, and `autosDir`. Nor does
anything prepare writes while it runs. A file you save while prepare runs is not noticed either; save
it again once prepare is done. The protocol the server speaks is
[The sim server protocol](sim-server-protocol.md).

## `robot.json`

Everything the planner needs to know about one robot. This example is the starter example's
`autos/robot.json`, a generic robot: a plain mecanum drive, one front intake, a fixed launcher.
Every number is a round placeholder. Replace them with your own robot's values as you measure them.

```json
{
  "$schema": "https://libraries.horizon36596.org/zenith/schema/v1/robot.json",
  "formatVersion": 1,
  "name": "Starter robot",
  "frame": { "forward": "+x", "left": "+y", "headingZero": "+x", "headingPositive": "ccw" },
  "footprint": {
    "startIn": { "lengthIn": 18, "widthIn": 18, "provenance": "PLACEHOLDER: starter example, measure your own robot" },
    "expandedIn": { "lengthIn": 18, "widthIn": 18, "provenance": "PLACEHOLDER: starter example, nothing sticks out past the frame" },
    "centreOfRotationIn": { "xIn": 0, "yIn": 0, "provenance": "PLACEHOLDER: starter example, the middle of the frame" }
  },
  "heightIn": { "value": 18, "provenance": "PLACEHOLDER: starter example, measure your own robot" },
  "kinematics": {
    "maxForwardVelInPerS": { "value": 60, "provenance": "PLACEHOLDER: starter example, measure your own robot with Pedro's velocity tuner" },
    "maxStrafeVelInPerS": { "value": 50, "provenance": "PLACEHOLDER: starter example, measure your own robot with Pedro's velocity tuner" },
    "forwardDecelInPerS2": { "value": 60, "provenance": "PLACEHOLDER: starter example, measure your own robot with Pedro's deceleration tuner" },
    "strafeDecelInPerS2": { "value": 40, "provenance": "PLACEHOLDER: starter example, measure your own robot with Pedro's deceleration tuner" },
    "accelInPerS2": { "value": 60, "provenance": "PLACEHOLDER: starter example, the same as the forward deceleration until you calibrate it" },
    "maxAngularVelRadPerS": { "value": 6, "provenance": "PLACEHOLDER: starter example, measure your own robot" },
    "defaultPathSpeedFraction": { "value": 0.8, "provenance": "SET BY HAND: starter example, 80 percent of full speed on every path" },
    "follower": { "library": "pedro", "version": "3.0.0-20260828.185437-17", "holdEnd": true }
  },
  "mouths": [
    {
      "id": "front",
      "side": "FRONT",
      "offsetIn": { "xIn": 7, "yIn": 0 },
      "widthIn": 16,
      "depthIn": 4,
      "provenance": "PLACEHOLDER: starter example, one intake across the front of the frame, flush with the front edge"
    }
  ],
  "capacity": { "elementKind": "pollen", "max": 4, "provenance": "SPEC (G407): the most pollen a robot may hold in BIOBUZZ" },
  "shooter": { "kind": "fixed", "settleS": { "value": 0.25, "provenance": "PLACEHOLDER: starter example, time for the robot to settle before it launches" } },
  "commands": [
    {
      "name": "intakeOn",
      "summary": "Runs the front intake inward and keeps it running.",
      "params": { "state": { "type": "enum", "values": ["ON"], "default": "ON" } },
      "estimateS": "0",
      "requires": ["intake"],
      "stationary": false
    },
    {
      "name": "intakeOff",
      "summary": "Stops the front intake.",
      "params": { "state": { "type": "enum", "values": ["OFF"], "default": "OFF" } },
      "estimateS": "0",
      "requires": ["intake"],
      "stationary": false
    },
    {
      "name": "spinUp",
      "summary": "Brings the launcher up to speed so the next score starts sooner. Ends once the launcher is at speed.",
      "estimateS": "0.5",
      "requires": ["launcher"],
      "stationary": false
    },
    {
      "name": "score",
      "summary": "Launches count pollen into the alliance's up hive cell, then waits for the launcher to settle. The robot must stand still while it runs.",
      "params": { "count": { "type": "integer", "min": 1, "max": 4, "default": 1 } },
      "estimateS": "0.5 + count * 0.5",
      "requires": ["launcher", "intake"],
      "stationary": true,
      "ledger": { "launches": "count" }
    }
  ],
  "conditions": [
    { "name": "holdingPiece", "summary": "At least one pollen is aboard. A sensor in the intake reads it." },
    { "name": "hopperFull", "summary": "The robot holds as much pollen as it may: four in BIOBUZZ.", "ledger": "full" },
    { "name": "hopperEmpty", "summary": "The robot holds no pollen.", "ledger": "empty" }
  ]
}
```

### Top-level keys

`name`
:   A name for people. Shown in the editor.

`frame`
:   How the robot frame is laid out. For almost every robot, leave it as shown.

`footprint`
:   `startIn` is the robot's box at the start of the match. `expandedIn` is the box with every
    mechanism out, which the wall and structure checks use. `lengthIn` runs along the nose,
    `widthIn` across it. `centreOfRotationIn` is the offset of the turning centre from the box
    centre. `footprint.heightIn` is also accepted; the top-level `heightIn` wins when both are set.
    `footprint.clearanceIn` is optional: how close, in inches, the robot may pass a structure before
    the [`CLEARANCE`](checks-and-findings.md#clearance) warning, as `{ "value", "provenance" }`. It
    is 1 in when left out, and 0 turns the warning off. Canonical form writes it last in
    `footprint`, after `heightIn`. Settings, Robot writes it with **Set**, labelled SET BY HAND.

`heightIn`
:   How tall the robot is, so the [`STRUCTURE`](checks-and-findings.md#structure) check knows what
    it can drive under. 18 in when left out.

`mouths`
:   Each intake opening: `id`, `side` (`FRONT`, `BACK`, `LEFT` or `RIGHT`), `offsetIn` from the robot
    centre, `widthIn` and `depthIn`. The wall and structure checks sweep the mouths with the body,
    and [`MOUTH_LEADING`](checks-and-findings.md#mouth_leading) uses `side`.

`capacity`
:   What the robot collects (`elementKind`) and how many it can hold (`max`).

`shooter`
:   Optional. `kind` is free text. A turret adds `turretRangeRad` with `minRad` and `maxRad`, used by
    [`TURRET_RANGE`](checks-and-findings.md#turret_range). `cadenceS` and `settleS` may describe
    firing rhythm.

`commands`
:   The named-command registry. See [commands](#commands).

`conditions`
:   The named conditions a `wait`, `branch` or `endCondition` may read. The optional `ledger` says
    how the preview reads the condition from the [ledger](seasons.md), so a branch on it draws the
    side the ledger picks. `"full"` means the robot holds its `capacity.max`, `"empty"` that it holds
    nothing. `{ "quantity": ..., "min": ..., "max": ... }` means a number the season's ledger keeps
    lies from `min` to `max`, both inclusive, either one optional: a place's piece count (`robot`,
    `hiveRedUpCell`, `flower0`, see [transfers](#transfers)) or a counter such as `hiveRed.tips`.
    `Own` and `Opponent` in a quantity stand for the routine's alliance and the other one, so
    `{ "quantity": "hiveOwn.tips", "min": 1 }` reads "our hive has tipped at least once" for RED
    and BLUE alike. It is planner-only: on the robot the condition is always your own
    `BooleanSupplier`.

### `kinematics`

| key | meaning |
|---|---|
| `maxForwardVelInPerS` | top speed driving nose-first |
| `maxStrafeVelInPerS` | top speed driving sideways |
| `forwardDecelInPerS2` | how fast the robot slows when coasting forward |
| `strafeDecelInPerS2` | how fast it slows when coasting sideways |
| `accelInPerS2` | how fast it speeds up |
| `maxAngularVelRadPerS` | top turning rate |
| `defaultPathSpeedFraction` | the `speedFraction` a path uses when it sets none |
| `settleS` | optional: time added at the end of a path for the follower to settle. 0.25 s when left out. |
| `strafeFractionWarn` | optional: the [`STRAFE_FRACTION`](checks-and-findings.md#strafe_fraction) threshold. 0.2 when left out. |
| `sweepSpeedFraction` | optional: the [`SWEEP_SPEED`](checks-and-findings.md#sweep_speed) limit. 0.4 when left out. |
| `calibration` | optional: written back after calibration. `band` is the estimate's error band as a fraction, with `samples` and `provenance`. |
| `follower` | the path follower: `library` (`pedro`), `version` and `holdEnd` |
| `drivetrain` | optional: `trackWidthIn`, `wheelBaseIn`, `wheelResponseRatePerS` for the preview sim |

Each value is an object, `{ "value": ..., "provenance": "..." }`, so it can say where it came from.

`follower` may also carry the Pedro follower's gains and tolerances, each an optional
`{ value, provenance }`, for the [instant preview sim](simulation.md#instant-preview-sim):
`forwardTranslationalPowerPerIn`, `strafeTranslationalPowerPerIn`, `headingPowerPerRad`,
`headingStaticPower`, `coastPowerPerInPerS`, `coastFeedforwardPowerPerInPerS`,
`brakeFeedforwardPowerPerInPerS`, `maxBrakingPower`, `headingDriveRatio`, `brakeAggression`,
`brakeLinearForwardS`, `brakeQuadraticForwardS2PerIn`, `brakeLinearStrafeS`,
`brakeQuadraticStrafeS2PerIn`, `headingBrakeLinearS`, `headingBrakeQuadraticS2PerRad`,
`endParametricT`, `endHeadingToleranceRad`, `endTranslationalToleranceIn`,
`endVelocityToleranceInPerS`, `holdTimeoutS`, `headingDeviationToleranceRad`,
`translationalDeviationToleranceIn` and `minCorrectionDistanceIn`. Two switches, `cosineScale` and
`turnBeforeDriving`, take a boolean or `{ value, provenance }`. A key left out falls back to
Pedro's default or a value derived from the rest of the file. Copy these from your Pedro constants
when you want the preview to follow paths the way your robot does.

### Commands

Each entry describes one command your robot code registers with `NamedCommands`.

| key | meaning |
|---|---|
| `name` | must match the name registered in the robot code |
| `summary` | shown in the editor: the whole of it on a long hover, its first sentence in a list (see below) |
| `params` | the arguments, each with a `type`: `integer`, `number` (with optional `min`, `max`, `default`), `enum` (with `values`), `boolean` or `string` |
| `estimateS` | how long it takes: an expression over the params using numbers, `+ - * /`, `max` and `min`, or `"unknown"` |
| `requires` | the subsystems it uses |
| `stationary` | `true` if the robot must stand still; a marker firing it raises [`STATIONARY_MARKER`](checks-and-findings.md#stationary_marker) |
| `movesRobot` | `true` if it drives the robot by itself; the next path must start from `"current"` |
| `ledger` | how it changes what the robot holds, such as `{ "launches": "count" }` |
| `provenance` | optional: where the entry came from. [`zenith import-commands`](cli-reference.md#zenith-import-commands) writes `SET FROM <file>; estimateS NEEDS MEASUREMENT` on a command it reads from the robot's Java |

A param, and a condition, may also carry an optional `provenance`; `zenith import-commands` writes
`SET FROM <file>` on each one it adds.

An `estimateS` of `"unknown"` draws a hatched block in the timeline, and the routine's total becomes a
lower bound.

### Writing a `summary`

Write the first sentence for the person building the auto, and say what the robot does: "Runs the front
intake inward and keeps it running." The editor cuts a summary at its first sentence where a list has
room for one line, in the Insert menu and in Settings with descriptions switched on, and shows the whole
summary when someone hovers the name for a moment. Put anything a programmer needs, such as the Java class
or a default, after that first sentence, where it is still one hover away and never in the way. The cut
is at a sentence end, so Zenith adds no ellipsis. A summary of one sentence is shown whole. A condition's
`summary` follows the same rule.

## `*.field.json`

One season's field, as vector geometry in the field frame. Zenith ships the BIOBUZZ field. Copy it
into your repository so you can correct measurements locally.

This is the BIOBUZZ field from the starter example, shortened to one obstacle, one zone, two
elements (a pollen in the RED garden and a flower) and one target. The shipped file has them all.

```json
{
  "$schema": "https://libraries.horizon36596.org/zenith/schema/v1/field.json",
  "formatVersion": 3,
  "season": "biobuzz",
  "name": "BIOBUZZ presented by RTX (FTC 2026-27)",
  "frame": {
    "origin": "centre",
    "xAxis": "audienceRight",
    "yAxis": "awayFromAudience",
    "headingZero": "+x",
    "headingPositive": "ccw",
    "units": "in",
    "canonicalAlliance": "RED",
    "mirror": "pointSymmetry",
    "view": { "audienceAt": "bottom" }
  },
  "sizeIn": { "xIn": 144, "yIn": 144 },
  "periods": { "autoS": 30, "teleopS": 120 },
  "obstacles": [
    {
      "id": "hiveRedPivotBar",
      "kind": "box",
      "minXIn": -22.75,
      "maxXIn": -2.75,
      "minYIn": -18.58,
      "maxYIn": 18.58,
      "minZIn": 25.5,
      "maxZIn": 65.6,
      "solidToRobot": true,
      "provenance": "SPEC plus APPROX (BIOBUZZ Competition Manual V1 §9.6, Figs 9-9 to 9-11). Pivot at x = -12.75: the two hives are 25.5 in centre to centre (Fig 9-10) and the pair is centred on the field (Fig 9-2; FIRST's BIOBUZZ field CAD (STEP v26-27.2) agrees). Cell outer face 18.58 in from the pivot in plan: the cells' inner faces are 18.84 in apart and each cell is 12.04 in deep (Fig 9-9), so the outer face is 21.46 in along the bar, times cos 30 degrees for the 30 degree tilt (Fig 9-10). Opening 20 in wide (§9.6.2, Fig 9-11). z from 25.5 in, the bottom of the down hive, to 65.6 in, the top of the up-cell opening (Fig 9-10). The box is an envelope over both cells' full swing footprint, because either cell may be up. APPROX on the 25.5 in floor: FIRST's BIOBUZZ field CAD (STEP v26-27.2) puts the down-cell floor at 31.981 in and the lowest hive structure at rest at 30.652 in, see TRANSCRIPTION.md."
    }
  ],
  "zones": [
    {
      "id": "loadingZoneRed",
      "kind": "rect",
      "minXIn": -72,
      "maxXIn": -61,
      "minYIn": 24,
      "maxYIn": 48,
      "rule": "G304: no start here",
      "provenance": "APPROX (BIOBUZZ Competition Manual V1 §9.3, Figs 9-2 and 9-3; FIRST's Event Field Setup Guide §8.3): 11 in deep off the x = -72 wall, between the y = +24 and y = +48 tile seams, tape included. FIRST's BIOBUZZ field CAD (STEP v26-27.2), on its 23.528 in tile pitch, puts it at x in [-70.674, -59.101], y in [23.907, 46.599], see TRANSCRIPTION.md."
    }
  ],
  "elements": [
    {
      "id": "gardenRed0",
      "kind": "pollen",
      "container": null,
      "xIn": -70.6,
      "yIn": -70.6,
      "radiusIn": 1.4,
      "provenance": "APPROX (BIOBUZZ Competition Manual V1 §10.3.1, Fig 10-2): the red garden's four pollen lie in a line along the audience wall starting in the red corner, each touching the next. Pollen are 2.8 in across (§9.8), so ball i sits at x = -(72 - 1.4 - 2.8 i), y = -(72 - 1.4)."
    },
    {
      "id": "flower0",
      "kind": "container",
      "container": "flower",
      "xIn": -69.46,
      "yIn": -24,
      "holds": ["pollen", "pollen", "pollen", "pollen"],
      "provenance": "SPEC plus APPROX (BIOBUZZ Competition Manual V1 §9.7, Figs 9-2, 9-4 and 9-12). On the x = -72 wall at the y = -24 tile seam, one tile off centre. The ring centre 2.54 in off the wall face (x = -69.46) is APPROX, derived from the public field drawings: FIRST's BIOBUZZ field CAD (STEP v26-27.2) puts it 2.629 in off the wall. Retrieval opening 3.55 in tall by 3.57 in deep at the bottom (Fig 9-12), taken as 6 in wide, the width of the foot. Holds 4 pollen at the start of the match (§10.3.1, Fig 10-2).",
      "retrieval": { "side": "field", "openingIn": { "widthIn": 6, "heightIn": 3.55, "depthIn": 3.57 }, "takes": ["pollen"] }
    }
  ],
  "targets": [
    {
      "id": "hiveRedUpCell",
      "kind": "cell",
      "provenance": "SPEC plus SET BY HAND. Aim at 59.5 in, the middle of the up-cell opening at 53.5 to 65.6 in (BIOBUZZ Competition Manual V1 Fig 9-10). A launch enters the cell's open outer end (§9.6.2, Fig 9-11), so it approaches along y from outboard of the outer face. The 6 in margin outboard of that face is SET BY HAND: a planning choice, not a game figure.",
      "hive": "hiveRed",
      "aimZIn": 59.5,
      "legalApproach": { "outboardOfOuterFaceByIn": 6, "alongAxis": "y" }
    }
  ],
  "startRules": { "touchingWall": true, "ownHalf": true, "notInZones": ["loadingZoneRed"], "notTouchingContainers": ["flower"], "holds": { "pollen": 4 } },
  "rules": { "plugin": "season-biobuzz", "tipTable": [8, 7, 6, 3, 1, 0], "capacity": 4 }
}
```

!!! note
    The example is formatted for reading. Canonical form writes each object's keys one per line.

| key | meaning |
|---|---|
| `season`, `name` | the season id and its display name |
| `frame` | the [field frame](#the-field-frame). `mirror` is `pointSymmetry`, `mirrorX`, `mirrorY` or `none`. `view.audienceAt` is where the editor draws the audience by default. |
| `sizeIn` | the field's size |
| `image` | optional picture drawn under the geometry; see [field image](#field-image) |
| `periods` | `autoS` and `teleopS`; [`TIME_BUDGET`](checks-and-findings.md#time_budget) reads `autoS` |
| `obstacles` | boxes with a z range, and slanted bars (struts); see [obstacles](#obstacles). `solidToRobot: true` makes [`STRUCTURE`](checks-and-findings.md#structure) check them. |
| `zones` | rectangles a rule talks about. `appliesInAuto: true` makes [`KEEPOUT`](checks-and-findings.md#keepout) check them. `ledger: "loadingZone"` makes the ledger count the pieces in it as that alliance's LOADING ZONE, where the human player enters pieces. |
| `elements` | game pieces and containers. The season plugin reads extra keys it put there. |
| `targets` | what the robot aims at. The season plugin reads extra keys it put there. |
| `startRules` | what [`START_ILLEGAL`](checks-and-findings.md#start_illegal) checks, and what the robot holds at the start |
| `rules.plugin` | the season plugin that tracks game state; see [Seasons](seasons.md) |

### Obstacles

An obstacle is one of two kinds, named by `kind`:

- `box`: an axis-aligned box, `minXIn`, `maxXIn`, `minYIn`, `maxYIn`, `minZIn` and `maxZIn`.
- `strut` (added in field format version 3): a straight bar between two points, such as a slanted
  leg of a hive frame. `fromIn` and `toIn` are the centres of its two end faces, each with `xIn`,
  `yIn` and `zIn` (the height above the tiles). `radiusIn` is the radius of a round envelope that
  holds the whole part. Canonical form writes its keys in the order `id`, `kind`, `fromIn`,
  `toIn`, `radiusIn`, `solidToRobot`, `provenance`.

```json
{
  "id": "frameLeg",
  "kind": "strut",
  "fromIn": { "xIn": 23.81, "yIn": 18.56, "zIn": 0.53 },
  "toIn": { "xIn": 12.74, "yIn": 0.51, "zIn": 41.09 },
  "radiusIn": 0.78,
  "solidToRobot": true,
  "provenance": "PLACEHOLDER: an example leg, not a measured one"
}
```

Both kinds take `solidToRobot` and `provenance`. What a strut blocks depends on how tall the robot
is: [`STRUCTURE`](checks-and-findings.md#structure) tests only the part below the robot's top, so
a slanted leg blocks more of the floor for a taller robot. A Zenith build older than field format
version 3 refuses a field file that declares version 3.

### Field image

An optional picture, added in field format version 2. It is only a picture: no check reads it, and
the vector geometry stays the truth. The BIOBUZZ field names none: the editor draws the whole field
from its geometry. A field file of your own can name a picture, for example a photo of your
practice field, and the editor then offers the picture, the picture with outlines, or the outlines
alone.

```json
"image": {
  "src": "img/practice-field.webp",
  "credit": "Photo by Horizon (FTC 36596)",
  "pxBoundsIn": { "left": 40, "top": 32, "right": 1040, "bottom": 1032 },
  "rotationDeg": 0,
  "provenance": "SET BY HAND: perimeter corners read off the photo"
}
```

| key | meaning |
|---|---|
| `src` | the picture, as a path relative to the field file or `app:<path>` for an image the app ships |
| `credit` | who made the image; shown wherever the image is |
| `pxBoundsIn` | `"fullBleed"` when the field wall is the image's edge, or `{ "left", "top", "right", "bottom" }` in image pixels |
| `rotationDeg` | `0`, `90`, `180` or `270`, clockwise as seen on screen. `0` when left out. |
| `variants` | optional other looks of the same picture, each `{ "name", "src" }` |
| `provenance` | optional: where the pixel box came from |

## `waypoints.json`

Named poses shared by every auto. An auto points at one with `{ "ref": "scoreSouth" }`. Change the
waypoint and every auto that uses it changes too, so you measure a pose on the field once.

This excerpt contains the three waypoints used by `first-auto`. The starter's other autos share
the same file and add their own waypoint names.

```json
{
  "$schema": "https://libraries.horizon36596.org/zenith/schema/v1/waypoints.json",
  "formatVersion": 1,
  "waypoints": {
    "start": { "xIn": -13, "yIn": -63, "headingRad": 1.5708, "provenance": "SET FROM EDITOR: starter example, against the south wall in RED's half, 4 in west of the centre line, facing the hive, so it drives straight north to scoreSouth; measure your own start tile" },
    "scoreSouth": { "xIn": -13, "yIn": -36, "headingRad": 1.5708, "provenance": "SET FROM EDITOR: starter example, south of the RED hive on x = -13, outside the legal approach margin, facing the up cell; 4 in clear of the centre line, so the robot can turn on the spot here without a corner crossing it" },
    "park": { "xIn": -40, "yIn": -36, "headingRad": 3.1416, "provenance": "PLACEHOLDER: starter example, an open spot in RED's half to finish in" }
  }
}
```

Each waypoint needs `xIn`, `yIn` and `headingRad`. `provenance` is optional but recommended. Poses
are for the RED alliance. A name the editor gives a waypoint starts with a letter and holds only
letters, digits, `_` and `-`, at most 64 characters; [step ids](#step-ids) follow the same rule.

## `*.auto.json`

One routine. The file name is `<name>.auto.json`. This is the starter example's
`first-auto.auto.json`; `collect-and-score.auto.json` beside it adds a curve, a marker, a parallel
group and a wait until a condition, and [Step kinds](step-kinds.md) shows each of those.

```json
{
  "$schema": "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
  "formatVersion": 4,
  "name": "first-auto",
  "title": "First auto",
  "description": "The smallest useful auto: drive out from the start tile, score the four preloaded pollen, and park. Three steps: a path, a command and another path. The getting-started guide walks through it.",
  "robot": "autos/robot.json",
  "field": "autos/field/biobuzz.field.json",
  "alliance": "RED",
  "authors": ["Horizon (FTC 36596)"],
  "created": "2026-09-23",
  "start": { "pose": { "ref": "start" }, "holds": { "pollen": 4 } },
  "steps": [
    {
      "id": "driveOut",
      "kind": "path",
      "segments": [
        { "kind": "line", "from": { "ref": "start" }, "to": { "ref": "scoreSouth" } }
      ],
      "heading": { "mode": "tangent" },
      "notes": "A straight line north to the scoring spot. Tangent heading keeps the front of the robot pointing the way it drives."
    },
    {
      "id": "scorePreload",
      "kind": "command",
      "name": "score",
      "args": { "count": 4 },
      "notes": "Launches the four preloaded pollen. score is stationary in robot.json, so it runs as its own step while the robot stands still."
    },
    {
      "id": "park",
      "kind": "path",
      "segments": [
        { "kind": "line", "from": "current", "to": { "ref": "park" } }
      ],
      "heading": { "mode": "tangent" },
      "notes": "from current starts where the last step ended, so the park leg follows on from wherever the robot scored."
    }
  ]
}
```

### Top-level keys

| key | required | meaning |
|---|---|---|
| `name` | yes | the routine's id; matches the file name |
| `title`, `description` | no | for people; shown in the editor |
| `robot`, `field` | no | paths to the robot and field files, when they differ from `zenith.json` |
| `alliance` | yes | `RED` or `BLUE`: which alliance the file's poses are written for |
| `authors`, `created` | no | who wrote it and when |
| `start` | yes | `pose` (a waypoint `ref` or an inline pose) and `holds`, what the robot carries at the start |
| `steps` | yes | the steps, at least one; see [Step kinds](step-kinds.md) |

### Step ids

A step's `id` is optional. When a step has one, it follows the same rule as a waypoint's name: it
starts with a letter and holds only letters, digits, `_` and `-`, at most 64 characters, for example
`driveOut`, `score_preload` or `park-2`. The editor, `zenith.edit.addStep`, `zenith.edit.insertAfter`,
`zenith.edit.renameStep` and the Inspector's id field refuse any other id and say why. A file written before the rule, with an id such as
`shoot preload`, still loads; `zenith validate` and the editor give it a
[`STEP_ID`](checks-and-findings.md#step_id) warning with a one-click rename that also updates the
`deadline` of a parallel group that named it. A step without an `id` goes by its place, `step3` or
`park.2`, and that positional id is not subject to the rule.

### Segments

In the editor a `path` step is a **path chain** and each of its `segments` is a **path** (Path 1, Path 2, …). Only the editor's words changed: the file keys, the MCP tool names and the generated Java keep "segment".

| kind | fields | notes |
|---|---|---|
| `line` | `from`, `to` | a straight line |
| `bezier` | `from`, `control[]`, `to` | a curve with one to three control points |

`from` and `to` are an inline pose, a waypoint `{ "ref": name }`, or the string `"current"`, the pose
the previous step ended at. The runtime reads `"current"` from the follower when the step starts;
the planner takes it from the previous step's end. Segments in one path must meet within 0.5 in.
A later segment's `from` may be `"current"` too: there it is the pose the segment before it ended
at, so the two cannot come apart. The editor writes it that way when it adds or removes a path in
a chain.

### Heading modes

| mode | editor label | Pedro call | fields | the robot faces | use it when |
|---|---|---|---|---|---|
| `tangent` | Tangent | `path.tangent()` | | along the direction of travel | the default on mecanum: nose first, front intake leading |
| `tangentReversed` | Reverse tangent | `path.reverseTangent()` | | opposite the direction of travel | a back mechanism should lead |
| `constant` | Constant | `path.constant(heading)` | `headingRad` | one fixed heading | a short, deliberate strafe, such as a sweep along a wall |
| `linear` | Linear | `path.linear(start, end)` | `fromRad`, `toRad` | turning steadily from one heading to the other | the robot must turn during the leg |
| `facePoint` | Facing point | `path.facingPoint(point)` | `xIn`, `yIn`, `offsetRad?` | toward a point on the field | a camera or launcher should stay on a target while moving |
| `piecewise` | Piecewise | `Interpolator.piecewise().until(t, ...)` | `ranges[]` | a different mode on each stretch of the path | hold a heading out of a wall, then turn to score, in one leg |

The editor labels are Pedro Pathing's own names for these heading interpolators, checked against the
Pedro build the robot runtime compiles against. The file keeps its own `mode` names.

For `linear`, the sweep is shared over the path's segments by length, and each segment's share turns
the short way round, as Pedro does. On a curve the share turns steadily in the curve's own
parameter rather than its length, as Pedro turns it, so the turn can run a little ahead of or
behind the halfway point; the editor, the estimate and the playback show it where the robot does it.
A share over half a turn goes the other way and raises the
[`HEADING`](checks-and-findings.md#heading) warning. The robot runtime ignores `facePoint`'s
`offsetRad` for now.

#### Piecewise heading

A `piecewise` heading splits the path into ranges of `t`, the fraction of the path's length from 0
at the start to 1 at the end, and gives each range its own mode:

```json
"heading": {
  "mode": "piecewise",
  "ranges": [
    { "startT": 0, "endT": 0.4, "heading": { "mode": "constant", "headingRad": 1.5708 } },
    { "startT": 0.4, "endT": 1, "heading": { "mode": "linear", "fromRad": 1.5708, "toRad": 3.1416 } }
  ]
}
```

| key | meaning |
|---|---|
| `ranges[]` | at least one range, in order along the path |
| `startT`, `endT` | where the range starts and ends, from 0 to 1; `t` has no unit and is not rounded |
| `heading` | the range's own mode: `tangent`, `tangentReversed`, `constant`, `linear` or `facePoint`, with that mode's fields; never `piecewise` |

- The ranges must cover the whole path: the first starts at 0, each starts where the one before it
  ends, and the last ends at 1. A gap, an overlap or a range that does not end after it starts is a
  [`HEADING_RANGES`](checks-and-findings.md#heading_ranges) error, because Pedro stops the auto on
  the robot when the ranges do not cover the path.
- A point on a boundary belongs to the range that ends there, as it does in Pedro.
- A `linear` range turns from `fromRad` at its start to `toRad` at its end, the short way round, over
  that range alone, and on a curve, like `linear`, steadily in the curve's own parameter. A range
  over half a turn raises the `HEADING` warning. `tangent`,
  `tangentReversed` and `facePoint` read the path wherever the range is.
- The robot runtime builds Pedro's `Interpolator.piecewise()` for each segment of the path, from the
  ranges that cross it.

### Markers

A marker fires a command part way along a path without stopping it. `at` is one of:

- `{ "t": 0.5 }`: a fraction of the whole path's length, from 0 to 1;
- `{ "distanceIn": 12 }`: inches from the start;
- `{ "distanceFromEndIn": 6 }`: inches before the end.

`command` is `{ "name": ..., "args": ... }`, like a command step. The runtime fires markers on
distance travelled, so the editor and the robot agree on where they happen.

### `expect`

Optional notes for the planner's ledger, on a `path` or `command` step. The robot ignores them.

| key | meaning |
|---|---|
| `collectFrom`, `count` | this step collects `count` pieces from the named container |
| `launchesInto` | this step launches into the named target, `count` pieces of them; a name that is not a target on the field raises [`LAUNCH_TARGET`](checks-and-findings.md#launch_target) |
| `tip` | `own` or `opponent`: this step tips a hive |

The ledger uses them to track what the robot holds and the season state after each step. `count`
is a launch count only on a step that launches: beside `launchesInto`, or on a command whose
registry entry has a `launches` hint, where it overrides the hint. Beside `collectFrom` alone it is
how many the step collects. A path's markers launch through their commands' own `launches` hints.

### Transfers

A `transfer` step (format version 4) tells the planner that game pieces move between two places at
this point in the routine, when nothing this robot does moves them: the alliance partner scoring
into your hive, the human player entering pieces through the loading zone, a tip spilling onto a
quarter of the floor.

```json
{ "id": "partnerScores", "kind": "transfer", "from": "partner", "to": "hiveRedUpCell", "expectedCount": 4, "actualCount": 0 }
```

| key | meaning |
|---|---|
| `from`, `to` | two places the season's ledger counts |
| `expectedCount` | how many pieces the routine is written for, a whole number |
| `actualCount` | optional: how many the ledger moves instead. Left out, it is `expectedCount` |
| `notes` | optional, for people |

`actualCount` is how a team previews an edge case without touching the routine: set it to 0 and the
ledger behaves as if the partner failed to score, so a branch on a condition that reads the ledger
takes its other side in the preview. The ledger moves at most what the source holds, and the
[`TRANSFER`](checks-and-findings.md#transfer) check says when it could not move them all.

The robot does nothing for a transfer. The runtime runs it as a wait of zero seconds, the estimate
gives it no time, and the generated Java carries it only as a comment, so editing either count never
changes the robot's code.

The BIOBUZZ places are `robot`, `partner` (it starts with the field's preload, `startRules.holds`),
each hive's `…UpCell` and `…DownCell`, `flower0` to `flower3`, the garden lines `gardenRed` and
`gardenBlue` (a source only), the four quarters of the floor `floorRedGardenSide`,
`floorRedLoadingSide`, `floorBlueGardenSide` and `floorBlueLoadingSide` (split at the field's centre
lines; each alliance's garden side is the quarter of its half its garden lies in), every zone marked
`ledger: "loadingZone"` by its own id (`loadingZoneRed`, `loadingZoneBlue`), `loose` for pieces
whose place is unknown, such as a tip's spill, `humanPlayerRed` and `humanPlayerBlue`, which bring
that alliance's nectar into its own loading zone and nowhere else, and `offField`, which is never
counted. `Own` and `Opponent` may stand in for `Red` and `Blue` in any of them. Mirroring a routine
for the other alliance swaps the colour in each place.

The BIOBUZZ ledger counts nectar and pollen apart in every place. A `from` that ends in `.nectar` or
`.pollen` (`robot.nectar`) moves only that kind; without one, pollen moves first. The same suffix
works on `expect.collectFrom` and on a condition's `quantity`. A human player brings in as many
nectar as the transfer says: no source gives the real limit.

### `envelope`

An envelope says where the robot stays while a step runs, when nobody can say exactly where it goes:
a command that drives the robot by itself, such as a vision collect, or a wait for a condition. It
is optional, it can go on a `path`, `command` or `wait` step, and the robot ignores it.

```json
"envelope": {
  "polygon": [
    { "xIn": -72, "yIn": -48 },
    { "xIn": -36, "yIn": -48 },
    { "xIn": -36, "yIn": -12 },
    { "xIn": -72, "yIn": -12 }
  ],
  "maxDurationS": 6,
  "provenance": "SET BY HAND: vision collect stays in the south-west quarter"
}
```

| key | meaning |
|---|---|
| `polygon` | 3 to 32 corners, `{ "xIn", "yIn" }` in field inches, in order round the outside |
| `maxDurationS` | the longest the step runs, in seconds: over 0 and at most 30 |
| `actualDurationS` | optional, a what-if: how long the step runs this time, in seconds, over 0 and at most `maxDurationS` |
| `provenance` | required: where the shape and the time came from, as a [provenance label](#provenance-labels) |

While the step runs, for at most `maxDurationS`, the robot's bounding box is declared to stay inside
the polygon.

- The polygon must be one simple shape. Edges that cross or fold back, corners that all lie on one
  line, or fewer than three distinct corners raise the
  [`ENVELOPE_SHAPE`](checks-and-findings.md#envelope_shape) error.
- A command or wait with no estimate of its own, such as a command whose `estimateS` is `"unknown"`
  or a wait on `until`, is timed by `maxDurationS` instead of being hatched on the timeline. A step
  that has its own estimate keeps it.
- `actualDurationS` previews a run that finishes sooner than the window, or fails early. Where the
  window times the step (the estimate, the timeline, the Ideal playback and the Instant sim), the
  planner uses it instead of `maxDurationS`. A partner's projection keeps
  `maxDurationS`, the promise. A value longer than `maxDurationS` is refused, saying so. Leave it
  out for a run of the whole window. The robot ignores it.
- A `sequence`, `parallel` or `branch` cannot carry an envelope; put it on the step inside.
- In the file it comes after `expect` (on a `wait`, after `timeoutS`) and before `notes`.

In the editor, select the step and use its Envelope section, or drag the envelope's corners on the
field.

### `rejoinFrom`

After a command that `robot.json` marks `movesRobot`, nobody knows exactly where the robot is, so the
next path starts from `"current"` and the planner cannot draw it. `rejoinFrom` tells the planner
where to assume the robot is when that path starts. It is optional and goes on a `path` step.

```json
{
  "id": "backToScore",
  "kind": "path",
  "rejoinFrom": { "xIn": -48, "yIn": -30, "headingRad": 1.5708, "provenance": "SET BY HAND: the collect ends near here" },
  "segments": [ { "kind": "line", "from": "current", "to": { "ref": "scoreSouth" } } ],
  "heading": { "mode": "tangent" }
}
```

| key | meaning |
|---|---|
| `xIn`, `yIn`, `headingRad` | the pose the planner starts the path from, in field inches and radians |
| `provenance` | optional: where the pose came from |

- It is used only when the path's first segment starts from `"current"` and the last step before
  it that moves the robot is a `movesRobot` command (or a `sequence` that ends in one). Steps that
  hold the robot still may come between them: a `wait`, a `transfer` or a command that does not
  drive. For example, a `movesRobot` command, then a 1 s `wait`, then the path still uses it. The
  planner then starts the path at this pose and takes it as where that command, and the steps that
  held still after it, end.
- Anywhere else it is not used, and the [`MOVES_ROBOT`](checks-and-findings.md#moves_robot) warning
  says so.
- The robot ignores it: on the robot, `"current"` is always the follower's own pose.
- In the file it comes after `timeoutS` and before `segments`.

`envelope` and `rejoinFrom` are optional additions, so adding them did not change the format
version, and nor did `actualDurationS` inside `envelope`: an older reader never meets it.

## `*.projection.json`

A projection is what another team receives when you give it a share file of an auto: a summary of
the routine made on your own computer, never the auto file. The editor's **Download share file**,
[`zenith projection`](cli-reference.md#zenith-projection) and the MCP server's `zenith.projection`
make one, all byte for byte the same, and so does the Share dialog. A partner loads it in the Partners
panel or passes it to [`zenith alliance`](cli-reference.md#zenith-alliance). A downloaded one is
named `<auto>.<level>.projection.json`. What the sharing settings mean is in
[Teams and sharing](teams-and-sharing.md#what-the-other-team-gets).

A projection is built from an allowlist: each key below is copied into a new object from the one
place that should supply it, so a key added to the auto format later can never leak into a
projection by default. It is read from another team, so it is **strict**, unlike the files a team
writes for itself: an unknown key at any depth is refused rather than dropped, every list and every
string has a limit, and `$schema` is required. This is the starter example's `first-auto` shared at
the view level with a title and with command names included, cut to its first three trajectory rows
(the full projection has 53). Its timing comes from the instant model, not a recorded robot run:

```json
{
  "$schema": "https://libraries.horizon36596.org/zenith/schema/v1/projection.json",
  "formatVersion": 1,
  "kind": "projection",
  "level": "view",
  "season": "biobuzz",
  "alliance": "RED",
  "title": "Horizon first auto",
  "startPose": { "xIn": -13, "yIn": -63, "headingRad": 1.5708 },
  "boundingBox": { "lengthIn": 18, "widthIn": 18, "centreOffsetIn": { "xIn": 0, "yIn": 0 } },
  "trajectory": {
    "rateHz": 10,
    "positionQuantumIn": 0.5,
    "headingQuantumRad": 0.0175,
    "poses": [[-13, -63, 1.5708], [-13, -62.5, 1.5708], [-13, -61, 1.5708]]
  },
  "phases": [
    { "startS": 0, "endS": 1.14, "label": "drive" },
    { "startS": 1.14, "endS": 3.64, "label": "score" },
    { "startS": 3.64, "endS": 5.29, "label": "park" }
  ],
  "claims": [{ "elementId": "hiveRedUpCell", "action": "score", "atS": 1.14 }],
  "envelopes": [],
  "totalS": 5.29,
  "commands": [
    { "token": "cmd1", "kind": "command", "name": "score", "args": { "count": 4 }, "startS": 1.14, "endS": 3.64 }
  ]
}
```

The example is written compactly to fit; in canonical form each trajectory row is written one number
to a line, like every other array.

Regenerate the complete projection from the starter project directory with a matching CLI build:

```powershell
zenith projection first-auto --level view --title "Horizon first auto" --include-commands
```

### Top-level keys

| key | required | meaning |
|---|---|---|
| `$schema` | yes | exactly `https://libraries.horizon36596.org/zenith/schema/v1/projection.json` |
| `formatVersion` | yes | `1` |
| `kind` | yes | `"projection"` |
| `level` | yes | `view` or `propose`: how much the other team sees |
| `season` | yes | the season id the field file names, such as `biobuzz`; 1 to 200 characters |
| `alliance` | yes | `RED` or `BLUE`: the alliance the poses are written for. A partner on the other alliance mirrors them with the field's own mirror. |
| `title` | no | the title the other team sees, 1 to 200 characters. Only there when the sharer typed one; the auto's own `title` is never copied. |
| `startPose` | yes | `xIn`, `yIn`, `headingRad`: the start pose, rounded like the trajectory |
| `boundingBox` | yes | one box around the whole robot; see below |
| `trajectory` | yes | where the robot is over time; see below |
| `phases` | yes | up to 200 time windows, each labelled from a fixed list |
| `claims` | yes | up to 200 field elements the auto takes from or scores into |
| `envelopes` | yes | up to 50 areas the robot stays inside for a time window |
| `totalS` | yes | the length of the run in the instant sim, in seconds, zero or more |
| `structure` | no | the steps, at the `propose` level only; see [The structure](#the-structure) |
| `commands` | no | what each command token stands for, only when the sharer ticked **Include command names**; see [Command names](#command-names) |

Every pose is in the season's frame, which for every shipped season is the field file's own
[frame](#the-field-frame), in inches and radians.

### `boundingBox`, `trajectory`, `phases`, `claims` and `envelopes`

| key | meaning |
|---|---|
| `boundingBox.lengthIn`, `widthIn` | the size of one axis-aligned box in the robot frame, over 0: the union of the robot's expanded footprint and every intake mouth, with no mouth layout. It is rounded outward to 0.5 in, even when the rest is coarsened. |
| `boundingBox.centreOffsetIn` | `xIn`, `yIn`: where the box's centre sits from the point the path follows, in the robot frame |
| `trajectory.rateHz` | always `10`: one row every 0.1 s |
| `trajectory.positionQuantumIn` | what positions are rounded to, in inches: `0.5`, or `2` when coarsened |
| `trajectory.headingQuantumRad` | what headings are rounded to, in radians: one degree (`0.0175`), or five degrees (`0.0873`) when coarsened |
| `trajectory.poses` | 1 to 3000 rows (300 s), each `[xIn, yIn, headingRad]`, from t = 0 to the end of the run |
| `phases[]` | `startS`, `endS` (not before `startS`) and `label`: one of `drive`, `score`, `collect`, `wait`, `park` or `other`. Neighbouring steps with the same label are joined. |
| `claims[]` | `elementId`, an element, container, target or zone id from the public field file (or the start of an element id, for a row of them); `action`, `take` or `score`; `atS`, when the step that does it starts |
| `envelopes[]` | `startS`, `endS` and `polygon`, 3 to 200 corners `{ "xIn", "yIn" }`: a step's [`envelope`](#envelope), from when the step starts for its `maxDurationS` (never its what-if `actualDurationS`), rounded outward. Its provenance is not carried. |

Times are rounded to the millisecond, or to 0.25 s when coarsened. A phase is `score` when a launch
happens in it and `collect` when a collection does, both from the ledger; otherwise a wait is `wait`,
a step that drives is `drive`, and anything else is `other`. The last drive becomes `park` when its
step's id says park and nothing after it drives, scores or collects.

### The structure

At the `propose` level, `structure` is `{ "steps": [...] }`: the auto's steps with every waypoint
and `"current"` resolved to a literal pose, so the other team can [propose changes](#proposaljson).
Poses in it are not coarsened, because a proposal edits the real poses.

- **Steps are named `s1` to `sN`**, depth first, a group before its members and a branch's `then`
  arm before its `else` arm. Your own step ids are never sent; your app maps these back.
- **Every command is a token**, `cmd1`, `cmd2` and on, counted in step order, and every condition is
  `{ "token": "cond1" }` and on, counted apart. Neither says what it stands for.
- Every list in it holds at most 200 entries, and steps nest at most 32 levels deep (a top-level
  step is level 1). A deeper projection is refused before it is read.

| kind | keys |
|---|---|
| `path` | `id`; `timeoutS`, over 0, optional; `segments`, 1 or more `line` (`from`, `to`) or `bezier` (`from`, 1 to 3 `control` points, `to`) segments, every pose literal; `heading`, optional, any [heading mode](#heading-modes); `speedFraction`, over 0 and at most 1, optional; `markers`, optional, each `{ "at", "token" }` with `at` as on an auto's [marker](#markers); `endCondition`, a condition token, optional |
| `command` | `id`; `token`; `estimateS`, the seconds `robot.json` estimates for this call, or `null` when it is unknown; `stationary` and `movesRobot`, the command's two flags from `robot.json`; `timeoutS`, optional |
| `wait` | `id`; `seconds`, zero or more, or `until`, a condition token; `timeoutS`, optional |
| `sequence` | `id`; `steps` |
| `parallel` | `id`; `mode`, `all`, `race` or `deadline`; `deadline`, the opaque id of the member that ends the group, optional; `steps` |
| `branch` | `id`; `condition`, a condition token; `then`; `else`, optional |

### Command names

`commands` is there only when the sharer ticks **Include command names**, which is off by default, at either level. It
names what each command token stands for and nothing else: one entry per command token, in token
order. A projection without it is byte for byte what it would be if the option did not exist, and
condition tokens are never named.

| key | required | meaning |
|---|---|---|
| `token` | yes | the command token, `cmd1` and on |
| `kind` | yes | `command` for a command step, `marker` for a marker on a path |
| `name` | yes | the command's name as the auto calls it, 1 to 200 characters |
| `args` | no | the arguments exactly as the auto passes them, at most 200, each a string of up to 200 characters, a number or `true`/`false`; absent when the call has none |
| `startS`, `endS` | no | the span of the step the token belongs to in the instant sim: a command step's own run, or the whole path a marker fires on. Both or neither; absent for a step that did not run, such as one in a branch arm the sim did not take. |

At most 1000 entries. Nothing from `robot.json`'s command table is carried: no summary, no
parameter table, no estimate formula, no code.

### What a projection leaves out

A projection **never** holds:

- Java or any generated code;
- `robot.json`: its kinematics, measured constants, follower gains, provenance and mouth layout.
  Only the bounding box, each command's estimated time and its two flags come from it;
- condition names, at any level;
- command names and arguments, unless the sharer includes them in `commands`;
- the author's step ids, waypoint names, notes, the description, authors and dates;
- the auto's own title, unless the sharer types one;
- file paths, `zenith.json` or the repository's name.

It still shows how fast the robot drives and in what order it scores, which is what a partner
needs and what anyone watching a match sees. **Coarsen** rounds the timed layer more.

## `*.proposal.json`

A proposal is the changes a team suggests to an auto another team shared with it at the `propose`
level. The proposing team only ever holds the projection, so a proposal names every step by the
projection's opaque id (`s3`) and every command and condition by its token (`cmd2`, `cond1`), and it
has no way to name, add or change a command. The editor's **Save proposal…** writes one as
`<share>.proposal.json`, and
[`zenith proposal validate`](cli-reference.md#zenith-proposal-validate) and
[`zenith proposal apply`](cli-reference.md#zenith-proposal-apply) check and apply one. How the owning
team reviews it is in [Alliance partners](alliance-partners.md#proposals), and every way it can be
refused in [Proposal findings](checks-and-findings.md#proposal-findings).

Like a projection, it is strict: an unknown key at any depth is refused, every list and string has a
limit, and `$schema` is required.

```json
{
  "$schema": "https://libraries.horizon36596.org/zenith/schema/v1/proposal.json",
  "formatVersion": 1,
  "kind": "proposal",
  "shareRef": { "shareId": "k3f9x2Qm7TzL", "revision": 3 },
  "baseStructureHash": "sha256:913f927447d1b42cc2e8a9a5ead0ab93de5b04b26836be97a4182b380f6da7f5",
  "changes": [
    { "op": "insertWait", "afterStepId": "s1", "seconds": 0.5, "comment": "Let our robot cross in front of you first." },
    { "op": "movePose", "stepId": "s3", "segmentIndex": 0, "point": "to", "pose": { "xIn": -40, "yIn": -30 } },
    { "op": "setSpeedFraction", "stepId": "s3", "speedFraction": 0.8, "comment": "Slower on the way to park." }
  ]
}
```

### Top-level keys

| key | required | meaning |
|---|---|---|
| `$schema` | yes | exactly `https://libraries.horizon36596.org/zenith/schema/v1/proposal.json` |
| `formatVersion` | yes | `1` |
| `kind` | yes | `"proposal"` |
| `shareRef` | yes | `shareId`, the share's id, 1 to 200 letters, digits, `_` or `-`; and `revision`, a whole number zero or more, the version of the auto the share was made from |
| `baseStructureHash` | yes | `sha256:` and 64 lowercase hex digits: the SHA-256 of the projection's `structure` it was made against, so a proposal against an older version is refused as a whole |
| `changes` | yes | up to 200 changes, applied in order |

Whether the share is live, revoked or expired is not in any file: the team library knows it.

### Changes

Each change has an `op` from the closed list below, and an optional `comment`, one line of 1 to 200
characters. `stepId` is an opaque id from the projection. Indexes count from 0.

| `op` | keys | does |
|---|---|---|
| `movePose` | `stepId`, `segmentIndex`, `point`, `pose` | moves one point of a path's segment: `point` is `"from"`, `"to"` or `{ "controlIndex": n }` for a Bézier control point. `pose` is `xIn`, `yIn` and an optional `headingRad`; left out, the heading stays as it was, and a control point takes only `xIn` and `yIn`. |
| `setHeading` | `stepId`, `heading` | gives a path a new [heading mode](#heading-modes) |
| `setSpeedFraction` | `stepId`, `speedFraction` | sets a path's speed fraction, over 0 and at most 1 |
| `setTimeout` | `stepId`, `timeoutS` | sets a path, command or wait step's timeout, in seconds over 0, or removes it with `null` |
| `insertWait` | `afterStepId` or `atStart: true`; `seconds` or `until` | adds a wait straight after a step, in the list that holds it, or at the start of the auto. It waits `seconds`, zero or more, or `until` a condition token the share holds; exactly one of each pair. |
| `setWait` | `stepId`; `seconds` or `until` | changes what a wait step waits for; exactly one of the two |
| `removeStep` | `stepId` | removes a path or wait step. A command, a group, a parallel group's deadline or the only step of a group cannot be removed. |
| `addPath` | `afterStepId` or `atStart: true`; `segments`, `heading`; optional `timeoutS`, `speedFraction`, `markers`, `endCondition` | adds a path step, placed like an inserted wait, with every pose literal as in the structure. Its markers and end condition can only use tokens the share holds and that the rest of the proposal frees, so a token is moved, never copied. |
| `reorder` | `stepId`, `newIndex` | moves a step to `newIndex` in the list that holds it, counted after it is taken out |
| `moveMarker` | `stepId`, `markerIndex`, `at` | slides one marker of a path to a new `at`, as on an auto's [marker](#markers) |
| `setEnvelope` | `stepId`, `envelope` | gives a path, command or wait step an [`envelope`](#envelope) (`polygon` of 3 to 32 corners, `maxDurationS` over 0 and at most 30, an optional `actualDurationS` over 0 and at most `maxDurationS`, `provenance` of 1 to 200 characters), or removes it with `null` |

A step the proposal adds gets the next opaque id after the share's highest (`s13`, `s14`, ...), in
the order the changes add them, so a later change can name it. A token must end up held exactly once:
a change that holds a token the share did not hold, or copies one, is refused. Applied poses carry no
provenance, exactly like a hand edit, so they read as `SET FROM EDITOR`.
