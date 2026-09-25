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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pedropathing.ivy.Scheduler;
import com.seattlesolvers.solverslib.command.CommandScheduler;
import com.seattlesolvers.solverslib.command.RunCommand;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.List;

/**
 * What each runtime does at start when a team command scheduled during init still holds the drive,
 * which the routine needs for its paths (site/docs/command-libraries.md, "A command left running from
 * init"). Both run {@code sequence-rules} on their real schedulers.
 *
 * <ul>
 *   <li>With each library's defaults (an Ivy priority of 0, a SolversLib command scheduled as
 *       interruptible) the routine interrupts the team command and runs, the same on both.</li>
 *   <li>An Ivy command at a higher priority blocks the routine. Ivy would drop it without a word; the
 *       Ivy runtime fails at start instead, naming the requirement.</li>
 *   <li>A SolversLib command scheduled as not interruptible blocks the routine too. SolversLib's
 *       scheduler would drop it without a word; the SolversLib runtime fails at start instead, naming
 *       the requirement and the command holding it.</li>
 * </ul>
 *
 * <p>Blocked, both runtimes fail the same way: an {@code IllegalStateException} at start, before any
 * step runs.</p>
 */
class StartBlockedTest {

    private static final int LOOPS = 60;

    @AfterEach
    void emptyTheSchedulers() {
        Scheduler.reset();
        CommandScheduler.getInstance().reset();
    }

    /** The Ivy runtime's OpMode, scheduling a never-ending command on the drive at the end of init. */
    private static IvyRun.OpModeMaker ivyHoldingTheDrive(final int priority) {
        return (name, teamRobot) -> new org.horizon36596.zenith.ivy.AutoFromFile() {
            @Override
            protected String autoName() {
                return name;
            }

            @Override
            protected org.horizon36596.zenith.ivy.ZenithRobot createRobot() {
                return teamRobot;
            }

            @Override
            public void initialize() {
                super.initialize();
                Scheduler.schedule(com.pedropathing.ivy.Command.build().requiring(drive()).setPriority(priority));
            }
        };
    }

    /** The SolversLib runtime's OpMode, scheduling a never-ending command on the drive at the end of init. */
    private static SolversLibRun.OpModeMaker solversLibHoldingTheDrive(final boolean interruptible) {
        return (name, teamRobot) -> new org.horizon36596.zenith.solverslib.AutoFromFile() {
            @Override
            protected String autoName() {
                return name;
            }

            @Override
            protected org.horizon36596.zenith.solverslib.ZenithRobot createRobot() {
                return teamRobot;
            }

            @Override
            public void initialize() {
                super.initialize();
                CommandScheduler.getInstance().schedule(interruptible, new RunCommand(() -> { }, drive()));
            }
        };
    }

    private static Outcome ivy(int priority) {
        return IvyRun.run(ConformanceTest.conformance(), "sequence-rules", "RED", new World(), LOOPS,
                ivyHoldingTheDrive(priority));
    }

    private static Outcome solversLib(boolean interruptible) {
        return SolversLibRun.run(ConformanceTest.conformance(), "sequence-rules", "RED", new World(), LOOPS,
                solversLibHoldingTheDrive(interruptible));
    }

    private static boolean anyStepStarted(List<String> log) {
        for (String line : log) {
            if (line.contains(" step ") && line.endsWith(" start")) {
                return true;
            }
        }
        return false;
    }

    @Test
    void withEachLibrarysDefaultsTheRoutineInterruptsTheCommandAndRunsTheSameOnBoth() {
        Outcome ivy = ivy(0);
        Outcome solvers = solversLib(true);
        assertNull(ivy.thrown, "Ivy threw; log " + ivy.log());
        assertNull(solvers.thrown, "SolversLib threw; log " + solvers.log());
        assertTrue(anyStepStarted(ivy.log()), ivy.log().toString());
        assertEquals(String.join("\n", solvers.log()), String.join("\n", ivy.log()));
    }

    @Test
    void aHigherPriorityIvyCommandFailsTheIvyOpModeAtStartAndNamesTheFollower() {
        Outcome ivy = ivy(1);
        assertTrue(ivy.thrown instanceof IllegalStateException, "Ivy threw " + ivy.thrown + "; log " + ivy.log());
        String message = ivy.thrown.getMessage();
        assertTrue(message.startsWith("Ivy's scheduler blocked the auto routine"), message);
        // The conformance robot keeps ZenithRobot's default drive(), which is the follower.
        assertTrue(message.contains("holds its requirement the follower ("), message);
        assertTrue(message.contains("above the routine's (0)"), message);
        assertFalse(anyStepStarted(ivy.log()), ivy.log().toString());
        assertFalse(ivy.routineStillScheduled);
    }

    @Test
    void aNonInterruptibleSolversLibCommandFailsTheSolversLibOpModeAtStartAndNamesTheDrive() {
        Outcome solvers = solversLib(false);
        assertTrue(solvers.thrown instanceof IllegalStateException,
                "SolversLib threw " + solvers.thrown + "; log " + solvers.log());
        String message = solvers.thrown.getMessage();
        assertTrue(message.startsWith("SolversLib's scheduler blocked the auto routine"), message);
        assertTrue(message.contains("holds its requirement drive() ("), message);
        assertTrue(message.contains(", held by RunCommand,"), message);
        assertTrue(message.contains("scheduled as not interruptible"), message);
        assertFalse(anyStepStarted(solvers.log()), solvers.log().toString());
    }

    @Test
    void whenBlockedBothRuntimesFailTheSameWay() {
        Outcome ivy = ivy(1);
        Outcome solvers = solversLib(false);
        assertTrue(ivy.thrown instanceof IllegalStateException, "Ivy threw " + ivy.thrown);
        assertTrue(solvers.thrown instanceof IllegalStateException, "SolversLib threw " + solvers.thrown);
        String tail = " blocked the auto routine instead of starting it, so ";
        assertTrue(ivy.thrown.getMessage().contains(tail), ivy.thrown.getMessage());
        assertTrue(solvers.thrown.getMessage().contains(tail), solvers.thrown.getMessage());
        // Neither ran a step: past each library's own explanation, the logs are the same.
        assertEquals(kindOnly(solvers.log()), kindOnly(ivy.log()));
        assertFalse(anyStepStarted(ivy.log()), ivy.log().toString());
    }

    /** A log with each thrown exception's message cut, leaving when it was thrown and its type. */
    private static String kindOnly(List<String> log) {
        StringBuilder out = new StringBuilder();
        for (String line : log) {
            int colon = line.indexOf(" threw ") < 0 ? -1 : line.indexOf(':', line.indexOf(" threw "));
            out.append(colon < 0 ? line : line.substring(0, colon)).append('\n');
        }
        return out.toString();
    }
}
