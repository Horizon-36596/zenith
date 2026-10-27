# Autonomous paths, explained

This page is for someone who has never planned an FTC autonomous. It explains the ideas Zenith is built on, one at a time, using the BIOBUZZ field (FTC 2026-27) as the example. You do not need to know any maths beyond coordinates.

## The autonomous period

An FTC match starts with a 30 second autonomous period. The robot drives itself: nobody touches the controls. What it does in those 30 seconds is a **routine** (or an "auto"), written before the match.

A routine is a list of **steps** the robot runs in order. A step either drives somewhere (a **path**), does something with a mechanism (a **command**), waits, or groups other steps together. In Zenith each routine is one file, `<name>.auto.json`, that you can open in the editor or read as text.

## The field and its coordinates

The field is a square 144 inches (12 feet) on a side. To say where something is, Zenith uses coordinates in inches, measured from the centre of the field:

- **x** runs left to right as the audience sees the field. Positive x is to the audience's right.
- **y** runs from the audience side to the far side. Positive y is away from the audience.
- The centre of the field is `(0, 0)`. The corners are at 72 inches in each direction.

The field file for a season (`field.json`) declares this frame, so every tool, and the robot, agrees on it. On the BIOBUZZ field that file also describes where the hives, the flowers, the loading zones and the gardens are, as shapes the checks can test against, and the editor draws the field from those same shapes.

## Poses: where the robot is and which way it faces

A **pose** is a position plus a direction: `x`, `y` and a **heading**.

The heading is the direction the front of the robot points. A heading of 0° points along positive x (toward the audience's right). Headings grow counter-clockwise when you look down at the field: 90° points away from the audience, 180° toward the audience's left, and 270° (or −90°) toward the audience.

The editor shows headings in degrees. Files store them in radians, and every number in a file names its unit in its key, such as `xIn`, `yIn` and `headingRad`, so there is never a doubt what a number means.

```json
{ "xIn": -13, "yIn": -63, "headingRad": 1.5708, "provenance": "SET FROM EDITOR: starter example, against the south wall in RED's half, 4 in west of the centre line, facing the hive, so it drives straight north to scoreSouth; measure your own start tile" }
```

That pose is the `start` waypoint of the starter example: 13 inches left of centre, 63 inches toward the audience, facing away from the audience (1.5708 radians is 90°). Its provenance records an editor change; it is not a measured starting pose for your robot.

### Where a number came from

Every pose and every robot constant carries a **provenance**: a short note saying where its value came from. `MEASURED` means someone measured it on a real field or robot. `SET FROM EDITOR` means it was dragged into place in Zenith. `PLACEHOLDER` and `NEEDS MEASUREMENT` mean nobody has checked it yet. The editor shows the provenance as a small label next to the value, so an unchecked number never looks as trustworthy as a measured one.

### Named waypoints

Some poses get used again and again: a starting spot against the wall, the place in front of a flower, a shooting spot. You can give a pose a name in `waypoints.json` and refer to it from any routine, such as `{ "ref": "scoreSouth" }`. The team measures it once on the field, and every auto that uses it picks up the measured value. The waypoint belongs to the project rather than to one path, so it outlives any path that uses it; many planners keep each point inside a single path instead. See [Waypoints explained](editor.md#waypoints-explained).

## The two alliances

In BIOBUZZ the field is point-symmetric: the blue half is the red half rotated half a turn around the centre. You plan a routine once, for one alliance, and the robot mirrors it for the other alliance at match time. The editor can show the mirrored version (`A`) so you can check it, but you always edit one side.

## Paths

A **path chain** step drives the robot from one pose to another. It is made of one or more **paths**, followed as one. Each path has a start and an end, and is either a straight line or a curve. The file calls the step `path` and its paths `segments`; in Pedro Pathing v3 the chain is `Paths.path(p1, …, pn)`, called a `PathChain` in Pedro 1.x and 2.x.

A path's start is usually `"current"`, which means "wherever the robot is when this step begins". That keeps a routine joined up when you move an earlier step.

Inside a chain, a later path's start can be `"current"` too, which means "where the path before it ends". The editor writes it that way when you add or remove a path in the chain, so the point where two paths meet can never come apart.

### Curves and control points

A curved path is a **Bezier curve**. Besides its start and end, it has one to three **control points**.

A control point is not a place the robot drives through. It pulls the curve toward itself, like a magnet bending a wire. Put a control point off to the side of a straight line and the line bows toward it. The curve leaves its start heading toward the first control point and arrives at its end coming from the last one. More control points give you more say over the shape.

In the editor, control points are the hollow squares joined to the path by thin lines. They appear when the path's step is selected.

- A **smooth** point keeps the two handles on either side of it in a straight line, so the path flows through without a kink.
- A **corner** point lets the two handles move independently, so the path can change direction sharply.

To make a curve from a straight path, right-click it on the field and choose **Make curve**, or set the path's **Kind** to **Curve** in the inspector. The new curve has one control point, in the middle of the line, so at first it is exactly the straight line; drag the hollow square to bend it. **Make straight line** turns it back.

!!! tip "Why not just drive straight lines?"
    A straight line from a flower to a hive may cut through a field element, or leave the robot facing
    the wrong way at the end. A gentle curve can go round the obstacle and arrive already lined up,
    which is usually faster than driving, stopping, and turning.

## Heading modes

A path says where the robot drives. The **heading mode** says which way it faces while it does. On a mecanum robot these are independent: the robot can drive in one direction while facing another. The editor names each mode the way Pedro Pathing does, and hovering a mode shows what it means and the Pedro call the robot makes.

Tangent (`path.tangent()`)
:   The robot faces the way it is driving, like a car. The front follows the path. This is the usual choice, and it is the one to use when an intake at the front needs to meet game pieces head-on.

Reverse tangent (`path.reverseTangent()`)
:   The robot faces directly away from the way it is driving, so it drives backwards along the path. Use it when the mechanism you care about is at the back.

Constant (`path.constant(heading)`)
:   The robot keeps one heading for the whole path, whatever direction it drives. Good for short sideways moves where turning would waste time.

Linear (`path.linear(start, end)`)
:   The robot turns smoothly from a starting heading to an ending heading over the length of the path. Use it to arrive facing a target without stopping to turn. On a curve, Pedro paces the turn by the curve's own parameter rather than its length, so the turn can run a little ahead or behind; the editor draws it where the robot does it.

Facing point (`path.facingPoint(point)`)
:   The robot keeps turning so its front points at one spot on the field while it drives, such as the centre of a hive. Useful when a mechanism must stay aimed at something.

Piecewise (`Interpolator.piecewise().until(t, ...)`)
:   The path is split into stretches, and each stretch has its own mode from the list above. For example, hold one heading while backing off a wall for the first 40% of the path, then turn to face the hive for the rest. The stretches are measured as a fraction of the path, from 0 at the start to 1 at the end, and together they must cover the whole path. Drag the ticks on the path, or the lines on the inspector's track, to move where one stretch ends and the next begins.

!!! note "Driving sideways costs time"
    Mecanum wheels drive sideways (strafing) more slowly than forwards. Zenith shows how much of each
    path is driven sideways and warns when it adds up, because a heading mode that keeps the robot
    nose-first is often quicker.

## Commands

A **command** is an action from the robot's own code: run the intake, stop it, launch a game piece, raise an arm. Zenith does not know how your mechanisms work. Instead, the robot file (`robot.json`) lists the commands your code provides, with their names, any settings they take, and roughly how long each one runs. The editor offers those names; your robot code supplies the behaviour.

A **command step** runs one command and waits until it finishes before the next step starts. For example, a routine on BIOBUZZ might drive to a flower, run a command that collects pollen, then drive to a launching spot.

Other step kinds build on this:

- **Wait** pauses for a number of seconds, or until a sensor condition the robot declares becomes true.
- **Parallel** runs several steps at once, such as driving while the intake spins. It can end when all of them finish, when the first one finishes (a **race**), or when one chosen step finishes (a **deadline**).
- **Sequence** chains steps into one block, which is useful as one lane of a parallel group.
- **Branch** runs one set of steps if a condition is true and another if it is not, such as skipping a pickup when the robot is already full.

[Step kinds](step-kinds.md) covers each of these in full.

## Markers

A **marker** is a command that fires partway along a path, without the robot stopping. You place it at a point on the path; when the robot passes that point, the command starts.

Markers are how a routine saves time. Instead of driving to a flower, stopping, starting the intake, and then collecting, you put an "intake on" marker two thirds of the way along the approach, so the intake is already running when the robot arrives.

A marker's position can be given as a fraction of the way along the path, as a distance from the start, or as a distance before the end. On the field, markers are small pins on the path; drag one to move it.

Some commands only make sense while the robot is standing still. Zenith knows which ones from the robot file and warns if one of them is placed as a marker on a moving path.

## Why paths get checked

A path that looks fine on screen can fail on the real field. Zenith checks every routine after every edit and lists what it finds in the Problems panel, worst first. The checks answer three questions.

**Does it fit the field?** The robot is drawn at its real footprint, including any intake that sticks out. Zenith tests that outline along the whole path against the field walls and against every solid field element, such as the hives and the flower bases on BIOBUZZ. It also checks zones the game rules restrict during autonomous, and that the starting pose is one the rules allow.

**Does it fit the time?** Zenith estimates how long each step takes from the robot's speed and acceleration limits, and adds them up against the 30 second period. The timeline shows which steps take the longest. A step whose timeout is barely longer than its estimate is flagged, because a slightly slow run would be cut off.

**Can the robot do it?** Some problems only show up when you follow the game pieces. Zenith keeps a **ledger** of what the robot is holding after each step: pollen collected from a flower, pollen launched into a hive. From that it catches a launch with nothing loaded, a robot carrying more than it can hold, an intake running while the robot drives too fast to pick anything up, or an intake that is not at the front of the robot while it is collecting.

Each finding is a plain sentence with a short code, such as `PERIMETER` (part of the robot would leave the field) or `STRUCTURE` (the robot would hit a field element). Hover the code in the editor for what it means and how to fix it. [Checks and findings](checks-and-findings.md) lists every code.

!!! note "Estimates, not promises"
    The checks and the built-in preview use the numbers in the robot and field files. When those are
    placeholders, the results are only as good as the placeholders. Measuring the robot and the field
    replaces guesses with real values, and Zenith labels which is which.

## The BIOBUZZ example, in one picture

Put together, a full BIOBUZZ routine reads like this. It is `collect-and-score.auto.json` from the starter example, the auto the app opens with:

1. **Start** against your alliance's wall at the `start` waypoint, holding four pollen.
2. **Path** `driveOut`, a straight line to `scoreSouth`, a legal scoring spot south of your hive, heading mode tangent.
3. **Command** `shootPreloads`: `score` all four pollen into the hive's up cell. It starts with 3 nectar, so 3 pollen tip it: the first volley tips the hive, and the up cell is now the north one.
4. **Path** `toOtherSide`, round the west side of the hive frame and on to `flowerNorthApproach`, because a launch only scores from the up cell's own quarter of the field. Under the hive, between the frame's west legs and the centre line, an 18 in robot has a fraction of an inch to spare, and a robot past the centre line during auto breaks G402, which [`OPPONENT_SIDE`](checks-and-findings.md#opponent_side) reports as an error.
5. **Path** `collectFlower`, slowly up to the flower on the north wall, with a marker that starts the intake as it sets off and an end condition that stops it once the robot is full. **Wait** `waitForFull` gives the intake up to one more second, then **command** `stopIntake` runs `intakeOff`.
6. **Path** `toScoreNorth`, backing off the flower to `scoreNorth`, then **command** `scoreFlowerPollen` puts four pollen into the north cell, half of the 8 an empty cell needs.
7. **Path** `toGarden` back round the west side of the frame to the RED garden line, turning to face west as it comes down to the wall, and **path** `sweepGarden` west along it with the intake running.
8. **Parallel** `returnToScore`: drive back to `scoreNorth` backwards while the launcher spins up, then **command** `scoreGardenPollen` puts in four more, and the hive tips a second time.

Step 7's sweep in the file:

```json
{
  "id": "sweepGarden",
  "kind": "path",
  "segments": [
    { "kind": "line", "from": "current", "to": { "ref": "gardenSweepEnd" } }
  ],
  "heading": { "mode": "constant", "headingRad": 3.1416 },
  "speedFraction": 0.3,
  "markers": [
    { "at": { "t": 0 }, "command": { "name": "intakeOn" } }
  ],
  "endCondition": { "condition": "hopperFull" },
  "expect": { "collectFrom": "gardenRed", "count": 4 }
}
```

The ledger tracks the pollen and the two tips through steps 3, 5, 6, 7 and 8, the checks test the robot outline along each path against the hive and the flowers, and the timeline adds the steps up against 30 seconds. When the Problems panel is empty, the plan fits the field, the time and the robot, as far as the robot and field files describe them.
