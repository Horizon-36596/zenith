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
import com.pedropathing.ivy.behaviors.BlockedBehavior;
import com.pedropathing.ivy.behaviors.ConflictBehavior;
import com.pedropathing.ivy.behaviors.EndCondition;
import com.pedropathing.ivy.behaviors.InterruptedBehavior;

import org.horizon36596.zenith.AutoTrace;

import java.util.Set;

/**
 * Writes {@code <auto>.trace.json} for the Ivy runtime: {@link AutoTrace}, which holds the format and
 * names no command library, plus {@link #traced}, which wraps an Ivy command. A trace of the same run is
 * the same file whichever runtime wrote it.
 *
 * <p>It is for tests. Nothing on a robot needs it, and it reads no clock: every time stamp is the sim
 * time the caller passes in.
 *
 * <pre>{@code
 * AutoTraceWriter trace = new AutoTraceWriter("first-auto", TICK_SECONDS);
 * // in the test's ZenithRobot:  public Command step(String id, Command body) { return trace.traced(id, body); }
 * ...each tick...
 * trace.tick(timeS);
 * trace.pose(xIn, yIn, headingRad);
 * ...afterwards...
 * trace.write(new File("build/sim/first-auto.trace.json"));
 * }</pre>
 */
public final class AutoTraceWriter extends AutoTrace {

    /**
     * @param autoName the auto's file stem, written into the trace
     * @param tickS    the sim's fixed tick, seconds
     */
    public AutoTraceWriter(String autoName, double tickS) {
        super(autoName, tickS);
    }

    /**
     * {@code body}, reporting its start and end to this trace. The same shape as
     * {@link ZenithRobot#step}, so a test's robot can return {@code trace.traced(id, body)} from it. A
     * suspension is not an end, so it is not recorded; the step's record closes when it really ends.
     *
     * @param id   the step's id
     * @param body the step's command
     * @return a command that runs {@code body} and records it
     */
    public Command traced(final String id, final Command body) {
        return new Command() {
            @Override
            public Set<Object> requirements() {
                return body.requirements();
            }

            @Override
            public int priority() {
                return body.priority();
            }

            @Override
            public InterruptedBehavior interruptedBehavior() {
                return body.interruptedBehavior();
            }

            @Override
            public ConflictBehavior conflictBehavior() {
                return body.conflictBehavior();
            }

            @Override
            public BlockedBehavior blockedBehavior() {
                return body.blockedBehavior();
            }

            @Override
            public void start() {
                stepStarted(id);
                body.start();
            }

            @Override
            public void execute() {
                body.execute();
            }

            @Override
            public boolean done() {
                return body.done();
            }

            @Override
            public void end(EndCondition endCondition) {
                body.end(endCondition);
                if (endCondition != EndCondition.SUSPENDED) {
                    stepEnded(id, endCondition == EndCondition.INTERRUPTED);
                }
            }
        };
    }
}
