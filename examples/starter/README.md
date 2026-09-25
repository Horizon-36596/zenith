# The starter example

A small robot project on the BIOBUZZ field, laid out the way a robot repository lays out its Zenith
files. The web app and the desktop app open it with **Load example**, the getting-started guide walks
through `first-auto`, and the tests use it.

**Every number in the robot and waypoint files is a placeholder.** The robot is made up: a plain
mecanum robot, 18 by 18 in, with one intake at the front and a fixed launcher. Its speeds, sizes and
poses are round numbers marked `PLACEHOLDER`, so nothing here is measured on a real robot. Copy the
layout, not the values; measure your own robot and field and replace each one along with its
provenance label.

## Files

| file | what it is |
|---|---|
| `zenith.json` | The link file: where the robot, field and waypoint files live, where `zenith deploy` copies the autos, the command library the generated Java is written for, the robot class the generated OpModes build, and the command that runs the robot repository's sim. |
| `autos/robot.json` | The robot: footprint, speeds, the one front intake (a `mouth`), the pollen it may hold, and the commands and conditions its code registers with `NamedCommands`. |
| `autos/field/biobuzz.field.json` | A copy of the BIOBUZZ field from `@horizon36596/zenith-season-biobuzz`. Its numbers come from the game manual. |
| `autos/waypoints.json` | Named poses the autos share: `start`, `scoreSouth`, `gardenApproach`, `gardenPickup` and `park`. Move one and every auto that uses it moves too. |
| `autos/first-auto.auto.json` | Drive out, score the preload, park. Three steps. The getting-started guide walks through it. |
| `autos/collect-and-score.auto.json` | Score the preload, collect four pollen from the garden and score again. Shows a marker on a path, a `parallel` deadline group with a `sequence` in it, and a `wait` until a condition. |
| `autos/all-step-kinds.auto.json` | One of every step kind: path, command, wait for a time, wait until, sequence, parallel all, race and deadline, and branch. |
| `autos/cycle-and-park.auto.json` | Score the preload, try one garden cycle with a time limit, score again only if the robot is holding pollen, and park. Uses markers, timeouts, an end condition, a race, a deadline group with a sequence in it, and a branch. The Java in `generated/` is written from it. |
| `generated/` | What `zenith codegen` and `zenith deploy` write for `cycle-and-park`, once for Ivy and once for SolversLib. Generated; never edit it. [`generated/README.md`](generated/README.md) says where each file would live in a robot project and how the two libraries' files differ. |

Each auto's `description` and each step's `notes` say what it shows.

## The command library

The starter's `zenith.json` sets `"commandLibrary": "solverslib"` in its `deploy` block, because
Horizon (FTC 36596) runs SolversLib on its own robot. A team whose robot code uses Ivy changes it to
`"commandLibrary": "ivy"`. Zenith has no default: if the key is removed, `zenith deploy` and
`zenith codegen` refuse to write any Java until it is put back.

## Commands and conditions

The robot file registers generic names. Your robot code registers the same names with
`NamedCommands` (see the robot runtime guide), or you rename them in both places.

| name | kind | what it does |
|---|---|---|
| `intakeOn` | command | Runs the front intake and keeps it running. |
| `intakeOff` | command | Stops the front intake. |
| `spinUp` | command | Brings the launcher up to speed. |
| `score` | command | Launches `count` pollen into the up hive cell. The robot stands still while it runs. |
| `holdingPiece` | condition | At least one pollen is aboard. |
| `hopperFull` | condition | The robot holds four pollen, the most BIOBUZZ allows. |
| `hopperEmpty` | condition | The robot holds no pollen. |

## Check it

Every auto here validates with no errors and no warnings:

```powershell
pnpm zenith -- validate examples/starter/autos/first-auto.auto.json examples/starter/autos/collect-and-score.auto.json examples/starter/autos/all-step-kinds.auto.json examples/starter/autos/cycle-and-park.auto.json
```

## Regenerate the Java

A test, `packages/cli/src/commands/starterJava.golden.test.ts`, runs `zenith codegen` and
`zenith deploy` on a copy of this project for each command library and fails if the files in
`generated/` differ from what they write now. After a change to `cycle-and-park` or to the Java Zenith
writes, regenerate them from the repository root with `ZENITH_UPDATE_GOLDEN` set, then check the diff:

```powershell
$env:ZENITH_UPDATE_GOLDEN = '1'; pnpm vitest run packages/cli/src/commands/starterJava.golden.test.ts; Remove-Item Env:ZENITH_UPDATE_GOLDEN
```
