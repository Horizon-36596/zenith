# @horizon36596/zenith-cli

The `zenith` command for [Zenith](https://libraries.horizon36596.org/zenith/), the FTC autonomous
planner by Horizon (FTC 36596). It validates, estimates, renders, generates code for, deploys and
simulates the autos in a robot repository, with `--json` on every verb and no prompts, so a CI job
or an agent can drive it.

```
npm install --save-dev --save-exact @horizon36596/zenith-cli
npx zenith --version
npx zenith init
npx zenith validate autos/*.auto.json
```

Requires Node 22 or newer. Documentation: https://libraries.horizon36596.org/zenith/. Licence: MIT.

## Package reference

The `zenith` command line tool: every verb an editor, a CI job, or an agent needs to work with a
Zenith project without opening the web app. The docs site's CLI reference
(https://libraries.horizon36596.org/zenith/cli-reference/) is the user-facing version of this file.

### Install and run

Inside this monorepo:

```
pnpm install
pnpm exec tsc -b packages/cli
pnpm zenith -- <verb> [args]
```

`pnpm zenith` forwards the `--` separator pnpm inserts before `<verb>`; `main()` drops that one
leading `--` before parsing, so flags after the verb (`--project`, `--json`, ...) work normally.

Or, once built, `zenith` is the package's bin and can be run directly (`node packages/cli/dist/index.js`,
or just `zenith` if the workspace's `node_modules/.bin` is on `PATH`).

### Project resolution

Every verb that needs a project looks for `zenith.json` in `--project <dir>` if given, otherwise by
walking up from the current directory. An auto argument may be a path to a `.auto.json` file or its
bare name inside `autosDir`.

### Conventions every verb follows

- `--json` prints a command result on stdout, with progress and diagnostics on stderr. Argument or
  setup errors may leave stdout empty. Check the exit code before parsing, and use the documented
  result shape for that command.
- No verb ever prompts. If stdin would be needed for a decision, the verb fails instead.
- Most commands use **0** for success, **1** for findings errors and **2** when the command cannot run.
  Check the command's own section for exceptions: `optimize` uses **2** for an infeasible route and
  **1** for an input error. Invalid options can exit **1** with usage text before a command runs.
- Every verb that needs season-specific rules (`validate`, `estimate`, `render`, `sim`, `propose`)
  resolves them through `@horizon36596/zenith-seasons` from the project's `field.json`. When the field names no
  season plugin, or one this build does not carry, the season-gated checks (`CAPACITY`,
  `EMPTY_SHOT`, `MOUTH_LEADING`, `SWEEP_SPEED`, `START_ILLEGAL`, `LEGAL_APPROACH`, `TURRET_RANGE`,
  `LAUNCH_TARGET`)
  and the ledger are simply absent rather than wrong; the verb still runs and prints a `warning:`
  line to stderr (and a `seasonWarnings` array under `--json`) saying so.

### Verbs

#### `zenith validate <autos...> [--json] [--project <dir>]`

Checks one or more `.auto.json` files against the schema and the feasibility rules. Prints a findings
table (or JSON). Exit 1 if any file has an error-level finding.

An argument may also be an interchange `trajectory.json` or `path.json` (a JSON file whose `kind` is
`"trajectory"` or `"path"`). It is checked the way `zenith import` reads it, and each problem is a
`SCHEMA` finding whose `field` (under `--json`) is the JSON path of the value it is about. Outside
any project, an interchange file is read against the field its season's package ships.

#### `zenith import <file> [--out <file>] [--name <name>] [--alliance RED|BLUE] [--pedro-centre <inches>] [--force] [--json] [--project <dir>]`

Turns a Pedro Pathing Visualizer `.pp` project or an interchange `path.json` into an auto, checked
against the project's robot and field, or an interchange `trajectory.json` into a partner projection
at 10 Hz. Without `--out` the result is printed. Exit 2, with every wrong field named, when the file
cannot be imported. `--pedro-centre` moves the Pedro Visualizer's field centre from its default of
70.75 in (half its 141.5 in field), for a team that treats (72, 72) as the centre.

#### `zenith init [--command-library ivy|solverslib] [--robot-class <class>] [--json] [--force]`

Writes a starter `zenith.json` and an `autos/` directory that validates, for a new project.
`zenith.json` gets a `codegen` section (package `org.firstinspires.ftc.teamcode.zenith`, dir
`TeamCode/src/main/java`), so `zenith deploy` writes the OpModes.
`--command-library` writes `deploy.commandLibrary`; the value is read in any case and written
lowercase. There is no default: without it the `deploy` section names no library, `init` prints a
note, and `zenith codegen` and `zenith deploy` refuse until `"ivy"` or `"solverslib"` is added.
`--robot-class` writes `deploy.robotClass`, the `ZenithRobot` class every generated OpMode
constructs. Without it, `init` prints any public class in `TeamCode/src/main/java` that implements
`ZenithRobot` as a suggestion, never writing it, and ends with a line saying to set
`deploy.robotClass`.

#### `zenith new <name> [--alliance RED|BLUE] [--json] [--force] [--project <dir>]`

Writes a new `.auto.json` from a canonical skeleton.

#### `zenith estimate <auto> [--json] [--explain] [--project <dir>]`

Prints a per-step table (id, kind, nominal time, low-high band, strafe percentage, an unknown-time
flag) and the total against the field's auto period. `--explain` also prints the assumptions behind
the numbers (`estimate.explain`). Calls `@horizon36596/zenith-core`'s `estimate`.

#### `zenith optimize <auto> --step <id> [--margin-in <in>] [--budget <n>] [--score sim|estimate] [--mode both|route|heading] [--no-split] [--no-ranges] [--max-paths <n>] [--hold-start-in <in>] [--hold-end-in <in>] [--write] [--json] [--project <dir>]`

Finds a faster route for one path step by calling
`@horizon36596/zenith-core`'s `runOptimize`. The default is a dry run: it prints the time before and
after under the instant sim and the estimate, the alternatives, the markers that move and the lines
`--write` would change, and leaves the file alone. `--write` saves the pick through `setRoute` in
canonical form, and only when it is faster, or, for a step that `zenith validate` finds going through
something, when it is the fastest clear route found, which may be slower (`originalBlocked` in the result says what the
step goes through). `--json` prints the `OptimizeResult` with `project`,
`auto` and `written` added. `--hold-start-in` and `--hold-end-in` hold the start heading over the
first, and the end heading over the last, so many inches of the route (0 off); a step that does not
gets the fastest route found that does, even a slower one (`originalBreaksHolds` says so). This verb's exit codes are its own: 0 improved or no better, 2 infeasible,
1 an error. It reads no clock; the search runs its whole budget, a count of evaluations.

#### `zenith render <auto> (--svg <out> | --png <out>) [--alliance RED|BLUE] [--base <otherAuto>] [--json] [--project <dir>]`

Draws the field, the path, findings and the ledger to SVG or PNG. PNG rendering goes through
`@resvg/resvg-js` (a CLI-only dependency; `@horizon36596/zenith-core` stays pure and only produces SVG text).
`--base` loads and validates a second auto for comparison; `@horizon36596/zenith-core`'s `render` does not yet take
an overlay, so today `--base` is validated but not drawn, and the CLI says so on stderr rather than
silently ignoring it.

#### `zenith codegen <auto> [--json] [--project <dir>]`

Writes the generated, read-only Java class described on the docs site's Robot runtime page
("Generated Java") to `zenith.json`'s `codegen.dir/<package path>/<PascalName>Generated.java`. The header
records the source file's sha256 (first 8 hex characters) so a stale generated file is easy to spot.
Output is deterministic: the same auto always produces byte-identical Java. The class is written for
the runtime `deploy.commandLibrary` names, `"ivy"` or `"solverslib"`. The key is required and has no
default: without it, or without a `deploy` block, the verb exits 2 with the same message as
`zenith deploy`.

A path step from `"current"` is written as `DeferredPath.of(...)`, the call both runtimes' `AutoBuilder`
makes, so it is built from the live pose when the step starts. Numbers that come from the path's
length (a marker placed anywhere but the start, a heading shared out by arc length) stay the planned
path's, and the generated method says so in a comment. `examples/starter/generated/` in the
repository has the output for both libraries, and
[Choosing a command library](https://libraries.horizon36596.org/zenith/command-libraries/) explains the
differences.

#### `zenith deploy [--dry-run] [--json] [--project <dir>]`

Copies `autosDir/*.auto.json`, `waypoints.json`, `robot.json` and the field file into
`zenith.json.deploy.dir`. When `zenith.json` has a `codegen` section, it also writes or refreshes a
three-line `@Autonomous` stub per auto under `codegen.dir/<package>/generated/<PascalName>Auto.java`.
Each stub extends `AutoFromFile` from the runtime `deploy.commandLibrary` names:
`org.horizon36596.zenith.ivy` for `"ivy"` or `org.horizon36596.zenith.solverslib` for `"solverslib"`.
The stubs are the only Java the verb writes, so the key is required, with no default, exactly when
there is a `codegen` section; then, without it, the verb copies nothing, exits 2, and prints:

```
zenith: zenith.json does not say which command library your robot code uses, and Zenith does not pick one. Add "commandLibrary": "solverslib" or "commandLibrary": "ivy" to its "deploy" section. See https://libraries.horizon36596.org/zenith/command-libraries/.
```

With no `codegen` section it only copies, needs no library, and writes no OpMode: its first line says
no Java is written, and when it copies an auto it ends with `warning: no "codegen" section, so no
OpMode was written; the Driver Station will not list these autos unless your own OpModes load them.`
The exit code is unchanged. Otherwise the first line of the output names the library
(`command library: Ivy (org.horizon36596.zenith.ivy)`). `--json` output carries it as
`commandLibrary` (`null` when none is named) and has `stubs`, `false` when there is no `codegen`
section. Stubs for autos that no longer exist are removed. An auto with a findings error is skipped (reported, not
copied) but does not stop the other autos from deploying; overall exit code is 1 if anything was
skipped. `--dry-run` lists every action (`copy:`, `write:`, `keep:`, `remove:`) without touching disk.

#### `zenith diff <a> <b> [--json]`

Prints the structural diff between two autos: added, removed, changed and moved steps, as a table or
markdown-flavoured text (or as JSON under `--json`). Calls `@horizon36596/zenith-core`'s `diff`.

#### `zenith sim <auto> [--open] [--timeout <seconds>] [--json] [--project <dir>]`

Runs `zenith.json`'s `sim.command` (with `{auto}` substituted) through the shell, streaming its
output; a non-zero exit or a missing trace file fails with exit 2 and the command's output tail on
stderr. Reads the trace at `sim.trace` and prints estimate vs actual per step (nominal, actual, delta,
and the largest cross-track distance between recorded poses and the planned path) plus a whole-run
summary (structure contacts, launches, tips, pieces held at the end). `--open` also renders the plan
to `autosDir/.renders/<name>.sim.svg` and prints its path, without spawning an image viewer.

#### `zenith calibrate [--traces <dir>] [--write] [--date <date>] [--json] [--project <dir>]`

Pairs every path step's recorded duration (from every `*.trace.json` in `--traces`, or
`traces/`, or `sim.trace`'s directory) against the plan's geometry, and fits `accelInPerS2`, `settleS`,
and a per-heading-mode scale by a grid search over the trapezoidal time model
(the docs site's Simulation page). Reports the residual band left after both
corrections. `--write` updates `robot.json`'s `kinematics.accelInPerS2` and `kinematics.settleS` with
provenance `CALIBRATED FROM SIM <date> (<n> steps)`; the per-mode scale has no field in
`@horizon36596/zenith-schema` yet, so it is reported but not persisted. The CLI reads the clock for the provenance
date (or takes `--date`); `@horizon36596/zenith-core`'s fit itself never does.

#### `zenith setup [--json] [--project <dir>]`

Gets a robot repository clone ready for an agent in one idempotent step: runs `zenith init` when there
is no `zenith.json`, adds the Zenith MCP server to `.mcp.json` (keeping the other servers), checks that
`origin` is on github.com and that a GitHub sign-in works, checks that `zenith.json` is on the default
branch, and validates every auto. Its `next` says the one thing to do next. It never commits.

#### `zenith github status [--json] [--project <dir>]`

`origin`'s owner and repository, its default branch, the signed-in login, push access, the current
branch and its open pull request, with `error` and `next` when something is missing. The sign-in is
`GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`, found by `@horizon36596/zenith-github`'s `findSignIn`;
the token is only ever sent to `api.github.com`.

#### `zenith propose <auto> [--base <branch>] [--branch <name>] [--summary <text>] [--reviewer <login>] [--dry-run] [--json] [--project <dir>]`

Proposing an auto change as a pull request (the docs site's GitHub page), the same steps as the
editor's Propose: it validates the auto (a findings error blocks with exit 1), commits the canonical
auto, a changed waypoints file and the render SVG to `auto/<auto>/<login>` with git, merging the base
in first, pushes the branch (never forced, never to the base) and opens or updates the pull request
through `@horizon36596/zenith-github`'s `openOrUpdatePull`. The commits are built on a private index,
so the person's checkout is left alone. `--dry-run` only renders an SVG to
`autosDir/.renders/<name>.svg` and prints the PR body — `@horizon36596/zenith-core`'s `prBody`, given
the local render path directly as `renderUrl` since a dry run has made no commit for a real GitHub URL
to point at — to stdout.

`zenith diff` and `zenith propose --dry-run` both format through `@horizon36596/zenith-core`'s own
`diffToMarkdown`/`prBody` (this package carries no separate copy of either), so a diff printed by the
CLI and a PR body opened by `@horizon36596/zenith-github` read the same way for the same inputs.

### Driving it with `--json`

Every verb above is safe for an agent or a script to call directly: pass `--json`, read stdout as one
JSON document, and use the exit code to decide whether to keep going.

- Check the exit code first. `0` means the JSON is the successful result. `1` means the auto has a
  findings error; the JSON is a findings list, not the thing you asked for. `2` means something
  prevented the verb from running at all (bad usage, a missing project, an IO error, or a `@horizon36596/zenith-core`
  export not landed yet); the JSON (where the verb prints one on `2`) is `{"error": "..."}`.
- Never parse the human-readable (non-`--json`) output. It is formatted for a terminal and can change
  wording between versions without notice; the JSON shape is the contract.
- `zenith estimate <auto> --json` and `zenith sim <auto> --json` are the two verbs most useful for an
  agent checking its own work after editing an auto: estimate answers "does this still fit the auto
  period", and sim (once a trace exists) answers "did the robot actually do what the plan said".
- `zenith propose <auto> --json` opens or updates the pull request and returns its URL under
  `pullRequest`; it fails loudly (exit 1) if the auto does not validate, and on exit 2 the JSON is
  `{"error": "...", "next": "..."}`, where `next` is the one step that fixes it. With `--dry-run` it
  hands back only the PR body text under `body` and the render path under `render`.
- A verb that depends on a `@horizon36596/zenith-core` M1 export not yet landed in this checkout (`estimate`,
  `ledger`, `render`, `diff`) exits 2 with `{"error": "core M1 not landed yet: ..."}` rather than a
  stack trace, so a script can detect "not ready yet" and retry later instead of treating it as its own
  bug.

### Tests

```
pnpm --filter @horizon36596/zenith-cli test
```

Each verb has a test file next to its command module under `src/commands/`, plus tests for the pure
helpers (`src/javaCodegen.ts`, `src/calibrateFit.ts`, `src/traceReport.ts`, `src/format/`). Tests for
verbs that call into a `@horizon36596/zenith-core` M1 export check both branches - the real result once that export
has landed, and the `core M1 not landed yet` gate message before it has - so the suite passes and stays
meaningful throughout M1, not just at the end of it.
