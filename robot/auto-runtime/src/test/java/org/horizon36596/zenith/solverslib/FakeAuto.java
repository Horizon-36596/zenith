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

import com.pedropathing.follower.Follower;
import com.pedropathing.paths.Path;
import com.seattlesolvers.solverslib.command.Command;
import com.seattlesolvers.solverslib.command.CommandBase;
import com.seattlesolvers.solverslib.command.Subsystem;
import com.seattlesolvers.solverslib.geometry.Pose2d;
import com.seattlesolvers.solverslib.geometry.Rotation2d;

import org.horizon36596.zenith.AutoSource;

import java.io.File;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;

/**
 * A robot with no hardware, for building and running command trees on the JVM.
 *
 * <p>Paths do not drive: {@link #followPath} returns a command that records what it was given, reports
 * steady progress through {@link #follower} (a Pedro {@code Follower} with no hardware behind it), and
 * finishes after {@link #pathLoops} loops. The clock is {@link #nowNanos}, advanced by {@link #loop}.
 * Every event lands in {@link #log} in order, so a test asserts on one list.
 */
class FakeAuto implements AutoContext {

    /** A drivetrain that is only a requirement. */
    static final Subsystem DRIVE = new Subsystem() {};

    /** A second subsystem, for commands that must not collide with the drivetrain. */
    static final Subsystem INTAKE = new Subsystem() {};

    final List<String> log = new ArrayList<String>();
    final List<String> stepIds = new ArrayList<String>();
    final List<Path> paths = new ArrayList<Path>();
    final List<Double> speeds = new ArrayList<Double>();

    long nowNanos;
    int pathLoops = 3;
    boolean mirror;
    boolean holdingPiece;
    Pose2d livePose = new Pose2d(-24, -36, new Rotation2d(0));

    /** Progress as the fake path commands report it; read by {@link PathMarkers}. */
    boolean following;
    int pathIndex;
    double curveCompletion;

    final Follower follower = new Follower(null, null, null) {
        @Override
        public boolean following() {
            return FakeAuto.this.following;
        }

        @Override
        public int pathIndex() {
            return FakeAuto.this.pathIndex;
        }

        @Override
        public double curveCompletion() {
            return FakeAuto.this.curveCompletion;
        }
    };

    @Override
    public Follower follower() {
        return follower;
    }

    @Override
    public Subsystem drive() {
        return DRIVE;
    }

    @Override
    public long nanoTime() {
        return nowNanos;
    }

    @Override
    public Pose2d alliance(Pose2d filePose) {
        return mirror
                ? new Pose2d(-filePose.getX(), -filePose.getY(), new Rotation2d(filePose.getHeading() + Math.PI))
                : filePose;
    }

    @Override
    public Pose2d currentPose() {
        log.add("currentPose");
        return livePose;
    }

    @Override
    public double defaultSpeedFraction() {
        return 0.6;
    }

    @Override
    public Command followPath(final Path path, final double speedFraction) {
        paths.add(path);
        speeds.add(speedFraction);
        final int index = paths.size() - 1;
        CommandBase drive = new CommandBase() {
            int loops;

            @Override
            public void initialize() {
                loops = 0;
                following = true;
                pathIndex = 0;
                curveCompletion = 0;
                log.add("path" + index + " start");
            }

            @Override
            public void execute() {
                loops++;
                curveCompletion = Math.min(1.0, (double) loops / pathLoops);
                if (loops >= pathLoops) {
                    following = false;
                }
            }

            @Override
            public boolean isFinished() {
                return loops >= pathLoops;
            }

            @Override
            public void end(boolean interrupted) {
                following = false;
                log.add("path" + index + (interrupted ? " interrupted" : " end"));
            }
        };
        drive.addRequirements(DRIVE);
        return drive;
    }

    @Override
    public Command step(String id, Command body) {
        stepIds.add(id);
        return body;
    }

    /** Register the commands and conditions the fixtures use. */
    void registerCommands() {
        NamedCommands.reset();
        NamedCommands.register("intakeOn", (args, ctx) -> instant("intakeOn", INTAKE));
        NamedCommands.register("score", (args, ctx) ->
                instant("score " + NamedCommands.argInt(args, "score", "level"), INTAKE));
        NamedCommands.registerCondition("holdingPiece", () -> holdingPiece);
    }

    /** A command that logs its name and finishes at once. */
    CommandBase instant(final String name, Subsystem requirement) {
        CommandBase command = new CommandBase() {
            @Override
            public void initialize() {
                log.add(name);
            }

            @Override
            public boolean isFinished() {
                return true;
            }
        };
        command.addRequirements(requirement);
        return command;
    }

    /** Run {@code command} to completion the way the scheduler would, 20 ms per loop. */
    void run(Command command, int maxLoops) {
        command.initialize();
        for (int i = 0; i < maxLoops; i++) {
            if (command.isFinished()) {
                command.end(false);
                return;
            }
            loop();
            command.execute();
        }
        throw new AssertionError("did not finish in " + maxLoops + " loops; log " + log);
    }

    /** Advance the clock one 20 ms loop. */
    void loop() {
        nowNanos += 20_000_000L;
    }

    /** The test fixtures folder, {@code src/test/resources/autos}. */
    static AutoSource fixtures() {
        try {
            return AutoSource.directory(new File(FakeAuto.class.getResource("/autos/demo.auto.json").toURI())
                    .getParentFile());
        } catch (URISyntaxException problem) {
            throw new IllegalStateException(problem);
        }
    }
}
