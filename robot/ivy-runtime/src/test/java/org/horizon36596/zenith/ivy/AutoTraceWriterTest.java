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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pedropathing.ivy.Command;

import org.horizon36596.zenith.AutoFile;
import org.junit.jupiter.api.Test;

import java.io.IOException;

/** The Ivy copy of the SolversLib runtime's AutoTraceWriterTest: the trace is the same on both. */
class AutoTraceWriterTest {

    /** Runs the demo with every step traced, and returns the trace text. */
    private static String traceDemo() throws IOException {
        final AutoTraceWriter trace = new AutoTraceWriter("demo", 0.02);
        final FakeAuto robot = new FakeAuto() {
            @Override
            public Command step(String id, Command body) {
                return trace.traced(id, body);
            }

            @Override
            void loop() {
                super.loop();
                trace.tick(nowNanos / 1e9);
            }
        };
        robot.registerCommands();
        robot.run(AutoBuilder.build(AutoFile.load(FakeAuto.fixtures(), "demo"), robot), 500);
        return trace.render();
    }

    @Test
    void recordsEveryStepThatRan() throws IOException {
        String text = traceDemo();
        assertTrue(text.contains("{ \"id\": \"toScore\", \"startS\": 0.000, \"endS\": 0.060,"), text);
        assertTrue(text.contains("\"id\": \"grab.2.2\""), text);
        assertTrue(text.contains("\"id\": \"park\""), text);
        assertTrue(text.contains("\"capabilities\": [\"steps\"]"), text);
    }

    @Test
    void twoRunsProduceTheSameTraceByteForByte() throws IOException {
        assertEquals(traceDemo(), traceDemo());
    }
}
