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

import com.pedropathing.api.Paths;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;
import com.pedropathing.paths.curves.Curve;
import com.pedropathing.paths.interpolator.Interpolator;
import com.pedropathing.paths.interpolator.PiecewiseInterpolator;

import java.util.ArrayList;
import java.util.List;
import java.util.function.UnaryOperator;

/**
 * Turns a file's {@code path} step into a Pedro v3 {@link Path}, and measures it. Both runtimes build
 * their paths here, so a path is the same Pedro object whichever command library drives it.
 *
 * <h2>The mapping</h2>
 * One file segment is one Pedro path; several become one compound path through
 * {@code Paths.path(...)}, so the whole step is a single path-following command. It uses these calls:
 *
 * <table>
 *   <tr><th>file</th><th>Pedro</th></tr>
 *   <tr><td>{@code line}</td><td>{@code Paths.line(a, b)}</td></tr>
 *   <tr><td>{@code bezier}</td><td>{@code Paths.curve(a, c1, ..., b)}</td></tr>
 *   <tr><td>{@code tangent}</td><td>{@code .tangent()}</td></tr>
 *   <tr><td>{@code tangentReversed}</td><td>{@code .reverseTangent()}</td></tr>
 *   <tr><td>{@code constant}</td><td>{@code .constant(h)}</td></tr>
 *   <tr><td>{@code linear}</td><td>{@code .linear(a, b)}</td></tr>
 *   <tr><td>{@code facePoint}</td><td>{@code .facingPoint(point)}</td></tr>
 *   <tr><td>{@code piecewise}</td><td>{@code .heading(Interpolator.piecewise().until(t, inner)...)}</td></tr>
 * </table>
 *
 * <p>A {@code piecewise} heading is built per segment, like every other mode: the ranges that cross a
 * segment are clipped to it and their ends turned from the step's arc-length fractions into that
 * segment's own parametric t ({@link #piecewiseFor}), because that t, not the step's, is what a
 * segment's interpolator is handed.
 *
 * <p>Every one of those is real API in the pinned snapshot {@code core-3.0.0-20260828.185437-17};
 * each was read out of that snapshot's sources jar. In particular {@code reverseTangent()} and
 * {@code facingPoint(...)} exist natively, so neither {@code tangentReversed} nor {@code facePoint}
 * needs the per-segment sampling that the spec allowed for as a fallback.
 *
 * <p><b>A heading interpolator is attached to every segment, always.</b> Pedro throws
 * {@code IllegalStateException("Cannot resolve segments: path has no heading.")} the moment a path with
 * none is followed, and a mistake that only shows itself when the robot is already moving is the one
 * mistake worth spending a branch to make impossible.
 *
 * <p><b>Headings are in the running alliance's frame.</b> {@link #build(List, AutoFile.Heading)} takes
 * a heading that has already been through {@link AllianceFrame#heading(AutoFile.Heading)}, which a
 * runtime builds from the same {@code alliance(pose)} that {@link #resolve} mirrors the poses with, so a
 * RED file run as BLUE faces BLUE's way along BLUE's path. {@link #build(AutoFile.PathStep,
 * AllianceFrame, Pose)} does both halves in one call.
 *
 * <p><b>Speed is not applied here.</b> {@code speedFraction} is handed to the running auto's
 * {@code followPath}, and each runtime's {@code FollowPath} applies it through {@code atSpeed} when the
 * path starts, so a team's cap is applied in one place and is reverted when the path ends.
 *
 * <h2>Measuring</h2>
 * {@link Built#segmentLengthsIn} is each segment's arc length in inches, computed here rather than
 * asked of Pedro, by walking the segment's own geometry at {@link #SAMPLES_PER_SEGMENT} samples and
 * summing the chords. Two reasons. It is needed <i>before</i> a heading can be attached, because a
 * multi-segment {@code linear} heading has to be split between segments by arc length. And it is what
 * makes the editor's {@code t} and the robot's marker fire at the same place: both are arc length along
 * the planned path, measured the same way from the same numbers. {@link MarkerProgress} consumes it.
 */
public final class PedroPaths {

    /**
     * Samples per segment when measuring arc length. The spec's figure ({@code 03} section 1): enough
     * for sub-tenth-of-an-inch error on a 144 in field, cheap enough to run at OpMode init.
     */
    public static final int SAMPLES_PER_SEGMENT = 64;

    private PedroPaths() {}

    /** A built path and the measurements marker placement needs. */
    public static final class Built {
        /** The whole step as one followable Pedro path. */
        public final Path path;
        /** Arc length of each segment, inches, in order. */
        public final double[] segmentLengthsIn;
        /** Arc length of the whole step, inches. */
        public final double totalLengthIn;

        Built(Path path, double[] segmentLengthsIn) {
            this.path = path;
            this.segmentLengthsIn = segmentLengthsIn;
            this.totalLengthIn = sum(segmentLengthsIn);
        }
    }

    /**
     * Each segment's control polygon in the running alliance's frame: index 0 the start, the last index
     * the end, anything between a Bezier control point.
     *
     * @param step        the step from the file; its poses are in the file's alliance frame
     * @param alliance    the running auto's mirror, applied to every pose the file wrote
     * @param currentPose the live field pose, already in this alliance's frame, used when the first
     *                    segment's {@code from} is {@code "current"}; may be {@code null} otherwise
     * @return one polygon per segment, in order
     */
    public static List<Pose[]> resolve(AutoFile.PathStep step, UnaryOperator<Pose> alliance,
            Pose currentPose) {
        List<Pose[]> out = new ArrayList<Pose[]>(step.segments.size());
        Pose previousEnd = null;
        for (int i = 0; i < step.segments.size(); i++) {
            AutoFile.Segment segment = step.segments.get(i);

            Pose from;
            if (segment.from == null) {
                // "current": the live pose is already this alliance's, so it is not mirrored.
                if (i == 0) {
                    if (currentPose == null) {
                        throw noLivePose();
                    }
                    from = currentPose;
                } else {
                    from = previousEnd;
                }
            } else {
                from = alliance.apply(segment.from);
            }

            Pose to = alliance.apply(segment.to);
            Pose[] points = new Pose[2 + segment.control.size()];
            points[0] = from;
            for (int c = 0; c < segment.control.size(); c++) {
                points[1 + c] = alliance.apply(segment.control.get(c));
            }
            points[points.length - 1] = to;
            out.add(points);
            previousEnd = to;
        }
        return out;
    }

    /**
     * The error for a {@code "current"} start with no live pose. It is a builder bug, not a file
     * problem: a builder defers such a step until it runs.
     *
     * @return the exception to throw
     */
    public static IllegalStateException noLivePose() {
        return new IllegalStateException("segment 0 starts at \"current\" but no live pose was supplied;"
                + " AutoBuilder should have deferred this step");
    }

    /**
     * Build one path step in the running alliance's frame: its poses through {@link #resolve}, its
     * heading through {@link AllianceFrame#heading(AutoFile.Heading)}, both from the one {@code frame}.
     *
     * @param step        the step from the file; its poses and heading are in the file's alliance frame
     * @param frame       the running alliance's frame
     * @param currentPose the live field pose, already in this alliance's frame, used when the first
     *                    segment's {@code from} is {@code "current"}; may be {@code null} otherwise
     * @return the path and its measurements
     */
    public static Built build(AutoFile.PathStep step, final AllianceFrame frame, Pose currentPose) {
        return build(resolve(step, new UnaryOperator<Pose>() {
            @Override
            public Pose apply(Pose filePose) {
                return frame.pose(filePose);
            }
        }, currentPose), frame.heading(step.heading));
    }

    /**
     * Build one path step from its resolved polygons.
     *
     * @param polygons each segment's control polygon, from {@link #resolve} or a runtime's own resolver
     * @param heading  the step's heading, in the same frame as {@code polygons}: through
     *                 {@link AllianceFrame#heading(AutoFile.Heading)} when the poses were mirrored
     * @return the path and its measurements
     */
    public static Built build(List<Pose[]> polygons, AutoFile.Heading heading) {
        double[] lengths = new double[polygons.size()];
        for (int i = 0; i < polygons.size(); i++) {
            lengths[i] = arcLengthIn(polygons.get(i));
        }
        double total = sum(lengths);

        List<Path> parts = new ArrayList<Path>(polygons.size());
        double travelled = 0;
        for (int i = 0; i < polygons.size(); i++) {
            Pose[] points = polygons.get(i);
            double startFraction = total == 0 ? 0 : travelled / total;
            travelled += lengths[i];
            double endFraction = total == 0 ? 1 : travelled / total;
            parts.add(withHeading(geometry(points), heading, points, startFraction, endFraction));
        }

        Path whole = parts.size() == 1 ? parts.get(0) : Paths.path(parts.toArray(new Path[0]));
        return new Built(whole, lengths);
    }

    /** The bare curve, no heading yet. */
    private static Path geometry(Pose[] points) {
        if (points.length == 2) {
            return Paths.line(points[0], points[1]);
        }
        // Paths.curve is variadic and BezierCurve needs three or more control poses; AutoFile has
        // already refused a bezier with no control point, so this is always at least three. Every pose
        // goes in: the schema allows one, two or three control points
        // (MAX_BEZIER_CONTROL_POINTS, packages/schema/src/auto.ts), and a curve of any of those degrees
        // is one Paths.curve call.
        return Paths.curve(points.clone());
    }

    /**
     * Attach the step's heading mode to one segment.
     *
     * @param startFraction where this segment begins as a fraction of the step's arc length
     * @param endFraction   where it ends; the two are what split a {@code linear} sweep between segments
     */
    private static Path withHeading(Path path, AutoFile.Heading heading, Pose[] points,
            double startFraction, double endFraction) {
        String mode = heading.mode;
        if ("tangent".equals(mode)) {
            return path.tangent();
        }
        if ("tangentReversed".equals(mode)) {
            return path.reverseTangent();
        }
        if ("constant".equals(mode)) {
            return path.constant(heading.headingRad);
        }
        if ("linear".equals(mode)) {
            // One sweep across the whole step, cut into the piece this segment owns, so a two-segment
            // path turns half way by the join rather than turning fully twice.
            //
            // The sweep is the difference the file wrote, shared out by arc length, and each
            // segment hands Pedro its own share with Path.linear(from, to). Pedro's
            // Interpolator.linear turns each share the short way round, so a share of more than
            // half a turn goes the other way: a 270 degree sweep on one segment turns 90 degrees
            // clockwise, while the same sweep split over two equal segments turns the full 270. The
            // editor's half turn, 3.1416, is a hair over pi and so turns clockwise. This is the
            // robot's behaviour, and the planner models it rather than this code changing:
            // linearHeadingPieces in packages/core/src/heading.ts cuts the sweep exactly as this
            // does, and the HEADING warning flags a share over half a turn
            // (site/docs/paths-explained.md).
            double sweep = heading.toRad - heading.fromRad;
            double from = heading.fromRad + sweep * startFraction;
            double to = heading.fromRad + sweep * endFraction;
            return path.linear(from, to);
        }
        if ("facePoint".equals(mode)) {
            return path.facingPoint(new Pose(heading.pointXIn, heading.pointYIn, 0));
        }
        if ("piecewise".equals(mode)) {
            return path.heading(piecewiseFor(heading, points, startFraction, endFraction));
        }
        throw new IllegalStateException("unknown heading mode \"" + mode + "\"; AutoFile should have"
                + " refused it. Segment from " + points[0] + " to " + points[points.length - 1]);
    }

    /**
     * A {@code piecewise} heading on one segment.
     *
     * <p>Pedro's {@code PiecewiseInterpolator} evaluates the range that ends at or after the t it is
     * given ({@code ceilingEntry}), hands that range's interpolator the same t, and refuses to run
     * unless the last {@code until} reaches 1. Each segment is its own Pedro path and sees its own
     * parametric t, so the ranges that cross this segment are clipped to it, and each clipped end, an
     * arc-length fraction of the step, is turned into this segment's t through the same 64-chord table
     * {@link #arcLengthIn} measures with. The last clipped range is stretched to exactly 1.
     *
     * <p>Every inner mode is Pedro's own interpolator except {@code linear}: Pedro's
     * {@code Interpolator.linear} runs over the whole of t, so a range gets its own interpolator that
     * turns the short way from the range's heading at the clipped start to its heading at the clipped
     * end, linear in this segment's t. {@code simulate}'s {@code piecewiseSegmentHeading} in
     * {@code packages/core/src/sim/pedroPath.ts} builds exactly the same thing.
     */
    public static Interpolator piecewiseFor(AutoFile.Heading heading, Pose[] points,
            double startFraction, double endFraction) {
        double span = endFraction - startFraction;
        List<AutoFile.HeadingRange> ranges = heading.ranges;
        List<Double> ends = new ArrayList<Double>(ranges.size());
        List<Interpolator> inners = new ArrayList<Interpolator>(ranges.size());
        double previous = 0;
        for (int i = 0; i < ranges.size(); i++) {
            AutoFile.HeadingRange range = ranges.get(i);
            double from = Math.max(range.startT, startFraction);
            double to = Math.min(range.endT, endFraction);
            boolean lastOfDegenerate = span <= 0 && i == ranges.size() - 1;
            if (to <= from && !lastOfDegenerate) {
                continue;
            }
            double localFrom = span <= 0 ? 0 : parameterAt(points, (from - startFraction) / span);
            double localTo = span <= 0 ? 1 : parameterAt(points, (to - startFraction) / span);
            if (localTo <= previous) {
                continue;
            }
            ends.add(localTo);
            inners.add(rangeInterpolator(range, from, to, localFrom, localTo));
            previous = localTo;
        }
        if (inners.isEmpty()) {
            // Only reachable for ranges AutoFile would have refused; hold the first range's mode
            // rather than follow a path with no heading at all.
            ends.add(1.0);
            inners.add(rangeInterpolator(ranges.get(0), 0, 1, 0, 1));
        }
        ends.set(ends.size() - 1, 1.0);
        PiecewiseInterpolator out = Interpolator.piecewise();
        for (int i = 0; i < inners.size(); i++) {
            out = out.until(ends.get(i), inners.get(i));
        }
        return out;
    }

    private static Interpolator rangeInterpolator(AutoFile.HeadingRange range, double from, double to,
            double localFrom, double localTo) {
        AutoFile.Heading inner = range.heading;
        String mode = inner.mode;
        if ("tangent".equals(mode)) {
            return Interpolator.tangent;
        }
        if ("tangentReversed".equals(mode)) {
            return Interpolator.tangent.reverse();
        }
        if ("constant".equals(mode)) {
            return Interpolator.constant(inner.headingRad);
        }
        if ("facePoint".equals(mode)) {
            return Interpolator.facingPoint(new Pose(inner.pointXIn, inner.pointYIn, 0));
        }
        if ("linear".equals(mode)) {
            double rangeSpan = range.endT - range.startT;
            double turn = normalizeSigned(inner.toRad - inner.fromRad);
            double atFrom = inner.fromRad + turn * (rangeSpan <= 0 ? 1 : (from - range.startT) / rangeSpan);
            double atTo = inner.fromRad + turn * (rangeSpan <= 0 ? 1 : (to - range.startT) / rangeSpan);
            final double start = normalize(atFrom);
            final double delta = atTo - atFrom;
            final double lower = localFrom;
            final double localSpan = localTo - localFrom;
            return new Interpolator() {
                @Override
                public double interpolate(Curve curve, double t) {
                    double local = localSpan <= 0 ? 1 : Math.min(1, Math.max(0, (t - lower) / localSpan));
                    return normalize(start + delta * local);
                }
            };
        }
        throw new IllegalStateException("unknown heading mode \"" + mode + "\" in a piecewise range;"
                + " AutoFile should have refused it");
    }

    /**
     * The segment t at which the 64-chord table reaches {@code fraction} of the segment's length,
     * linear inside a chord. Exact for a line.
     */
    public static double parameterAt(Pose[] points, double fraction) {
        if (fraction <= 0) {
            return 0;
        }
        if (fraction >= 1) {
            return 1;
        }
        if (points.length == 2) {
            return fraction;
        }
        double[] cumulative = new double[SAMPLES_PER_SEGMENT + 1];
        double previousX = points[0].x();
        double previousY = points[0].y();
        for (int sample = 1; sample <= SAMPLES_PER_SEGMENT; sample++) {
            double u = (double) sample / SAMPLES_PER_SEGMENT;
            double x = bezier(points, u, true);
            double y = bezier(points, u, false);
            cumulative[sample] = cumulative[sample - 1] + Math.hypot(x - previousX, y - previousY);
            previousX = x;
            previousY = y;
        }
        double total = cumulative[SAMPLES_PER_SEGMENT];
        if (total <= 0) {
            return fraction;
        }
        double target = fraction * total;
        for (int sample = 1; sample <= SAMPLES_PER_SEGMENT; sample++) {
            if (cumulative[sample] >= target) {
                double lower = cumulative[sample - 1];
                double upper = cumulative[sample];
                double within = upper == lower ? 0 : (target - lower) / (upper - lower);
                return (sample - 1 + within) / SAMPLES_PER_SEGMENT;
            }
        }
        return 1;
    }

    /** Pedro's {@code Angle.normalize}: into [0, 2 pi). */
    public static double normalize(double rad) {
        double twoPi = Math.PI * 2;
        double angle = rad % twoPi;
        return angle < 0 ? angle + twoPi : angle;
    }

    /** Pedro's {@code Angle.normalizeSigned}: into [-pi, pi), so an exact half turn goes clockwise. */
    public static double normalizeSigned(double rad) {
        double angle = normalize(rad);
        return angle >= Math.PI ? angle - Math.PI * 2 : angle;
    }

    /**
     * Arc length of one segment, inches, by chord summation over its own Bezier geometry. A line is
     * exact; a curve is under-estimated by the usual chord error, which at 64 samples over a field-sized
     * curve is well under a tenth of an inch.
     */
    private static double arcLengthIn(Pose[] points) {
        if (points.length == 2) {
            return Math.hypot(points[1].x() - points[0].x(), points[1].y() - points[0].y());
        }
        double length = 0;
        double previousX = points[0].x();
        double previousY = points[0].y();
        for (int sample = 1; sample <= SAMPLES_PER_SEGMENT; sample++) {
            double u = (double) sample / SAMPLES_PER_SEGMENT;
            double x = bezier(points, u, true);
            double y = bezier(points, u, false);
            length += Math.hypot(x - previousX, y - previousY);
            previousX = x;
            previousY = y;
        }
        return length;
    }

    /** De Casteljau on one axis. {@code xAxis} picks x over y. */
    private static double bezier(Pose[] points, double u, boolean xAxis) {
        double[] work = new double[points.length];
        for (int i = 0; i < points.length; i++) {
            work[i] = xAxis ? points[i].x() : points[i].y();
        }
        for (int round = points.length - 1; round > 0; round--) {
            for (int i = 0; i < round; i++) {
                work[i] = work[i] + (work[i + 1] - work[i]) * u;
            }
        }
        return work[0];
    }

    private static double sum(double[] values) {
        double total = 0;
        for (double value : values) {
            total += value;
        }
        return total;
    }
}
