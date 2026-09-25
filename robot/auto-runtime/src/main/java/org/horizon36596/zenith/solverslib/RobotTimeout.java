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

import org.horizon36596.zenith.RobotClock;

import com.seattlesolvers.solverslib.command.Command;

/**
 * Gives a command a deadline measured on the robot's own clock. The only timeout the file-driven
 * runtime uses.
 *
 * <p><b>Why not {@code Command.withTimeout(millis)}.</b> It composes a SolversLib {@code WaitCommand},
 * which times itself with the SDK's {@code ElapsedTime}, the wall clock. On the robot that is the same
 * clock as everything else, so the bug is invisible. In a JVM simulation it is not: sim time is stepped
 * by a fixed tick however fast the ticks actually run, and a tick costs well under a millisecond of wall
 * time. A quarter-second {@code withTimeout} therefore expires after about thirty simulated seconds, and
 * by a different amount on every run. Found on 2026-09-21.
 *
 * <p>{@link WaitRobotTime} reads the {@link RobotClock}, so a race against it lasts the stated time in
 * both worlds.
 */
public final class RobotTimeout {

    private RobotTimeout() {}

    /**
     * {@code command}, but no longer than {@code seconds} of robot time. Whichever finishes first ends
     * the group: the winner gets {@code end(false)} and the loser {@code end(true)}, so a timed-out
     * {@link FollowPath} still holds the pose it was cut off at, and a path that arrives in time is ended
     * cleanly. It is a {@link Parallel#race}, not SolversLib's race group, which never ends the winner.
     *
     * @param command the command to bound
     * @param seconds the budget; zero or less means the command is cut off on its first loop, which is
     *                almost certainly a mistake in the file rather than an intention
     * @param clock   the robot's clock; the running {@link AutoContext} is one
     * @return the bounded command
     */
    public static Command of(Command command, double seconds, RobotClock clock) {
        return Parallel.race(command, new WaitRobotTime(Math.round(seconds * 1000.0), clock));
    }
}
