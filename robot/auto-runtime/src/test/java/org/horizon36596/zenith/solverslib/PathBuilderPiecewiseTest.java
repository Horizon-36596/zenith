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

import com.pedropathing.paths.interpolator.Interpolator;
import com.seattlesolvers.solverslib.geometry.Pose2d;
import com.seattlesolvers.solverslib.geometry.Rotation2d;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * The piecewise heading as {@link PathBuilder} hands it to Pedro: ranges clipped to a segment, their
 * ends turned into the segment's own t, and a linear range turning over its own stretch. The same
 * cases are pinned for the sim in packages/core/src/sim/pedroPath.test.ts.
 */
class PathBuilderPiecewiseTest {

    private static final double EPS = 1e-9;

    private static Pose2d[] line(double x0, double x1) {
        return new Pose2d[] {new Pose2d(x0, 0, new Rotation2d(0)), new Pose2d(x1, 0, new Rotation2d(0))};
    }

    private static AutoSpec.Heading constant(double rad) {
        return new AutoSpec.Heading("constant", rad, 0, 0, 0, 0);
    }

    private static AutoSpec.Heading linear(double from, double to) {
        return new AutoSpec.Heading("linear", 0, from, to, 0, 0);
    }

    /** Constant 0 over the first half, linear 0 to pi/2 over the second. */
    private static AutoSpec.Heading constantThenLinear() {
        List<AutoSpec.HeadingRange> ranges = new ArrayList<AutoSpec.HeadingRange>();
        ranges.add(new AutoSpec.HeadingRange(0, 0.5, constant(0)));
        ranges.add(new AutoSpec.HeadingRange(0.5, 1, linear(0, Math.PI / 2)));
        return new AutoSpec.Heading("piecewise", 0, 0, 0, 0, 0, ranges);
    }

    @Test
    void oneSegmentHoldsThenTurnsOverItsOwnRange() {
        Interpolator heading = PathBuilder.piecewiseFor(constantThenLinear(), line(0, 24), 0, 1);
        assertEquals(0, heading.interpolate(null, 0.25), EPS);
        assertEquals(0, heading.interpolate(null, 0.5), EPS);
        assertEquals(Math.PI / 4, heading.interpolate(null, 0.75), EPS);
        assertEquals(Math.PI / 2, heading.interpolate(null, 1), EPS);
    }

    @Test
    void aSecondSegmentSeesOnlyTheRangesThatCrossIt() {
        // Two equal lines: the second one is the step's 0.5 to 1, all of it the linear range.
        Interpolator second = PathBuilder.piecewiseFor(constantThenLinear(), line(24, 48), 0.5, 1);
        assertEquals(0, second.interpolate(null, 0), EPS);
        assertEquals(Math.PI / 4, second.interpolate(null, 0.5), EPS);
        assertEquals(Math.PI / 2, second.interpolate(null, 1), EPS);
        Interpolator first = PathBuilder.piecewiseFor(constantThenLinear(), line(0, 24), 0, 0.5);
        assertEquals(0, first.interpolate(null, 1), EPS);
    }

    @Test
    void aLinearRangeTurnsTheShortWay() {
        List<AutoSpec.HeadingRange> ranges = new ArrayList<AutoSpec.HeadingRange>();
        ranges.add(new AutoSpec.HeadingRange(0, 1, linear(0.1, 2 * Math.PI - 0.1)));
        AutoSpec.Heading heading = new AutoSpec.Heading("piecewise", 0, 0, 0, 0, 0, ranges);
        Interpolator interpolator = PathBuilder.piecewiseFor(heading, line(0, 24), 0, 1);
        assertEquals(0, PathBuilder.normalizeSigned(interpolator.interpolate(null, 0.5)), EPS);
    }

    @Test
    void mapsAnArcFractionToTheSegmentsOwnT() {
        assertEquals(0.3, PathBuilder.parameterAt(line(0, 10), 0.3), EPS);
        Pose2d[] curve = new Pose2d[] {new Pose2d(0, 0, new Rotation2d(0)),
                new Pose2d(0, 20, new Rotation2d(0)), new Pose2d(20, 20, new Rotation2d(0))};
        assertEquals(0.5, PathBuilder.parameterAt(curve, 0.5), 1e-6);
    }
}