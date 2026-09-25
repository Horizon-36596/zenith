# Zenith robot runtime

The Java half of Zenith. It reads a `*.auto.json` file out of the robot's APK at OpMode init, builds it
into one command tree that follows Pedro Pathing v3 paths, and runs it as an ordinary `@Autonomous`
OpMode. The file you edit in Zenith is the routine the robot runs.

The tree is built from whichever command library the project names in `zenith.json`: Ivy, Pedro
Pathing's command library (`org.horizon36596.zenith.ivy`), or SolversLib (`org.horizon36596.zenith.solverslib`).
Both are first-class and neither is a default. The two runtimes are symmetric: the classes a team uses
have the same names in both packages, and what names no command library is shared, in
`org.horizon36596.zenith`. Most of this file shows the SolversLib classes; [Ivy](#ivy)
below says what is different for Ivy.

It is a library, installed from JitPack with one Gradle line. It knows nothing about any particular
robot: your robot reaches it through one interface, `ZenithRobot`, and your commands reach an auto file
only through the names you register.

MIT, copyright Horizon (FTC 36596).

| | |
|---|---|
| JitPack coordinate | `com.github.Horizon-36596:zenith:v0.1.1` |
| Maven group, artifact | `org.horizon36596:zenith-runtime` (what `publishToMavenLocal` writes) |
| Java packages | `org.horizon36596.zenith.ivy` (Ivy), `org.horizon36596.zenith.solverslib` (SolversLib), `org.horizon36596.zenith` (shared) |
| Packaging | Android library (AAR), `minSdk` 24 |

The JitPack version is the git tag exactly as it was pushed, leading `v` included. That is how JitPack
names a build, and it is what Horizon's SimLoop library measured on its first JitPack release.

## Install

Paste one of these into `build.dependencies.gradle` at the root of your FTC project, keeping the lines
already there.

For Ivy:

```groovy
repositories {
    mavenCentral()
    google() // Needed for androidx
    maven { url = 'https://jitpack.io' }                                       // Zenith
    maven { url = 'https://central.sonatype.com/repository/maven-snapshots' }  // Pedro Pathing v3
}

dependencies {
    // ...the FTC SDK lines that are already here...

    implementation 'com.pedropathing.ivy:pedro:1.1.1'
    implementation 'com.pedropathing:core:3.0.0-20260828.185437-17'
    implementation 'com.github.Horizon-36596:zenith:v0.1.1'
}
```

For SolversLib:

```groovy
repositories {
    mavenCentral()
    google() // Needed for androidx
    maven { url = 'https://jitpack.io' }                                       // Zenith
    maven { url = 'https://repo.dairy.foundation/releases' }                   // SolversLib
    maven { url = 'https://central.sonatype.com/repository/maven-snapshots' }  // Pedro Pathing v3
}

dependencies {
    // ...the FTC SDK lines that are already here...

    implementation 'org.solverslib:core:0.3.6'
    implementation 'com.pedropathing:core:3.0.0-20260828.185437-17'
    implementation 'com.github.Horizon-36596:zenith:v0.1.1'
}
```

Sync Gradle, and the runtime for your library is importable from TeamCode. Then set
`"commandLibrary": "ivy"` or `"commandLibrary": "solverslib"` in the `deploy` block of `zenith.json`.
Zenith writes no Java until it is set: `zenith codegen` refuses, and so does `zenith deploy`, which
writes the OpMode stubs, whenever `zenith.json` has a `codegen` section.
[Choosing a command library](https://libraries.horizon36596.org/zenith/command-libraries/) on the docs
site says how to choose and how to switch.

### Prerequisites

The runtime is compiled against these and does not bring them with it. Its POM lists no dependencies
at all, on purpose: your project already declares its command library and Pedro at the versions your
robot was tuned against, and some teams keep SolversLib's sources inside TeamCode instead of declaring it. A
runtime that declared either would move your Pedro pin, or put a second copy of SolversLib next to
yours and fail the APK build with duplicate classes.

| library | compiled and tested against | repository |
|---|---|---|
| FTC SDK | `org.firstinspires.ftc:RobotCore:12.0.0`, `Hardware:12.0.0` | Maven Central |
| Ivy (Ivy runtime) | `com.pedropathing.ivy:pedro:1.1.1` | Maven Central |
| SolversLib (SolversLib runtime) | `org.solverslib:core:0.3.6` | `https://repo.dairy.foundation/releases` |
| Pedro Pathing v3 | `com.pedropathing:core:3.0.0-20260828.185437-17` | `https://central.sonatype.com/repository/maven-snapshots` |

Pedro Pathing **v3** is a pre-release line with a different API from the v1 and v2 most tutorials
describe (no `PathChain`, no `PathBuilder`). The pin is a timestamped snapshot so the same commit drives
the same way every day; record the same string in `robot.json` as `kinematics.follower.version`.

## What your robot provides: `ZenithRobot`

Write one class that implements `org.horizon36596.zenith.solverslib.ZenithRobot`, with a public no-argument
constructor, and name it in `zenith.json` as `deploy.robotClass`. Every OpMode `zenith deploy`
generates constructs one.

| method | required | what it is for |
|---|---|---|
| `init(AutoFromFile opMode)` | yes | build hardware, subsystems and the Pedro follower from `opMode.hardwareMap` |
| `registerCommands(AutoFromFile opMode)` | yes | fill `NamedCommands` with the names your auto files use |
| `follower()` | yes | the Pedro v3 `Follower` that drives paths and reports progress for markers |
| `drive()` | yes | the drivetrain `Subsystem`; every path step requires it |
| `runningAlliance()` | yes | `"RED"` or `"BLUE"`, as the Driver Station selected it |
| `mirror(Pose2d)` | yes | the same place and facing on the other alliance's side of this season's field; headings go through it too |
| `nanoTime()` | no, `System.nanoTime()` | the robot clock every wait and timeout reads; a headless sim returns its stepped clock |
| `setStartPose(Pose2d)` | no, `follower().setPose(...)` | put the robot at the start pose at init |
| `currentPose()` | no, the follower's pose | the live pose a `"current"` start is built from |
| `defaultSpeedFraction()` | no, `1.0` | the speed a path runs at when the file gives none |
| `atSpeed(Path, double)` | no, unchanged | apply your velocity cap as a path is handed to the follower |
| `followPath(Path, double)` | no, the runtime's `FollowPath` | your own path-following command, if you have one |
| `step(String id, Command)` | no, unchanged | wrap each step for logging or tracing; `id` is the editor's step id |
| `initLoop(AutoFromFile)` | no, nothing | run on every loop while waiting for start |

Something must call `follower.update(...)` once per loop. The usual place is your drivetrain
subsystem's `periodic()`, which the SolversLib scheduler runs every loop; the runtime does not call it,
so a robot that already updates it there does not update it twice.

```java
package org.firstinspires.ftc.teamcode.zenith;

public class MyRobot implements ZenithRobot {
    private Follower follower;
    private DriveSubsystem drive;
    private Intake intake;

    @Override public void init(AutoFromFile opMode) {
        follower = PedroSetup.createFollower(opMode.hardwareMap);   // your own setup
        drive = new DriveSubsystem(follower);                        // periodic() calls follower.update()
        intake = new Intake(opMode.hardwareMap);
    }

    @Override public void registerCommands(AutoFromFile opMode) {
        NamedCommands.register("intakeOn", (args, ctx) -> new InstantCommand(intake::on, intake));
        NamedCommands.register("score", (args, ctx) ->
                new ScoreCommand(NamedCommands.argInt(args, "score", "count")));
        NamedCommands.registerCondition("holdingPiece", intake::hasPiece);
    }

    @Override public Follower follower() { return follower; }
    @Override public Subsystem drive() { return drive; }
    @Override public String runningAlliance() { return AllianceSelector.selected(); }
    @Override public Pose2d mirror(Pose2d p) {
        return new Pose2d(-p.getX(), -p.getY(), new Rotation2d(p.getHeading() + Math.PI));
    }
}
```

`PedroSetup`, `DriveSubsystem`, `Intake`, `ScoreCommand` and `AllianceSelector` stand for your own
code. Register only commands that exist: an auto that names an unregistered command or condition fails
at init with the list of what *is* registered, while the robot is still on the tile. Argument values
arrive from the JSON reader, so a number is a `Double`, a string a `String` and a flag a `Boolean`; the
`NamedCommands.arg*` helpers check them and name the command and argument when they are wrong.

## One OpMode per auto

The Driver Station lists classes, not assets, so every auto file gets a small generated subclass of
`AutoFromFile`. `zenith deploy` writes them, and nothing in the generated folder should be edited by
hand:

```java
package org.firstinspires.ftc.teamcode.zenith.generated;

import com.qualcomm.robotcore.eventloop.opmode.Autonomous;
import org.horizon36596.zenith.solverslib.AutoFromFile;
import org.horizon36596.zenith.solverslib.ZenithRobot;

/** GENERATED by zenith deploy from autos/first-auto.auto.json. Do not edit; edit the file and re-run zenith deploy. */
@Autonomous(name = "First auto", group = "Generated")
public final class FirstAutoAuto extends AutoFromFile {
    @Override protected String autoName() { return "first-auto"; }
    @Override protected ZenithRobot createRobot() { return new org.firstinspires.ftc.teamcode.zenith.MyRobot(); }
}
```

The `zenith.json` keys that shape them:

```json
"deploy": {
  "kind": "androidAssets",
  "dir": "TeamCode/src/main/assets/autos",
  "commandLibrary": "solverslib",
  "robotClass": "org.firstinspires.ftc.teamcode.zenith.MyRobot",
  "preselectTeleOp": "Driver Control"
},
"codegen": {
  "package": "org.firstinspires.ftc.teamcode.zenith",
  "dir": "TeamCode/src/main/java"
}
```

`robotClass` is required once `codegen` is set. `preselectTeleOp` is optional; when it is set, the
Driver Station selects that TeleOp after each auto. `commandLibrary` is required and has no default:
`"solverslib"` gives the stubs above, and `"ivy"` makes them import `AutoFromFile` and `ZenithRobot`
from `org.horizon36596.zenith.ivy`. Without it, `zenith deploy` stops before copying anything and says
that `zenith.json` does not say which command library the robot code uses.

### What happens at init

1. The file is read from `assets/autos/<name>.auto.json`, with `waypoints.json` beside it. Its
   `formatVersion` is checked, waypoint references resolved and every step read.
2. `createRobot()`, then `init`, then `NamedCommands.reset()` and `registerCommands`.
3. The robot is put at the start pose, mirrored for the running alliance if the file was written for
   the other one.
4. The whole routine is built. Every problem with the file throws here and names the step.
5. While waiting for start, the Driver Station shows the file, its title and its step count. At start
   the routine is scheduled. The SolversLib `AutoFromFile` is a `CommandOpMode`, whose command
   scheduler runs the routine once per loop. The Ivy `AutoFromFile` calls `Scheduler.schedule(routine)`,
   then on every loop the robot's `periodic` and `Scheduler.execute()`. If a command left running
   from init blocks the routine, either `AutoFromFile` fails at start and names what blocked it.

A pose is mirrored **if and only if** the selected alliance is not the file's. A `"current"` start is
never mirrored, because odometry already reports in the running alliance's frame.

A path's headings are mirrored by the same decision, through the same `mirror`
(`org.horizon36596.zenith.AllianceFrame`): a `constant` heading and a `linear` sweep's start go
through it, a `facePoint` point goes through it, a sweep keeps its size and turns the other way under
a reflection, and each `piecewise` range is treated the same way. Tangent headings follow the mirrored
path. So `mirror` has to carry the heading with the pose, `(-x, -y, h + pi)` for a point symmetry or
`(x, -y, -h)` for a reflection across x; one whose headings disagree with its positions fails at init.
`MirrorConformanceTest` checks that a file run as the other alliance drives exactly what the editor's
mirror of it drives, saved for that alliance, on both runtimes.

## Ivy

The Ivy runtime is in the same AAR, in `org.horizon36596.zenith.ivy`. It has the same classes with the
same simple names (`AutoFromFile`, `ZenithRobot`, `AutoContext`, `NamedCommands`, `AutoBuilder`,
`FollowPath`, `Parallel`, `RobotTimeout`, `WaitRobotTime`, `PathMarkers`, `AutoTraceWriter`,
`DeferredPath`), plus
`Sequence` and `Branch`, and it reads the same files through the shared `AutoFile`.

A team that uses it declares `com.pedropathing.ivy:pedro:1.1.1` (Maven Central) instead of SolversLib,
implements `org.horizon36596.zenith.ivy.ZenithRobot` with Pedro `Pose` in place of `Pose2d`, and sets
`"commandLibrary": "ivy"` in the `deploy` block of `zenith.json`, so `zenith deploy` writes stubs that
extend the Ivy `AutoFromFile`. The robot's `periodic` runs before `Scheduler.execute()` on every loop and
updates the follower unless the team overrides it, because Ivy has no subsystem `periodic()`.

The docs site's robot runtime page has the whole section: install, the robot class, named commands, the
OpMode lifecycle, deploy, and what `PedroCommands.follow` and suspension do.
[Choosing a command library](https://libraries.horizon36596.org/zenith/command-libraries/) compares the two
runtimes and lists the steps to switch a project between them.

## Using the pieces without `AutoFromFile`

A team with its own autonomous base class can skip the generated OpModes and call the builder itself:
implement `AutoContext` (the follower, the drivetrain, the clock, `alliance(Pose2d)`, and optionally the
rest), then

```java
AutoSpec spec = AutoSpec.loadForInit(AutoSource.assets(hardwareMap.appContext), "first-auto");
Command routine = AutoBuilder.build(spec, myContext);
```

`AutoTraceWriter` writes the `<auto>.trace.json` the editor reads back from a headless sim; its
`traced(id, command)` has the same shape as `ZenithRobot.step`.

## What is here

| file | what it does |
|---|---|
| `AutoFromFile` | the abstract `@Autonomous` base every generated OpMode extends |
| `ZenithRobot` | what a team implements: its robot, as the runtime sees it |
| `AutoContext` | what the builder needs from a running auto; `AutoFromFile` is one |
| `AutoSpec` | one `*.auto.json` parsed and resolved: version check, waypoints, the step model |
| `AutoSource` | where the bytes come from: the APK's assets, or a folder in a headless sim |
| `AutoBuilder` | the step model to one SolversLib command tree |
| `DeferredPath` | a path step from `"current"`, built from the live pose when the step starts |
| `NamedCommands` | the name-to-command registry, and the argument readers |
| `PathBuilder` | file segments and heading modes to a Pedro v3 `Path`, plus arc lengths |
| `PathMarkers` | fires a command part-way along a path without stopping it |
| `FollowPath` | drives one path; the default for `followPath` |
| `Parallel` | the `all`, `race` and `deadline` groups: members in file order, each ended exactly once |
| `Args` | argument maps for generated code, without Java 9's `Map.of` |
| `RobotTimeout`, `WaitRobotTime` | a deadline and a wait on the robot's clock; the runtime never uses `withTimeout` |
| `RobotClock`, `Poses` | the clock seam, and SolversLib to Pedro pose conversion |
| `Json` | a small complete JSON reader, used instead of `org.json` (below) |
| `AutoTraceWriter` | for tests: writes the trace a headless sim run leaves for the editor |

Those are in `auto-runtime/src/main/java`, package `org.horizon36596.zenith.solverslib`, except `Args`,
`AutoSource`, `Json` and `RobotClock`. What names no command library (`AutoFile`, the parser and
step model; `PedroPaths`; `MarkerProgress`; `AutoTrace`; `NamedRegistry`; `Args`; `Json`;
`AutoSource`; `RobotClock`) is in `auto-runtime/src/shared/java`, package `org.horizon36596.zenith`, and
the Ivy runtime is in `ivy-runtime/src/main/java`, package `org.horizon36596.zenith.ivy`. All three trees go into the one published AAR.

`templates/` holds a starting `zenith.json` and `robot.json` for a robot project. Its `sim.command`
names `*YourAutoHeadlessTest*`, a placeholder: replace it with the JVM test in your project that runs
an auto headless and writes its trace, or delete the `sim` block if you have none.

## Building and testing it

From the repository root, with JDK 17 and an Android SDK (`ANDROID_HOME`, or `sdk.dir` in
`robot/local.properties`):

```powershell
.\robot\gradlew.bat -p robot build
```

That compiles the AAR, runs the JVM unit tests (JSON reading, file parsing and command-tree building
against a fake robot, with no device) and Android lint. It also builds `:ivy-runtime`, which compiles the
shared and Ivy trees with no SolversLib on any classpath and runs the Ivy tests; runs the conformance
suite, which drives every starter auto and every fixture in `auto-runtime/src/test/resources/conformance`
through both runtimes and fails if their event logs differ (the logs land in
`auto-runtime/build/conformance`); and `dexCheck`, which dexes the AAR at API 24 without SolversLib and
without Ivy. `publishToMavenLocal` installs it into
`~/.m2` the way JitPack does; the release steps are in `PUBLISHING.md` at the repository root. The
version is read from the root `package.json`, the one place the Zenith version is set.

## Decisions worth knowing before you read the code

The library's shape, in short. It is an Android library (AAR), not a jar, because SolversLib and the FTC
SDK are only published as AARs and the runtime reads the APK's assets. Every dependency is
`compileOnly`, so the runtime never moves your Pedro pin and never adds a second copy of a SolversLib
you vendor into TeamCode. JitPack serves the one published module as
`com.github.Horizon-36596:zenith:<tag>`, with the tag verbatim.

### Why not `org.json`

`org.json` ships inside `android.jar`, so on the robot it costs nothing. It is not dependable in JVM
unit tests: the Android Gradle plugin swaps in a mockable `android.jar`, and a project that sets
`unitTests.returnDefaultValues = true` gets a default back from every stubbed method. Probed on
2026-09-21: `new JSONObject("{\"a\":1}")` constructs happily and then reports `has("a") == false` and
`length() == 0`. A headless sim is where this runtime gets tested before a competition, so a parser that
returns an empty document there is worse than none. `Json.java` is about 400 lines, has no dependencies,
and behaves identically on both sides.

### How markers find their place on the path

`PathMarkers` reads `follower.pathIndex()` and `follower.curveCompletion()` and maps them onto the
file's arc length using per-segment lengths measured at build time:

```
distance = sum(lengths[0 .. index - 1]) + completion * lengths[index]
```

The end of the path is a special case. Pedro declares a path finished while `curveCompletion()` is
still short of 1, and the deadline group interrupts the runner on the same loop, so a marker written
`{"t": 1}` or `{"distanceFromEndIn": 0}` would be stepped over and never run. Once the follower has been
seen driving this path, a follower that has stopped following counts as the whole length travelled,
which fires those markers on the last loop the runner gets; the "has been seen" latch keeps that from
firing everything at `initialize()`, before the path was handed over.

One Pedro path per file segment makes `pathIndex()` the index of the file's own segment, and
`curveCompletion()` is `1 - remainingDistance / curve.length()`, already an arc-length fraction rather
than a raw Bezier parameter. So a marker the editor placed six tenths along a path fires six tenths
along that path on the robot.

### Why timeouts are not `withTimeout`

SolversLib's `Command.withTimeout` composes a `WaitCommand`, which times itself on the wall clock. In
a headless sim, time is stepped by a fixed tick while a tick costs microseconds of real time, so a
250 ms timeout lasts about thirty simulated seconds and a different amount every run.
`RobotTimeout.of(cmd, seconds, clock)` races the command against `WaitRobotTime`, which reads the
`RobotClock`.

Only `path`, `command` and `wait` steps are wrapped in one, the three kinds the file format gives a
`timeoutS`. `AutoFile` ignores a `timeoutS` on a `sequence`, `parallel` or `branch`, which the editor's
schema drops too, and records a message naming the step in `AutoFile.warnings`. Each runtime's
`AutoFromFile` shows those messages as `Zenith warning` lines in init telemetry. To bound a group, put
the timeout on a step inside it, or make it a `deadline` group whose deadline is a `wait`.

### Why parallels are not SolversLib's groups

`parallel` steps, step timeouts and marker groups all use the runtime's `Parallel` (`all`, `race`,
`deadline`) rather than SolversLib's three parallel groups, for two reasons found in SolversLib 0.3.6:

- `ParallelRaceGroup.end` never ends the member that finished. A path under a `timeoutS` that arrives
  in time never got `end(false)`, and a marker command still running at the end of that path was never
  ended at all.
- SolversLib's groups keep their members in a `HashMap` or `HashSet`, so the order members started in
  within one loop changed from run to run.

`Parallel` ends every member exactly once: `end(false)` on the loop it finishes, `end(true)` if the
group ends first. Members start, run and end in the order the file lists them; a deadline group puts
its deadline first, and a marker group runs its path before its markers. Loop timing is the same as
SolversLib's. A headless run's trace is now identical byte for byte from one run to the next.

### Why generated code has no `Map.of`

A Control Hub runs Android API 24. `Map.of` is API 30, and whether a team's build backports it
depends on its Android Gradle Plugin, so generated code builds argument maps with `Args.of(key, value,
...)`. The runtime's own build fails on any other call above API 24 through lint's `NewApi` check, and
`packages/cli/src/javaApiLevel.test.ts` greps the generated code and the runtime for a list of them.

### Step ids

`id` is optional on every step. A step without one is named by its position (`step1`, `step2`, a
parallel's children `step2.1` and on, a branch with two arms `pick.1.1` and `pick.2.1`) by the same
rule as `effectiveId`/`childPrefix` in `packages/core/src/edit/ids.ts`. The string passed to
`step(id, ...)`, the string the editor's step list shows and the string a finding is keyed on are one
string, so a message can be carried from the planner to the robot. Two steps answering to the same id
are refused at init.

### `"current"` defers

A path whose first segment starts at `"current"` cannot be built at init. It becomes a
`DeferredPath`, a `DeferredCommand` that builds the path in its own `initialize()` from
`currentPose()`, with the drivetrain and any marker's subsystems declared as requirements up front.
The class `zenith codegen` writes calls `DeferredPath.of` for the same steps.
