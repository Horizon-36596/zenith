# MeepMeep exporter

`ZenithTrajectoryExport.java` is a copy-in class for a MeepMeep project. It writes the RoadRunner 1.0
trajectory your MeepMeep bot runs to a Zenith interchange `trajectory.json`, which `zenith import`
turns into a partner trajectory for the alliance view. MIT, copyright Horizon (FTC 36596).

It is not part of the robot runtime and is not built by `robot/`'s Gradle build: it belongs in your
MeepMeep module, next to the class that runs MeepMeep.

## Use

1. Copy `ZenithTrajectoryExport.java` into your MeepMeep module (the `MeepMeepTesting` module the
   MeepMeep README sets up), in the package `org.horizon36596.zenith.meepmeep` or one of your own
   (change the `package` line).
2. After `myBot.runAction(...)`, add one line:

   ```java
   ZenithTrajectoryExport.write(myBot, java.nio.file.Paths.get("trajectory.json"),
           new ZenithTrajectoryExport.Options("biobuzz", "RED", 18, 18));
   ```

   The two numbers are the robot's length along its heading and its width, in inches: the `height`
   and `width` you gave `setDimensions`, in that order.
3. Run MeepMeep. The file appears in the module's working directory. Import it with
   `zenith import trajectory.json`.

## What it writes

The pose every 0.1 s, in MeepMeep's coordinates (inches, radians, origin at the field centre), with
`"frame": { "preset": "roadrunner" }`. For BIOBUZZ that frame is the FTC Field Coordinate System, and
Zenith turns it a quarter turn into the season's frame on import
(Zenith's ADR 0008, section 4). Waits and turns are included
the way MeepMeep plays them; after the last trajectory the robot holds its last pose.

It writes the trajectory only, not an editable path, because RoadRunner's splines do not map exactly
onto Pedro's Bézier segments. RoadRunner 0.5 is not supported.

## Status

**Verified on 2026-09-28 against MeepMeep 0.1.7 and RoadRunner 1.0.1 built from source, not yet
against the published jars.** `maven.brott.dev`, where the MeepMeep and RoadRunner READMEs publish
them, is refused by the Zenith build environment's egress policy, and so is JitPack; neither library
is on Maven Central. So the libraries were built from their public source at their release tags, with
Kotlin 1.9.0 as their own builds use, and published under their real coordinates to a local Maven
repository:

| artifact | built from | tag | commit |
|---|---|---|---|
| `com.acmerobotics.roadrunner:MeepMeep:0.1.7` | `github.com/acmerobotics/MeepMeep` | `v0.1.7` | `04a0b1464ec5568d6e4398f7777e36800549be5d` |
| `com.acmerobotics.roadrunner:core:1.0.1` and `:actions:1.0.1` | `github.com/acmerobotics/road-runner` | `v1.0.1` | `03367b9701fd37f98705d65af56e4d4cd27417a6` |
| `com.acmerobotics.dashboard:core:0.4.7` (which `actions` depends on) | `github.com/acmerobotics/ftc-dashboard` | `v0.4.7` | `c25de0fb1eb7f2272bd564fc4f58561a961277ef` |

Kotlin standard library 1.9.0 and Gson 2.8.6 came from Maven Central. A build from source at the tag
has the same sources and coordinates as the published jar, but it is not the same file, so the first
team to drop the exporter into a MeepMeep 0.1.7 project with the published jars still confirms that.

What was checked, with JDK 21, Gradle 8.14 and Xvfb:

- `ZenithTrajectoryExport.java`, unchanged, compiles against those classes in a MeepMeep module set up
  the way the MeepMeep README sets one up (Java 8, `-Xlint:all -Werror`). No API mismatch was found:
  every class and member it uses has, under `javap`, the signature the stand-ins in `standin/` give.
- `real-check/` runs a real MeepMeep bot: from `(63, -40, pi)`, `lineToX(45)`, `waitSeconds(0.5)`,
  `splineTo((36, 0), pi / 2)`, `turn(pi / 2)`, at 60 in/s, 60 in/s², 180 deg/s and 180 deg/s². MeepMeep
  laid it out as the line to 1.095 s, the wait to 1.595 s, the spline to 3.595 s and the turn to
  5.010 s. Every exported sample is within 0.00005 in and 0.0000005 rad (the file's rounding) of the
  pose MeepMeep's own `RoadRunnerBotEntity.update` gives at the same time, which is the pose it draws;
  screenshots of the MeepMeep window at 0, 1, 2.3, 3.4 and 4.96 s show the robot at those poses. The
  export through `write(Action, ...)` is byte for byte the export through `write(bot, ...)`.
- That export is `packages/import/fixtures/trajectory/meepmeep-line-wait-spline-turn.trajectory.json`.
  `zenith import` reads it with no warnings; `meepmeepRealExport.test.ts` pins it: the `roadrunner`
  preset turns every sample a quarter turn into the season's frame (`(x, y, h)` to `(y, -x, h - pi/2)`),
  the view projection lands within its rounding of MeepMeep's poses, the wait holds still at the line's
  end, and the route ends at `(0, -36)` facing north. Zenith reports the trajectory as 5.1 s where
  MeepMeep shows 5.01 s: the file has whole 0.1 s steps, and its last sample holds the final pose.
- With a trailing `waitSeconds(1)`, MeepMeep shows the robot at `(0, 0, 0)` during the wait, and the
  exporter holds the last pose instead, as its javadoc says.

`standin/` still holds the stand-in classes, now checked against the real signatures, and a harness
that exports a stand-in timeline; `packages/import/fixtures/trajectory/meepmeep-line-and-turn.trajectory.json`
is that harness's output. To repeat the stand-in check:

```
cd robot/meepmeep-export
mkdir -p /tmp/zenith-meepmeep && javac -d /tmp/zenith-meepmeep $(find standin -name "*.java") ZenithTrajectoryExport.java
java -cp /tmp/zenith-meepmeep Harness /tmp/zenith-meepmeep/trajectory.json
```

To repeat the real check where `maven.brott.dev` is reachable (`--screenshots` needs a display, such as
`xvfb-run -a -s "-screen 0 1000x1000x24"`):

```
cd robot/meepmeep-export/real-check
gradle installDist
build/install/MeepMeepExportCheck/bin/MeepMeepExportCheck /tmp/zenith-meepmeep-real --screenshots
```

Where it is not, clone the three tags above into one directory as `mm`, `rr` and `dash`, build them
into a local repository, and point the check at it:

```
gradle -p source-build publish -Psources=<clones> -Prepo=/tmp/zenith-meepmeep-m2
gradle installDist -PlocalRepo=/tmp/zenith-meepmeep-m2
```

Add `-PcentralMirror=<url>` to the source build if Maven Central answers HTTP 429.
