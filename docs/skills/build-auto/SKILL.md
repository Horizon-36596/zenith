---
name: build-auto
description: Build or edit a Zenith auto (FTC autonomous routine) for this robot from a plain-language brief, using the zenith MCP server, iterating until zenith.validate returns zero errors, and handing back a rendered picture. Use this whenever asked to write, extend, or fix an autonomous routine, a ".auto.json" file, or an auto's path/timing/scoring.
---

# Build an auto

This is a copy of Zenith's own `docs/skills/build-auto/SKILL.md`, dropped into this robot
repository's `.claude/skills/build-auto/` so the same routine-building workflow runs here.
The agents and MCP page of the Zenith docs (`site/docs/agents-mcp.md`) is the full reference this
skill is the short, instruction-form version of; read it if a finding code or a tool's exact input is not covered
below.

You have the `zenith` MCP server (`packages/mcp`, or `@horizon36596/zenith-mcp` from the registry). Use its
tools, not hand-edited JSON: every `zenith.edit.*` tool keeps the file canonical (stable ids,
continuous segments, the exact byte form the file format page, `site/docs/file-format.md`, requires) and hands back
the new findings in the same call, so you rarely need a separate validate round trip.

## Steps

1. **Open the project.** Call `zenith.project.open` first, every time, even if you think you
   remember the robot. It returns the robot's footprint, the full command/condition registry (the
   only legal step verbs and end conditions), the field name and size, every named waypoint, and
   the autos already in the project. Do not invent a command, condition, or waypoint name that
   is not in this list.

2. **Read the brief as constraints, not vibes.** A one-line brief ("score the preload, collect four
   from the garden, score again") names: a start (a waypoint, or a pose you'll set with `setStart`),
   a sequence of scoring/collecting actions (each an existing command from the registry, or a
   `parallel`/`branch` of them), and an end state. On the starter example (`examples/starter` in the
   Zenith repository) that brief reads as: start at the `start` waypoint holding four pollen; drive
   to `scoreSouth` and run `score` with `count` 4; drive to `gardenApproach`, then sweep slowly to
   `gardenPickup` with an `intakeOn` marker and a `hopperFull` end condition; wait until
   `hopperFull`; `intakeOff`; drive back to `scoreSouth` while `spinUp` runs; `score` again. Its
   `collect-and-score.auto.json` is that brief, built and validated, to compare against. If the
   brief is ambiguous about something that changes the file materially — which alliance, which side,
   how many cycles — make the most reasonable call from the registry and the project's existing
   autos and continue; note the assumption when you hand back the result. Stop and ask only if
   nothing reasonable is inferable (e.g., no alliance given anywhere and none can be defaulted).

3. **Start the file.** New auto: `zenith.edit.newAutoFromTemplate` with the alliance, a start pose
   (a waypoint reference or a literal pose), and a name derived from the brief. Editing an existing
   auto: skip this step and go straight to reading it with `zenith.auto.read`.

4. **Build the routine with `zenith.edit.*`.** One call per structural change:
   `addStep`/`removeStep`/`moveStep`/`renameStep` for the step list; `setPose`/`setHeadingMode`/
   `setSpeed`/`addSegment`/`removeSegment` for a path step's geometry; `addMarker`/`removeMarker`/
   `setMarkerAt` for mid-path commands; `setCommandArgs` for a command step's arguments;
   `setTimeout`; `setStart`; `setMeta` for title/description/authors. Prefer a waypoint reference
   over a literal pose when the target is a named spot on the field (a hive, a start, a park zone),
   such as `{ "ref": "scoreSouth" }` — it stays correct if the waypoint is later remeasured. Use a literal pose,
   provenance-labelled per this repository's own convention, only for a point nothing already
   names.

5. **Validate after every call that could break something**, which in practice is every edit call
   — read the `findings` field the tool already returned rather than making a separate
   `zenith.validate` call, unless you want a fresh read with nothing pending. An `error` finding
   blocks; a `warning`/`info` finding is worth a glance but does not.

6. **Fix findings in order, cheapest first.** `SCHEMA` and `CONTINUITY` errors mean the file is
   structurally broken and come first. Then `HEADING_MISSING`, then geometry (`PERIMETER`,
   `STRUCTURE`, `KEEPOUT`, `START_ILLEGAL`), then scoring legality (`LEGAL_APPROACH`,
   `TURRET_RANGE`, `CAPACITY`, `EMPTY_SHOT`), then quality-of-motion (`STRAFE_FRACTION`,
   `MOUTH_LEADING`, `SWEEP_SPEED`), then timing (`TIME_BUDGET`, `TIMEOUT_TIGHT`), then the rest
   (`STATIONARY_MARKER`, `MOVES_ROBOT`, `PROVENANCE`). The full code-to-fix table is in
   `site/docs/checks-and-findings.md`, or read it live from the `zenith://spec/checks` resource. Loop step 4→5→6
   until `errors` is `0`.

7. **Sanity-check the estimate** with `zenith.estimate` — a per-step time wildly off from what the
   brief implies (a two-second brief producing a forty-second plan, or the reverse) usually means a
   step is missing or a speed fraction is wrong, not that the estimator is wrong.

8. **Render a picture.** `zenith.render` with `format: "png"` (or `"svg"` if a human will open it in
   an editor rather than just look at it). Save it next to the auto or attach it to whatever you're
   handing back — a path with no picture is much harder for a human to sanity-check than one with a
   picture, even a correct one.

9. **Hand back a summary, not just a file path.** State: what the auto does, in the order it does
   it; any assumption you made in step 2; the final error/warning count; where the rendered
   picture is. If this was for a PR, that summary is most of the PR body.

## Without MCP: the CLI sequence

No MCP access (a plain shell, or a CI step)? Drive the same loop with the `zenith` CLI instead,
always with `--json` so the output is a document to parse rather than text to scrape
(`packages/cli/README.md` has the exit-code convention every verb shares):

```powershell
zenith new garden-run --alliance RED --json
# hand-edit autos/garden-run.auto.json, or repeat validate/edit/validate below
zenith validate autos/garden-run.auto.json --json
zenith estimate autos/garden-run.auto.json --explain --json
zenith render autos/garden-run.auto.json --png garden-run.png --json
zenith sim autos/garden-run.auto.json --json
zenith propose autos/garden-run.auto.json --dry-run --json
```

There is no CLI verb per `zenith.edit.*` primitive — without MCP, edit the JSON by hand between
`zenith validate` calls, keeping ids stable and segments continuous the way canonical form
requires. Exit code `1` means the JSON is a findings list, not the result you asked for; loop
edit→`validate` until `errors` is `0` before moving on to `estimate`/`render`/`sim`/`propose`. If
the field names a season plugin this build does not carry (or none), every verb's JSON also carries
a `seasonWarnings` array — read it before trusting a `0`, since the checks it is warning about
simply did not run.

## Guardrails

- Never hand-edit the JSON when an MCP tool covers the change; hand-editing is what produces the
  non-canonical diffs and stale ids this workflow exists to avoid.
- Never invent a command, condition, waypoint, or numeric constant. Everything usable comes from
  `zenith.project.open`, `zenith.registry`, or `zenith.waypoints`. A number with no source is a
  `PROVENANCE` finding waiting to happen — label it per this repository's provenance vocabulary
  (`CLAUDE.md`: MEASURED, SET BY HAND, SPEC, NEEDS MEASUREMENT, CARRIED OVER, PLACEHOLDER, APPROX,
  SET FROM SIM, SET FROM EDITOR, CALIBRATED FROM SIM, CALIBRATED FROM ROBOT).
- Do not declare a routine finished with any `error`-severity finding outstanding.
- If a `zenith.edit.*` call returns a tool error, it means the edit was rejected before anything
  was written — the file on disk is untouched. Read the error message (it names the bad id, field,
  or the schema violation) and adjust the call; do not retry the same call unchanged.
