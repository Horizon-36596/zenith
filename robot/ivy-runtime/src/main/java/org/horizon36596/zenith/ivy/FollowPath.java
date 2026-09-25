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

import com.pedropathing.ivy.behaviors.EndCondition;
import com.pedropathing.paths.Path;

/**
 * Drives one Pedro Pathing v3 path and finishes when the follower stops following it. This is what
 * {@link AutoContext#followPath} builds unless a team overrides it. It keeps the contract of the
 * SolversLib runtime's {@code FollowPath}.
 *
 * <ul>
 *   <li><b>Start:</b> hands the follower {@code ctx.atSpeed(path, speedFraction)}, so a team that caps
 *       its velocity per path does it in one place.</li>
 *   <li><b>Done:</b> when {@code follower.following()} goes false. That is the follower's mode: it goes
 *       false on the loop the path completes, and Pedro then holds the end pose itself.</li>
 *   <li><b>Interrupted or suspended</b> (a timeout, an end condition, another command taking the
 *       drivetrain): holds the pose the robot was cut off at, rather than leaving the follower chasing a
 *       path nobody wants any more. A path that Ivy resumes after a suspension is done on its next
 *       loop, whatever the follower is doing by then; it does not drive the rest of the path from
 *       wherever the robot was left, and the path's markers that the robot had not reached do not
 *       fire.</li>
 * </ul>
 *
 * <p>Requires {@link AutoContext#drive()}, so two paths can never drive at once.
 *
 * <p><b>Why not Ivy's {@code PedroCommands.follow}.</b> It is done on
 * {@code atParametricEnd()} rather than {@code !following()}, which is not the signal the marker runner
 * reads, it declares no requirements, and it does nothing when interrupted, so the follower keeps
 * driving a path that was cut off. A team that wants it anyway can return it from its own
 * {@code followPath}.
 */
public class FollowPath extends BaseCommand {

    private final AutoContext ctx;
    private final Path path;
    private final double speedFraction;

    /**
     * Set by a suspension, cleared by {@link #start()}. Ivy does not start a resumed command again, so
     * this is what makes the path done on the loop it resumes, even if whatever took the drivetrain left
     * the follower driving a path of its own.
     */
    private boolean suspended;

    /**
     * @param ctx           the running auto: its follower drives the path, its drivetrain is required
     * @param path          the path to follow; it must carry a heading interpolator, which every path
     *                      the runtime builds does
     * @param speedFraction 0 to 1, the fraction of the robot's maximum speed, passed to
     *                      {@link AutoContext#atSpeed}
     */
    public FollowPath(AutoContext ctx, Path path, double speedFraction) {
        this.ctx = ctx;
        this.path = path;
        this.speedFraction = speedFraction;
        addRequirement(ctx.drive());
    }

    @Override
    public void start() {
        suspended = false;
        ctx.follower().follow(ctx.atSpeed(path, speedFraction));
    }

    @Override
    public boolean done() {
        return suspended || !ctx.follower().following();
    }

    @Override
    public void end(EndCondition endCondition) {
        if (endCondition != EndCondition.NATURALLY && !suspended) {
            ctx.follower().hold(ctx.follower().pose());
        }
        if (endCondition == EndCondition.SUSPENDED) {
            suspended = true;
        }
        // Naturally, after arriving: Pedro has already switched to holding the end pose. Naturally or
        // interrupted after a suspension: the robot was held when it was suspended, and whatever took
        // the drivetrain may be driving it now, so the follower is left alone.
    }
}
