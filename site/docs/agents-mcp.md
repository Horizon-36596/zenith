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

`zenith setup` (below) writes this for you. To add it by hand, put this in your robot repository's
root. Claude Code reads `.mcp.json` from there.

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

## Connect to GitHub

An agent can take a robot repository from a fresh clone to an open pull request with no setup by
hand. The only thing a person does first is sign the GitHub CLI in, once per computer:

```powershell
gh auth login
```

Then give the agent one line, from inside the clone:

```text
Set up Zenith in this repo with npx -y @horizon36596/zenith-cli setup, then build the auto I describe and propose it as a pull request.
```

The agent runs three steps:

1. **`zenith setup`** (MCP: `zenith.setup`). It runs `zenith init` when there is no `zenith.json`,
   adds the Zenith server to `.mcp.json` and keeps every other server there, checks that `origin` is
   a github.com repository and that a GitHub sign-in works, checks that `zenith.json` is on the
   default branch, and validates every auto. It is safe to run again; it never overwrites a file and
   never commits. After it adds the server, restart the agent so it loads the `zenith.*` tools.
2. **Edit** with the `zenith.edit.*` tools, as in [the loop](#the-loop).
3. **`zenith propose <auto>`** (MCP: `zenith.propose`). It does what the editor's **Propose** button
   does (see [Working with GitHub](github.md#propose-a-pull-request-that-reviews-itself)): validate,
   commit the auto, any changed waypoints and the rendered SVG to `auto/<auto>/<login>`, merge the
   base in, push, and open or update the pull request. Run it again after more edits to update the
   same pull request.

`zenith github status` (MCP: `zenith.github.status`) says where things stand at any point.

Every result that is not ready has `next`, the one thing to do about it, such as "Run `gh auth
login` ..." or "Fix the errors in first-auto ...". An agent reads `next` and does it, or asks a
person to when it needs one (signing in, or write access to the repository).

### Sign-in

Zenith looks for a GitHub sign-in in this order:

1. the `GH_TOKEN` environment variable,
2. the `GITHUB_TOKEN` environment variable,
3. `gh auth token`, when the GitHub CLI is installed and signed in to github.com.

With none of them, the result says how to get one: `gh auth login`, or a fine-grained personal access
token with **Contents** and **Pull requests** set to *Read and write* on the robot repository, in
`GH_TOKEN`. The token is never printed, logged or written to a file, and it is only ever sent to
`api.github.com`. Results name where it came from (`auth`), never the token itself.

`zenith propose` pushes with git, using git's own credentials, not the token. If git cannot push,
the result says to run `gh auth setup-git`, which lets git use the GitHub CLI's sign-in. git is run so
that it never stops to ask for a password; it fails with that step instead.

### Safety

- Nothing is ever written to the base branch, and nothing is force-pushed. If someone else pushed to
  the work branch meanwhile, propose merges it in; if both sides changed and cannot be joined, it
  stops and says how to bring them together.
- Propose commits only under the directories `zenith.json` declares (`autosDir`, the deploy directory
  and the codegen directory). That is why `zenith.json` itself has to be on the base branch first;
  `zenith setup` checks this and says how when it is not.
- Propose builds its commits without touching your checkout: the files you are editing, the branch
  you are on and what you have staged stay as they are. When the work branch is the one checked out,
  it moves forward to the new commit, like `git pull`.
- An error finding blocks a proposal, and a merge conflict with the base stops it and names the files.

### GitHub tools

| tool | inputs | returns |
|---|---|---|
| `zenith.setup` | `project`, a directory in the clone | `{ ok, root, init, mcp, github, projectOnGitHub, autos, notes, next }`. `init` is `{ ran, written }`; `mcp` is `{ path, status }` with `status` one of `written`, `added`, `kept` or `invalid` (a `.mcp.json` that is not JSON is left alone); `github` is what `zenith.github.status` returns; `autos` lists each auto's `{ name, path, errors, warnings }`. Same as [`zenith setup`](cli-reference.md#zenith-setup). |
| `zenith.github.status` | `project` | `{ ok, repo, defaultBranch, login, auth, canPush, branch, pullRequest, error, next }`: `repo` is `{ owner, repo, fullName, url }` read from `origin`, `auth` is `GH_TOKEN`, `GITHUB_TOKEN` or `gh`, `branch` the checked-out branch and `pullRequest` its open pull request `{ number, url, base, head }`. A field is `null` until it is known. Same as [`zenith github status`](cli-reference.md#zenith-github-status). |
| `zenith.propose` | `auto`; `base`, default the repository's default branch; `branch`, default `auto/<auto>/<login>`; `summary`, the commit summary, default `edit`; `reviewers`, GitHub logins; `dryRun`, default `false`; `project` | `{ ok, auto, repo, base, branch, login, commit, mergedBase, files, pushed, pullRequest, errors, warnings, seasonWarnings, next }`, where `pullRequest` is `{ number, url, created }` and `commit` is `null` when the branch already had these files. An auto with an error gives `{ ok: false, findings, errors, warnings, help, next }`. Anything else that stops it is a tool error with `{ error, next }`, and `files` for a merge conflict. With `dryRun`, `{ render, body, seasonWarnings }`. Same as [`zenith propose`](cli-reference.md#zenith-propose). |

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
| `zenith.validate` | the findings for one auto, or for an interchange `trajectory.json` or `path.json` given by its path (see [Bring paths from other planners](import.md)) |
| `zenith.estimate` | the per-step time estimate and the total |
| `zenith.optimize` | Optimize path on one path step (`stepId`): a faster route between its own two ends, as an `OptimizeResult`. It never writes. Takes the CLI's options (`marginIn`, `budget`, `scorer`, `mode`, `allowSplit`, `allowRanges`, `maxPaths`). When the step goes through something, `originalBlocked` says what and the pick is the fastest clear route, even a slower one. Apply its pick with `setRoute` |
| `zenith.render` | writes an SVG or PNG to `out`; takes `format` and an optional `alliance` |
| `zenith.diff` | the structural diff between autos `a` and `b` |
| `zenith.sim` | runs the sim command and compares the trace with the plan |
| `zenith.alliance` | the predicted alliance findings between one auto and partners' shared projection files, and the editor's two fixes for each collision, near miss and envelope entry: the smallest start delay and the smallest wait step that clear it; never part of `zenith.validate` |
| `zenith.import` | imports a `.pp` project, a `path.json` or a `trajectory.json` as an auto or a projection, and writes it only when given `out` |
| `zenith.projection` | a share file of one auto, its projection, built with no account and no network, and written only when given `out` |
| `zenith.importCommands` | `robot.json` checked against the robot's Java: the commands, conditions and params it lacks, every disagreement, and the lines that would change; writes `robot.json` only when `write` is true (see [Commands from the robot's code](robot-runtime.md#commands-from-the-robots-code)) |

## Showing the project in the desktop app

`zenith.app.open` opens the project, and optionally one auto, in the Zenith desktop app on the
computer the server runs on, so the person at it can see what you are working on. It starts the app,
or reaches the copy already running, which opens the folder as if it had been picked in File > Open
robot repo. If that window has unsaved edits, it asks the person before replacing them.

| tool | inputs | returns |
|---|---|---|
| `zenith.app.open` | `auto`, the auto to open first, by name or file name, optional; `project` | `{ opened, root, auto }`. An error, with nothing started, when the folder has no `zenith.json`, the auto is not in its autos folder, or the desktop app is not installed. Same as [`zenith open`](cli-reference.md#zenith-open). |

The desktop app is Windows only. The tool looks for it where the installer puts it, for this user or
for everyone. If it is installed somewhere else, set `ZENITH_DESKTOP` to the full path of `Zenith.exe`
in the server's environment. The tool reads nothing back from the app, and the app writes nothing
until the person saves.

## Alliance and proposal tools

These tools read files another team gave you: a partner's projection, or a proposal made against
one of your shares. Every file they read must be inside the project, given by a path relative to
the project root or an absolute path inside it. Each one returns what the matching CLI verb prints
under `--json`.

| tool | inputs | returns |
|---|---|---|
| `zenith.alliance` | `auto`; `projections`, one or more partner projection files; `offsetS`, the seconds your robot waits at its start pose, zero or more, default `0`; `project` | `{ auto, alliance, offsetS, partners, findings, errors, warnings, clearingOffset?, clearingOffsets, clearingWaits, help }`. `clearingOffsets` has, for each of `ALLIANCE_COLLISION`, `ALLIANCE_NEAR_MISS` and `ALLIANCE_ENVELOPE` found, the smallest start delay that clears every finding of that code without a collision: `{ offsetS }`, or `null` when no delay up to 10 s does. `clearingOffset` is its collision entry, there only when a collision is predicted. `clearingWaits` has one `{ findingIndex, code, wait }` for each finding of those codes, where `wait` is `{ stepId, seconds }`, the smallest wait to put before step `stepId` (add it with `zenith.edit.addStep`), or `null` when none up to 10 s clears it or the finding names no step. Same as [`zenith alliance`](cli-reference.md#zenith-alliance). |
| `zenith.proposal.validate` | `proposal`, the proposal file; `projection`, the propose-level projection file it was made from; `share`, one of `live`, `revoked` or `expired`, default `live`; `project` | `{ proposal, projection, share, ok, changes, findings, errors, help }`. `ok` is true when the proposal can be sent. Same as [`zenith proposal validate`](cli-reference.md#zenith-proposal-validate). |
| `zenith.proposal.apply` | `auto`, your auto; `proposal`; `base`, the auto as it was at the revision the share is pinned to, default `auto`; `accept`, `"all"` or an array of change numbers from 1, default `"all"`; `share`, default `live`; `write`, default `false`; `project` | `{ auto, base, proposal, accepted, changes, findings, errors, warnings, diff, validation, written, notWritten?, proposed, help }`. Each entry of `changes` has a `status`: `applied`, `notAccepted`, `conflict`, `invalid` or `refused`. `proposed` is the auto with the accepted changes, and `validation` is its findings. Same as [`zenith proposal apply`](cli-reference.md#zenith-proposal-apply), plus `warnings`, `notWritten` and `proposed`. |

`zenith.proposal.apply` never writes unless `write` is `true`. Then it needs `accept`, and it
writes the auto in canonical form only when no accepted change is a conflict or invalid; otherwise
`written` is `null` and `notWritten` says why. The alliance and proposal findings are explained on
[Checks and findings](checks-and-findings.md#alliance-findings), and none of them is ever part of
`zenith.validate`.

## Import and share-file tools

These two tools turn files into files. Neither writes anything unless it is given `out`, a path
inside the project, and neither overwrites an existing file unless `force` is `true`. Each returns
what the matching CLI verb prints under `--json`. `zenith.validate` checks an interchange file
without importing it.

| tool | inputs | returns |
|---|---|---|
| `zenith.import` | `file`, a `.pp` project, a `path.json` or a `trajectory.json` inside the project; `out`; `name`, the auto's name, default the file's own; `alliance`, `RED` or `BLUE`, for a `.pp` file; `pedroCentreIn`, the visualizer's field centre in its own inches, default `70.75`, for a `.pp` file; `asAuto`, for a `trajectory.json`, default `false`; `force`; `project` | For an auto, `{ kind, written, auto, robotFootprint?, findings, errors, warnings, help }`: `findings` are what `zenith.validate` would say of the new auto, and they do not stop the import. For a trajectory without `asAuto`, `{ kind, written, projection, warnings }`, a view projection that `zenith.alliance` reads. A file that cannot be imported is an error naming every wrong field. Same as [`zenith import`](cli-reference.md#zenith-import), plus `errors` and `help`. |
| `zenith.projection` | `auto`; `level`, `view` or `propose`, default `view`; `title`, default none; `coarsen`, default `false`; `includeCommands`, default `false`, adds the `commands` list naming each command token and its arguments; `out`; `force`; `project` | `{ auto, level, written, bytes, projection, seasonWarnings }`, byte for byte the file the editor's **Download share file** gives. For an auto with an error, `{ auto, written: null, notWritten, findings, errors, warnings, help }` and nothing is built. Same as [`zenith projection`](cli-reference.md#zenith-projection). |

See [Bring paths from other planners](import.md) for what an import maps and warns about.

## Commands from the robot's Java

`zenith.importCommands` reads the robot's own Java and Kotlin, finds every `NamedCommands.register`
and `registerCondition` call and the arguments each factory reads, and compares them with
`robot.json`. It writes nothing unless `write` is `true`, and it never reads outside the project.

| tool | inputs | returns |
|---|---|---|
| `zenith.importCommands` | `dirs`, directories or files of the robot's Java or Kotlin inside the project, default the whole project with build output and test sources skipped; `write`, default `false`; `project` | `{ robot, filesScanned, commands, conditions, changes, findings, written, diff, reformats, errors, warnings }`: `commands` and `conditions` are what the Java registers, `changes` what would be added to `robot.json`, `findings` every remaining disagreement and everything the scanner could not read, with the file and line. Same as [`zenith import-commands`](cli-reference.md#zenith-import-commands). |

## Resources

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
- writes the canonical file back at the current `formatVersion` (4 for autos; a version 1, 2 or 3 file
  is read and migrated),
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

An explicit id follows the waypoint name rule: it starts with a letter and holds only letters,
digits, `_` and `-`, at most 64 characters. `zenith.edit.addStep`, `zenith.edit.insertAfter` and
`zenith.edit.renameStep` refuse any other id with the reason. A file with an older id outside the rule still loads, and `zenith.validate` reports it as a
[`STEP_ID`](checks-and-findings.md#step_id) warning.

### Tool table

| tool | does |
|---|---|
| `addStep` | Adds a step (`step`) after `afterId`, into a group (`into: { into, index?, arm? }`), or at the end. A step given an `id` outside the step id rule is refused with the reason. |
| `insertAfter` | Inserts `step` right after `afterId`; a path starts where that step ends. Returns `id` and `continuityGapStepId`: the following path that now starts away from the robot, or null. A step given an `id` outside the step id rule is refused with the reason, as with `addStep`. |
| `repairContinuity` | Sets the path step `stepId`'s first `from` to `"current"`, clearing the gap `insertAfter` reported. |
| `wrap` | Wraps sibling steps `ids` (one unbroken run) in a new `sequence`, or in a `parallel` group with `mode`. Returns `groupId`. Every step keeps its id. |
| `unwrap` | Replaces the sequence or parallel group `id` with its members. |
| `removeStep` | Removes the step `id`. A deadline `parallel` whose deadline was that step passes it to its first remaining step that drives, or its first step. |
| `moveStep` | Moves `id` after `afterId`, into a group (`into`), or to a top-level `index`. Moving a deadline group's deadline out of it passes the deadline on, as `removeStep` does. |
| `renameStep` | Gives `id` a new explicit id, and updates a parent `parallel`'s `deadline` if it named the old one. The new id starts with a letter and holds only letters, digits, `_` and `-`, at most 64 characters; any other is refused with the reason. |
| `setPose` | Sets a segment's `from` or `to`, or one Bezier control point, to a literal pose. With `joint: true`, a point where two segments meet moves as one point, as in the editor: the other end of the joint gets the same pose. A control point is written without a heading. |
| `setHeadingMode` | Replaces a path step's heading mode. |
| `setRoute` | Replaces a path step's `segments` and `heading` together and nothing else; this is how a route from `zenith.optimize` is applied (pass its `step.segments` and `step.heading`). The route must keep both ends of the step exactly as written. One that moves an end is refused with a message naming both, and nothing is written. |
| `setSpeed` | Sets a path step's `speedFraction`. |
| `addSegment` / `removeSegment` | Adds or removes a segment on a path step, as written; neither rejoins the path. |
| `appendSegment` / `removeSegmentJoined` / `joinSegmentsAt` | The editor's path chain edits, which keep the step joined: add a 24 in line from `"current"` at the end, remove the segment at `segmentIndex` (the next one then starts from `"current"`), or merge the two segments that meet at point `nodeIndex` (1 joins segments 0 and 1). Markers and piecewise ranges keep their distance along the unchanged part; `movedMarkers`, `movedRanges` and `droppedWaypoints` say what changed. |
| `joinSteps` | The editor's Join with next path: joins the path step `nextStepId` (by default the step straight after `stepId`) onto the end of `stepId` as one path step, its first segment starting from `"current"`. Two different headings become a `piecewise` heading split at the joint, and each marker keeps its distance along its own step. Refused, with the reason, unless the two are path steps one after the other that agree on `speedFraction`, `endCondition` and `timeoutS`. |
| `addMarker` / `removeMarker` / `setMarkerAt` | Adds or removes a marker, or moves where it fires. |
| `setCommandArgs` | Replaces a command step's `args`. |
| `setTimeout` | Sets or clears `timeoutS` on a path, command or wait step. |
| `setEnvelope` | Gives a path, command or wait step an [`envelope`](file-format.md#envelope) (`polygon`, `maxDurationS`, an optional what-if `actualDurationS`, `provenance`), or removes it when `envelope` is left out or `null`. |
| `setEnvelopeCorner` / `addEnvelopeCorner` / `removeEnvelopeCorner` | Moves the envelope corner at `cornerIndex`, adds one at the middle of the edge after `afterIndex`, or removes one. An envelope keeps 3 to 32 corners. |
| `setRejoinFrom` | Sets or clears the [`rejoinFrom`](file-format.md#rejoinfrom) pose of a path that starts from `"current"`, used after a command that moves the robot. |
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
| [`CONTINUITY`](checks-and-findings.md#continuity) | A segment's `from` is more than 0.5 in from the previous segment's `to`, or a step's first segment does not start where the previous step ended. `repairContinuity` makes the step start from `"current"`, and a step-start gap carries it as a `startFromCurrent` fix ("Start from where the robot is"). Otherwise `setPose` the endpoint (with `joint: true`, where two segments meet, so the other end goes with it), or add a connecting segment with `addSegment`. |
| [`HEADING_MISSING`](checks-and-findings.md#heading_missing) | A path step has no `heading`. Call `setHeadingMode`; `tangent` is the usual choice on mecanum. |
| [`HEADING_RANGES`](checks-and-findings.md#heading_ranges) | A `piecewise` heading's ranges leave a gap or overlap, or do not run from 0 to 1. Replace the heading with `setHeadingMode`, giving ranges that each start where the one before ends. |
| [`HEADING`](checks-and-findings.md#heading) | A `linear` heading asks one segment for more than half a turn (warning), or a `facePoint` has an `offsetRad` the runtime ignores (info). Split the path with `addSegment` so each segment turns less than half a turn. The warning carries a `splitSegment` fix: its `params` give the `segmentIndex`, the cuts as `atFractions` of that segment's arc length, and the segment's resolved ends as `fromIn` and `toIn`; on a `piecewise` range it carries `splitHeadingRange` with `rangeIndex` and `parts`. Core's `applyFix` carries out either. |
| [`PERIMETER`](checks-and-findings.md#perimeter) | The footprint leaves the field. `geometry.penetrationIn` says how far out the robot goes at its worst, `geometry.poseIn` where that is and, on a path, `geometry.tRange` the stretch outside. Move the pose inward with `setPose`, or split the segment and route around. When the robot turns against the wall as the path starts, the finding carries a `linearHeading` fix ("Turn while driving"): `setHeadingMode` with `{ mode: "linear", fromRad, toRad }` from its `params`. Where the robot is deepest at the path's end, an inline pose, and the path checked again with that end moved is clear, the finding carries a `pushBack` fix: `setPose` that end to the `xIn` and `yIn` in its `params`, keeping its heading. |
| [`STRUCTURE`](checks-and-findings.md#structure) | The footprint overlaps a solid obstacle (`geometry.obstacleId` says which, `geometry.penetrationIn` how far the robot would have to move to clear it, and on a path `geometry.tRange` and `geometry.contactIn` the stretch it stays in contact over). Move the path clear with `setPose` or `addSegment`, or add a Bezier control point to bow around it. On a path step the finding also carries an `optimizeRoute` fix ("Route around <label>", with `params.obstacleId`), which writes nothing and only asks the editor to open Optimize path in Route around mode; `PERIMETER`, `CLEARANCE` and `KEEPOUT` carry it too, and `STRAFE_FRACTION` carries one with `params.mode: "headingOnly"`. Where the robot is deepest at the path's end, an inline pose, and the path checked again with that end moved is clear, the finding carries a `pushBack` fix: `setPose` that end to the `xIn` and `yIn` in its `params`, keeping its heading. `params.clearOf` names the obstacle. |
| [`KEEPOUT`](checks-and-findings.md#keepout) | The footprint enters a zone whose rule applies during auto. Same fixes as `STRUCTURE`. |
| [`OPPONENT_SIDE`](checks-and-findings.md#opponent_side) | During auto the footprint, mouths included, goes past the centre line into the other alliance's side (BIOBUZZ G402); an error. `geometry.penetrationIn` says how far over, `geometry.poseIn` where it is worst and, on a path, `geometry.tRange` the stretch over the line. Move the path back onto your own side with `setPose`/`addSegment`; on a path step the finding carries an `optimizeRoute` fix ("Route around the centre line"). |
| [`START_ILLEGAL`](checks-and-findings.md#start_illegal) | The start pose breaks a season start rule. `setStart` with a corrected pose, or reference a known-good waypoint. |
| [`LEGAL_APPROACH`](checks-and-findings.md#legal_approach) | A shoot-class command runs where the current target cannot be legally approached from. Move the step, or the path into it, outboard of the target's legal-approach band. When a legal spot nearby leaves the auto no worse, the finding carries a `moveToLegalApproach` fix ("Move to approach"): `setPose` the end of the path before the shot to the `xIn` and `yIn` in its `params` with `headingRad`, and, when `params.heading` is there, `setHeadingMode` with it, the leg's heading turned to end at `headingRad`. `params.aim` is `"fixed"` (the same side of the robot faces the target) or `"turret"` (the target in the turret's range), and `params.addsWarning`, when set, is the warning the move adds. |
| [`TURRET_RANGE`](checks-and-findings.md#turret_range) | The bearing to the target is outside the turret's range. Reposition, or turn the chassis with a `linear` or `constant` heading before the shot. |
| [`CAPACITY`](checks-and-findings.md#capacity) | The robot would hold more than `robot.json`'s `capacity.max`. Shoot or empty before collecting more, or collect fewer. |
| [`EMPTY_SHOT`](checks-and-findings.md#empty_shot) | A shoot step fires with nothing held. Add a collect step first, or check the step that should have filled the robot carries its `expect.collectFrom` hint. |
| [`LAUNCH_TARGET`](checks-and-findings.md#launch_target) | A step's `expect.launchesInto` names something that is not a target on the field, so the ledger lands the pieces loose. Set it to the target the message names, or remove it so the step launches at the current target. |
| [`STRAFE_FRACTION`](checks-and-findings.md#strafe_fraction) | A tangent-mode leg spends over 20% of its distance moving more sideways than forward. Often fine on mecanum; check that `tangent` was intended. `geometry.tRange` spans the sideways driving, and `geometry.tRanges` lists each stretch when there is more than one. |
| [`MOUTH_LEADING`](checks-and-findings.md#mouth_leading) | An intake is running but its mouth is not within 30° of the direction of travel. Change the heading mode so the running mouth leads, or `setCommandArgs` on the intake step or marker. |
| [`SWEEP_SPEED`](checks-and-findings.md#sweep_speed) | A path with the intake running is faster than the robot's sweep speed. Lower `speedFraction` with `setSpeed`. |
| [`TIME_BUDGET`](checks-and-findings.md#time_budget) | The estimated total is close to (warning) or over (error) the auto period. Shorten the route, raise `speedFraction` where safe, or cut a step. The info note on `total` needs no fix: it says why the total is a bound and lists the steps it names in `stepIds`. |
| [`TIMEOUT_TIGHT`](checks-and-findings.md#timeout_tight) | A step's `timeoutS` is under its own estimate (warning: the robot stops it there, and the message says where) or under 1.2 times it (info). Raise it with `setTimeout` to the fix's value, 1.2 times the estimate rounded up to 0.1 s, or shorten the step. |
| [`WAIT_NO_TIMEOUT`](checks-and-findings.md#wait_no_timeout) | A `wait` with `until` has no `timeoutS`, so it may wait for the rest of the period. Ask the person how long the robot may wait and set it with `setTimeout`; do not pick a number yourself. |
| [`STATIONARY_MARKER`](checks-and-findings.md#stationary_marker) | A marker fires a `stationary: true` command mid-path, which cannot run while driving. Move it to its own `command` step. |
| [`MOVES_ROBOT`](checks-and-findings.md#moves_robot) | A path follows a `movesRobot: true` command but does not start `from: "current"`. Fix the segment's `from` with `setPose`. The finding carries a `startFromCurrent` fix ("Start from where the robot is"), which is `repairContinuity` on its `stepId`. |
| [`PROVENANCE`](checks-and-findings.md#provenance) | A pose has no provenance label. Informational. Add one when the number is more than a placeholder. |
| [`STEP_ID`](checks-and-findings.md#step_id) | An explicit step id has a space or a character an id cannot hold, or does not start with a letter (warning). It carries a `renameStep` fix whose `params.newId` is an id inside the rule; call `renameStep` with it, which also updates a `deadline` that named the old id. Core's `applyFix` carries it out. |
| [`ENVELOPE_SHAPE`](checks-and-findings.md#envelope_shape) | A step's envelope is not one simple polygon. Fix the corners with `setEnvelopeCorner`, `addEnvelopeCorner` or `removeEnvelopeCorner`, or remove it with `setEnvelope`. |

The `ALLIANCE_*` codes come only from `zenith.alliance` and the `PROPOSAL_*` codes only from the
proposal tools. See [Alliance findings](checks-and-findings.md#alliance-findings) and
[Proposal findings](checks-and-findings.md#proposal-findings).

The provenance vocabulary is MEASURED, SET BY HAND, SPEC, NEEDS MEASUREMENT, CARRIED OVER,
PLACEHOLDER, APPROX, SET FROM SIM, SET FROM EDITOR, CALIBRATED FROM SIM and CALIBRATED FROM ROBOT.

## Seasons and `seasonWarnings`

Every check that depends on the game comes from a season plugin, not from Zenith's core: `CAPACITY`,
`EMPTY_SHOT`, `MOUTH_LEADING`, `SWEEP_SPEED`, `START_ILLEGAL`, `OPPONENT_SIDE`, `LEGAL_APPROACH`,
`TURRET_RANGE`, `LAUNCH_TARGET` and the ledger. Zenith reads `field.json`'s `rules.plugin` (or its `season` name) and loads the matching
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
zenith setup --json
zenith github status --json
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
zenith propose first-auto --json
zenith propose autos/first-auto.auto.json --dry-run --json
zenith alliance first-auto partners/partner.projection.json --json
zenith proposal validate proposal.json partner.projection.json --json
zenith proposal apply first-auto proposal.json --json
zenith import score-and-park.pp --out autos/score-and-park.auto.json --json
zenith import partner.trajectory.json --as-auto --out autos/partner.auto.json --json
zenith projection first-auto --level view --out partners/first-auto.view.projection.json --json
zenith open --auto first-auto --json
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
