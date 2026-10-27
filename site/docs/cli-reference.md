# CLI reference

`zenith` is the command-line tool for a Zenith project. It does everything a CI job or an agent needs
without opening the editor: validate autos, estimate their time, render pictures, deploy to the robot
project, run the sim and compare iterations.

## Install

The CLI is the npm package `@horizon36596/zenith-cli`, which provides the `zenith` command. It needs
Node.js 22 or newer.

Install it into your robot project:

```powershell
npm install --save-dev --save-exact @horizon36596/zenith-cli
```

Then run it through npm:

```powershell
npx zenith validate autos/first-auto.auto.json
```

Or run it once without installing:

```powershell
npx -y @horizon36596/zenith-cli validate autos/first-auto.auto.json
```

The examples on this page write `zenith <verb>`. Put `npx` in front if `zenith` is not on your `PATH`.

## Conventions

These hold for every verb.

### Project resolution

A verb that needs a project looks for `zenith.json`:

1. In `--project <dir>`, if you pass it.
2. Otherwise in the current directory, then each parent directory in turn, the way git looks for
   `.git`.
3. If that finds nothing and the verb was given an auto path, it walks up from that file's directory
   instead. So `zenith validate some/project/autos/first-auto.auto.json` works from anywhere above the
   project.

If no `zenith.json` is found, the verb exits `2` and tells you to run `zenith init` or pass
`--project`.

Every path in `zenith.json` is relative to the directory that holds it. A directory Zenith writes to
(`autosDir`, `deploy.dir`, `codegen.dir`, the sim trace) must resolve inside that directory. Zenith
refuses a path that escapes it.

### Naming an auto

Where a verb takes `<auto>`, pass either a path to a `.auto.json` file or the auto's bare name inside
`autosDir`. These are the same auto:

```powershell
zenith estimate autos/first-auto.auto.json
zenith estimate first-auto
```

Auto names use only letters, digits, `.`, `_` and `-`.

### `--json`

Every verb takes `--json`. Command results use one JSON document on stdout; progress and diagnostic
text belong on stderr. Without it, output is formatted for a terminal. An argument or setup error may
produce only a message on stderr, so do not assume stdout always contains a document.

- Parse only the `--json` output. The terminal format can change wording between versions. The JSON
  shape is the contract.
- Check the exit code and read the command-specific result shape. A failed validation can return a
  findings list; another command can return an object describing why it failed. The command sections
  below document those results. Handle an empty stdout and read stderr before reporting a parse error.

### No prompts

Commands run without interactive questions. Supply their required options before running them from
CI or an agent. Check which commands write files: for example, `deploy --dry-run` previews without writing, and
`proposal apply` needs `--write` and an explicit acceptance choice to make changes.

### Exit codes

| code | meaning |
|---|---|
| `0` | ok |
| `1` | an auto has an `error`-severity finding: a schema, geometry, rules or timing problem in the auto itself; for `alliance`, a predicted alliance error; for `proposal`, a proposal that is refused or an accepted change that cannot be made |
| `2` | the verb could not run: bad usage, no project found, an IO error, a failed sim command, or a feature this build does not support |

Check a command's section for exceptions: `optimize`, for example, uses `2` for an infeasible route
and `1` for an input error. An unknown option, a bad flag value or a missing argument exits `2` before
the command runs, printing usage help on stderr even when you passed `--json`. Treat any nonzero code as failure before interpreting
its result.

A build that is missing a core feature a verb depends on exits `2` with a message instead of a stack
trace, so a script can tell "not supported here" from its own bug.

[`zenith optimize`](#zenith-optimize) is the one verb with its own codes: `0` for a route that is
faster or no better, `2` for a step with no route that keeps the margin, and `1` for any error.

### Season warnings

`validate`, `estimate`, `render`, `sim` and `propose` read the game's rules from the season plugin
that `field.json` names. If the field names no plugin, or one this build does not carry, the
season-specific checks (`CAPACITY`, `EMPTY_SHOT`, `MOUTH_LEADING`, `SWEEP_SPEED`, `START_ILLEGAL`,
`LEGAL_APPROACH`, `TURRET_RANGE`, `LAUNCH_TARGET`) and the ledger do not run. The verb still runs. It prints a
`warning:` line to stderr, and under `--json` it adds a `seasonWarnings` array of full sentences.

Read `seasonWarnings` before you trust a clean result. Zero errors with a season warning can mean the
checks that would have found something did not run. See [Seasons](seasons.md).

## Verbs

| verb | does |
|---|---|
| [`validate`](#zenith-validate) | checks autos against the schema and the feasibility rules |
| [`init`](#zenith-init) | writes a starter project |
| [`setup`](#zenith-setup) | gets a robot repository clone ready for agents and GitHub in one step |
| [`github status`](#zenith-github-status) | says which GitHub repository, branch, sign-in and pull request this clone has |
| [`new`](#zenith-new) | writes a new auto from a skeleton |
| [`estimate`](#zenith-estimate) | prints the per-step time estimate |
| [`optimize`](#zenith-optimize) | finds a faster route for one path step; a dry run unless you pass `--write` |
| [`render`](#zenith-render) | draws an auto to SVG or PNG |
| [`codegen`](#zenith-codegen) | writes a readable Java class for an auto |
| [`deploy`](#zenith-deploy) | copies autos into the robot project and refreshes the OpMode stubs |
| [`diff`](#zenith-diff) | prints the structural diff between two autos |
| [`sim`](#zenith-sim) | runs the high-fidelity sim and compares it with the plan |
| [`open`](#zenith-open) | opens a project, and optionally one auto, in the Zenith desktop app |
| [`calibrate`](#zenith-calibrate) | fits the time model to recorded sim traces |
| [`propose`](#zenith-propose) | commits an auto and its render to a work branch, pushes it and opens or updates its pull request |
| [`import`](#zenith-import) | turns a Pedro Visualizer project, a `path.json` or a `trajectory.json` into Zenith's files |
| [`import-commands`](#zenith-import-commands) | reads the robot's `NamedCommands` registrations from its Java and adds what `robot.json` is missing |
| [`projection`](#zenith-projection) | writes the projection a share of an auto would send, without the cloud |
| [`alliance`](#zenith-alliance) | compares an auto with alliance partners' shared projections |
| [`proposal validate`](#zenith-proposal-validate) | checks a proposed change to a shared auto before it is sent |
| [`proposal apply`](#zenith-proposal-apply) | reviews a proposal against your own auto and, with `--write`, makes the changes you accept |

### `zenith validate`

```text
zenith validate [files...] [--java <dir>]... [--explain] [--json] [--project <dir>]
```

Checks one or more `.auto.json` files against the schema and the feasibility rules, and prints a
findings table.

A file may also be an interchange `trajectory.json` or `path.json`, a JSON file whose `kind` is
`"trajectory"` or `"path"`. It is checked the way `zenith import` reads it. Every problem is a
`SCHEMA` finding whose message starts with the JSON path of the value it is about, and under
`--json` that path is also in the finding's `field`. Outside any project, an interchange file is read
against the field its season's package ships, so no `zenith.json` is needed. See
[Bring paths from other planners](import.md#validate-a-file).

`--explain`
:   After the table, say what each finding code means and how to fix it, in plain words. The editor
    shows the same text.

`--java <dir>`
:   Also check `robot.json` against the robot's own Java or Kotlin under this directory, and print
    it as one more file in the table: every command and condition `robot.json` declares must be
    registered with `NamedCommands`, and every argument a factory requires must be declared. Repeat
    the flag for more directories. The findings are `REGISTRY` findings; see
    [`zenith import-commands`](#zenith-import-commands) for what is read. With `--java`, the files
    are optional: `zenith validate --java TeamCode` checks only `robot.json`.

When `zenith.json` has a [`javaDir`](file-format.md#zenithjson), `zenith validate` does the same
check with no flag, on every run that names an auto. `--java`, when given, wins over `javaDir`. A
`javaDir` folder that is not there is a `REGISTRY` warning, not an error, because the robot code
often lives in another checkout; a name the scanner cannot read is a warning too.

Exits `1` if any file has an `error`-severity finding. `warning` and `info` findings do not change the
exit code. The [checks and findings](checks-and-findings.md) page lists every code.

```powershell
zenith validate autos/first-auto.auto.json autos/park-and-shoot.auto.json
zenith validate autos/first-auto.auto.json --explain
zenith validate autos/first-auto.auto.json --java TeamCode/src/main/java
```

### `zenith init`

```text
zenith init [--command-library ivy|solverslib] [--robot-class <class>] [--force] [--json]
```

Writes a starter project into the current directory:

- `zenith.json`, with a `deploy` section and a `codegen` section,
- `autos/robot.json`, with every number labelled `NEEDS MEASUREMENT`,
- `autos/waypoints.json`, with one placeholder waypoint,
- `autos/field/biobuzz.field.json`, copied from the BIOBUZZ season package when it can be found.

The `codegen` section puts the generated Java in TeamCode, in a package of its own, so
`zenith deploy` writes one `@Autonomous` OpMode per auto:

```json
"codegen": {
  "package": "org.firstinspires.ftc.teamcode.zenith",
  "dir": "TeamCode/src/main/java"
}
```

`--command-library ivy|solverslib`
:   Write this library into the `deploy` section as `commandLibrary`. The value is read in any case
    (`Ivy` works) and written lowercase, the only form `zenith.json` accepts. Zenith has no default:
    without the option, `zenith.json` names no library and `init` prints a note saying to add one.

`--robot-class <class>`
:   Write your `ZenithRobot` class, fully qualified (`org.firstinspires.ftc.teamcode.zenith.MyRobot`),
    into the `deploy` section as `robotClass`. Every OpMode `zenith deploy` writes constructs it.
    A value that is not a dotted Java class name is refused, and nothing is written.

`--force`
:   Overwrite files that already exist. Without it, existing files are kept and reported as `kept`.

If the field file could not be copied, `init` says so. Put a field file at the path `zenith.json`
names.

Without `--command-library`, the `deploy` section `init` writes has no `commandLibrary`. Add
`"commandLibrary": "ivy"` or `"commandLibrary": "solverslib"` to it, for the library your robot code
uses, before Zenith writes any Java with `zenith codegen` or `zenith deploy`.

Without `--robot-class`, `init` looks in `TeamCode/src/main/java` for a public Java class that
implements `ZenithRobot`, and prints each one it finds as a suggestion, such as
`found: org.firstinspires.ftc.teamcode.zenith.MyRobot implements ZenithRobot`. It never writes one
into `zenith.json`; you choose. Its last line then says to set `deploy.robotClass` before
`zenith deploy`, which exits `2` until it is set. `--json` output has the option as `robotClass`
(`null` without it) and the classes found as `robotClassSuggestions`.

### `zenith setup`

```text
zenith setup [--json] [--project <dir>]
```

Gets a clone of the robot repository ready for an agent, in one step that is safe to repeat:

1. runs [`zenith init`](#zenith-init) when there is no `zenith.json` (at the top of the git
   repository, or in `--project`),
2. adds the Zenith MCP server to `.mcp.json` at the top of the repository, keeping every other
   server in it; a `zenith` entry already there is kept as it is, and a `.mcp.json` that is not JSON
   is left alone,
3. checks GitHub, as [`zenith github status`](#zenith-github-status) does,
4. checks that `zenith.json` is on the default branch on GitHub, because `zenith propose` only
   commits under the autos, deploy and codegen directories,
5. validates every auto in `autosDir`.

It never overwrites a file, and never commits or pushes. The last line, `next:`, is the one thing to
do next. Under `--json` the result is
`{ ok, root, init, mcp, github, projectOnGitHub, autos, notes, next }`; see
[Connect to GitHub](agents-mcp.md#connect-to-github).

Exits `0` when everything is ready, and `2` when a step is missing.

```powershell
zenith setup
```

### `zenith github status`

```text
zenith github status [--json] [--project <dir>]
```

Prints the GitHub side of this clone: `origin`'s owner and repository, its default branch, the
signed-in login and where the sign-in came from, whether it can push, the checked-out branch, and
that branch's open pull request. It changes nothing.

The sign-in is `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token` when the GitHub CLI is signed
in. The token is never printed, and only ever sent to `api.github.com`. When something is missing,
the `problem:` line says what and the `next:` line says the one thing to do, for example
`gh auth login`.

Under `--json` the result is
`{ ok, repo, defaultBranch, login, auth, canPush, branch, pullRequest, error, next }`, with `null`
for anything not known. Exits `0` when an auto can be proposed from here, `2` otherwise.

### `zenith new`

```text
zenith new <name> [--alliance RED|BLUE] [--force] [--json] [--project <dir>]
```

Writes `autosDir/<name>.auto.json` from a canonical skeleton: the given alliance, a placeholder start
pose and one placeholder path leg. The file validates as written. Needs an existing project.

`--alliance RED|BLUE`
:   The alliance the file's poses are written for. Default `RED`.

`--force`
:   Overwrite the file if it exists. Without it, an existing file is an error (exit `2`).

```powershell
zenith new first-auto --alliance RED
```

### `zenith estimate`

```text
zenith estimate <auto> [--explain] [--json] [--project <dir>]
```

Prints a per-step table: id, kind, nominal time, low-to-high band, strafe percentage and a flag for
steps whose time is unknown. Then prints the total against the field's auto period.

`--explain`
:   Also print the assumptions behind the numbers.

Exits `1` if the auto does not load or validate far enough to plan.

### `zenith optimize`

```text
zenith optimize <auto> --step <id> [--margin-in <in>] [--budget <n>] [--score sim|estimate]
  [--mode both|route|heading] [--no-split] [--no-ranges] [--max-paths <n>] [--hold-start-in <in>]
  [--hold-end-in <in>] [--write] [--json] [--project <dir>]
```

Looks for a faster route for one path step, between the step's own two ends. It may change the
route's geometry and its heading together, break the step into up to four paths and change the
heading mode part-way along. It keeps both ends, the markers (each `at` exactly as written), the
speed fraction and every other step, and it keeps the robot clear of structures by a margin, inside
the walls and out of the keep-outs. The rules are the same as the editor's Optimize path.

A step that goes through a structure, past the wall, into a keep-out or over the centre line, which
`zenith validate` reports as a `STRUCTURE`, `PERIMETER`, `KEEPOUT` or `OPPONENT_SIDE` finding on it,
has no time worth beating, so the card gives the fastest clear route it finds even when it is
slower, and its first line says what the original goes through. When no route between the step's
ends is clear, the result is `infeasible` and says so. A step with none of those findings must be
beaten: a new route must be faster and come no closer to anything than the step does, even where
the step passes closer than the margin or rides the wall, so the result is `improved` or `noBetter`.

It is a dry run. The card it prints has the time before and after under the instant sim and under
the estimate, the closest the new route comes to a structure, the markers that move on the field,
any findings it adds or removes, the other routes that also passed, and the lines of the auto file
that `--write` would change. The file is not touched. A route that is faster in the instant sim and
slower in the estimate is listed as an alternative and is never the pick, except for a step that goes
through something: there the fastest clear route is the pick whatever the two models say, and the
card labels it.

`--step <id>`
:   The step to optimize. Required. It is the step's id, at any depth.

`--margin-in <in>`
:   The clearance to structures for this run. Default: the robot's `footprint.clearanceIn`, or 1 in
    when `robot.json` has none. It is never saved.

`--budget <n>`
:   How many candidate routes the search may score. It is a count, never a time, so the same inputs
    and the same budget give the same result on one machine.

`--score sim|estimate`
:   Score with the instant sim (the default) or with the estimate. When the instant sim cannot run
    the routine, the search falls back to the estimate and the card says why.

`--mode both|route|heading`
:   Change the route and the heading (the default), the route only, or the heading only.

`--no-split`
:   Keep the route to one path.

`--no-ranges`
:   Keep the heading to one mode, with no heading ranges.

`--max-paths <n>`
:   The most paths the route may have. Default 4.

`--hold-start-in <in>`
:   Hold the heading the robot starts with over the first this many inches of the route. Default 0,
    off. Every route offered keeps it; when the step as written does not, the fastest route found
    that does is offered even if it is slower, and with none the exit code is 2.

`--hold-end-in <in>`
:   Reach the step's end heading this many inches before its end and hold it there, so the last bit
    drives straight. Default 0, off, and kept the same way as `--hold-start-in`.

`--write`
:   Save the best route into the auto, in canonical form, through the same edit the editor uses.
    Nothing is written when there is no faster route. A second `zenith validate` passes.

`--json`
:   Print the result as one JSON document: the `OptimizeResult` (`status`, `pick`, `alternatives`,
    `scorer`, `movedMarkers`, `findingsAdded`, `findingsRemoved`, `changes`, `notes`, `evaluations`,
    `inputKey`, `closest` and `originalBlocked`, what the step as written goes through, or `null`),
    with `project`, `auto` and `written` added.

Exits `0` when the route is faster or no better, or is the clear route for a step that went through
something, `2` when the step cannot be done: its own end overlaps something, or it goes through
something and no route between its ends is clear, and `1` for an error, such as an auto that does not
load, a step that is not there or is not a path, or a margin or budget the search cannot use. An
error under `--json` is `{ "error": "..." }`.

```powershell
zenith optimize autos/collect-and-score.auto.json --step toOtherSide
zenith optimize collect-and-score --step toOtherSide --write
```

The search is deterministic. It uses no clock and no randomness, so it runs its whole budget and
the same inputs and options give byte-identical results on one JavaScript engine. Another engine may
break an exact tie differently.

### `zenith render`

```text
zenith render <auto> (--svg <out> | --png <out>) [--alliance RED|BLUE] [--base <otherAuto>] [--json] [--project <dir>]
```

Draws the field, the path, footprint ghosts, findings and the ledger to a file.

`--svg <out>`
:   Write an SVG file.

`--png <out>`
:   Write a PNG file.

`--alliance RED|BLUE`
:   Mirror the picture for this alliance. Default: the auto's own alliance.

`--base <otherAuto>`
:   Load a second auto for comparison. In 0.1.0 the base auto is loaded and validated but not drawn;
    the CLI says so on stderr. If the base auto fails to load, the verb exits `2`.

```powershell
zenith render autos/first-auto.auto.json --png first-auto.png
```

### `zenith codegen`

```text
zenith codegen <auto> [--export] [--json] [--project <dir>]
```

Writes a readable, read-only Java class for the auto to
`codegen.dir/<package path>/<PascalName>Generated.java`, using the `codegen` section of `zenith.json`.
It builds the same routine the [robot runtime](robot-runtime.md) builds from the file, for the runtime
`deploy.commandLibrary` names: `"ivy"` or `"solverslib"`. The key is required and has no default, so
a project that uses `codegen` needs a `deploy` section with `kind`, `dir` and `commandLibrary`; without
it the verb exits `2` with the same message as [`zenith deploy`](#zenith-deploy). The header records
the first 8 hex characters of the source file's SHA-256, so a stale class is easy to spot.
The output is deterministic: the same auto always produces byte-identical Java.

A path from `"current"` is written as `DeferredPath.of(...)` and built from the live pose when the step
starts, as the runtime builds it. The one exception is a number that comes from the path's length (a
marker placed anywhere but the start, or a heading shared out by arc length), which stays the planned
path's; the generated method says so in a comment.

Never edit the generated class. Edit the auto and run `zenith codegen` again. Exits `1` if the auto
has an error. The robot does not run this class: it runs the auto file through the generated OpMode
`zenith deploy` writes, and the class is the same routine written out to read.

`--export` writes `<PascalName>Exported.java` in the same folder instead: a standalone `@Autonomous`
OpMode that reads no auto file, for a team that wants Java it owns. It needs `deploy.robotClass`, since
it constructs your robot, and exits `2` without it. It is not recommended: Zenith no longer tracks the
routine once it is exported, and the verb prints a `warning:` line saying so (`--json` adds
`"exported": true` and the warning). See
[Exported OpMode](robot-runtime.md#exported-opmode-not-recommended).

The starter example's
[`generated` folder](https://github.com/Horizon-36596/zenith/tree/main/examples/starter/generated)
has the classes this writes for its `cycle-and-park` auto, with and without `--export`, for each
library, next to the stub `zenith deploy` writes. See [Choosing a command library](command-libraries.md#what-zenith-generates).

### `zenith deploy`

```text
zenith deploy [--dry-run] [--json] [--project <dir>]
```

Copies `autosDir/*.auto.json`, `waypoints.json`, `robot.json` and the field file into `deploy.dir`.
When `zenith.json` has a `codegen` section, it also writes or refreshes one `@Autonomous` stub per
auto at `codegen.dir/<package>/generated/<PascalName>Auto.java`, and removes the stubs for autos that
no longer exist. Each stub extends `AutoFromFile` from the runtime `deploy.commandLibrary` names:
`org.horizon36596.zenith.ivy` for `"ivy"` or `org.horizon36596.zenith.solverslib` for `"solverslib"`.
The first line of the output names it, and `--json` output has it as `commandLibrary`.

The stubs are the only Java `zenith deploy` writes. So `deploy.commandLibrary` is required, with no
default, whenever there is a `codegen` section. Without it, `zenith deploy` stops before it copies or
writes anything, exits `2`, and prints:

```text
zenith: zenith.json does not say which command library your robot code uses, and Zenith does not pick one. Add "commandLibrary": "solverslib" or "commandLibrary": "ivy" to its "deploy" section. See https://libraries.horizon36596.org/zenith/command-libraries/.
```

With a `codegen` section and no `deploy.robotClass`, it also stops before it copies anything and
exits `2`, saying to set `deploy.robotClass` to your `ZenithRobot` class.

With no `codegen` section, `zenith deploy` only copies the files and needs no library. It writes no
OpMode, so the Driver Station lists none of the autos unless your own OpModes load them. Its first
line says that no Java is written, whether or not a library is named:

```text
command library: none named, and none needed: zenith.json has no "codegen" section, so no Java is written
command library: Ivy is named, but none is needed: zenith.json has no "codegen" section, so no Java is written
```

When it copies at least one auto, its last line is this warning, which does not change the exit
code:

```text
warning: no "codegen" section, so no OpMode was written; the Driver Station will not list these autos unless your own OpModes load them.
```

`--json` output has `"stubs": true` when the deploy writes the OpMode stubs, and `"stubs": false`
when there is no `codegen` section. `"commandLibrary"` is the library `zenith.json` names, or `null`.
To have deploy write the OpModes, add the `codegen` section [`zenith init`](#zenith-init) writes, and
`deploy.robotClass`.

`--dry-run`
:   List every action (`copy:`, `write:`, `keep:`, `remove:`) without touching disk.

An auto with a validation error is skipped and reported, and the other autos still deploy. The verb
exits `1` if anything was skipped. It exits `2` if `zenith.json` has no `deploy` section, or has a
`codegen` section and no `deploy.commandLibrary` or no `deploy.robotClass`.

`deploy` does not build or install the APK. See [Robot runtime](robot-runtime.md#deploy-autos).

```powershell
zenith deploy --dry-run
zenith deploy
```

### `zenith diff`

```text
zenith diff <a> <b> [--json]
```

Prints the structural diff between two autos: added, removed, changed and moved steps, as
Markdown-flavoured text. The same format appears in pull request bodies. `<a>` and `<b>` are paths.
`diff` needs no project; if one is found, paths are printed relative to it.

A step is reported as moved only when its order among the other steps changed, or it moved into
another group. Adding or removing a step does not make every step after it a move: only the added
or removed step is reported.

Exits `2` if either file cannot be loaded.

```powershell
zenith diff autos/first-auto.auto.json autos/park-and-shoot.auto.json
```

### `zenith sim`

```text
zenith sim <auto> [--open] [--timeout <seconds>] [--json] [--project <dir>]
```

Runs the high-fidelity sim command from `zenith.json` and compares the recorded run with the plan.
`zenith.json` needs a `sim` section:

```json
"sim": {
  "command": "PLACEHOLDER: the command that runs your headless sim test, with {auto} where the auto name goes",
  "trace": "TeamCode/build/sim/{auto}.trace.json"
}
```

`{auto}` is replaced by the auto's name in both. The command is split into words and run directly from
the project directory. It is **not** run through a shell, so pipes, redirects and shell variables do
not work in it. Its output streams to the terminal.

When the command succeeds, `sim` reads the trace at `sim.trace` and prints, per step, the estimate,
the actual time, the difference and the largest cross-track distance from the planned path. Then it
prints a whole-run summary: structure contacts, launches, tips and pieces held at the end.

`--open`
:   Also render the plan to `autosDir/.renders/<name>.sim.svg` and print its path. It does not open
    an image viewer.

`--timeout <seconds>`
:   Stop the sim command after this many seconds.

`--json`
:   Write the result as JSON on stdout. Progress and the child sim command's output go to stderr, so
    a script can parse stdout directly. Check the exit code before using the result.

Exits `1` if the auto has an error. Exits `2` if the command fails, times out, or exits `0` without
writing a readable trace; the last lines of its output go to stderr. See [Simulation](simulation.md).

### `zenith open`

```text
zenith open [dir] [--auto <name>] [--json]
```

Opens a project in the Zenith desktop app. `dir` is the project folder or a folder inside it, and
defaults to the working directory; the project is found by walking up, as every verb finds it. If the
app is not running it starts; if it is, the running window opens the project instead of a second
window appearing. That window asks before it replaces unsaved edits.

`--auto <name>`
:   Open this auto first, by bare name (`first-auto`) or file name (`first-auto.auto.json`). Without
    it the app opens the project's first auto.

The verb checks the project and the auto before it starts anything, so a mistake is reported here and
not on the app's status line. `--json` prints `{ opened, root, auto, app }`, or `{ opened: false,
error }`.

The desktop app is Windows only. `zenith open` looks for `Zenith.exe` where the installer puts it,
for this user (`%LOCALAPPDATA%\Programs\Zenith`) or for everyone (`Program Files\Zenith`). If it is
installed somewhere else, set `ZENITH_DESKTOP` to the full path of `Zenith.exe`:

```powershell
$env:ZENITH_DESKTOP = 'D:\Apps\Zenith\Zenith.exe'; zenith open --auto first-auto
```

Exits `2` when there is no project, the auto is not in the autos folder, or the desktop app is not
installed. Agents have the same as the MCP tool `zenith.app.open` ([Agents and MCP](agents-mcp.md)).

### `zenith calibrate`

```text
zenith calibrate [--traces <dir>] [--write] [--date <date>] [--json] [--project <dir>]
```

Pairs every path step's recorded duration against the plan's geometry and fits the time model:
`accelInPerS2`, `settleS` and a scale per heading mode. Reports the residual band left after the fit.

`--traces <dir>`
:   Read every `*.trace.json` in this directory. Default: `traces/`, or else the directory of
    `sim.trace`.

`--write`
:   Write the fitted `kinematics.accelInPerS2` and `kinematics.settleS` into `robot.json`, with
    provenance `CALIBRATED FROM SIM <date> (<n> steps)`. The per-mode scale is reported but not
    written; `robot.json` has no field for it.

`--date <date>`
:   The date to record in the provenance. Default: today.

If there are no path-step samples, nothing is written.

```powershell
zenith calibrate --traces traces
zenith calibrate --traces traces --write
```

### `zenith propose`

```text
zenith propose <auto> [--base <branch>] [--branch <name>] [--summary <text>] [--reviewer <login>]... [--dry-run] [--json] [--project <dir>]
```

Proposes an auto as a pull request, the same as the editor's **Propose** button
([Working with GitHub](github.md#propose-a-pull-request-that-reviews-itself)). Run it inside a clone
of the robot repository whose `origin` is on github.com:

1. validates the auto; an error stops it (exit `1`), and warnings go in the pull request body,
2. uses the work branch `auto/<auto>/<login>`, starting it from the base when it does not exist yet,
   and merges the base into it when the base has moved on; a conflict stops it and names the files,
3. commits the canonical auto, the waypoints file when it has local changes, and the rendered SVG
   (`autosDir/.renders/<auto>.svg`) as `auto(<auto>): <summary>`,
4. pushes the branch and opens the pull request against the base, or updates the body of the one
   already open.

It never writes the base branch, never force-pushes and only commits under the directories
`zenith.json` declares. It leaves your checkout alone: the commit is built without touching the files
you are editing or the branch you are on, except that a checked-out work branch moves forward to the
new commit. The GitHub sign-in is found as for [`zenith github status`](#zenith-github-status), and
git pushes with its own credentials; if it cannot, run `gh auth setup-git`.

`--base <branch>`
:   The branch the pull request goes into. Default: the repository's default branch.

`--branch <name>`
:   The work branch. Default: `auto/<auto>/<login>`. The base branch is refused.

`--summary <text>`
:   The commit summary after `auto(<auto>): `. Default: `edit`.

`--reviewer <login>`
:   Ask this GitHub user to review the pull request. Repeat for more.

`--dry-run`
:   Only validate the auto, render the SVG to `autosDir/.renders/<name>.svg` and print the pull
    request body to stdout, for a pull request you open yourself. No git and no GitHub. Under
    `--json` the body is under `body` and the render path under `render`.

Under `--json`, success prints
`{ ok, auto, repo, base, branch, login, commit, mergedBase, files, pushed, pullRequest, errors, warnings, seasonWarnings, next }`,
with `pullRequest` as `{ number, url, created }`. Exits `1` if the auto has an error, and `2` when
something else stops it; the JSON is then `{ error, next }`, plus `files` for a merge conflict.

```powershell
zenith propose first-auto
zenith propose first-auto --summary "slower into the garden" --reviewer octocat
```

### `zenith import`

```text
zenith import <file> [--out <file>] [--name <name>] [--alliance RED|BLUE] [--pedro-centre <inches>]
              [--as-auto] [--force] [--json] [--project <dir>]
```

Brings a path from another planner into the project. What it does depends on the file:

| file | becomes |
|---|---|
| a Pedro Pathing Visualizer project, `.pp` | an auto |
| an interchange `path.json` (`"kind": "path"`) | an auto |
| an interchange `trajectory.json` (`"kind": "trajectory"`) | a partner projection at 10 Hz, for the alliance view; with `--as-auto`, an auto |

Needs an existing project, whose field the file is read against. An imported auto is also checked
against the project's robot and field, and the findings are printed with the importer's warnings.
They do not change the exit code: `zenith validate` is the gate.

`--out <file>`
:   Write the auto, or the projection, to this file. Without it the result is printed on stdout and
    the warnings on stderr.

`--name <name>`
:   The imported auto's name. The default is the file's own name.

`--alliance RED|BLUE`
:   The alliance a `.pp` path was drawn for. A `.pp` file does not say, so the default is the field's
    own alliance, with a warning. A `path.json` and a `trajectory.json` name their own alliance and
    frame, so `--alliance` and `--pedro-centre` with either are a usage error (exit `2`).

`--pedro-centre <inches>`
:   The Pedro Visualizer's field centre in its own inches, for a `.pp` file. The default is 70.75,
    half the visualizer's 141.5 in field. Pass `72` if your points were placed with the centre at
    (72, 72).

`--as-auto`
:   For a `trajectory.json`: write an auto instead of a projection, cut into drive, wait and turn
    steps the way [the editor does it](import.md#a-trajectoryjson-as-an-auto), so a team can save it
    to its library and share it. With a `.pp` or `path.json` file it is a usage error (exit `2`).

`--force`
:   Overwrite `--out` if it exists. Without it, an existing `--out` file is an error (exit `2`).

Under `--json` the result is `{ kind, written?, auto, robotFootprint?, findings, warnings }` for an
auto and `{ kind, written?, projection, warnings }` for a trajectory. `robotFootprint` is the robot
size a `.pp` or `trajectory.json` file records; it is reported and never written to `robot.json`.
A projection is written in canonical form with its `$schema`, so `zenith alliance` and the Partners
panel read it.

Exits `0` when the file was imported. Exits `2`, naming every field that is wrong, when the file
cannot be imported, and for a usage error: an existing `--out` without `--force`, a bad `--alliance`
or `--pedro-centre`, or a flag that does not fit the file. Under `--json` every one of these is
`{ "error": "...", "issues": [{ "path", "message" }] }` on stdout, with `issues` empty for a usage
error, and nothing on stderr.

```powershell
zenith import score-and-park.pp --out autos/score-and-park.auto.json
zenith import score-and-park.pp --pedro-centre 72 --alliance BLUE
zenith import partner.trajectory.json --out partners/partner.projection.json --json
zenith import our-roadrunner.trajectory.json --as-auto --out autos/our-roadrunner.auto.json
```

See [Bring paths from other planners](import.md) for what maps and what is warned about.

### `zenith import-commands`

```text
zenith import-commands [dirs...] [--check] [--diff] [--json] [--project <dir>]
```

Reads the robot's `NamedCommands` registrations from its Java or Kotlin and brings `robot.json` up
to date. It needs nothing but Node: no Gradle, no Android Studio, no administrator rights, and no
network. The directories default to `zenith.json`'s [`javaDir`](file-format.md#zenithjson)
when it is set (a `javaDir` folder that is not there is then a usage error), and otherwise to the
whole project; build output, dot directories and test
sources (`src/test`, `src/androidTest`) are skipped, since a robot's tests often register stand-in
commands. A directory outside the project is refused.

For every `NamedCommands.register("name", factory)` and `registerCondition("name", ...)` call it
finds, it reads the name, follows the factory, and records each argument the factory reads with
`argInt` (a required whole number), `argDouble` and `argString` (required, or optional with the
fallback as the default) and `argEnum` (optional, with the enum's constants as the values). See
[Commands from the robot's code](robot-runtime.md#commands-from-the-robots-code) for what it can
and cannot read.

Then it adds to `robot.json` what the Java has and `robot.json` lacks:

- a new command gets its params, `"estimateS": "unknown"` and a `provenance` of
  `SET FROM <file>; estimateS NEEDS MEASUREMENT`, since no timing can be read from code;
- a new param on a command already in `robot.json` gets a `provenance` of `SET FROM <file>`;
- a new condition gets a `provenance` of `SET FROM <file>`.

Nothing already in `robot.json` is changed: summaries, estimates, `requires`, `stationary`,
`movesRobot`, ledger hints and every declared param stay as they are. Nothing is removed either: a
command or condition the Java does not register is reported, for you to settle. The file is written
in canonical form, and only when something was added.

`--check`
:   Write nothing. Exits `1` when `robot.json` is missing something, or disagrees with the Java.

`--diff`
:   Also print the lines of `robot.json` that change.

Under `--json` the result is `{ robot, filesScanned, commands, conditions, changes, findings,
written, diff, reformats, errors, warnings }`. `reformats` is `true` when `robot.json` is not in
canonical form, so writing it also reformats lines the diff, which compares canonical text, does not
show. `findings` are what is still wrong after the additions (with
`--check`, before them), each with a `severity`, a `subject` (`command`, `condition` or `scan`), the
`name`, `key` and file and line `at` it is about, and a `message`.

Exits `0` when `robot.json` agrees with the Java, `1` when an error remains (a declared command or
condition that is not registered, an argument the Java requires that `robot.json` does not declare,
an enum value the Java enum lacks) or, with `--check`, when something would be added, and `2` for a
usage or IO problem.

```powershell
zenith import-commands --check
zenith import-commands TeamCode/src/main/java --diff
zenith import-commands TeamCode/src/main/java --json
```

### `zenith projection`

```text
zenith projection <auto> [--level view|propose] [--title <text>] [--coarsen] [--include-commands]
                  [--out <file>] [--force] [--json] [--project <dir>]
```

Writes a share file of `<auto>`, its projection, with no account and no network: what another
team sees of your routine (see [Alliance partners](alliance-partners.md)). It is built the way the
editor's **Download share file** builds it, from the instant sim's run of the auto, the ledger with
the season's rules and core's `projectShare`, in canonical form, and it is byte for byte the file
the editor gives. A partner loads it in the Partners panel or passes it to
[`zenith alliance`](#zenith-alliance).

`--level view|propose`
:   How much the other team sees. `view`, the default, has the trajectory, phases and claims.
    `propose` adds the step structure under opaque ids, so the other team can send a proposal.

`--title <text>`
:   The title the other team sees, up to 200 characters. The auto's own title is never sent unless
    you pass it here.

`--coarsen`
:   Round the timed layer to 2 in, 5 degrees and 0.25 s instead of 0.5 in, 1 degree and 1 ms.

`--include-commands`
:   Add the optional `commands` list, the same list the Share dialog adds with **Include command names**: for
    each command token, the command's name, its arguments exactly as the auto passes them, and the
    span of the step it belongs to. Off by default, and then every command is an opaque token and
    the file is byte for byte what it is without the option. Condition names and the robot file's
    command table are never sent either way.

`--out <file>`
:   Write the projection to this file. Without it the projection is printed on stdout.

`--force`
:   Overwrite `--out` if it exists. Without it, an existing `--out` file is an error (exit `2`).

Under `--json` the result is `{ project, auto, level, written, bytes, projection, seasonWarnings }`,
with `written` `null` when nothing was written and `bytes` the size of the canonical file.

Exits `1` if the auto has an error, because an auto with an error has nothing to share yet, or if
the projection would break its own limits (a run over 300 s, say). Exits `2` for a `--level` that is
not `view` or `propose`, or an existing `--out` without `--force`; under `--json` that is
`{ "error": "..." }`.

```powershell
zenith projection first-auto --out partners/first-auto.view.projection.json
zenith projection collect-and-score --level propose --title "Horizon collect" --json
zenith projection collect-and-score --include-commands --out partners/collect.view.projection.json
```

### `zenith alliance`

```text
zenith alliance <auto> <projections...> [--offset <seconds>] [--json] [--project <dir>]
```

Puts your auto and one or more alliance partners on one field and compares them every 0.1 s. Your
robot is the instant sim's run of `<auto>`. Each partner is a projection file another team shared
with you (kind `projection`, usually named `*.projection.json`). A partner written for the other
alliance is mirrored onto yours by the field's own mirror. A partner is named by its projection's
title, or else by its file name.

It prints the predicted alliance findings: `ALLIANCE_COLLISION` and `ALLIANCE_START_OVERLAP` are
errors, `ALLIANCE_NEAR_MISS`, `ALLIANCE_ELEMENT_CONFLICT` and `ALLIANCE_ENVELOPE` are warnings. The
[checks and findings](checks-and-findings.md#alliance-findings) page explains each one.

It also prints the two fixes the editor's alliance view offers, for `ALLIANCE_COLLISION`,
`ALLIANCE_NEAR_MISS` and `ALLIANCE_ENVELOPE`. Each is sized, in 0.1 s steps up to 10 s, to clear
every finding of its code without leaving a predicted collision, or it says that none does:

- **Delay my start**: for each of those codes, the smallest start delay for your robot. For an
  envelope that is the smallest delay that keeps your robot out while the envelope is active.
- **Add a wait step**: for each of those findings, the smallest `wait` step to put before the step
  your robot is running when the finding begins (for a near miss, at its closest approach). A step
  inside a parallel group is waited for by waiting before the group. A finding that happens while
  your robot is not running a step, waiting out `--offset` or already parked, has no wait; delay
  your start instead.

`ALLIANCE_START_OVERLAP` and `ALLIANCE_ELEMENT_CONFLICT` have no fix, because a waiting robot holds
its start pose, and both robots still claim the element whenever each gets there.

Under `--json` the result is `{ project, auto, alliance, offsetS, partners, findings, errors,
warnings, clearingOffset?, clearingOffsets, clearingWaits, help }`:

`clearingOffsets`
:   One entry for each of the three codes that was found, keyed by code: `{ "offsetS": ... }`, or
    `null` when no delay up to 10 s clears it. A code with no finding has no entry.

`clearingOffset`
:   The `ALLIANCE_COLLISION` entry of `clearingOffsets`, there only when a collision is predicted.

`clearingWaits`
:   One entry for each finding of the three codes, in the order of `findings`:
    `{ "findingIndex": ..., "code": ..., "wait": { "stepId": ..., "seconds": ... } }`, where
    `findingIndex` counts from 0 in `findings` and `stepId` is the step the wait goes before. `wait`
    is `null` when no wait up to 10 s clears it or the finding names no step.

`--offset <seconds>`
:   Delay your robot's start by this many seconds, as if it waited at its start pose. Default `0`.

Exits `1` if any alliance finding is an error, or if the auto itself does not load, and `0`
otherwise. Exits `2` if a projection file cannot be read or does not pass the projection schema, or
if `--offset` is not a number of seconds, zero or more. These findings are predictions. They are never part of
`zenith validate`, and nothing else, not a save, a deploy or a `propose`, depends on them.

```powershell
zenith alliance first-auto partners/starter-partner.projection.json
zenith alliance first-auto partners/starter-partner.projection.json --offset 0.5 --json
```

### `zenith proposal validate`

```text
zenith proposal validate <proposal> <projection> [--share live|revoked|expired] [--json]
```

The proposing team's check before it sends a proposal. A proposal is a file (kind `proposal`) with
changes to an auto another team shared with you at the propose level: moved poses and control
points, heading modes, speeds, timeouts, waits, reordered steps, added or removed path steps, slid
markers and envelopes, each with an optional one-line comment. It names steps by the projection's
opaque ids (`s1`, `s2`, ...) and can never name, add or change a command. `<proposal>` is that file,
and `<projection>` is the projection file the share gave you. Neither needs a project.

It prints either one line saying the proposal can be sent, or a table of the reasons it would be
refused: `PROPOSAL_SHARE`, `PROPOSAL_STALE`, `PROPOSAL_TOKEN`, `PROPOSAL_CHANGE`, or `SCHEMA` for a
file that is not a proposal. The
[checks and findings](checks-and-findings.md#proposal-findings) page explains each one.

`--share live|revoked|expired`
:   The state of the share, which only the cloud library knows and no file records. Default `live`.

Under `--json` the result is `{ proposal, projection, share, ok, changes, findings, errors, help }`.
`ok` is `true` when there are no findings at all, and `changes` is the number of changes in the
proposal.

Exits `0` when the proposal can be sent and `1` when it would be refused. Exits `2` if `--share` is
not one of the three states, if either file cannot be read, or if `<projection>` does not pass the
projection schema.

```powershell
zenith proposal validate partner.proposal.json partners/collect-and-score.propose.projection.json
zenith proposal validate partner.proposal.json partners/collect-and-score.propose.projection.json --share expired --json
```

### `zenith proposal apply`

```text
zenith proposal apply <auto> <proposal> [--base <auto>] [--accept all|none|<numbers>]
                      [--share live|revoked|expired] [--write] [--json] [--project <dir>]
```

The owning team's review of a proposal made against a share of `<auto>`. It maps the proposal's
opaque step ids and tokens back to your own steps and commands, through the auto as it was when it
was shared, and prints:

- every change, numbered from 1, with its status and a one-sentence summary in your step names, and
  the proposer's comment;
- the proposal findings, if any;
- the step-level diff between your auto and your auto with the accepted changes, with the time
  estimate before and after;
- the findings `zenith validate` would give your auto with the accepted changes.

A change's status is one of:

| status | meaning |
|---|---|
| `applied` | accepted, and made through the normal edit primitives |
| `notAccepted` | not in `--accept`, so nothing was done |
| `conflict` | its step has changed in your auto since the share, so it can only be rejected (`PROPOSAL_CONFLICT`) |
| `invalid` | it does not fit the share, or fits only together with a change you did not accept |
| `refused` | the whole proposal was refused: a view, revoked or expired share, or a stale structure |

A finding about a change you accept is an error. The same finding about a change you did not accept
is a warning, because not accepting it is already the remedy.

It is a dry run unless you pass `--write`. Nothing is written without it, and nothing is written
with `--accept none`: the report says no change was accepted.

`--base <auto>`
:   The auto as it was at the revision the share is pinned to, as a path or a bare name. Pass it when
    your auto has changed since you shared it. Default: `<auto>` itself.

`--accept all|none|<numbers>`
:   The changes to accept: `all`, `none`, or change numbers from 1 separated by commas, such as
    `1,2,5`. The others are not accepted. Default `all` for the dry run. Required with `--write`.

`--share live|revoked|expired`
:   The state of the share. Default `live`. A revoked or expired share refuses the whole proposal.

`--write`
:   Write `<auto>` in place, in canonical form, with the accepted changes. It needs `--accept`, and it
    writes nothing while an accepted change is a conflict or invalid; accept only the changes marked
    `applied`.

Under `--json` the result is
`{ project, auto, base, proposal, accepted, changes, findings, errors, diff, validation, written, help }`.
`accepted` lists the change numbers accepted, counted from 1. Each entry of `changes` is
`{ index, number, op, stepId, status, summary, comment? }`, where `index` counts from 0 and `number`
from 1. `validation` is `{ findings, errors }` for the auto with the accepted changes, and `written`
is the file written, or `null`.

Exits `1` if the proposal is refused, if an accepted change is a conflict or invalid, if the auto
with the accepted changes has an error, or if `<auto>` or `--base` does not load. Exits `2` if
`--write` is given without `--accept`, if `--accept` or `--share` is not a value above, or if the
proposal file cannot be read.

```powershell
zenith proposal apply collect-and-score partner.proposal.json
zenith proposal apply collect-and-score partner.proposal.json --accept 1,2
zenith proposal apply collect-and-score partner.proposal.json --accept 1,2 --write
```

A dry run prints the changes like this:

```text
autos/collect-and-score.auto.json with the proposal partner.proposal.json

Changes
    1. applied      Drive "toOtherSide" at 0.6 of full speed. Comment: Slower round the hive.
    2. applied      Wait 0.5 s after "shootPreloads".
    3. notAccepted  Remove "driveOut".
```

A proposal never deploys, never runs anything and never touches the robot project beyond the one
auto file `--write` names. See [Alliance partners](alliance-partners.md#proposals) for how
proposals travel between teams.

## Using the CLI from a script or an agent

Pass `--json`, read stdout as one JSON document, and use the exit code to decide what to do next.

- `zenith validate <auto> --json` after every edit. Loop until it exits `0`.
- `zenith estimate <auto> --json` answers "does this still fit the auto period".
- `zenith sim <auto> --json` answers "did the robot do what the plan said", once your project has a
  sim.
- `zenith setup --json` once, in a fresh clone; its `next` says what is still missing.
- `zenith propose <auto> --json` opens or updates the pull request, and fails loudly on an invalid
  auto. Add `--dry-run` to get only the pull request body.
- `zenith alliance <auto> <projection> --json` answers "will we meet our partner", and
  `clearingOffset` says how long to wait if so.
- `zenith proposal validate <proposal> <projection> --json` answers "will the other team take this
  proposal", and `zenith proposal apply <auto> <proposal> --json` shows the owner what accepting it
  would change, without writing anything.

A typical sequence:

```powershell
zenith new first-auto --alliance RED --json
zenith validate autos/first-auto.auto.json --json
zenith estimate autos/first-auto.auto.json --explain --json
zenith render autos/first-auto.auto.json --png first-auto.png --json
zenith sim autos/first-auto.auto.json --json
zenith propose autos/first-auto.auto.json --dry-run --json
```

The CLI has no verb per structural edit. An agent that edits autos should use the MCP server's
`zenith.edit.*` tools. See [Agents and MCP](agents-mcp.md).
