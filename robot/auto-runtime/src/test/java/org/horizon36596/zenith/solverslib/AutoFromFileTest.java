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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pedropathing.follower.Follower;
import com.seattlesolvers.solverslib.command.Command;
import com.seattlesolvers.solverslib.command.CommandGroupBase;
import com.seattlesolvers.solverslib.command.CommandScheduler;
import com.seattlesolvers.solverslib.command.RunCommand;
import com.seattlesolvers.solverslib.command.Subsystem;
import com.seattlesolvers.solverslib.geometry.Pose2d;
import com.seattlesolvers.solverslib.geometry.Rotation2d;

import org.firstinspires.ftc.robotcore.external.Telemetry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** The OpMode half: what a generated stub runs at init, with a team robot that has no hardware. */
class AutoFromFileTest {

    /** The smallest ZenithRobot a team could write, recording what the runtime asked of it. */
    static class TestRobot implements ZenithRobot {
        final FakeAuto parts = new FakeAuto();
        final List<String> calls = new ArrayList<String>();
        String alliance = "RED";
        Pose2d startPose;
        /** A team command to schedule during init, as a robot that holds its drive until start might. */
        Command scheduledAtInit;
        boolean interruptibleAtInit = true;

        @Override
        public void init(AutoFromFile opMode) {
            calls.add("init");
            if (scheduledAtInit != null) {
                CommandScheduler.getInstance().schedule(interruptibleAtInit, scheduledAtInit);
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
        public Subsystem drive() {
            return FakeAuto.DRIVE;
        }

        @Override
        public String runningAlliance() {
            return alliance;
        }

        @Override
        public Pose2d mirror(Pose2d pose) {
            return new Pose2d(-pose.getX(), -pose.getY(), new Rotation2d(pose.getHeading() + Math.PI));
        }

        @Override
        public void setStartPose(Pose2d pose) {
            startPose = pose;
        }
    }

    /** What zenith deploy writes, plus the test's source and robot. */
    static class DemoAuto extends AutoFromFile {
        final TestRobot testRobot = new TestRobot();

        @Override
        protected String autoName() {
            return "demo";
        }

        @Override
        protected ZenithRobot createRobot() {
            return testRobot;
        }
    }

    @BeforeEach
    void clearGroups() {
        CommandGroupBase.clearGroupedCommands();
    }

    @AfterEach
    void emptyTheScheduler() {
        CommandScheduler.getInstance().enable();
        CommandScheduler.getInstance().reset();
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

    @Test
    void initReadsTheFileBuildsTheRobotAndTheRoutineInThatOrder() {
        DemoAuto auto = new DemoAuto();
        auto.setAutoSource(FakeAuto.fixtures());
        auto.initialize();
        assertEquals("demo", auto.spec().name);
        assertEquals(java.util.Arrays.asList("init", "registerCommands"), auto.testRobot.calls);
        assertNotNull(auto.routine());
        assertEquals(-60.0, auto.testRobot.startPose.getX());
    }

    @Test
    void mirrorsOnlyWhenTheSelectedAllianceIsNotTheFiles() {
        DemoAuto auto = new DemoAuto();
        auto.testRobot.alliance = "BLUE";
        auto.setAutoSource(FakeAuto.fixtures());
        auto.initialize();
        assertEquals(60.0, auto.testRobot.startPose.getX());
        assertEquals(36.0, auto.testRobot.startPose.getY());
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
        auto.setAutoSource(FakeAuto.fixtures());
        IllegalArgumentException problem = assertThrows(IllegalArgumentException.class, auto::initialize);
        assertTrue(problem.getMessage().contains("step \"score\""), problem.getMessage());
    }

    @Test
    void aRoutineBlockedByANonInterruptibleCommandFromInitFailsAtStartAndNamesTheRequirement() {
        DemoAuto auto = new DemoAuto();
        Command blocker = new RunCommand(() -> { }, FakeAuto.DRIVE);
        auto.testRobot.scheduledAtInit = blocker;
        auto.testRobot.interruptibleAtInit = false;
        List<String> telemetry = recordTelemetry(auto);
        auto.setAutoSource(FakeAuto.fixtures());
        auto.initialize();
        assertTrue(auto.routine().getRequirements().contains(FakeAuto.DRIVE));

        IllegalStateException problem = assertThrows(IllegalStateException.class, auto::startRoutine);
        String message = problem.getMessage();
        assertTrue(message.startsWith("SolversLib's scheduler blocked the auto routine instead of starting it"),
                message);
        assertTrue(message.contains("holds its requirement drive() (" + FakeAuto.DRIVE + "), held by RunCommand,"),
                message);
        assertTrue(message.contains("scheduled as not interruptible"), message);
        assertFalse(message.contains(String.valueOf(FakeAuto.INTAKE)), "only the held requirement is named: " + message);
        assertEquals(Arrays.asList("Zenith: " + message), telemetry);

        // Nothing was started, and the check disturbed nothing: the team command still runs.
        assertFalse(CommandScheduler.getInstance().isScheduled(auto.routine()));
        assertTrue(CommandScheduler.getInstance().isScheduled(blocker));
    }

    @Test
    void aRoutineInterruptsAnInterruptibleCommandFromInitThatHoldsItsRequirement() {
        // A routine that only requires the drive: the demo file's paths would start FakeAuto's follower,
        // which has no path algorithm.
        DemoAuto auto = new DemoAuto() {
            @Override
            protected Command buildRoutine() {
                return new RunCommand(() -> { }, FakeAuto.DRIVE);
            }
        };
        Command teamCommand = new RunCommand(() -> { }, FakeAuto.DRIVE);
        auto.testRobot.scheduledAtInit = teamCommand;
        List<String> telemetry = recordTelemetry(auto);
        auto.setAutoSource(FakeAuto.fixtures());
        auto.initialize();
        assertTrue(CommandScheduler.getInstance().isScheduled(teamCommand));

        auto.startRoutine();
        assertTrue(CommandScheduler.getInstance().isScheduled(auto.routine()));
        assertFalse(CommandScheduler.getInstance().isScheduled(teamCommand));
        assertEquals(Arrays.<String>asList(), telemetry);
    }

    @Test
    void aDisabledSchedulerFailsAtStartTooAndSaysSo() {
        DemoAuto auto = new DemoAuto();
        recordTelemetry(auto);
        auto.setAutoSource(FakeAuto.fixtures());
        auto.initialize();
        CommandScheduler.getInstance().disable();
        IllegalStateException problem = assertThrows(IllegalStateException.class, auto::startRoutine);
        assertTrue(problem.getMessage().startsWith("SolversLib's scheduler did not schedule the auto routine"),
                problem.getMessage());
        assertTrue(problem.getMessage().contains("CommandScheduler.disable()"), problem.getMessage());
    }
}
