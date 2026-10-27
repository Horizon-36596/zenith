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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class ArgsTest {

    @Test
    void argIntReadsAWholeNumberAtEitherEndOfTheIntRange() {
        assertEquals(3, Args.argInt(Args.of("level", 3.0), "score", "level"));
        assertEquals(Integer.MAX_VALUE, Args.argInt(Args.of("level", 2147483647.0), "score", "level"));
        assertEquals(Integer.MIN_VALUE, Args.argInt(Args.of("level", -2147483648.0), "score", "level"));
    }

    @Test
    void argIntRefusesAWholeNumberAnIntCannotHold() {
        for (double raw : new double[] {2147483648.0, -2147483649.0, 1e20,
                Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY}) {
            IllegalArgumentException problem = assertThrows(IllegalArgumentException.class,
                    () -> Args.argInt(Args.of("level", raw), "score", "level"), "for " + raw);
            assertTrue(problem.getMessage().startsWith("score: argument \"level\""), problem.getMessage());
        }
    }

    @Test
    void argIntStillRefusesAFraction() {
        assertThrows(IllegalArgumentException.class,
                () -> Args.argInt(Args.of("level", 2.5), "score", "level"));
    }
}
