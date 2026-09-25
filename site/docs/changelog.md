# Changelog

This page mirrors the `CHANGELOG.md` at the root of the repository, which is the source of truth for
every release. See the [root changelog](https://github.com/Horizon-36596/zenith/blob/main/CHANGELOG.md).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.1 - 2026-09-25

### Fixed

- **CLI on Linux and macOS.** The `zenith` command installed from npm exited without doing anything,
  because npm links a bin there as a symlink and the CLI did not recognise itself through it. It now
  resolves the link. Windows was not affected. CI now packs and installs the npm packages and runs
  their commands on Linux on every change, which is where this showed.
- **npm.** 0.1.0 was not published to npm, because this fault stopped its publish run. 0.1.1 is the
  first version of the `@horizon36596/zenith-*` packages there. The desktop app, the docs site and
  the robot runtime are unchanged from 0.1.0 apart from the version.

## 0.1.0 - 2026-09-25

The first public release.

### Added

- **Editor, web.** The Zenith editor as a static web app at
  <https://libraries.horizon36596.org/zenith/app/>, public, with no sign-in needed to use it. Draw
  paths with headings, attach commands, and see timing and findings update as you drag. Local mode
  opens a robot repository folder and saves in place in Chrome and Edge.
- **Editor, desktop.** A Windows installer and a portable exe on GitHub Releases, built from the same
  UI. Adds native folder open, file watching, the high-fidelity sim button with an automatic overlay,
  deploy, and commit, push and open a pull request. Not code-signed yet, so SmartScreen warns on first
  run.
- **Playback levels.** Three levels, chosen under the timeline's scrubber: **Ideal** (the
  default) follows the planned path exactly on the estimate's clock and turns or drives across any
  gap between steps; **Instant sim** is the preview sim; **Full sim** plays a loaded
  high-fidelity sim trace. The robot, the timeline and the readouts say which level they show.
  `idealTrajectory` and `idealPoseAt` in `@horizon36596/zenith-core` compute the ideal level.
- **Headings by Pedro's names.** The editor names each heading mode the way Pedro Pathing does:
  Tangent, Reverse tangent, Constant, Linear, Facing point and Piecewise, with the plain meaning and
  the Pedro call in each mode's tooltip. The values in the file did not change.
- **Heading arrows.** The selected path shows its heading as arrows on the field, which you drag to
  turn it: a Constant's two arrows turn together, a Linear's start and end turn apart. They snap to
  15° steps like points do.
- **Piecewise headings.** A `piecewise` heading mode gives each stretch of a path its own mode, as
  ranges of t from 0 to 1. Split a range on the inspector's track or with **Split heading here** on
  the path's right-click menu, and drag a boundary's tick along the path. The runtime follows it with
  Pedro's piecewise interpolator. It moves the auto `formatVersion` to 3; version 1 and 2 files load
  and are migrated.
- **Direct dot drags.** Any path's dot can be dragged straight away, without selecting its step
  first; the drag selects the step, and one undo puts the dot back.
- **Tour.** A first-run tour of six stops, then an optional tour of every feature. It is
  non-modal: every control in the editor works while it runs, and its card keeps clear of what it
  points at and of any open menu, tooltip or dialog.
- **One tooltip at a time.** Opening a tooltip closes any other, and keyboard focus opens a
  tooltip only when it came from the keyboard, not from a click.
- **Step kinds.** Path, command, wait (for seconds or until a condition), sequence, parallel (all,
  race or deadline) and branch (if/else).
- **Checks and findings.** Continuity, perimeter, keep-out, heading, capacity, legal approach, start
  legality and timing checks, each with a plain-language explanation and, where one exists, a
  one-click fix.
- **Instant sim.** A deterministic follower sim in the core that re-runs on every edit and drives
  playback, the hover robot and the timeline.
- **Provenance.** Every number in `robot.json` and `field.json` carries a provenance label, shown and
  ranked in the editor.
- **CLI.** `@horizon36596/zenith-cli`, which installs the `zenith` command: `init`, `new`,
  `validate`, `estimate`, `render`, `codegen`, `deploy`, `diff`, `sim`, `calibrate` and
  `propose --dry-run`. Every verb takes `--json` and none of them prompts.
- **MCP server.** `@horizon36596/zenith-mcp`, which installs `zenith-mcp`: the same work as MCP tools,
  plus structural edit primitives so an agent never hand-edits JSON.
- **Libraries on npm.** `@horizon36596/zenith-schema`, `@horizon36596/zenith-core`,
  `@horizon36596/zenith-seasons`, `@horizon36596/zenith-season-biobuzz` and
  `@horizon36596/zenith-github`, published with provenance.
- **Robot runtime, on Ivy or SolversLib.** The Java runtime that plays an auto file on the robot
  through Pedro Pathing v3, on JitPack as `com.github.Horizon-36596:zenith`. It builds the file into
  a command tree on either of two command libraries, both first-class: Ivy, Pedro Pathing's own
  (`com.pedropathing.ivy:pedro:1.1.1`), with the classes in `org.horizon36596.zenith.ivy`, or
  SolversLib (`org.solverslib:core:0.3.6`), with the classes in `org.horizon36596.zenith.solverslib`.
  The classes a team uses have the same names in both packages, and what names no command library,
  such as `Args` and `RobotClock`, is shared in `org.horizon36596.zenith`. One artifact holds both, and
  a team declares only the library its robot code uses. A new auto needs no Java edit. On either
  library, if a command left running from init blocks the routine at start, the OpMode fails and
  names what blocked it rather than doing nothing. See
  [Robot runtime](robot-runtime.md) and [Choosing a command library](command-libraries.md).
- **`deploy.commandLibrary` in `zenith.json`.** `"ivy"` or `"solverslib"`, the library the robot code
  uses. Zenith picks neither, and writes no Java until it is set: `zenith codegen` refuses without it,
  and so do `zenith deploy` and the desktop app's Deploy when `zenith.json` has a `codegen` section,
  because only then do they write OpMode stubs. `zenith deploy` writes stubs for the named runtime and
  names it on the first line of its output, the desktop app's deploy preview names it, and
  `zenith codegen` writes that runtime's form of the readable class. `zenith init --command-library ivy`
  or `--command-library solverslib` writes it into a new project; without the option, `init` leaves it
  out and says so.
- **Alliance mirroring, headings included.** A file run as the other alliance is mirrored through the
  team's `ZenithRobot.mirror`, poses and headings together, decided in one place
  (`AutoFile.mirrorsInto`). A `constant` heading and the start of a `linear` sweep go through the
  mirror, a `facePoint` point goes through it, a sweep keeps its size and turns the other way under a
  reflection, and every `piecewise` range is treated the same way. The runtime reads how headings move
  and whether turns reverse from the team's mirror, so a point symmetry and a reflection both work, and
  a mirror whose headings disagree with its positions fails at init. The editor's mirror to the other
  alliance keeps a `linear` sweep's size and direction the same way, and the robot tests check that a
  file run as the other alliance drives what the editor's mirror of it drives, on both runtimes, under
  a point symmetry and a reflection.
- **Conformance suite.** Every starter auto, and a fixture for every end rule, timeout, parallel mode,
  branch arm, marker kind, piecewise headings and three-deep nesting, runs through both runtimes in the robot
  tests, as its own alliance and mirrored, which fail unless every step, command and path starts and
  ends on the same loop on both.
- **Generated Java examples.** The starter's `cycle-and-park` auto (markers, timeouts, an end
  condition, a race, a deadline group with a sequence in it, and a branch) has what `zenith codegen`
  and `zenith deploy` write for it with each command library checked in under
  `examples/starter/generated/`, and a test fails if those files go stale.
- **GitHub mode.** Sign in with a fine-grained personal access token, edit on a work branch
  (`auto/<autoName>/<login>`), and propose a pull request whose body carries a rendered SVG, an
  estimate table and the end-of-routine ledger. Review mode draws the base and head of a pull request
  together from a `#/review/<owner>/<repo>/<number>` link.
- **BIOBUZZ season plugin.** The field file and rules for BIOBUZZ presented by RTX (FTC 2026-27):
  hives, tip table, flowers, garden and pollen, the legal-approach rule and the start rules.
- **Starter example.** A generic mecanum robot with one front intake, round PLACEHOLDER numbers, the
  BIOBUZZ field, waypoints and teaching routines that cover every step kind.
- **JSON Schemas.** Published at `https://libraries.horizon36596.org/zenith/schema/v1/<kind>.json`.
- **Documentation.** The docs site at <https://libraries.horizon36596.org/zenith/>: getting started,
  the editor guide, a newcomer's guide to autonomous paths, the file-format reference, checks, sims,
  the robot runtime, choosing a command library, the CLI, agents and MCP, seasons, GitHub, and the FAQ.
