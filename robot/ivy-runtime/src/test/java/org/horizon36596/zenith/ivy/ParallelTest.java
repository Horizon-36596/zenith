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

package org.horizon36596.zenith.ivy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pedropathing.ivy.Command;
import com.pedropathing.ivy.behaviors.EndCondition;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * The Ivy runtime's groups: every member ended exactly once with the right condition, in a fixed order.
 * Every case of the SolversLib runtime's ParallelTest, plus what only Ivy has: priorities, suspension,
 * and the sequence group the Ivy side needs of its own.
 */
class ParallelTest {

    private FakeAuto robot;

    @BeforeEach
    void freshRobot() {
        robot = new FakeAuto();
        robot.registerCommands();
    }

    /** Logs its lifecycle into the robot's log, and is done after {@code loops} executes (never if -1). */
    private FakeAuto.Recorder recorder(final String name, final int loops) {
        return new FakeAuto.Recorder() {
            int executed;

            @Override
            public void start() {
                executed = 0;
                robot.log.add(name + " start");
            }

            @Override
            public void execute() {
                executed++;
            }

            @Override
            public boolean done() {
                return loops >= 0 && executed >= loops;
            }

            @Override
            public void end(EndCondition endCondition) {
                robot.log.add(name + " end(" + (endCondition == EndCondition.NATURALLY ? "false"
                        : endCondition == EndCondition.INTERRUPTED ? "true" : "suspended") + ")");
            }
        };
    }

    private int count(String event) {
        return Collections.frequency(robot.log, event);
    }

    @Test
    void aRaceEndsTheWinnerWithFalseAndTheLoserWithTrueOnceEach() {
        robot.run(Parallel.race(recorder("path", 3), recorder("timer", -1)), 20);
        assertEquals(Arrays.asList("path start", "timer start", "path end(false)", "timer end(true)"),
                robot.log);
    }

    @Test
    void aPathUnderATimeoutThatArrivesInTimeGetsEndFalse() {
        robot.run(RobotTimeout.of(robot.followPath(null, 1.0), 5.0, robot), 100);
        assertEquals(1, count("path0 end"), robot.log.toString());
        assertEquals(0, count("path0 interrupted"), robot.log.toString());
        assertEquals(3 * 20_000_000L, robot.nowNanos);
    }

    @Test
    void aPathCutOffByItsTimeoutGetsEndTrue() {
        robot.pathLoops = 1000;
        robot.run(RobotTimeout.of(robot.followPath(null, 1.0), 0.1, robot), 100);
        assertEquals(Arrays.asList("path0 start", "path0 interrupted"), robot.log);
    }

    @Test
    void aMarkerCommandStillRunningWhenItsPathArrivesIsInterrupted() {
        List<PathMarkers.Marker> markers = new ArrayList<PathMarkers.Marker>();
        markers.add(new PathMarkers.Marker(0.0, recorder("marker", -1)));
        Command path = PathMarkers.wrap(robot.followPath(null, 1.0), new double[] {10.0}, markers, robot);
        robot.run(RobotTimeout.of(path, 5.0, robot), 100);
        assertEquals(Arrays.asList("path0 start", "marker start", "path0 end", "marker end(true)"),
                robot.log);
    }

    @Test
    void aMarkerThatFinishesBeforeThePathIsEndedWithFalseAndOnlyOnce() {
        List<PathMarkers.Marker> markers = new ArrayList<PathMarkers.Marker>();
        markers.add(new PathMarkers.Marker(0.0, recorder("marker", 1)));
        Command path = PathMarkers.wrap(robot.followPath(null, 1.0), new double[] {10.0}, markers, robot);
        robot.run(path, 100);
        assertEquals(1, count("marker end(false)"), robot.log.toString());
        assertEquals(0, count("marker end(true)"), robot.log.toString());
    }

    @Test
    void deadlineMembersStartInTheOrderGivenEveryTime() {
        for (int attempt = 0; attempt < 50; attempt++) {
            robot.log.clear();
            Parallel group = Parallel.deadline(recorder("d", 2), recorder("a", -1), recorder("b", 1),
                    recorder("c", -1));
            robot.run(group, 20);
            // Each member once: Ivy's own deadline group would end a and c a second time here.
            assertEquals(Arrays.asList("d start", "a start", "b start", "c start",
                    "b end(false)", "d end(false)", "a end(true)", "c end(true)"), robot.log);
        }
    }

    @Test
    void anInterruptedGroupEndsOnlyTheMembersStillRunning() {
        Parallel group = Parallel.all(recorder("quick", 1), recorder("slow", -1));
        group.start();
        group.execute();
        group.execute();
        group.end(EndCondition.INTERRUPTED);
        assertEquals(Arrays.asList("quick start", "slow start", "quick end(false)", "slow end(true)"),
                robot.log);
    }

    @Test
    void allWaitsForEveryMember() {
        robot.run(Parallel.all(recorder("one", 1), recorder("three", 3)), 20);
        assertEquals(Arrays.asList("one start", "three start", "one end(false)", "three end(false)"),
                robot.log);
        assertEquals(3 * 20_000_000L, robot.nowNanos);
    }

    @Test
    void membersThatShareARequirementAreRefusedAtConstruction() {
        FakeAuto.Recorder first = recorder("first", 1).require(FakeAuto.INTAKE);
        FakeAuto.Recorder second = recorder("second", 1).require(FakeAuto.INTAKE);
        IllegalArgumentException problem = assertThrows(IllegalArgumentException.class,
                () -> Parallel.all(first, second));
        assertTrue(problem.getMessage().contains("same subsystems"), problem.getMessage());
    }

    @Test
    void theSameCommandTwiceIsRefused() {
        FakeAuto.Recorder once = recorder("once", 1);
        assertThrows(IllegalArgumentException.class, () -> Parallel.all(once, once));
        assertThrows(IllegalArgumentException.class, () -> new Sequence(once, once));
    }

    @Test
    void aGroupTakesTheUnionOfRequirementsAndTheHighestPriority() {
        FakeAuto.Recorder low = recorder("low", 1).require(FakeAuto.INTAKE);
        FakeAuto.Recorder high = new FakeAuto.Recorder() {
            @Override
            public int priority() {
                return 3;
            }
        }.require(FakeAuto.DRIVE);
        Parallel group = Parallel.all(low, high);
        assertEquals(new java.util.LinkedHashSet<Object>(Arrays.asList(FakeAuto.INTAKE, FakeAuto.DRIVE)),
                group.requirements());
        assertEquals(3, group.priority());
    }

    @Test
    void aSuspendedGroupPassesItOnAndKeepsItsPlace() {
        Parallel group = Parallel.all(recorder("quick", 1), recorder("slow", 3));
        group.start();
        group.execute();
        group.end(EndCondition.SUSPENDED);
        group.execute();
        group.execute();
        assertEquals(Arrays.asList("quick start", "slow start", "quick end(false)", "slow end(suspended)",
                "slow end(false)"), robot.log);
        assertTrue(group.done());
    }

    @Test
    void aSequenceEndsOnlyItsCurrentMemberWhenInterrupted() {
        Sequence sequence = new Sequence(recorder("one", 1), recorder("two", -1), recorder("three", 1));
        sequence.start();
        sequence.execute();
        sequence.execute();
        sequence.end(EndCondition.INTERRUPTED);
        // "three" never started, so it is never ended; Ivy's own sequential group would end it.
        assertEquals(Arrays.asList("one start", "one end(false)", "two start", "two end(true)"), robot.log);
    }

    @Test
    void aSequenceStartsTheNextMemberOnTheLoopThePreviousOneFinishes() {
        robot.run(new Sequence(recorder("one", 1), recorder("two", 1)), 20);
        assertEquals(Arrays.asList("one start", "one end(false)", "two start", "two end(false)"), robot.log);
        // One execute each, the second on the loop after the first: the SolversLib group's timing.
        assertEquals(2 * 20_000_000L, robot.nowNanos);
    }

    @Test
    void aBranchExecutesAnArmThatIsDoneAsSoonAsItStarts() {
        final int[] executed = {0};
        Command instant = new FakeAuto.Recorder() {
            @Override
            public void execute() {
                executed[0]++;
            }

            @Override
            public boolean done() {
                return true;
            }
        };
        Command branch = Forward.branch(() -> true, instant, recorder("never", 1));
        robot.run(new Sequence(branch), 10);
        // SolversLib's ConditionalCommand executes it once; Ivy's Commands.conditional would not.
        assertEquals(1, executed[0]);
        assertEquals(0, count("never start"));
    }
}
