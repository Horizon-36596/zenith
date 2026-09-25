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

import java.util.Arrays;

class JsonTest {

    @Test
    void readsObjectsInFileOrder() {
        Json root = Json.parse("{\"b\": 1, \"a\": [true, \"x\", null], \"c\": {\"d\": -2.5e1}}", "t.json");
        assertEquals(Arrays.asList("b", "a", "c"), root.keys());
        assertEquals(1.0, root.num("b"));
        assertEquals(3, root.get("a").size());
        assertTrue(root.get("a").at(0).bool());
        assertEquals("x", root.get("a").at(1).text());
        assertEquals(-25.0, root.get("c").num("d"));
    }

    @Test
    void aWrongTypeNamesItsPath() {
        Json root = Json.parse("{\"start\": {\"pose\": {\"xIn\": \"left\"}}}", "demo.auto.json");
        IllegalArgumentException problem = assertThrows(IllegalArgumentException.class,
                () -> root.get("start").get("pose").num("xIn"));
        assertTrue(problem.getMessage().contains("start.pose.xIn"), problem.getMessage());
    }

    @Test
    void refusesDuplicateKeysTrailingCommasAndComments() {
        assertThrows(IllegalArgumentException.class, () -> Json.parse("{\"a\": 1, \"a\": 2}", "t.json"));
        assertThrows(IllegalArgumentException.class, () -> Json.parse("[1, 2,]", "t.json"));
        assertThrows(IllegalArgumentException.class, () -> Json.parse("{} // no", "t.json"));
        assertThrows(IllegalArgumentException.class, () -> Json.parse("[01]", "t.json"));
    }
}
