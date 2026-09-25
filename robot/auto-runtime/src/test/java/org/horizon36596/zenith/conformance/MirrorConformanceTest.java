/*
 * MIT License
 *
 * Copyright (c) 2026 Horizon (FTC 36596)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
 * OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

package org.horizon36596.zenith.conformance;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;
import com.pedropathing.paths.PathSegment;

import org.horizon36596.zenith.AutoSource;
import org.horizon36596.zenith.PedroPaths;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.function.UnaryOperator;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The robot mirrors a file the way the editor does.
 *
 * <p>For every starter auto and every conformance fixture, the file F is run as BLUE, the other
 * alliance, so the runtime mirrors it through the robot's {@code mirror}. Next to it runs the file
 * {@code mirrorAuto} in {@code packages/core/src/mirror.ts} makes of F, saved as BLUE, so the runtime
 * does not mirror it at all. {@code packages/season-biobuzz/src/mirroredFixtures.test.ts} writes those
 * files and fails when they drift. The two runs must hand the follower the same paths, with the same
 * positions and headings at every sampled t, and log the same events on the same loops with the same
 * trace. Both runtimes, SolversLib and Ivy, are held to it.
 *
 * <p>Two mirrors are run. {@code pointSymmetry} is BIOBUZZ's, the one {@code field.json} declares;
 * {@code mirrorX} is a reflection, which reverses the way every turn goes.
 *
 * <p>Numbers are compared to within what canonical form rounds a mirrored file to: four decimals of a
 * radian, and a heading only up to whole turns, since F run as BLUE turns heading h into h + pi where
 * the saved file writes h - pi. Everything else in the log and the trace is compared exactly.
 */
class MirrorConformanceTest {

    /** Canonical form writes radians to four decimals, so a mirrored file's heading is within 5e-5. */
    static final double HEADING_TOLERANCE_RAD = 2e-4;

    /** Poses in the log are printed to hundredths and headings to thousandths. */
    static final double LOGGED_INCHES = 0.011;
    static final double LOGGED_RAD = 0.0011;

    static final class Mode {
        final String name;
        final UnaryOperator<Pose> mirror;

        Mode(String name, UnaryOperator<Pose> mirror) {
            this.name = name;
            this.mirror = mirror;
        }
    }

    static final List<Mode> MODES = Arrays.asList(
            new Mode("pointSymmetry", World.POINT_SYMMETRY),
            new Mode("mirrorX", World.MIRROR_X));

    static AutoSource mirrored(String mode, String source) {
        File dir = new File("src/test/resources/mirrored/" + mode + "/" + source);
        assertTrue(dir.isDirectory(), "the mirrored fixtures are at " + dir.getAbsolutePath()
                + "; packages/season-biobuzz/src/mirroredFixtures.test.ts writes them");
        return AutoSource.directory(dir);
    }

    static List<String> autosIn(File dir) {
        String[] files = dir.list();
        assertTrue(files != null && files.length > 0, dir.getAbsolutePath());
        Arrays.sort(files);
        List<String> names = new ArrayList<String>();
        for (String file : files) {
            if (file.endsWith(".auto.json")) {
                names.add(file.substring(0, file.length() - ".auto.json".length()));
            }
        }
        return names;
    }

    interface Runner {
        Outcome run(AutoSource source, String autoName, String alliance, World world);
    }

    static final Runner SOLVERSLIB = (source, name, alliance, world) ->
            SolversLibRun.run(source, name, alliance, world, ConformanceTest.LOOPS);
    static final Runner IVY = (source, name, alliance, world) ->
            IvyRun.run(source, name, alliance, world, ConformanceTest.LOOPS);

    static World world(UnaryOperator<Pose> mirror) {
        World world = new World();
        world.mirror = mirror;
        return world;
    }

    @TestFactory
    List<DynamicTest> aFileRunAsTheOtherAllianceDrivesWhatTheEditorsMirrorOfItDrives() {
        List<DynamicTest> tests = new ArrayList<DynamicTest>();
        String[][] sources = {
            {"starter", new File("../../examples/starter/autos").getPath()},
            {"conformance", new File("src/test/resources/conformance").getPath()},
        };
        for (final Mode mode : MODES) {
            for (final String[] source : sources) {
                final AutoSource original = "starter".equals(source[0])
                        ? ConformanceTest.starter()
                        : ConformanceTest.conformance();
                final AutoSource mirrored = mirrored(mode.name, source[0]);
                List<String> names = autosIn(new File(source[1]));
                assertEquals(names, autosIn(new File("src/test/resources/mirrored/" + mode.name + "/" + source[0])),
                        "every " + source[0] + " auto has a mirrored copy");
                for (final String name : names) {
                    for (final String runtime : new String[] {"solverslib", "ivy"}) {
                        final Runner runner = "ivy".equals(runtime) ? IVY : SOLVERSLIB;
                        final String label = source[0] + " " + name + " " + mode.name + " " + runtime;
                        tests.add(DynamicTest.dynamicTest(label, () -> {
                            World asBlue = world(mode.mirror);
                            World saved = world(mode.mirror);
                            // Every file here is written for RED, and mirrorAuto saves it for BLUE.
                            Outcome mirroredOnTheRobot = runner.run(original, name, "BLUE", asBlue);
                            Outcome mirroredInTheEditor = runner.run(mirrored, name, "BLUE", saved);
                            ConformanceTest.save(label + " robot", "mirror", mirroredOnTheRobot);
                            ConformanceTest.save(label + " editor", "mirror", mirroredInTheEditor);
                            samePaths(asBlue.followed, saved.followed);
                            sameText(String.join("\n", mirroredInTheEditor.log()),
                                    String.join("\n", mirroredOnTheRobot.log()), LOG_POSE, 3);
                            sameText(mirroredInTheEditor.trace.render(), mirroredOnTheRobot.trace.render(),
                                    TRACE_ROW, 4);
                        }));
                    }
                }
            }
        }
        return tests;
    }

    /** Every path the follower was handed, sampled along each segment. */
    static void samePaths(List<Path> robot, List<Path> editor) {
        assertEquals(editor.size(), robot.size(), "the same number of paths is followed");
        for (int p = 0; p < robot.size(); p++) {
            List<PathSegment> a = robot.get(p).getSegments();
            List<PathSegment> b = editor.get(p).getSegments();
            assertEquals(b.size(), a.size(), "path " + p + " has the same segments");
            for (int s = 0; s < a.size(); s++) {
                for (int k = 0; k <= 100; k++) {
                    double t = k / 100.0;
                    Pose got = a.get(s).get(t);
                    Pose want = b.get(s).get(t);
                    String where = "path " + p + " segment " + s + " at t " + t + ": the robot's mirror gives "
                            + got + ", the editor's " + want;
                    assertEquals(want.x(), got.x(), 1e-9, where);
                    assertEquals(want.y(), got.y(), 1e-9, where);
                    assertTrue(Math.abs(PedroPaths.normalizeSigned(want.heading() - got.heading()))
                            < HEADING_TOLERANCE_RAD, where);
                }
            }
        }
    }

    /** A pose in the world's log: {@code (x, y, heading)}. */
    static final Pattern LOG_POSE = Pattern.compile("\\((-?\\d+\\.\\d+), (-?\\d+\\.\\d+), (-?\\d+\\.\\d+)\\)");

    /** A pose row in the trace: {@code [t, x, y, heading]}. */
    static final Pattern TRACE_ROW = Pattern.compile(
            "\\[(-?\\d+\\.\\d+), (-?\\d+\\.\\d+), (-?\\d+\\.\\d+), (-?\\d+\\.\\d+)\\]");

    /**
     * {@code actual} is {@code expected} with every pose in it within rounding: the text around the poses
     * exactly, each pose's numbers to within what they are printed to, and its heading, the group numbered
     * {@code headingGroup}, only up to whole turns.
     */
    static void sameText(String expected, String actual, Pattern pose, int headingGroup) {
        Matcher want = pose.matcher(expected);
        Matcher got = pose.matcher(actual);
        StringBuilder wantRest = new StringBuilder();
        StringBuilder gotRest = new StringBuilder();
        int wantAt = 0;
        int gotAt = 0;
        while (want.find()) {
            if (!got.find()) {
                fail("the robot's run has fewer poses than the editor's; robot:\n" + actual + "\neditor:\n" + expected);
            }
            wantRest.append(expected, wantAt, want.start()).append("<pose>");
            gotRest.append(actual, gotAt, got.start()).append("<pose>");
            wantAt = want.end();
            gotAt = got.end();
            for (int g = 1; g <= want.groupCount(); g++) {
                double a = Double.parseDouble(want.group(g));
                double b = Double.parseDouble(got.group(g));
                boolean same = g == headingGroup
                        ? Math.abs(PedroPaths.normalizeSigned(a - b)) <= LOGGED_RAD
                        : Math.abs(a - b) <= (g == 1 && pose == TRACE_ROW ? 0 : LOGGED_INCHES);
                if (!same) {
                    fail("the editor's " + want.group() + " is the robot's " + got.group());
                }
            }
        }
        if (got.find()) {
            fail("the robot's run has more poses than the editor's; robot:\n" + actual + "\neditor:\n" + expected);
        }
        wantRest.append(expected.substring(wantAt));
        gotRest.append(actual.substring(gotAt));
        assertEquals(wantRest.toString(), gotRest.toString());
    }
}
