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

import com.pedropathing.paths.Path;
import com.seattlesolvers.solverslib.command.CommandBase;

/**
 * Drives one Pedro Pathing v3 path and finishes when the follower stops following it. This is what
 * {@link AutoContext#followPath} builds unless a team overrides it.
 *
 * <ul>
 *   <li><b>Start:</b> hands the follower {@code ctx.atSpeed(path, speedFraction)}, so a team that caps
 *       its velocity per path does it in one place.</li>
 *   <li><b>Finish:</b> when {@code follower.following()} goes false. That is the follower's mode: it goes
 *       false on the loop the path completes, and Pedro then holds the end pose itself.
 *       {@code isBusy()} is not used, because it stays true while the follower is only holding.</li>
 *   <li><b>Interrupted</b> (a timeout, an end condition, another command taking the drivetrain): holds
 *       the pose the robot was cut off at, rather than leaving the follower chasing a path nobody wants
 *       any more.</li>
 * </ul>
 *
 * <p>Requires {@link AutoContext#drive()}, so two paths can never drive at once.
 */
public class FollowPath extends CommandBase {

    private final AutoContext ctx;
    private final Path path;
    private final double speedFraction;

    /**
     * @param ctx           the running auto: its follower drives the path, its drivetrain is required
     * @param path          the path to follow; it must carry a heading interpolator, which every path
     *                      {@link PathBuilder} builds does
     * @param speedFraction 0 to 1, the fraction of the robot's maximum speed, passed to
     *                      {@link AutoContext#atSpeed}
     */
    public FollowPath(AutoContext ctx, Path path, double speedFraction) {
        this.ctx = ctx;
        this.path = path;
        this.speedFraction = speedFraction;
        addRequirements(ctx.drive());
    }

    @Override
    public void initialize() {
        ctx.follower().follow(ctx.atSpeed(path, speedFraction));
    }

    @Override
    public boolean isFinished() {
        return !ctx.follower().following();
    }

    @Override
    public void end(boolean interrupted) {
        if (interrupted) {
            ctx.follower().hold(ctx.follower().pose());
        }
        // Not interrupted: Pedro has already switched to holding the end pose.
    }
}
