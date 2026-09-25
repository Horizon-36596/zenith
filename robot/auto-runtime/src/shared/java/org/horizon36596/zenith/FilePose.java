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

/**
 * A pose read from a file, which remembers the heading exactly as the file wrote it.
 *
 * <p>Pedro's {@link Pose} normalises its heading into [0, 2 pi) when it is built, so {@code -1.5708}
 * comes back as {@code 4.7124}. That is the same direction and every path Pedro builds is unaffected,
 * but the SolversLib runtime's {@code AutoSpec} hands its poses to teams as SolversLib {@code Pose2d},
 * whose heading a team can read, and those have always carried the file's own number. {@link AutoFile}
 * builds every pose it parses as one of these so that {@code AutoSpec} can keep doing that.
 *
 * <p>Public only because the runtimes live in their own packages; a team never needs to build one.
 */
public final class FilePose extends Pose {

    /** The heading as the file wrote it, radians, not normalised. */
    public final double headingRad;

    /**
     * @param xIn        inches
     * @param yIn        inches
     * @param headingRad radians, as the file wrote it
     */
    public FilePose(double xIn, double yIn, double headingRad) {
        super(xIn, yIn, headingRad);
        this.headingRad = headingRad;
    }

    /**
     * @param pose any pose
     * @return its heading as the file wrote it when it came from a file, otherwise Pedro's
     */
    public static double headingOf(Pose pose) {
        return pose instanceof FilePose ? ((FilePose) pose).headingRad : pose.heading();
    }
}
