# CLI reference

`zenith` is the command-line tool for a Zenith project. It does everything a CI job or an agent needs
without opening the editor: validate autos, estimate their time, render pictures, deploy to the robot
project, run the sim and compare iterations.

## Install

The CLI is the npm package `@horizon36596/zenith-cli`, which provides the `zenith` command. It needs
Node.js 22 or newer.

Install it into your robot project:

```powershell
npm install --save-dev @horizon36596/zenith-cli
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

Every verb takes `--json`. With it, the verb prints exactly one JSON document to stdout and nothing
else there. Without it, output is formatted for a terminal.

- Parse only the `--json` output. The terminal format can change wording between versions. The JSON
  shape is the contract.
- Check the exit code before you read the JSON. On exit `1`, the JSON is a findings list, not the
  result you asked for. On exit `2`, where the verb prints JSON at all, it is `{ "error": "..." }`.

### No prompts

No verb ever asks a question. If a decision would need input, the verb fails instead. This makes every
verb safe to run in CI or from an agent.

### Exit codes

| code | meaning |
|---|---|
| `0` | ok |
| `1` | an auto has an `error`-severity finding: a schema, geometry, rules or timing problem in the auto itself |
| `2` | the verb could not run: bad usage, no project found, an IO error, a failed sim command, or a feature this build does not support |

A build that is missing a core feature a verb depends on exits `2` with a message instead of a stack
trace, so a script can tell "not supported here" from its own bug.

### Season warnings

`validate`, `estimate`, `render`, `sim` and `propose` read the game's rules from the season plugin
that `field.json` names. If the field names no plugin, or one this build does not carry, the
season-specific checks (`CAPACITY`, `EMPTY_SHOT`, `MOUTH_LEADING`, `SWEEP_SPEED`, `START_ILLEGAL`,
`LEGAL_APPROACH`, `TURRET_RANGE`) and the ledger do not run. The verb still runs. It prints a
`warning:` line to stderr, and under `--json` it adds a `seasonWarnings` array of full sentences.

Read `seasonWarnings` before you trust a clean result. Zero errors with a season warning can mean the
checks that would have found something did not run. See [Seasons](seasons.md).

## Verbs

| verb | does |
|---|---|
| [`validate`](#zenith-validate) | checks autos against the schema and the feasibility rules |
| [`init`](#zenith-init) | writes a starter project |
| [`new`](#zenith-new) | writes a new auto from a skeleton |
| [`estimate`](#zenith-estimate) | prints the per-step time estimate |
| [`render`](#zenith-render) | draws an auto to SVG or PNG |
| [`codegen`](#zenith-codegen) | writes a readable Java class for an auto |
| [`deploy`](#zenith-deploy) | copies autos into the robot project and refreshes the OpMode stubs |
| [`diff`](#zenith-diff) | prints the structural diff between two autos |
| [`sim`](#zenith-sim) | runs the high-fidelity sim and compares it with the plan |
| [`calibrate`](#zenith-calibrate) | fits the time model to recorded sim traces |
| [`propose`](#zenith-propose) | validates, renders and prints a pull request body |

### `zenith validate`

```text
zenith validate <autos...> [--explain] [--json] [--project <dir>]
```

Checks one or more `.auto.json` files against the schema and the feasibility rules, and prints a
findings table.

`--explain`
:   After the table, say what each finding code means and how to fix it, in plain words. The editor
    shows the same text.

Exits `1` if any file has an `error`-severity finding. `warning` and `info` findings do not change the
exit code. The [checks and findings](checks-and-findings.md) page lists every code.

```powershell
zenith validate autos/first-auto.auto.json autos/park-and-shoot.auto.json
zenith validate autos/first-auto.auto.json --explain
```

### `zenith init`

```text
zenith init [--command-library ivy|solverslib] [--force] [--json]
```

Writes a starter project into the current directory:

- `zenith.json`,
- `autos/robot.json`, with every number labelled `NEEDS MEASUREMENT`,
- `autos/waypoints.json`, with one placeholder waypoint,
- `autos/field/biobuzz.field.json`, copied from the BIOBUZZ season package when it can be found.

`--command-library ivy|solverslib`
:   Write this library into the `deploy` section as `commandLibrary`. The value is read in any case
    (`Ivy` works) and written lowercase, the only form `zenith.json` accepts. Zenith has no default:
    without the option, `zenith.json` names no library and `init` prints a note saying to add one.

`--force`
:   Overwrite files that already exist. Without it, existing files are kept and reported as `kept`.

If the field file could not be copied, `init` says so. Put a field file at the path `zenith.json`
names.

Without `--command-library`, the `deploy` section `init` writes has no `commandLibrary`. Add
`"commandLibrary": "ivy"` or `"commandLibrary": "solverslib"` to it, for the library your robot code
uses, before Zenith writes any Java: before you run `zenith codegen`, or `zenith deploy` once
`zenith.json` has a `codegen` section.

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
zenith codegen <auto> [--json] [--project <dir>]
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
has an error.

The starter example's
[`generated` folder](https://github.com/Horizon-36596/zenith/tree/main/examples/starter/generated)
has the class this writes for its `cycle-and-park` auto, for each library, next to the stub
`zenith deploy` writes. See [Choosing a command library](command-libraries.md#what-zenith-generates).

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

With no `codegen` section, `zenith deploy` only copies the files, needs no library, and says so on its
first line: `command library: none named, and none needed: zenith.json has no "codegen" section, so no
Java is written`. `--json` output then has `"commandLibrary": null`.

`--dry-run`
:   List every action (`copy:`, `write:`, `keep:`, `remove:`) without touching disk.

An auto with a validation error is skipped and reported, and the other autos still deploy. The verb
exits `1` if anything was skipped. It exits `2` if `zenith.json` has no `deploy` section, or has a
`codegen` section and no `deploy.commandLibrary`.

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

Exits `1` if the auto has an error. Exits `2` if the command fails, times out, or exits `0` without
writing a readable trace; the last lines of its output go to stderr. See [Simulation](simulation.md).

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
    written; `robot.json` has no field for it in 0.1.0.

`--date <date>`
:   The date to record in the provenance. Default: today.

If there are no path-step samples, nothing is written.

```powershell
zenith calibrate --traces traces
zenith calibrate --traces traces --write
```

### `zenith propose`

```text
zenith propose <auto> --dry-run [--base <branch>] [--json] [--project <dir>]
```

Prepares a pull request for an auto change. In 0.1.0 only `--dry-run` is supported. It validates the
auto, renders an SVG to `autosDir/.renders/<name>.svg` and prints the pull request body to stdout.
Under `--json` the body is under `body` and the render path under `render`.

`--dry-run`
:   Required in 0.1.0. Without it the verb prints a note and exits `2`. To open a real pull request,
    use the editor. See [Working with GitHub](github.md).

`--base <branch>`
:   Accepted for compatibility with a future GitHub mode. Unused by `--dry-run`.

Exits `1` if the auto has an error. Run it before you ask someone to open a pull request.

## Using the CLI from a script or an agent

Pass `--json`, read stdout as one JSON document, and use the exit code to decide what to do next.

- `zenith validate <auto> --json` after every edit. Loop until it exits `0`.
- `zenith estimate <auto> --json` answers "does this still fit the auto period".
- `zenith sim <auto> --json` answers "did the robot do what the plan said", once your project has a
  sim.
- `zenith propose <auto> --dry-run --json` fails loudly on an invalid auto and otherwise hands back
  the pull request body.

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
