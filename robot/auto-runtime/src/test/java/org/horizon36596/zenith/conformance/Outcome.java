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

package org.horizon36596.zenith.conformance;

import org.horizon36596.zenith.AutoTrace;

import java.util.List;

/** What one run of an auto produced: the world's log, the trace, and what it threw, if anything. */
public final class Outcome {

    public final World world;
    public final AutoTrace trace;

    /** The exception the OpMode saw, or {@code null} when it ran to the end of its loops. */
    public RuntimeException thrown;

    /** Ivy only: whether the routine was still in the scheduler after the OpMode stopped. */
    public boolean routineStillScheduled;

    Outcome(World world, AutoTrace trace) {
        this.world = world;
        this.trace = trace;
    }

    void threw(RuntimeException problem) {
        thrown = problem;
        world.event("threw " + problem.getClass().getSimpleName() + ": " + problem.getMessage());
    }

    /** @return the log, one event per line */
    public List<String> log() {
        return world.log;
    }
}
