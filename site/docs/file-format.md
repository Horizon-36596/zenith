# File format reference

Zenith keeps everything in plain JSON files inside your robot repository. Five kinds of file:

| file | what it holds | current `formatVersion` | JSON Schema |
|---|---|---|---|
| `zenith.json` | the link file: where everything else lives, how to run the sim | 1 | [`link.json`](https://libraries.horizon36596.org/zenith/schema/v1/link.json) |
| `robot.json` | one robot: footprint, speeds, intake mouths, commands, conditions | 1 | [`robot.json`](https://libraries.horizon36596.org/zenith/schema/v1/robot.json) |
| `*.field.json` | one season's field: walls, obstacles, zones, game elements, start rules | 2 | [`field.json`](https://libraries.horizon36596.org/zenith/schema/v1/field.json) |
| `waypoints.json` | named poses shared by every auto | 1 | [`waypoints.json`](https://libraries.horizon36596.org/zenith/schema/v1/waypoints.json) |
| `*.auto.json` | one autonomous routine | 3 | [`auto.json`](https://libraries.horizon36596.org/zenith/schema/v1/auto.json) |

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

Autos are written for the **RED** alliance, which is the canonical alliance. Zenith produces the
BLUE version by mirroring. For BIOBUZZ the mirror is a **point symmetry** through the field centre:
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
number with no label is treated as `NEEDS MEASUREMENT`.

## Format versions and migration

Every file carries a `formatVersion`. Each kind of file is versioned on its own, and the version
goes up only for a change that breaks older readers.

| file | current | history |
|---|---|---|
| `*.auto.json` | 3 | 2 added the [`sequence`](step-kinds.md#sequence) step. 3 added the [`piecewise`](#piecewise-heading) heading mode. |
| `*.field.json` | 2 | 2 added the optional [`image`](#field-image). |
| `robot.json` | 1 | unchanged |
| `waypoints.json` | 1 | unchanged |
| `zenith.json` | 1 | unchanged |

- Zenith **loads older versions** and migrates them in memory. The editor, the CLI and the MCP
  server all do this.
- Zenith **always writes the current version**. A version 1 or 2 auto comes back from its first save
  as version 3, and otherwise unchanged.
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

Put the URL in a file's `$schema` key and editors such as VS Code will complete and check it as you
type. `$schema` is optional when reading; Zenith writes it on every save. The same schemas ship in
the `@horizon36596/zenith-schema` npm package, with TypeScript types.

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
| `deploy` | no | where `zenith deploy` copies autos. `kind` is `androidAssets` (the runtime reads them from the APK's assets) or `directory`. `commandLibrary` is `ivy` or `solverslib`: which runtime the generated OpModes and `zenith codegen` classes use ([Choosing a command library](command-libraries.md)). It has no default, and `zenith deploy`, `zenith codegen` and the desktop app's Deploy refuse to write Java until it is set; the schema accepts a file without it, so an older `zenith.json` still opens and validates. `robotClass` is the robot class the generated OpModes build. |
| `sim` | no | how to run the [high-fidelity sim](simulation.md#high-fidelity-sim). `{auto}` is replaced with the auto's name. |
| `codegen` | no | the Java package and source folder `zenith codegen` writes to |

All paths are relative to the folder holding `zenith.json`.

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
      "summary": "Runs the front intake inward and keeps it running. The state parameter has one value and a default, so an auto calls intakeOn with no arguments; it tells Zenith's intake checks that this command runs the intake.",
      "params": { "state": { "type": "enum", "values": ["ON"], "default": "ON" } },
      "estimateS": "0",
      "requires": ["intake"],
      "stationary": false
    },
    {
      "name": "intakeOff",
      "summary": "Stops the front intake. Like intakeOn, it takes no arguments in an auto.",
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
:   The named conditions a `wait`, `branch` or `endCondition` may read. `ledger` is `"full"` or
    `"empty"` when the condition means "at capacity" or "holding nothing", so the preview sim can
    answer it from what the robot holds.

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
| `summary` | shown in the editor |
| `params` | the arguments, each with a `type`: `integer`, `number` (with optional `min`, `max`, `default`), `enum` (with `values`), `boolean` or `string` |
| `estimateS` | how long it takes: an expression over the params using numbers, `+ - * /`, `max` and `min`, or `"unknown"` |
| `requires` | the subsystems it uses |
| `stationary` | `true` if the robot must stand still; a marker firing it raises [`STATIONARY_MARKER`](checks-and-findings.md#stationary_marker) |
| `movesRobot` | `true` if it drives the robot by itself; the next path must start from `"current"` |
| `ledger` | how it changes what the robot holds, such as `{ "launches": "count" }` |

An `estimateS` of `"unknown"` draws a hatched block in the timeline, and the routine's total becomes a
lower bound.

## `*.field.json`

One season's field, as vector geometry in the field frame. Zenith ships the BIOBUZZ field. Copy it
into your repository so you can correct measurements locally.

This is the BIOBUZZ field from the starter example, shortened to one obstacle, one zone, two
elements (a pollen in the RED garden and a flower) and one target. The shipped file has them all.

```json
{
  "$schema": "https://libraries.horizon36596.org/zenith/schema/v1/field.json",
  "formatVersion": 2,
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
  "image": {
    "src": "app:fields/biobuzz/biobuzz-dark.webp",
    "credit": "Field image by Team Juice 16236",
    "pxBoundsIn": "fullBleed",
    "rotationDeg": 90,
    "variants": [{ "name": "dark", "src": "app:fields/biobuzz/biobuzz-dark.webp" }, { "name": "black", "src": "app:fields/biobuzz/biobuzz-black.webp" }, { "name": "light", "src": "app:fields/biobuzz/biobuzz-light.webp" }],
    "provenance": "SET BY HAND 2026-09-22: full bleed (1080 px spans 144 in, grid every 180 px = one tile) and a 90 degree clockwise turn, checked against the RED loading zone, the four flowers and hiveRed (apps/web/public/fields/biobuzz/SOURCE.md)"
  },
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
| `obstacles` | axis-aligned boxes with a z range. `solidToRobot: true` makes [`STRUCTURE`](checks-and-findings.md#structure) check them. |
| `zones` | rectangles a rule talks about. `appliesInAuto: true` makes [`KEEPOUT`](checks-and-findings.md#keepout) check them. |
| `elements` | game pieces and containers. The season plugin reads extra keys it put there. |
| `targets` | what the robot aims at. The season plugin reads extra keys it put there. |
| `startRules` | what [`START_ILLEGAL`](checks-and-findings.md#start_illegal) checks, and what the robot holds at the start |
| `rules.plugin` | the season plugin that tracks game state; see [Seasons](seasons.md) |

### Field image

An optional picture, added in field format version 2. It is only a picture: no check reads it, and
the vector geometry stays the truth.

| key | meaning |
|---|---|
| `src` | the picture, as a path relative to the field file or `app:<path>` for an image the app ships |
| `credit` | who made the image; shown wherever the image is |
| `pxBoundsIn` | `"fullBleed"` when the field wall is the image's edge, or `{ "left", "top", "right", "bottom" }` in image pixels |
| `rotationDeg` | `0`, `90`, `180` or `270`, clockwise as seen on screen. `0` when left out. |
| `variants` | optional other looks of the same picture, each `{ "name", "src" }` |
| `provenance` | optional: where the pixel box came from |

The BIOBUZZ field images are by Team Juice 16236.

## `waypoints.json`

Named poses shared by every auto. An auto points at one with `{ "ref": "scoreSouth" }`. Change the
waypoint and every auto that uses it changes too, so you measure a pose on the field once.

```json
{
  "$schema": "https://libraries.horizon36596.org/zenith/schema/v1/waypoints.json",
  "formatVersion": 1,
  "waypoints": {
    "start": { "xIn": -12, "yIn": -63, "headingRad": 1.5708, "provenance": "PLACEHOLDER: starter example, against the south wall in RED's half, facing the hive; measure your own start tile" },
    "scoreSouth": { "xIn": -12, "yIn": -36, "headingRad": 1.5708, "provenance": "PLACEHOLDER: starter example, south of the RED hive, outside the legal approach margin, facing the up cell" },
    "gardenApproach": { "xIn": -61, "yIn": -44, "headingRad": -1.5708, "provenance": "PLACEHOLDER: starter example, above the RED garden row, intake facing the south wall" },
    "gardenPickup": { "xIn": -61, "yIn": -62, "headingRad": -1.5708, "provenance": "PLACEHOLDER: starter example, the intake over the RED garden row, frame 1 in off the south wall" },
    "park": { "xIn": -40, "yIn": -36, "headingRad": 3.1416, "provenance": "PLACEHOLDER: starter example, an open spot in RED's half to finish in" }
  }
}
```

Each waypoint needs `xIn`, `yIn` and `headingRad`. `provenance` is optional but recommended. Poses
are for the RED alliance.

## `*.auto.json`

One routine. The file name is `<name>.auto.json`. This is the starter example's
`first-auto.auto.json`; `collect-and-score.auto.json` beside it adds a curve, a marker, a parallel
group and a wait until a condition, and [Step kinds](step-kinds.md) shows each of those.

```json
{
  "$schema": "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
  "formatVersion": 3,
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

### Segments

| kind | fields | notes |
|---|---|---|
| `line` | `from`, `to` | a straight line |
| `bezier` | `from`, `control[]`, `to` | a curve with one to three control points |

`from` and `to` are an inline pose, a waypoint `{ "ref": name }`, or the string `"current"`, the pose
the previous step ended at. The runtime reads `"current"` from the follower when the step starts;
the planner takes it from the previous step's end. Segments in one path must meet within 0.5 in.

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
the short way round, as Pedro does. A share over half a turn goes the other way and raises the
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
  that range alone. A range over half a turn raises the `HEADING` warning. `tangent`,
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
| `launchesInto` | this step launches into the named target |
| `tip` | `own` or `opponent`: this step tips a hive |

The ledger uses them to track what the robot holds and the season state after each step.
