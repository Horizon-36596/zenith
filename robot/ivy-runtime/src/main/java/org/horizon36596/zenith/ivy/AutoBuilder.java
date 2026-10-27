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

import com.pedropathing.ivy.Command;
import com.pedropathing.ivy.commands.Commands;
import com.pedropathing.math.Pose;

import org.horizon36596.zenith.AllianceFrame;
import org.horizon36596.zenith.AutoFile;
import org.horizon36596.zenith.PedroPaths;

import java.util.ArrayList;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.Function;
import java.util.function.UnaryOperator;

/**
 * Turns a parsed {@link AutoFile} into the one Ivy {@link Command} an auto is. The Ivy side's copy of the
 * SolversLib runtime's {@code AutoBuilder}: the same tree, step for step, so a file runs the same way on
 * either library.
 *
 * <table>
 *   <tr><th>file step</th><th>what is built</th></tr>
 *   <tr><td>the routine, {@code sequence}, a branch arm</td><td>{@link Sequence}</td></tr>
 *   <tr><td>{@code path}</td><td>{@link AutoContext#followPath}, wrapped by {@link PathMarkers} when it
 *       has markers and raced against {@code Commands.waitUntil} with {@link Parallel#race} when it has
 *       an {@code endCondition}</td></tr>
 *   <tr><td>{@code command}</td><td>{@link NamedCommands#build}</td></tr>
 *   <tr><td>{@code wait}</td><td>{@link WaitRobotTime} or {@code Commands.waitUntil}</td></tr>
 *   <tr><td>{@code parallel}</td><td>{@link Parallel#all} / {@link Parallel#race} /
 *       {@link Parallel#deadline}, members in file order</td></tr>
 *   <tr><td>{@code branch}</td><td>{@link Branch}, which picks an arm at start; an empty {@code else} is
 *       {@code Commands.instant(() -> {})}, never {@code Command.NOOP}, which never finishes</td></tr>
 *   <tr><td>a path, command or wait step's {@code timeoutS}</td><td>{@link RobotTimeout}; a group step
 *       has none ({@link AutoFile#warnings})</td></tr>
 * </table>
 *
 * <p>Every step is wrapped in {@link AutoContext#step}, nested ones included.
 *
 * <p><b>{@code "current"} defers.</b> A path whose first segment starts at the live pose is built when
 * the step starts, from {@link AutoContext#currentPose()}, with the path's requirement and every
 * marker's declared up front ({@link DeferredPath}).
 *
 * <p><b>Everything else is built at init</b>, so a file that names a command nobody registered or a
 * waypoint nobody measured throws while the robot is still on the tile, with the step named
 * ({@link AutoFile.StepFailure}).
 */
public final class AutoBuilder {

    private AutoBuilder() {}

    /**
     * The whole routine.
     *
     * @param file the parsed file
     * @param ctx  the running auto: the robot, its clock and its alliance frame
     * @return one command that runs every step in order
     */
    public static Command build(AutoFile file, AutoContext ctx) {
        // Read the alliance frame once here, at init, so a mirror that turns headings differently from
        // positions is refused on the tile even when every path starts from "current".
        frame(ctx);
        return sequence(file.steps, ctx);
    }

    /** The running alliance's frame, poses and headings alike, from {@link AutoContext#alliance}. */
    static AllianceFrame frame(final AutoContext ctx) {
        return AllianceFrame.of(new UnaryOperator<Pose>() {
            @Override
            public Pose apply(Pose filePose) {
                return ctx.alliance(filePose);
            }
        });
    }

    private static Command sequence(List<AutoFile.Step> steps, AutoContext ctx) {
        List<Command> built = new ArrayList<Command>(steps.size());
        for (AutoFile.Step step : steps) {
            built.add(named(step, ctx));
        }
        return new Sequence(built.toArray(new Command[0]));
    }

    /** One step, with its timeout and its {@code Auto/step} name. */
    private static Command named(AutoFile.Step step, AutoContext ctx) {
        Command body;
        try {
            body = body(step, ctx);
        } catch (RuntimeException problem) {
            throw AutoFile.StepFailure.inStep(step.id, problem);
        }
        if (step.timeoutS != null) {
            body = RobotTimeout.of(body, step.timeoutS.doubleValue(), ctx);
        }
        return ctx.step(step.id, body);
    }

    private static Command body(AutoFile.Step step, AutoContext ctx) {
        if (step instanceof AutoFile.PathStep) {
            return path((AutoFile.PathStep) step, ctx);
        }
        if (step instanceof AutoFile.CommandStep) {
            AutoFile.CommandStep command = (AutoFile.CommandStep) step;
            return NamedCommands.build(command.name, command.args, ctx);
        }
        if (step instanceof AutoFile.WaitStep) {
            AutoFile.WaitStep wait = (AutoFile.WaitStep) step;
            if (wait.until != null) {
                return Commands.waitUntil(NamedCommands.condition(wait.until));
            }
            return new WaitRobotTime(Math.round(wait.seconds.doubleValue() * 1000.0), ctx);
        }
        if (step instanceof AutoFile.ParallelStep) {
            return parallel((AutoFile.ParallelStep) step, ctx);
        }
        if (step instanceof AutoFile.BranchStep) {
            AutoFile.BranchStep branch = (AutoFile.BranchStep) step;
            Command otherwise = branch.otherwise.isEmpty()
                    ? Commands.instant(new Runnable() {
                        @Override
                        public void run() {}
                    })
                    : sequence(branch.otherwise, ctx);
            return Branch.of(NamedCommands.condition(branch.condition), sequence(branch.then, ctx),
                    otherwise);
        }
        if (step instanceof AutoFile.SequenceStep) {
            return sequence(((AutoFile.SequenceStep) step).steps, ctx);
        }
        throw new IllegalStateException("unhandled step type " + step.getClass().getName());
    }

    // ---------------------------------------------------------------------------------------------
    // path
    // ---------------------------------------------------------------------------------------------

    private static Command path(final AutoFile.PathStep step, final AutoContext ctx) {
        // Resolved here, at init, even for a path that is built later from "current": an end condition
        // nobody registered then throws on the tile, not when the step starts mid-match.
        final BooleanSupplier endCondition = step.endCondition != null
                ? NamedCommands.condition(step.endCondition)
                : null;
        if (!step.startsFromCurrentPose()) {
            return follow(step, ctx, null, endCondition);
        }
        Command[] markers = new Command[step.markers.size()];
        for (int i = 0; i < markers.length; i++) {
            AutoFile.Marker marker = step.markers.get(i);
            markers[i] = NamedCommands.build(marker.commandName, marker.args, ctx);
        }
        return DeferredPath.of(step.id, ctx, new Function<Pose, Command>() {
            @Override
            public Command apply(Pose currentPose) {
                return follow(step, ctx, currentPose, endCondition);
            }
        }, markers);
    }

    /** The path-following command for one path step, with its markers and its end condition. */
    private static Command follow(AutoFile.PathStep step, final AutoContext ctx, Pose currentPose,
            BooleanSupplier endCondition) {
        PedroPaths.Built built = PedroPaths.build(step, frame(ctx), currentPose);

        double speed = step.speedFraction != null
                ? step.speedFraction.doubleValue()
                : ctx.defaultSpeedFraction();
        // A step this short is a turn on the spot (decision D10): it is held at its end pose until the
        // heading settles, never handed to followPath, and every marker on it fires as it starts.
        Command drive = built.isTurn()
                ? new TurnInPlace(ctx, built.turn)
                : ctx.followPath(built.path, speed);
        // The markers go on the path itself and the end condition races the two together, never the
        // other way round. A condition that cuts the path short then ends the marker runner with it, on
        // the loop it fires. Inside the race, the runner would run once more after the path was held,
        // see a follower that has stopped following, count the whole path as driven and start every
        // marker still waiting, wherever the robot was cut off.
        //
        // A turn has nothing to measure progress along, so its markers all sit at 0 and start with it.
        // They still go through the runner, so two that need one subsystem take turns there as they do
        // on a path, rather than both running (or the group refusing them) inside a plain deadline.
        List<PathMarkers.Marker> markers = new ArrayList<PathMarkers.Marker>(step.markers.size());
        for (AutoFile.Marker marker : step.markers) {
            markers.add(new PathMarkers.Marker(
                    built.isTurn() ? 0.0 : marker.distanceAlongIn(built.totalLengthIn),
                    NamedCommands.build(marker.commandName, marker.args, ctx)));
        }
        return cutShortBy(endCondition, PathMarkers.wrap(drive, built.segmentLengthsIn, markers, ctx));
    }

    /** {@code drive} raced against the step's end condition, or {@code drive} when it has none. */
    private static Command cutShortBy(BooleanSupplier endCondition, Command drive) {
        if (endCondition == null) {
            return drive;
        }
        // Ivy's own until() is a race that ends every member once, but its race walks a HashMap;
        // this one runs the path first on every loop, as the SolversLib runtime does.
        return Parallel.race(drive, Commands.waitUntil(endCondition));
    }

    // ---------------------------------------------------------------------------------------------
    // parallel
    // ---------------------------------------------------------------------------------------------

    private static Command parallel(AutoFile.ParallelStep step, AutoContext ctx) {
        List<Command> members = new ArrayList<Command>(step.steps.size());
        Command deadline = null;
        for (AutoFile.Step member : step.steps) {
            Command built = named(member, ctx);
            if (step.deadlineId != null && step.deadlineId.equals(member.id)) {
                deadline = built;
            }
            members.add(built);
        }

        if ("all".equals(step.mode)) {
            return Parallel.all(members.toArray(new Command[0]));
        }
        if ("race".equals(step.mode)) {
            return Parallel.race(members.toArray(new Command[0]));
        }
        if (deadline == null) {
            throw new IllegalArgumentException("step \"" + step.id + "\": its deadline is \""
                    + step.deadlineId + "\", which is not one of its own steps");
        }
        List<Command> others = new ArrayList<Command>(members);
        others.remove(deadline);
        return Parallel.deadline(deadline, others.toArray(new Command[0]));
    }
}
