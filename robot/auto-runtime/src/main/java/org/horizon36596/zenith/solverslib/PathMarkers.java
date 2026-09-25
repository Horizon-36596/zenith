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

import com.seattlesolvers.solverslib.command.Command;
import com.seattlesolvers.solverslib.command.CommandBase;
import com.seattlesolvers.solverslib.command.CommandGroupBase;
import com.seattlesolvers.solverslib.command.Subsystem;

import org.horizon36596.zenith.MarkerProgress;

import java.util.ArrayList;
import java.util.List;
import java.util.function.DoubleSupplier;

/**
 * Fires commands part-way along a path, without stopping the path.
 *
 * <p>The shape is a {@link Parallel#deadline} whose deadline is the path-following command, so the
 * group lasts exactly as long as the drive does and any marker still running when the path finishes is
 * interrupted with it ({@code end(true)}), including when the group sits inside a step timeout. The
 * path runs first in each loop and the runner second, every time. The other member is a {@link Runner}, which watches the follower's progress and
 * starts each marker's command when the robot passes the marker's distance.
 *
 * <h2>How progress is measured</h2>
 * {@link MarkerProgress}, which both runtimes share, holds the rule: distance along the planned path from
 * {@code follower.pathIndex()} and {@code follower.curveCompletion()}, held monotone, with a finished
 * path counting as the whole length once the follower has been seen driving it. Its javadoc has the
 * reasons.
 *
 * <h2>Marker commands run inside the runner, not on the scheduler</h2>
 * The runner owns its marker commands: it initialises, executes and ends them itself, and declares
 * their requirements as its own. That makes the group's own requirement check do useful work - a marker
 * that wanted the drivetrain would collide with the path it is attached to, and
 * the group throws for that at <b>construction</b>, which is OpMode init, on the
 * tile. Scheduling them separately would instead have discovered it by interrupting the path mid-leg.
 * It also keeps the runtime free of scheduler re-entrancy, so a headless run stays a pure function of
 * its inputs.
 *
 * <p>The follower is read from {@link AutoContext#follower()} on every loop, not captured when the
 * group is built, so a routine can be built before the follower exists.
 */
public final class PathMarkers {

    private PathMarkers() {}

    /** One marker: where it fires, and what it runs. */
    public static final class Marker {
        final double distanceIn;
        final Command command;

        /**
         * @param distanceIn where the marker fires, inches along the planned path from its start
         * @param command    what it runs; it must not already be in a command group
         */
        public Marker(double distanceIn, Command command) {
            this.distanceIn = distanceIn;
            this.command = command;
        }
    }

    /**
     * Wrap a path-following command so that {@code markers} fire along it.
     *
     * @param follow           the command that drives the path; it is the group's deadline
     * @param segmentLengthsIn each file segment's arc length, from {@link PathBuilder.Built}
     * @param markers          in any order; the runner sorts by distance
     * @param ctx              the running auto, whose follower reports progress along the path
     * @return {@code follow} itself when there are no markers, otherwise the group
     */
    public static Command wrap(Command follow, double[] segmentLengthsIn, List<Marker> markers,
            AutoContext ctx) {
        if (markers.isEmpty()) {
            return follow;
        }
        return Parallel.deadline(follow, new Runner(segmentLengthsIn, markers, ctx));
    }

    /** Watches the follower and runs the markers. Never finishes; the deadline ends it. */
    static class Runner extends CommandBase {

        private final AutoContext ctx;
        private final double[] segmentLengthsIn;
        private final MarkerProgress<Command> progress;
        private final List<Command> running = new ArrayList<Command>();

        Runner(double[] segmentLengthsIn, List<Marker> markers, AutoContext ctx) {
            this.ctx = ctx;
            this.segmentLengthsIn = segmentLengthsIn.clone();
            List<MarkerProgress.Entry<Command>> entries = new ArrayList<MarkerProgress.Entry<Command>>();
            for (Marker marker : markers) {
                entries.add(new MarkerProgress.Entry<Command>(marker.distanceIn, marker.command));
            }
            this.progress = new MarkerProgress<Command>(this.segmentLengthsIn, entries);
            for (MarkerProgress.Entry<Command> marker : progress.markers()) {
                CommandGroupBase.requireUngrouped(marker.command);
                for (Subsystem requirement : marker.command.getRequirements()) {
                    m_requirements.add(requirement);
                }
            }
            setName("PathMarkers: " + progress.markers().size() + " marker(s)");
        }

        @Override
        public void initialize() {
            progress.reset();
            running.clear();
            fireDue();
        }

        @Override
        public void execute() {
            progress.update(stillFollowing(), new DoubleSupplier() {
                @Override
                public double getAsDouble() {
                    return followerDistanceIn();
                }
            });
            fireDue();

            for (int i = running.size() - 1; i >= 0; i--) {
                Command command = running.get(i);
                command.execute();
                if (command.isFinished()) {
                    command.end(false);
                    running.remove(i);
                }
            }
        }

        @Override
        public boolean isFinished() {
            // The path is the deadline. A marker that outlives it is interrupted with it, which is what
            // "a marker does not stop the path" has to mean in the other direction too.
            return false;
        }

        @Override
        public void end(boolean interrupted) {
            for (int i = running.size() - 1; i >= 0; i--) {
                running.get(i).end(true);
            }
            running.clear();
        }

        /** Start every marker whose distance the robot has passed and which has not run yet. */
        private void fireDue() {
            Command command;
            while ((command = progress.nextDue()) != null) {
                command.initialize();
                if (command.isFinished()) {
                    command.end(false);
                } else {
                    running.add(command);
                }
            }
        }

        /**
         * True while Pedro is still driving this step's path.
         *
         * <p>Package-private and overridable so a unit test can drive a {@link Runner} without a
         * follower, which is the only way to assert on marker timing without a whole headless robot.
         */
        boolean stillFollowing() {
            return ctx.follower().following();
        }

        /** Progress as the follower reports it, inches along the planned path. The test seam again. */
        double followerDistanceIn() {
            return MarkerProgress.alongIn(segmentLengthsIn, ctx.follower().pathIndex(), new DoubleSupplier() {
                @Override
                public double getAsDouble() {
                    return ctx.follower().curveCompletion();
                }
            });
        }

    }
}
