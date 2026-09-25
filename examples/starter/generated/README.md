# Generated Java for `cycle-and-park`

This folder holds the Java that Zenith writes for the starter example's
[`cycle-and-park`](../autos/cycle-and-park.auto.json) auto, once for each command library the robot
runtime supports. It is here so you can read Zenith's Java output without running anything.

| file | written by | what it is |
|---|---|---|
| `solverslib/CycleAndParkAuto.java` | `zenith deploy` | the `@Autonomous` OpMode stub, for SolversLib |
| `solverslib/CycleAndParkGenerated.java` | `zenith codegen cycle-and-park` | the readable class, for SolversLib |
| `ivy/CycleAndParkAuto.java` | `zenith deploy` | the `@Autonomous` OpMode stub, for Ivy |
| `ivy/CycleAndParkGenerated.java` | `zenith codegen cycle-and-park` | the readable class, for Ivy |

Every file here is generated. Never edit one; change the auto or the code that writes it, and
regenerate.

## Where the files go in a robot project

The starter's `zenith.json` has `codegen.package` set to `org.firstinspires.ftc.teamcode.zenith` and
`codegen.dir` set to `TeamCode/src/main/java`. In a robot project with that `zenith.json`, the files
would be written to:

- `TeamCode/src/main/java/org/firstinspires/ftc/teamcode/zenith/CycleAndParkGenerated.java`
- `TeamCode/src/main/java/org/firstinspires/ftc/teamcode/zenith/generated/CycleAndParkAuto.java`

A project writes one library's files, the one `deploy.commandLibrary` in `zenith.json` names, and
the commands refuse when it names none. The starter's `zenith.json` names `"solverslib"`, so it would
get the SolversLib files. The two folders here come from running the commands with
`"commandLibrary": "ivy"` and with `"commandLibrary": "solverslib"`.

## The stub and the readable class

The stub is what runs on the robot. It names the auto file and the robot class, and the runtime loads
the file from the APK's assets and builds the routine at init. It is the class the Driver Station lists.

The readable class writes the same plan out as Java, one private method per step, called in file order
from `buildRoutine()`. It is abstract and no OpMode uses it. It is for reading an auto as code and for
teams that use the file format without the runtime.

## How the two libraries' files differ

The stubs differ only in two imports: `AutoFromFile` and `ZenithRobot` come from
`org.horizon36596.zenith.solverslib` for SolversLib and from `org.horizon36596.zenith.ivy` for Ivy.

The readable classes have the same methods, in the same order, with the same numbers. They differ in
the types they use:

- **Poses.** The SolversLib class builds SolversLib `Pose2d`s and converts each with
  `Poses.toPedro(...)` before it reaches Pedro's `Paths`. The Ivy class builds Pedro `Pose`s and passes
  them straight in.
- **Groups.** The routine and the sequence inside `returnToScore` are a `SequentialCommandGroup` for
  SolversLib and the runtime's `Sequence` for Ivy. The branch is a `ConditionalCommand` for SolversLib
  and the runtime's `Branch.of(...)` for Ivy. The race and the deadline group are the runtime's own
  `Parallel` in both.
- **Waits and empty steps.** The sweep's `endCondition` is raced against `new WaitUntilCommand(...)`
  for SolversLib and `Commands.waitUntil(...)` for Ivy. The branch's empty else arm is
  `new InstantCommand()` or `Commands.instant(() -> { })`.
- **Imports.** Command types come from `com.seattlesolvers.solverslib.command` or
  `com.pedropathing.ivy`, and the runtime classes from `org.horizon36596.zenith` or
  `org.horizon36596.zenith.ivy`. Both use `org.horizon36596.zenith.Args`.

## How they are checked

A test in the CLI package, `packages/cli/src/commands/starterJava.golden.test.ts`, runs `zenith codegen`
and `zenith deploy` on a copy of the starter project for each library and fails if a file here differs
from what they write now. The robot build compiles both readable classes with the runtime's unit tests
and runs them against the routine the runtime builds from the file, on both alliances and down both
arms of the branch, and checks that they do the same thing loop for loop.

To regenerate the files after a change, run the test from the repository root with
`ZENITH_UPDATE_GOLDEN` set, then read the diff before you commit it:

```powershell
$env:ZENITH_UPDATE_GOLDEN = '1'; pnpm vitest run packages/cli/src/commands/starterJava.golden.test.ts; Remove-Item Env:ZENITH_UPDATE_GOLDEN
```

## Paths that start from `"current"`

Four path steps in this auto start from `"current"`: `toGarden`, `sweepGarden`, `driveBack` and `park`.
The readable class writes each one as `DeferredPath.of(...)`, the same call the runtime makes, so the
path is built when the step starts, from wherever the robot is then:

```java
private Command stepSweepGarden() {
    // Starts from "current": built when the step starts, from where the robot is then.
    return DeferredPath.of("sweepGarden", this, from -> stepSweepGardenFrom(from), NamedCommands.build("intakeOn", Args.of(), this));
}
```

`stepSweepGardenFrom(from)` builds the path from that pose. The marker commands passed after it are
built at init so their requirements are declared up front, as the runtime declares them.

One thing stays planned: a number that comes from the path's length, such as the distance of a marker
placed anywhere but the very start, or a heading shared out between segments by arc length. A step from
`"current"` that has one carries a comment saying so. None of this auto's four does; the sweep's marker
is at the start.
