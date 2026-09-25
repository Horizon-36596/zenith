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

import com.pedropathing.follower.Follower;
import com.pedropathing.ivy.Command;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;

import org.horizon36596.zenith.AutoFile;
import org.horizon36596.zenith.RobotClock;

/**
 * Everything the Ivy runtime needs from the robot it runs on. The Ivy side's copy of the SolversLib
 * runtime's {@code AutoContext}, with Pedro {@link Pose} poses and Ivy {@link Command}s. {@link AutoFromFile}
 * implements it by asking the team's {@link ZenithRobot}.
 *
 * <p>Four things have no default here and must be supplied: the Pedro {@link #follower()}, the
 * {@link #alliance alliance frame}, the {@link #nanoTime() clock} inherited from {@link RobotClock}, and
 * {@link #drive()}, the requirement every path takes. {@link AutoFromFile} answers the last with the
 * follower unless the robot says otherwise, because an Ivy requirement is any object.
 *
 * <h2>Alliance</h2>
 * A file says which alliance its poses are written for ({@link AutoFile#alliance}). {@link #alliance} is
 * the one place a pose from the file is turned into the frame the OpMode is running in, and the rule is
 * <b>mirror if and only if the running alliance is not the file's</b>. Every file pose the builder
 * resolves goes through this call exactly once. The live pose read for a {@code "current"} start never
 * does, because odometry already reports in the running alliance's frame.
 *
 * <p>A path's headings follow this same call. The builder reads it once through
 * {@link org.horizon36596.zenith.AllianceFrame} to learn where headings go and whether turns reverse, so a
 * {@code constant}, {@code linear}, {@code facePoint} or {@code piecewise} heading is mirrored exactly when
 * the poses are, and the mirror decision is never made twice.
 */
public interface AutoContext extends RobotClock {

    /** @return the Pedro Pathing v3 follower that drives this robot's paths */
    Follower follower();

    /** @return the requirement every path step takes, so two paths never drive at once */
    Object drive();

    /**
     * A pose as the file wrote it, in the frame this OpMode is running in. See <b>Alliance</b> above.
     *
     * @param filePose a pose in the file's own alliance frame, field frame, inches and radians
     * @return the pose mirrored for the running alliance, or unchanged when the file was written for it
     */
    Pose alliance(Pose filePose);

    /**
     * The robot's live pose, already in the running alliance's frame. Read when a path that starts at
     * {@code "current"} begins.
     *
     * @return the follower's pose, field frame, inches and radians, unless a team overrides it
     */
    default Pose currentPose() {
        return follower().pose();
    }

    /**
     * The speed a path step runs at when the file gives no {@code speedFraction}.
     *
     * @return 0 to 1; full speed unless a team overrides it
     */
    default double defaultSpeedFraction() {
        return 1.0;
    }

    /**
     * The command that drives one path. The default is {@link FollowPath}; a team with its own
     * path-following command returns that instead.
     *
     * <p>A path that starts from the robot's current pose is built when its step starts, so before then
     * the runtime has to say what it will need. It says: {@link #drive()}, priority 0, plus whatever its
     * markers need. A command returned here should therefore require {@link #drive()} and keep Ivy's
     * default priority of 0, or such a path will be scheduled with different requirements and priority
     * from the same path written from a fixed pose.
     *
     * <p>A path's markers that the robot has not reached when the routine is suspended never fire after
     * it resumes, whatever the command does, so a command that went on driving would drive the rest of
     * the path without them. It should be done on the loop the routine resumes, as {@link FollowPath}
     * is.
     *
     * @param path          the built path, with its heading interpolators
     * @param speedFraction 0 to 1, from the file or from {@link #defaultSpeedFraction()}
     * @return a command that is done when the path is
     */
    default Command followPath(Path path, double speedFraction) {
        return new FollowPath(this, path, speedFraction);
    }

    /**
     * Apply a speed cap to a path as {@link FollowPath} hands it to the follower. The default does
     * nothing.
     *
     * @param path          the path about to be followed
     * @param speedFraction 0 to 1
     * @return the path to follow
     */
    default Path atSpeed(Path path, double speedFraction) {
        return path;
    }

    /**
     * Wrap one step's command, for logging or tracing. Called once for every step in the file, nested
     * steps included, with the step's effective id ({@link AutoFile.Step#id}). The default returns the
     * command unchanged.
     *
     * @param id   the step's id, the same string the editor shows
     * @param body the step's command
     * @return the command to run in its place
     */
    default Command step(String id, Command body) {
        return body;
    }
}
