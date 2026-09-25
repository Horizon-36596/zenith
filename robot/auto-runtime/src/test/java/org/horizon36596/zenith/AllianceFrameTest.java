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
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pedropathing.math.Pose;
import com.pedropathing.paths.PathSegment;

import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.UnaryOperator;

/**
 * {@link AllianceFrame} and {@link PedroPaths#build(AutoFile.PathStep, AllianceFrame, Pose)}: a path run
 * as the other alliance faces, at every point along it, the mirror of the way the file's own path faces
 * at the same point. That is the whole contract, so it is checked for every heading mode under two point
 * symmetries and two reflections, rather than number by number.
 */
class AllianceFrameTest {

    private static final double EPSILON = 1e-7;

    private static final UnaryOperator<Pose> IDENTITY = new UnaryOperator<Pose>() {
        @Override
        public Pose apply(Pose pose) {
            return pose;
        }
    };

    /** The mirrors a team might write, by what they are. */
    static Map<String, UnaryOperator<Pose>> mirrors() {
        Map<String, UnaryOperator<Pose>> mirrors = new LinkedHashMap<String, UnaryOperator<Pose>>();
        mirrors.put("point symmetry", p -> new Pose(-p.x(), -p.y(), p.heading() + Math.PI));
        // The same symmetry in Pedro's own frame, whose origin is a corner of the 144 in field.
        mirrors.put("point symmetry about (72, 72)", p -> new Pose(144 - p.x(), 144 - p.y(), p.heading() + Math.PI));
        mirrors.put("reflection across x", p -> new Pose(p.x(), -p.y(), -p.heading()));
        mirrors.put("reflection across y", p -> new Pose(-p.x(), p.y(), Math.PI - p.heading()));
        return mirrors;
    }

    static AutoFile.Heading heading(String mode) {
        return new AutoFile.Heading(mode, 0, 0, 0, 0, 0);
    }

    static AutoFile.Heading constant(double rad) {
        return new AutoFile.Heading("constant", rad, 0, 0, 0, 0);
    }

    static AutoFile.Heading linear(double fromRad, double toRad) {
        return new AutoFile.Heading("linear", 0, fromRad, toRad, 0, 0);
    }

    static AutoFile.Heading facePoint(double xIn, double yIn) {
        return new AutoFile.Heading("facePoint", 0, 0, 0, xIn, yIn);
    }

    static AutoFile.Heading piecewise(AutoFile.HeadingRange... ranges) {
        return new AutoFile.Heading("piecewise", 0, 0, 0, 0, 0, Arrays.asList(ranges));
    }

    static AutoFile.HeadingRange range(double startT, double endT, AutoFile.Heading inner) {
        return new AutoFile.HeadingRange(startT, endT, inner);
    }

    /** Every heading mode, with numbers a mirror has to move, and piecewise ranges of every inner mode. */
    static Map<String, AutoFile.Heading> headings() {
        Map<String, AutoFile.Heading> headings = new LinkedHashMap<String, AutoFile.Heading>();
        headings.put("tangent", heading("tangent"));
        headings.put("tangentReversed", heading("tangentReversed"));
        headings.put("constant", constant(0.7));
        headings.put("linear, 270 degrees over two segments", linear(-2.3562, 2.3562));
        headings.put("linear, clockwise", linear(1, -0.5));
        headings.put("facePoint", facePoint(-60, 12));
        headings.put("piecewise with a linear inner", piecewise(
                range(0, 0.3, constant(-1)),
                range(0.3, 0.7, linear(0.5, 2.5)),
                range(0.7, 0.85, facePoint(30, -30)),
                range(0.85, 1, heading("tangentReversed"))));
        headings.put("piecewise ending on the tangent", piecewise(
                range(0, 0.6, linear(-3, -1.2)),
                range(0.6, 1, heading("tangent"))));
        return headings;
    }

    /** A line then a curve, of different lengths, so every linear share and piecewise clip is uneven. */
    static AutoFile.PathStep step(AutoFile.Heading heading) {
        List<AutoFile.Segment> segments = Arrays.asList(
                new AutoFile.Segment("line", new Pose(-48, -48, 0), Collections.<Pose>emptyList(),
                        new Pose(-24, -48, 0)),
                new AutoFile.Segment("bezier", new Pose(-24, -48, 0), Collections.singletonList(new Pose(0, -36, 0)),
                        new Pose(-24, -12, 0)));
        return new AutoFile.PathStep("go", null, segments, heading, null,
                Collections.<AutoFile.Marker>emptyList(), null);
    }

    static boolean sameAngle(double a, double b) {
        return Math.abs(PedroPaths.normalizeSigned(a - b)) < EPSILON;
    }

    @TestFactory
    List<DynamicTest> everyModeFacesTheMirroredWayAlongTheMirroredPath() {
        List<DynamicTest> tests = new ArrayList<DynamicTest>();
        for (final Map.Entry<String, UnaryOperator<Pose>> mirror : mirrors().entrySet()) {
            for (final Map.Entry<String, AutoFile.Heading> heading : headings().entrySet()) {
                tests.add(DynamicTest.dynamicTest(heading.getKey() + ", " + mirror.getKey(), () -> {
                    AutoFile.PathStep step = step(heading.getValue());
                    List<PathSegment> plain = PedroPaths.build(step, AllianceFrame.of(IDENTITY), null)
                            .path.getSegments();
                    List<PathSegment> mirrored = PedroPaths.build(step, AllianceFrame.of(mirror.getValue()), null)
                            .path.getSegments();
                    assertEquals(plain.size(), mirrored.size());
                    for (int i = 0; i < plain.size(); i++) {
                        for (int k = 0; k <= 64; k++) {
                            double t = k / 64.0;
                            Pose expected = mirror.getValue().apply(plain.get(i).get(t));
                            Pose actual = mirrored.get(i).get(t);
                            String where = "segment " + i + " at t " + t + ": expected " + expected + ", got " + actual;
                            assertEquals(expected.x(), actual.x(), EPSILON, where);
                            assertEquals(expected.y(), actual.y(), EPSILON, where);
                            assertTrue(sameAngle(expected.heading(), actual.heading()), where);
                        }
                    }
                }));
            }
        }
        return tests;
    }

    /** The heading turned through along the whole step, summed sample by sample. */
    static double turnedThrough(AutoFile.PathStep step, AllianceFrame frame) {
        double turned = 0;
        Double previous = null;
        for (PathSegment segment : PedroPaths.build(step, frame, null).path.getSegments()) {
            for (int k = 0; k <= 64; k++) {
                double heading = segment.heading(k / 64.0);
                if (previous != null) {
                    turned += PedroPaths.normalizeSigned(heading - previous);
                }
                previous = heading;
            }
        }
        return turned;
    }

    @Test
    void aLinearSweepKeepsItsSizeAndTurnsTheWayTheMirrorTurns() {
        // Two lines of the same length, so each carries 135 degrees of the 270 degree sweep.
        List<AutoFile.Segment> segments = Arrays.asList(
                new AutoFile.Segment("line", new Pose(-48, -48, 0), Collections.<Pose>emptyList(), new Pose(-24, -48, 0)),
                new AutoFile.Segment("line", new Pose(-24, -48, 0), Collections.<Pose>emptyList(), new Pose(-24, -24, 0)));
        AutoFile.PathStep step = new AutoFile.PathStep("sweep", null, segments, linear(-2.3562, 2.3562), null,
                Collections.<AutoFile.Marker>emptyList(), null);
        assertEquals(4.7124, turnedThrough(step, AllianceFrame.of(IDENTITY)), 1e-6);
        Map<String, UnaryOperator<Pose>> mirrors = mirrors();
        assertEquals(4.7124, turnedThrough(step, AllianceFrame.of(mirrors.get("point symmetry"))), 1e-6,
                "a point symmetry keeps a counter-clockwise sweep counter-clockwise");
        assertEquals(-4.7124, turnedThrough(step, AllianceFrame.of(mirrors.get("reflection across x"))), 1e-6,
                "a reflection turns it clockwise, by the same amount");
        assertEquals(-4.7124, turnedThrough(step, AllianceFrame.of(mirrors.get("reflection across y"))), 1e-6);
    }

    @Test
    void theMirroredNumbersAreTheOnesTheEditorWrites() {
        AllianceFrame point = AllianceFrame.of(mirrors().get("point symmetry"));
        assertFalse(point.reversesTurns());
        assertEquals(0.7 - Math.PI, point.heading(0.7), 1e-12);
        AutoFile.Heading sweep = point.heading(linear(-2.3562, 2.3562));
        assertEquals(-2.3562 + Math.PI, sweep.fromRad, 1e-12);
        assertEquals(4.7124, sweep.toRad - sweep.fromRad, 1e-12, "the sweep is left unwrapped");
        AutoFile.Heading face = point.heading(facePoint(-60, 12));
        assertEquals(60, face.pointXIn, 0);
        assertEquals(-12, face.pointYIn, 0);

        AllianceFrame reflection = AllianceFrame.of(mirrors().get("reflection across x"));
        assertTrue(reflection.reversesTurns());
        assertEquals(-0.7, reflection.heading(0.7), 1e-12);
        AutoFile.Heading clockwise = reflection.heading(linear(-2.3562, 2.3562));
        assertEquals(2.3562, clockwise.fromRad, 1e-12);
        assertEquals(-4.7124, clockwise.toRad - clockwise.fromRad, 1e-12);

        AutoFile.Heading ranges = point.heading(headings().get("piecewise with a linear inner"));
        assertEquals(4, ranges.ranges.size());
        assertEquals(0.3, ranges.ranges.get(1).startT, 0);
        assertEquals(0.7, ranges.ranges.get(1).endT, 0);
        assertEquals(2.0, ranges.ranges.get(1).heading.toRad - ranges.ranges.get(1).heading.fromRad, 1e-12);
    }

    @Test
    void aFrameThatMirrorsNothingHandsTheFileBackUnchanged() {
        AllianceFrame identity = AllianceFrame.of(IDENTITY);
        for (AutoFile.Heading heading : headings().values()) {
            assertSame(heading, identity.heading(heading));
        }
        assertEquals(3.5, identity.heading(3.5), 0);
        // A frame that only moves the field, as a team's own offset might, turns no heading either.
        AllianceFrame shifted = AllianceFrame.of(p -> new Pose(p.x() + 72, p.y() + 72, p.heading()));
        AutoFile.Heading linear = linear(-2.3562, 2.3562);
        assertSame(linear, shifted.heading(linear));
    }

    @Test
    void aMirrorThroughARotationGivesTheSameNumbersAsOneWrittenWithPlusPi() {
        // What a SolversLib mirror does to a heading on its way through Rotation2d and back.
        AllianceFrame viaAtan2 = AllianceFrame.of(p -> {
            double h = p.heading() + Math.PI;
            return new Pose(-p.x(), -p.y(), Math.atan2(Math.sin(h), Math.cos(h)));
        });
        AllianceFrame plusPi = AllianceFrame.of(mirrors().get("point symmetry"));
        for (double rad : new double[] {0, 0.7, -1.2, 3.1416, -3.1416, 2.3562}) {
            assertEquals(plusPi.heading(rad), viaAtan2.heading(rad), 0, "at " + rad);
        }
    }

    @Test
    void aMirrorThatForgetsToTurnHeadingsIsRefused() {
        IllegalStateException problem = assertThrows(IllegalStateException.class,
                () -> AllianceFrame.of(p -> new Pose(p.x(), -p.y(), p.heading())));
        assertTrue(problem.getMessage().contains("ZenithRobot.mirror turns headings differently from positions"),
                problem.getMessage());
        // A point symmetry that forgets the half turn is caught the same way.
        assertThrows(IllegalStateException.class, () -> AllianceFrame.of(p -> new Pose(-p.x(), -p.y(), p.heading())));
    }

    @Test
    void aMirrorThatFoldsTheFieldOntoALineIsRefused() {
        IllegalStateException problem = assertThrows(IllegalStateException.class,
                () -> AllianceFrame.of(p -> new Pose(p.x(), 0, p.heading())));
        assertTrue(problem.getMessage().contains("do not span the field"), problem.getMessage());
    }
}
