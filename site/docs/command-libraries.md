# Choosing a command library

The robot runtime turns an auto file into a tree of commands and runs it. It can build that tree from
either of two command libraries, and both are first-class:

- **Ivy**, Pedro Pathing's own command library (`com.pedropathing.ivy:pedro:1.1.1`, on Maven Central).
  The runtime's classes are in `org.horizon36596.zenith.ivy`.
- **SolversLib** (`org.solverslib:core:0.3.6`). The runtime's classes are in
  `org.horizon36596.zenith.solverslib`.

The two runtimes are symmetric: the same class names in two packages. `AutoFromFile`, `ZenithRobot`,
`NamedCommands`, `AutoContext`, `Parallel`, `RobotTimeout`, `WaitRobotTime`, `DeferredPath` and the rest
exist in both, and a robot class imports them from the package of its library. What names no command
library, such as `Args` and `RobotClock`, is shared by both and lives in `org.horizon36596.zenith`.

Both runtimes ship in the one Zenith artifact on JitPack, and both follow paths with Pedro Pathing v3.
They read the same `*.auto.json`, `robot.json`, `field.json` and `waypoints.json`, so a team can plan
with Zenith whichever library its robot code uses. Zenith does not pick one for you: each project names
its library in `zenith.json`.

## You must choose

Set `commandLibrary` in the `deploy` block of `zenith.json` to the library your robot code uses. A new
project can name it when it is made, with one of:

```powershell
npx zenith init --command-library ivy
```

```powershell
npx zenith init --command-library solverslib
```

In an existing project, add it by hand.

For Ivy:

```json
"deploy": {
  "kind": "androidAssets",
  "dir": "TeamCode/src/main/assets/autos",
  "commandLibrary": "ivy",
  "robotClass": "org.firstinspires.ftc.teamcode.zenith.MyRobot"
}
```

For SolversLib:

```json
"deploy": {
  "kind": "androidAssets",
  "dir": "TeamCode/src/main/assets/autos",
  "commandLibrary": "solverslib",
  "robotClass": "org.firstinspires.ftc.teamcode.zenith.MyRobot"
}
```

There is no default. Until the key is set, every command that would write Java refuses, and says:

```text
zenith.json does not say which command library your robot code uses, and Zenith does not pick one. Add "commandLibrary": "solverslib" or "commandLibrary": "ivy" to its "deploy" section. See https://libraries.horizon36596.org/zenith/command-libraries/.
```

Exactly two things write Java:

- **`zenith codegen`** always writes a class, so it always needs the key. A project that only uses
  codegen still needs a `deploy` block with `kind`, `dir` and `commandLibrary`.
- **`zenith deploy`**, and the desktop app's Deploy preview and button, write one OpMode stub per auto
  when `zenith.json` has a `codegen` section, which says where the stubs go. With a `codegen` section
  they need the key, and check it before they copy anything. Without one they only copy the auto,
  robot, field and waypoint files, which name no library, so they run without the key and say that no
  library was needed.

Everything else works without it: a `zenith.json` with no `commandLibrary` opens in the editor, and
`zenith validate`, the checks and the sims run as usual.

## Which one to use

Use the library your team's robot code already uses. The runtime calls your commands, and your commands
are written against one library or the other, so the choice is made by the code you have. A team with no
command-based code yet can pick either; the autos behave the same on both.

The runtimes are checked against each other. The robot build runs every starter auto, and fixtures for
every end rule, timeout, parallel mode, branch arm and marker kind, through both runtimes, and fails
unless every step, command and path starts and ends on the same loop on both.

Horizon (FTC 36596) runs SolversLib on its own robot, so the SolversLib runtime gets far more testing on
a real robot from the team. The Ivy runtime passes the same automated checks, but the team has not yet
run it on a Control Hub.

## What differs

Everything that differs is in your Gradle file, your Java and one key in `zenith.json`.

| | Ivy | SolversLib |
|---|---|---|
| Gradle dependency | `com.pedropathing.ivy:pedro:1.1.1`, from Maven Central | `org.solverslib:core:0.3.6`, from `https://repo.dairy.foundation/releases` |
| Runtime package | `org.horizon36596.zenith.ivy` | `org.horizon36596.zenith.solverslib` |
| Pose type | Pedro `Pose` (`com.pedropathing.math`) | SolversLib `Pose2d` (`com.seattlesolvers.solverslib.geometry`) |
| Command type | Ivy `Command` (`com.pedropathing.ivy`) | SolversLib `Command` |
| `drive()` | optional; any `Object`, the follower if you do not override it | required; a SolversLib `Subsystem` |
| Follower updates | the robot class's `periodic(AutoFromFile)`, which calls `follower().update()` unless you override it | your code, usually the drive subsystem's `periodic()` |
| A named command | for example `Commands.instant(intake::on).requiring(intake)` | for example `new InstantCommand(intake::on, intake)` |
| OpMode base class | `AutoFromFile`, an FTC SDK `LinearOpMode` | `AutoFromFile`, a SolversLib `CommandOpMode` |
| Scheduler | Ivy's `Scheduler`, run by `AutoFromFile` once per loop after `periodic` | SolversLib's command scheduler, run by `CommandOpMode` once per loop |
| `zenith.json` | `"commandLibrary": "ivy"` in `deploy` | `"commandLibrary": "solverslib"` in `deploy` |

Both runtimes need Pedro Pathing `com.pedropathing:core:3.0.0-20260828.185437-17` and the JitPack
repository for Zenith. The [robot runtime page](robot-runtime.md#install) has the Gradle block for
each.

## A command left running from init

The routine is scheduled at start. If a command your robot code scheduled during init or `initLoop` is
still running then, and needs something the routine needs, such as the drive, the library decides
which one runs. Either the routine interrupts your command and starts, or your command blocks it.

Both libraries drop a blocked command without saying so. Both runtimes check for this at start: the
OpMode stops with an error, in telemetry and on the Driver Station, that names what blocked the
routine. The robot never sits still at the whistle with no error.

What blocks the routine depends on the library:

- **Ivy.** Every command has a priority, 0 unless you set one, and the routine's is the highest of the
  commands in it. A command of yours at the routine's priority or below is interrupted, and the routine
  starts. A command at a **higher** priority blocks it. The error names the requirement that is held
  and the routine's priority. Cancel the command before start, or give it a priority no higher than the
  routine's.
- **SolversLib.** There are no priorities. A command scheduled the usual way, `schedule(command)`, is
  interruptible: the routine interrupts it and starts. A command scheduled with
  `schedule(false, command)`, not interruptible, blocks it. The error names the requirement that is
  held and the command holding it. Cancel the command before start, or schedule it as interruptible.

With each library's defaults, the routine interrupts your command, and both runtimes run the same
auto the same way. The robot build checks the default case and the blocked case on each library.

## What does not change

- **The files.** Nothing in an auto file, `robot.json`, `field.json` or `waypoints.json` names a
  command library. You do not edit an auto to switch.
- **The editor, the checks and the sims.** They read the same files, so estimates, findings and the
  instant sim are the same for both.
- **Command and condition names.** `NamedCommands.register` and `registerCondition` take the same
  names, and the `arg*` readers work the same way. Keep `robot.json` and your registrations in step as
  before.
- **What the robot does.** Each step runs in the same order and for the same time on either runtime.
  Markers fire at the same place on the path, timeouts read the robot clock, and a `"current"` start
  is built from the robot's pose when the step starts.

## Switch between them

A project can move from one library to the other without touching its auto files. The Java changes
and the `commandLibrary` key change together, so do the steps in one go and deploy once at the end.

### From SolversLib to Ivy

1. **Gradle.** In `build.dependencies.gradle`, add `implementation 'com.pedropathing.ivy:pedro:1.1.1'`
   and make sure `mavenCentral()` is in `repositories`.
   The Ivy runtime does not need SolversLib; remove `org.solverslib:core` and its repository if
   nothing else in your project uses it. Sync Gradle.
2. **The robot class.** Import `ZenithRobot`, `AutoFromFile`, `NamedCommands`, `WaitRobotTime`,
   `RobotTimeout` and `Parallel` from `org.horizon36596.zenith.ivy` in place of
   `org.horizon36596.zenith.solverslib`, so the class implements the Ivy `ZenithRobot`. Only the
   runtime classes move: `Args` and `RobotClock` are shared and stay in `org.horizon36596.zenith`, and
   `Poses` exists only in `org.horizon36596.zenith.solverslib`, so remove it. Replace `Pose2d` with
   Pedro's `Pose` in `mirror`, which still turns the heading with the pose, and in `setStartPose` and
   `currentPose` if you override them. If you override `followPath` or `step`,
   change their `Command` to Ivy's. Remove `drive()`, or return any object your commands use as the
   drive requirement.
3. **Follower updates.** The Ivy runtime calls your robot class's `periodic(AutoFromFile)` once per
   loop, and unless you override it, that calls `follower().update()`. If your code already updates the follower
   somewhere that still runs under Ivy, override `periodic` so the follower is not updated twice.
   A SolversLib subsystem's `periodic()` does not run under Ivy.
4. **Named commands.** Rewrite each factory in `registerCommands` to return an Ivy `Command`, and
   return a new command on every call. Use the runtime's `WaitRobotTime` and `RobotTimeout` from
   `org.horizon36596.zenith.ivy` for timing, not Ivy's `Commands.waitMs`, which reads the wall clock.
5. **`zenith.json`.** Set `commandLibrary` in the `deploy` block to `"ivy"`:

    ```json
    "deploy": {
      "kind": "androidAssets",
      "dir": "TeamCode/src/main/assets/autos",
      "commandLibrary": "ivy",
      "robotClass": "org.firstinspires.ftc.teamcode.zenith.MyRobot"
    }
    ```

6. **Deploy again.** Run `zenith deploy`, or **Robot > Deploy autos into the robot repo** in the
   desktop app, so every `@Autonomous` stub is rewritten to extend the Ivy `AutoFromFile`. Preview it
   first if you like:

    ```powershell
    npx zenith deploy --dry-run
    npx zenith deploy
    ```

7. **Check the first line.** The first line of the deploy output names the library:

    ```text
    command library: Ivy (org.horizon36596.zenith.ivy)
    ```

    Under `--json`, the output has `"commandLibrary": "ivy"`. If the line says SolversLib, the
    `commandLibrary` inside the `deploy` block still says `"solverslib"`.

8. **Generated classes.** If your team keeps readable classes from `zenith codegen`, run it again for
   each one, so they are written against Ivy too.
9. **Build.** Build TeamCode in Android Studio. A stub or class still importing
   `org.horizon36596.zenith.solverslib` where it should import `org.horizon36596.zenith.ivy` shows up here as
   a type error against your robot class.

### From Ivy to SolversLib

The same steps the other way:

1. Declare `org.solverslib:core:0.3.6` and the `https://repo.dairy.foundation/releases` repository.
   You can remove the Ivy line if nothing else uses it.
2. Import the runtime classes from `org.horizon36596.zenith.solverslib` in place of
   `org.horizon36596.zenith.ivy`, keeping `Args` and `RobotClock` in `org.horizon36596.zenith`. Use
   `Pose2d` in place of `Pose`, and `Poses.toPedro` from `org.horizon36596.zenith.solverslib` where a
   SolversLib pose goes to Pedro, and implement `drive()` with your drivetrain `Subsystem`. Make sure something updates the follower every
   loop, normally that subsystem's `periodic()`.
3. Rewrite the named command factories to return SolversLib commands.
4. Set `commandLibrary` in the `deploy` block of `zenith.json` to `"solverslib"`. Do not remove it:
   with no `commandLibrary`, `zenith deploy` refuses to write the stubs.
5. Run `zenith deploy`, check that the first line reads `command library: SolversLib
   (org.horizon36596.zenith.solverslib)`, and run `zenith codegen` again for any generated classes you keep.

## What Zenith generates

The starter example has one auto, `cycle-and-park`, whose generated Java is checked in for both
libraries, in [`examples/starter/generated/`](https://github.com/Horizon-36596/zenith/tree/main/examples/starter/generated).
Each library's folder holds the readable class `zenith codegen` writes (`CycleAndParkGenerated.java`)
and the OpMode stub `zenith deploy` writes (`CycleAndParkAuto.java`).

The stubs differ only in two imports: `org.horizon36596.zenith.solverslib.AutoFromFile` and `ZenithRobot`, or
the same names from `org.horizon36596.zenith.ivy`. The readable classes have the same methods in the same
order and differ in the types they use. Here is the branch step from each.

SolversLib:

```java
private Command stepScoreIfCollected() {
    Command thenBranch = new SequentialCommandGroup(step("returnToScore", stepReturnToScore()), step("scoreCollected", stepScoreCollectedWithTimeout()));
    return new ConditionalCommand(thenBranch, new InstantCommand(), NamedCommands.condition("holdingPiece"));
}
```

Ivy:

```java
private Command stepScoreIfCollected() {
    Command thenBranch = new Sequence(step("returnToScore", stepReturnToScore()), step("scoreCollected", stepScoreCollectedWithTimeout()));
    return Branch.of(NamedCommands.condition("holdingPiece"), thenBranch, Commands.instant(() -> { }));
}
```

The other differences follow the same pattern:

- **Poses.** The SolversLib class builds `Pose2d`s and converts each one with `Poses.toPedro(...)`
  before handing it to Pedro's `Paths`. The Ivy class builds Pedro `Pose`s and passes them straight in.
- **Groups.** `SequentialCommandGroup` and `ConditionalCommand` become the Ivy runtime's `Sequence`
  and `Branch`. Parallel groups are the runtime's own `Parallel` in both.
- **Waits and empty steps.** An `endCondition` is raced against `new WaitUntilCommand(...)` in the
  SolversLib class and `Commands.waitUntil(...)` in the Ivy class. An empty branch arm is
  `new InstantCommand()` or `Commands.instant(() -> { })`.
- **Paths from `"current"`.** Both write `DeferredPath.of(...)`, from their own runtime package, and
  the method that builds the path takes a `Pose2d` or a `Pose`.
- **Imports.** Command types come from `com.seattlesolvers.solverslib.command` or `com.pedropathing.ivy`,
  and the runtime classes from `org.horizon36596.zenith.solverslib` or `org.horizon36596.zenith.ivy`. Both use
  the shared `org.horizon36596.zenith.Args`.

## Generated classes and `"current"`

A path whose first segment starts from `"current"` is written as `DeferredPath.of(...)`, the same call
both runtimes make. The path is built when the step starts, from the robot's live pose, so the
generated class builds the same routine as the runtime, apart from the one case below. The robot
build checks this for
`cycle-and-park` on both alliances and both arms of its branch.

One thing stays planned. In a step from `"current"`, a number that comes from the path's length uses
the planned path: the distance of a marker placed anywhere but the very start, and a heading shared out
between segments by arc length (piecewise, or linear over more than one segment). The generated method
says so in a comment. None of `cycle-and-park`'s steps has one.
