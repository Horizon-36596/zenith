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
import com.seattlesolvers.solverslib.command.ConditionalCommand;
import com.seattlesolvers.solverslib.command.InstantCommand;
import com.seattlesolvers.solverslib.command.SequentialCommandGroup;
import com.seattlesolvers.solverslib.command.WaitUntilCommand;
import com.seattlesolvers.solverslib.geometry.Pose2d;

import org.horizon36596.zenith.AutoFile;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * Turns a parsed {@link AutoSpec} into the one {@link Command} an auto is.
 *
 * <p>Everything it produces is ordinary SolversLib: a {@code SequentialCommandGroup} of steps, each
 * wrapped in {@link AutoContext#step} so a team's step logging works on a file-driven auto exactly as it
 * does on a hand-written one. Nested steps inside a {@code parallel} or a {@code branch} are wrapped
 * too, so a step that only exists inside a group still names itself in the log.
 *
 * <table>
 *   <tr><th>file step</th><th>what is built</th></tr>
 *   <tr><td>{@code path}</td><td>{@link AutoContext#followPath}, wrapped by {@link PathMarkers} when it has markers
 *       and raced against {@code WaitUntilCommand} with {@link Parallel#race} when it has an
 *       {@code endCondition}</td></tr>
 *   <tr><td>{@code command}</td><td>{@link NamedCommands#build}</td></tr>
 *   <tr><td>{@code wait}</td><td>{@link WaitRobotTime} or {@code WaitUntilCommand}</td></tr>
 *   <tr><td>{@code parallel}</td><td>{@link Parallel#all} / {@link Parallel#race} /
 *       {@link Parallel#deadline}, members in file order</td></tr>
 *   <tr><td>{@code branch}</td><td>{@code ConditionalCommand}</td></tr>
 *   <tr><td>{@code sequence}</td><td>{@code SequentialCommandGroup} of its own steps, each still wrapped
 *       in {@code ctx.step(id, ...)}, so it nests inside a {@code parallel}'s {@code deadline}, a
 *       {@code branch} arm, or anywhere else a step goes, the same as every other kind</td></tr>
 *   <tr><td>a path, command or wait step's {@code timeoutS}</td><td>{@link RobotTimeout}, never
 *       {@code withTimeout}; a group step has none ({@link org.horizon36596.zenith.AutoFile#warnings})</td></tr>
 * </table>
 *
 * <p><b>{@code "current"} defers.</b> A path whose first segment starts at the live pose cannot be
 * built at init, because the pose it starts from is whatever the previous step left behind. Such a step
 * becomes a {@link DeferredPath}, a {@code DeferredCommand} that builds the path in its own
 * {@code initialize()} from {@link AutoContext#currentPose()}, with the drivetrain and every marker's
 * subsystems declared as its requirements up front.
 *
 * <p><b>Everything else is built at init.</b> A file that names a command nobody registered, a waypoint
 * nobody measured or a heading mode this runtime does not know throws while the robot is still on the
 * tile with the Driver Station showing the message, which is the whole reason {@link AutoFromFile}
 * builds its routine at init rather than at start. Every one of those messages names the step it came
 * from ({@link AutoFile.StepFailure}): "no auto command named \"intke\" is registered" is a different
 * problem to find in a file with two {@code intake} steps once it says which one.
 */
public final class AutoBuilder {

    private AutoBuilder() {}

    /**
     * The whole routine.
     *
     * @param spec the parsed file
     * @param ctx  the running auto: the robot, its clock and its alliance frame
     * @return one command that runs every step in order
     */
    public static Command build(AutoSpec spec, AutoContext ctx) {
        // Read the alliance frame once here, at init, so a mirror that turns headings differently from
        // positions is refused on the tile even when every path starts from "current".
        PathBuilder.frame(ctx);
        return sequence(spec.steps, ctx);
    }

    private static Command sequence(List<AutoSpec.Step> steps, AutoContext ctx) {
        List<Command> built = new ArrayList<Command>(steps.size());
        for (AutoSpec.Step step : steps) {
            built.add(named(step, ctx));
        }
        return new SequentialCommandGroup(built.toArray(new Command[0]));
    }

    /** One step, with its timeout and its {@code Auto/step} name. */
    private static Command named(AutoSpec.Step step, AutoContext ctx) {
        Command body;
        try {
            body = body(step, ctx);
        } catch (RuntimeException problem) {
            throw inStep(step.id, problem);
        }
        if (step.timeoutS != null) {
            body = RobotTimeout.of(body, step.timeoutS.doubleValue(), ctx);
        }
        return ctx.step(step.id, body);
    }

    /**
     * Rethrow a build failure with the step it happened in named, unless it already names one.
     *
     * <p>A nested step names itself first and keeps that name: the innermost step is the one a human has
     * to go and look at.
     */
    private static RuntimeException inStep(String stepId, RuntimeException problem) {
        return AutoFile.StepFailure.inStep(stepId, problem);
    }

    private static Command body(AutoSpec.Step step, AutoContext ctx) {
        if (step instanceof AutoSpec.PathStep) {
            return path((AutoSpec.PathStep) step, ctx);
        }
        if (step instanceof AutoSpec.CommandStep) {
            AutoSpec.CommandStep command = (AutoSpec.CommandStep) step;
            return NamedCommands.build(command.name, command.args, ctx);
        }
        if (step instanceof AutoSpec.WaitStep) {
            AutoSpec.WaitStep wait = (AutoSpec.WaitStep) step;
            if (wait.until != null) {
                return new WaitUntilCommand(NamedCommands.condition(wait.until));
            }
            return new WaitRobotTime(Math.round(wait.seconds.doubleValue() * 1000.0), ctx);
        }
        if (step instanceof AutoSpec.ParallelStep) {
            return parallel((AutoSpec.ParallelStep) step, ctx);
        }
        if (step instanceof AutoSpec.BranchStep) {
            AutoSpec.BranchStep branch = (AutoSpec.BranchStep) step;
            Command otherwise = branch.otherwise.isEmpty()
                    ? new InstantCommand()
                    : sequence(branch.otherwise, ctx);
            return new ConditionalCommand(sequence(branch.then, ctx), otherwise,
                    NamedCommands.condition(branch.condition));
        }
        if (step instanceof AutoSpec.SequenceStep) {
            // Just another SequentialCommandGroup of named() children - the same helper the whole routine
            // and a branch's arms use - so a sequence nested inside a parallel's deadline, another
            // sequence, or a branch arm builds exactly like a top-level one.
            return sequence(((AutoSpec.SequenceStep) step).steps, ctx);
        }
        throw new IllegalStateException("unhandled step type " + step.getClass().getName());
    }

    // ---------------------------------------------------------------------------------------------
    // path
    // ---------------------------------------------------------------------------------------------

    private static Command path(final AutoSpec.PathStep step, final AutoContext ctx) {
        if (!step.startsFromCurrentPose()) {
            return follow(step, ctx, null);
        }
        Command[] markers = new Command[step.markers.size()];
        for (int i = 0; i < markers.length; i++) {
            AutoSpec.Marker marker = step.markers.get(i);
            markers[i] = NamedCommands.build(marker.commandName, marker.args, ctx);
        }
        return DeferredPath.of(step.id, ctx, new Function<Pose2d, Command>() {
            @Override
            public Command apply(Pose2d currentPose) {
                return follow(step, ctx, currentPose);
            }
        }, markers);
    }

    /** The path-following command for one path step, with its markers and its end condition. */
    private static Command follow(AutoSpec.PathStep step, AutoContext ctx, Pose2d currentPose) {
        PathBuilder.Built built = PathBuilder.build(step, ctx, currentPose);

        double speed = step.speedFraction != null
                ? step.speedFraction.doubleValue()
                : ctx.defaultSpeedFraction();
        Command drive = ctx.followPath(built.path, speed);
        if (step.endCondition != null) {
            // Not drive.interruptOn(...): that is a SolversLib ParallelRaceGroup, whose end() skips the
            // member that finished, so a path that arrived before its condition was never ended. This
            // race ends every member exactly once.
            drive = Parallel.race(drive, new WaitUntilCommand(NamedCommands.condition(step.endCondition)));
        }

        List<PathMarkers.Marker> markers = new ArrayList<PathMarkers.Marker>(step.markers.size());
        for (AutoSpec.Marker marker : step.markers) {
            markers.add(new PathMarkers.Marker(
                    marker.distanceAlongIn(built.totalLengthIn),
                    NamedCommands.build(marker.commandName, marker.args, ctx)));
        }
        return PathMarkers.wrap(drive, built.segmentLengthsIn, markers, ctx);
    }

    // ---------------------------------------------------------------------------------------------
    // parallel
    // ---------------------------------------------------------------------------------------------

    private static Command parallel(AutoSpec.ParallelStep step, AutoContext ctx) {
        List<Command> members = new ArrayList<Command>(step.steps.size());
        Command deadline = null;
        for (AutoSpec.Step member : step.steps) {
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
