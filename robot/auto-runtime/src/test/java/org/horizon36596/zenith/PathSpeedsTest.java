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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Where a path's speed comes from on the robot, and the warning when nothing applies it (issue #192). */
class PathSpeedsTest {

    /** What a team's robot is to the runtime: an interface with a default and a class that replaces it. */
    interface Library {
        default int atSpeed(String path, double fraction) {
            return 0;
        }
    }

    static class Plain implements Library {
    }

    static class Capped implements Library {
        @Override
        public int atSpeed(String path, double fraction) {
            return 1;
        }
    }

    private static File fixtures() {
        try {
            return new File(PathSpeedsTest.class.getResource("/autos/slow.auto.json").toURI()).getParentFile();
        } catch (URISyntaxException problem) {
            throw new IllegalStateException(problem);
        }
    }

    private static AutoSource robotJson(final String text) {
        return new AutoSource() {
            @Override
            public InputStream open(String fileName) throws IOException {
                if (!PathSpeeds.ROBOT_FILE.equals(fileName) || text == null) {
                    throw new FileNotFoundException(fileName);
                }
                return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
            }

            @Override
            public String describe() {
                return "the test's assets";
            }
        };
    }

    private static AutoFile slow() {
        return AutoFile.loadForInit(AutoSource.directory(fixtures()), "slow");
    }

    @Test
    void aStepBelowFullSpeedIsNamedWithItsFraction() {
        String warning = PathSpeeds.unappliedWarning(slow().steps, 1.0);
        assertNotNull(warning);
        assertTrue(warning.contains("step \"creep\" (0.3) is"), warning);
        assertFalse(warning.contains("cruise"), warning);
        assertTrue(warning.contains("atSpeed()"), warning);
    }

    @Test
    void aStepWithNoSpeedOfItsOwnIsNamedWhenTheDefaultIsBelowFullSpeed() {
        String warning = PathSpeeds.unappliedWarning(slow().steps, 0.8);
        assertTrue(warning.contains("steps \"creep\" (0.3), \"cruise\" (0.8) are"), warning);
    }

    @Test
    void aRoutineAtFullSpeedHasNothingToWarnAbout() {
        assertNull(PathSpeeds.unappliedWarning(new ArrayList<AutoFile.Step>(), 0.5));
    }

    @Test
    void theDefaultIsReadFromRobotJson() {
        List<String> warnings = new ArrayList<String>();
        double fraction = PathSpeeds.defaultFromRobotFile(robotJson(
                "{\"kinematics\": {\"defaultPathSpeedFraction\": {\"value\": 0.8, \"provenance\": \"x\"}}}"), warnings);
        assertEquals(0.8, fraction);
        assertTrue(warnings.isEmpty(), warnings.toString());
    }

    @Test
    void anythingElseFallsBackToFullSpeedWithOneWarning() {
        String[] unusable = {
            null,
            "{}",
            "{\"kinematics\": {}}",
            "{\"kinematics\": {\"defaultPathSpeedFraction\": {\"value\": 0}}}",
            "{\"kinematics\": {\"defaultPathSpeedFraction\": {\"value\": 1.5}}}",
            "{\"kinematics\": {\"defaultPathSpeedFraction\": {\"value\": \"fast\"}}}",
            "not json",
        };
        for (String text : unusable) {
            List<String> warnings = new ArrayList<String>();
            assertEquals(1.0, PathSpeeds.defaultFromRobotFile(robotJson(text), warnings), String.valueOf(text));
            assertEquals(1, warnings.size(), String.valueOf(text));
            assertTrue(warnings.get(0).contains("robot.json"), warnings.get(0));
            assertTrue(warnings.get(0).contains("drives at 1.0"), warnings.get(0));
        }
    }

    @Test
    void overridesTellsADefaultFromAReplacement() {
        assertFalse(PathSpeeds.overrides(new Plain(), Library.class, "atSpeed", String.class, double.class));
        assertTrue(PathSpeeds.overrides(new Capped(), Library.class, "atSpeed", String.class, double.class));
        assertFalse(PathSpeeds.overrides(new Plain(), Library.class, "noSuchMethod"));
    }

    @Test
    void aWarningAddedAtInitShowsInTheFilesList() {
        AutoFile file = slow();
        file.addWarning("late");
        assertTrue(file.warnings.contains("late"));
    }
}
