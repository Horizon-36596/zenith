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
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.pedropathing.paths.PathSegment;
import com.seattlesolvers.solverslib.command.Command;
import com.seattlesolvers.solverslib.command.CommandBase;
import com.seattlesolvers.solverslib.command.CommandGroupBase;
import com.seattlesolvers.solverslib.geometry.Pose2d;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import org.horizon36596.zenith.Json;

import java.io.IOException;
import java.util.Arrays;
import java.util.Collections;

class AutoBuilderTest {

    private FakeAuto robot;

    @BeforeEach
    void freshRobot() {
        // SolversLib remembers every command that has been put in a group, in a static set, and refuses
        // to group one twice. Each test builds fresh commands, so the set is cleared between them.
        CommandGroupBase.clearGroupedCommands();
        robot = new FakeAuto();
        robot.registerCommands();
    }

    private Command buildDemo() throws IOException {
        return AutoBuilder.build(AutoSpec.load(FakeAuto.fixtures(), "demo"), robot);
    }

    @Test
    void wrapsEveryStepNestedOnesIncludedWithItsId() throws IOException {
        buildDemo();
        assertEquals(Arrays.asList("toScore", "score", "step3", "drive", "grab.2.1", "grab.2.2", "grab.2",
                "grab", "park", "scoreAgain", "check"), robot.stepIds);
    }

    @Test
    void runsTheRoutineInOrderOnTheRobotsClock() throws IOException {
        Command routine = buildDemo();
        // Only the first path is built at init; the second starts at "current" and is deferred.
        assertEquals(1, robot.paths.size());

        robot.run(routine, 500);

        // The whole run, in one fixed order. The first path runs under its timeoutS and arrives in time,
        // so it is ended cleanly ("path0 end"). In the parallel the file lists the deferred path first, so
        // it starts first: it reads the live pose, then the sequence beside it turns the intake on.
        assertEquals(Arrays.asList(
                "path0 start",
                "intakeOn",        // the marker at t = 0.5, fired part-way along the first path
                "path0 end",
                "score 2",
                "currentPose",
                "path1 start",
                "intakeOn",
                "path1 end"), robot.log);
        // 0.8 from the file; 0.6 is the fake robot's default, used where the file gives no speed.
        assertEquals(Arrays.asList(0.8, 0.6), robot.speeds);
    }

    @Test
    void takesTheBranchTheConditionPicks() throws IOException {
        robot.holdingPiece = true;
        robot.run(buildDemo(), 500);
        assertTrue(robot.log.contains("score 1"), robot.log.toString());
    }

    @Test
    void mirrorsFilePosesThroughTheContextOnly() throws IOException {
        robot.mirror = true;
        buildDemo();
        // The first path ends at the waypoint "score", (-24, -36), mirrored through the fake's point
        // symmetry.
        assertEquals(24.0, robot.paths.get(0).endPose().x(), 1e-9);
        assertEquals(36.0, robot.paths.get(0).endPose().y(), 1e-9);
    }

    @Test
    void mirrorsHeadingsThroughTheSameContextAsPoses() throws IOException {
        robot.mirror = true;
        robot.run(buildDemo(), 500);
        // The deferred path turns linearly from 0 to pi/2 on RED; through the fake's point symmetry it
        // turns the same quarter turn, the same way, from a half turn.
        PathSegment drive = robot.paths.get(1).getSegments().get(0);
        assertEquals(PathBuilder.normalize(Math.PI), drive.heading(0), 1e-9);
        assertEquals(PathBuilder.normalize(Math.PI + 1.5708 / 2), drive.heading(0.5), 1e-9);
        assertEquals(PathBuilder.normalize(Math.PI + 1.5708), drive.heading(1), 1e-9);
    }

    @Test
    void aMirrorThatForgetsHeadingsIsRefusedAtInit() {
        FakeAuto forgetful = new FakeAuto() {
            @Override
            public Pose2d alliance(Pose2d filePose) {
                return new Pose2d(filePose.getX(), -filePose.getY(), filePose.getRotation());
            }
        };
        forgetful.registerCommands();
        IllegalStateException problem = assertThrows(IllegalStateException.class,
                () -> AutoBuilder.build(AutoSpec.load(FakeAuto.fixtures(), "demo"), forgetful));
        assertTrue(problem.getMessage().contains("turns headings differently from positions"),
                problem.getMessage());
    }

    @Test
    void anUnregisteredCommandNamesTheStepAndWhatIsRegistered() {
        Json root = Json.parse("{\"formatVersion\": 3, \"start\": {\"pose\": {\"xIn\": 0, \"yIn\": 0}},"
                + " \"steps\": [{\"id\": \"volley\", \"kind\": \"command\", \"name\": \"scor\"}]}", "typo.auto.json");
        AutoSpec spec = AutoSpec.parse(root, "typo", Collections.<String, Pose2d>emptyMap());
        IllegalArgumentException problem = assertThrows(IllegalArgumentException.class,
                () -> AutoBuilder.build(spec, robot));
        assertTrue(problem.getMessage().startsWith("step \"volley\": "), problem.getMessage());
        assertTrue(problem.getMessage().contains("[intakeOn, score]"), problem.getMessage());
    }

    @Test
    void waitRobotTimeWaitsOnTheRobotClockNotTheWallClock() {
        WaitRobotTime wait = new WaitRobotTime(250, robot);
        robot.run(wait, 100);
        // 250 ms at 20 ms per loop is done on the thirteenth loop, however fast the loops ran.
        assertEquals(13 * 20_000_000L, robot.nowNanos);
    }

    @Test
    void robotTimeoutCutsANeverEndingCommandOff() {
        final boolean[] interrupted = {false};
        Command forever = new CommandBase() {
            @Override
            public void end(boolean wasInterrupted) {
                interrupted[0] = wasInterrupted;
            }
        };
        robot.run(RobotTimeout.of(forever, 0.1, robot), 100);
        assertEquals(5 * 20_000_000L, robot.nowNanos);
        assertTrue(interrupted[0]);
    }

    @Test
    void aTimeoutOnAGroupDoesNotCutItShort() {
        // The file format gives a group no timeoutS, and the editor drops one, so the runtime does too:
        // the sequence runs its whole 0.3 s wait rather than stopping at 0.1 s.
        Json root = Json.parse("{\"formatVersion\": 3, \"start\": {\"pose\": {\"xIn\": 0, \"yIn\": 0}},"
                + " \"steps\": [{\"id\": \"group\", \"kind\": \"sequence\", \"timeoutS\": 0.1,"
                + " \"steps\": [{\"id\": \"long\", \"kind\": \"wait\", \"seconds\": 0.3}]}]}", "group.auto.json");
        AutoSpec spec = AutoSpec.parse(root, "group", Collections.<String, Pose2d>emptyMap());
        assertEquals(1, spec.warnings.size(), spec.warnings.toString());
        robot.run(AutoBuilder.build(spec, robot), 100);
        assertTrue(robot.nowNanos >= 300_000_000L, "the group ran " + robot.nowNanos / 1_000_000 + " ms");
    }
}
