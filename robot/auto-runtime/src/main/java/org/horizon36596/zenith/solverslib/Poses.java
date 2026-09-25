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
import com.seattlesolvers.solverslib.geometry.Pose2d;
import com.seattlesolvers.solverslib.geometry.Rotation2d;

/**
 * Converts between SolversLib's {@link Pose2d} and Pedro Pathing's {@link Pose}. Same frame, same units
 * (inches and radians); a type change only.
 */
public final class Poses {

    private Poses() {}

    /**
     * @param pose a SolversLib pose, field frame, inches and radians
     * @return the same pose as a Pedro {@link Pose}
     */
    public static Pose toPedro(Pose2d pose) {
        return new Pose(pose.getX(), pose.getY(), pose.getHeading());
    }

    /**
     * @param pose a Pedro pose, field frame, inches and radians
     * @return the same pose as a SolversLib {@link Pose2d}
     */
    public static Pose2d fromPedro(Pose pose) {
        return new Pose2d(pose.x(), pose.y(), new Rotation2d(pose.heading()));
    }
}
