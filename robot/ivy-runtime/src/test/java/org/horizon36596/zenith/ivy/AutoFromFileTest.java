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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pedropathing.follower.Follower;
import com.pedropathing.ivy.Command;
import com.pedropathing.ivy.CommandBuilder;
import com.pedropathing.ivy.Scheduler;
import com.pedropathing.ivy.behaviors.BlockedBehavior;
import com.pedropathing.ivy.behaviors.EndCondition;
import com.pedropathing.ivy.commands.Commands;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;

import org.firstinspires.ftc.robotcore.external.Telemetry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** The OpMode half on Ivy: what a generated stub runs, with a team robot that has no hardware. */
class AutoFromFileTest {

    /** The smallest Ivy ZenithRobot a team could write, recording what the runtime asked of it. */
    static class TestRobot implements ZenithRobot {
        final FakeAuto parts = new FakeAuto();
        final List<String> calls = new ArrayList<String>();
        String alliance = "RED";
        Pose startPose;
        /** A team command the robot schedules during init, as a team's own init code might. */
        Command scheduledAtInit;

        @Override
        public void init(AutoFromFile opMode) {
            calls.add("init");
            if (scheduledAtInit != null) {
                Scheduler.schedule(scheduledAtInit);
            }
        }

        @Override
        public void registerCommands(AutoFromFile opMode) {
            calls.add("registerCommands");
            parts.registerCommands();
        }

        @Override
        public Follower follower() {
            return parts.follower();
        }

        @Override
        public Object drive() {
            return FakeAuto.DRIVE;
        }

        @Override
        public String runningAlliance() {
            return alliance;
        }

        @Override
        public Pose mirror(Pose pose) {
            return new Pose(-pose.x(), -pose.y(), pose.heading() + Math.PI);
        }

        @Override
        public void setStartPose(Pose pose) {
            startPose = pose;
        }

        @Override
        public void periodic(AutoFromFile opMode) {
            calls.add("periodic");
        }

        /** The fake follower drives nothing, so paths are the fake robot's recording commands. */
        @Override
        public Command followPath(Path path, double speedFraction) {
            return parts.followPath(path, speedFraction);
        }
    }

    /** What zenith deploy writes, plus the test's source and robot. */
    static class DemoAuto extends AutoFromFile {
        final TestRobot testRobot = new TestRobot();

        DemoAuto() {
            setAutoSource(FakeAuto.fixtures());
        }

        @Override
        protected String autoName() {
            return "demo";
        }

        @Override
        protected ZenithRobot createRobot() {
            return testRobot;
        }
    }

    @AfterEach
    void emptyTheScheduler() {
        Scheduler.reset();
    }

    /** Swaps the OpMode's telemetry for one that keeps each {@code addData} as "caption: value". */
    static List<String> recordTelemetry(AutoFromFile auto) {
        final List<String> lines = new ArrayList<String>();
        auto.telemetry = (Telemetry) Proxy.newProxyInstance(Telemetry.class.getClassLoader(),
                new Class<?>[] {Telemetry.class}, (proxy, method, args) -> {
                    if ("addData".equals(method.getName()) && args != null && args.length == 2) {
                        lines.add(args[0] + ": " + args[1]);
                    }
                    Class<?> type = method.getReturnType();
                    if (type == boolean.class) {
                        return false;
                    }
                    if (type == int.class) {
                        return 0;
                    }
                    return null;
                });
        return lines;
    }

    /** A team command that never ends, requiring the drive at {@code priority}, logging how it ends. */
    static CommandBuilder heldDrive(int priority, final List<String> ends) {
        return Commands.waitUntil(() -> false)
                .requiring(FakeAuto.DRIVE)
                .setPriority(priority)
                .setEnd(condition -> ends.add(condition.name()));
    }

    @Test
    void aRoutineBlockedByAHigherPriorityCommandFromInitFailsAtStartAndNamesTheRequirement() {
        List<String> ends = new ArrayList<String>();
        DemoAuto auto = new DemoAuto();
        Command blocker = heldDrive(5, ends);
        auto.testRobot.scheduledAtInit = blocker;
        List<String> telemetry = recordTelemetry(auto);
        auto.initialize();
        assertTrue(auto.routine().requirements().contains(FakeAuto.DRIVE));
        assertEquals(0, auto.routine().priority());

        IllegalStateException problem = assertThrows(IllegalStateException.class, auto::startRoutine);
        String message = problem.getMessage();
        assertTrue(message.startsWith("Ivy's scheduler blocked the auto routine instead of starting it"), message);
        assertTrue(message.contains("holds its requirement drive() (" + FakeAuto.DRIVE + ")"), message);
        assertTrue(message.contains("at a priority above the routine's (0)"), message);
        assertFalse(message.contains(String.valueOf(FakeAuto.INTAKE)), "only the held requirement is named: " + message);
        assertEquals(Arrays.asList("Zenith: " + message), telemetry);

        // Nothing was started, and the check disturbed nothing: the team command still runs, and the
        // free requirement the check tried is free again.
        assertFalse(Scheduler.isScheduled(auto.routine()));
        assertTrue(Scheduler.isRunning(blocker));
        assertEquals(Arrays.<String>asList(), ends);
        Command intake = Commands.waitUntil(() -> false).requiring(FakeAuto.INTAKE).setPriority(Integer.MIN_VALUE);
        Scheduler.schedule(intake);
        assertTrue(Scheduler.isRunning(intake));
    }

    @Test
    void aRoutineInterruptsACommandFromInitThatHoldsItsRequirementAtItsPriorityOrBelow() {
        for (int priority : new int[] {0, -3}) {
            Scheduler.reset();
            List<String> ends = new ArrayList<String>();
            DemoAuto auto = new DemoAuto();
            Command teamCommand = heldDrive(priority, ends);
            auto.testRobot.scheduledAtInit = teamCommand;
            List<String> telemetry = recordTelemetry(auto);
            auto.initialize();
            assertTrue(Scheduler.isRunning(teamCommand));

            auto.startRoutine();
            assertTrue(Scheduler.isRunning(auto.routine()), "priority " + priority);
            assertFalse(Scheduler.isScheduled(teamCommand), "priority " + priority);
            assertEquals(Arrays.asList(EndCondition.INTERRUPTED.name()), ends, "priority " + priority);
            assertEquals(Arrays.<String>asList(), telemetry);
        }
    }

    @Test
    void aRoutineQueuedBehindACommandFromInitFailsAtStartToo() {
        List<String> ends = new ArrayList<String>();
        DemoAuto auto = new DemoAuto() {
            @Override
            protected Command buildRoutine() {
                return Commands.waitUntil(() -> false).requiring(FakeAuto.DRIVE)
                        .setBlockedBehavior(BlockedBehavior.QUEUE);
            }
        };
        auto.testRobot.scheduledAtInit = heldDrive(1, ends);
        recordTelemetry(auto);
        auto.initialize();
        IllegalStateException problem = assertThrows(IllegalStateException.class, auto::startRoutine);
        assertTrue(problem.getMessage().startsWith("Ivy's scheduler queued the auto routine"), problem.getMessage());
        assertTrue(problem.getMessage().contains("QUEUE"), problem.getMessage());
        auto.reset();
        assertFalse(Scheduler.isScheduled(auto.routine()), "stop empties the queue too");
    }

    @Test
    void initReadsTheFileBuildsTheRobotAndTheRoutineInThatOrder() {
        DemoAuto auto = new DemoAuto();
        auto.initialize();
        assertEquals("demo", auto.spec().name);
        assertEquals(Arrays.asList("init", "registerCommands"), auto.testRobot.calls);
        assertNotNull(auto.routine());
        assertEquals(-60.0, auto.testRobot.startPose.x());
    }

    @Test
    void mirrorsOnlyWhenTheSelectedAllianceIsNotTheFiles() {
        DemoAuto auto = new DemoAuto();
        auto.testRobot.alliance = "BLUE";
        auto.initialize();
        assertEquals(60.0, auto.testRobot.startPose.x());
        assertEquals(36.0, auto.testRobot.startPose.y());
    }

    @Test
    void anUnregisteredNameFailsAtInitNotAtTheWhistle() {
        DemoAuto auto = new DemoAuto() {
            @Override
            protected ZenithRobot createRobot() {
                return new TestRobot() {
                    @Override
                    public void registerCommands(AutoFromFile opMode) {
                        NamedCommands.register("intakeOn", (args, ctx) -> parts.instant("intakeOn", FakeAuto.INTAKE));
                    }
                };
            }
        };
        IllegalArgumentException problem = assertThrows(IllegalArgumentException.class, auto::initialize);
        assertTrue(problem.getMessage().contains("step \"score\""), problem.getMessage());
    }

    @Test
    void initEmptiesTheSchedulerLeftFromTheLastOpMode() {
        Command leftOver = Commands.waitUntil(() -> false).requiring(FakeAuto.DRIVE);
        Scheduler.schedule(leftOver);
        assertTrue(Scheduler.isScheduled(leftOver));
        new DemoAuto().initialize();
        assertFalse(Scheduler.isScheduled(leftOver));
    }

    @Test
    void startSchedulesTheRoutineAndStopEmptiesTheScheduler() {
        DemoAuto auto = new DemoAuto();
        auto.initialize();
        auto.startRoutine();
        assertTrue(Scheduler.isScheduled(auto.routine()));
        auto.reset();
        assertFalse(Scheduler.isScheduled(auto.routine()));
    }

    @Test
    void periodicRunsBeforeTheSchedulerOnEveryLoop() {
        DemoAuto auto = new DemoAuto() {
            @Override
            protected Command buildRoutine() {
                return Commands.infinite(() -> testRobot.calls.add("execute"));
            }
        };
        auto.initialize();
        auto.startRoutine();
        for (int i = 0; i < 3; i++) {
            auto.run();
        }
        assertEquals(Arrays.asList("init", "registerCommands", "periodic", "execute", "periodic", "execute",
                "periodic", "execute"), auto.testRobot.calls);
    }
}
