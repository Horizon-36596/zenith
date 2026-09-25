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

import org.horizon36596.zenith.RobotClock;

/**
 * Gives a command a deadline measured on the robot's own clock. The only timeout the Ivy runtime uses.
 *
 * <p>Not Ivy's {@code until(...)} with a {@code waitMs}: that wait reads the wall clock, which in a JVM
 * simulation with a stepped clock expires after a different number of loops on every run.
 * {@link WaitRobotTime} reads the {@link RobotClock}, so a race against it lasts the stated time in both
 * worlds.
 */
public final class RobotTimeout {

    private RobotTimeout() {}

    /**
     * {@code command}, but no longer than {@code seconds} of robot time. Whichever finishes first ends
     * the group: the winner is ended {@code NATURALLY} and the loser {@code INTERRUPTED}, so a timed-out
     * {@link FollowPath} still holds the pose it was cut off at, and a path that arrives in time is ended
     * cleanly. It is a {@link Parallel#race}.
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
