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

import com.pedropathing.math.Pose;

import java.util.ArrayList;
import java.util.List;
import java.util.function.UnaryOperator;

/**
 * The running alliance's frame as a path step needs it: the running auto's pose map, and the heading map
 * that follows from it.
 *
 * <h2>One decision</h2>
 * Whether a file is mirrored is decided in one place, the running auto's {@code alliance(pose)}, which
 * mirrors if and only if {@link AutoFile#mirrorsInto} says so. This class is built from that same call
 * and never asks the question again, so a path's headings are mirrored exactly when its poses are. When
 * {@code alliance(pose)} does not turn headings, every heading here is handed back unchanged, the very
 * same numbers.
 *
 * <h2>The heading map</h2>
 * The team's mirror is a rigid motion of the field: a point symmetry, a reflection across an axis, or any
 * other rotation or reflection. A rigid motion carries a heading {@code h} to {@code c + s * h}, for one
 * constant {@code c} and one sign {@code s}, whatever the pose it is at. So both are read once:
 *
 * <ul>
 *   <li>{@code c} is the heading of {@code alliance(Pose(0, 0, 0))}, the team's own answer for heading
 *       zero. It is snapped to an exact multiple of a quarter turn when it is within
 *       {@value #SNAP_RAD} rad of one, so a mirror written as {@code h + PI} and one that goes through a
 *       SolversLib {@code Rotation2d} give the same bits.</li>
 *   <li>{@code s} is the orientation of the map on positions: the sign of the cross product of where
 *       the mirror sends the unit x and y steps. A point symmetry keeps orientation ({@code s = +1}), so a
 *       counter-clockwise turn stays counter-clockwise; a reflection reverses it ({@code s = -1}).</li>
 * </ul>
 *
 * <p>Both are then checked against the team's mirror itself: the heading it gives for zero must point
 * where it sends the unit x step, and the heading it gives for a quarter turn must be
 * {@code c + s * pi/2}. A mirror that moves positions one way and headings another (a reflection that
 * forgets to negate the heading, say) is refused at init with both numbers, because it would have driven
 * the mirrored path facing the wrong way.
 *
 * <h2>Per heading mode</h2>
 * <ul>
 *   <li>{@code constant}: {@link #heading(double)} of the file's heading.</li>
 *   <li>{@code linear}: the start is mapped, and the sweep keeps its size and turns {@code s} times the
 *       way the file wrote it, left unwrapped, so each segment's share and the way round it turns are
 *       what the file meant. This is {@code mirrorHeading} in {@code packages/core/src/mirror.ts}.</li>
 *   <li>{@code facePoint}: the point goes through the pose map.</li>
 *   <li>{@code piecewise}: each range's heading is mapped the same way; its {@code startT} and
 *       {@code endT} stay, because a rigid motion keeps arc length.</li>
 *   <li>{@code tangent}, {@code tangentReversed}: unchanged, since they follow the mirrored curve.</li>
 * </ul>
 */
public final class AllianceFrame {

    /** How close {@code c} has to be to a multiple of a quarter turn to be snapped onto it. */
    static final double SNAP_RAD = 1e-9;

    /** How far the team's mirror may be from a rigid motion's headings before it is refused. */
    static final double TOLERANCE_RAD = 1e-6;

    private final UnaryOperator<Pose> alliance;
    /** True when headings come through unchanged, so a heading is handed back as it is. */
    private final boolean headingsUnchanged;
    /** {@code c}: where heading zero goes. */
    private final double offsetRad;
    /** {@code s}: +1 when the map keeps orientation, -1 when it reverses it. */
    private final int turn;

    private AllianceFrame(UnaryOperator<Pose> alliance, boolean headingsUnchanged, double offsetRad,
            int turn) {
        this.alliance = alliance;
        this.headingsUnchanged = headingsUnchanged;
        this.offsetRad = offsetRad;
        this.turn = turn;
    }

    /**
     * The frame the running auto's {@code alliance(pose)} describes.
     *
     * @param alliance the running auto's {@code alliance(pose)}: the team's mirror when the file was
     *                 written for the other alliance, the identity when it was not
     * @return the frame
     * @throws IllegalStateException when the map turns headings differently from positions, or folds the
     *                               field onto a line
     */
    public static AllianceFrame of(UnaryOperator<Pose> alliance) {
        Pose origin = alliance.apply(new Pose(0, 0, 0));
        Pose unitX = alliance.apply(new Pose(1, 0, 0));
        Pose unitY = alliance.apply(new Pose(0, 1, 0));
        double xx = unitX.x() - origin.x();
        double xy = unitX.y() - origin.y();
        double yx = unitY.x() - origin.x();
        double yy = unitY.y() - origin.y();
        double cross = xx * yy - xy * yx;
        if (!(Math.abs(cross) > 1e-9)) {
            throw new IllegalStateException("ZenithRobot.mirror sends (0, 0), (1, 0) and (0, 1) to "
                    + origin + ", " + unitX + " and " + unitY + ", which do not span the field;"
                    + " a mirror has to be a point symmetry, a reflection or another rigid motion");
        }
        int turn = cross > 0 ? 1 : -1;

        double offset = snap(origin.heading());
        double alongX = Math.atan2(xy, xx);
        if (!sameAngle(offset, alongX)) {
            throw inconsistent("heading 0", offset, alongX);
        }
        double quarter = alliance.apply(new Pose(0, 0, Math.PI / 2)).heading();
        double expected = offset + turn * Math.PI / 2;
        if (!sameAngle(quarter, expected)) {
            throw inconsistent("heading pi/2", quarter, expected);
        }
        boolean unchanged = turn > 0 && sameAngle(offset, 0);
        return new AllianceFrame(alliance, unchanged, wrap(offset), turn);
    }

    /**
     * @param filePose a pose as the file wrote it
     * @return the pose in the running alliance's frame, from the running auto's {@code alliance(pose)}
     */
    public Pose pose(Pose filePose) {
        return alliance.apply(filePose);
    }

    /** @return true when this frame reverses turning direction, as a reflection does */
    public boolean reversesTurns() {
        return turn < 0;
    }

    /**
     * A heading from the file, in this frame.
     *
     * @param fileRad radians, as the file wrote it
     * @return {@code fileRad} itself when headings are unchanged; otherwise {@code c + s * fileRad},
     *         wrapped into (-pi, pi]
     */
    public double heading(double fileRad) {
        return headingsUnchanged ? fileRad : wrap(offsetRad + turn * fileRad);
    }

    /**
     * A path step's heading, in this frame. See <b>Per heading mode</b> above.
     *
     * @param file the heading as the file wrote it
     * @return {@code file} itself when headings are unchanged, otherwise the mirrored heading
     */
    public AutoFile.Heading heading(AutoFile.Heading file) {
        if (headingsUnchanged) {
            return file;
        }
        String mode = file.mode;
        if ("constant".equals(mode)) {
            return new AutoFile.Heading(mode, heading(file.headingRad), file.fromRad, file.toRad,
                    file.pointXIn, file.pointYIn, file.ranges);
        }
        if ("linear".equals(mode)) {
            double from = heading(file.fromRad);
            double to = from + turn * (file.toRad - file.fromRad);
            return new AutoFile.Heading(mode, file.headingRad, from, to, file.pointXIn, file.pointYIn,
                    file.ranges);
        }
        if ("facePoint".equals(mode)) {
            Pose point = pose(new Pose(file.pointXIn, file.pointYIn, 0));
            return new AutoFile.Heading(mode, file.headingRad, file.fromRad, file.toRad, point.x(),
                    point.y(), file.ranges);
        }
        if ("piecewise".equals(mode)) {
            List<AutoFile.HeadingRange> ranges = new ArrayList<AutoFile.HeadingRange>(file.ranges.size());
            for (AutoFile.HeadingRange range : file.ranges) {
                ranges.add(new AutoFile.HeadingRange(range.startT, range.endT, heading(range.heading)));
            }
            return new AutoFile.Heading(mode, file.headingRad, file.fromRad, file.toRad, file.pointXIn,
                    file.pointYIn, ranges);
        }
        // tangent and tangentReversed follow the mirrored curve; an unknown mode is PedroPaths' to refuse.
        return file;
    }

    private static IllegalStateException inconsistent(String what, double got, double expected) {
        return new IllegalStateException("ZenithRobot.mirror turns headings differently from positions: for "
                + what + " it gives " + got + " rad where its positions say " + expected + " rad."
                + " A mirror has to carry the heading with the pose, for example (-x, -y, h + pi) for a"
                + " point symmetry or (x, -y, -h) for a reflection across the x axis");
    }

    /** {@code rad} moved onto the nearest multiple of a quarter turn when it is within {@link #SNAP_RAD}. */
    private static double snap(double rad) {
        double quarters = Math.rint(rad / (Math.PI / 2));
        return Math.abs(rad - quarters * (Math.PI / 2)) < SNAP_RAD ? quarters * (Math.PI / 2) + 0.0 : rad;
    }

    /** Into (-pi, pi], the canonical range the editor writes headings in. */
    static double wrap(double rad) {
        double angle = PedroPaths.normalize(rad);
        return angle > Math.PI ? angle - Math.PI * 2 : angle + 0.0;
    }

    private static boolean sameAngle(double a, double b) {
        return Math.abs(PedroPaths.normalizeSigned(a - b)) < TOLERANCE_RAD;
    }
}
