# Robot runtime

The robot runtime is the Java half of Zenith. It reads a `*.auto.json` file from the robot's APK,
builds it into one command tree that follows Pedro Pathing paths, and runs it as an ordinary
`@Autonomous` OpMode. The file you edit in Zenith is the routine the robot runs. There is no separate
copy to keep in sync.

The tree is built from whichever command library `zenith.json` names: Ivy, Pedro Pathing's own
command library, or SolversLib. Both are first-class, and Zenith does not pick one: a project sets
`deploy.commandLibrary`, and the commands that write Java refuse until it does. The file, the editor
and the checks are the same for both. [Install](#install) gives the Gradle lines for each library. The
sections after it give the SolversLib classes, and [Ivy](#ivy) says what is different for Ivy.
[Choosing a command library](command-libraries.md) compares the two and says how to switch a project
from one to the other.

## Install

The runtime is published through JitPack. One artifact holds both runtimes; your Gradle file declares
the command library your robot code uses next to it.

Use a runtime compatible with the editor and CLI that saved your auto. If you are reading these docs
on an unreleased source branch, the dependency examples may still name the last published version.
Build the corresponding runtime source or wait for the matching release; an older artifact may not
read the development branch's newer file format.

| | |
|---|---|
| JitPack coordinate | `com.github.Horizon-36596:zenith:v0.1.2` |
| Java package | `org.horizon36596.zenith.ivy` (Ivy), `org.horizon36596.zenith.solverslib` (SolversLib), `org.horizon36596.zenith` (shared) |
| Packaging | Android library (AAR), minSdk 24 |
| Maven group and artifact (local builds only) | `org.horizon36596:zenith-runtime` |

JitPack names the artifact after the repository and uses the git tag as the version, `v` included, so
the coordinate is `...:zenith:v0.1.1`, not `...:zenith:0.1.1`.

The runtime declares no dependencies of its own. Your project declares its command library and Pedro
Pathing next to it, at the versions below, so your Pedro pin never moves and a vendored SolversLib never
collides with a second copy. In a standard FTC SDK project, add one of these blocks to
`build.dependencies.gradle`.

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
    implementation 'com.github.Horizon-36596:zenith:v0.1.2'
}
```

`com.pedropathing.ivy:pedro` brings Ivy's `core` with it. Both are on Maven Central.

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
    implementation 'com.github.Horizon-36596:zenith:v0.1.2'
}
```

Sync Gradle. The runtime classes are then importable from `org.horizon36596.zenith.ivy` for Ivy or
`org.horizon36596.zenith.solverslib` for SolversLib. The two runtimes are symmetric: the classes a team
uses have the same names in both packages. What names no command library, such as `Args` and
`RobotClock`, is shared and lives in `org.horizon36596.zenith`. Then set `commandLibrary` in
`zenith.json` to match (see [Deploy autos](#deploy-autos)).

!!! note "The runtime brings no JSON library"
    The runtime parses auto files with its own small JSON reader. It does not use `org.json`, because
    the mockable `android.jar` in JVM unit tests returns empty documents from it, and the headless sim
    runs in exactly those tests. You do not need to add a JSON dependency.

## Prerequisites

The runtime drives your robot through two libraries your project must already use: Pedro Pathing v3
and a command library.

### Pedro Pathing v3

Paths are built with the Pedro Pathing **v3** API (`com.pedropathing.api.Paths`). This is the
pre-release v3 line, not the v1 or v2 API most Pedro tutorials describe. It has no `PathChain`, no
`PathBuilder` and no `BezierLine`.

The runtime source is built and checked against this snapshot:

| | |
|---|---|
| Dependency | `com.pedropathing:core:3.0.0-20260828.185437-17` |
| Repository | `https://central.sonatype.com/repository/maven-snapshots` |

```groovy
repositories {
    maven { url = 'https://central.sonatype.com/repository/maven-snapshots' }
}

dependencies {
    implementation 'com.pedropathing:core:3.0.0-20260828.185437-17'
}
```

Tune your follower with Pedro's own tuners before you run a Zenith auto. Copy the results into
`robot.json`'s `kinematics` block too, so the editor's time estimates match the robot. See the
[file format reference](file-format.md).

!!! warning "Keep the Pedro version in one place"
    `robot.json` records the follower build in `kinematics.follower.version`. Set it to the exact
    version string in your Gradle file. A newer Pedro snapshot can change path progress reporting,
    which is what places markers.

### Your command library

The command tree is built from the library `zenith.json` names. With Ivy it is built from Ivy commands
and the runtime's own `Sequence`, `Parallel` and `Branch`; [Ivy](#ivy) has its versions and details.
With SolversLib it is built from the SolversLib command framework (`com.seattlesolvers.solverslib`):
`SequentialCommandGroup` and `ConditionalCommand`, plus the runtime's own `Parallel` groups, which are
SolversLib commands too, and your robot code must schedule commands through SolversLib's scheduler.

The SolversLib runtime is compiled and tested against these:

| | |
|---|---|
| SolversLib | `org.solverslib:core:0.3.6` |
| Pedro Pathing | `com.pedropathing:core:3.0.0-20260828.185437-17` |
| FTC SDK | `12.0.0` |

If you vendor SolversLib's sources instead of declaring it, the runtime links against your copy.

### What your robot code provides

Your project writes one class that implements `ZenithRobot`. It is the whole extension surface: the
runtime asks it for your hardware and your rules and nothing else. This table is the SolversLib
interface, `org.horizon36596.zenith.solverslib.ZenithRobot`; the Ivy one, `org.horizon36596.zenith.ivy.ZenithRobot`,
differs in the two methods [Your robot class](#your-robot-class) lists.

| method | required | used for |
|---|---|---|
| `init(AutoFromFile opMode)` | yes | build your hardware and subsystems at OpMode init |
| `registerCommands(AutoFromFile opMode)` | yes | `NamedCommands.register(...)` for every command name your files use |
| `Follower follower()` | yes | the Pedro follower paths run on, and path markers read |
| `Subsystem drive()` | yes | the requirement every path step holds |
| `String runningAlliance()` | yes | the alliance this match runs as, `"RED"` or `"BLUE"` |
| `Pose2d mirror(Pose2d pose)` | yes | running a file written for the other alliance: its poses and its headings. See [Alliance](#alliance) |
| `long nanoTime()` | no, `System.nanoTime()` | every timer the runtime uses |
| `void setStartPose(Pose2d pose)` | no, `follower().setPose(...)` | seeding the start pose at init |
| `Pose2d currentPose()` | no, from the follower | paths that start at `"current"` |
| `double defaultSpeedFraction()` | no, `kinematics.defaultPathSpeedFraction` from the deployed `robot.json`, or `1.0` with a warning | the speed a path uses when the file sets none |
| `Path atSpeed(Path path, double fraction)` | no, unchanged, **but needed for path speeds** | applying a path's speed. The default leaves the path alone, so a speed below 1 changes the editor's times and not the robot |
| `Command followPath(Path path, double fraction)` | no, the runtime's `FollowPath` | driving each path step |
| `Command step(String id, Command body)` | no, unchanged | wrapping each step, for logging or tracing |
| `void initLoop(AutoFromFile opMode)` | no, nothing | work during the init loop |
| `void onStart(AutoFromFile opMode)` | no, nothing | once at start, before the routine is scheduled: start a match log here |
| `void periodic(AutoFromFile opMode)` | no, nothing | every loop after start, before SolversLib's scheduler runs your subsystems and commands |
| `void afterLoop(AutoFromFile opMode)` | no, nothing | every loop after start, after the scheduler: log what the loop did |
| `void onStop(AutoFromFile opMode)` | no, nothing | once when the OpMode stops, however it stops, a failure at init or at start included, whenever your robot was created: close what `init` or `onStart` opened |

### Your own code around the routine

An auto file holds the routine and nothing else. Anything else your auto does, such as logging, a
camera started at init or telemetry of your own, goes in your `ZenithRobot`, so every Zenith auto gets
it without anyone editing a generated OpMode:

```java
@Override public void onStart(AutoFromFile opMode) { matchLog.open(opMode.spec().name); }
@Override public void afterLoop(AutoFromFile opMode) { matchLog.record(follower.pose(), opMode.nanoTime()); }
@Override public void onStop(AutoFromFile opMode) { matchLog.close(); }
@Override public Command step(String id, Command body) { return matchLog.timed(id, body); }
```

`matchLog` stands for your own logging code. `onStop` runs even when init fails, as long as your robot
was created, so a log opened in `init` is always closed, and the scheduler is still reset if `onStop`
throws. The order on every loop is `periodic`, then the scheduler, then `afterLoop`. The Ivy runtime has
the same four methods with the same names.

When that is still not enough, two more ways exist, with costs. `deploy.opModeBase` makes every
generated OpMode extend your own subclass of `AutoFromFile` ([Deploy autos](#deploy-autos)), and an
[exported OpMode](#exported-opmode-not-recommended) is the whole auto as Java you own.

!!! warning "Path speeds need `atSpeed`"
    A path's `speedFraction`, and the robot's default path speed, set how long the editor says a path
    takes. The robot drives at that speed only if your `ZenithRobot` implements `atSpeed`, because
    `FollowPath` hands the follower whatever `atSpeed(path, fraction)` returns and the default returns the
    path unchanged. Without it every path drives at full speed. When a path step is set below 1 and
    `atSpeed` is still the default, init shows a `Zenith warning` line on the Driver Station naming
    those steps. A robot that replaces `followPath` is taken to apply speeds itself and gets no warning.
    The runtime cannot apply the speed for you yet: whether Pedro 3.0.0 offers a per-path speed is still
    an open question.

    `defaultSpeedFraction()` needs nothing from you. Leave it out and the runtime reads
    `kinematics.defaultPathSpeedFraction` from the `robot.json` that `zenith deploy` copied beside your
    autos, so the robot and the editor start from the same number. If the file is missing or has no valid
    number, the answer is `1.0` and init says so.

Two more extension points exist for teams that need them. `AutoFromFile` is an abstract SolversLib
`CommandOpMode` whose `startPose()` and `buildRoutine()` hooks can be overridden, which is what
`zenith codegen` does. `AutoContext` is the interface the builder reads; a team with its own OpMode base
can implement it and call `AutoBuilder.build(spec, context)` directly.

## How a file becomes a command

`AutoBuilder` turns the file's steps into one `SequentialCommandGroup`. Each step is wrapped in
`step(id, command)`, so your existing step logging shows the same step ids the editor and the
findings use.

| step kind | built as |
|---|---|
| `path` | a `FollowPath` over a Pedro path, one Pedro path per file segment. Markers fire alongside it; `endCondition` interrupts it; `timeoutS` bounds it. A path of 2 in or less is a `TurnInPlace` instead (below). |
| `command` | the command registered under that name, built with the step's `args` |
| `wait` | a wait on the robot clock, or a wait until a registered condition is true |
| `sequence` | `SequentialCommandGroup` |
| `parallel` | the runtime's `Parallel.all`, `Parallel.race` or `Parallel.deadline`, by `mode` |
| `branch` | `ConditionalCommand` over a registered condition |

Details that affect how a routine behaves:

- **Parallel groups end every member once, in file order.** SolversLib 0.3.6's `ParallelRaceGroup`
  never ends the member that finished, and its three parallel groups keep members in a hash set, so
  their order changed from run to run. The runtime's `Parallel` holds members in file order and calls
  each member's `end` exactly once, so a marker command still running when its path arrives is ended,
  and two headless runs give the same trace.
- **Timeouts use the robot clock.** SolversLib's `Command.withTimeout` times itself on the wall clock,
  so the runtime never uses it. `RobotTimeout.of(command, seconds)` races the command against
  `WaitRobotTime`, which reads the robot's `nanoTime()`. The headless sim steps that clock, so
  timeouts behave the same in the sim and on the field. Only `path`, `command` and `wait` steps have
  one. A `timeoutS` on a `sequence`, `parallel` or `branch` is ignored, as the editor ignores it, and
  init shows a `Zenith warning` line on the Driver Station naming the step.
- **Markers fire by distance along the path.** `PathMarkers` reads Pedro's segment index and
  arc-length completion each loop and fires a marker when the path passes the marker's position. A
  marker placed 60% along a path in the editor fires 60% along it on the robot. Markers at the very
  end of a path still fire. A path cut short by its `endCondition` or `timeoutS` ends its markers
  with it, so a marker past the point where the robot stopped never fires.
- **Two markers that need one subsystem take turns.** When a marker starts, any marker on the same
  path that is still running and needs one of its subsystems is interrupted, as the scheduler would
  interrupt it. A long `raiseLift` marker followed by a `lowerLift` marker leaves the lift lowering.
- **A turn on the spot is held, not followed.** A path step of 2 in or less, measured on the path
  as built, is never handed to Pedro: `TurnInPlace` calls `follower.hold` at the step's end point
  with its end heading and is done once the heading is within two degrees of it and the robot within
  0.5 in of the point. Both, so a short step that drives a little without turning still ends only
  once the robot has got there. A hold that comes to rest a little further off, because its heading
  or translational P cannot beat the friction, ends once the robot has stayed still for a quarter of
  a second within ten degrees and 2 in of the pose (`PedroPaths.TurnSettle`). Outside those bounds,
  stopping alone does not finish the step; set `timeoutS` to bound it. The robot turns from whichever way it arrives facing, the short way
  round. Its markers start with it and end with it, and your `followPath` is not called for it.
- **`"current"` starts are built late.** A path whose first segment starts at `"current"` is built
  when it starts, from the robot's live pose. Its markers' commands and its `endCondition` are still
  looked up at init, so a name nobody registered fails on the tile.
- **Everything else is built at init.** A missing file, an unknown format version, an unregistered
  command or condition, an unknown waypoint, or a duplicate step id throws during init, while the
  robot is still on the tile. The Driver Station shows the message, and the message names the step.

## Register commands and conditions

A command step in a file names a command, such as `score`. The robot needs a real `Command` from its
command library for that name. The examples here are SolversLib; [Named commands](#named-commands)
covers Ivy. `NamedCommands` is the table that connects the two.

```java
public final class NamedCommands {
    public interface Factory { Command build(Map<String, Object> args, AutoContext ctx); }

    public static void reset();
    public static void register(String name, Factory factory);
    public static void registerCondition(String name, BooleanSupplier condition);
    public static Command build(String name, Map<String, Object> args, AutoContext ctx);  // throws on an unknown name
    public static BooleanSupplier condition(String name);                                 // throws on an unknown name
}
```

`AutoContext` is what the builder hands every factory: the follower, the drivetrain, the clock and
the alliance, plus whatever else `ZenithRobot` answers. `AutoFromFile` implements it by delegating to
your `ZenithRobot`, so a factory reading `ctx.follower()` or `ctx.drive()` works the same whether the
routine came from a generated OpMode or from `AutoBuilder.build(spec, ctx)` directly.

Fill it once per OpMode init, before the routine is built. Call `reset()` first so one OpMode never
inherits another's table:

```java
NamedCommands.reset();

NamedCommands.register("intakeOn", (args, ctx) -> new InstantCommand(intake::on, intake));
NamedCommands.register("score", (args, ctx) ->
        new ScoreCommand(NamedCommands.argInt(args, "score", "count")));

NamedCommands.registerCondition("holdingPiece", intake::hasPiece);
```

The command classes in this example (`ScoreCommand`) stand for your own robot's helpers.

- Register only helpers that exist. Registering the same name twice in one fill is an error.
- Argument values arrive from the JSON reader: a number is a `Double`, a string is a `String` and a
  flag is a `Boolean`. Use the `arg*` helpers (`argInt`, `argDouble`, `argString`, `argEnum`, each
  with an optional fallback where it makes sense). Their error messages name the command and the
  argument. `argInt` refuses a fraction, and a whole number too big or too small for an `int`.
- An auto that names an unregistered command fails at init and lists every name that *is*
  registered.

### The `robot.json` registry

`robot.json` declares the same names for the editor and the checks:

```json
"commands": [
  {
    "name": "intakeOn",
    "summary": "Run the intake.",
    "params": {},
    "estimateS": "0",
    "requires": ["intake"],
    "stationary": false
  },
  {
    "name": "score",
    "summary": "Score the requested number of held game pieces.",
    "params": { "count": { "type": "integer", "min": 1, "max": 4 } },
    "estimateS": "0.5 + count * 0.5",
    "requires": ["intake"],
    "stationary": true
  }
],
"conditions": [
  { "name": "holdingPiece", "summary": "The robot is holding a game piece." }
]
```

`zenith validate` rejects an auto that names a command or condition `robot.json` does not declare
(a `SCHEMA` finding). Keep `robot.json` and your `NamedCommands.register` calls in step: every name
in one should be in the other. The [file format reference](file-format.md) lists every command key.
This fragment matches the Java example's `count` argument. Its range and time estimate are example
values; replace them with your command's limits and measured timing.

### Commands from the robot's code

You do not have to copy the names across by hand. Zenith can read your registrations straight
from your Java or Kotlin and fill in `robot.json`, in two places:

- **On the command line**, `zenith import-commands` scans the project (or the directories you name),
  adds what `robot.json` lacks, and `zenith validate --java TeamCode` checks the two against each
  other. Set `"javaDir": "TeamCode/src/main/java"` in `zenith.json` and every `zenith validate`
  does that check by itself. Both need only Node: no Gradle, no Android Studio, no administrator rights. See
  [`zenith import-commands`](cli-reference.md#zenith-import-commands).
- **In the editor**, **Import commands from Java...** in the command palette reads the Java files
  of the folder you pick, or of the GitHub repository you have open, shows the `robot.json` lines
  that would change, and writes them when you apply. See [the editor](editor.md#import-commands-from-java).

What the scanner reads, for each `NamedCommands.register` and `registerCondition` call:

- the name, when it is a string literal, a `static final String` or Kotlin `const val` constant (in
  the same class or named as `Names.SHOOT`), or a `+` of those; and through a small wrapper method
  such as `void reg(String name, ...) { NamedCommands.register(name, ...); }`, at each call of it;
- the factory, when it is a lambda (Java or Kotlin, a trailing lambda included), a method reference
  such as `this::shoot`, an anonymous `Factory`, a field holding one of those, or a method that
  returns one, following any method in your sources that the argument map is passed to;
- each argument the factory reads with an `arg*` helper: its key and type, whether it is required,
  the fallback as its default when that is a literal or a constant, and an enum's constants when
  the enum is declared in your sources.

What it cannot read, it lists with the file and line instead of guessing: a name that is only known
when the code runs (a loop over a list of names, a string template, a name read from a file), an
enum declared in a library, an argument read straight from the map with `args.get("key")`, and a
factory that hands the argument map to code outside your sources. Estimates, `requires`,
`stationary`, `movesRobot` and ledger hints cannot be read from code at all, so a new command gets
`"estimateS": "unknown"` and a `provenance` that says the estimate needs measuring, and everything
you have written in `robot.json` stays as you wrote it.

Test sources (`src/test`, `src/androidTest`) and build output are skipped, since a robot's tests
often register stand-in commands the real robot does not have. `NamedCommands.commandNames()` and
`conditionNames()` list what is really registered at run time, if you want to check a registration
the scanner could not read.

## Load an auto on the robot

### Where the files go

On the robot, the runtime reads from the APK's assets:

| file | asset path |
|---|---|
| each auto | `assets/autos/<name>.auto.json` |
| waypoints | `assets/autos/waypoints.json` |

In an FTC SDK project that is `TeamCode/src/main/assets/autos/`. Set `deploy.dir` in `zenith.json` to
that folder and `zenith deploy` copies the files there (see below).

### One OpMode per auto

The Driver Station lists classes, not assets, so each auto file gets one small subclass of
`AutoFromFile`. It says which file to load and nothing else:

```java
import com.qualcomm.robotcore.eventloop.opmode.Autonomous;
import org.horizon36596.zenith.solverslib.AutoFromFile;
import org.horizon36596.zenith.solverslib.ZenithRobot;

@Autonomous(name = "First auto", group = "Generated")
public final class FirstAutoAuto extends AutoFromFile {
    @Override protected String autoName() { return "first-auto"; }
    @Override protected ZenithRobot createRobot() { return new org.firstinspires.ftc.teamcode.zenith.MyRobot(); }
}
```

`autoName()` is the file stem: `"first-auto"` loads `assets/autos/first-auto.auto.json`.
`createRobot()` constructs the class named by `deploy.robotClass` in `zenith.json`. If
`deploy.preselectTeleOp` is set, the Driver Station selects that TeleOp after the auto ends.

This is the SolversLib stub. The Ivy stub is the same except that it imports `AutoFromFile` and
`ZenithRobot` from `org.horizon36596.zenith.ivy`; the [Ivy section](#the-opmode-stub) shows it.

You do not write these by hand. `zenith deploy` generates them.

### What happens at init

1. The file is read from `assets/autos/<name>.auto.json`, with `waypoints.json` beside it.
   `formatVersion` is checked (a file newer than the runtime fails, naming both versions), waypoint
   references are resolved and every step is read.
2. `createRobot()` runs, then your `ZenithRobot`'s `init`, then `NamedCommands.reset()` and
   `registerCommands`.
3. The robot is put at the start pose, mirrored for the running alliance if the file was written for
   the other one.
4. The whole routine is built. Any problem with the file — an unregistered command or condition, an
   unresolved waypoint, a duplicate step id — throws here, while the robot is still on the tile, and
   names the step.
5. While waiting for start, the Driver Station shows the file, its title, its step count and each `Zenith warning`. At start
   the routine is scheduled. With SolversLib, `AutoFromFile` is a `CommandOpMode`, and SolversLib's
   command scheduler runs the routine once per loop. With Ivy, `AutoFromFile` calls
   `Scheduler.schedule(routine)`, and then on every loop your robot's `periodic` and
   `Scheduler.execute()`. A command of yours still running from init can stop the routine starting.
   On both libraries `AutoFromFile` checks for that at start and fails with an error that names what
   blocked it; [Choosing a command library](command-libraries.md#a-command-left-running-from-init)
   says when it happens on each.

### Alliance

A file records which alliance its poses are written for. The runtime mirrors a pose **if and only if**
the alliance selected on the robot is not the file's alliance. A RED file run as BLUE is mirrored once.
A file mirrored in the editor and saved as BLUE, run as BLUE, is not mirrored at all. A `"current"`
start is never mirrored, because odometry already reports in the running alliance's frame.

Headings are mirrored by the same decision, through the same `mirror`. When a path is mirrored:

| heading | on the other alliance |
|---|---|
| `tangent`, `tangentReversed` | unchanged: they follow the mirrored path |
| `constant` | the heading goes through `mirror` |
| `linear` | the start goes through `mirror`; the sweep keeps its size, and turns the other way round if `mirror` is a reflection |
| `facePoint` | the point goes through `mirror`, even when `mirror` only moves the field and keeps every heading |
| `piecewise` | each range's heading as above; the ranges stay where they are along the path |

A RED file run as BLUE drives what the editor's **mirror to the other alliance** drives, saved as
BLUE. The runtime's tests check that for every example and test file, under a point symmetry and a
reflection.

`mirror` has to be a rigid motion of the field that carries the heading with the pose. The runtime
asks it where heading 0 and a quarter turn go, and where the x and y directions go. That tells it how
headings move and whether turns reverse. Some mirrors:

| field | `mirror` |
|---|---|
| symmetric about the centre point (BIOBUZZ) | `(-x, -y, heading + pi)` |
| reflected across the x axis | `(x, -y, -heading)` |
| reflected across the y axis | `(-x, y, pi - heading)` |

A mirror whose headings disagree with its positions, such as a reflection that leaves the heading as
it is, fails at init with both numbers.

### Reading from somewhere other than the APK

The headless sim has no APK. A test calls `setAutoSource(AutoSource)` on the OpMode before init and
points it at a folder, normally `TeamCode/src/main/assets/autos`. On the robot, leave it unset. See
[Simulation](simulation.md) for the headless sim setup.

## Deploy autos

Deploying copies your project's files into the robot project and refreshes the generated OpModes. It
does not build the APK or install anything on the robot. Build and install from Android Studio as
usual afterwards.

`zenith.json` needs a `deploy` section:

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

`commandLibrary` is `"ivy"` or `"solverslib"`, the library your robot code uses, and it is required
once `codegen` is set.
`robotClass` is the dotted name of your `ZenithRobot` implementation; it is required once `codegen`
is set, because it is written straight into the generated OpMode's source. `preselectTeleOp` is
optional. So is `opModeBase`: the dotted name of your own abstract subclass of your library's
`AutoFromFile`, which every generated OpMode then extends in place of `AutoFromFile`, for code that
belongs in the OpMode rather than in your `ZenithRobot`. The stub still names the file and constructs
`robotClass`, so your base class leaves `autoName()` and `createRobot()` to it. Both `dir` values must be inside the project. Zenith refuses a path that resolves outside
it.

This example deploys for SolversLib; a team on Ivy sets `"commandLibrary": "ivy"` (see
[Ivy](#deploy)). There is no default. The generated OpModes are the only Java a deploy writes, and it
writes them only when there is a `codegen` section. So with a `codegen` section and no
`commandLibrary`, `zenith deploy` and the desktop app's Deploy refuse before they copy or write
anything, as `zenith codegen` always does without it, with this message:

```text
zenith.json does not say which command library your robot code uses, and Zenith does not pick one. Add "commandLibrary": "solverslib" or "commandLibrary": "ivy" to its "deploy" section. See https://libraries.horizon36596.org/zenith/command-libraries/.
```

`zenith deploy` names the library it wrote for on the first line of its output. Without a `codegen`
section it copies the files only and needs no `commandLibrary`, but it writes no OpMode, so the
Driver Station lists none of the autos unless your own OpModes load them. Its first line then says
that no Java is written, its last line warns that no OpMode was written, and `--json` output has
`"stubs": false`. The desktop app's Deploy says the same. `zenith init` writes the `codegen` section
above, so a new project has one.

### From the desktop app

Choose **Robot > Deploy autos into the robot repo** (Ctrl+Shift+D). The app shows which files would be
written and which are unchanged, then writes them when you confirm.

### From the CLI

Preview first:

```powershell
zenith deploy --dry-run
```

Then deploy:

```powershell
zenith deploy
```

For each auto, `zenith deploy`:

- copies `autosDir/*.auto.json`, `waypoints.json`, `robot.json` and the field file into `deploy.dir`,
- writes or refreshes one `@Autonomous` stub, `<PascalName>Auto.java`, extending the chosen runtime's
  `AutoFromFile`, under the `codegen` directory and package,
- removes stubs for autos that no longer exist.

An auto with a validation error is skipped and reported. The other autos still deploy, and the command
exits `1` so a script notices. `--dry-run` lists every action (`copy:`, `write:`, `keep:`,
`remove:`) without touching disk. The [CLI reference](cli-reference.md#zenith-deploy) has every flag.

!!! tip "Commit the generated stubs"
    The stubs and the copied assets are build inputs. Commit them with the auto change, so a teammate
    who pulls and builds gets the same OpModes.

## Generated Java (optional)

What runs on the robot is the auto file. The OpMode `zenith deploy` writes names the file, and
`AutoFromFile` reads it at init and has `AutoBuilder` build the routine. The generated class is not
that code. It is a reference: the same routine `AutoBuilder` builds, written out as Java to read.

`zenith codegen <auto>` writes that class for one auto, and the editor's
[Code panel](editor.md#code-panel) shows it as you edit. It is written for the runtime
`deploy.commandLibrary` names, Ivy or SolversLib, and refuses when the key is not set. It is for
reading an auto as code and for checking the runtime when you suspect it. It extends the runtime's
`AutoFromFile`, which still reads the auto file, so it needs both the runtime and the file. The
conformance suite runs the starter's generated classes against the routine built from the file and
fails if they differ. The file is derived. Never edit it; edit the auto and run `zenith codegen`
again. The header records the source file's hash, so a stale class is easy to spot.

A path that starts from `"current"` is written as `DeferredPath.of(...)`, the call the runtime makes,
so it is built from the robot's live pose when the step starts. Its `endCondition` is looked up when
the class builds its routine, as `AutoBuilder` does, so a condition nobody registered fails on the
tile. One thing stays planned: in such a step, a marker placed anywhere but the very start, or a
heading shared out between segments by arc length, uses the planned path's length, and the generated
method says so in a comment.

A path step of 2 in or less is written as `new TurnInPlace(...)`, as `AutoBuilder` builds it, with its
markers in a `Parallel.deadline` beside the turn. When such a step starts from `"current"`, the
generated method measures the live path with `PedroPaths.lengthIn` and decides at run time, as
`AutoBuilder` does: still 2 in or less, it turns on the spot; longer, it follows the path.

The starter example's
[`generated` folder](https://github.com/Horizon-36596/zenith/tree/main/examples/starter/generated)
holds what `zenith codegen`, `zenith codegen --export` and `zenith deploy` write for its
`cycle-and-park` auto, once for each library. [Choosing a command library](command-libraries.md#what-zenith-generates)
walks through the differences.

### Exported OpMode (not recommended)

`zenith codegen --export <auto>`, or **Export** in the Code panel, writes `<Name>Exported.java`: the
whole auto as a concrete `@Autonomous` OpMode that you paste into TeamCode and own. It reads no auto
file. Its `loadSpec()` returns `AutoSpec.inCode(...)` (`AutoFile.inCode(...)` on Ivy), which carries the
alliance its poses are written for, the start pose and the default path speed from `robot.json`, and
its `buildRoutine()` is the same routine as the generated class. It still needs the runtime library
and your `ZenithRobot`, and it refuses without `deploy.robotClass`, because it constructs your robot.
Edit it as you like: add logging, vision, or anything an auto file cannot hold.

It is not the recommended path. Once you export, Zenith no longer tracks the routine: a change you
make in the class is not in the auto file, so the editor, its checks and its sim never see it, and
exporting again overwrites the class. It also gets no `Zenith warning` about path speeds `atSpeed`
does not apply, because it has no file steps to name. Try your `ZenithRobot`'s
[hooks](#your-own-code-around-the-routine) or `deploy.opModeBase` first. If you do export, delete
the generated OpMode for the same auto, or the Driver Station lists both.

The conformance suite runs the starter's exported classes against the routine built from the file,
on both alliances, and fails if they differ.

## Ivy

The Ivy runtime runs the same auto files on Ivy, Pedro Pathing's command library, instead of SolversLib.
The file format does not change, and neither does anything in the editor. A step runs in the same
order and for the same time on either runtime: Zenith runs its test autos through both and checks that
every step, command and path starts and ends on the same loop.

A robot project names one library in `zenith.json`, and neither is a default.
[Choosing a command library](command-libraries.md) puts the two side by side and lists the steps to
switch an existing project.

### Install

The Ivy runtime is in the same Zenith artifact as the SolversLib one. [Install](#install) has its
Gradle block: Ivy and Pedro Pathing next to Zenith, with SolversLib
left out. The Ivy runtime is compiled and tested against these:

| | |
|---|---|
| Ivy | `com.pedropathing.ivy:pedro:1.1.1` |
| Pedro Pathing | `com.pedropathing:core:3.0.0-20260828.185437-17` |
| FTC SDK | `12.0.0` |
| Java package | `org.horizon36596.zenith.ivy` |

An Ivy team's APK holds the SolversLib runtime's classes too, and a SolversLib team's holds the Ivy
ones. Your code never uses them. When the FTC SDK scans the APK for OpModes at start-up, it skips a
class it cannot load and logs a warning, so expect warnings in the robot log for the other runtime's
classes. The build checks that the classes dex at API 24 with the other library absent, and that no
class a team uses needs the library it left out.

### Your robot class

Implement `org.horizon36596.zenith.ivy.ZenithRobot`. It has the same methods as the SolversLib one,
with Pedro's `Pose` in place of SolversLib's `Pose2d` and Ivy's `Command` in place of SolversLib's.
Two methods differ:

| method | required | used for |
|---|---|---|
| `Object drive()` | no, the follower | the requirement every path step holds. Ivy takes any object as a requirement, so there is no subsystem class. |
| `void periodic(AutoFromFile opMode)` | no, `follower().update()` | once per loop, before `Scheduler.execute()`. Ivy has no subsystem `periodic()`, so this is where the follower is updated. If you override it, update the follower yourself. |

`onStart`, `afterLoop` and `onStop` are the same as the SolversLib ones
([Your own code around the routine](#your-own-code-around-the-routine)); `afterLoop` runs after
`Scheduler.execute()`.

The required methods are `init`, `registerCommands`, `follower()`, `runningAlliance()` and
`mirror(Pose)`.

```java
import com.pedropathing.follower.Follower;
import com.pedropathing.ivy.commands.Commands;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;
import org.horizon36596.zenith.ivy.AutoFromFile;
import org.horizon36596.zenith.ivy.NamedCommands;
import org.horizon36596.zenith.ivy.ZenithRobot;

public final class MyRobot implements ZenithRobot {
    private Follower follower;
    private Intake intake;

    @Override public void init(AutoFromFile opMode) {
        follower = PedroSetup.createFollower(opMode.hardwareMap);
        intake = new Intake(opMode.hardwareMap);
    }

    @Override public void registerCommands(AutoFromFile opMode) {
        NamedCommands.register("intakeOn", (args, ctx) -> Commands.instant(intake::on).requiring(intake));
        NamedCommands.registerCondition("holdingPiece", intake::hasPiece);
    }

    @Override public Follower follower() { return follower; }
    @Override public String runningAlliance() { return "RED"; }
    @Override public Pose mirror(Pose pose) { return new Pose(-pose.x(), -pose.y(), pose.heading() + Math.PI); }

    // Needed for path speeds: without it every path drives at full speed. Apply the cap the way your
    // follower setup does; for a ForesightV3 follower built from a config you keep, this is the line.
    @Override public Path atSpeed(Path path, double fraction) {
        return path.with(foresightConfig.setPathSpeed(fraction));
    }
}
```

`PedroSetup.createFollower` and `Intake` stand for your own robot's code. This is an integration
outline, not a standalone class: `foresightConfig` is the configuration retained by your own
ForesightV3 follower setup. Supply that configuration or replace `atSpeed` with the speed-cap hook
your follower uses. Removing the override leaves path speeds unapplied.

### Named commands

`NamedCommands` works as on the SolversLib side, with the same names, the same `arg*` readers and the
same error messages. A factory returns an Ivy `Command`, for example one built with `Commands.instant`
or `Command.build()`.

A factory is called every time its name appears in a file. Return a new command each time. An Ivy
`CommandBuilder` holds state, so one instance used in two steps would share it.

Use the runtime's `WaitRobotTime` and `RobotTimeout` for timing inside your own commands. Ivy's
`Commands.waitMs` reads the wall clock, so it lasts a different time on every run of the headless sim.

### The OpMode

`org.horizon36596.zenith.ivy.AutoFromFile` extends the FTC SDK's `LinearOpMode`.

1. **Init.** `Scheduler.reset()`, then the same init as the SolversLib side: read the file,
   `createRobot()`, `init`, `NamedCommands.reset()`, `registerCommands`, the start pose, and the whole
   routine. A problem with the file fails here, on the tile, and names the step.
2. **Start.** `Scheduler.schedule(routine)`. Ivy starts it at once, and `AutoFromFile` checks that it
   did. If a command you scheduled during init or `initLoop` is still running and holds one of the
   routine's requirements at a higher Ivy priority, Ivy would drop the routine without a word, so the
   OpMode fails instead, in telemetry and on the Driver Station, naming the requirement. See
   [A command left running from init](command-libraries.md#a-command-left-running-from-init).
3. **Each loop.** Your robot's `periodic`, then `Scheduler.execute()`.
4. **Stop.** `Scheduler.reset()`, however the OpMode ends, a thrown exception included. It ends
   nothing, as SolversLib's `reset()` ends nothing.

### The OpMode stub

`zenith deploy` writes one stub per auto, as on the SolversLib side. The Ivy stub imports
`AutoFromFile` and `ZenithRobot` from `org.horizon36596.zenith.ivy`. This one is for the starter
example's `cycle-and-park` auto:

```java
package org.firstinspires.ftc.teamcode.zenith.generated;

import com.qualcomm.robotcore.eventloop.opmode.Autonomous;
import org.horizon36596.zenith.ivy.AutoFromFile;
import org.horizon36596.zenith.ivy.ZenithRobot;

/** GENERATED by zenith deploy from autos/cycle-and-park.auto.json. Do not edit; edit the file and re-run zenith deploy. */
@Autonomous(name = "Cycle and park", group = "Generated")
public final class CycleAndParkAuto extends AutoFromFile {
    @Override protected String autoName() { return "cycle-and-park"; }
    @Override protected ZenithRobot createRobot() { return new org.firstinspires.ftc.teamcode.zenith.MyRobot(); }
}
```

### Deploy

Set `commandLibrary` in the `deploy` block of `zenith.json`:

```json
"deploy": {
  "kind": "androidAssets",
  "dir": "TeamCode/src/main/assets/autos",
  "commandLibrary": "ivy",
  "robotClass": "org.firstinspires.ftc.teamcode.zenith.MyRobot"
}
```

`zenith deploy` then writes OpMode stubs that extend `org.horizon36596.zenith.ivy.AutoFromFile`, and
`zenith codegen` writes the Ivy form of the readable class. `zenith deploy` names the library on the
first line of its output, `command library: Ivy (org.horizon36596.zenith.ivy)`, and as
`commandLibrary` under `--json`. The desktop app's deploy preview names it too. Set
`commandLibrary` to `"solverslib"` for the SolversLib runtime.

### How the tree is built

The same as the SolversLib tree, step for step. The groups are the runtime's own: `Sequence`,
`Parallel` and `Branch` in `org.horizon36596.zenith.ivy`. Ivy's own groups keep members in a hash map,
so their order can change between runs, and they end some members twice or end members that never
started. The runtime's groups run members in file order and end each one exactly once.

- **Paths.** The Ivy `FollowPath` starts following at start, is done when the follower stops following,
  requires `drive()`, and holds the robot where it is when it is interrupted.
- **`PedroCommands.follow`.** You can return it from your robot's `followPath` instead. It finishes on
  the follower's parametric end rather than when the follower stops following, requires nothing, and
  does nothing when it is interrupted, so the robot keeps driving the path.
- **Suspension.** The routine is ended, not suspended, when a higher-priority command takes a
  requirement it holds. If your own code suspends it, every running step is suspended with it and a
  running path holds where it is. Ivy does not start a command again when it resumes, so that path ends
  on the next loop and the routine goes on from the next step. The path's markers that the robot had
  not reached do not run.

## Determinism

The runtime's timers read the robot's `nanoTime()`; they do not read a random source. The default
clock is `System.nanoTime()`, so a headless harness must supply its stepped clock. Repeating a run
also needs the same model, initial state, inputs and deterministic robot commands. A command that
reads wall time or an unseeded random source can still make the result differ. See
[Simulation](simulation.md).
