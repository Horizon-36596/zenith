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
import com.seattlesolvers.solverslib.command.DeferredCommand;
import com.seattlesolvers.solverslib.command.Subsystem;
import com.seattlesolvers.solverslib.geometry.Pose2d;

import org.horizon36596.zenith.AutoFile;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * A path step whose first segment starts from {@code "current"}: the robot's pose when the step
 * starts, which nobody knows at init. {@link AutoBuilder} builds every such step with this, and so
 * does the class {@code zenith codegen} writes, so the two defer the same steps the same way.
 *
 * <p>The path is built when the step starts, from {@link AutoContext#currentPose()}, which is already
 * in the alliance's frame and so is used unmirrored. The requirements are declared up front: the
 * drivetrain, plus every marker command's. That is what stops another command taking a subsystem out
 * from under a leg that has not been built yet.
 */
public final class DeferredPath {

    private DeferredPath() {}

    /**
     * The command for a path step that starts from the live pose.
     *
     * @param stepId  the step's id, named in the error if building the path throws
     * @param ctx     the running auto
     * @param build   builds the step's command from the live pose, when the step starts
     * @param markers the step's marker commands, built at init only for their requirements
     * @return a command that builds and runs the path when it starts
     */
    public static Command of(final String stepId, final AutoContext ctx,
                             final Function<Pose2d, Command> build, Command... markers) {
        Set<Subsystem> requirements = new LinkedHashSet<Subsystem>();
        requirements.add(ctx.drive());
        for (Command marker : markers) {
            requirements.addAll(marker.getRequirements());
        }

        Supplier<Command> supplier = new Supplier<Command>() {
            @Override
            public Command get() {
                try {
                    return build.apply(ctx.currentPose());
                } catch (RuntimeException problem) {
                    // This one builds when the step starts rather than at init, so it is the one place
                    // the step's identity is not on the stack already.
                    throw AutoFile.StepFailure.inStep(stepId, problem);
                }
            }
        };
        return new DeferredCommand(supplier, new ArrayList<Subsystem>(requirements));
    }
}
