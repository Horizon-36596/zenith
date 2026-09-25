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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pedropathing.math.Pose;

import org.horizon36596.zenith.AutoSource;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

import java.io.File;
import java.io.IOException;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.function.UnaryOperator;

/**
 * The conformance suite: the same auto file, run through the SolversLib
 * runtime and the Ivy runtime on the same {@link World}, produces the same events on the same loops
 * and the same trace.
 *
 * <p>Each run writes its log to {@code build/conformance/<case>.<runtime>.log}, so a failure can be
 * read side by side.
 */
class ConformanceTest {

    /** Enough loops for the longest fixture to finish, with room to spare. */
    static final int LOOPS = 600;

    static final class Case {
        final String label;
        final AutoSource source;
        final String autoName;
        final String alliance;
        /** The field's mirror, used when {@link #alliance} is not the file's. */
        final UnaryOperator<Pose> mirror;

        Case(String label, AutoSource source, String autoName, String alliance) {
            this(label, source, autoName, alliance, World.POINT_SYMMETRY);
        }

        Case(String label, AutoSource source, String autoName, String alliance, UnaryOperator<Pose> mirror) {
            this.label = label;
            this.source = source;
            this.autoName = autoName;
            this.alliance = alliance;
            this.mirror = mirror;
        }
    }

    static AutoSource conformance() {
        try {
            return AutoSource.directory(new File(ConformanceTest.class
                    .getResource("/conformance/waypoints.json").toURI()).getParentFile());
        } catch (URISyntaxException problem) {
            throw new IllegalStateException(problem);
        }
    }

    /** The starter example's autos, the ones a new team deploys first. */
    static AutoSource starter() {
        File dir = new File("../../examples/starter/autos");
        assertTrue(new File(dir, "first-auto.auto.json").isFile(), "the starter example is at " + dir.getAbsolutePath());
        return AutoSource.directory(dir);
    }

    static List<Case> cases() {
        List<Case> cases = new ArrayList<Case>();
        // Every auto in the starter example, read from the directory so a new one is covered too.
        AutoSource starter = starter();
        String[] starterFiles = new File("../../examples/starter/autos").list();
        Arrays.sort(starterFiles);
        for (String file : starterFiles) {
            if (file.endsWith(".auto.json")) {
                String name = file.substring(0, file.length() - ".auto.json".length());
                addWithMirrors(cases, "starter " + name, starter, name);
            }
        }
        for (String name : new String[] {
            "sequence-rules", "groups", "branches", "never-ends", "edges", "headings", "mirror-headings",
        }) {
            addWithMirrors(cases, name, conformance(), name);
        }
        return cases;
    }

    /**
     * The file as the RED it is written for, and as BLUE under BIOBUZZ's point symmetry and under a
     * reflection, so the two runtimes are held to the same mirrored paths as well as the same plain ones.
     */
    static void addWithMirrors(List<Case> cases, String label, AutoSource source, String name) {
        cases.add(new Case(label, source, name, "RED"));
        cases.add(new Case(label + " mirrored", source, name, "BLUE", World.POINT_SYMMETRY));
        cases.add(new Case(label + " reflected", source, name, "BLUE", World.MIRROR_X));
    }

    /** A fresh world with {@code c}'s mirror. */
    static World world(Case c) {
        World world = new World();
        world.mirror = c.mirror;
        return world;
    }

    static Outcome solversLib(Case c) {
        return SolversLibRun.run(c.source, c.autoName, c.alliance, world(c), LOOPS);
    }

    static Outcome ivy(Case c) {
        return IvyRun.run(c.source, c.autoName, c.alliance, world(c), LOOPS);
    }

    static void save(String label, String runtime, Outcome outcome) {
        File dir = new File("build/conformance");
        dir.mkdirs();
        try {
            Files.write(new File(dir, label.replace(' ', '-') + "." + runtime + ".log").toPath(),
                    outcome.log(), StandardCharsets.UTF_8);
        } catch (IOException problem) {
            throw new IllegalStateException(problem);
        }
    }

    @TestFactory
    List<DynamicTest> bothRuntimesLogTheSameEventsOnTheSameLoops() {
        List<DynamicTest> tests = new ArrayList<DynamicTest>();
        for (final Case c : cases()) {
            tests.add(DynamicTest.dynamicTest(c.label, () -> {
                Outcome solvers = solversLib(c);
                Outcome ivy = ivy(c);
                save(c.label, "solverslib", solvers);
                save(c.label, "ivy", ivy);
                assertNull(solvers.thrown, "SolversLib threw; log " + solvers.log());
                assertNull(ivy.thrown, "Ivy threw; log " + ivy.log());
                assertEquals(String.join("\n", solvers.log()), String.join("\n", ivy.log()));
                assertEquals(solvers.trace.render(), ivy.trace.render());
            }));
        }
        return tests;
    }

    // ---------------------------------------------------------------------------------------------
    // The logs are the same; these check they are also right.
    // ---------------------------------------------------------------------------------------------

    static Outcome both(String name) {
        Case c = new Case(name, conformance(), name, "RED");
        Outcome solvers = solversLib(c);
        Outcome ivy = ivy(c);
        assertEquals(String.join("\n", solvers.log()), String.join("\n", ivy.log()));
        return ivy;
    }

    static int count(List<String> log, String suffix) {
        int n = 0;
        for (String line : log) {
            if (line.substring(line.indexOf(' ') + 1).equals(suffix)) {
                n++;
            }
        }
        return n;
    }

    static int loopOf(List<String> log, String suffix) {
        for (String line : log) {
            int space = line.indexOf(' ');
            if (line.substring(space + 1).equals(suffix)) {
                return Integer.parseInt(line.substring(0, space));
            }
        }
        throw new AssertionError("no \"" + suffix + "\" in " + log);
    }

    @Test
    void everyEndRuleInASequenceEndsItsStepTheWayTheFileSays() {
        List<String> log = both("sequence-rules").log();
        assertEquals(1, count(log, "forever interrupted"), "a timeout ends a command that never ends, once");
        assertEquals(1, count(log, "step timeoutFires end"), "the timeout is part of the step: " + log);
        assertEquals(1, count(log, "take {loops=3} end"), "a timeout that does not fire leaves the command alone");
        assertEquals(loopOf(log, "step waitTime start") + 5, loopOf(log, "step waitTime end"),
                "a 0.1 s wait is five 20 ms loops");
        assertEquals(loopOf(log, "step waitNever start") + 5, loopOf(log, "step waitNever end"));
        assertTrue(loopOf(log, "step waitHopper end") >= 30, "hopperFull holds from loop 30");
        assertTrue(loopOf(log, "step endFires end") < loopOf(log, "step endSpare start") + 1);
        assertEquals(1, count(log, "routine finished"));
        assertEquals(loopOf(log, "step endFires start") + 6, loopOf(log, "step endFires end"),
                "an endCondition ends the path on the loop it first holds, halfway along 24 in");
        assertEquals(0, count(log, "hold (-24.00, -24.00, 0.000)"), "a path that arrives is not held");
    }

    @Test
    void markersFireInOrderOfDistanceNotOfTheFile() {
        List<String> log = both("sequence-rules").log();
        int t0 = loopOf(log, "instant {at=t0} start");
        int fourIn = loopOf(log, "instant {at=4in} start");
        int half = loopOf(log, "take {at=t0.5, loops=2} start");
        int fromEnd = loopOf(log, "instant {at=6in from end} start");
        int t1 = loopOf(log, "instant {at=t1} start");
        assertTrue(t0 <= fourIn && fourIn < half && half < fromEnd && fromEnd <= t1, log.toString());
        assertTrue(log.indexOf(t1 + " instant {at=t1} start") < log.indexOf(t1 + " step markers end")
                || log.indexOf(t1 + " step markers end") < 0, "a marker at t = 1 fires before the path ends");
    }

    @Test
    void groupsEndTheirMembersOnceAndInterruptOnlyWhatIsStillRunning() {
        List<String> log = both("groups").log();
        assertEquals(1, count(log, "step race end"));
        assertEquals(1, count(log, "step raceForever interrupted"));
        assertEquals(1, count(log, "step outerForever interrupted"), "a sequence as a deadline ends the others");
        assertEquals(1, count(log, "step deepForever interrupted"));
        assertEquals(1, count(log, "step afterRace end"), "three deep, the race still hands on to its sequence");
        assertEquals(1, count(log, "step longIntake interrupted"), "a path as a deadline ends the others");
        assertEquals(1, count(log, "step timedForever end"), "a member's own timeout ends that member");
        assertEquals(1, count(log, "step timedTake end"), "a member's timeout does not end another member");
        assertEquals(loopOf(log, "step timedForever end"), loopOf(log, "step memberTimeout end"),
                "the group ends once its last member has");
    }

    @Test
    void branchesTakeTheArmTheConditionSaysAtTheMomentTheyStart() {
        List<String> log = both("branches").log();
        assertEquals(1, count(log, "step yesThen start"), log.toString());
        assertEquals(0, count(log, "step yesElse start"));
        assertEquals(0, count(log, "step noThen start"), "an empty else runs nothing and ends");
        assertEquals(1, count(log, "step no end"));
        assertEquals(1, count(log, "step innerDrive end"));
        assertEquals(1, count(log, "step lateThen start") + count(log, "step lateElse start"));
        assertEquals(1, count(log, "step stuck end"), "a timeout in the arm a branch chose ends that step");
        assertEquals(loopOf(log, "step stuck end"), loopOf(log, "step branchTimeout end"),
                "and the branch ends with its arm");
    }

    @Test
    void aCommandThatNeverEndsRunsUntilItsTimeoutOrTheEndOfTheOpMode() {
        List<String> log = both("never-ends").log();
        assertEquals(1, count(log, "forever interrupted"));
        assertEquals(1, count(log, "forever {n=1} interrupted"));
        assertEquals(1, count(log, "forever {n=2} interrupted"), "a member's timeout ends a race of commands that never end");
        assertEquals(1, count(log, "forever {n=3} start"));
        assertEquals(0, count(log, "forever {n=3} interrupted"), "stopping the OpMode ends nothing");
        assertEquals(0, count(log, "routine finished"));
    }

    @Test
    void edgesBreakTiesInFileOrderAndEndEveryMemberOnce() {
        List<String> log = both("edges").log();
        assertEquals(loopOf(log, "step zeroWait start") + 1, loopOf(log, "step zeroWait end"),
                "a zero second wait is done on its first loop");
        assertEquals(1, count(log, "step onlyMember end"), "a one-member race ends its member naturally");
        assertEquals(1, count(log, "step tieFirst end"));
        assertEquals(1, count(log, "step tieSecond end"), "a member done on the same loop is not interrupted");
        assertEquals(1, count(log, "take {loops=5} end"), "a command done on its timeout's loop ends naturally");
        assertEquals(1, count(log, "step innerShort end"), "an inner timeout ends its own step");
        assertEquals(1, count(log, "step innerLong interrupted"), "an outer deadline interrupts what is left");
        assertEquals(loopOf(log, "step outerLimit end"), loopOf(log, "step innerLong interrupted"),
                "on the loop the deadline wait ends, before the inner timeout would have");
        assertEquals(1, count(log, "forever {n=3} interrupted"), "an instant deadline ends the others at once");
        assertEquals(1, count(log, "forever {n=4} interrupted"), "a marker still running when the path arrives");
        assertEquals(1, count(log, "take {at=end, loops=3} start"), "a marker at t = 1 still fires");
        assertEquals(1, count(log, "routine finished"));
    }

    @Test
    void piecewiseHeadingsTurnWhereTheirRangesSay() {
        List<String> log = both("headings").log();
        // The first path's last range is the tangent of its second line, which points up the field; the
        // curve's last range faces the origin from d, which is the same direction.
        assertEquals(1, count(log, "arrive (-24.00, -24.00, 1.571)"), log.toString());
        assertEquals(1, count(log, "arrive (0.00, -24.00, 1.571)"), log.toString());
        assertEquals(1, count(log, "instant {at=join} start"), "the marker at the join fires once");
        assertEquals(1, count(log, "routine finished"));
    }

    // ---------------------------------------------------------------------------------------------
    // Commands that throw, on both runtimes.
    // ---------------------------------------------------------------------------------------------

    @TestFactory
    List<DynamicTest> aThrowingCommandReachesTheOpModeOnBothRuntimes() {
        List<DynamicTest> tests = new ArrayList<DynamicTest>();
        for (final String name : new String[] {"fail-to-build", "throw-in-start", "throw-in-execute", "requirement-clash"}) {
            tests.add(DynamicTest.dynamicTest(name, () -> {
                Case c = new Case(name, conformance(), name, "RED");
                Outcome solvers = solversLib(c);
                Outcome ivy = ivy(c);
                save(name, "solverslib", solvers);
                save(name, "ivy", ivy);
                assertNotNull(solvers.thrown, "SolversLib swallowed it; log " + solvers.log());
                assertNotNull(ivy.thrown, "Ivy swallowed it; log " + ivy.log());
                assertEquals(solvers.thrown.getMessage(), ivy.thrown.getMessage());
                assertEquals(String.join("\n", solvers.log()), String.join("\n", ivy.log()));
                assertFalse(ivy.routineStillScheduled, "Ivy's scheduler is empty after the OpMode stops");
                if (name.equals("fail-to-build")) {
                    assertTrue(ivy.thrown.getMessage().contains("step \"culprit\""), ivy.thrown.getMessage());
                    assertEquals(0, count(ivy.log(), "take {loops=2} start"), "a build failure is at init");
                }
            }));
        }
        return tests;
    }

    // ---------------------------------------------------------------------------------------------
    // The Java `zenith codegen` writes, against the routine the runtime builds from the file.
    // ---------------------------------------------------------------------------------------------

    /**
     * The build copies examples/starter/generated/{solverslib,ivy}/CycleAndParkGenerated.java into
     * packages of their own and compiles them with these tests. Each is run as a team would run it, as
     * a subclass that names the file and the robot, and must log the same events on the same loops and
     * write the same trace as both runtimes building the routine from the file. The world runs once
     * with {@code holdingPiece} true, so the branch scores again, and once with it never true, so the
     * empty else arm runs and the park starts from where the collect left the robot.
     */
    @TestFactory
    List<DynamicTest> theGeneratedStarterClassesBuildTheRoutineTheFileDoes() {
        List<DynamicTest> tests = new ArrayList<DynamicTest>();
        for (final String alliance : new String[] {"RED", "BLUE"}) {
            for (final boolean holding : new boolean[] {true, false}) {
                final String label = "generated cycle-and-park " + alliance
                        + (holding ? " holding" : " not holding");
                tests.add(DynamicTest.dynamicTest(label, () -> {
                    AutoSource starter = starter();
                    String name = "cycle-and-park";
                    Outcome solversFile = SolversLibRun.run(starter, name, alliance, world(holding), LOOPS);
                    Outcome solversGenerated = SolversLibRun.run(starter, name, alliance, world(holding), LOOPS,
                            SOLVERSLIB_GENERATED);
                    Outcome ivyFile = IvyRun.run(starter, name, alliance, world(holding), LOOPS);
                    Outcome ivyGenerated = IvyRun.run(starter, name, alliance, world(holding), LOOPS, IVY_GENERATED);
                    save(label, "solverslib-file", solversFile);
                    save(label, "solverslib-generated", solversGenerated);
                    save(label, "ivy-file", ivyFile);
                    save(label, "ivy-generated", ivyGenerated);
                    for (Outcome outcome : Arrays.asList(solversFile, solversGenerated, ivyFile, ivyGenerated)) {
                        assertNull(outcome.thrown, "a run threw; log " + outcome.log());
                    }
                    // The arm the world chose was the one that ran, so both cases prove what they claim.
                    List<String> log = solversFile.log();
                    assertEquals(holding ? 1 : 0, count(log, "step returnToScore start"), log.toString());
                    assertEquals(1, count(log, "step park end"), log.toString());
                    assertEquals(1, count(log, "routine finished"), log.toString());
                    String expected = String.join("\n", log);
                    assertEquals(expected, String.join("\n", solversGenerated.log()), "SolversLib, generated");
                    assertEquals(expected, String.join("\n", ivyFile.log()), "Ivy, from the file");
                    assertEquals(expected, String.join("\n", ivyGenerated.log()), "Ivy, generated");
                    String trace = solversFile.trace.render();
                    assertEquals(trace, solversGenerated.trace.render(), "SolversLib, generated");
                    assertEquals(trace, ivyFile.trace.render(), "Ivy, from the file");
                    assertEquals(trace, ivyGenerated.trace.render(), "Ivy, generated");
                }));
            }
        }
        return tests;
    }

    /** The generated SolversLib class, subclassed the way a team's OpMode subclasses it. */
    static final SolversLibRun.OpModeMaker SOLVERSLIB_GENERATED = (name, teamRobot) ->
            new org.horizon36596.zenith.examples.solverslib.CycleAndParkGenerated() {
                @Override
                protected String autoName() {
                    return name;
                }

                @Override
                protected org.horizon36596.zenith.solverslib.ZenithRobot createRobot() {
                    return teamRobot;
                }
            };

    /** The generated Ivy class, subclassed the same way. */
    static final IvyRun.OpModeMaker IVY_GENERATED = (name, teamRobot) ->
            new org.horizon36596.zenith.examples.ivy.CycleAndParkGenerated() {
                @Override
                protected String autoName() {
                    return name;
                }

                @Override
                protected org.horizon36596.zenith.ivy.ZenithRobot createRobot() {
                    return teamRobot;
                }
            };

    /**
     * The conformance world, with {@code holdingPiece} true from its usual loop or never. The hopper is
     * full from the first loop, so the garden sweep's end condition ends it where {@code toGarden} left
     * the robot, short of its planned end. Every later path from {@code "current"} then starts off the
     * plan, which is what shows a generated class building those paths from the live pose.
     */
    static World world(boolean holdingPiece) {
        World world = new World();
        world.hopperFullFrom = 0;
        if (!holdingPiece) {
            world.holdingPieceFrom = Integer.MAX_VALUE;
        }
        return world;
    }

    @Test
    void theIvyRuntimeIsDeterministic() {
        Case c = new Case("all-step-kinds", starter(), "all-step-kinds", "RED");
        Outcome first = ivy(c);
        Outcome second = ivy(c);
        assertEquals(first.log(), second.log());
        assertEquals(first.trace.render(), second.trace.render());
    }
}
