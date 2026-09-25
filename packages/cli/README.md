# @horizon36596/zenith-cli

The `zenith` command for [Zenith](https://libraries.horizon36596.org/zenith/), the FTC autonomous
planner by Horizon (FTC 36596). It validates, estimates, renders, generates code for, deploys and
simulates the autos in a robot repository, with `--json` on every verb and no prompts, so a CI job
or an agent can drive it.

```
npm install --save-dev @horizon36596/zenith-cli
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
pnpm --filter @horizon36596/zenith-cli build
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

- `--json` on every verb prints machine-readable output instead of the human-readable text, and never
  mixes the two.
- No verb ever prompts. If stdin would be needed for a decision, the verb fails instead.
- Exit codes are the same convention everywhere: **0** ok, **1** the auto has findings errors (a
  validation or feasibility problem in the auto itself), **2** usage, IO, or a verb that depends on a
  `@horizon36596/zenith-core` export not landed yet.
- Every verb that calls a `@horizon36596/zenith-core` M1 export (`estimate`, `ledger`, `render`, `diff`) is real
  as of this build; `src/coreGate.ts`'s `NotImplementedError` handling (`core M1 not landed yet:
  ...` to stderr, or `{"error": "..."}` under `--json`, exit code 2) is a defensive fallback rather
  than the common case, kept so a future gap still fails with a clear message instead of a stack
  trace.
- Every verb that needs season-specific rules (`validate`, `estimate`, `render`, `sim`, `propose`)
  resolves them through `@horizon36596/zenith-seasons` from the project's `field.json`. When the field names no
  season plugin, or one this build does not carry, the season-gated checks (`CAPACITY`,
  `EMPTY_SHOT`, `MOUTH_LEADING`, `SWEEP_SPEED`, `START_ILLEGAL`, `LEGAL_APPROACH`, `TURRET_RANGE`)
  and the ledger are simply absent rather than wrong; the verb still runs and prints a `warning:`
  line to stderr (and a `seasonWarnings` array under `--json`) saying so.

### Verbs

#### `zenith validate <autos...> [--json] [--project <dir>]`

Checks one or more `.auto.json` files against the schema and the feasibility rules. Prints a findings
table (or JSON). Exit 1 if any file has an error-level finding.

#### `zenith init [--command-library ivy|solverslib] [--json] [--force]`

Writes a starter `zenith.json` and an `autos/` directory that validates, for a new project.
`--command-library` writes `deploy.commandLibrary`; the value is read in any case and written
lowercase. There is no default: without it the `deploy` section names no library, `init` prints a
note, and `zenith codegen` refuses, as does `zenith deploy` once there is a `codegen` section, until
`"ivy"` or `"solverslib"` is added.

#### `zenith new <name> [--alliance RED|BLUE] [--json] [--force] [--project <dir>]`

Writes a new `.auto.json` from a canonical skeleton.

#### `zenith estimate <auto> [--json] [--explain] [--project <dir>]`

Prints a per-step table (id, kind, nominal time, low-high band, strafe percentage, an unknown-time
flag) and the total against the field's auto period. `--explain` also prints the assumptions behind
the numbers (`estimate.explain`). Calls `@horizon36596/zenith-core`'s `estimate`.

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

With no `codegen` section it only copies, and needs no library. The first line of the output names the library
(`command library: Ivy (org.horizon36596.zenith.ivy)`), and `--json` output carries it as
`commandLibrary` (`null` when there is no `codegen` section and none is named). Stubs for autos that no longer exist are removed. An auto with a findings error is skipped (reported, not
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

#### `zenith propose <auto> [--dry-run] [--base <branch>] [--json] [--project <dir>]`

The CLI half of proposing an auto change as a pull request (the docs site's GitHub page). Only `--dry-run` is implemented
here: it validates the auto (a findings error blocks with exit 1), renders an SVG to
`autosDir/.renders/<name>.svg`, and prints the PR body — `@horizon36596/zenith-core`'s `prBody`, given the local
render path directly as `renderUrl` since a `--dry-run` run has made no commit for a real GitHub URL
to point at — to stdout. Without `--dry-run` it prints "GitHub mode: use the web app or pass
--dry-run" and exits 2, because opening an actual pull request is `@horizon36596/zenith-github`'s job, which this
package does not depend on.

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
- `zenith propose <auto> --dry-run --json` is the one to call before asking a human to open a real pull
  request: it fails loudly (exit 1) if the auto does not validate, and otherwise hands back the exact
  PR body text under `body` and the render path under `render`.
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
