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

import com.pedropathing.follower.Follower;
import com.pedropathing.ivy.Command;
import com.pedropathing.ivy.behaviors.EndCondition;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;

import org.horizon36596.zenith.AutoSource;

import java.io.File;
import java.net.URISyntaxException;
import java.util.ArrayList;
import java.util.List;

/**
 * A robot with no hardware, for building and running Ivy command trees on the JVM. The Ivy copy of the
 * SolversLib tests' {@code FakeAuto}, event for event, so the two suites can expect the same lists.
 *
 * <p>Paths do not drive: {@link #followPath} returns a command that records what it was given, reports
 * steady progress through {@link #follower}, and finishes after {@link #pathLoops} loops. The clock is
 * {@link #nowNanos}, advanced by {@link #loop}. Every event lands in {@link #log} in order.
 */
class FakeAuto implements AutoContext {

    /** A drivetrain that is only a requirement. */
    static final Object DRIVE = new Object();

    /** A second requirement, for commands that must not collide with the drivetrain. */
    static final Object INTAKE = new Object();

    final List<String> log = new ArrayList<String>();
    final List<String> stepIds = new ArrayList<String>();
    final List<Path> paths = new ArrayList<Path>();
    final List<Double> speeds = new ArrayList<Double>();

    long nowNanos;
    int pathLoops = 3;
    boolean mirror;
    boolean holdingPiece;
    Pose livePose = new Pose(-24, -36, 0);

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
    public Object drive() {
        return DRIVE;
    }

    @Override
    public long nanoTime() {
        return nowNanos;
    }

    @Override
    public Pose alliance(Pose filePose) {
        return mirror ? new Pose(-filePose.x(), -filePose.y(), filePose.heading() + Math.PI) : filePose;
    }

    @Override
    public Pose currentPose() {
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
        return new Recorder() {
            int loops;

            {
                require(DRIVE);
            }

            @Override
            public void start() {
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
            public boolean done() {
                return loops >= pathLoops;
            }

            @Override
            public void end(EndCondition endCondition) {
                following = false;
                log.add("path" + index + (endCondition == EndCondition.INTERRUPTED ? " interrupted" : " end"));
            }
        };
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
    Recorder instant(final String name, Object requirement) {
        Recorder command = new Recorder() {
            @Override
            public void start() {
                log.add(name);
            }

            @Override
            public boolean done() {
                return true;
            }
        };
        command.require(requirement);
        return command;
    }

    /**
     * Run {@code command} to completion the way the SolversLib tests' fake does, 20 ms per loop, so the
     * two suites expect the same lists.
     */
    void run(Command command, int maxLoops) {
        command.start();
        for (int i = 0; i < maxLoops; i++) {
            if (command.done()) {
                command.end(EndCondition.NATURALLY);
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

    /** The test fixtures folder, auto-runtime's {@code src/test/resources/autos}. */
    static AutoSource fixtures() {
        try {
            return AutoSource.directory(new File(FakeAuto.class.getResource("/autos/demo.auto.json").toURI())
                    .getParentFile());
        } catch (URISyntaxException problem) {
            throw new IllegalStateException(problem);
        }
    }

    /** A test command whose requirements a test can add, like SolversLib's {@code CommandBase}. */
    static class Recorder extends BaseCommand {
        Recorder require(Object requirement) {
            addRequirement(requirement);
            return this;
        }
    }
}
