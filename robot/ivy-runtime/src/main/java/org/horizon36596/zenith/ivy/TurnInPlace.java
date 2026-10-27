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
import com.pedropathing.math.Pose;

import org.horizon36596.zenith.PedroPaths;

/**
 * Runs a turn on the spot: a path step no longer than {@link PedroPaths#TURN_IN_PLACE_MAX_IN}, which is
 * never handed to Pedro (decision D10). It keeps the contract of the SolversLib runtime's
 * {@code TurnInPlace}, and {@link AutoBuilder} builds it for such a step in place of
 * {@link AutoContext#followPath}.
 *
 * <ul>
 *   <li><b>Start:</b> {@code follower.hold(turn)}, the step's end point with its end heading
 *       ({@link PedroPaths.Built#turn}), so the robot turns from the heading it arrives with to the end
 *       heading the short way.</li>
 *   <li><b>Done:</b> when {@link PedroPaths.TurnSettle#done} says so: at once when the heading
 *       is within {@link PedroPaths#TURN_SETTLED_RAD} of the turn's and the position within
 *       {@link PedroPaths#TURN_ARRIVED_IN} of its point, so a short step that drives without turning
 *       still ends only once the robot is there, or once the robot has stayed still for
 *       {@link PedroPaths#TURN_STILL_S} within {@link PedroPaths#TURN_NEAR_RAD} and
 *       {@link PedroPaths#TURN_IN_PLACE_MAX_IN} of it, so a hold that rests a little outside the
 *       tolerances still ends. Timed on {@link AutoContext#nanoTime()}. The follower goes on holding
 *       the pose afterwards.</li>
 *   <li><b>Interrupted or suspended:</b> holds the pose the robot was cut off at, as {@link FollowPath}
 *       does, and a turn Ivy resumes after a suspension is done on its next loop.</li>
 * </ul>
 *
 * <p>Requires {@link AutoContext#drive()}, so a turn and a path can never drive at once.
 */
public class TurnInPlace extends BaseCommand {

    private final AutoContext ctx;
    private final Pose turn;

    /** When the hold is done; a fresh one each time the turn starts. */
    private PedroPaths.TurnSettle settle;

    /** Set by a suspension, cleared by {@link #start()}, as in {@link FollowPath}. */
    private boolean suspended;

    /**
     * @param ctx  the running auto: its follower holds the turn, its drivetrain is required
     * @param turn the pose to hold, in the running alliance's frame
     */
    public TurnInPlace(AutoContext ctx, Pose turn) {
        this.ctx = ctx;
        this.turn = turn;
        addRequirement(ctx.drive());
    }

    @Override
    public void start() {
        suspended = false;
        settle = new PedroPaths.TurnSettle(turn);
        ctx.follower().hold(turn);
    }

    @Override
    public boolean done() {
        return suspended || settle.done(ctx.follower().pose(), ctx.nanoTime() / 1e9);
    }

    @Override
    public void end(EndCondition endCondition) {
        if (endCondition != EndCondition.NATURALLY && !suspended) {
            ctx.follower().hold(ctx.follower().pose());
        }
        if (endCondition == EndCondition.SUSPENDED) {
            suspended = true;
        }
    }
}
