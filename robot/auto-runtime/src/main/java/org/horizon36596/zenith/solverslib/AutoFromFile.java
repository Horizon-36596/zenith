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

import org.horizon36596.zenith.AllianceFrame;
import org.horizon36596.zenith.AutoSource;

import com.pedropathing.follower.Follower;
import com.pedropathing.paths.Path;
import com.seattlesolvers.solverslib.command.Command;
import com.seattlesolvers.solverslib.command.CommandOpMode;
import com.seattlesolvers.solverslib.command.CommandScheduler;
import com.seattlesolvers.solverslib.command.Robot;
import com.seattlesolvers.solverslib.command.Subsystem;
import com.seattlesolvers.solverslib.geometry.Pose2d;

import java.util.ArrayList;
import java.util.List;

/**
 * An autonomous OpMode whose routine is a file. {@code zenith deploy} generates one subclass per auto
 * file, and each says two things: which file, and which robot.
 *
 * <pre>{@code
 * @Autonomous(name = "First auto", group = "Generated")
 * public final class FirstAutoAuto extends AutoFromFile {
 *     @Override protected String autoName() { return "first-auto"; }
 *     @Override protected ZenithRobot createRobot() { return new MyRobot(); }
 * }
 * }</pre>
 *
 * <p>One class per auto file, because the Driver Station lists classes, not assets. They are generated,
 * not written, and nothing in the generated folder should ever be edited by hand. {@code MyRobot} is the
 * team's {@link ZenithRobot}, named in {@code zenith.json} as {@code deploy.robotClass}.
 *
 * <h2>Order of events</h2>
 * <ol>
 *   <li><b>Init</b> ({@link #initialize()}): read and check the file, build the robot
 *       ({@link ZenithRobot#init}), fill {@link NamedCommands} ({@link ZenithRobot#registerCommands}),
 *       put the robot at the alliance-correct start pose, and build the whole routine.</li>
 *   <li><b>Waiting for start</b> ({@link #initialize_loop()}): show the file and its step count.</li>
 *   <li><b>Start</b> ({@link #startRoutine()}): schedule the routine, then check that SolversLib did. A
 *       command still running from init that holds one of its requirements and was scheduled as not
 *       interruptible would make SolversLib drop the routine without a word; the OpMode fails instead,
 *       naming the requirement and the command. Then run SolversLib's scheduler once per loop until the
 *       OpMode stops.</li>
 * </ol>
 *
 * <p>{@link #runOpMode()} is written out here rather than inherited from {@code CommandOpMode}, because
 * the SolversLib releases in use disagree about the hook that runs at start: 0.3.6 calls
 * {@code preRun()}, while at least one copy vendored into a TeamCode calls {@code startOnce()} instead.
 * A routine scheduled from the hook the running copy does not call would never run, with no error. The
 * loop below uses only what every copy has: {@code initialize()}, {@code initialize_loop()},
 * {@code schedule}, {@code run()}, {@code end()} and {@code reset()}.
 * So a missing file, a bad version, an unknown command name or an unreachable waypoint all fail on the
 * tile with a message, never at the whistle with a robot that does nothing.
 *
 * <h2>Alliance</h2>
 * {@link #alliance} mirrors <b>if and only if</b> the alliance the Driver Station selected is not the
 * file's ({@link AutoSpec#mirrorsInto}). A routine mirrored in the editor and saved as a BLUE file, run as
 * BLUE, is therefore not mirrored a second time.
 *
 * <p>A path's headings are mirrored from that same call ({@link AllianceFrame}, through
 * {@link #headingRad} and {@link #turnRad} in a generated class), so a {@code constant} heading, a
 * {@code linear} sweep, a {@code facePoint} point and every {@code piecewise} range turn exactly when the
 * poses do.
 *
 * <h2>Where the file comes from</h2>
 * By default the APK's {@code assets/autos/}. A headless sim has no APK and no Android context, so a test
 * calls {@link #setAutoSource(AutoSource)} before the OpMode is initialised and points it at the source
 * tree, for example {@code TeamCode/src/main/assets/autos}.
 */
public abstract class AutoFromFile extends CommandOpMode implements AutoContext {

    /** @return the file stem: {@code "first-auto"} loads {@code assets/autos/first-auto.auto.json} */
    protected abstract String autoName();

    /** @return a new instance of this team's robot; called once per init */
    protected abstract ZenithRobot createRobot();

    /** The parsed file. Valid from the top of {@link #initialize()} onwards. */
    protected AutoSpec spec;

    /** The team's robot. Valid from {@link #initialize()} onwards. */
    protected ZenithRobot robot;

    /** The whole routine, built at init and scheduled at start. */
    private Command routine;

    /** The running alliance's frame, read from {@link #alliance} at init. */
    private AllianceFrame frame;

    /** Set by a test; {@code null} on the robot, which means the APK's assets. */
    private AutoSource source;

    /**
     * Read the auto from somewhere other than the APK. Call before the OpMode is initialised; after
     * that it has no effect.
     *
     * @param source where to read the auto file and {@code waypoints.json} from
     */
    public void setAutoSource(AutoSource source) {
        this.source = source;
    }

    /** @return where this OpMode reads from, for telemetry and for error messages */
    protected AutoSource autoSource() {
        return source != null ? source : AutoSource.assets(hardwareMap.appContext);
    }

    /** @return the parsed file, or {@code null} before {@link #initialize()} */
    public AutoSpec spec() {
        return spec;
    }

    /** @return the team's robot, or {@code null} before {@link #initialize()} */
    public ZenithRobot robot() {
        return robot;
    }

    /** @return the built routine, or {@code null} before {@link #initialize()} */
    public Command routine() {
        return routine;
    }

    @Override
    public void initialize() {
        spec = AutoSpec.loadForInit(autoSource(), autoName());
        robot = createRobot();
        if (robot == null) {
            throw new IllegalStateException(getClass().getSimpleName() + ".createRobot() returned null");
        }
        robot.init(this);
        NamedCommands.reset();
        robot.registerCommands(this);
        // Read once, here, so a mirror whose headings disagree with its positions fails on the tile,
        // whichever way the routine is built.
        frame = PathBuilder.frame(this);
        robot.setStartPose(startPose());
        routine = buildRoutine();
        if (routine == null) {
            throw new IllegalStateException(getClass().getSimpleName() + ".buildRoutine() returned null");
        }
    }

    /**
     * Where the robot is placed before start. The file's start pose in the running alliance's frame,
     * unless a subclass says otherwise; {@code zenith codegen}'s readable classes override it.
     *
     * @return the start pose, running alliance's frame, inches and radians
     */
    protected Pose2d startPose() {
        return alliance(spec.startPose);
    }

    /**
     * The whole routine, built at init. {@link AutoBuilder#build} on the file, unless a subclass says
     * otherwise; {@code zenith codegen}'s readable classes override it with the same tree written out
     * as Java.
     *
     * @return the routine
     */
    protected Command buildRoutine() {
        return AutoBuilder.build(spec, this);
    }

    @Override
    public void initialize_loop() {
        robot.initLoop(this);
        telemetry.addData("Auto file", autoName() + ".auto.json (" + spec.title + ")");
        telemetry.addData("Auto steps", spec.steps.size());
        telemetry.update();
    }

    /**
     * Start: schedule the routine, which SolversLib initialises at once, and check that it did.
     *
     * <p>SolversLib's {@code schedule} returns nothing and can decline (ADR 0007 section 4). When a
     * command already running holds one of the routine's requirements and was scheduled as not
     * interruptible ({@code schedule(false, ...)}), the routine is dropped without a word; that is a team
     * command scheduled during init or {@link ZenithRobot#initLoop}. The auto would not run at the
     * whistle, so this fails instead, on the Driver Station and in telemetry, naming each requirement
     * another command holds and the command holding it ({@code CommandScheduler.requiring}). The same
     * happens, with a message that says why, when the scheduler or {@code Robot.isDisabled} has disabled
     * it.
     *
     * <p>A command holding a requirement that was scheduled as interruptible, SolversLib's default, is
     * interrupted, and the routine starts.
     *
     * @throws IllegalStateException when SolversLib's scheduler did not schedule the routine
     */
    public void startRoutine() {
        schedule(routine);
        if (CommandScheduler.getInstance().isScheduled(routine)) {
            return;
        }
        String problem = notStartedMessage(routine);
        try {
            telemetry.addData("Zenith", problem);
            telemetry.update();
        } catch (RuntimeException telemetryProblem) {
            // Telemetry is a courtesy here: off the robot (a headless sim) it may have nothing to send
            // to, and the exception below carries the same message to the Driver Station either way.
        }
        throw new IllegalStateException(problem);
    }

    /** Why SolversLib did not schedule {@code routine}, naming each of its requirements another command holds. */
    private String notStartedMessage(Command routine) {
        CommandScheduler scheduler = CommandScheduler.getInstance();
        List<String> held = new ArrayList<String>();
        for (Subsystem requirement : routine.getRequirements()) {
            Command holder = scheduler.requiring(requirement);
            if (holder != null && holder != routine) {
                held.add(describe(requirement) + ", held by " + nameOf(holder));
            }
        }
        String opMode = getClass().getSimpleName();
        if (held.isEmpty()) {
            String why = Robot.isDisabled && !routine.runsWhenDisabled()
                    ? "Robot.isDisabled is true, and the routine does not run when disabled."
                    : "No command holds any of its requirements, so the scheduler itself is disabled"
                            + " (CommandScheduler.disable()).";
            return "SolversLib's scheduler did not schedule the auto routine, so " + opMode + " would not run at"
                    + " the whistle. " + why + " Enable it before start.";
        }
        StringBuilder names = new StringBuilder();
        for (String name : held) {
            names.append(names.length() == 0 ? "" : "; ").append(name);
        }
        String why = held.size() == 1
                ? "A command that is already running holds its requirement " + names + ", and it was scheduled"
                        + " as not interruptible, which SolversLib never interrupts."
                : "Commands that are already running hold its requirements " + names + ", and at least one of"
                        + " them was scheduled as not interruptible, which SolversLib never interrupts.";
        return "SolversLib's scheduler blocked the auto routine instead of starting it, so " + opMode
                + " would not run at the whistle. " + why + " A command scheduled during init or initLoop with"
                + " schedule(false, ...) is the usual cause: cancel it before start, or schedule it as"
                + " interruptible.";
    }

    /** A requirement as a person reads it: the robot's drive by name. */
    private String describe(Subsystem requirement) {
        if (robot != null && requirement == robot.drive()) {
            return "drive() (" + requirement + ")";
        }
        return String.valueOf(requirement);
    }

    /** A command's SolversLib name, or what it prints as when it has none. */
    private static String nameOf(Command command) {
        String name = command.getName();
        return name == null || name.isEmpty() ? String.valueOf(command) : name;
    }

    @Override
    public void runOpMode() throws InterruptedException {
        initialize();
        try {
            while (opModeInInit()) {
                initialize_loop();
            }
            if (opModeIsActive()) {
                startRoutine();
                while (opModeIsActive()) {
                    run();
                }
            }
        } finally {
            try {
                end();
            } finally {
                reset();
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // AutoContext, answered by the team's robot
    // ---------------------------------------------------------------------------------------------

    @Override
    public Follower follower() {
        return robot.follower();
    }

    @Override
    public Subsystem drive() {
        return robot.drive();
    }

    @Override
    public long nanoTime() {
        return robot.nanoTime();
    }

    /**
     * A pose as the file wrote it, in the frame this OpMode is running in. See <b>Alliance</b> above.
     *
     * @param filePose a pose in the file's own alliance frame, field frame, inches and radians
     * @return the same pose mirrored for the running alliance, or unchanged when the file was written
     *         for it
     */
    @Override
    public Pose2d alliance(Pose2d filePose) {
        return spec.mirrorsInto(robot.runningAlliance()) ? robot.mirror(filePose) : filePose;
    }

    /**
     * A heading from the file, in the frame this OpMode is running in: unchanged when the file was
     * written for the running alliance, and mirrored through {@link ZenithRobot#mirror} when it was not
     * ({@link AllianceFrame}), so it turns exactly as {@link #alliance} turns the poses. The classes
     * {@code zenith codegen} writes pass every {@code constant} heading, and the start of every
     * {@code linear} turn, through it.
     *
     * @param fileRad radians, as the file wrote it
     * @return radians, in the running alliance's frame
     */
    protected double headingRad(double fileRad) {
        return frame.heading(fileRad);
    }

    /**
     * A turn from the file, in the frame this OpMode is running in: the same size, and the other way
     * round when the mirror is a reflection. The classes {@code zenith codegen} writes pass every
     * {@code linear} turn through it.
     *
     * @param fileTurnRad radians turned, counter-clockwise positive, as the file wrote it
     * @return radians turned in the running alliance's frame
     */
    protected double turnRad(double fileTurnRad) {
        return frame.reversesTurns() ? -fileTurnRad : fileTurnRad;
    }

    @Override
    public Pose2d currentPose() {
        return robot.currentPose();
    }

    @Override
    public double defaultSpeedFraction() {
        return robot.defaultSpeedFraction();
    }

    @Override
    public Command followPath(Path path, double speedFraction) {
        Command own = robot.followPath(path, speedFraction);
        return own != null ? own : new FollowPath(this, path, speedFraction);
    }

    @Override
    public Path atSpeed(Path path, double speedFraction) {
        return robot.atSpeed(path, speedFraction);
    }

    @Override
    public Command step(String id, Command body) {
        return robot.step(id, body);
    }
}
