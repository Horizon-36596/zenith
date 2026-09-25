# Step kinds

An auto is a list of steps in `steps[]`. The robot runs them one after another, and the routine ends
when the last one does. There are six kinds of step:

| kind | what it does | fields | runs on the robot as |
|---|---|---|---|
| `path` | drives a path | `segments[]`, `heading`, `speedFraction`, `markers[]`, `endCondition?`, `timeoutS?`, `notes?` | `FollowPath`, with markers and an optional interrupt |
| `command` | runs one named robot command | `name`, `args`, `timeoutS?` | `NamedCommands.build(name, args)` |
| `wait` | waits for a time or a condition | `seconds` or `until`, `timeoutS?` | `WaitRobotTime` / `WaitUntilCommand` |
| `sequence` | runs a list of steps one after another | `steps[]` (at least one), `notes?` | `SequentialCommandGroup` |
| `parallel` | runs steps at the same time | `mode` (`all`, `race` or `deadline`), `deadline?`, `steps[]` | the runtime's `Parallel.all` / `Parallel.race` / `Parallel.deadline` |
| `branch` | picks one of two lists by a condition | `condition`, `then[]`, `else[]` | `ConditionalCommand` |

Every step may also carry an `id`. The editor always gives a new step one. Ids are how findings,
the timeline, traces and a `parallel` group's `deadline` point at a step, so keep them short and
descriptive: `driveOut`, `scorePreload`, `park`.

A step without an `id` is addressed by position: `step3` is the third top-level step,
`returnToScore.2` is the second child of the group `returnToScore`, and `checkPollen.1.1` /
`checkPollen.2.1` are the first steps of a branch's `then` and `else` lists.

The examples on this page come from the starter example in `examples/starter`: a plain mecanum
robot with one front intake and a fixed launcher, on the BIOBUZZ field. `all-step-kinds.auto.json`
there uses every kind on this page. Its `robot.json` registers these commands and conditions:

| name | kind | notes |
|---|---|---|
| `intakeOn` | command | Runs the front intake and keeps it running. Takes no time. |
| `intakeOff` | command | Stops the front intake. Takes no time. |
| `spinUp` | command | Brings the launcher up to speed. About 0.5 s. |
| `score` | command | `count`: 1 to 4, default 1. Launches `count` pollen. `stationary: true`. |
| `holdingPiece` | condition | True when at least one pollen is aboard. |
| `hopperFull` | condition | True when the robot holds four pollen, its capacity. |
| `hopperEmpty` | condition | True when the robot holds nothing. |

See the [file format reference](file-format.md#robotjson) for the full robot file.

## `path`

Drives the robot along one or more connected segments. Use it for every move across the field.

The first step of `first-auto.auto.json`:

```json
{
  "id": "driveOut",
  "kind": "path",
  "segments": [
    { "kind": "line", "from": { "ref": "start" }, "to": { "ref": "scoreSouth" } }
  ],
  "heading": { "mode": "tangent" },
  "notes": "A straight line north to the scoring spot. Tangent heading keeps the front of the robot pointing the way it drives."
}
```

What the fields do:

`segments`
:   One or more `line` or `bezier` segments. A `line` has `from` and `to`. A `bezier` has `from`,
    one to three `control` points, and `to`. Each segment must start where the previous one ended,
    within 0.5 in.

`from` and `to`
:   An inline pose (`{ "xIn": ..., "yIn": ..., "headingRad": ... }`), a named waypoint
    (`{ "ref": "scoreSouth" }`), or, for `from` only in practice, the string `"current"`: wherever
    the previous step left the robot.

`heading`
:   Which way the robot faces while it drives. Required: a path without one is a
    [`HEADING_MISSING`](checks-and-findings.md#heading_missing) error. The modes are `tangent`,
    `tangentReversed`, `constant`, `linear` and `facePoint`; see
    [heading modes](file-format.md#heading-modes).

`speedFraction`
:   The fraction of top speed to drive at, above 0 and at most 1. Left out, the robot's
    `defaultPathSpeedFraction` applies.

`markers`
:   Commands that fire part way along the path without stopping it. `at` is `{ "t": 0.5 }` (a
    fraction of the whole path), `{ "distanceIn": 12 }` or `{ "distanceFromEndIn": 6 }`.

`endCondition`
:   `{ "condition": "hopperFull" }` ends the path early when the condition reads true.

`timeoutS`
:   Ends the step after this many seconds, even if the robot has not arrived.

`expect`
:   Planner-only notes for the ledger, such as `{ "collectFrom": "gardenRed", "count": 4 }`. The
    robot ignores them.

A path with a marker that turns the intake on as the path starts, and an end condition that ends
the path once the robot is full. This is `sweepGarden` from `collect-and-score.auto.json`: a slow
drive onto the RED garden row, holding the intake toward the south wall.

```json
{
  "id": "sweepGarden",
  "kind": "path",
  "segments": [
    { "kind": "line", "from": "current", "to": { "ref": "gardenPickup" } }
  ],
  "heading": { "mode": "constant", "headingRad": -1.5708 },
  "speedFraction": 0.3,
  "markers": [
    { "at": { "t": 0 }, "command": { "name": "intakeOn" } }
  ],
  "endCondition": { "condition": "hopperFull" },
  "expect": { "collectFrom": "gardenRed", "count": 4 }
}
```

!!! tip "Use `\"current\"` after anything that can end in more than one place"
    A path that ends on a condition, or a command marked `movesRobot`, leaves the robot somewhere
    the planner cannot pin down. Start the next path with `"from": "current"` so it begins wherever
    the robot really is.

## `command`

Runs one command the robot registered by name. Use it for anything that is not driving: launching,
setting a mechanism, resetting a sensor.

```json
{ "id": "stopIntake", "kind": "command", "name": "intakeOff" }
```

With arguments, from `first-auto.auto.json`:

```json
{ "id": "scorePreload", "kind": "command", "name": "score", "args": { "count": 4 } }
```

`intakeOn` and `intakeOff` each declare one `state` parameter with a single value and a default,
so an auto calls them with no `args`, and the intake checks still know they run and stop the
intake.

`name` must be one of the commands in `robot.json`, and the same name must be registered with
`NamedCommands` in your robot code. `args` are checked against the command's `params`. An unknown
name or a bad argument is a [`SCHEMA`](checks-and-findings.md#schema) error.

The timeline takes the command's time from its `estimateS` in `robot.json`. A command whose estimate
is `"unknown"` draws as a hatched block, and the routine's total becomes a lower bound.

## `wait`

Pauses the routine. Give it either `seconds` or `until`, never both.

```json
{ "id": "pause", "kind": "wait", "seconds": 0.25 }
```

```json
{ "id": "waitForFull", "kind": "wait", "until": "hopperFull", "timeoutS": 1 }
```

Use `seconds` to let a mechanism finish when it has no sensor to say so. Use `until` with a
condition from `robot.json` when there is one, and give it a `timeoutS` so a sensor that never
fires does not stall the auto.

## `sequence`

Runs its steps one after another and ends when the last one does. It is the same as the top-level
list, packed into one step. `sequence` was added in auto format version 2.

```json
{
  "id": "clearThenSpinUp",
  "kind": "sequence",
  "steps": [
    { "id": "clearGarden", "kind": "wait", "seconds": 0.5 },
    { "id": "readyLauncher", "kind": "command", "name": "spinUp" }
  ]
}
```

At the top level a sequence changes nothing about what the robot does. Its point is grouping.
A `parallel` group runs each of its members side by side; without `sequence`, "wait half a second,
then spin up" would be two members running at once. Wrapped in a sequence, it is one member that
runs in order while the rest of the group runs beside it. The [`deadline`](#deadline-spin-up-on-the-way-back)
example below does exactly that.

A sequence can go anywhere a step can: at the top level, inside a `parallel` group, in a branch
arm, or inside another sequence.

Inside a sequence, poses chain the same way they do at the top level. `"from": "current"` in its
second step is where its first step ended, and the sequence ends where its last step ended.

For time, a sequence costs the sum of its steps, with the robot's speed carried through from one
step to the next.

## `parallel`

Runs its steps at the same time. `mode` decides when the group ends.

| mode | ends when | estimated time |
|---|---|---|
| `all` | every member has finished | the longest member |
| `race` | the first member finishes; the rest are stopped | the shortest member |
| `deadline` | the member named by `deadline` finishes; the rest are stopped | the deadline member |

Every member of a parallel group starts from the pose the group started at. Only one member
should drive; two paths in one group would fight over the drivetrain.

### `all`: start the intake while driving

Curve over to the garden and start the intake on the way. The group ends when both have finished,
so the robot is at `gardenApproach` with the intake running.

```json
{
  "id": "toGarden",
  "kind": "parallel",
  "mode": "all",
  "steps": [
    {
      "id": "driveToGarden",
      "kind": "path",
      "segments": [
        {
          "kind": "bezier",
          "from": "current",
          "control": [
            { "xIn": -12, "yIn": -28, "provenance": "PLACEHOLDER: starter example, a curve control point" },
            { "xIn": -61, "yIn": -24, "provenance": "PLACEHOLDER: starter example, a curve control point" }
          ],
          "to": { "ref": "gardenApproach" }
        }
      ],
      "heading": { "mode": "tangent" },
      "speedFraction": 0.4
    },
    { "id": "startIntake", "kind": "command", "name": "intakeOn" }
  ]
}
```

### `race`: stop when the drive ends or the robot is full

Sweep the garden row, but stop as soon as the robot reports full, and give up waiting after 3 s.
Whichever member finishes first ends the group.

```json
{
  "id": "sweepGarden",
  "kind": "parallel",
  "mode": "race",
  "steps": [
    {
      "id": "sweep",
      "kind": "path",
      "segments": [
        { "kind": "line", "from": "current", "to": { "ref": "gardenPickup" } }
      ],
      "heading": { "mode": "constant", "headingRad": -1.5708 },
      "speedFraction": 0.3,
      "expect": { "collectFrom": "gardenRed", "count": 4 }
    },
    { "id": "untilFull", "kind": "wait", "until": "hopperFull", "timeoutS": 3 }
  ]
}
```

!!! note
    To end a single path early on a condition, `endCondition` on the path is shorter and does the
    same thing. Use `race` when the thing that should be cut short is not a path, or when more
    than two things compete.

### `deadline`: spin up on the way back

Drive back from the garden to the scoring spot while a sequence waits half a second, to clear the
garden, and then spins the launcher up. The drive is the deadline: when it arrives, the group ends
and the sequence is stopped wherever it is. This is `returnToScore` from
`collect-and-score.auto.json`.

```json
{
  "id": "returnToScore",
  "kind": "parallel",
  "mode": "deadline",
  "deadline": "driveBack",
  "steps": [
    {
      "id": "driveBack",
      "kind": "path",
      "segments": [
        {
          "kind": "bezier",
          "from": "current",
          "control": [
            { "xIn": -61, "yIn": -24, "provenance": "PLACEHOLDER: starter example, a curve control point" },
            { "xIn": -12, "yIn": -28, "provenance": "PLACEHOLDER: starter example, a curve control point" }
          ],
          "to": { "ref": "scoreSouth" }
        }
      ],
      "heading": { "mode": "tangentReversed" }
    },
    {
      "id": "clearThenSpinUp",
      "kind": "sequence",
      "steps": [
        { "id": "clearGarden", "kind": "wait", "seconds": 0.5 },
        { "id": "readyLauncher", "kind": "command", "name": "spinUp" }
      ]
    }
  ]
}
```

`deadline` must name one of the group's own direct members. A missing or wrong name is a
[`SCHEMA`](checks-and-findings.md#schema) error. The deadline may be a sequence.

The intake checks look across the group: an `intakeOn` in one member counts as running for the
path in another, so [`MOUTH_LEADING`](checks-and-findings.md#mouth_leading) and
[`SWEEP_SPEED`](checks-and-findings.md#sweep_speed) apply to `driveToGarden` in the `all` group
above. That is why it drives at `speedFraction` 0.4, the default sweep limit.

## `branch`

Picks one of two lists of steps by reading a condition when the branch starts. `then` runs when the
condition is true; `else`, which may be left out, runs when it is false.

The last step of `all-step-kinds.auto.json`: after the sweep, score if the robot picked anything
up, and park if it did not.

```json
{
  "id": "checkPollen",
  "kind": "branch",
  "condition": "holdingPiece",
  "then": [
    { "id": "stopIntake", "kind": "command", "name": "intakeOff" },
    {
      "id": "returnToScore",
      "kind": "parallel",
      "mode": "deadline",
      "deadline": "driveBack",
      "steps": [
        {
          "id": "driveBack",
          "kind": "path",
          "segments": [
            {
              "kind": "bezier",
              "from": "current",
              "control": [
                { "xIn": -61, "yIn": -24, "provenance": "PLACEHOLDER: starter example, a curve control point" },
                { "xIn": -12, "yIn": -28, "provenance": "PLACEHOLDER: starter example, a curve control point" }
              ],
              "to": { "ref": "scoreSouth" }
            }
          ],
          "heading": { "mode": "tangentReversed" }
        },
        {
          "id": "clearThenSpinUp",
          "kind": "sequence",
          "steps": [
            { "id": "clearGarden", "kind": "wait", "seconds": 0.5 },
            { "id": "readyLauncher", "kind": "command", "name": "spinUp" }
          ]
        }
      ]
    },
    { "id": "scoreCollected", "kind": "command", "name": "score", "args": { "count": 4 } }
  ],
  "else": [
    { "id": "giveUp", "kind": "command", "name": "intakeOff" },
    {
      "id": "parkEmpty",
      "kind": "path",
      "segments": [
        {
          "kind": "bezier",
          "from": "current",
          "control": [
            { "xIn": -61, "yIn": -40, "provenance": "PLACEHOLDER: starter example, a curve control point" }
          ],
          "to": { "ref": "park" }
        }
      ],
      "heading": { "mode": "tangentReversed" }
    }
  ]
}
```

Use it when the robot has a sensor that answers a real question mid-routine: is anything aboard,
did a pickup work. The first step of each side starts from the pose the branch started at.

Nobody can know which way a condition goes while planning, so the estimate charges the longer of
the two sides. The [instant preview sim](simulation.md#instant-preview-sim) answers `hopperFull` and
`hopperEmpty` (and any condition marked with a `ledger` in `robot.json`) from what the robot holds.
A condition it cannot read takes the `then` side.

!!! warning "The two sides end in different places"
    After a branch, the robot may be in either side's end pose. Start the next path with
    `"from": "current"`.
