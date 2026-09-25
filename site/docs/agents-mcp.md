# Agents and MCP

An agent can author and edit a Zenith auto end to end without hand-editing JSON. That agent can be
Claude Code working inside your robot repository, or any other client that speaks the Model Context
Protocol (MCP).

Two surfaces do the same work:

- the **MCP server**, `@horizon36596/zenith-mcp` (command `zenith-mcp`), and
- the **CLI**, `@horizon36596/zenith-cli` (command `zenith`), with `--json` on every verb.

Prefer the MCP tools for anything that changes a file. The `zenith.edit.*` tools use the same
structural edit primitives as the editor, so the file stays canonical. Each one also returns the
findings for the file it just wrote, which saves a round trip.

## Setup: `.mcp.json`

Add this to your robot repository's root. Claude Code reads `.mcp.json` from there.

```json
{
  "mcpServers": {
    "zenith": {
      "command": "npx",
      "args": ["-y", "@horizon36596/zenith-mcp"]
    }
  }
}
```

If you install the packages into the repository instead, point at the installed copy:

```powershell
npm install --save-dev @horizon36596/zenith-mcp @horizon36596/zenith-cli
```

```json
{
  "mcpServers": {
    "zenith": {
      "command": "npx",
      "args": ["zenith-mcp"]
    }
  }
}
```

!!! note "PNG renders and the sim use the CLI"
    `zenith.render` with `format: "png"` and `zenith.sim` run the `zenith` CLI as a child process.
    `@horizon36596/zenith-mcp` depends on `@horizon36596/zenith-cli`, so both setups above install it
    and these tools work from `npx -y @horizon36596/zenith-mcp` too. The second setup lists the CLI
    as well so that `npx zenith` works in the repository.

### Finding the project

The server finds the project the same way `zenith validate` does. It walks up from its own working
directory looking for `zenith.json`. Start the server, or Claude Code, from inside the robot
repository.

Every tool also takes an optional `project` argument that names the project directory directly.
`zenith.project.open` takes it as `dir`. Use it when the client starts the server somewhere else, or
works across more than one project.

## The loop

1. **Open the project.** `zenith.project.open` returns the robot's footprint, its command and
   condition registry, the field's name and size, the waypoint names and the autos already in the
   project. Read it before writing anything. It is the vocabulary a command step, a marker, a branch
   or an `endCondition` may use. There is no CLI equivalent; a shell-only agent reads `zenith.json`,
   `autos/robot.json` and `autos/waypoints.json` directly.
2. **Start the file.** `zenith.edit.newAutoFromTemplate` writes a minimal skeleton that already
   validates, with the alliance and start pose you give it and one placeholder leg. From the CLI,
   `zenith new <name> --alliance RED` does the same. Both write canonical JSON directly. There is no
   draft state to reconcile.
3. **Build the routine** with the `zenith.edit.*` tools below. Once a file exists, prefer the tools
   over hand-editing. They keep ids stable, keep segments continuous and keep the file canonical, so
   the git diff stays small and reviewable.
4. **Validate after every edit.** Every `zenith.edit.*` tool already returns the new findings. Call
   `zenith.validate` when you want a fresh read without changing anything. A finding is
   `{ severity, stepId, t?, code, message, geometry? }`. The table below gives the usual fix for each
   code. The `zenith://spec/checks` resource is the full reference; read it when a message alone is
   not enough.
5. **Iterate to zero errors.** `warning` and `info` findings are worth reading but do not block.
   `error` findings do, and `zenith validate` exits `1` on any. Read a finding's `stepId` and `code`,
   call the matching `zenith.edit.*` tool, and check the findings it returns.
6. **Hand a human a picture.** `zenith.render` with `format: "svg"` or `"png"` writes the field, the
   path, footprint ghosts and findings to a file. Attach it to a pull request or send it to a
   teammate.
7. **Run the sim, when the robot repository has one.** `zenith.sim` runs `zenith.json`'s sim command
   and reports estimate against actual per step. It needs the robot repository's own build tooling
   (Gradle) where the server runs. See [Simulation](simulation.md).
8. **Compare iterations.** `zenith.diff` takes two autos and returns the added, removed, changed and
   moved steps. Use it mid-session to see what an edit did, not only for review.

## Reading tools

| tool | does |
|---|---|
| `zenith.project.open` | the robot, its registry, the field, the waypoints and the list of autos |
| `zenith.registry` | the command and condition registry from `robot.json` |
| `zenith.waypoints` | the named waypoints |
| `zenith.auto.read` | one auto, with every step's id |
| `zenith.validate` | the findings for one auto |
| `zenith.estimate` | the per-step time estimate and the total |
| `zenith.render` | writes an SVG or PNG to `out`; takes `format` and an optional `alliance` |
| `zenith.diff` | the structural diff between autos `a` and `b` |
| `zenith.sim` | runs the sim command and compares the trace with the plan |

Two resources carry the reference text:

| resource | contents |
|---|---|
| `zenith://spec/file-format` | the file format |
| `zenith://spec/checks` | the path model and every feasibility check |

## The `zenith.edit.*` tools

There is one tool per structural edit primitive. Every one:

- takes `auto` (a bare name like `"first-auto"`, a path, or an absolute path) and an optional
  `project`,
- applies one change,
- writes the canonical file back at the current `formatVersion` (3 for autos; a version 1 or 2 file is
  read and migrated),
- returns `{ written, auto, findings, errors, warnings, seasonWarnings, help }`.

`errors` and `warnings` are counts. `seasonWarnings` is a list of sentences, usually empty; see
[Seasons and `seasonWarnings`](#seasons-and-seasonwarnings). `help` gives, for each finding code
present, `{ title, means, fix }` in plain words. It is the same text the editor and
`zenith validate --explain` show, so use it when you explain a finding to a person.

### Step ids

A step is addressed by its `id`. That is the explicit `id` field when the step has one. Otherwise it
is the positional id (`step1`, `step2`, ...) that `zenith.validate`'s findings use. A step inside a
group is named under the group's id: `park.2` is the second member of the group `park`, and
`choose.1.1` and `choose.2.1` are the first steps of a branch's `then` and `else`.

Removing or inserting a sibling without an explicit id shifts the positional ids after it. For that
reason `zenith.edit.addStep` always gives a new step an explicit id. The response's `auto.steps`
shows what it got.

### Tool table

| tool | does |
|---|---|
| `addStep` | Adds a step (`step`) after `afterId`, into a group (`into: { into, index?, arm? }`), or at the end. |
| `insertAfter` | Inserts `step` right after `afterId`; a path starts where that step ends. Returns `id` and `continuityGapStepId`: the following path that now starts away from the robot, or null. |
| `repairContinuity` | Sets the path step `stepId`'s first `from` to `"current"`, clearing the gap `insertAfter` reported. |
| `wrap` | Wraps sibling steps `ids` (one unbroken run) in a new `sequence`, or in a `parallel` group with `mode`. Returns `groupId`. Every step keeps its id. |
| `unwrap` | Replaces the sequence or parallel group `id` with its members. |
| `removeStep` | Removes the step `id`. |
| `moveStep` | Moves `id` after `afterId`, into a group (`into`), or to a top-level `index`. |
| `renameStep` | Gives `id` a new explicit id, and updates a parent `parallel`'s `deadline` if it named the old one. |
| `setPose` | Sets a segment's `from` or `to`, or one Bezier control point, to a literal pose. |
| `setHeadingMode` | Replaces a path step's heading mode. |
| `setSpeed` | Sets a path step's `speedFraction`. |
| `addSegment` / `removeSegment` | Adds or removes a segment on a path step. |
| `addMarker` / `removeMarker` / `setMarkerAt` | Adds or removes a marker, or moves where it fires. |
| `setCommandArgs` | Replaces a command step's `args`. |
| `setTimeout` | Sets or clears `timeoutS` on a path, command or wait step. |
| `setStart` | Replaces the auto's `start` (pose and holds). |
| `setMeta` | Sets `title`, `description` or `authors`. `null` clears a field; leaving it out keeps it. |
| `newAutoFromTemplate` | Creates a new `<name>.auto.json`. |

Each name in the table is prefixed `zenith.edit.`, for example `zenith.edit.addStep`.

A primitive rejects a bad edit with a precise error instead of writing a broken file. The error is a
tool error result (`isError: true`) and names the problem: an id that does not exist, a step kind that
has no such field, or an edit that would leave the file invalid against the schema. The file on disk is
only written after the whole edit validates. Read the error and change the call. Do not retry the same
call unchanged.

## Groups: sequence, parallel, branch

A `sequence` runs its steps one after another and counts as one step. That is how several steps become
one member of a `parallel` group.

A common shape is a drive with an intake cycle alongside it: a `parallel` group with
`mode: "deadline"`, `deadline` naming the path, and a `sequence` of intake on, wait, intake off as its
other member. Build it with `addStep` for the group and `into` for its members, or build the steps
first and `wrap` them.

Inside a sequence, `from: "current"` is where the member before it ended. Inside a `parallel` group,
every member starts where the group started.

To add a leg in the middle of a routine, use `insertAfter`, not `addStep`. It starts the new path where
the step before it ends, and tells you which later step no longer lines up. Fix that step with
`repairContinuity`, or move its start on purpose with `setPose`.

See [Step kinds](step-kinds.md) for every step and group field.

## Finding codes and fixes

The full reference is [Checks and findings](checks-and-findings.md), or the `zenith://spec/checks`
resource. This is the short version, in the order you are likely to meet them.

| code | usual fix |
|---|---|
| [`SCHEMA`](checks-and-findings.md#schema) | A command or condition the auto uses is not in `robot.json` (`zenith.registry` lists them), a `{ "ref": name }` is not in `waypoints.json` (`zenith.waypoints`), or the JSON does not match the schema (the message names the field). |
| [`CONTINUITY`](checks-and-findings.md#continuity) | A segment's `from` is more than 0.5 in from the previous segment's `to`, or a step's first segment does not start where the previous step ended. `repairContinuity` makes the step start from `"current"`. Otherwise `setPose` the endpoint, or add a connecting segment with `addSegment`. |
| [`HEADING_MISSING`](checks-and-findings.md#heading_missing) | A path step has no `heading`. Call `setHeadingMode`; `tangent` is the usual choice on mecanum. |
| [`HEADING`](checks-and-findings.md#heading) | A `linear` heading asks one segment for more than half a turn (warning), or a `facePoint` has an `offsetRad` the runtime ignores (info). Split the path with `addSegment` so each segment turns less than half a turn. |
| [`PERIMETER`](checks-and-findings.md#perimeter) | The footprint leaves the field. Move the pose inward with `setPose`, or split the segment and route around. |
| [`STRUCTURE`](checks-and-findings.md#structure) | The footprint overlaps a solid obstacle (`geometry.obstacleId` says which, `geometry.penetrationIn` by how much). Move the path clear with `setPose` or `addSegment`, or add a Bezier control point to bow around it. |
| [`KEEPOUT`](checks-and-findings.md#keepout) | The footprint enters a zone whose rule applies during auto. Same fixes as `STRUCTURE`. |
| [`START_ILLEGAL`](checks-and-findings.md#start_illegal) | The start pose breaks a season start rule. `setStart` with a corrected pose, or reference a known-good waypoint. |
| [`LEGAL_APPROACH`](checks-and-findings.md#legal_approach) | A shoot-class command runs where the current target cannot be legally approached from. Move the step, or the path into it, outboard of the target's legal-approach band. |
| [`TURRET_RANGE`](checks-and-findings.md#turret_range) | The bearing to the target is outside the turret's range. Reposition, or turn the chassis with a `linear` or `constant` heading before the shot. |
| [`CAPACITY`](checks-and-findings.md#capacity) | The robot would hold more than `robot.json`'s `capacity.max`. Shoot or empty before collecting more, or collect fewer. |
| [`EMPTY_SHOT`](checks-and-findings.md#empty_shot) | A shoot step fires with nothing held. Add a collect step first, or check the step that should have filled the robot carries its `expect.collectFrom` hint. |
| [`STRAFE_FRACTION`](checks-and-findings.md#strafe_fraction) | A tangent-mode leg spends over 20% of its distance moving more sideways than forward. Often fine on mecanum; check that `tangent` was intended. |
| [`MOUTH_LEADING`](checks-and-findings.md#mouth_leading) | An intake is running but its mouth is not within 30° of the direction of travel. Change the heading mode so the running mouth leads, or `setCommandArgs` on the intake step or marker. |
| [`SWEEP_SPEED`](checks-and-findings.md#sweep_speed) | A path with the intake running is faster than the robot's sweep speed. Lower `speedFraction` with `setSpeed`. |
| [`TIME_BUDGET`](checks-and-findings.md#time_budget) | The estimated total is close to (warning) or over (error) the auto period. Shorten the route, raise `speedFraction` where safe, or cut a step. |
| [`TIMEOUT_TIGHT`](checks-and-findings.md#timeout_tight) | A step's `timeoutS` is under 1.2 times its own estimate. Raise it with `setTimeout`, or shorten the step. |
| [`STATIONARY_MARKER`](checks-and-findings.md#stationary_marker) | A marker fires a `stationary: true` command mid-path, which cannot run while driving. Move it to its own `command` step. |
| [`MOVES_ROBOT`](checks-and-findings.md#moves_robot) | A path follows a `movesRobot: true` command but does not start `from: "current"`. Fix the segment's `from` with `setPose`. |
| [`PROVENANCE`](checks-and-findings.md#provenance) | A pose has no provenance label. Informational. Add one when the number is more than a placeholder. |

The provenance vocabulary is MEASURED, SET BY HAND, SPEC, NEEDS MEASUREMENT, CARRIED OVER,
PLACEHOLDER, APPROX, SET FROM SIM, SET FROM EDITOR, CALIBRATED FROM SIM and CALIBRATED FROM ROBOT.

## Seasons and `seasonWarnings`

Every check that depends on the game comes from a season plugin, not from Zenith's core: `CAPACITY`,
`EMPTY_SHOT`, `MOUTH_LEADING`, `SWEEP_SPEED`, `START_ILLEGAL`, `LEGAL_APPROACH`, `TURRET_RANGE` and
the ledger. Zenith reads `field.json`'s `rules.plugin` (or its `season` name) and loads the matching
plugin. Zenith 0.1.0 ships the BIOBUZZ plugin.

When a field names no plugin, or one this build does not carry, the season checks are absent, not
wrong. The routine still validates, plans and estimates. Every affected tool result carries a
`seasonWarnings` array of full sentences saying so. The CLI also prints each one to stderr as a
`warning:` line outside `--json`.

Read `seasonWarnings` before you trust `errors: 0` on a project whose season is not recognised. It can
mean the routine is clean, or it can mean the checks that would have caught something did not run. See
[Seasons](seasons.md).

## CLI equivalents

Every reading and analysis tool has a CLI verb with `--json`, for a shell-only agent or a CI step:

```powershell
zenith validate autos/first-auto.auto.json --json
zenith validate autos/first-auto.auto.json --explain
zenith new first-auto --alliance RED --json
zenith estimate autos/first-auto.auto.json --explain --json
zenith render autos/first-auto.auto.json --png first-auto.png --json
zenith codegen autos/first-auto.auto.json --json
zenith deploy --dry-run --json
zenith diff autos/first-auto.auto.json autos/park-and-shoot.auto.json --json
zenith sim autos/first-auto.auto.json --json
zenith calibrate --write --json
zenith propose autos/first-auto.auto.json --dry-run --json
```

The [CLI reference](cli-reference.md) has every flag and the exit codes.

The `zenith.edit.*` tools have no CLI equivalent. A verb per primitive would mean twenty near-identical
flag sets. Without MCP, edit the JSON by hand between `zenith validate` calls, keep ids stable and
segments continuous, and let `zenith validate` catch mistakes.

## The `/build-auto` skill

`/build-auto` is a Claude Code skill that drives the loop above from a one-line brief, such as
"start on the left tile, collect three, score, park". It ends with a file that has zero errors, a
rendered picture and a short summary, without asking you to read a spec first. It is the short,
instruction-form version of this page.

To use it, copy `docs/skills/build-auto/SKILL.md` from the Zenith repository into your robot
repository as `.claude/skills/build-auto/SKILL.md`, or wherever your Claude Code setup keeps skills.
Configure `.mcp.json` as above.

The skill tells the agent to:

1. open the project with `zenith.project.open`, every time,
2. read the brief as constraints: a start, a sequence of actions from the registry and an end state,
   and note any assumption it makes,
3. start the file with `zenith.edit.newAutoFromTemplate`, or read an existing one with
   `zenith.auto.read`,
4. build the routine with one `zenith.edit.*` call per change, preferring waypoint references to
   literal poses,
5. read the findings each call returns,
6. fix findings cheapest first: `SCHEMA` and `CONTINUITY`, then headings, then geometry, then scoring
   rules, then motion quality, then timing, until `errors` is `0`,
7. sanity-check the total with `zenith.estimate`,
8. render a picture with `zenith.render`,
9. hand back a summary: what the auto does in order, any assumption, the final error and warning
   count, and where the picture is.

It never invents a command, condition, waypoint or number, and never declares a routine finished with
an `error` finding outstanding.
