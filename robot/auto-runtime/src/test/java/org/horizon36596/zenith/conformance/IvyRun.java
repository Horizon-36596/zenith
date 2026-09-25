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

import com.pedropathing.follower.Follower;
import com.pedropathing.ivy.Command;
import com.pedropathing.ivy.Scheduler;
import com.pedropathing.ivy.behaviors.BlockedBehavior;
import com.pedropathing.ivy.behaviors.ConflictBehavior;
import com.pedropathing.ivy.behaviors.EndCondition;
import com.pedropathing.ivy.behaviors.InterruptedBehavior;
import com.pedropathing.math.Pose;

import org.horizon36596.zenith.AutoSource;
import org.horizon36596.zenith.ivy.AutoFromFile;
import org.horizon36596.zenith.ivy.AutoTraceWriter;
import org.horizon36596.zenith.ivy.NamedCommands;
import org.horizon36596.zenith.ivy.ZenithRobot;

import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Runs an auto file through the Ivy runtime's own {@link AutoFromFile}, on a {@link World}.
 *
 * <p>The OpMode is driven the way its {@code runOpMode} drives it, minus the Driver Station: init,
 * {@code startRoutine()} at start, {@code run()} once per loop, and {@code reset()} when the loops run
 * out or a command throws. The robot keeps {@link ZenithRobot#periodic}'s default, which updates the
 * follower before {@code Scheduler.execute()}.
 */
public final class IvyRun {

    private IvyRun() {}

    /**
     * @param source   where the auto file and its waypoints are
     * @param autoName the file stem
     * @param alliance the alliance the Driver Station selected
     * @param world    the world to run on; its log is the result
     * @param loops    how many loops the OpMode runs after start
     * @return the run's outcome
     */
    public static Outcome run(AutoSource source, final String autoName, final String alliance,
            final World world, int loops) {
        return run(source, autoName, alliance, world, loops, FROM_FILE);
    }

    /** Makes the OpMode a run drives, given the file stem and the robot the harness built. */
    public interface OpModeMaker {
        AutoFromFile make(String autoName, ZenithRobot robot);
    }

    /**
     * The runtime's own {@link AutoFromFile}, which builds the routine from the file. The robot parameter
     * is not called {@code robot}, because inside the subclass that name is {@link AutoFromFile}'s own
     * field, which is null until init.
     */
    public static final OpModeMaker FROM_FILE = (name, teamRobot) -> new AutoFromFile() {
        @Override
        protected String autoName() {
            return name;
        }

        @Override
        protected ZenithRobot createRobot() {
            return teamRobot;
        }
    };

    /**
     * As {@link #run(AutoSource, String, String, World, int)}, driving the OpMode {@code maker} makes,
     * such as a subclass of a class {@code zenith codegen} wrote.
     *
     * @param maker makes the OpMode from the file stem and the robot
     * @return the run's outcome
     */
    public static Outcome run(AutoSource source, final String autoName, final String alliance,
            final World world, int loops, OpModeMaker maker) {
        final AutoTraceWriter trace = new AutoTraceWriter(autoName, World.LOOP_NANOS / 1e9);
        final Map<String, Object> subsystems = new HashMap<String, Object>();
        // The drivetrain is the follower, ZenithRobot's default drive(), so a command that requires
        // "drive" clashes with a path here exactly as it does with the SolversLib drive subsystem.
        subsystems.put(World.DRIVE, world.follower);
        subsystems.put(World.INTAKE, new Object());
        subsystems.put(World.SHOOTER, new Object());

        final ZenithRobot teamRobot = new ZenithRobot() {
            @Override
            public void init(AutoFromFile opMode) {}

            @Override
            public void registerCommands(AutoFromFile opMode) {
                register(world, subsystems);
            }

            @Override
            public Follower follower() {
                return world.follower;
            }

            @Override
            public String runningAlliance() {
                return alliance;
            }

            @Override
            public Pose mirror(Pose pose) {
                return world.mirror.apply(pose);
            }

            @Override
            public long nanoTime() {
                return world.nanoTime();
            }

            @Override
            public void setStartPose(Pose pose) {
                world.place(pose);
            }

            @Override
            public Command step(String id, Command body) {
                return trace.traced(id, logged(world, id, body));
            }
        };

        AutoFromFile opMode = maker.make(autoName, teamRobot);
        opMode.setAutoSource(source);

        Outcome outcome = new Outcome(world, trace);
        try {
            try {
                opMode.initialize();
            } catch (RuntimeException problem) {
                outcome.threw(problem);
                return outcome;
            }
            opMode.startRoutine();
            boolean finished = false;
            for (int i = 0; i < loops; i++) {
                world.advance();
                trace.tick(world.loop * World.LOOP_NANOS / 1e9);
                opMode.run();
                Pose pose = world.follower.pose();
                trace.pose(pose.x(), pose.y(), pose.heading());
                if (!finished && !inScheduler(opMode.routine())) {
                    finished = true;
                    world.event("routine finished");
                }
            }
        } catch (RuntimeException problem) {
            outcome.threw(problem);
        } finally {
            opMode.reset();
        }
        outcome.routineStillScheduled = opMode.routine() != null && inScheduler(opMode.routine());
        return outcome;
    }

    /** Register the world's named commands and conditions with the Ivy runtime. */
    static void register(final World world, final Map<String, Object> subsystems) {
        for (final String name : World.COMMANDS) {
            NamedCommands.register(name, (args, ctx) -> command(world.action(name, args), subsystems));
        }
        for (final String name : World.CONDITIONS) {
            NamedCommands.registerCondition(name, () -> world.condition(name));
        }
    }

    private static boolean inScheduler(Command command) {
        return Scheduler.isRunning(command) || Scheduler.isScheduled(command);
    }

    /** {@code action} as an Ivy command, requiring the subsystem it names. */
    static Command command(final World.Action action, Map<String, Object> subsystems) {
        final Set<Object> requirements = action.requires == null
                ? Collections.<Object>emptySet()
                : Collections.singleton(subsystems.get(action.requires));
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
                if (endCondition == EndCondition.SUSPENDED) {
                    action.suspend();
                } else {
                    action.end(endCondition == EndCondition.INTERRUPTED);
                }
            }
        };
    }

    /** {@code body}, logging the step's start and end in the world. */
    static Command logged(final World world, final String id, final Command body) {
        final Set<Object> requirements = new LinkedHashSet<Object>(body.requirements());
        return new Command() {
            @Override
            public Set<Object> requirements() {
                return requirements;
            }

            @Override
            public int priority() {
                return body.priority();
            }

            @Override
            public InterruptedBehavior interruptedBehavior() {
                return body.interruptedBehavior();
            }

            @Override
            public ConflictBehavior conflictBehavior() {
                return body.conflictBehavior();
            }

            @Override
            public BlockedBehavior blockedBehavior() {
                return body.blockedBehavior();
            }

            @Override
            public void start() {
                world.event("step " + id + " start");
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
                if (endCondition == EndCondition.SUSPENDED) {
                    world.event("step " + id + " suspended");
                } else {
                    world.event("step " + id + (endCondition == EndCondition.INTERRUPTED ? " interrupted" : " end"));
                }
            }
        };
    }
}
