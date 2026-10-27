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
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.seattlesolvers.solverslib.command.Command;
import com.seattlesolvers.solverslib.command.CommandGroupBase;
import com.seattlesolvers.solverslib.command.CommandScheduler;
import com.seattlesolvers.solverslib.command.RunCommand;

import org.horizon36596.zenith.AutoSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * The team's own code around the routine (issue #532): {@code onStart}, {@code periodic},
 * {@code afterLoop} and {@code onStop}, and an auto whose routine is an exported class rather than a file
 * (issue #535). The OpMode is driven the way its {@code runOpMode} drives it, minus the Driver Station.
 */
class LifecycleHooksTest {

    /** A robot that records every hook, and can fail where a test asks it to. */
    static class HookRobot extends AutoFromFileTest.TestRobot {
        boolean failInit;
        RuntimeException stopProblem;

        @Override
        public void init(AutoFromFile opMode) {
            super.init(opMode);
            if (failInit) {
                throw new IllegalStateException("the robot's init failed");
            }
        }

        @Override
        public void onStart(AutoFromFile opMode) {
            calls.add("onStart");
        }

        @Override
        public void periodic(AutoFromFile opMode) {
            calls.add("periodic");
        }

        @Override
        public void afterLoop(AutoFromFile opMode) {
            calls.add("afterLoop");
        }

        @Override
        public void onStop(AutoFromFile opMode) {
            calls.add("onStop");
            if (stopProblem != null) {
                throw stopProblem;
            }
        }
    }

    /** The demo file, run by {@link HookRobot}, with a routine that only records each loop. */
    static class HookAuto extends AutoFromFile {
        final HookRobot hookRobot = new HookRobot();
        String name = "demo";

        HookAuto() {
            setAutoSource(FakeAuto.fixtures());
        }

        @Override
        protected String autoName() {
            return name;
        }

        @Override
        protected ZenithRobot createRobot() {
            return hookRobot;
        }

        @Override
        protected Command buildRoutine() {
            return new RunCommand(() -> hookRobot.calls.add("routine"), FakeAuto.DRIVE);
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

    @Test
    void theHooksRunInOrderAroundTheRoutine() {
        HookAuto auto = new HookAuto();
        auto.initialize();
        auto.startRoutine();
        auto.run();
        auto.run();
        auto.end();
        auto.reset();
        assertEquals(Arrays.asList("init", "registerCommands", "onStart", "periodic", "routine", "afterLoop",
                "periodic", "routine", "afterLoop", "onStop"), auto.hookRobot.calls);
    }

    @Test
    void onStopRunsOnceHoweverOftenTheOpModeResets() {
        HookAuto auto = new HookAuto();
        auto.initialize();
        auto.reset();
        auto.reset();
        assertEquals(1, Collections.frequency(auto.hookRobot.calls, "onStop"));
    }

    @Test
    void onStopRunsAfterAFailureAtInitOnceTheRobotExists() {
        HookAuto auto = new HookAuto();
        auto.hookRobot.failInit = true;
        assertThrows(IllegalStateException.class, auto::initialize);
        auto.reset();
        assertEquals(Arrays.asList("init", "onStop"), auto.hookRobot.calls);
    }

    @Test
    void onStopRunsAfterAFailureAtStart() {
        HookAuto auto = new HookAuto();
        auto.initialize();
        CommandScheduler.getInstance().disable();
        assertThrows(IllegalStateException.class, auto::startRoutine);
        auto.reset();
        assertEquals(Arrays.asList("init", "registerCommands", "onStart", "onStop"), auto.hookRobot.calls);
    }

    @Test
    void noRobotMeansNoOnStop() {
        HookAuto auto = new HookAuto();
        auto.name = "no-such-auto";
        assertThrows(IllegalStateException.class, auto::initialize);
        auto.reset();
        assertEquals(Collections.<String>emptyList(), auto.hookRobot.calls);
    }

    @Test
    void theSchedulerIsResetEvenWhenOnStopThrows() {
        HookAuto auto = new HookAuto();
        auto.initialize();
        auto.startRoutine();
        assertTrue(CommandScheduler.getInstance().isScheduled(auto.routine()));
        IllegalStateException problem = new IllegalStateException("the log would not close");
        auto.hookRobot.stopProblem = problem;
        assertSame(problem, assertThrows(IllegalStateException.class, auto::reset));
        assertFalse(CommandScheduler.getInstance().isScheduled(auto.routine()));
    }

    // ---------------------------------------------------------------------------------------------
    // An exported class: the routine is Java, and no file is read (issue #535)
    // ---------------------------------------------------------------------------------------------

    /** A source that fails the test if anything is read from it. */
    static final AutoSource NOTHING_TO_READ = new AutoSource() {
        @Override
        public InputStream open(String fileName) {
            throw new AssertionError("an exported class read " + fileName);
        }

        @Override
        public String describe() {
            return "nowhere";
        }
    };

    /** What {@code zenith codegen --export} writes, cut down to the parts the runtime reads. */
    static class ExportedAuto extends HookAuto {
        ExportedAuto() {
            setAutoSource(NOTHING_TO_READ);
        }

        @Override
        protected AutoSpec loadSpec() {
            return AutoSpec.inCode("exported", "Exported auto", "RED", -12.0, -63.0, 1.5708, 0.4);
        }
    }

    @Test
    void anExportedClassReadsNoFileAndTakesItsStartAndSpeedFromCode() {
        ExportedAuto auto = new ExportedAuto();
        List<String> telemetry = AutoFromFileTest.recordTelemetry(auto);
        auto.initialize();
        assertEquals(0.4, auto.defaultSpeedFraction(), 1e-12);
        assertEquals(-12.0, auto.hookRobot.startPose.getX(), 1e-12);
        assertEquals(-63.0, auto.hookRobot.startPose.getY(), 1e-12);
        assertEquals(1.5708, auto.hookRobot.startPose.getHeading(), 1e-12);
        assertTrue(auto.spec().steps.isEmpty());

        auto.initialize_loop();
        assertEquals(Arrays.asList("Auto class: ExportedAuto (Exported auto), exported from Zenith"), telemetry);
    }

    @Test
    void anExportedClassMirrorsLikeAFileForTheOtherAlliance() {
        ExportedAuto auto = new ExportedAuto();
        auto.hookRobot.alliance = "BLUE";
        auto.initialize();
        assertEquals(12.0, auto.hookRobot.startPose.getX(), 1e-12);
        assertEquals(63.0, auto.hookRobot.startPose.getY(), 1e-12);
    }

    @Test
    void anAutoInCodeRefusesAnAllianceOrSpeedTheRuntimeCannotUse() {
        IllegalArgumentException alliance = assertThrows(IllegalArgumentException.class,
                () -> AutoSpec.inCode("exported", "Exported", "GREEN", 0, 0, 0, 1.0));
        assertTrue(alliance.getMessage().contains("\"GREEN\""), alliance.getMessage());
        assertThrows(IllegalArgumentException.class, () -> AutoSpec.inCode("exported", "Exported", "RED", 0, 0, 0, 0));
        assertThrows(IllegalArgumentException.class, () -> AutoSpec.inCode("exported", "Exported", "RED", 0, 0, 0, 1.5));
        assertThrows(IllegalArgumentException.class, () -> AutoSpec.inCode("", "Exported", "RED", 0, 0, 0, 1.0));
    }
}
