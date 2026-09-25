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

import org.horizon36596.zenith.RobotClock;

/**
 * Does nothing for a stated time, measured on the robot's own clock ({@link RobotClock}), then
 * finishes. The Ivy runtime's replacement for Ivy's {@code Commands.waitMs}.
 *
 * <p><b>Why not {@code Commands.waitMs}.</b> It reads {@code System.currentTimeMillis()}, the wall clock.
 * On the robot that is the same clock as everything else. In a JVM simulation it is not: the sim's clock
 * is stepped by a fixed tick however fast the ticks actually run, so a wall-clock wait lasts a different
 * number of sim loops on every run. Reading the {@link RobotClock} instead means
 * this command takes 250 ms of sim time in the sim and 250 ms of real time on the robot, exactly as the
 * SolversLib runtime's {@code WaitRobotTime} does.
 */
public final class WaitRobotTime extends BaseCommand {

    private final RobotClock clock;
    private final long durationNanos;
    private long startNanos;

    /**
     * @param millis how long to wait, milliseconds, on the robot's clock
     * @param clock  the robot's clock; the running {@link AutoContext} is one
     */
    public WaitRobotTime(long millis, RobotClock clock) {
        this.clock = clock;
        this.durationNanos = Math.max(0L, millis) * 1_000_000L;
    }

    @Override
    public void start() {
        startNanos = clock.nanoTime();
    }

    @Override
    public boolean done() {
        return clock.nanoTime() - startNanos >= durationNanos;
    }
}
