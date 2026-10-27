/* EXPORTED by zenith from autos/cycle-and-park.auto.json (sha 85225f6f). This copy is yours to edit. */

package org.firstinspires.ftc.teamcode.zenith;

import com.pedropathing.api.Paths;
import com.pedropathing.ivy.Command;
import com.pedropathing.ivy.commands.Commands;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;
import com.qualcomm.robotcore.eventloop.opmode.Autonomous;

import org.horizon36596.zenith.Args;
import org.horizon36596.zenith.AutoFile;
import org.horizon36596.zenith.ivy.AutoFromFile;
import org.horizon36596.zenith.ivy.Branch;
import org.horizon36596.zenith.ivy.DeferredPath;
import org.horizon36596.zenith.ivy.NamedCommands;
import org.horizon36596.zenith.ivy.Parallel;
import org.horizon36596.zenith.ivy.PathMarkers;
import org.horizon36596.zenith.ivy.RobotTimeout;
import org.horizon36596.zenith.ivy.Sequence;
import org.horizon36596.zenith.ivy.WaitRobotTime;
import org.horizon36596.zenith.ivy.ZenithRobot;

/**
 * EXPORTED by zenith from autos/cycle-and-park.auto.json (sha 85225f6f), for the Ivy runtime.
 *
 * <p>This is the whole auto as Java, and it is the code that runs: it reads no auto file. It is yours
 * to edit, to add logging, vision or anything else the auto file cannot hold. Your own code can also
 * go in your robot's {@code onStart}, {@code periodic}, {@code afterLoop} and {@code onStop}.
 *
 * <p><b>Not recommended.</b> Zenith no longer tracks this routine. A change made here is not in the
 * auto file, so the editor, its checks and its sim do not see it, and exporting again overwrites
 * this file. Keep the auto file as the routine, deployed with {@code zenith deploy}, unless you need
 * code it cannot hold. Delete the generated OpMode for the same auto, or the Driver Station lists both.
 *
 * <p>One private method per step, called in file order from buildRoutine(). It still needs the
 * Zenith runtime library and your ZenithRobot.
 */
@Autonomous(name = "Cycle and park (exported)", group = "Exported")
public class CycleAndParkExported extends AutoFromFile {

    @Override
    protected String autoName() {
        return "cycle-and-park";
    }

    @Override
    protected ZenithRobot createRobot() {
        return new org.firstinspires.ftc.teamcode.zenith.MyRobot();
    }

    /**
     * No file: the alliance these poses are written for, the start pose in that alliance's frame
     * (mirrored for the other alliance like every pose below), and the speed a path with no speed of
     * its own drives at, from robot.json when this was exported.
     */
    @Override
    protected AutoFile loadSpec() {
        return AutoFile.inCode("cycle-and-park", "Cycle and park", "RED",
                -13.0, -63.0, 1.5708, 0.8);
    }

    @Override
    protected Command buildRoutine() {
        return new Sequence(
            step("driveOut", stepDriveOutWithTimeout()),
            step("scorePreload", stepScorePreloadWithTimeout()),
            step("toGarden", stepToGarden()),
            step("collect", stepCollect()),
            step("stopIntake", stepStopIntake()),
            step("scoreIfCollected", stepScoreIfCollected()),
            step("park", stepPark())
        );
    }

    private static Pose pose(double xIn, double yIn, double headingRad) {
        return new Pose(xIn, yIn, headingRad);
    }

    private Command stepDriveOut() {
        Path seg0 = Paths.line(alliance(pose(-13.0, -63.0, 1.5708)) /* ref: start */, alliance(pose(-13.0, -36.0, 1.5708)) /* ref: scoreSouth */).tangent();
        Path path = seg0;
        Command drive = followPath(path, defaultSpeedFraction());
        double[] segmentLengthsIn = { 27.0 };
        java.util.List<PathMarkers.Marker> markers = new java.util.ArrayList<PathMarkers.Marker>();
        markers.add(new PathMarkers.Marker(6.75, NamedCommands.build("spinUp", Args.of(), this)));
        return PathMarkers.wrap(drive, segmentLengthsIn, markers, this);
    }

    private Command stepDriveOutWithTimeout() {
        return RobotTimeout.of(stepDriveOut(), 4.0, this);
    }

    private Command stepScorePreload() {
        return NamedCommands.build("score", Args.of("count", 4.0), this);
    }

    private Command stepScorePreloadWithTimeout() {
        return RobotTimeout.of(stepScorePreload(), 3.0, this);
    }

    private Command stepToGarden() {
        // Starts from "current": built when the step starts, from where the robot is then.
        return DeferredPath.of("toGarden", this, from -> stepToGardenFrom(from));
    }

    private Command stepToGardenFrom(Pose from) {
        Path seg0 = Paths.curve(from, alliance(pose(-20.0, -52.0, 0.0)), alliance(pose(-24.0, -60.0, 0.0)), alliance(pose(-46.0, -62.0, 3.1416)) /* ref: gardenSweepStart */).tangent();
        Path path = seg0;
        Command drive = followPath(path, defaultSpeedFraction());
        return drive;
    }

    private Command stepSweepGarden() {
        // Starts from "current": built when the step starts, from where the robot is then.
        java.util.function.BooleanSupplier endCondition = NamedCommands.condition("hopperFull");
        return DeferredPath.of("sweepGarden", this, from -> stepSweepGardenFrom(from, endCondition), NamedCommands.build("intakeOn", Args.of(), this));
    }

    private Command stepSweepGardenFrom(Pose from, java.util.function.BooleanSupplier endCondition) {
        Path seg0 = Paths.line(from, alliance(pose(-62.0, -62.0, 3.1416)) /* ref: gardenSweepEnd */).tangent();
        Path path = seg0;
        Command drive = followPath(path, 0.3);
        double[] segmentLengthsIn = { 16.0 };
        java.util.List<PathMarkers.Marker> markers = new java.util.ArrayList<PathMarkers.Marker>();
        markers.add(new PathMarkers.Marker(0.0, NamedCommands.build("intakeOn", Args.of(), this)));
        drive = PathMarkers.wrap(drive, segmentLengthsIn, markers, this);
        drive = Parallel.race(drive, Commands.waitUntil(endCondition));
        return drive;
    }

    private Command stepGiveUp() {
        return new WaitRobotTime(2500, this);
    }

    private Command stepCollect() {
        java.util.List<Command> members = new java.util.ArrayList<Command>();
        Command m_sweepGarden = stepSweepGarden();
        Command member_sweepGarden = step("sweepGarden", m_sweepGarden);
        members.add(member_sweepGarden);
        Command m_giveUp = stepGiveUp();
        Command member_giveUp = step("giveUp", m_giveUp);
        members.add(member_giveUp);
        return Parallel.race(members.toArray(new Command[0]));
    }

    private Command stepStopIntake() {
        return NamedCommands.build("intakeOff", Args.of(), this);
    }

    private Command stepDriveBack() {
        // Starts from "current": built when the step starts, from where the robot is then.
        return DeferredPath.of("driveBack", this, from -> stepDriveBackFrom(from));
    }

    private Command stepDriveBackFrom(Pose from) {
        Path seg0 = Paths.curve(from, alliance(pose(-30.0, -62.0, 0.0)), alliance(pose(-40.0, -50.0, 0.0)), alliance(pose(-40.0, 0.0, 3.1416))).reverseTangent();
        Path seg1 = Paths.curve(alliance(pose(-40.0, 0.0, 3.1416)), alliance(pose(-40.0, 40.0, 0.0)), alliance(pose(-13.0, 30.0, 0.0)), alliance(pose(-13.0, 44.0, -1.5708)) /* ref: scoreNorth */).reverseTangent();
        Path path = Paths.path(seg0, seg1);
        Command drive = followPath(path, defaultSpeedFraction());
        return drive;
    }

    private Command stepClearGarden() {
        return new WaitRobotTime(500, this);
    }

    private Command stepReadyLauncher() {
        return NamedCommands.build("spinUp", Args.of(), this);
    }

    private Command stepClearThenSpinUp() {
        return new Sequence(step("clearGarden", stepClearGarden()), step("readyLauncher", stepReadyLauncher()));
    }

    private Command stepReturnToScore() {
        java.util.List<Command> members = new java.util.ArrayList<Command>();
        Command m_driveBack = stepDriveBack();
        Command member_driveBack = step("driveBack", m_driveBack);
        members.add(member_driveBack);
        Command m_clearThenSpinUp = stepClearThenSpinUp();
        Command member_clearThenSpinUp = step("clearThenSpinUp", m_clearThenSpinUp);
        members.add(member_clearThenSpinUp);
        Command deadline = member_driveBack;
        members.remove(deadline);
        return Parallel.deadline(deadline, members.toArray(new Command[0]));
    }

    private Command stepScoreCollected() {
        return NamedCommands.build("score", Args.of("count", 4.0), this);
    }

    private Command stepScoreCollectedWithTimeout() {
        return RobotTimeout.of(stepScoreCollected(), 3.0, this);
    }

    private Command stepScoreIfCollected() {
        Command thenBranch = new Sequence(step("returnToScore", stepReturnToScore()), step("scoreCollected", stepScoreCollectedWithTimeout()));
        return Branch.of(NamedCommands.condition("holdingPiece"), thenBranch, Commands.instant(() -> { }));
    }

    private Command stepPark() {
        // Starts from "current": built when the step starts, from where the robot is then.
        return DeferredPath.of("park", this, from -> stepParkFrom(from));
    }

    private Command stepParkFrom(Pose from) {
        Path seg0 = Paths.line(from, alliance(pose(-56.0, 36.0, 3.1416)) /* ref: parkLoadingZone */).reverseTangent();
        Path path = seg0;
        Command drive = followPath(path, defaultSpeedFraction());
        return drive;
    }
}
