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

    /**
     * The longest path step, in inches, that is run as a turn on the spot instead of being handed to
     * Pedro (decision D10). Measured on the path as built, so a turn written from {@code "current"} is
     * still a turn when the robot arrives a little short of where the step before it ended.
     * {@code TURN_IN_PLACE_MAX_IN} in {@code packages/core/src/turnInPlace.ts}.
     */
    public static final double TURN_IN_PLACE_MAX_IN = 2;

    /**
     * The heading error a turn on the spot ends within at once, in radians: two degrees, set from the
     * instant sim, about twice the largest error its hold comes to rest at with Pedro's default heading
     * P (0.019 rad over every whole degree of target). One degree sat right at that error and some
     * turns never ended. Pedro's own hold end constraint, 0.007 rad, is tighter still.
     * {@code TURN_SETTLED_RAD} in core.
     */
    public static final double TURN_SETTLED_RAD = 2 * Math.PI / 180;

    /**
     * How near the held point the robot must be before a turn on the spot ends at once, in inches: half
     * an inch, set by hand, the editor's "same spot" ({@code CONTINUITY_TOLERANCE_IN} in core). Every
     * step of {@link #TURN_IN_PLACE_MAX_IN} or less is held, so a short drive with no heading change is
     * settled on heading at once and must still arrive. Pedro's own 0.1 in is tighter than a hold's
     * translational P can always reach against friction. {@code TURN_ARRIVED_IN} in core.
     */
    public static final double TURN_ARRIVED_IN = 0.5;

    /**
     * How long the robot must stay still near the held pose before a turn on the spot ends anyway, in
     * seconds, set by hand. A hold whose P cannot push the robot inside {@link #TURN_SETTLED_RAD} and
     * {@link #TURN_ARRIVED_IN} against friction leaves it at rest a little off, and waiting longer
     * would only stop the routine. {@code TURN_STILL_S} in core.
     */
    public static final double TURN_STILL_S = 0.25;

    /**
     * "Still" for {@link #TURN_STILL_S}, heading, in radians: a quarter of a degree, set by hand.
     * {@code TURN_STILL_RAD} in core.
     */
    public static final double TURN_STILL_RAD = 0.25 * Math.PI / 180;

    /**
     * "Still" for {@link #TURN_STILL_S}, position, in inches, set by hand. {@code TURN_STILL_IN} in
     * core.
     */
    public static final double TURN_STILL_IN = 0.05;

    /**
     * "Near" for {@link #TURN_STILL_S}: a robot at rest ends the turn only within this heading error, in
     * radians, ten degrees, set by hand, and within {@link #TURN_IN_PLACE_MAX_IN} of the held point, so
     * a robot that has not started moving is not taken for one that has finished. {@code TURN_NEAR_RAD}
     * in core.
     */
    public static final double TURN_NEAR_RAD = 10 * Math.PI / 180;

    private PedroPaths() {}

    /** A built path and the measurements marker placement needs. */
    public static final class Built {
        /**
         * The whole step as one followable Pedro path, or {@code null} for a turn on the spot, which is
         * never handed to Pedro: see {@link #turn}.
         */
        public final Path path;
        /** Arc length of each segment, inches, in order. */
        public final double[] segmentLengthsIn;
        /** Arc length of the whole step, inches. */
        public final double totalLengthIn;
        /**
         * For a step no longer than {@link #TURN_IN_PLACE_MAX_IN}, the pose to hold: the step's end point
         * with its end heading ({@link #turnHeading}). The runtime holds it with {@code follower.hold}
         * until {@link TurnSettle#done}. {@code null} for a path Pedro follows.
         */
        public final Pose turn;

        Built(Path path, double[] segmentLengthsIn) {
            this(path, segmentLengthsIn, null);
        }

        Built(Path path, double[] segmentLengthsIn, Pose turn) {
            this.path = path;
            this.segmentLengthsIn = segmentLengthsIn;
            this.totalLengthIn = sum(segmentLengthsIn);
            this.turn = turn;
        }

        /** @return true when this step is a turn on the spot, held rather than followed */
        public boolean isTurn() {
            return turn != null;
        }
    }

    /**
     * Whether a turn on the spot has settled within the tolerances: the robot's heading is within
     * {@link #TURN_SETTLED_RAD} of the turn's, the short way round, and its position within
     * {@link #TURN_ARRIVED_IN} of the turn's point. Both, because a held step that drives a little and
     * does not turn has the right heading from its first loop. The first test of {@link TurnSettle}.
     * {@code turnSettled} in {@code packages/core/src/turnInPlace.ts}.
     *
     * @param turn  the pose the turn holds
     * @param robot the robot's pose now
     * @return true once the turn is done
     */
    public static boolean turnSettled(Pose turn, Pose robot) {
        return Math.abs(normalizeSigned(turn.heading() - robot.heading())) < TURN_SETTLED_RAD
                && Math.hypot(turn.x() - robot.x(), turn.y() - robot.y()) < TURN_ARRIVED_IN;
    }

    /**
     * When a held turn on the spot is done, which both runtimes' {@code TurnInPlace} ask every loop.
     * Done at once when {@link #turnSettled}; otherwise done once the robot has stayed within
     * {@link #TURN_STILL_RAD} and {@link #TURN_STILL_IN} of one pose for {@link #TURN_STILL_S} while
     * within {@link #TURN_NEAR_RAD} and {@link #TURN_IN_PLACE_MAX_IN} of the held pose. The clock is
     * passed in, so asking twice in one loop changes nothing. {@code TurnSettle} in
     * {@code packages/core/src/turnInPlace.ts}, which the instant sim runs.
     */
    public static final class TurnSettle {
        private final Pose turn;
        private Pose anchor;
        private double anchorS;

        /** @param turn the pose the turn holds */
        public TurnSettle(Pose turn) {
            this.turn = turn;
        }

        /**
         * @param robot the robot's pose now
         * @param nowS  the robot's clock now, in seconds
         * @return true once the turn is done
         */
        public boolean done(Pose robot, double nowS) {
            if (turnSettled(turn, robot)) {
                return true;
            }
            if (anchor == null
                    || Math.abs(normalizeSigned(robot.heading() - anchor.heading())) > TURN_STILL_RAD
                    || Math.hypot(anchor.x() - robot.x(), anchor.y() - robot.y()) > TURN_STILL_IN) {
                // A copy, so a pose the follower updates in place cannot move the anchor with it.
                anchor = new Pose(robot.x(), robot.y(), robot.heading());
                anchorS = nowS;
                return false;
            }
            return nowS - anchorS >= TURN_STILL_S
                    && Math.abs(normalizeSigned(turn.heading() - robot.heading())) < TURN_NEAR_RAD
                    && Math.hypot(turn.x() - robot.x(), turn.y() - robot.y()) < TURN_IN_PLACE_MAX_IN;
        }
    }

    /**
     * The heading a turn on the spot holds: the step's heading mode at the end of its last segment,
     * worked out without Pedro, because the step is never built into a Pedro path. Tangent reads the
     * last segment's end direction ({@code P[n] - P[n-1]}, else its chord, else 0, which is what
     * Pedro's {@code Vector2D.theta} gives a zero vector); Linear its {@code toRad}; Constant its
     * angle; Facing point the bearing from the end to the point; Piecewise its last range's mode, a
     * linear range turning the short way from its {@code fromRad}. {@code turnHeading} in
     * {@code packages/core/src/sim/pedroPath.ts} is the same.
     *
     * @param polygons each segment's control polygon, in the running alliance's frame
     * @param heading  the step's heading, in the same frame
     * @return the heading to hold, in [0, 2 pi)
     */
    public static double turnHeading(List<Pose[]> polygons, AutoFile.Heading heading) {
        Pose[] last = polygons.get(polygons.size() - 1);
        Pose end = last[last.length - 1];
        double tangent = endTangentRad(polygons);
        AutoFile.Heading mode = heading;
        if ("piecewise".equals(heading.mode)) {
            AutoFile.Heading inner = heading.ranges.get(heading.ranges.size() - 1).heading;
            if ("linear".equals(inner.mode)) {
                return normalize(inner.fromRad + normalizeSigned(inner.toRad - inner.fromRad));
            }
            mode = inner;
        }
        if ("tangent".equals(mode.mode)) {
            return normalize(tangent);
        }
        if ("tangentReversed".equals(mode.mode)) {
            return normalize(tangent + Math.PI);
        }
        if ("constant".equals(mode.mode)) {
            return normalize(mode.headingRad);
        }
        if ("linear".equals(mode.mode)) {
            return normalize(mode.toRad);
        }
        if ("facePoint".equals(mode.mode)) {
            return normalize(Math.atan2(mode.pointYIn - end.y(), mode.pointXIn - end.x()));
        }
        throw new IllegalStateException("unknown heading mode \"" + mode.mode + "\"; AutoFile should have"
                + " refused it. Turn at " + end);
    }

    /**
     * The direction the last segment ends in, as {@link #turnHeading} reads a tangent: {@code P[n] -
     * P[n-1]}, else its chord, else 0. Public so a generated class can turn on the spot from a live
     * path exactly as {@code AutoBuilder} does.
     *
     * @param polygons each segment's control polygon, in the running alliance's frame
     * @return the direction in radians, not normalized
     */
    public static double endTangentRad(List<Pose[]> polygons) {
        Pose[] last = polygons.get(polygons.size() - 1);
        Pose end = last[last.length - 1];
        Pose before = last[last.length - 2];
        double dx = end.x() - before.x();
        double dy = end.y() - before.y();
        if (Math.hypot(dx, dy) <= 1e-9) {
            dx = end.x() - last[0].x();
            dy = end.y() - last[0].y();
        }
        return Math.hypot(dx, dy) <= 1e-9 ? 0 : Math.atan2(dy, dx);
    }

    /**
     * Arc length of a whole step, inches: each segment's chord-summed length, as {@link #build}
     * measures it before it decides whether the step is a turn on the spot. Public so a generated
     * class makes that decision on the live path exactly as {@code AutoBuilder} does.
     *
     * @param polygons each segment's control polygon
     * @return the step's length in inches
     */
    public static double lengthIn(List<Pose[]> polygons) {
        double total = 0;
        for (Pose[] points : polygons) {
            total += arcLengthIn(points);
        }
        return total;
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

        // A turn on the spot is never handed to Pedro: it is held at its end pose until the robot has
        // settled there, on heading and on position (decision D10). A path this short would end at t 0.975 before the robot had turned,
        // and a line with no length at all gives Pedro a zero tangent.
        if (total <= TURN_IN_PLACE_MAX_IN) {
            Pose[] last = polygons.get(polygons.size() - 1);
            Pose end = last[last.length - 1];
            return new Built(null, lengths, new Pose(end.x(), end.y(), turnHeading(polygons, heading)));
        }

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
