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
| [`CLEARANCE`](#clearance) | warning | The robot passes closer to something solid than its clearance, without touching it. |
| [`KEEPOUT`](#keepout) | warning | The robot drives into a zone the rules restrict during auto. |
| [`OPPONENT_SIDE`](#opponent_side) | error | During auto, the robot goes past the centre line into the other alliance's side. |
| [`START_ILLEGAL`](#start_illegal) | error | The starting pose breaks a game rule. |
| [`LEGAL_APPROACH`](#legal_approach) | error | The robot shoots from a place the rules do not allow for its target. |
| [`TURRET_RANGE`](#turret_range) | warning | The turret cannot turn far enough to aim at the target. |
| [`CAPACITY`](#capacity) | error | The robot would hold more pieces than it can carry or the rules allow. |
| [`EMPTY_SHOT`](#empty_shot) | warning | A shoot step runs with nothing, or too little, to shoot. |
| [`LAUNCH_TARGET`](#launch_target) | warning | A step's `expect.launchesInto` names something that is not a target on the field. |
| [`TRANSFER`](#transfer) | error, warning or info | A transfer step names a place the ledger does not count, or asks for more pieces than its source holds. |
| [`STRAFE_FRACTION`](#strafe_fraction) | warning | Much of a path is driven sideways, which is slow on mecanum. |
| [`MOUTH_LEADING`](#mouth_leading) | warning | The intake is running but not facing the way the robot drives. |
| [`SWEEP_SPEED`](#sweep_speed) | warning | The robot drives too fast while its intake runs. |
| [`TIME_BUDGET`](#time_budget) | error, warning or info | The routine may not fit in the autonomous period. |
| [`TIMEOUT_TIGHT`](#timeout_tight) | warning or info | A step's timeout is shorter than, or close to, how long it should take. |
| [`WAIT_NO_TIMEOUT`](#wait_no_timeout) | warning | A wait for a condition has no timeout, so it may wait for the rest of the period. |
| [`STATIONARY_MARKER`](#stationary_marker) | warning | A stand-still command is set to fire while the robot moves. |
| [`MOVES_ROBOT`](#moves_robot) | error or warning | A path assumes a fixed start after a command that moves the robot by itself, or declares a rejoin pose that is not used. |
| [`PROVENANCE`](#provenance) | info | A pose has no note saying where its numbers came from. |
| [`ENVELOPE_SHAPE`](#envelope_shape) | error | A step's envelope is not one simple polygon. |
| [`STEP_ID`](#step_id) | warning | A step's id has a space or a character an id cannot hold, or does not start with a letter. |

### Alliance codes

These five codes compare your auto with an alliance partner's shared auto. They come only from the
alliance view in the editor, `zenith alliance` on the command line and the `zenith.alliance` MCP
tool. They are never part of `zenith validate`, so they never stop a save, a deploy, a `propose` or
a run. See [Alliance findings never block anything](#alliance-findings-never-block-anything).

| code | severity | what it means |
|---|---|---|
| [`ALLIANCE_COLLISION`](#alliance_collision) | error | Your robot and your partner's are predicted to be in the same place at the same time. |
| [`ALLIANCE_NEAR_MISS`](#alliance_near_miss) | warning | The two robots are predicted to pass close without touching. |
| [`ALLIANCE_START_OVERLAP`](#alliance_start_overlap) | error | The two start poses overlap, or both robots start on the same field tile. |
| [`ALLIANCE_ELEMENT_CONFLICT`](#alliance_element_conflict) | warning | Both autos take from the same container or score into the same target. |
| [`ALLIANCE_ENVELOPE`](#alliance_envelope) | warning | Your robot enters an area your partner has reserved while its path is not known. |

### Proposal codes

These five codes are about a proposal: a set of changes one team suggests to an auto another team
shared with it at the propose level. They come only from the editor's proposal and review views,
`zenith proposal validate` and `zenith proposal apply` on the command line, and the
`zenith.proposal.validate` and `zenith.proposal.apply` MCP tools. They are never part of
`zenith validate` on an auto. See [Proposal findings](#proposal-findings).

| code | severity | what it means |
|---|---|---|
| [`PROPOSAL_SHARE`](#proposal_share) | error | The share takes no proposals: it is view only, revoked or expired. |
| [`PROPOSAL_STALE`](#proposal_stale) | error | The proposal was made against a different share, revision or version of the shared auto. |
| [`PROPOSAL_TOKEN`](#proposal_token) | error or warning | A change places a command or condition token the share did not hold, or copies one instead of moving it. |
| [`PROPOSAL_CHANGE`](#proposal_change) | error or warning | A change names a step that is not there, or asks for something its step cannot do. |
| [`PROPOSAL_CONFLICT`](#proposal_conflict) | error or warning | The step a change is about has changed in the auto since it was shared. |

### Robot code codes

This code compares `robot.json` with the robot's own Java. It comes only from
`zenith validate --java <dir>` and `zenith import-commands`, which read the Java to find the
`NamedCommands` registrations, and from the editor's Import commands from Java dialog. See
[Commands from the robot's code](robot-runtime.md#commands-from-the-robots-code).

| code | severity | what it means |
|---|---|---|
| [`REGISTRY`](#registry) | error, warning or info | `robot.json` and the robot's Java disagree about a command, a condition or an argument. |

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
gap is measured from where the previous step ended, and anything over 0.5 in counts. The paths
inside one path chain must also meet within 0.5 in.

How "where the previous step ended" is worked out:

- a `sequence` chains its members like the top-level list;
- every member of a `parallel` group starts where the group started;
- the first step of each side of a `branch` starts where the branch started;
- `"from": "current"` is only allowed after a step that defines where the robot is.

**Fix.** The one-click fix, **Start from robot**, sets the path's start to `"current"` so it begins
wherever the robot is. Or drag its first point onto the end of the step before it.

Where two paths of one path chain do not meet, the finding has its own help and a one-click fix,
**Join path N to path N-1**, which sets the later segment's `from` to the earlier one's `to` (a
waypoint stays a waypoint). In the editor, the point where two paths meet moves as one point,
so dragging, nudging, turning or typing it never opens this gap. Removing a path (**Remove this
path**, or Del on the point where two paths meet, which joins them) starts the next path from
`"current"`, so that never opens it either.

### `HEADING_MISSING`

**No heading.** Error.

A path does not say which way the robot should face while it drives. Pedro, the path follower,
stops the auto with an error when a path has no heading.

**Fix.** Choose a heading mode in the path's inspector. `tangent`, which points the nose along the
path, is the usual choice.

### `HEADING`

**Heading differs on the robot.** Warning or info.

The robot will not face the way this path asks. Two cases:

- **Warning:** a `linear` heading turns more than half a circle on one path. Pedro turns each
  path's share of the sweep the short way round, so the robot goes the other way. The message
  gives the turn the robot actually makes, in degrees, counter-clockwise positive.
- **Info:** a `facePoint` heading has a non-zero `offsetRad`. The robot runtime ignores the offset
  for now. The editor still draws it.

Both apply inside a [`piecewise`](file-format.md#piecewise-heading) heading too, to a `linear` or
`facePoint` range; the finding's `t` is where the range starts.

**Fix.** Split the path so no piece turns more than half a circle, or set the heading at a waypoint
in between. The warning's one-click fix, **Split path**, splits the path in two (or into as many
pieces as it takes): it cuts the path that asks for the most into equal lengths, so each piece turns its share the
long way. The heading stays the one sweep you wrote, so at each cut the robot faces where it was
meant to, and a start from `"current"` or a waypoint end stays as it was. On a `piecewise` range,
**Split range N in two** cuts the range instead. For the info, set `offsetRad` to 0 or accept that
the robot will face the point directly.

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

The message names the wall, west, east, south or north, and how far past it the robot goes, and
along a path the stretch it stays out over, for example "The robot leaves the field past the west
wall by 5.00 in, t 0.80 to 1.00." The field tints that stretch.

Like `STRUCTURE`, the finding goes on the step that drove out, and a step where the robot only
stands in that pose afterwards does not repeat it. The routine's start pose has not been checked
before the first step, so a command that stands at a start through the wall reports it. A path that
turns on the spot as it starts is in a new pose, so it is still checked. A turn on the spot, a path
step with no length, is checked through the whole turn, and its message says the robot's corners
swing past the wall as it turns; it has no one-click fix, so turn further from the wall or turn less.

**Fix.** Move the point away from the wall until the outline stays inside. Snapping to the wall
places the robot flush against it and never raises this finding. When the message says the robot
turns while it is still against the wall, the one-click fix, **Turn while driving**, gives the path a
`linear` heading from the way the robot faces as the path starts to the way the path ends, so the
robot leaves the wall facing as it was and turns as it drives. When the robot is furthest out where
the path ends, and that end is a pose of its own rather than a waypoint, the one-click fix **Push the
end back from the wall** moves the end inward until the outline is a tenth of an inch inside. It is
offered only when the whole auto, checked again with the end moved, is clean of what the finding was
about: the path no longer leaves the field, no step runs into anything new, and no step is left
starting away from where the robot is. A next step that starts from `current` follows the moved
end; one written to start at the old end as a pose of its own would be left behind, so the fix is
not offered then. On a path step, the finding also offers **Route around**, which looks for a route
clear of the field wall: it opens [Optimize path](editor.md#optimize-path) on that step; see [Route around](#route-around).

### `STRUCTURE`

**Hits a field element.** Error.

The robot's outline overlaps an obstacle marked `solidToRobot` in the field file, such as the hive
or a flower base. The robot would crash into it. The footprint is checked every 2 in along the path
and at every segment end, mouths included.

Only the part of an obstacle below the robot's top counts, using the robot height from
`robot.json`. The robot is treated as an upright block of its outline from the tiles to that
height, and is checked against the floor plan of that part:

- A box counts in full when its underside is lower than the robot's top, and not at all otherwise,
  so the robot can drive under a bar that is higher than it is.
- A [strut](file-format.md#obstacles), a slanted bar, counts from the tiles up to the robot's top.
  Its floor plan is the strip under that piece of the bar, as wide as the bar's round envelope and
  reaching that far past each end. A taller robot meets more of a slanted leg, so a route that clears
  it at 6 in can hit it at 18 in. A strut entirely above the robot never counts.

When the robot's height decided the finding, for a strut or for a box that starts above the tiles,
the message ends with the height used and its provenance label, for example "with the robot 18 in
tall (placeholder)", so you can see when the answer rests on a height nobody has measured.

The message names the obstacle in words you can find on the field, with the field file's id after
it, such as "the west base bar of the hive frame (frameBarWest)", when the season plugin gives it a
name. It says how far the robot drives in contact and how deep it goes, for example "The robot
drives into the west base bar of the hive frame (frameBarWest) for about 56 in (t 0.15 to 0.85), up
to 9.50 in deep." The depth is how far the robot would have to move to get clear of the obstacle,
so a robot driving straight across a 1 in bar reads as deep, not as a 1 in graze. The field tints
the whole stretch in contact, puts the clip ghost where the robot is deepest (the middle of that
stretch when it is equally deep all along), and outlines the obstacle while you point at the row.

The finding goes on the step that drove into the obstacle. A step where the robot only stands in
that same pose afterwards, such as a wait or a command, and the next path's first point, when it
starts there with the same heading, do not report it again.

**Fix.** Move the path around the element, or add a point to bend it clear. When the robot hits it
by turning on the spot as a path starts, the same **Turn while driving** fix as for `PERIMETER` is
offered. When it goes deepest where the path ends, on a pose of its own, **Push the end clear of**
the element moves the end out by the shortest of the four ways round it, to a tenth of an inch
past the robot's clearance (the same margin [`CLEARANCE`](#clearance) uses, 1 in unless `robot.json`
says otherwise), so the moved end does not raise `CLEARANCE` at once. When no such spot passes the
check below, it moves the end to a tenth of an inch clear instead. For a strut the four ways are measured round the box that holds its floor plan, so the end
can move a little further than it strictly needs. It is offered only when the whole auto, checked again with the end moved, passes the same
test as for `PERIMETER`: the path touches the element no more, no step runs into anything new, and
no step is left starting away from where the robot is. On a path step the finding also offers
**Route around** the element, named the way the message names it; see [Route around](#route-around).

### `CLEARANCE`

**Close to a field element.** Warning.

The robot's outline passes within the robot's clearance of an obstacle `STRUCTURE` checks, without
touching it. A robot that drifts that far off the path would hit it. The clearance is the robot's
own number, `footprint.clearanceIn` in [`robot.json`](file-format.md#robotjson), or 1 in when the
file leaves it out. It is not the path follower's deviation tolerance.

- Only structures count: the obstacles `STRUCTURE` checks, at the robot's height. The field wall
  and keep-out zones do not, because driving along the wall is common.
- Where the robot touches an obstacle on a step, that step reports `STRUCTURE` for it and no
  `CLEARANCE`.
- The message says how close the robot comes and where the margin came from, for example "The robot
  passes 0.47 in from the south-west leg of the hive frame (frameLegSouthWest) at t 0.38, within 1 in
  (Zenith's default; set it in Settings, Robot)." Once `robot.json` sets it, the brackets give the
  file and the number's provenance label instead, such as "(robot.json, SET BY HAND)".
- No personal setting changes the margin, so `zenith validate`, the MCP server and the editor
  report the same warnings for one file. A clearance of 0 turns the warning off for that robot.

Like `STRUCTURE`, it is reported on the step that drove past, not again on a step that only stands
there afterwards.

**Fix.** Move the path a little further from the element, or add a point to bend it clear. If your
robot follows its paths closely, set a smaller clearance in Settings, Robot, which writes
`footprint.clearanceIn` to `robot.json`. On a path step the warning also offers **Route around** the
element; see [Route around](#route-around).

### `KEEPOUT`

**Enters a no-go zone.** Warning.

The robot drives into a zone the game rules restrict during the autonomous period. That can cost a
penalty. Only zones marked `appliesInAuto: true` in the field file count. Like `STRUCTURE`, it is
reported on the step that drove in, not again on a step that only stands there afterwards.

**Fix.** Reroute the path so the outline stays out of the shaded zone. The zone's rule is named in
the message. On a path step the warning also offers **Route around** the zone; see
[Route around](#route-around).

### `OPPONENT_SIDE`

**Crosses the centre line.** Error.

During auto, the robot goes past the centre line into the other alliance's side of the field. In
BIOBUZZ that is G402 (Competition Manual V1, section 11.4.1): during AUTO, columns A to C are the
red side and D to F the blue side (Figure 9-5), each alliance has priority on its own side, and
driving onto the other side "may be seen as STRATEGIC". The penalty is a MAJOR FOUL, and a MAJOR
FOUL and a YELLOW CARD if the referees see it as strategic. A yellow card puts the match at risk and
a planner cannot know where the other alliance's robots will be, so Zenith makes it an error, not a
warning.

- The line is the one [`START_ILLEGAL`](#start_illegal) uses for "starting in the wrong half", with
  the same 0.05 in of slack, so the two never disagree. The season plugin says where it is: for
  BIOBUZZ it is the field's centre, x = 0, and the alliance's own side is the half its own hive is in.
- The auto's `alliance` decides which side is its own, so a mirrored BLUE auto is checked against
  BLUE's side.
- The robot is everything the footprint checks test: the expanded body, turned to its heading, and
  every intake mouth, as `STRUCTURE` and `PERIMETER` sweep them. A mouth reaching over the line is
  part of the robot over it; the message says so when the mouth is the part that crosses.
- It is checked every 2 in along each path, at every segment end and through each turn on the spot,
  whose corners can swing over the line though both its ends are clear.
- The start pose is checked too, by the first step that stands in it, because `START_ILLEGAL`
  measures only the start-configuration size there: a robot whose start-configuration body is on its
  own side but whose expanded body or a mouth is over the line gets this error from its first step,
  even when that step is a wait. When the start-configuration body itself is over the line, the start
  is reported once, as the `START_ILLEGAL` error, and the first step leaves that pose to it. Like
  `STRUCTURE`, a step where the robot only stands in a pose a step before it already checked does not
  report it again.

The message says how far over the robot goes and where, for example "The robot crosses the centre
line into BLUE's side for about 64 in (t 0.00 to 0.74), up to 2.13 in over.", and ends with the rule
and what breaking it costs. The field tints the stretch of the path that is over and puts the clip
ghost where the robot is farthest over.

**Fix.** Move the path back onto your own side of the line, or add a point to bend it clear. On a
path step the error also offers **Route around the centre line**; see [Route around](#route-around).
The optimizer treats the other side as a keep-out, so it never offers a route that crosses.

### `START_ILLEGAL`

**Start not allowed.** Error.

The starting pose breaks a rule in the field's `startRules`: not touching a wall, starting in the
wrong half, starting in a loading zone, or touching a flower. The referees would not let the match
start like this.

**Fix.** Drag the start pose to a legal spot, usually flush against your own alliance's wall. Wall
snap helps. The one-click fix, **Move start**, moves it to the nearest legal spot: it tries poses
touching each wall against the same rule, keeping the robot's heading where it can, and checks the whole auto from
each of the 40 closest that pass, nearest first. It moves the start to the first from which the auto
has no error it did not have before and its first path leaves facing the way the robot starts, so the
robot does not turn on the spot against the wall. When there is none, it tries them again turned to
the way the first path leaves, pushed back against the same wall. When that finds none either, it
takes one the checks pass even though the robot turns there, or else the nearest, and the status line
names the error the auto still has. Its provenance says it was found, not measured, so check it where
the robot really sets up. A start that follows a waypoint gets a pose of its own there, as when you
drag it, and the waypoint, which other autos may use, stays where it is; one undo makes the start
follow it again. A path whose first point sits on the start moves with it. When no pose touching a
wall passes the rule, the status line says so and the start stays where it is.

Clicking the row selects the start, pauses playback and puts the playhead at 0, where the robot
stands on the start. While the start breaks the rule, the field draws the start mark and the outline
of the robot there in the error colour, over the robot.

### `LEGAL_APPROACH`

**Shot from an illegal spot.** Error.

A command that launches pieces (one with `ledger.launches` in `robot.json`) runs where the target is
not legally approachable. For a BIOBUZZ hive cell, the robot must be outboard of the up cell's outer
face by the margin the field file gives, on the correct side. The scoring would not count or would
draw a penalty.

When the pose was legal earlier in the auto, the message names the step after which it stopped
being legal and what the ledger says changed there, such as a hive tipping, and any transfer step
before it that moved pieces into or out of the target. A transfer that fills the up cell can make
an earlier shot tip the hive, so the error lands on a later shot.

**Fix.** Move the shooting pose to the allowed side of the target. The one-click fix, **Move to
approach**, moves the end of the path before the shot to a legal spot and turns the robot there so
the side of it the shot pointed at the target still points at it. It starts from the nearest legal
spot and looks at spots round it, up to 24 in away, nearest the shot first. The check runs on
every edit, so it plans at most three moves again and checks at most two of them whole; a spot
further down the list goes untried. A spot is out when the
whole auto, checked again, is worse: the path still runs into a field element, a step runs into
anything new or is left starting away from where the robot is, the auto gains an error, or a
problem it already had gets deeper or nearer. Of the rest it takes the first that adds no warning
either; when every one adds a warning, it takes the first of those and its status line says which
warning it added. When no spot is left, it is not offered. A turret aims anywhere in its
`turretRangeRad`, so the heading changes only when the target would be outside it, and then the
target is put in the middle of the range. Anything else keeps the shot's own aim: the target sits at
the same bearing from the robot's body at the new spot as it did where the shot was, so a robot that
launched out of its back still launches out of its back. Where the heading has to change, a
constant heading gets the new angle, a linear one or the last range of a piecewise one ends at it,
and a tangent heading becomes a linear turn to it from the way the robot arrives. The fix's tooltip
says the robot is turned so the same side faces the target. The moved end is labelled SET FROM
EDITOR, as the other one-click fixes label what they write. A launch from a marker partway along a
path has no such fix, since moving the path's end would not move it.

### `TURRET_RANGE`

**Turret cannot aim.** Warning.

At this shooting pose, the bearing to the target relative to the chassis is outside the turret's
`turretRangeRad` in `robot.json`. The robot would shoot in the wrong direction. Robots with no
turret never raise it.

**Fix.** Turn the robot so the target is closer to straight ahead, or move the shooting pose.

### `CAPACITY`

**Holds too many.** Error.

The ledger says the robot would hold more pieces than `capacity.max` in `robot.json`: at the
start, after a collect, or after a transfer into the robot. Something would fall out or draw a
penalty.

**Fix.** Shoot or drop pieces before collecting more, or collect fewer. The ledger panel shows what
the robot holds after each step.

### `EMPTY_SHOT`

**Shooting nothing.** Warning.

A shoot step runs when the ledger says the robot holds nothing, or fewer pieces than the step
launches. It wastes time in the autonomous period.

**Fix.** Collect before shooting, or remove the shot. Check the ledger panel to see when the robot
is empty.

### `LAUNCH_TARGET`

**Unknown launch target.** Warning.

A step's `expect.launchesInto` names something the season plugin does not know as a target. For
BIOBUZZ a target is a hive cell, named by its target id (such as `hiveRedUpCell`) or by the hive's
own id. The ledger cannot score the pieces anywhere, so it takes them out of the robot and counts
them as loose on the floor. The message names the target that is current at that step. A season
plugin that cannot tell targets apart never raises it.

**Fix.** In the step's `expect`, change `launchesInto` to the target the message names or another
target on this field, or remove it so the step launches at the current target.

### `TRANSFER`

**Transfer does not add up.** Error, warning or info.

A transfer step is a planner-only note that game pieces move between two places the ledger counts,
such as the alliance partner scoring into the hive (see "Transfers" in the file format). It is an
error when the step names a place the season does not count, names the same place twice, or tries
to put a piece back on a garden line; the message lists the places it does count. It is a warning
when the source holds fewer pieces at that point than the step's actual count, so the ledger moves
only what is there. It is info when no season plugin that counts places is loaded, so the step
changes nothing. The robot never acts on a transfer, so none of these stop it from running.

**Fix.** Pick the from and to places from the lists in the transfer's inspector. If the source
runs short, lower the actual count, or add the step that fills the source earlier.

### `STRAFE_FRACTION`

**Driving sideways.** Warning.

Too much of this path is driven sideways: the distance where the travel direction is closer to the
robot's side than to its nose is over the threshold (20 % by default, set by `strafeFractionWarn` in
`robot.json`). On mecanum wheels, sideways driving is slower and stops less sharply than driving
forward. The message says how many seconds it costs against driving the same leg nose-first,
counting on each side the turn on the spot the leg opens with. A robot that already faces across the
leg would have to turn before driving it nose-first, so a short leg can be no slower sideways; then
the message says so, and the fix that points the nose along the path is not offered. The field tints the path from where the robot first drives sideways to where it last does, and each stretch apart when nose-first driving comes between them.

**Fix.** Use the fix that points the nose along the path, or turn during the previous stop. Keep
sideways driving for short, deliberate moves, such as a sweep along a wall. When you want the
sideways driving but a faster way to face while you do it, **Find faster heading** opens
[Optimize path](editor.md#optimize-path) on the step with the path's segments kept exactly as
written, so only its heading is searched. It shows the result before anything changes.

### `MOUTH_LEADING`

**Intake not in front.** Warning.

An intake is running on this path, but its mouth is more than 30° away from the direction the robot
drives. The robot's body would push game pieces away instead of picking them up. The intake counts
as running when a marker turns it on, when an earlier `intakeOn` was never stopped, or when an
`intakeOn` runs in another member of the same `parallel` group. A marker that stops it ends the
running stretch there, so the part of the path before the stop still counts. After a `branch`, the
intake counts as running when either arm leaves it running; each arm starts from the state the
branch was entered with.

**Fix.** Choose a heading that puts the running mouth in front: `tangent` for a front mouth,
`tangentReversed` for a back one.

### `SWEEP_SPEED`

**Intaking too fast.** Warning.

The robot drives faster than `sweepSpeedFraction` in `robot.json` (0.4 by default) while its intake
runs on any part of the path, counted as for `MOUTH_LEADING`. Pieces get knocked away rather than
collected at that speed.

**Fix.** Lower this path's `speedFraction` to the sweep speed. The one-click fix does it for you.

### `TIME_BUDGET`

**Over the time limit.** Error, warning or info.

The whole routine may take longer than the autonomous period (`periods.autoS` in the field file).
Anything after the buzzer does not happen. The estimate is a range, and the severity depends on
which end of it is over:

- **Error:** even the optimistic end of the range is over the period. A path that ends on a
  condition counts as zero there, since its sensor can stop it at once.
- **Warning:** the nominal estimate is over; only the optimistic end fits.
- **Info:** some step has no fixed time, so the total is a bound rather than a firm number. The
  note names those steps. The editor does not list it in the Problems panel or count it there: the
  timeline's `~` before an Ideal or estimate total says the same, and hovering it says why (see
  [Timeline and playback](editor.md#timeline-and-playback)). **Validate**, Save and
  `zenith validate` still report it. It says one of three things:
  - A step with no estimate and no timeout counts as zero, so the total is a lower bound and the
    routine may not fit. This note stays even when the total is already over the period.
  - A wait, or a command with no estimate, that has a `timeoutS` takes at most its timeout. The note
    says whether the routine fits even if each one runs its full timeout, for example "The routine
    fits the 30 s period even if waitForFull runs its full 1 s timeout (25.0 s)."
  - A path that ends on a condition is timed as if it drove the whole path, so the total is an
    upper bound and the routine may come in under it. This note stays even when the total is over
    the period.

  A step that its group stops early adds nothing to the total, so the note leaves it out: a member
  of a `deadline` group other than its deadline, and a member of a `race` when another member is
  sure to end.

**Fix.** Cut or shorten steps, drive faster where it is safe, or move slow steps later. The timeline
shows which steps take the longest. The info note needs nothing. To make the total firm, give each
wait it names a timeout and each command it names an estimate in `robot.json`.

### `TIMEOUT_TIGHT`

**Timeout too short.** Warning or info.

This step's `timeoutS` is shorter than, or close to, its estimate. The robot stops the step when its
timeout runs out, finished or not.

- **Warning:** the timeout is under the estimate, so the step is stopped before it is done. The
  message says where: for a path, how far along it is (`t`) and how many inches short of its end.
  The estimate counts the step up to its timeout, so the timeline and the total show the step cut
  short. On the Ideal playback level the robot stops there too, and the next path opens with a
  transition from that spot, a hatched block on the timeline.
- **Info:** the timeout is between the estimate and 1.2 times it. Only a slow run is cut short.

**Fix.** Raise the step's timeout to a little more than its estimate. The one-click fix, "Raise the
timeout to N s", sets it to 1.2 times the estimate, rounded up to the next 0.1 s.

### `WAIT_NO_TIMEOUT`

**Wait with no timeout.** Warning.

A `wait` step with `until` and no `timeoutS`. If the condition never reads true, for example
because a sensor is unplugged, the robot waits there for the rest of the period. A path's
`endCondition` does not raise it, because the generated code races the condition against the path,
so the end of the path bounds it. Nor does a wait in a `deadline` group that is not its deadline
step, or a wait inside a `race` group that another member is sure to end, such as a path or a wait
with a timeout, because the group ends it. A race whose members can all wait forever ends none of
them, so each wait in it still warns.

**Fix.** Type the longest the robot may wait into the step's Timeout field. The one-click fix, "Set
a timeout", selects the step and puts the cursor in that field. It writes no number, because only
you know how long the robot may wait.

### `STATIONARY_MARKER`

**Stop-only command while moving.** Warning.

A marker fires a command that `robot.json` marks `stationary: true`, in the middle of a path. It
would run while the robot is still driving.

**Fix.** Make it its own `command` step after the path instead of a marker on it.

### `MOVES_ROBOT`

**Start after a moving command.** Error.

An earlier step runs a command marked `movesRobot: true`, which drives the robot by itself, so nobody
knows exactly where it ends, and this is the first path after it. This path starts from a fixed pose
anyway. A wait, a transfer or a command that does not drive, in between, holds the robot wherever the
moving command left it, so it does not help.

**Fix.** Set this path's start to `"current"` so it begins wherever the robot really is. The
one-click fix, **Start from robot**, does it for you.

The same code, as a warning, marks a path whose `rejoinFrom` is not used: either the path does not
start from `"current"`, or the steps written before it end at a pose the planner knows, and the
known pose wins. Remove the `rejoinFrom`, or make the path the first one after the command that moves
the robot.

### `PROVENANCE`

**Where did this come from?** Info.

A pose has no provenance label saying where its numbers came from, such as measured on the field or
set in the editor. Inline poses the editor writes are treated as `SET FROM EDITOR`. This is only a
reminder, not an error. See [provenance labels](file-format.md#provenance-labels).

**Fix.** Nothing is required. Measure the pose on the field, or save it as a named waypoint with a
label, to record where it came from.

### `ENVELOPE_SHAPE`

**Envelope shape is broken.** Error.

A step's `envelope`, the area its robot's bounding box is declared to stay inside while the step
runs, is not one simple polygon: two of its edges cross (a bowtie), an edge runs back along the one
before it, its corners all lie on one line, or it has fewer than three distinct corners. The
finding marks where the edges cross.

**Fix.** Edit the corners in the step's Envelope section so they run round the outside in order,
or remove the envelope.

### `STEP_ID`

**Step id breaks the rule.** Warning.

A step's `id` follows the same rule as a waypoint's name: it starts with a letter and holds only
letters, digits, `_` and `-`, at most 64 characters. A file written before the rule may have an id
such as `shoot preload` or `park.2`. It still loads, runs and generates Java that compiles, so this
is a warning, not an error. Only an `id` written in the file is checked; a step without one, which
goes by its place (`step3`, `park.2`), never raises it.

**Fix.** Use the **Rename to ...** fix. It renames the step to the id with the characters taken out
and each word after them starting with a capital (`shoot preload` becomes `shootPreload`), with
`step` in front when it would not start with a letter, and a number after it when another step has
that id. A parallel group's `deadline` that named the old id names the new one. Or rename the step
yourself.

### Route around

`PERIMETER`, `STRUCTURE`, `CLEARANCE`, `KEEPOUT` and `OPPONENT_SIDE` on a path step offer a fix
for what the path goes through: **Route around the west base bar of the hive frame**, **Route
around the field wall**, **Route around the centre line**, or **Route around** a keep-out zone's id.
The editor's button says **Route around**, since the problem's message already names the obstacle,
and it is left off a step whose own start or end is inside something, where no route between those
ends could be clear. It is not like the other one-click fixes, because
it writes nothing. It opens [Optimize path](editor.md#optimize-path) on that step in Route around
mode and runs it at once; you see the proposed route and press **Apply** or **Discard**.

In Route around mode, a route that clears every structure by the margin, stays inside the walls,
stays out of the keep-outs and stays on its own side of the centre line is accepted even when it is slower than the original, because the
original was never a route the robot could drive. The step collides when it has a `STRUCTURE`,
`PERIMETER`, `KEEPOUT` or `OPPONENT_SIDE` finding. Optimize path started any other way, from the
toolbar, a menu, the palette, Optimize every path, `zenith optimize` or `zenith.optimize`, follows
that rule too, so a step through the hive frame always gets the fastest clear route found, or a
sentence saying no clear route joins its ends.

Route around goes one step further, because you asked it to clear something: a `CLEARANCE` warning
on the step, or the planned path coming closer than the margin to anything, counts as a collision
for it. The route it returns keeps the whole margin even when that is slower, and says so: "The
original comes within the margin of the west base bar of the hive frame, so this is the fastest
route found that keeps the margin." When the step's own start or end is itself within the margin,
no route between those ends can keep it there, so the sentence says that instead: "...and its own
end is within the margin, which Route around cannot move, so this is the fastest route found that
keeps the margin everywhere else." A `CLEARANCE` warning whose closest point is the path's own start
or end does not offer Route around at all: move that end first. Optimize path started any other way keeps a step that only
comes within the margin, unless a route is faster and comes no closer to anything than the step
does. The step keeps its first and last point, and nothing else in the auto changes.

A wait, a command and a turn on the spot have no route to go round anything with, so they do not
offer it. With the Optimize path switch off in Settings, General, the fix is not offered. The
checks never run the optimizer themselves: a finding only says the fix exists.

## Alliance findings

The alliance checks put your robot and each partner's on one field and compare them every 0.1 s.
Your robot is the instant sim's prediction of your auto. Each partner is the projection they shared
with you: their trajectory, their robot's bounding box, their phases, the field elements they claim
and any envelopes. A partner whose auto was written for the other alliance is mirrored onto yours
by the field's own mirror first.

Every alliance message begins with "Predicted", because it compares two predictions and neither is
a promise about the match. Each robot can be given a **start offset**, the seconds it waits at its
start pose before its auto begins. A robot holds its start pose while its offset runs and its final
pose after its auto ends.

### Alliance findings never block anything

The five alliance codes are not part of `zenith validate` on an auto. They never stop a save, a
deploy, a `propose` or a run. `zenith alliance` exits `1` when it finds an alliance error, so an
agent can see it, and that exit code gates nothing else.

### `ALLIANCE_COLLISION`

**Predicted crash with partner.** Error.

The two bounding boxes, each grown by a 2 in margin on every side, overlap at the same time. There is
one finding for each run of 0.1 s ticks that overlap. It names the time the run starts, what each
robot is doing then (your step, their phase) and the closest approach, or how deep the boxes
overlap, during the run.

**Fix.** Two one-click fixes find the smallest change, in 0.1 s steps up to 10 s, that clears every
predicted collision:

- **Delay my start** sets your robot's start offset in the alliance view. It changes nothing in the
  auto, so agree the delay with your drive team.
- **Add a wait step** inserts a real `wait` step before the step your robot is running when the
  collision begins, through the normal edit and undo path. A step inside a `parallel` group gets
  the wait before the group instead.

You can also route around the partner.

### `ALLIANCE_NEAR_MISS`

**Predicted close pass.** Warning.

The two boxes, each grown by a 6 in margin, overlap without the 2 in collision margins touching. A
small difference in speed on the field could turn it into a crash. There is one finding per run of
close ticks, not one per tick.

**Fix.** Nothing is required. For more room, the same two one-click fixes as a collision find the
smallest change, in 0.1 s steps up to 10 s, that clears every predicted near miss without a
collision: **Delay my start**, or **Add a wait step** before the step your robot is running at the
closest approach. You can also move your path further away.

### `ALLIANCE_START_OVERLAP`

**Starts overlap partner.** Error.

Either the two robots' boxes overlap at their start poses, or both start poses are on the same
field tile. The field is a 6 by 6 grid of 24 in tiles, so tile edges are at every multiple of 24 in
from -72 in to 72 in, and a robot's tile is the one under its centre of rotation. Two robots cannot
be set up on one tile. A start offset cannot fix this, because a robot waiting out its offset stays
at its start pose.

**Fix.** Agree start poses with your partner and move one of them to another tile. The alliance
view draws both outlines. There is no one-click fix, because no delay moves a waiting robot.

### `ALLIANCE_ELEMENT_CONFLICT`

**Both go for one element.** Warning.

Both autos plan to take from the same container, or both plan to score into the same target. The
finding names the element and which robot gets there first. The robot that gets there second may
find nothing left.

A target that is a different place at different times is compared by place. A BIOBUZZ hive's up
cell is one target for two cells, and the other cell comes up at every tip, so a robot scoring from
the north quarter and one scoring from the south quarter score into different cells and do not
conflict. When both score into the same cell, the finding names it, such as
`hiveRedUpCell (the south cell)`.

**Fix.** Agree with your partner who takes it, and change the other auto to collect or score
somewhere else. There is no one-click fix: getting there later still takes from the same element.

### `ALLIANCE_ENVELOPE`

**Enters partner's area.** Warning.

Your robot's box enters an envelope your partner declared, while that envelope is active. An
envelope is an area a robot promises to stay inside for a time while its path is not known, for
example while it collects with vision. Passing through is allowed; it is just likely to meet them.

**Fix.** Route around the hatched area during its active time, or arrive after it ends. The
message says when it starts and stops. The same two one-click fixes as a collision find the smallest
change, in 0.1 s steps up to 10 s, that keeps your robot out of every partner envelope while it is
active, without a collision: **Delay my start**, or **Add a wait step** before the step your robot is
running when it enters. That is at most the wait until the window closes.

## Proposal findings

A proposal is a file (kind `proposal`) that lists changes to a shared auto, each with an optional
one-line comment. The team that proposes only ever holds the share's projection, so a proposal names
steps by the projection's opaque ids (`s1`, `s2`, ...) and commands and conditions by opaque tokens.
It can move poses and control points, change heading modes, speeds and timeouts, add or change
waits, reorder steps, add or remove path steps, slide markers and set envelopes. It can never name,
add or change a command.

A proposal is checked twice:

- **Before it is sent.** The proposing team checks it against the projection it was given. Any
  finding means it would be refused.
- **When the owning team reviews it.** The owner checks it against its own auto, as it is now and as
  it was when it was shared, and accepts or rejects each change on its own. A finding about a change
  the owner accepts is an **error**, and nothing is written while one is left. The same finding about
  a change the owner rejects is a **warning**, since rejecting it is already the remedy.

A finding about the whole proposal, rather than one change, has the step id `(proposal)`. A file
that is not a proposal at all is refused with a `SCHEMA` finding.

### Proposal findings never touch the robot

A proposal never deploys, never changes the robot project and cannot run anything. The owning team's
accepted changes go through the same edit and undo path as its own edits, and the review also shows
the findings `zenith validate` would give the auto with those changes. `zenith proposal validate`
exits `1` when a proposal would be refused. `zenith proposal apply` exits `1` when a proposal is
refused, an accepted change cannot be made, or the auto with the accepted changes has an error.

### `PROPOSAL_SHARE`

**Share takes no proposals.** Error.

Only a live share at the propose level takes proposed changes. This one is view only, has been
revoked, or has expired. The whole proposal is refused, and its changes are not looked at.

**Fix.** Ask the team that shared the auto for a new propose-level share file.

### `PROPOSAL_STALE`

**Made against an old version.** Error.

The proposal was made against a different version of the shared auto than the one it is checked
against. Either it names a different share or revision, or the structure it was made against no
longer matches the share's. Every proposal records the structure of the projection it was made
from, and the message names both. The whole proposal is refused, because its steps may no longer
line up.

**Fix.** Open the share again and make the changes against the version it holds now.

### `PROPOSAL_TOKEN`

**Command token not allowed.** Error or warning.

A proposal may move the share's own command and condition tokens, for example by adding a path that
carries a marker taken from a path it removes, but it may not copy one or bring in one the share did
not hold. There are two cases:

- a change holds a token the share did not hold;
- a change places a token that is still held where the share had it, so the command would run twice.

**Fix.** Remove or change the step that holds the token before placing it somewhere new, or leave the
token where it is.

### `PROPOSAL_CHANGE`

**Change does not fit.** Error or warning.

A proposed change names a step that is not there, or asks for something that step cannot do. The
message names the change by its number, counted from 1, and says which. The cases are:

- the change names a step the share does not have, or one an earlier change in the same proposal
  removed;
- it moves a pose, sets a heading or speed, or slides a marker on a step that is not a path, or
  names a segment, control point or marker that the path does not have;
- it sets a timeout on a step other than a path, command or wait step, or sets what a step waits for
  when it is not a wait;
- it removes a step other than a path or a wait, the deadline of a `parallel` group, or the only
  step in a group;
- the owner accepts a change number the proposal does not have;
- an accepted change fits only together with a change the owner rejected, for example a token that
  only the rejected change would have freed, or the edit cannot be made on the auto.

Changes are checked in order, each against the structure the changes before it leave.

**Fix.** Read the message for the step and the change. Point the change at a step of the right kind,
or drop it.

### `PROPOSAL_CONFLICT`

**Step changed since share.** Error or warning.

The step this change is about has changed in the owning team's auto since the version that was
shared, so the change cannot be applied safely. It is raised only in review, and it also covers a
step that is no longer in the auto, a step whose id more than one step now has, and a reorder among
steps that have changed. Such a change can only be rejected.

**Fix.** Reject this change. Share the auto again, and the other team can propose it against the
new version.

### `REGISTRY`

**Robot code disagrees.** Error, warning or info.

`robot.json` lists a command, condition or argument differently from what the robot's Java
registers with `NamedCommands`. It is an error when an auto made in the editor would fail when the
robot starts it:

- `robot.json` declares a command or condition that no `NamedCommands.register` or
  `registerCondition` call in the scanned Java registers (a warning instead while some
  registration's name could not be read, since it may be that one);
- the Java requires an argument, through `argInt` or an `arg*` helper with no fallback, that
  `robot.json` does not declare;
- `robot.json` offers an enum value that the Java enum has no constant for.

It is a warning when the two differ in a way that is not fatal on its own: the Java registers
something `robot.json` does not declare, so the editor cannot offer it; the types differ; a default
in `robot.json` does not match the Java's fallback, or is given for an argument the Java requires;
or `robot.json` declares an argument the factory never reads. Anything the scanner could not read,
such as a name built at run time, is listed too, with the file and line.

**Fix.** Run `zenith import-commands` to add what the Java has and `robot.json` lacks. Fix a name
that `robot.json` has and the Java does not in whichever of the two is wrong.

## Checks that need an estimate

`STRAFE_FRACTION`, `TIME_BUDGET` and `TIMEOUT_TIGHT` use the time estimate. If an estimate cannot be
made, those three are skipped and every other check still runs. See [Simulation](simulation.md) for
how the estimate is made.
