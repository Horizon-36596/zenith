# Checks and findings

Zenith checks every auto each time it changes. Each problem it finds is a **finding**: a code, a
severity, the step it belongs to, and a message. Where it can, a finding also says where along the
path it happened, and the editor marks that spot on the field.

The editor, the CLI and the MCP server run the same checks on the same files, so they always agree.

## Severities

| severity | meaning |
|---|---|
| **error** | The auto is wrong: the robot would refuse the file, crash, break a rule or run out of time. `zenith validate` exits non-zero on any error. |
| **warning** | The auto will run, but probably not the way you want. Fix it or accept it knowingly. |
| **info** | Something worth knowing. Nothing needs to change. |

## Reading findings

In the editor, click a finding's code chip to see what it means and how to fix it. Some findings
have a one-click fix.

On the command line, `--explain` prints the same help under each finding:

```bash
zenith validate autos/first-auto.auto.json --explain
```

`--json` prints the findings as JSON for scripts and agents.

## All codes

| code | severity | what it means |
|---|---|---|
| [`SCHEMA`](#schema) | error | Something in a file is not allowed: a misspelled command, a missing value, a waypoint that does not exist. |
| [`CONTINUITY`](#continuity) | error | A path starts somewhere other than where the robot is. |
| [`HEADING_MISSING`](#heading_missing) | error | A path does not say which way the robot faces. |
| [`HEADING`](#heading) | warning or info | The robot will not face the way this path asks. |
| [`HEADING_RANGES`](#heading_ranges) | error | A piecewise heading's ranges do not cover the path from 0 to 1. |
| [`PERIMETER`](#perimeter) | error | Part of the robot would go past the field wall. |
| [`STRUCTURE`](#structure) | error | The robot's outline overlaps something solid on the field. |
| [`KEEPOUT`](#keepout) | warning | The robot drives into a zone the rules restrict during auto. |
| [`START_ILLEGAL`](#start_illegal) | error | The starting pose breaks a game rule. |
| [`LEGAL_APPROACH`](#legal_approach) | error | The robot shoots from a place the rules do not allow for its target. |
| [`TURRET_RANGE`](#turret_range) | warning | The turret cannot turn far enough to aim at the target. |
| [`CAPACITY`](#capacity) | error | The robot would hold more pieces than it can carry or the rules allow. |
| [`EMPTY_SHOT`](#empty_shot) | warning | A shoot step runs with nothing, or too little, to shoot. |
| [`STRAFE_FRACTION`](#strafe_fraction) | warning | Much of a path is driven sideways, which is slow on mecanum. |
| [`MOUTH_LEADING`](#mouth_leading) | warning | The intake is running but not facing the way the robot drives. |
| [`SWEEP_SPEED`](#sweep_speed) | warning | The robot drives too fast while its intake runs. |
| [`TIME_BUDGET`](#time_budget) | error, warning or info | The routine may not fit in the autonomous period. |
| [`TIMEOUT_TIGHT`](#timeout_tight) | info | A step's timeout is close to how long it should take. |
| [`STATIONARY_MARKER`](#stationary_marker) | warning | A stand-still command is set to fire while the robot moves. |
| [`MOVES_ROBOT`](#moves_robot) | error | A path assumes a fixed start after a command that moves the robot by itself. |
| [`PROVENANCE`](#provenance) | info | A pose has no note saying where its numbers came from. |

## Codes in detail

### `SCHEMA`

**File problem.** Error.

Something in the file is not allowed. The robot would refuse to load it. This covers:

- the file does not match its [JSON Schema](file-format.md#json-schemas);
- a command or condition name that `robot.json` does not list, or arguments that do not fit the
  command's `params`;
- a `{ "ref": ... }` to a waypoint that `waypoints.json` does not have;
- a `wait` with both `seconds` and `until`, or with neither;
- a `parallel` group in `deadline` mode whose `deadline` names none of its own direct members.

**Fix.** Read the message for the exact key that is wrong. Pick the name from the list the editor
offers, or add the missing value.

### `CONTINUITY`

**Path jumps.** Error.

A path starts somewhere other than where the robot is, so the robot would have to teleport. The
gap is measured from where the previous step ended, and anything over 0.5 in counts. Segments
inside one path must also meet within 0.5 in.

How "where the previous step ended" is worked out:

- a `sequence` chains its members like the top-level list;
- every member of a `parallel` group starts where the group started;
- the first step of each side of a `branch` starts where the branch started;
- `"from": "current"` is only allowed after a step that defines where the robot is.

**Fix.** Set the path's start to `"current"` so it begins wherever the robot is. Or drag its first
point onto the end of the step before it.

### `HEADING_MISSING`

**No heading.** Error.

A path does not say which way the robot should face while it drives. Pedro, the path follower,
stops the auto with an error when a path has no heading.

**Fix.** Choose a heading mode in the path's inspector. `tangent`, which points the nose along the
path, is the usual choice.

### `HEADING`

**Heading differs on the robot.** Warning or info.

The robot will not face the way this path asks. Two cases:

- **Warning:** a `linear` heading turns more than half a circle on one segment. Pedro turns each
  segment's share of the sweep the short way round, so the robot goes the other way. The message
  gives the turn the robot actually makes, in degrees, counter-clockwise positive.
- **Info:** a `facePoint` heading has a non-zero `offsetRad`. The robot runtime ignores the offset
  for now. The editor still draws it.

Both apply inside a [`piecewise`](file-format.md#piecewise-heading) heading too, to a `linear` or
`facePoint` range; the finding's `t` is where the range starts.

**Fix.** Split the path so no piece turns more than half a circle, or set the heading at a waypoint
in between. For the info, set `offsetRad` to 0 or accept that the robot will face the point
directly.

### `HEADING_RANGES`

**Heading ranges do not fit.** Error.

A [`piecewise`](file-format.md#piecewise-heading) heading must split its path into ranges that run
from `t` 0 to `t` 1 in order: the first starts at 0, each starts where the one before it ends, each
ends after it starts, and the last ends at 1. Pedro's piecewise interpolator stops the auto on the
robot when they do not, so the file cannot run. The message names the first range that is wrong and
how.

**Fix.** Drag the boundaries in the inspector's range track, or set each range's end, so each range
starts where the one before it ends. The editor's own range edits never leave a gap or an overlap;
this finding means the file was edited by hand.

### `PERIMETER`

**Leaves the field.** Error.

Part of the robot, its body or an intake mouth, would go past the field wall at some point on the
path. A real robot would hit the wall instead. The check uses the robot's expanded footprint,
turned to its heading, plus every mouth.

**Fix.** Move the point away from the wall until the outline stays inside. Snapping to the wall
places the robot flush against it and never raises this finding.

### `STRUCTURE`

**Hits a field element.** Error.

The robot's outline overlaps an obstacle marked `solidToRobot` in the field file, such as the hive
or a flower base. The robot would crash into it. Only obstacles that reach below the robot's height
count, so the robot can drive under a bar that is higher than it is. The footprint is checked every
2 in along the path and at every segment end, mouths included. The finding names the obstacle and
marks where the overlap is deepest.

**Fix.** Move the path around the element, or add a point to bend it clear.

### `KEEPOUT`

**Enters a no-go zone.** Warning.

The robot drives into a zone the game rules restrict during the autonomous period. That can cost a
penalty. Only zones marked `appliesInAuto: true` in the field file count.

**Fix.** Reroute the path so the outline stays out of the shaded zone. The zone's rule is named in
the message.

### `START_ILLEGAL`

**Start not allowed.** Error.

The starting pose breaks a rule in the field's `startRules`: not touching a wall, starting in the
wrong half, starting in a loading zone, or touching a flower. The referees would not let the match
start like this.

**Fix.** Drag the start pose to a legal spot, usually flush against your own alliance's wall. Wall
snap helps.

### `LEGAL_APPROACH`

**Shot from an illegal spot.** Error.

A command that launches pieces (one with `ledger.launches` in `robot.json`) runs where the target is
not legally approachable. For a BIOBUZZ hive cell, the robot must be outboard of the up cell's outer
face by the margin the field file gives, on the correct side. The scoring would not count or would
draw a penalty.

**Fix.** Move the shooting pose to the allowed side of the target. The one-click fix moves it to the
nearest legal spot.

### `TURRET_RANGE`

**Turret cannot aim.** Warning.

At this shooting pose, the bearing to the target relative to the chassis is outside the turret's
`turretRangeRad` in `robot.json`. The robot would shoot in the wrong direction. Robots with no
turret never raise it.

**Fix.** Turn the robot so the target is closer to straight ahead, or move the shooting pose.

### `CAPACITY`

**Holds too many.** Error.

The ledger says the robot would hold more pieces than `capacity.max` in `robot.json`, either at the
start or after a collect. Something would fall out or draw a penalty.

**Fix.** Shoot or drop pieces before collecting more, or collect fewer. The ledger panel shows what
the robot holds after each step.

### `EMPTY_SHOT`

**Shooting nothing.** Warning.

A shoot step runs when the ledger says the robot holds nothing, or fewer pieces than the step
launches. It wastes time in the autonomous period.

**Fix.** Collect before shooting, or remove the shot. Check the ledger panel to see when the robot
is empty.

### `STRAFE_FRACTION`

**Driving sideways.** Warning.

Too much of this path is driven sideways: the distance where the travel direction is closer to the
robot's side than to its nose is over the threshold (20 % by default, set by `strafeFractionWarn` in
`robot.json`). On mecanum wheels, sideways driving is slower and stops less sharply than driving
forward. The message says how many seconds it costs against driving the same leg nose-first.

**Fix.** Use the fix that points the nose along the path, or turn during the previous stop. Keep
sideways driving for short, deliberate moves, such as a sweep along a wall.

### `MOUTH_LEADING`

**Intake not in front.** Warning.

An intake is running on this path, but its mouth is more than 30° away from the direction the robot
drives. The robot's body would push game pieces away instead of picking them up. The intake counts
as running when a marker turns it on, when an earlier `intakeOn` was never stopped, or when an
`intakeOn` runs in another member of the same `parallel` group.

**Fix.** Choose a heading that puts the running mouth in front: `tangent` for a front mouth,
`tangentReversed` for a back one.

### `SWEEP_SPEED`

**Intaking too fast.** Warning.

The robot drives faster than `sweepSpeedFraction` in `robot.json` (0.4 by default) while its intake
runs. Pieces get knocked away rather than collected at that speed.

**Fix.** Lower this path's `speedFraction` to the sweep speed. The one-click fix does it for you.

### `TIME_BUDGET`

**Over the time limit.** Error, warning or info.

The whole routine may take longer than the autonomous period (`periods.autoS` in the field file).
Anything after the buzzer does not happen. The estimate is a range, and the severity depends on
which end of it is over:

- **Error:** even the optimistic end of the range is over the period.
- **Warning:** the nominal estimate is over; only the optimistic end fits.
- **Info:** the routine fits, but some step has no fixed time. Either a step has no estimate at
  all, so the total is a lower bound, or a step ends on a condition, so the total is an upper bound.

**Fix.** Cut or shorten steps, drive faster where it is safe, or move slow steps later. The timeline
shows which steps take the longest.

### `TIMEOUT_TIGHT`

**Timeout too short.** Info.

This step's `timeoutS` is under 1.2 times its estimate. A slightly slow run would be cut off before
it finishes.

**Fix.** Raise the step's timeout to a little more than its estimate. The estimate is shown beside
the step.

### `STATIONARY_MARKER`

**Stop-only command while moving.** Warning.

A marker fires a command that `robot.json` marks `stationary: true`, in the middle of a path. It
would run while the robot is still driving.

**Fix.** Make it its own `command` step after the path instead of a marker on it.

### `MOVES_ROBOT`

**Start after a moving command.** Error.

The step before this one runs a command marked `movesRobot: true`, which drives the robot by itself,
so nobody knows exactly where it ends. This path starts from a fixed pose anyway.

**Fix.** Set this path's start to `"current"` so it begins wherever the robot really is.

### `PROVENANCE`

**Where did this come from?** Info.

A pose has no provenance label saying where its numbers came from, such as measured on the field or
set in the editor. Inline poses the editor writes are treated as `SET FROM EDITOR`. This is only a
reminder, not an error. See [provenance labels](file-format.md#provenance-labels).

**Fix.** Nothing is required. Measure the pose on the field, or save it as a named waypoint with a
label, to record where it came from.

## Checks that need an estimate

`STRAFE_FRACTION`, `TIME_BUDGET` and `TIMEOUT_TIGHT` use the time estimate. If an estimate cannot be
made, those three are skipped and every other check still runs. See [Simulation](simulation.md) for
how the estimate is made.
