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


package org.horizon36596.zenith.solverslib;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.seattlesolvers.solverslib.command.Command;
import com.seattlesolvers.solverslib.command.CommandBase;
import com.seattlesolvers.solverslib.command.CommandGroupBase;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * The runtime's parallel groups: every member ended exactly once with the right flag, in a fixed order.
 * SolversLib 0.3.6's own groups fail the first three of these; see {@link Parallel}.
 */
class ParallelTest {

    private FakeAuto robot;

    @BeforeEach
    void freshRobot() {
        CommandGroupBase.clearGroupedCommands();
        robot = new FakeAuto();
        robot.registerCommands();
    }

    /** Logs its lifecycle into the robot's log, and finishes after {@code loops} executes (never if -1). */
    private CommandBase recorder(final String name, final int loops) {
        return new CommandBase() {
            int executed;

            @Override
            public void initialize() {
                executed = 0;
                robot.log.add(name + " start");
            }

            @Override
            public void execute() {
                executed++;
            }

            @Override
            public boolean isFinished() {
                return loops >= 0 && executed >= loops;
            }

            @Override
            public void end(boolean interrupted) {
                robot.log.add(name + " end(" + interrupted + ")");
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
        // Three loops of path, not five seconds of timer.
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
        // The marker sits at the start of the path, so it starts at once and never finishes by itself.
        List<PathMarkers.Marker> markers = new ArrayList<PathMarkers.Marker>();
        markers.add(new PathMarkers.Marker(0.0, recorder("marker", -1)));
        Command path = PathMarkers.wrap(robot.followPath(null, 1.0), new double[] {10.0}, markers, robot);

        // Under a step timeout: the case SolversLib's race group gets wrong, because the member that
        // finished (the whole marker group) is never ended, so neither is the marker.
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
        // Identity hash codes differ from one set of objects to the next, which is what made
        // SolversLib's HashMap order vary; fifty fresh groups would show it.
        for (int attempt = 0; attempt < 50; attempt++) {
            robot.log.clear();
            Parallel group = Parallel.deadline(recorder("d", 2), recorder("a", -1), recorder("b", 1),
                    recorder("c", -1));
            robot.run(group, 20);
            assertEquals(Arrays.asList("d start", "a start", "b start", "c start",
                    "b end(false)", "d end(false)", "a end(true)", "c end(true)"), robot.log);
        }
    }

    @Test
    void anInterruptedGroupEndsOnlyTheMembersStillRunning() {
        Parallel group = Parallel.all(recorder("quick", 1), recorder("slow", -1));
        group.initialize();
        group.execute();
        group.execute();
        group.end(true);
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
    void membersThatShareASubsystemAreRefusedAtConstruction() {
        CommandBase first = recorder("first", 1);
        CommandBase second = recorder("second", 1);
        first.addRequirements(FakeAuto.INTAKE);
        second.addRequirements(FakeAuto.INTAKE);
        IllegalArgumentException problem = assertThrows(IllegalArgumentException.class,
                () -> Parallel.all(first, second));
        assertTrue(problem.getMessage().contains("same subsystems"), problem.getMessage());
    }
}
