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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.seattlesolvers.solverslib.geometry.Pose2d;
import com.seattlesolvers.solverslib.geometry.Rotation2d;

import org.junit.jupiter.api.Test;

import org.horizon36596.zenith.Json;

import java.io.IOException;
import java.util.Collections;
import java.util.Map;

class AutoSpecTest {

    private static AutoSpec demo() throws IOException {
        return AutoSpec.load(FakeAuto.fixtures(), "demo");
    }

    @Test
    void loadsTheFileAndResolvesWaypoints() throws IOException {
        AutoSpec spec = demo();
        assertEquals("demo", spec.name);
        assertEquals("Demo Auto", spec.title);
        assertEquals("RED", spec.alliance);
        assertEquals(-60.0, spec.startPose.getX());
        assertEquals(-36.0, spec.startPose.getY());
        assertEquals(5, spec.steps.size());

        AutoSpec.PathStep toScore = (AutoSpec.PathStep) spec.steps.get(0);
        assertEquals(-24.0, toScore.segments.get(0).to.getX());
        assertEquals(0.8, toScore.speedFraction.doubleValue());
        assertEquals(3.0, toScore.timeoutS.doubleValue());
        assertEquals(1, toScore.markers.size());
        assertEquals(18.0, toScore.markers.get(0).distanceAlongIn(36.0));
    }

    @Test
    void namesStepsWithoutAnIdByPosition() throws IOException {
        AutoSpec spec = demo();
        assertEquals("step3", spec.steps.get(2).id);
        AutoSpec.ParallelStep grab = (AutoSpec.ParallelStep) spec.steps.get(3);
        assertEquals("drive", grab.steps.get(0).id);
        assertEquals("grab.2", grab.steps.get(1).id);
        AutoSpec.SequenceStep inner = (AutoSpec.SequenceStep) grab.steps.get(1);
        assertEquals("grab.2.1", inner.steps.get(0).id);
        assertEquals("grab.2.2", inner.steps.get(1).id);
    }

    @Test
    void leavesAMissingSpeedForTheRobotToDecide() throws IOException {
        AutoSpec.ParallelStep grab = (AutoSpec.ParallelStep) demo().steps.get(3);
        AutoSpec.PathStep drive = (AutoSpec.PathStep) grab.steps.get(0);
        assertNull(drive.speedFraction);
        assertTrue(drive.startsFromCurrentPose());
    }

    @Test
    void mirrorsOnlyIntoTheOtherAlliance() throws IOException {
        AutoSpec spec = demo();
        assertFalse(spec.mirrorsInto("RED"));
        assertTrue(spec.mirrorsInto("BLUE"));
    }

    @Test
    void refusesANewerFormatVersionAndSaysWhichHalfToUpdate() {
        Json root = Json.parse("{\"formatVersion\": 99, \"start\": {\"pose\": {\"xIn\": 0, \"yIn\": 0}},"
                + " \"steps\": [{\"kind\": \"wait\", \"seconds\": 1}]}", "future.auto.json");
        IllegalStateException problem = assertThrows(IllegalStateException.class,
                () -> AutoSpec.parse(root, "future", Collections.<String, Pose2d>emptyMap()));
        assertTrue(problem.getMessage().contains("formatVersion 99"), problem.getMessage());
        assertTrue(problem.getMessage().contains("zenith-runtime"), problem.getMessage());
    }

    @Test
    void anUnknownWaypointNamesTheStep() {
        Json root = Json.parse("{\"formatVersion\": 3, \"start\": {\"pose\": {\"xIn\": 0, \"yIn\": 0}},"
                + " \"steps\": [{\"id\": \"go\", \"kind\": \"path\", \"heading\": {\"mode\": \"tangent\"},"
                + " \"segments\": [{\"kind\": \"line\", \"from\": \"current\", \"to\": {\"ref\": \"nowhere\"}}]}]}",
                "bad.auto.json");
        Map<String, Pose2d> none = Collections.emptyMap();
        IllegalArgumentException problem = assertThrows(IllegalArgumentException.class,
                () -> AutoSpec.parse(root, "bad", none));
        assertTrue(problem.getMessage().contains("(step \"go\")"), problem.getMessage());
        assertTrue(problem.getMessage().contains("nowhere"), problem.getMessage());
    }

    @Test
    void keepsEveryHeadingAsTheFileWroteIt() {
        // Pedro's Pose would normalise -pi/2 to 3 pi/2; the poses a team reads carry the file's number.
        Json root = Json.parse("{\"formatVersion\": 3,"
                + " \"start\": {\"pose\": {\"xIn\": 0, \"yIn\": 0, \"headingRad\": -1.5708}},"
                + " \"steps\": [{\"id\": \"go\", \"kind\": \"path\", \"heading\": {\"mode\": \"tangent\"},"
                + " \"segments\": [{\"kind\": \"line\", \"from\": {\"xIn\": 0, \"yIn\": 0, \"headingRad\": -3},"
                + " \"to\": {\"ref\": \"there\"}}]}]}", "negative.auto.json");
        Map<String, Pose2d> waypoints = Collections.singletonMap("there",
                new Pose2d(24, 0, new Rotation2d(-0.5)));
        AutoSpec spec = AutoSpec.parse(root, "negative", waypoints);
        assertEquals(-1.5708, spec.startPose.getHeading());
        AutoSpec.Segment segment = ((AutoSpec.PathStep) spec.steps.get(0)).segments.get(0);
        assertEquals(-3.0, segment.from.getHeading());
        assertEquals(-0.5, segment.to.getHeading());
    }

    private static Json pathWithHeading(String heading) {
        return Json.parse("{\"formatVersion\": 3, \"start\": {\"pose\": {\"xIn\": 0, \"yIn\": 0}},"
                + " \"steps\": [{\"id\": \"go\", \"kind\": \"path\", \"heading\": " + heading + ","
                + " \"segments\": [{\"kind\": \"line\", \"from\": {\"xIn\": 0, \"yIn\": 0},"
                + " \"to\": {\"xIn\": 24, \"yIn\": 0}}]}]}", "piecewise.auto.json");
    }

    @Test
    void readsAPiecewiseHeadingRangeByRange() {
        Json root = pathWithHeading("{\"mode\": \"piecewise\", \"ranges\": ["
                + "{\"startT\": 0, \"endT\": 0.4, \"heading\": {\"mode\": \"constant\", \"headingRad\": 0.5}},"
                + "{\"startT\": 0.4, \"endT\": 1, \"heading\": {\"mode\": \"linear\", \"fromRad\": 0.5, \"toRad\": 1.5}}]}");
        AutoSpec spec = AutoSpec.parse(root, "piecewise", Collections.<String, Pose2d>emptyMap());
        AutoSpec.Heading heading = ((AutoSpec.PathStep) spec.steps.get(0)).heading;
        assertEquals("piecewise", heading.mode);
        assertEquals(2, heading.ranges.size());
        assertEquals(0.4, heading.ranges.get(0).endT);
        assertEquals("constant", heading.ranges.get(0).heading.mode);
        assertEquals(0.5, heading.ranges.get(0).heading.headingRad);
        assertEquals("linear", heading.ranges.get(1).heading.mode);
        assertEquals(1.5, heading.ranges.get(1).heading.toRad);
    }

    @Test
    void refusesPiecewiseRangesWithAGapAndNamesTheRange() {
        Json root = pathWithHeading("{\"mode\": \"piecewise\", \"ranges\": ["
                + "{\"startT\": 0, \"endT\": 0.4, \"heading\": {\"mode\": \"tangent\"}},"
                + "{\"startT\": 0.5, \"endT\": 1, \"heading\": {\"mode\": \"tangent\"}}]}");
        IllegalArgumentException problem = assertThrows(IllegalArgumentException.class,
                () -> AutoSpec.parse(root, "piecewise", Collections.<String, Pose2d>emptyMap()));
        assertTrue(problem.getMessage().contains("range 2"), problem.getMessage());
        assertTrue(problem.getMessage().contains("(step \"go\")"), problem.getMessage());
    }

    @Test
    void refusesPiecewiseRangesThatStopShortOfOne() {
        Json root = pathWithHeading("{\"mode\": \"piecewise\", \"ranges\": ["
                + "{\"startT\": 0, \"endT\": 0.9, \"heading\": {\"mode\": \"tangent\"}}]}");
        IllegalArgumentException problem = assertThrows(IllegalArgumentException.class,
                () -> AutoSpec.parse(root, "piecewise", Collections.<String, Pose2d>emptyMap()));
        assertTrue(problem.getMessage().contains("must end at 1"), problem.getMessage());
    }

    @Test
    void refusesAPiecewiseRangeInsideAPiecewiseRange() {
        Json root = pathWithHeading("{\"mode\": \"piecewise\", \"ranges\": ["
                + "{\"startT\": 0, \"endT\": 1, \"heading\": {\"mode\": \"piecewise\", \"ranges\": []}}]}");
        assertThrows(IllegalArgumentException.class,
                () -> AutoSpec.parse(root, "piecewise", Collections.<String, Pose2d>emptyMap()));
    }

    @Test
    void aMissingFileSaysWhereItLooked() {
        IllegalStateException problem = assertThrows(IllegalStateException.class,
                () -> AutoSpec.loadForInit(FakeAuto.fixtures(), "absent"));
        assertTrue(problem.getMessage().contains("absent"), problem.getMessage());
        assertTrue(problem.getMessage().contains("zenith deploy"), problem.getMessage());
    }
}
