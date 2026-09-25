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

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.seattlesolvers.solverslib.command.Command;
import com.seattlesolvers.solverslib.command.CommandGroupBase;
import com.seattlesolvers.solverslib.geometry.Pose2d;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import org.horizon36596.zenith.Json;

import java.util.Arrays;
import java.util.Collections;

/**
 * A path's {@code endCondition}, built as the runtime's own race. The path is ended exactly once
 * either way: {@code end(false)} when it arrives before the condition, {@code end(true)} when the
 * condition cuts it short.
 */
class EndConditionTest {

    private static final String AUTO = "{\"formatVersion\": 2, \"name\": \"cut\","
            + " \"start\": {\"pose\": {\"xIn\": 0, \"yIn\": 0}},"
            + " \"steps\": [{\"id\": \"go\", \"kind\": \"path\", \"endCondition\": {\"condition\": \"holdingPiece\"},"
            + " \"segments\": [{\"kind\": \"line\", \"from\": {\"xIn\": 0, \"yIn\": 0},"
            + " \"to\": {\"xIn\": 24, \"yIn\": 0}}], \"heading\": {\"mode\": \"tangent\"}}]}";

    private FakeAuto robot;

    @BeforeEach
    void freshRobot() {
        CommandGroupBase.clearGroupedCommands();
        robot = new FakeAuto();
        robot.registerCommands();
    }

    private Command build() {
        AutoSpec spec = AutoSpec.parse(Json.parse(AUTO, "cut.auto.json"), "cut", Collections.<String, Pose2d>emptyMap());
        return AutoBuilder.build(spec, robot);
    }

    @Test
    void aPathThatArrivesFirstIsEndedCleanly() {
        robot.run(build(), 50);
        assertEquals(Arrays.asList("path0 start", "path0 end"), robot.log);
    }

    @Test
    void aConditionThatTripsFirstInterruptsThePath() {
        Command routine = build();
        robot.holdingPiece = true;
        robot.run(routine, 50);
        assertEquals(Arrays.asList("path0 start", "path0 interrupted"), robot.log);
    }
}
