# Full sim with SimLoop

Zenith's [high-fidelity sim](simulation.md#high-fidelity-sim) runs your robot repository's own
headless sim, then draws what it recorded over the plan. [SimLoop](https://libraries.horizon36596.org/simloop/)
is Horizon's library for running FTC robot code on a laptop, against fake hardware, in a JVM unit
test. This page sets the two up together: SimLoop's starter folder for the sim, Zenith's
[robot runtime](robot-runtime.md) for the auto, and one test that joins them.

Zenith does not need SimLoop. Any headless sim that writes a [trace](simulation.md#the-trace) works.
SimLoop is one way to get there without writing the sim yourself.

## What you need

- An FTC project on **SDK 12.0**. SimLoop `v0.2.0-alpha.1` is built against it.
- A JDK and Android SDK configured for your FTC project's Gradle build. The sim runs on the JVM,
  but the test task still builds through the Android Gradle Plugin.
- The Zenith robot runtime, Pedro Pathing v3 and your command library, set up as
  [Robot runtime](robot-runtime.md#install) says, with at least one auto deployed into `TeamCode`.
- The Zenith desktop app, or the `zenith` CLI.

SimLoop is an alpha. Keep its version pinned, as its starter folder does.

## 1. Install SimLoop

Copy the `simloop-starter/` folder from SimLoop's `v0.2.0-alpha.1` tag into the root of your FTC project, next to `TeamCode/`,
then add one line to the bottom of `TeamCode/build.gradle`:

```groovy
apply from: "$rootDir/simloop-starter/simloop.gradle"
```

Run `./gradlew :TeamCode:testDebugUnitTest`. The starter's two example tests should pass. The
[SimLoop docs](https://libraries.horizon36596.org/simloop/) explain the folder and what it adds.

## 2. Simulate your robot

Write one class in your test sources that builds your robot on fake hardware. SimLoop's
`ExampleRobotSim` in the starter is the pattern to copy:

- a `FakeHardwareMap` with a fake device under every name your robot code looks up;
- a `MecanumDrivePlant` behind the four drive motors, with your chassis's wheel mounting signs and
  the same top speeds your follower is tuned to;
- the localizer Pedro reads, fed from the plant. With a goBILDA Pinpoint, put SimLoop's
  `FakeGoBildaPinpoint` at the start pose with `attachChassisAt(xMm, yMm, headingRad)`, and after
  the plant moves each tick, report where it went with `moveChassisTo(xMm, yMm, headingRad)`. Mount
  its pods where your localizer config says they are;
- a plant or a fake for each mechanism an auto command or condition waits on, so the command can
  finish and the condition can come true.

Give it a `step(dt)` method that advances every plant by one tick. The test calls it every tick.

Use measured robot constants where you have them and label placeholders where you do not. Compare
the model with a real robot run before relying on its timing or clearance predictions. A passing sim
test checks the code against the model you supplied.

## 3. Run an auto in a test

Two classes in your test sources do this: an OpMode that records a trace, and a test that runs it.

**The traced OpMode** is your auto's OpMode with a recorder around it. Subclass `AutoFromFile`, as
the OpMode `zenith deploy` generates does, and change only what a sim needs:

- `createRobot()` returns your robot class with `step` overridden to wrap every step:
  `return trace.traced(id, body);`. `AutoTraceWriter` (in `org.horizon36596.zenith.solverslib`, or
  `org.horizon36596.zenith.ivy` for Ivy) then records when each step starts and ends;
- `autoName()` and the auto files' folder (`setAutoSource(AutoSource.directory(...))`) come from the
  test instead of being written into the class;
- each loop, call `trace.tick(timeS)` with the time since the routine started, and
  `trace.pose(xIn, yIn, headingRad)` with the pose the follower believes. `trace.truthPose(...)`
  with the plant's pose records the real one beside it;
- if your sim models more than the drive, record that too:
  `trace.structureContact(obstacle, penetrationIn)` when the chassis touches a structure,
  `trace.ledger().held(n).launches(n).tips(alliance, n)` when the robot's game pieces change, and
  `trace.event(kind, alliance)` for anything else worth a mark on the timeline. Declare what it
  checks before the run, `trace.capability(AutoTrace.STRUCTURE_CONTACTS)` and
  `trace.capability(AutoTrace.LEDGER)`, so a clean run reads as checked rather than inert.
  [The trace](simulation.md#the-trace) says what each field means;
- when the OpMode ends, `trace.write(file)`.

SimLoop builds the OpMode itself, inside the class loader that gives it the sim clock, so the OpMode
cannot take constructor arguments. Pass the auto's name, the folder, the trace path, the tick and the
drive plant through `OpMode.blackboard` instead.

**The test** reads the auto's name from the `zenith.auto` system property, builds the sim from step 2,
places it at the auto's start pose, and runs the traced OpMode for the autonomous period plus a margin:

```java
OpModeRunner.forTeamClass(TracedAuto.class, sim.hardwareMap)
        // Your code, SolversLib, Pedro and the Zenith runtime all read the sim clock. The Zenith
        // runtime's classes extend SolversLib's, so they must be in the same loader.
        .teamPackages("org.firstinspires.ftc.teamcode.", "com.seattlesolvers.solverslib.",
                SimClockLoader.PEDRO_PATHING, "org.horizon36596.zenith.")
        .keepBlackboard(true)
        .tickSeconds(OpModeRunner.DEFAULT_TICK_SECONDS)
        .initLoopTicks(25)
        .activeTicks((int) Math.round((30 + 2) / OpModeRunner.DEFAULT_TICK_SECONDS))
        .eachTick(sim::step)
        .run();
```

Leave out `"org.horizon36596.zenith."` and the run fails with class loader linkage errors. Then check
that the trace was written, and that each step in it ran to its end. The trace goes to
`TeamCode/build/sim/<auto>.trace.json`.

## 4. Pass the auto's name to the test

Gradle does not hand its own `-Dzenith.auto` to the test JVM. Forward it in `TeamCode/build.gradle`,
inside the `android { }` block:

```groovy
testOptions {
    unitTests.all {
        def zenithAuto = System.getProperty('zenith.auto')
        if (zenithAuto) {
            systemProperty 'zenith.auto', zenithAuto
            // The auto files are not task inputs, so a named run always runs.
            outputs.upToDateWhen { false }
        }
    }
}
```

If your file already has a `testOptions` block, put the `unitTests.all` part inside it.

## 5. Tell Zenith how to run it

Add a `sim` block to `zenith.json`, naming your test class:

```json
"sim": {
  "command": "./gradlew :TeamCode:testDebugUnitTest --tests \"*ZenithAutoHeadlessTest*\" -Dzenith.auto={auto}",
  "trace": "TeamCode/build/sim/{auto}.trace.json"
}
```

## 6. Run it

In the desktop app, open the robot project, open an auto and press **High-fidelity sim**. If the auto
has unsaved edits, the app asks you to save first, because the sim runs the file on disk. It runs the
command, streams its output, and draws the recorded path over the plan. The
**Full sim** playback level then plays the recorded run. From a terminal, `zenith sim <auto>` does the
same and prints the report.

The first run downloads Gradle dependencies and can take a few minutes.

## Full sim speed

A run through `sim.command` starts Gradle, builds the robot code and starts a new JVM each time, so
it takes several seconds before anything plays. A **sim server** skips that: it is one JVM that stays
running and runs an auto each time Zenith asks. The desktop app's **Settings, General, Full sim
speed** chooses how it is used.

SimLoop `v0.2.0-alpha.1` has no sim server. It comes with a later SimLoop version. Until your robot
code has one, every run is Basic.

| Speed | What it does | What it costs |
|---|---|---|
| **Basic** | Runs `sim.command` for every run. Nothing keeps running afterwards. | Roughly 6 to 10 s before a run starts to play. The computer is used only while a run is going. |
| **Fast** (default) | Starts the sim server on the first run and stops it after 10 minutes with no run. Each run plays as it is simulated. | Roughly 4 s for the first run while the server starts, then well under 1 s. Roughly 0.3 GB of memory while the server is up, and one or two processor cores for a second or two each run. |
| **Ultrafast** | Starts the sim server when the project opens. About half a second after you save an auto, runs it again in the background, so the next run of that auto plays at once. | Roughly 0.3 GB of memory while the project is open, and one or two processor cores for a second or two after each save. |

The figures are rough. They were measured on a team laptop with one team's robot code; another
robot's code, or a slower computer, will differ. On Windows, the desktop app asks Windows not to slow the sim server down
as background work ("power throttling"): left throttled, the same runs took three to four times as long.

At Fast and Ultrafast, the timeline says **Simulating** while the rows arrive, the Full sim level
plays from the first rows, and the playhead waits at the last time received until more comes. When
the run ends, the trace is the same one the server writes to disk. Cancelling, or a run that fails,
puts back the trace that was loaded before.

Ultrafast plays a saved run only when the auto file, the waypoints file and the robot file are the
same as when it ran, and the robot code has not changed since. Anything else is a new run.

A project whose `zenith.json` has no `sim.server` section runs Basic, whatever the setting says, and
the sim panel says so when a run starts. The setting is only in the desktop app: the web app does
not run the robot repository's sim, so its Settings has no Full sim speed row. If the server cannot
be used for a run (its prepare command fails, it speaks another protocol version, it does not start,
or it stops part way), that run falls back to Basic and the sim panel says why.

### Setting up the sim server

Add a `server` block to the `sim` section of `zenith.json`. Keep the `command` and `trace` from
[step 5](#5-tell-zenith-how-to-run-it): Basic still uses them.

```json
"sim": {
  "command": "./gradlew :TeamCode:testDebugUnitTest --tests \"*ZenithAutoHeadlessTest*\" -Dzenith.auto={auto}",
  "trace": "TeamCode/build/sim/{auto}.trace.json",
  "server": {
    "prepare": "./gradlew <your prepare task>",
    "args": "TeamCode/build/sim/server.args",
    "cwd": "TeamCode",
    "watch": ["TeamCode/src", "TeamCode/build.gradle"]
  }
}
```

- `prepare` builds what the server needs and writes the `args` file. It runs like `sim.command`:
  split into words, no shell, and `./gradlew` works on Windows too. It must exit with 0. The task it
  names is yours to write; the SimLoop version with the sim server will describe one.
- `args` is a Java argument file. Zenith starts the server as `java @<args>`, with the same Java it
  uses for the sim command. The file holds the classpath, any `-D` or `-X` options, the server's main
  class and its arguments.
- `cwd` is the server's working folder. It defaults to the folder `zenith.json` is in.
- `watch` lists files and folders whose change means the robot code changed. The server is then
  stopped, and the next run prepares and starts it again. List your robot code's sources and build
  files. The autos folder, the `args` file's folder and the trace folder never count, so a watched
  folder may hold them.

Every path must stay inside the repository. `zenith validate` refuses one that starts with `/`, a
drive letter, or has a `..` part. [File format](file-format.md#sim) has the full rules.

Zenith reads `sim.server` again for every run, so an edit counts on the next run: a changed section
stops the old server and starts a new one, and a removed one runs Basic.

Nothing prepare writes while it runs counts as a change, so a build into a watched folder cannot
make the server rebuild again. A file you save while prepare runs is not noticed either; save it
again once prepare is done.

If prepare fails, Ultrafast stops running saved autos in the background, so a broken build is not
built again on every save. The next run, or the next change to a watched path, tries again. A server
that speaks another protocol version is tried again when a watched path changes, when its `args`
file changes, or 5 minutes later.

The server speaks protocol 1 with Zenith over its own standard input and output, one JSON object per
line, and nothing listens on a network port. [The sim server protocol](sim-server-protocol.md) has
the messages. Anything the robot code prints goes to the sim panel's log. Zenith stops the server and
everything it started when you quit, when you close the project, when you choose Basic, when Fast's
10 minutes run out, and when a watched path changes.

## What it can and cannot tell you

- The trace holds each step's times and the robot's poses, and the contacts, ledger and events your
  sim records. The report lists the contacts and the ledger as inert until your sim declares them.
  Compare the times with the estimate in the report, and use [`zenith calibrate`](simulation.md#calibrating-the-estimate) to bring the estimate
  closer.
- The sim knows only what you modelled. A mechanism with no plant behind it finishes when its command
  says so, not when the real one would.
- A fake localizer is exact, so the pose the robot believes is the pose it is at. The sim shows no
  localisation error.
- A headless harness is a model too. Simulated motors have no traction limit, so a simulated robot can
  accelerate harder than a real one. Check the sim against a recording of the real robot before you
  tune for a quirk of the harness.
