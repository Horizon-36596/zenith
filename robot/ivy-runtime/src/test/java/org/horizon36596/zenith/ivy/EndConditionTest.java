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

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pedropathing.math.Pose;

import org.horizon36596.zenith.AutoFile;
import org.horizon36596.zenith.Json;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Collections;

/** A path's {@code endCondition} on the Ivy runtime: the SolversLib EndConditionTest's init check. */
class EndConditionTest {

    private FakeAuto robot;

    @BeforeEach
    void freshRobot() {
        robot = new FakeAuto();
        robot.registerCommands();
    }

    @Test
    void anUnknownConditionOnAPathFromCurrentIsRefusedAtInit() {
        // The path is built only when its step starts, from the live pose; its end condition is not.
        String auto = "{\"formatVersion\": 2, \"name\": \"typo\","
                + " \"start\": {\"pose\": {\"xIn\": 0, \"yIn\": 0}},"
                + " \"steps\": [{\"id\": \"go\", \"kind\": \"path\", \"endCondition\": {\"condition\": \"holdingPeice\"},"
                + " \"segments\": [{\"kind\": \"line\", \"from\": \"current\","
                + " \"to\": {\"xIn\": 24, \"yIn\": 0}}], \"heading\": {\"mode\": \"tangent\"}}]}";
        AutoFile file = AutoFile.parse(Json.parse(auto, "typo.auto.json"), "typo", Collections.<String, Pose>emptyMap());
        IllegalArgumentException problem = assertThrows(IllegalArgumentException.class,
                () -> AutoBuilder.build(file, robot));
        assertTrue(problem.getMessage().startsWith("step \"go\": "), problem.getMessage());
        assertTrue(problem.getMessage().contains("holdingPeice"), problem.getMessage());
    }
}
