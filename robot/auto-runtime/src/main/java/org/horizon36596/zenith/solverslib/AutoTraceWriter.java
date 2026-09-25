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

import org.horizon36596.zenith.AutoTrace;

import com.seattlesolvers.solverslib.command.Command;
import com.seattlesolvers.solverslib.command.CommandBase;
import com.seattlesolvers.solverslib.command.CommandGroupBase;

/**
 * Writes {@code <auto>.trace.json} for the SolversLib runtime: {@link AutoTrace}, which holds the format
 * and names no command library, plus {@link #traced}, which wraps a SolversLib command.
 *
 * <p>It is for tests. Nothing on a robot needs it, and it reads no clock: every time stamp is the sim
 * time the caller passes in.
 *
 * <h2>Using it</h2>
 * Wrap every step through {@link #traced}, which is exactly the shape of {@link ZenithRobot#step}:
 *
 * <pre>{@code
 * AutoTraceWriter trace = new AutoTraceWriter("first-auto", TICK_SECONDS);
 * // in the test's ZenithRobot:  public Command step(String id, Command body) { return trace.traced(id, body); }
 * ...each tick...
 * trace.tick(timeS);                    // stamps the clock the step records use
 * trace.pose(xIn, yIn, headingRad);     // what the robot believes
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
     * {@link ZenithRobot#step}, so a test's robot can return {@code trace.traced(id, body)} from it.
     *
     * @param id   the step's id
     * @param body the step's command; it must not already be in a command group
     * @return a command that runs {@code body} and records it
     */
    public Command traced(final String id, final Command body) {
        CommandGroupBase.requireUngrouped(body);
        return new CommandBase() {
            {
                m_requirements.addAll(body.getRequirements());
                setName(id);
            }

            @Override
            public void initialize() {
                stepStarted(id);
                body.initialize();
            }

            @Override
            public void execute() {
                body.execute();
            }

            @Override
            public boolean isFinished() {
                return body.isFinished();
            }

            @Override
            public void end(boolean interrupted) {
                body.end(interrupted);
                stepEnded(id, interrupted);
            }

            @Override
            public boolean runsWhenDisabled() {
                return body.runsWhenDisabled();
            }
        };
    }
}
