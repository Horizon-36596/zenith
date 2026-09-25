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
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pedropathing.ivy.Command;
import com.pedropathing.ivy.behaviors.EndCondition;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;
import com.pedropathing.paths.PathSegment;
import com.pedropathing.paths.interpolator.Interpolator;

import org.horizon36596.zenith.AutoFile;
import org.horizon36596.zenith.AutoSource;
import org.horizon36596.zenith.Json;
import org.horizon36596.zenith.PedroPaths;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.io.IOException;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** The Ivy copy of the SolversLib runtime's AutoBuilderTest: the same fixture, the same expectations. */
class AutoBuilderTest {

    private FakeAuto robot;

    @BeforeEach
    void freshRobot() {
        robot = new FakeAuto();
        robot.registerCommands();
    }

    private Command buildDemo() throws IOException {
        return AutoBuilder.build(AutoFile.load(FakeAuto.fixtures(), "demo"), robot);
    }

    @Test
    void wrapsEveryStepNestedOnesIncludedWithItsId() throws IOException {
        buildDemo();
        assertEquals(Arrays.asList("toScore", "score", "step3", "drive", "grab.2.1", "grab.2.2", "grab.2",
                "grab", "park", "scoreAgain", "check"), robot.stepIds);
    }

    @Test
    void runsTheRoutineInOrderOnTheRobotsClock() throws IOException {
        Command routine = buildDemo();
        // Only the first path is built at init; the second starts at "current" and is deferred.
        assertEquals(1, robot.paths.size());

        robot.run(routine, 500);

        assertEquals(Arrays.asList(
                "path0 start",
                "intakeOn",
                "path0 end",
                "score 2",
                "currentPose",
                "path1 start",
                "intakeOn",
                "path1 end"), robot.log);
        assertEquals(Arrays.asList(0.8, 0.6), robot.speeds);
    }

    @Test
    void takesTheBranchTheConditionPicks() throws IOException {
        robot.holdingPiece = true;
        robot.run(buildDemo(), 500);
        assertTrue(robot.log.contains("score 1"), robot.log.toString());
    }

    @Test
    void mirrorsFilePosesThroughTheContextOnly() throws IOException {
        robot.mirror = true;
        buildDemo();
        assertEquals(24.0, robot.paths.get(0).endPose().x(), 1e-9);
        assertEquals(36.0, robot.paths.get(0).endPose().y(), 1e-9);
    }

    @Test
    void mirrorsHeadingsThroughTheSameContextAsPoses() throws IOException {
        robot.mirror = true;
        robot.run(buildDemo(), 500);
        // The deferred path turns linearly from 0 to pi/2 on RED; through the fake's point symmetry it
        // turns the same quarter turn, the same way, from a half turn.
        PathSegment drive = robot.paths.get(1).getSegments().get(0);
        assertEquals(PedroPaths.normalize(Math.PI), drive.heading(0), 1e-9);
        assertEquals(PedroPaths.normalize(Math.PI + 1.5708 / 2), drive.heading(0.5), 1e-9);
        assertEquals(PedroPaths.normalize(Math.PI + 1.5708), drive.heading(1), 1e-9);
    }

    @Test
    void aMirrorThatForgetsHeadingsIsRefusedAtInit() {
        FakeAuto forgetful = new FakeAuto() {
            @Override
            public Pose alliance(Pose filePose) {
                return new Pose(filePose.x(), -filePose.y(), filePose.heading());
            }
        };
        forgetful.registerCommands();
        IllegalStateException problem = assertThrows(IllegalStateException.class,
                () -> AutoBuilder.build(AutoFile.load(FakeAuto.fixtures(), "demo"), forgetful));
        assertTrue(problem.getMessage().contains("turns headings differently from positions"),
                problem.getMessage());
    }

    @Test
    void anUnregisteredCommandNamesTheStepAndWhatIsRegistered() {
        Json root = Json.parse("{\"formatVersion\": 2, \"start\": {\"pose\": {\"xIn\": 0, \"yIn\": 0}},"
                + " \"steps\": [{\"id\": \"volley\", \"kind\": \"command\", \"name\": \"scor\"}]}", "typo.auto.json");
        AutoFile file = AutoFile.parse(root, "typo", Collections.<String, Pose>emptyMap());
        IllegalArgumentException problem = assertThrows(IllegalArgumentException.class,
                () -> AutoBuilder.build(file, robot));
        assertTrue(problem.getMessage().startsWith("step \"volley\": "), problem.getMessage());
        assertTrue(problem.getMessage().contains("[intakeOn, score]"), problem.getMessage());
    }

    @Test
    void waitRobotTimeWaitsOnTheRobotClockNotTheWallClock() {
        WaitRobotTime wait = new WaitRobotTime(250, robot);
        robot.run(wait, 100);
        assertEquals(13 * 20_000_000L, robot.nowNanos);
    }

    @Test
    void robotTimeoutCutsANeverEndingCommandOff() {
        final EndCondition[] ended = {null};
        Command forever = new FakeAuto.Recorder() {
            @Override
            public void end(EndCondition endCondition) {
                ended[0] = endCondition;
            }
        };
        robot.run(RobotTimeout.of(forever, 0.1, robot), 100);
        assertEquals(5 * 20_000_000L, robot.nowNanos);
        assertEquals(EndCondition.INTERRUPTED, ended[0]);
    }

    @Test
    void anEmptyElseArmFinishesRatherThanWaitingForever() {
        Json root = Json.parse("{\"formatVersion\": 2, \"start\": {\"pose\": {\"xIn\": 0, \"yIn\": 0}},"
                + " \"steps\": [{\"id\": \"maybe\", \"kind\": \"branch\", \"condition\": \"holdingPiece\","
                + " \"then\": [{\"kind\": \"command\", \"name\": \"intakeOn\"}]}]}", "empty-else.auto.json");
        AutoFile file = AutoFile.parse(root, "empty-else", Collections.<String, Pose>emptyMap());
        robot.run(AutoBuilder.build(file, robot), 10);
        assertEquals(Collections.<String>emptyList(), robot.log);
    }

    /**
     * The conformance suite's {@code headings} fixture: a two-segment path whose piecewise heading holds
     * 0 until a quarter of the way, turns to pi/2 by three quarters, then follows the tangent.
     */
    @Test
    void aPiecewiseHeadingIsPedroPathsPiecewiseForOnEachSegment() throws Exception {
        AutoSource conformance = AutoSource.directory(new File(AutoBuilderTest.class
                .getResource("/conformance/waypoints.json").toURI()).getParentFile());
        AutoFile file = AutoFile.load(conformance, "headings");
        NamedCommands.register("instant", (args, ctx) -> robot.instant("instant", FakeAuto.INTAKE));
        AutoBuilder.build(file, robot);
        AutoFile.PathStep step = (AutoFile.PathStep) file.steps.get(0);
        assertEquals("piecewise", step.heading.mode);

        Path path = robot.paths.get(0);
        List<PathSegment> segments = path.getSegments();
        assertEquals(2, segments.size());
        // Waypoints a, b and c; the two lines are the same length, so each is half the step.
        Pose[][] points = {
            {new Pose(-48, -48, 0), new Pose(-24, -48, 0)},
            {new Pose(-24, -48, 0), new Pose(-24, -24, 0)},
        };
        for (int i = 0; i < 2; i++) {
            Interpolator expected = PedroPaths.piecewiseFor(step.heading, points[i], i * 0.5, (i + 1) * 0.5);
            for (int k = 0; k <= 20; k++) {
                double t = k / 20.0;
                assertEquals(expected.interpolate(segments.get(i).curve, t), segments.get(i).heading(t), 1e-9,
                        "segment " + i + " at t " + t);
            }
        }
        // And the numbers the ranges mean, independent of piecewiseFor: held at 0 an eighth of the way,
        // a quarter of the turn at three eighths, and the tangent of the second line (pi/2) at its end.
        assertEquals(0, segments.get(0).heading(0.25), 1e-9);
        assertEquals(1.5708 / 4, segments.get(0).heading(0.75), 1e-6);
        assertEquals(Math.PI / 2, segments.get(1).heading(1), 1e-6);
    }
}
