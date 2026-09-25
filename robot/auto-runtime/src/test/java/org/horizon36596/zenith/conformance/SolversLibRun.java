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
import com.pedropathing.math.Pose;
import com.seattlesolvers.solverslib.command.Command;
import com.seattlesolvers.solverslib.command.CommandBase;
import com.seattlesolvers.solverslib.command.CommandGroupBase;
import com.seattlesolvers.solverslib.command.CommandScheduler;
import com.seattlesolvers.solverslib.command.Subsystem;
import com.seattlesolvers.solverslib.geometry.Pose2d;
import com.seattlesolvers.solverslib.geometry.Rotation2d;

import org.horizon36596.zenith.solverslib.AutoFromFile;
import org.horizon36596.zenith.AutoSource;
import org.horizon36596.zenith.solverslib.AutoTraceWriter;
import org.horizon36596.zenith.solverslib.NamedCommands;
import org.horizon36596.zenith.solverslib.ZenithRobot;

import java.util.HashMap;
import java.util.Map;

/**
 * Runs an auto file through the SolversLib runtime's own {@link AutoFromFile}, on a {@link World}.
 *
 * <p>The OpMode is driven the way its {@code runOpMode} drives it, minus the Driver Station: init,
 * then {@code startRoutine()} at start, then {@code run()} once per loop, and {@code end()} then
 * {@code reset()} when the loops run out or a command throws. The drivetrain is a registered subsystem
 * whose {@code periodic()} updates the follower, so the scheduler updates it before any command runs.
 */
public final class SolversLibRun {

    private SolversLibRun() {}

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
        CommandScheduler.getInstance().reset();
        CommandGroupBase.clearGroupedCommands();
        final AutoTraceWriter trace = new AutoTraceWriter(autoName, World.LOOP_NANOS / 1e9);
        final Map<String, Subsystem> subsystems = new HashMap<String, Subsystem>();
        final Subsystem drive = new Subsystem() {
            @Override
            public void periodic() {
                world.follower.update();
            }
        };
        subsystems.put(World.DRIVE, drive);
        subsystems.put(World.INTAKE, new Subsystem() {});
        subsystems.put(World.SHOOTER, new Subsystem() {});

        final ZenithRobot teamRobot = new ZenithRobot() {
            @Override
            public void init(AutoFromFile opMode) {
                opMode.register(drive);
            }

            @Override
            public void registerCommands(AutoFromFile opMode) {
                for (final String name : World.COMMANDS) {
                    NamedCommands.register(name, (args, ctx) -> command(world.action(name, args), subsystems));
                }
                for (final String name : World.CONDITIONS) {
                    NamedCommands.registerCondition(name, () -> world.condition(name));
                }
            }

            @Override
            public Follower follower() {
                return world.follower;
            }

            @Override
            public Subsystem drive() {
                return drive;
            }

            @Override
            public String runningAlliance() {
                return alliance;
            }

            @Override
            public Pose2d mirror(Pose2d pose) {
                Pose mirrored = world.mirror.apply(new Pose(pose.getX(), pose.getY(), pose.getHeading()));
                return new Pose2d(mirrored.x(), mirrored.y(), new Rotation2d(mirrored.heading()));
            }

            @Override
            public long nanoTime() {
                return world.nanoTime();
            }

            @Override
            public void setStartPose(Pose2d pose) {
                world.place(new Pose(pose.getX(), pose.getY(), pose.getHeading()));
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
                if (!finished && !CommandScheduler.getInstance().isScheduled(opMode.routine())) {
                    finished = true;
                    world.event("routine finished");
                }
            }
        } catch (RuntimeException problem) {
            outcome.threw(problem);
        } finally {
            try {
                opMode.end();
            } finally {
                opMode.reset();
                CommandScheduler.getInstance().unregisterSubsystem(drive);
            }
        }
        return outcome;
    }

    /** {@code action} as a SolversLib command, requiring the subsystem it names. */
    static Command command(final World.Action action, Map<String, Subsystem> subsystems) {
        CommandBase command = new CommandBase() {
            @Override
            public void initialize() {
                action.start();
            }

            @Override
            public void execute() {
                action.execute();
            }

            @Override
            public boolean isFinished() {
                return action.done();
            }

            @Override
            public void end(boolean interrupted) {
                action.end(interrupted);
            }
        };
        if (action.requires != null) {
            command.addRequirements(subsystems.get(action.requires));
        }
        return command;
    }

    /** {@code body}, logging the step's start and end in the world. */
    static Command logged(final World world, final String id, final Command body) {
        return new CommandBase() {
            {
                m_requirements.addAll(body.getRequirements());
            }

            @Override
            public void initialize() {
                world.event("step " + id + " start");
                body.initialize();
            }

            @Override
            public void execute() {
                body.execute();
            }

            @Override
            public boolean isFinished() {
                return body.isFinished();
            }

            @Override
            public void end(boolean interrupted) {
                body.end(interrupted);
                world.event("step " + id + (interrupted ? " interrupted" : " end"));
            }

            @Override
            public boolean runsWhenDisabled() {
                return body.runsWhenDisabled();
            }
        };
    }
}
