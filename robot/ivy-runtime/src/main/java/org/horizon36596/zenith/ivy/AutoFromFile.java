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
import com.pedropathing.ivy.CommandBuilder;
import com.pedropathing.ivy.Scheduler;
import com.pedropathing.ivy.behaviors.BlockedBehavior;
import com.pedropathing.ivy.behaviors.ConflictBehavior;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;
import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;

import org.horizon36596.zenith.AllianceFrame;
import org.horizon36596.zenith.AutoFile;
import org.horizon36596.zenith.AutoSource;

import java.util.ArrayList;
import java.util.List;

/**
 * An autonomous OpMode whose routine is a file, run on Ivy. {@code zenith deploy} generates one subclass
 * per auto file when {@code zenith.json} says {@code "commandLibrary": "ivy"}, and each says two things:
 * which file, and which robot.
 *
 * <pre>{@code
 * @Autonomous(name = "First auto", group = "Generated")
 * public final class FirstAutoAuto extends AutoFromFile {
 *     @Override protected String autoName() { return "first-auto"; }
 *     @Override protected ZenithRobot createRobot() { return new MyRobot(); }
 * }
 * }</pre>
 *
 * <p>{@code AutoFromFile} and {@code ZenithRobot} here are the ones in {@code org.horizon36596.zenith.ivy};
 * {@code MyRobot} is the team's Ivy {@link ZenithRobot}.
 *
 * <h2>Order of events</h2>
 * <ol>
 *   <li><b>Init</b> ({@link #initialize()}): {@code Scheduler.reset()}, because Ivy's scheduler is static
 *       and outlives the last OpMode; read and check the file; build the robot ({@link ZenithRobot#init});
 *       fill {@link NamedCommands} ({@link ZenithRobot#registerCommands}); put the robot at the
 *       alliance-correct start pose; build the whole routine.</li>
 *   <li><b>Waiting for start</b> ({@link #initialize_loop()}): show the file and its step count.</li>
 *   <li><b>Start</b> ({@link #startRoutine()}): {@code Scheduler.schedule(routine)}, which starts it at
 *       once, then a check that Ivy did start it. A command still running from init that holds one of
 *       its requirements at a higher priority would make Ivy drop the routine without a word; the
 *       OpMode fails instead, naming the requirement.</li>
 *   <li><b>Every loop</b> ({@link #run()}): {@link ZenithRobot#periodic}, which updates the follower by
 *       default, then {@code Scheduler.execute()}. The same order as SolversLib, whose scheduler runs
 *       every subsystem's {@code periodic()} before any command.</li>
 *   <li><b>Stop</b> ({@link #reset()}): {@code Scheduler.reset()}, which ends nothing, as SolversLib's
 *       {@code CommandOpMode.reset()} ends nothing. It runs however the OpMode stops, a thrown exception
 *       included, so the next OpMode starts with an empty scheduler.</li>
 * </ol>
 *
 * <p>So a missing file, a bad version, an unknown command name or an unreachable waypoint all fail on
 * the tile with a message, never at the whistle with a robot that does nothing.
 *
 * <h2>Alliance</h2>
 * {@link #alliance} mirrors <b>if and only if</b> the alliance the Driver Station selected is not the
 * file's ({@link AutoFile#mirrorsInto}).
 *
 * <p>A path's headings are mirrored from that same call ({@link AllianceFrame}, through
 * {@link #headingRad} and {@link #turnRad} in a generated class), so a {@code constant} heading, a
 * {@code linear} sweep, a {@code facePoint} point and every {@code piecewise} range turn exactly when the
 * poses do.
 *
 * <h2>Where the file comes from</h2>
 * By default the APK's {@code assets/autos/}. A headless sim calls {@link #setAutoSource(AutoSource)}
 * before the OpMode is initialised and points it at the source tree.
 */
public abstract class AutoFromFile extends LinearOpMode implements AutoContext {

    /** @return the file stem: {@code "first-auto"} loads {@code assets/autos/first-auto.auto.json} */
    protected abstract String autoName();

    /** @return a new instance of this team's robot; called once per init */
    protected abstract ZenithRobot createRobot();

    /** The parsed file. Valid from the top of {@link #initialize()} onwards. */
    protected AutoFile spec;

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
    public AutoFile spec() {
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

    /** Init: see <b>Order of events</b>. */
    public void initialize() {
        Scheduler.reset();
        spec = AutoFile.loadForInit(autoSource(), autoName());
        robot = createRobot();
        if (robot == null) {
            throw new IllegalStateException(getClass().getSimpleName() + ".createRobot() returned null");
        }
        robot.init(this);
        NamedCommands.reset();
        robot.registerCommands(this);
        // Read once, here, so a mirror whose headings disagree with its positions fails on the tile,
        // whichever way the routine is built.
        frame = AutoBuilder.frame(this);
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
    protected Pose startPose() {
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

    /** One loop while waiting for start. */
    public void initialize_loop() {
        robot.initLoop(this);
        telemetry.addData("Auto file", autoName() + ".auto.json (" + spec.title + ")");
        telemetry.addData("Auto steps", spec.steps.size());
        telemetry.update();
    }

    /**
     * Start: schedule the routine, which Ivy starts at once, and check that it did.
     *
     * <p>Ivy's {@code schedule} returns nothing and can decline (ADR 0007 section 4). When a command
     * already running holds one of the routine's requirements at a higher priority, the routine is
     * blocked, and with the default {@code BlockedBehavior.CANCEL} it is dropped without a word; that is
     * a team command scheduled during init or {@link ZenithRobot#initLoop} with a raised priority. A
     * routine a subclass built with {@code QUEUE} behaviours may be queued instead, and would start only
     * when that command ends. Either way the auto would not run at the whistle, so this fails instead,
     * on the Driver Station and in telemetry, naming each requirement another command holds.
     *
     * <p>A command holding a requirement at the routine's priority or below is interrupted, as the
     * routine's {@code ConflictBehavior.OVERRIDE} and Ivy's priority rule say, and the routine starts.
     *
     * @throws IllegalStateException when Ivy's scheduler did not start the routine
     */
    public void startRoutine() {
        Scheduler.schedule(routine);
        if (Scheduler.isRunning(routine)) {
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

    /** Why Ivy did not start {@code routine}, naming each of its requirements another command holds. */
    private String notStartedMessage(Command routine) {
        boolean queued = Scheduler.isScheduled(routine);
        List<Object> held = heldRequirements(routine);
        StringBuilder names = new StringBuilder();
        for (Object requirement : held) {
            names.append(names.length() == 0 ? "" : ", ").append(describe(requirement));
        }
        String holds = held.isEmpty() ? "one of its requirements"
                : (held.size() == 1 ? "its requirement " : "its requirements ") + names;
        String why = queued
                ? "holds " + holds + ", and the routine's blocked or conflict behaviour is QUEUE, so it would"
                        + " start only when that command ends."
                : "holds " + holds + " at a priority above the routine's (" + routine.priority() + ").";
        return "Ivy's scheduler " + (queued ? "queued" : "blocked") + " the auto routine instead of starting it,"
                + " so " + getClass().getSimpleName() + " would not run at the whistle. A command that is"
                + " already running " + why + " A command scheduled during init or initLoop is the usual"
                + " cause: cancel it before start, or give it a priority no higher than " + routine.priority()
                + ".";
    }

    /**
     * Which of {@code command}'s requirements another command holds. Ivy has no call that says, so each
     * requirement is tried with a probe that can never displace anything: the lowest priority there is,
     * and {@code CANCEL} for both blocked and conflict behaviour, so Ivy drops it rather than
     * interrupting the holder (ADR 0007 section 4). A probe Ivy starts found its requirement free and
     * is cancelled at once; it does nothing when started or ended.
     */
    private static List<Object> heldRequirements(Command command) {
        List<Object> held = new ArrayList<Object>();
        for (Object requirement : command.requirements()) {
            Command probe = new CommandBuilder()
                    .requiring(requirement)
                    .setPriority(Integer.MIN_VALUE)
                    .setBlockedBehavior(BlockedBehavior.CANCEL)
                    .setConflictBehavior(ConflictBehavior.CANCEL);
            Scheduler.schedule(probe);
            if (Scheduler.isRunning(probe)) {
                Scheduler.cancel(probe);
            } else {
                held.add(requirement);
            }
        }
        return held;
    }

    /** A requirement as a person reads it: the follower and the robot's drive by name. */
    private String describe(Object requirement) {
        if (robot != null && requirement == robot.follower()) {
            return "the follower (" + requirement + ")";
        }
        if (robot != null && requirement == robot.drive()) {
            return "drive() (" + requirement + ")";
        }
        return String.valueOf(requirement);
    }

    /** One loop after start: the robot's {@link ZenithRobot#periodic}, then the scheduler. */
    public void run() {
        robot.periodic(this);
        Scheduler.execute();
    }

    /** Stop: empty the scheduler. Ends nothing; see <b>Order of events</b>. */
    public void reset() {
        Scheduler.reset();
    }

    @Override
    public void runOpMode() throws InterruptedException {
        try {
            initialize();
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
            reset();
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
    public Object drive() {
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
    public Pose alliance(Pose filePose) {
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
    public Pose currentPose() {
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
