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

import com.pedropathing.follower.Follower;
import com.pedropathing.ivy.Command;
import com.pedropathing.ivy.Scheduler;
import com.pedropathing.ivy.behaviors.BlockedBehavior;
import com.pedropathing.ivy.behaviors.ConflictBehavior;
import com.pedropathing.ivy.behaviors.EndCondition;
import com.pedropathing.ivy.behaviors.InterruptedBehavior;
import com.pedropathing.math.Pose;

import org.horizon36596.zenith.AutoFile;
import org.horizon36596.zenith.ivy.AutoBuilder;
import org.horizon36596.zenith.ivy.AutoContext;
import org.horizon36596.zenith.ivy.NamedCommands;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.List;
import java.util.Set;

/**
 * What the robot runtime page says about suspension on Ivy: a suspended routine holds its running path,
 * and because Ivy does not call {@code start()} again on resume, that path ends on the next loop and the
 * routine goes on from the next step. The path's markers that the robot had not reached when it was
 * suspended do not fire.
 */
class IvySuspensionTest {

    @AfterEach
    void emptyTheScheduler() {
        Scheduler.reset();
    }

    @Test
    void aSuspendedPathHoldsAndEndsWhenTheRoutineResumes() {
        List<String> log = runSuspendedOn(5);
        assertTrue(log.contains("5 step markers suspended"), log.toString());
        assertTrue(log.stream().anyMatch(line -> line.startsWith("5 hold ")), log.toString());
        int resumed = ConformanceTest.loopOf(log, "intruder end");
        assertEquals(resumed + 1, ConformanceTest.loopOf(log, "step markers end"),
                "the held path is done on the first loop after the routine resumes");
        assertEquals(resumed + 1, ConformanceTest.loopOf(log, "step timeoutFires start"));
        assertEquals(1, ConformanceTest.count(log, "step markers start"), "the path is not started again");

        // The markers passed before the suspension ran; the ones still ahead of the robot do not all
        // fire at once where it was left when the routine resumes.
        assertEquals(1, ConformanceTest.count(log, "instant {at=t0} start"));
        assertEquals(1, ConformanceTest.count(log, "instant {at=4in} start"));
        assertEquals(0, ConformanceTest.count(log, "take {at=t0.5, loops=2} start"), log.toString());
        assertEquals(0, ConformanceTest.count(log, "instant {at=6in from end} start"), log.toString());
        assertEquals(0, ConformanceTest.count(log, "instant {at=t1} start"), log.toString());
    }

    @Test
    void aMarkerRunningWhenThePathIsSuspendedResumesAndEndsOnce() {
        // The t=0.5 marker starts on loop 13 and would end on loop 14; the routine is suspended on 14.
        List<String> log = runSuspendedOn(14);
        String marker = "take {at=t0.5, loops=2}";
        assertTrue(log.contains("13 " + marker + " start"), log.toString());
        assertTrue(log.contains("14 " + marker + " suspended"), log.toString());
        assertEquals(1, ConformanceTest.count(log, marker + " start"), "the marker is not started again");
        // The path runs first on the resume loop and is done; the runner then runs the marker, which
        // finishes its second loop and ends on its own, before the group ends.
        int resumed = ConformanceTest.loopOf(log, "intruder end");
        assertTrue(log.contains((resumed + 1) + " " + marker + " execute 2"), log.toString());
        assertTrue(log.contains((resumed + 1) + " " + marker + " end"), log.toString());
        assertEquals(0, ConformanceTest.count(log, marker + " interrupted"), log.toString());
        assertEquals(resumed + 1, ConformanceTest.loopOf(log, "step markers end"));
        assertEquals(0, ConformanceTest.count(log, "instant {at=6in from end} start"), log.toString());
        assertEquals(0, ConformanceTest.count(log, "instant {at=t1} start"), log.toString());
    }

    /**
     * Runs sequence-rules as a suspendable routine, and on loop {@code loop} schedules an intruder that
     * requires the drivetrain for three loops at a higher priority.
     */
    private static List<String> runSuspendedOn(int loop) {
        final World world = new World();
        final Object drive = new Object();
        AutoContext ctx = new AutoContext() {
            @Override
            public Follower follower() {
                return world.follower;
            }

            @Override
            public Object drive() {
                return drive;
            }

            @Override
            public Pose alliance(Pose filePose) {
                return filePose;
            }

            @Override
            public long nanoTime() {
                return world.nanoTime();
            }

            @Override
            public Command step(String id, Command body) {
                return IvyRun.logged(world, id, body);
            }
        };
        NamedCommands.reset();
        IvyRun.register(world, Collections.<String, Object>emptyMap());
        AutoFile file = AutoFile.loadForInit(ConformanceTest.conformance(), "sequence-rules");
        Command routine = suspending(AutoBuilder.build(file, ctx), 0);
        Command intruder = suspending(Commands.lasting(world, "intruder", 3, drive), 1);

        Scheduler.schedule(routine);
        for (int i = 1; i <= loop + 15; i++) {
            world.advance();
            world.follower.update();
            if (i == loop) {
                Scheduler.schedule(intruder);
            }
            Scheduler.execute();
        }
        return world.log;
    }

    /** {@code body} with {@link InterruptedBehavior#SUSPEND} and the given priority. */
    static Command suspending(final Command body, final int priority) {
        return new Command() {
            @Override
            public Set<Object> requirements() {
                return body.requirements();
            }

            @Override
            public int priority() {
                return priority;
            }

            @Override
            public InterruptedBehavior interruptedBehavior() {
                return InterruptedBehavior.SUSPEND;
            }

            @Override
            public ConflictBehavior conflictBehavior() {
                return ConflictBehavior.OVERRIDE;
            }

            @Override
            public BlockedBehavior blockedBehavior() {
                return BlockedBehavior.CANCEL;
            }

            @Override
            public void start() {
                body.start();
            }

            @Override
            public void execute() {
                body.execute();
            }

            @Override
            public boolean done() {
                return body.done();
            }

            @Override
            public void end(EndCondition endCondition) {
                body.end(endCondition);
            }
        };
    }

    /** Commands the test schedules beside the routine. */
    static final class Commands {
        private Commands() {}

        /** A command that logs as a named command does, lasts {@code loops} loops and requires {@code what}. */
        static Command lasting(World world, String label, int loops, Object what) {
            final World.Action action = new World.Action(world, label, loops, null, null);
            final Set<Object> requirements = Collections.singleton(what);
            return new Command() {
                @Override
                public Set<Object> requirements() {
                    return requirements;
                }

                @Override
                public int priority() {
                    return 0;
                }

                @Override
                public InterruptedBehavior interruptedBehavior() {
                    return InterruptedBehavior.END;
                }

                @Override
                public ConflictBehavior conflictBehavior() {
                    return ConflictBehavior.OVERRIDE;
                }

                @Override
                public BlockedBehavior blockedBehavior() {
                    return BlockedBehavior.CANCEL;
                }

                @Override
                public void start() {
                    action.start();
                }

                @Override
                public void execute() {
                    action.execute();
                }

                @Override
                public boolean done() {
                    return action.done();
                }

                @Override
                public void end(EndCondition endCondition) {
                    action.end(endCondition == EndCondition.INTERRUPTED);
                }
            };
        }
    }
}
