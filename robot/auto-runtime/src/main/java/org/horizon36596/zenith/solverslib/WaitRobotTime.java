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

import com.seattlesolvers.solverslib.command.CommandBase;

/**
 * Does nothing for a stated time, measured on the robot's own clock ({@link RobotClock}), then
 * finishes. The runtime's replacement for SolversLib's {@code WaitCommand}.
 *
 * <p><b>Why not {@code WaitCommand}.</b> It times itself with the SDK's {@code ElapsedTime}, which reads
 * {@code System.nanoTime()}, the wall clock. On the robot that is the same clock as everything else. In
 * a JVM simulation it is not: the sim's clock is stepped by a fixed tick however fast the ticks actually
 * run, and a tick takes well under a millisecond of wall time. A {@code WaitCommand} of 250 ms therefore
 * lasted about thirty simulated seconds in a headless auto test (measured on 2026-09-21), and its length
 * changed from run to run. Reading the {@link RobotClock} instead means this command takes 250 ms of sim
 * time in the sim and 250 ms of real time on the robot.
 */
public final class WaitRobotTime extends CommandBase {

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
        setName("WaitRobotTime: " + millis + " milliseconds");
    }

    @Override
    public void initialize() {
        startNanos = clock.nanoTime();
    }

    @Override
    public boolean isFinished() {
        return clock.nanoTime() - startNanos >= durationNanos;
    }

    @Override
    public boolean runsWhenDisabled() {
        return true;
    }
}
