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

import com.pedropathing.follower.Follower;
import com.pedropathing.paths.Path;
import com.seattlesolvers.solverslib.command.Command;
import com.seattlesolvers.solverslib.command.Subsystem;
import com.seattlesolvers.solverslib.geometry.Pose2d;

/**
 * A team's robot, as {@link AutoFromFile} sees it. The team implements this once, in one class with a
 * public no-argument constructor, and names that class in {@code zenith.json} as
 * {@code deploy.robotClass}; every OpMode {@code zenith deploy} generates then constructs one.
 *
 * <p>This is the whole extension surface. The runtime knows nothing about intakes, launchers, motor
 * names or a season's scoring: the robot's own commands and conditions reach an auto file only through
 * the names {@link #registerCommands} puts in {@link NamedCommands}.
 *
 * <h2>Required</h2>
 * <ul>
 *   <li>{@link #init} builds the hardware and the Pedro follower from the OpMode's hardware map.</li>
 *   <li>{@link #registerCommands} fills {@link NamedCommands} with the names the team's auto files
 *       use.</li>
 *   <li>{@link #follower()} and {@link #drive()}: the follower that drives paths, and the drivetrain
 *       subsystem every path requires. <b>Something must call {@code follower.update(...)} every
 *       loop</b>; the usual place is the drivetrain subsystem's {@code periodic()}, which the SolversLib
 *       scheduler runs once per loop. The runtime does not, because a team that already updates it there
 *       would then update it twice.</li>
 *   <li>{@link #runningAlliance()} and {@link #mirror}: which alliance the Driver Station selected, and
 *       how this season's field maps a pose onto the other alliance's side.</li>
 * </ul>
 *
 * <h2>Optional</h2>
 * The defaults are what a plain Pedro robot wants; override the ones that differ.
 */
public interface ZenithRobot {

    /**
     * Build the robot: hardware, subsystems, the follower. Called once, at the top of the OpMode's init,
     * after the auto file has been read and before any command is built.
     *
     * @param opMode the running OpMode, for its {@code hardwareMap} and {@code telemetry}
     */
    void init(AutoFromFile opMode);

    /**
     * Register every command and condition name this robot's auto files may use, with
     * {@link NamedCommands#register} and {@link NamedCommands#registerCondition}. Called once per init,
     * after {@link #init} and after {@link NamedCommands#reset()}, so a name from an earlier OpMode is
     * never still registered.
     *
     * @param opMode the running OpMode; it is also the {@link AutoContext} factories receive
     */
    void registerCommands(AutoFromFile opMode);

    /** @return the Pedro Pathing v3 follower, built by {@link #init} */
    Follower follower();

    /** @return the drivetrain subsystem, built by {@link #init}; every path step requires it */
    Subsystem drive();

    /** @return the alliance the Driver Station selected, {@code "RED"} or {@code "BLUE"} */
    String runningAlliance();

    /**
     * The same place on the other alliance's side of the field, facing the same way relative to it.
     * Called only when the auto file was written for the other alliance.
     *
     * <p><b>Headings go through this too.</b> The runtime mirrors every pose the file names through it,
     * and it also reads it to mirror each path's heading: a {@code constant} heading, both ends of a
     * {@code linear} sweep, the point a {@code facePoint} heading faces, and every {@code piecewise}
     * range. It asks this method where heading 0 and a quarter turn go, and where the unit x and y steps
     * go, and so learns whether the mirror keeps the way a turn goes (a point symmetry) or reverses it
     * (a reflection). A {@code linear} sweep keeps its size and turns the mirrored way.
     *
     * <p>So what it needs is a rigid motion of the field that carries the heading with the pose: turn
     * the heading exactly as the positions turn. For a field symmetric about its centre point that is
     * {@code (-x, -y, heading + pi)}; reflected across the x axis it is {@code (x, -y, -heading)}; across
     * the y axis {@code (-x, y, pi - heading)}. In Pedro's own frame, whose origin is a field corner, the
     * point symmetry is {@code (144 - x, 144 - y, heading + pi)}. A mirror whose headings disagree with
     * its positions, such as a reflection that leaves the heading alone, is refused at init with both
     * numbers, rather than driving the mirrored path facing the wrong way.
     *
     * @param pose a pose, field frame, inches and radians
     * @return the mirrored pose
     */
    Pose2d mirror(Pose2d pose);

    /** @return the robot's clock in nanoseconds; see {@link RobotClock}. {@code System.nanoTime()} by default */
    default long nanoTime() {
        return System.nanoTime();
    }

    /**
     * Put the robot at the auto's start pose before the match starts.
     *
     * @param pose the start pose, already in the running alliance's frame
     */
    default void setStartPose(Pose2d pose) {
        follower().setPose(Poses.toPedro(pose));
    }

    /** @return the live pose, running alliance's frame; the follower's by default */
    default Pose2d currentPose() {
        return Poses.fromPedro(follower().pose());
    }

    /** @return the speed a path runs at when the file gives none, 0 to 1; full speed by default */
    default double defaultSpeedFraction() {
        return 1.0;
    }

    /**
     * See {@link AutoContext#atSpeed}. The default leaves the path unchanged.
     *
     * @param path          the path about to be followed
     * @param speedFraction 0 to 1
     * @return the path to follow
     */
    default Path atSpeed(Path path, double speedFraction) {
        return path;
    }

    /**
     * See {@link AutoContext#followPath}. {@code null}, the default, means the runtime's own
     * {@link FollowPath}.
     *
     * @param path          the built path
     * @param speedFraction 0 to 1
     * @return the command that drives it, or {@code null} for {@link FollowPath}
     */
    default Command followPath(Path path, double speedFraction) {
        return null;
    }

    /**
     * See {@link AutoContext#step}. The default returns the command unchanged.
     *
     * @param id   the step's id
     * @param body the step's command
     * @return the command to run in its place
     */
    default Command step(String id, Command body) {
        return body;
    }

    /**
     * Called on every loop while the OpMode waits for start, before the telemetry update. The default
     * does nothing.
     *
     * @param opMode the running OpMode
     */
    default void initLoop(AutoFromFile opMode) {}
}
