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

package org.horizon36596.zenith;

/**
 * The robot's own clock, in nanoseconds. The only clock the runtime reads.
 *
 * <p>Each runtime's {@code WaitRobotTime} and {@code RobotTimeout} measure against this rather than the SDK's
 * {@code ElapsedTime}, because a JVM simulation steps time by a fixed tick however fast the ticks run.
 * On the robot the usual implementation is {@code System.nanoTime()}; in a headless sim it is the sim's
 * own stepped clock, so a 250 ms wait lasts 250 ms of sim time, and the same amount on every run.
 *
 * <p>Both runtimes' {@code AutoContext} extend this, so the running auto is the clock.
 */
public interface RobotClock {

    /** @return the robot's time in nanoseconds; only the difference between two readings means anything */
    long nanoTime();
}
