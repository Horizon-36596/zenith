---
name: build-auto
description: Plan, build and verify a Zenith auto (FTC autonomous routine) for this robot from a plain-language brief. Does the ball arithmetic and the time budget before choosing any pose, builds the routine with the zenith MCP server until zenith.validate returns zero errors, renders a picture, and - in a robot repository with a headless sim - runs it as a match twice and on both alliances before handing back. Use this whenever asked to write, plan, re-plan, extend, speed up or fix an autonomous routine, a ".auto.json" file, or an auto's path/timing/scoring, or when a goal is named in game terms ("get three tips", "clear the garden first").
---

# Build an auto

This is Zenith's own `docs/skills/build-auto/SKILL.md`. A robot repository carries a copy at
`.claude/skills/build-auto/` (with its `references/`) so the same workflow runs there; change it here and
re-copy, never the other way round. The agents and MCP page of the Zenith docs (`site/docs/agents-mcp.md`)
is the full reference this skill is the short, instruction-form version of.

**The one sentence.** An auto is decided by ball arithmetic and a time budget, not by poses. Poses are
what falls out at the end. A session that opens the file and starts placing points has already lost.

The workflow has three parts, and each one only means something if the one before it was done:
**plan** (arithmetic, time, the robot as it is), **build** (the `zenith.edit.*` loop until `errors` is
`0`), and **verify** (Zenith's estimate and render everywhere; a headless match run where the robot
repository has one). `references/checklist.md` is the numbered list behind all three, every item a mistake
that has already been made once. `references/seasons/` holds one field ledger per season - where the
game pieces are, what a score costs, what stops the robot - read the one for the field you are on.
**A robot repository's copy may add `references/robot.md`**: that robot's measured speeds, launch
cadence, intake geometry and headless harness. If it is there, read it before step 3; it is the only
place those numbers come from.

You have the `zenith` MCP server (`packages/mcp`, or `@horizon36596/zenith-mcp` from the registry). Use its
tools, not hand-edited JSON: every `zenith.edit.*` tool keeps the file canonical (stable ids, continuous
segments, the exact byte form `site/docs/file-format.md` requires) and hands back the new findings in the
same call, so you rarely need a separate validate round trip. No MCP? See "Without MCP" below.

## Plan - before any pose

1. **Open the project.** Call `zenith.project.open` first, every time, even if you think you remember
   the robot. It returns the robot's footprint, the full command/condition registry (the only legal step
   verbs and end conditions), the field name and size, every named waypoint, and the autos already in the
   project. Do not invent a command, condition, or waypoint name that is not in this list.

2. **Audit, then read the robot as it is.** List the autos already in the project and read any whose
   name or purpose overlaps the brief: prior sessions scaffold ahead, and the right move is to evolve
   that file rather than add a near-duplicate. In a robot repository, also read what the registry names
   stand for (its own docs, and `references/robot.md` if it has one) and write down the intake archetype
   you are planning for: how many mouths, where, how wide, how many pieces the robot may hold, and what "full"
   means. Helper names and intake shapes change under an auto; an auto written against a stale robot
   validates for a while and then does not.

3. **Do the arithmetic, and write it down.** From the season's field ledger: how many game pieces the
   goal needs, how many exist within reach by source (nearest first, and only sources that can actually
   be collected), how many scores that pays for, and what is left over. If the arithmetic does not close,
   the plan is wrong and no amount of pose tuning fixes it - bring the shortfall to the human instead of
   building a routine that cannot reach its own goal.

4. **Budget the time.** AUTO is 30 s. Estimate every leg from the robot's measured speeds and launch
   cadence (`references/robot.md`, or the robot file), total them, and say which score lands after the
   buzzer if the total runs over. After step 7 below, `zenith.estimate` checks this estimate; a large
   disagreement means one of the two is wrong, and finding out which is part of the job.

5. **Read the brief as constraints, not vibes.** A one-line brief ("shoot the preload for the first tip,
   then collect from the other side and score again") names: a start (a waypoint, or a pose you'll set
   with `setStart`), a sequence of scoring/collecting actions (each an existing command from the registry,
   or a `parallel`/`branch` of them), and an end state. On the starter example (`examples/starter` in the
   Zenith repository) that brief reads as: start at the `start` waypoint holding four pollen; drive to
   `scoreSouth` and run `score` with `count` 4, which tips the hive and turns its up cell north; drive
   around the hive to `flowerNorthApproach`, then slowly to `flowerNorthPickup` with an `intakeOn` marker
   and a `hopperFull` end condition; wait until `hopperFull`; `intakeOff`; drive to `scoreNorth` and
   `score` 4; sweep the garden line from `gardenSweepStart` to `gardenSweepEnd`; drive back to `scoreNorth`
   while `spinUp` runs; `score` 4 again for the second tip. Its `collect-and-score.auto.json` is that
   brief, built and validated, to compare against. If the brief is ambiguous about something that changes the file materially - which
   alliance, which side, how many cycles - make the most reasonable call from the registry, the ledger and
   the project's existing autos and continue; note the assumption when you hand back the result. Stop and
   ask only if nothing reasonable is inferable.

## Build - the edit loop

6. **Start the file.** New auto: `zenith.edit.newAutoFromTemplate` with the alliance, a start pose (a
   waypoint reference or a literal pose), and a name derived from the brief. Editing an existing auto:
   skip this step and read it with `zenith.auto.read`.

7. **Build the routine with `zenith.edit.*`.** One call per structural change:
   `addStep`/`removeStep`/`moveStep`/`renameStep` for the step list; `setPose`/`setHeadingMode`/
   `setSpeed`/`addSegment`/`removeSegment` for a path step's geometry; `addMarker`/`removeMarker`/
   `setMarkerAt` for mid-path commands; `setCommandArgs` for a command step's arguments; `setTimeout`;
   `setEnvelope`/`setEnvelopeCorner`/`addEnvelopeCorner`/`removeEnvelopeCorner` for the area a step
   whose path nobody can predict stays in, and `setRejoinFrom` for where the path after it starts;
   `setStart`; `setMeta` for title/description/authors. Prefer a waypoint reference over a literal pose
   when the target is a named spot on the field (a hive, a start, a park zone), such as
   `{ "ref": "scoreSouth" }` - it stays correct if the waypoint is later remeasured. Use a literal pose,
   provenance-labelled, only for a point nothing already names. While building, the rules that the
   checks only partly catch (`references/checklist.md` items 5-10):
   - **Legs are tangent unless a mouth has to lead.** Turn where the robot is already stationary, which in
     practice means during a volley.
   - **Sweeps collect mouth leading, at no more than 0.4 of max speed, stopping inside the gap to the next
     piece.** Never sweep a row sideways: the body is wider than the mouth, so it shoves the row along
     instead of eating it. A full-speed sweep stops too late and pushes the last piece out of reach.
   - **Every shoot pose must be legal for the goal state at that point in the routine**, not the one at
     kickoff. A score can change which goal is open (on BIOBUZZ a tip swaps which cell is up).
   - **Give every step a distinct name.** The run report and the step log key on it; two steps with one
     name read as one.

8. **Validate after every call that could break something**, which in practice is every edit call - read
   the `findings` field the tool already returned rather than making a separate `zenith.validate` call,
   unless you want a fresh read with nothing pending. An `error` finding blocks; a `warning`/`info`
   finding is worth a glance but does not.

9. **Fix findings in order, cheapest first.** `SCHEMA` and `CONTINUITY` errors mean the file is
   structurally broken and come first. Then `HEADING_MISSING`, then geometry (`PERIMETER`, `STRUCTURE`,
   `CLEARANCE`, `KEEPOUT`, `OPPONENT_SIDE`, `START_ILLEGAL`), then scoring legality (`LEGAL_APPROACH`, `TURRET_RANGE`, `CAPACITY`,
   `EMPTY_SHOT`, `LAUNCH_TARGET`), then quality-of-motion (`STRAFE_FRACTION`, `MOUTH_LEADING`, `SWEEP_SPEED`), then timing
   (`TIME_BUDGET`, `TIMEOUT_TIGHT`), then the rest (`STATIONARY_MARKER`, `MOVES_ROBOT`, `PROVENANCE`). The
   full code-to-fix table is in `site/docs/checks-and-findings.md`, or read it live from the
   `zenith://spec/checks` resource. Loop 7 -> 8 -> 9 until `errors` is `0`.

## Verify - in this order

10. **Sanity-check the estimate** with `zenith.estimate` against your step-4 budget. A per-step time
    wildly off from what the brief implies (a two-second brief producing a forty-second plan, or the
    reverse) usually means a step is missing or a speed fraction is wrong, not that the estimator is wrong.

11. **Render a picture.** `zenith.render` with `format: "png"` (or `"svg"` if a human will open it in an
    editor). Save it next to the auto or attach it to whatever you're handing back - a path with no
    picture is much harder for a human to sanity-check than one with a picture, even a correct one.

12. **Run it as a match, if the robot repository can.** Zenith's checks and `zenith sim` read the field
    file's geometry and the robot file's footprint; they do not run the robot's code. A robot repository
    with a headless simulation harness does, on a field with game-piece physics, and it is the higher
    authority wherever the two disagree - they can, because a field file can be wrong about the real
    field (the season ledger says where it is known to be). `references/robot.md` in the robot repository
    names the harness and the exact commands. Whatever the harness, the run must:
    - stop the OpMode at 30 s the way the field does, and count a score as AUTO only if the field
      counts it as AUTO; assert that count, not one from a run with no buzzer;
    - run **twice** with identical decoded logs, and **once on the other alliance**, which must score the
      same;
    - show no structure contact except the intended kind (pulling from a goal you are pressed against),
      strafing under a fifth of the driving, and the robot's belief agreeing with the sim's truth.
    No harness? Say that this step was not run. Do not report `zenith sim` as a match result.

13. **Hand back a summary, not just a file path.** State: what the auto does, in the order it does it;
    the arithmetic and the time budget from steps 3-4; any assumption from step 5; the final error/warning
    count; where the rendered picture is; and, if step 12 ran, the scores counted as AUTO and the report's
    flags. If step 12 produced an RLOG, hand it over properly: a clickable path checked in this session to
    exist and be non-empty, the command that regenerates it (`build/` is gitignored), which AdvantageScope
    tab and keys to open, and the one specific thing that would be wrong. List the human items last: poses
    to measure on the real field, assumed geometry to confirm, and the replay only a person can judge. If
    this was for a PR, that summary is most of the PR body.

## Without MCP: the CLI sequence

No MCP access (a plain shell, or a CI step)? Drive the same loop with the `zenith` CLI instead, always
with `--json` so the output is a document to parse rather than text to scrape (`packages/cli/README.md`
has the exit-code convention every verb shares):

```powershell
zenith new garden-run --alliance RED --json
# hand-edit autos/garden-run.auto.json, or repeat validate/edit/validate below
zenith validate autos/garden-run.auto.json --json
zenith estimate autos/garden-run.auto.json --explain --json
zenith render autos/garden-run.auto.json --png garden-run.png --json
zenith sim autos/garden-run.auto.json --json
zenith propose autos/garden-run.auto.json --dry-run --json
```

There is no CLI verb per `zenith.edit.*` primitive - without MCP, edit the JSON by hand between
`zenith validate` calls, keeping ids stable and segments continuous the way canonical form requires. Exit
code `1` means the JSON is a findings list, not the result you asked for; loop edit -> `validate` until
`errors` is `0` before moving on to `estimate`/`render`/`sim`/`propose`. If the field names a season plugin
this build does not carry (or none), every verb's JSON also carries a `seasonWarnings` array - read it
before trusting a `0`, since the checks it is warning about simply did not run.

## Guardrails

- Never hand-edit the JSON when an MCP tool covers the change; hand-editing is what produces the
  non-canonical diffs and stale ids this workflow exists to avoid.
- Never invent a command, condition, waypoint, or numeric constant. Everything usable comes from
  `zenith.project.open`, `zenith.registry`, `zenith.waypoints`, or the season's field ledger. A number with
  no source is a `PROVENANCE` finding waiting to happen - label it per the repository's provenance
  vocabulary (`CLAUDE.md`: MEASURED, SET BY HAND, SPEC, NEEDS MEASUREMENT, CARRIED OVER, PLACEHOLDER,
  APPROX, SET FROM SIM, SET FROM EDITOR, CALIBRATED FROM SIM, CALIBRATED FROM ROBOT).
- Do not declare a routine finished with any `error`-severity finding outstanding, or with step 12 skipped
  where the repository could have run it.
- If a `zenith.edit.*` call returns a tool error, the edit was rejected before anything was written - the
  file on disk is untouched. Read the error message (it names the bad id, field, or the schema violation)
  and adjust the call; do not retry the same call unchanged.
- Do not tune the drivetrain, change measured constants, add a dependency, or decide alliance strategy
  (which partner goes where, whose preloads are free). Those are human calls; name them in the hand-back.
