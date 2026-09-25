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

import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;
import com.pedropathing.paths.interpolator.Interpolator;
import com.seattlesolvers.solverslib.geometry.Pose2d;

import org.horizon36596.zenith.AllianceFrame;
import org.horizon36596.zenith.AutoFile;
import org.horizon36596.zenith.PedroPaths;

import java.util.ArrayList;
import java.util.List;
import java.util.function.UnaryOperator;

/**
 * Turns a file's {@code path} step into a Pedro v3 {@link Path}, and measures it, for the SolversLib
 * runtime.
 *
 * <p>The geometry, the heading mapping and the arc-length measurement are {@link PedroPaths}'s, which the
 * Ivy runtime uses too, so a path step is the same Pedro path whichever library drives it. The one thing
 * done here is resolving the file's poses into this alliance's frame through
 * {@link AutoContext#alliance}, which takes a SolversLib {@link Pose2d}. The step's heading goes through
 * {@link AllianceFrame}, built from that same call.
 *
 * <p><b>Speed is not applied here.</b> {@code speedFraction} is handed to
 * {@link AutoContext#followPath}, and {@link FollowPath} applies it through
 * {@link AutoContext#atSpeed} when the path starts, so a team's cap is applied in one place and is
 * reverted when the path ends.
 */
public final class PathBuilder {

    /** Samples per segment when measuring arc length; {@link PedroPaths#SAMPLES_PER_SEGMENT}. */
    public static final int SAMPLES_PER_SEGMENT = PedroPaths.SAMPLES_PER_SEGMENT;

    private PathBuilder() {}

    /** A built path and the measurements {@link PathMarkers} needs to place markers on it. */
    public static final class Built {
        /** The whole step as one followable Pedro path. */
        public final Path path;
        /** Arc length of each segment, inches, in order. */
        public final double[] segmentLengthsIn;
        /** Arc length of the whole step, inches. */
        public final double totalLengthIn;

        Built(PedroPaths.Built built) {
            this.path = built.path;
            this.segmentLengthsIn = built.segmentLengthsIn;
            this.totalLengthIn = built.totalLengthIn;
        }
    }

    /**
     * Build one path step.
     *
     * @param step        the step from the file; its poses are canonical alliance
     * @param ctx         the running auto, for {@link AutoContext#alliance}
     * @param currentPose the live field pose, already in this alliance's frame, used when the first
     *                    segment's {@code from} is {@code "current"}; may be {@code null} otherwise
     * @return the path and its measurements
     */
    public static Built build(AutoSpec.PathStep step, AutoContext ctx, Pose2d currentPose) {
        AutoFile.Heading heading = frame(ctx).heading(step.file.heading);
        return new Built(PedroPaths.build(resolve(step, ctx, currentPose), heading));
    }

    /**
     * The running alliance's frame, poses and headings alike, from {@link AutoContext#alliance}: the
     * one call that decides whether this file is mirrored, so its headings are mirrored exactly when
     * its poses are.
     *
     * @param ctx the running auto
     * @return the frame, as Pedro poses
     */
    static AllianceFrame frame(final AutoContext ctx) {
        return AllianceFrame.of(new UnaryOperator<Pose>() {
            @Override
            public Pose apply(Pose filePose) {
                return Poses.toPedro(ctx.alliance(Poses.fromPedro(filePose)));
            }
        });
    }

    /**
     * A {@code piecewise} heading on one segment; {@link PedroPaths#piecewiseFor} says how it is clipped.
     *
     * @param heading       a {@code piecewise} heading
     * @param points        the segment's control polygon
     * @param startFraction where the segment begins, as a fraction of the step's arc length
     * @param endFraction   where it ends
     * @return the interpolator for that segment
     */
    static Interpolator piecewiseFor(AutoSpec.Heading heading, Pose2d[] points,
            double startFraction, double endFraction) {
        return PedroPaths.piecewiseFor(AutoSpec.toFile(heading), toPedro(points), startFraction, endFraction);
    }

    /** {@link PedroPaths#parameterAt} for a SolversLib control polygon. */
    static double parameterAt(Pose2d[] points, double fraction) {
        return PedroPaths.parameterAt(toPedro(points), fraction);
    }

    /** Pedro's {@code Angle.normalize}; {@link PedroPaths#normalize}. */
    static double normalize(double rad) {
        return PedroPaths.normalize(rad);
    }

    /** Pedro's {@code Angle.normalizeSigned}; {@link PedroPaths#normalizeSigned}. */
    static double normalizeSigned(double rad) {
        return PedroPaths.normalizeSigned(rad);
    }

    private static Pose[] toPedro(Pose2d[] points) {
        Pose[] out = new Pose[points.length];
        for (int i = 0; i < points.length; i++) {
            out[i] = Poses.toPedro(points[i]);
        }
        return out;
    }

    /**
     * Each segment's control polygon in the alliance's own frame: index 0 the start, the last index the
     * end, anything between a Bezier control point. Mirrored as SolversLib poses, because that is what
     * {@link AutoContext#alliance} takes, then handed to Pedro.
     */
    private static List<Pose[]> resolve(AutoSpec.PathStep step, AutoContext ctx, Pose2d currentPose) {
        List<Pose[]> out = new ArrayList<Pose[]>(step.segments.size());
        Pose2d previousEnd = null;
        for (int i = 0; i < step.segments.size(); i++) {
            AutoSpec.Segment segment = step.segments.get(i);

            Pose2d from;
            if (segment.from == null) {
                // "current": the live pose is already this alliance's, so it is not mirrored.
                if (i == 0) {
                    if (currentPose == null) {
                        throw PedroPaths.noLivePose();
                    }
                    from = currentPose;
                } else {
                    from = previousEnd;
                }
            } else {
                from = ctx.alliance(segment.from);
            }

            Pose2d to = ctx.alliance(segment.to);
            Pose[] points = new Pose[2 + segment.control.size()];
            points[0] = Poses.toPedro(from);
            for (int c = 0; c < segment.control.size(); c++) {
                points[1 + c] = Poses.toPedro(ctx.alliance(segment.control.get(c)));
            }
            points[points.length - 1] = Poses.toPedro(to);
            out.add(points);
            previousEnd = to;
        }
        return out;
    }
}
