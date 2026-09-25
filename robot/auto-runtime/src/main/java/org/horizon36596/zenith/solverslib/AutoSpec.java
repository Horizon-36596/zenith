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

import org.horizon36596.zenith.AutoFile;
import org.horizon36596.zenith.AutoSource;
import org.horizon36596.zenith.FilePose;
import org.horizon36596.zenith.Json;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One {@code *.auto.json} file, parsed and resolved, ready for {@link AutoBuilder} to turn into
 * SolversLib commands. Parsing happens once at OpMode init, so a bad file fails on the tile rather than
 * at the whistle.
 *
 * <p>This is {@link AutoFile}, the parser both runtimes share, with its poses handed out as SolversLib
 * {@link Pose2d}. Every rule about what a file means - waypoints, step ids, {@code "current"}, the
 * version check, every error message - is {@link AutoFile}'s, so the SolversLib and Ivy runtimes read a
 * file identically. The javadoc there is the reference; this class only converts.
 *
 * <h2>Alliance</h2>
 * A file declares the alliance its poses are written for, and the runtime <b>mirrors if and only if</b>
 * the alliance the Driver Station selected is not that one ({@link #mirrorsInto}). {@link AutoFromFile}
 * applies it in {@link AutoContext#alliance}, so every pose in the file-driven stack goes through the one
 * mirror call and no pose goes through it twice.
 */
public final class AutoSpec {

    /** The newest {@code formatVersion} this runtime understands; {@link AutoFile#FORMAT_VERSION}. */
    public static final int FORMAT_VERSION = AutoFile.FORMAT_VERSION;

    /** The oldest {@code formatVersion} this runtime understands; {@link AutoFile#MIN_FORMAT_VERSION}. */
    public static final int MIN_FORMAT_VERSION = AutoFile.MIN_FORMAT_VERSION;

    /** The alliance a file is taken to be written for when it does not say. */
    public static final String CANONICAL_ALLIANCE = AutoFile.CANONICAL_ALLIANCE;

    /** The waypoint file every auto shares, read from the same folder as the auto. */
    public static final String WAYPOINTS_FILE = AutoFile.WAYPOINTS_FILE;

    /** Short name, the file's stem: {@code first-auto.auto.json} is {@code "first-auto"}. */
    public final String name;

    /** Human title, what the Driver Station shows. Defaults to {@link #name}. */
    public final String title;

    /** Free text from the file, or the empty string. Not used by the runtime; carried for logging. */
    public final String description;

    /**
     * The alliance this file's poses are written for, {@code "RED"} or {@code "BLUE"};
     * {@link #mirrorsInto} is what reads it.
     */
    public final String alliance;

    /** Where the robot is placed before start, in the file's alliance frame. {@link AutoFromFile} mirrors it. */
    public final Pose2d startPose;

    /** The routine, in order. */
    public final List<Step> steps;

    /** What the file says that this runtime read past; {@link AutoFile#warnings}. */
    public final List<String> warnings;

    /** The library-neutral file this was converted from. */
    final AutoFile file;

    private AutoSpec(AutoFile file) {
        this.file = file;
        this.name = file.name;
        this.title = file.title;
        this.description = file.description;
        this.alliance = file.alliance;
        this.startPose = fromPedro(file.startPose);
        this.steps = Collections.unmodifiableList(steps(file.steps));
        this.warnings = file.warnings;
    }

    /**
     * Whether this file's poses have to be mirrored to be driven as {@code runningAlliance}.
     *
     * @param runningAlliance the alliance the OpMode is running as, {@code "RED"} or {@code "BLUE"}
     * @return true when the file's poses must be mirrored to be driven as {@code runningAlliance}
     */
    public boolean mirrorsInto(String runningAlliance) {
        return file.mirrorsInto(runningAlliance);
    }

    // ---------------------------------------------------------------------------------------------
    // Loading: every call goes to AutoFile
    // ---------------------------------------------------------------------------------------------

    /**
     * Read {@code <autoName>.auto.json} and, if it is there, {@code waypoints.json} from {@code source}.
     *
     * @param source    the APK's assets on the robot, a folder in the headless sim ({@link AutoSource})
     * @param autoName  the file stem, for example {@code "first-auto"}
     * @throws IllegalStateException    when the file's {@code formatVersion} is not this runtime's
     * @throws IllegalArgumentException when the file is malformed or names something that is not there
     * @throws java.io.IOException      when the file cannot be read at all
     * @return the parsed, resolved file
     */
    public static AutoSpec load(AutoSource source, String autoName) throws IOException {
        return new AutoSpec(AutoFile.load(source, autoName));
    }

    /**
     * {@link #load}, with a read failure turned into an {@link IllegalStateException} that names the file
     * and where it was looked for. What {@link AutoFromFile} calls at init.
     *
     * @param source   where to read from
     * @param autoName the file stem
     * @return the parsed, resolved file
     */
    public static AutoSpec loadForInit(AutoSource source, String autoName) {
        return new AutoSpec(AutoFile.loadForInit(source, autoName));
    }

    /**
     * The waypoints in {@code source}, or an empty map when the file is absent.
     *
     * @param source where to read {@code waypoints.json} from
     * @return the waypoints by name, in file order
     * @throws IOException when the file exists and cannot be read
     */
    public static Map<String, Pose2d> loadWaypoints(AutoSource source) throws IOException {
        Map<String, Pose2d> out = new LinkedHashMap<String, Pose2d>();
        for (Map.Entry<String, Pose> entry : AutoFile.loadWaypoints(source).entrySet()) {
            out.put(entry.getKey(), fromPedro(entry.getValue()));
        }
        return Collections.unmodifiableMap(out);
    }

    /**
     * Parse an already-read document. Separated from {@link #load} so tests can pass a string.
     *
     * @param root      the parsed JSON document
     * @param autoName  the file stem, used when the file has no {@code name}
     * @param waypoints the waypoints {@code {"ref": ...}} poses resolve against
     * @return the parsed, resolved file
     */
    public static AutoSpec parse(Json root, String autoName, Map<String, Pose2d> waypoints) {
        Map<String, Pose> pedro = new LinkedHashMap<String, Pose>();
        for (Map.Entry<String, Pose2d> entry : waypoints.entrySet()) {
            Pose2d pose = entry.getValue();
            pedro.put(entry.getKey(), new FilePose(pose.getX(), pose.getY(), pose.getHeading()));
        }
        return new AutoSpec(AutoFile.parse(root, autoName, pedro));
    }

    // ---------------------------------------------------------------------------------------------
    // Conversion
    // ---------------------------------------------------------------------------------------------

    /**
     * A pose, or {@code null} for {@code "current"}, which stays {@code null}. The heading is the one the
     * file wrote, not Pedro's normalised one; see {@link FilePose}.
     */
    private static Pose2d fromPedro(Pose pose) {
        return pose == null ? null
                : new Pose2d(pose.x(), pose.y(), new Rotation2d(FilePose.headingOf(pose)));
    }

    private static Heading heading(AutoFile.Heading h) {
        List<HeadingRange> ranges = new ArrayList<HeadingRange>(h.ranges.size());
        for (AutoFile.HeadingRange range : h.ranges) {
            ranges.add(new HeadingRange(range.startT, range.endT, heading(range.heading)));
        }
        return new Heading(h.mode, h.headingRad, h.fromRad, h.toRad, h.pointXIn, h.pointYIn, ranges);
    }

    /** The shared form of {@code h}, for {@link PedroPaths}. */
    static AutoFile.Heading toFile(Heading h) {
        List<AutoFile.HeadingRange> ranges = new ArrayList<AutoFile.HeadingRange>(h.ranges.size());
        for (HeadingRange range : h.ranges) {
            ranges.add(new AutoFile.HeadingRange(range.startT, range.endT, toFile(range.heading)));
        }
        return new AutoFile.Heading(h.mode, h.headingRad, h.fromRad, h.toRad, h.pointXIn, h.pointYIn, ranges);
    }

    private static List<Step> steps(List<AutoFile.Step> from) {
        List<Step> out = new ArrayList<Step>(from.size());
        for (AutoFile.Step step : from) {
            out.add(step(step));
        }
        return out;
    }

    private static Step step(AutoFile.Step step) {
        if (step instanceof AutoFile.PathStep) {
            AutoFile.PathStep path = (AutoFile.PathStep) step;
            List<Segment> segments = new ArrayList<Segment>(path.segments.size());
            for (AutoFile.Segment segment : path.segments) {
                List<Pose2d> control = new ArrayList<Pose2d>(segment.control.size());
                for (Pose point : segment.control) {
                    control.add(fromPedro(point));
                }
                segments.add(new Segment(segment.kind, fromPedro(segment.from), control,
                        fromPedro(segment.to)));
            }
            Heading heading = heading(path.heading);
            List<Marker> markers = new ArrayList<Marker>(path.markers.size());
            for (AutoFile.Marker m : path.markers) {
                markers.add(new Marker(m));
            }
            return new PathStep(path, segments, heading, markers);
        }
        if (step instanceof AutoFile.CommandStep) {
            AutoFile.CommandStep command = (AutoFile.CommandStep) step;
            return new CommandStep(step.id, step.timeoutS, command.name, command.args);
        }
        if (step instanceof AutoFile.WaitStep) {
            AutoFile.WaitStep wait = (AutoFile.WaitStep) step;
            return new WaitStep(step.id, step.timeoutS, wait.seconds, wait.until);
        }
        if (step instanceof AutoFile.ParallelStep) {
            AutoFile.ParallelStep parallel = (AutoFile.ParallelStep) step;
            return new ParallelStep(step.id, parallel.mode, parallel.deadlineId,
                    steps(parallel.steps));
        }
        if (step instanceof AutoFile.BranchStep) {
            AutoFile.BranchStep branch = (AutoFile.BranchStep) step;
            return new BranchStep(step.id, branch.condition, steps(branch.then),
                    steps(branch.otherwise));
        }
        if (step instanceof AutoFile.SequenceStep) {
            return new SequenceStep(step.id, steps(((AutoFile.SequenceStep) step).steps));
        }
        throw new IllegalStateException("unhandled step type " + step.getClass().getName());
    }

    // ---------------------------------------------------------------------------------------------
    // The step model, the same shape as AutoFile's with SolversLib poses
    // ---------------------------------------------------------------------------------------------

    /** One step of a routine. {@code id} is what {@link AutoContext#step} is called with. */
    public abstract static class Step {
        /**
         * The step's effective id ({@link AutoFile#effectiveId}): the file's {@code id} when it has one,
         * its position when it does not. Never null, which is what lets {@link AutoBuilder} compare it
         * against a parallel's {@code deadline} without a null check on every member.
         */
        public final String id;
        /**
         * Seconds this step is allowed, or {@code null}. Enforced by {@link RobotTimeout}. Always
         * {@code null} on a group step; see {@link AutoFile.Step#timeoutS}.
         */
        public final Double timeoutS;

        Step(String id, Double timeoutS) {
            this.id = id;
            this.timeoutS = timeoutS;
        }
    }

    /** Drive a path. Poses are canonical alliance; a {@code null} {@code from} means "wherever we are". */
    public static final class PathStep extends Step {
        public final List<Segment> segments;
        public final Heading heading;
        /**
         * Fraction of the robot's maximum speed, 0 to 1, or {@code null} when the file gives none and
         * {@link AutoContext#defaultSpeedFraction()} applies.
         */
        public final Double speedFraction;
        public final List<Marker> markers;
        /** A condition name that cuts the path short, or {@code null}. */
        public final String endCondition;

        /** The library-neutral step, whose heading {@link PathBuilder} hands to {@link PedroPaths}. */
        final AutoFile.PathStep file;

        PathStep(AutoFile.PathStep file, List<Segment> segments, Heading heading, List<Marker> markers) {
            super(file.id, file.timeoutS);
            this.file = file;
            this.segments = Collections.unmodifiableList(segments);
            this.heading = heading;
            this.speedFraction = file.speedFraction;
            this.markers = Collections.unmodifiableList(markers);
            this.endCondition = file.endCondition;
        }

        /** @return true when this path starts from the live pose and so cannot be built until it runs */
        public boolean startsFromCurrentPose() {
            return segments.get(0).from == null;
        }
    }

    /** Run a named command from {@link NamedCommands}. */
    public static final class CommandStep extends Step {
        public final String name;
        public final Map<String, Object> args;

        CommandStep(String id, Double timeoutS, String name, Map<String, Object> args) {
            super(id, timeoutS);
            this.name = name;
            this.args = args;
        }
    }

    /** Wait a fixed time on the robot's clock, or until a named condition is true. */
    public static final class WaitStep extends Step {
        /** Seconds, or {@code null} when {@link #until} is set. */
        public final Double seconds;
        /** A condition name, or {@code null} when {@link #seconds} is set. */
        public final String until;

        WaitStep(String id, Double timeoutS, Double seconds, String until) {
            super(id, timeoutS);
            this.seconds = seconds;
            this.until = until;
        }
    }

    /** Run several steps at once. {@code mode} is {@code all}, {@code race} or {@code deadline}. */
    public static final class ParallelStep extends Step {
        public final String mode;
        /** The id of the member step that ends the group, for {@code deadline}. */
        public final String deadlineId;
        public final List<Step> steps;

        ParallelStep(String id, String mode, String deadlineId, List<Step> steps) {
            super(id, null);
            this.mode = mode;
            this.deadlineId = deadlineId;
            this.steps = Collections.unmodifiableList(steps);
        }
    }

    /** Run one of two sequences depending on a named condition. */
    public static final class BranchStep extends Step {
        public final String condition;
        public final List<Step> then;
        public final List<Step> otherwise;

        BranchStep(String id, String condition, List<Step> then, List<Step> otherwise) {
            super(id, null);
            this.condition = condition;
            this.then = Collections.unmodifiableList(then);
            this.otherwise = Collections.unmodifiableList(otherwise);
        }
    }

    /**
     * A group of steps in order, addressed as one step (formatVersion 2). {@link AutoBuilder} builds it
     * as one {@code SequentialCommandGroup}, so it can be a {@code parallel}'s {@code deadline} member,
     * an arm of a {@code branch}, or sit next to any other step.
     */
    public static final class SequenceStep extends Step {
        public final List<Step> steps;

        SequenceStep(String id, List<Step> steps) {
            super(id, null);
            this.steps = Collections.unmodifiableList(steps);
        }
    }

    /** One leg of a path. {@code from == null} means the live pose. */
    public static final class Segment {
        /** {@code "line"} or {@code "bezier"}. */
        public final String kind;
        public final Pose2d from;
        /** Bezier control points, empty for a line. */
        public final List<Pose2d> control;
        public final Pose2d to;

        Segment(String kind, Pose2d from, List<Pose2d> control, Pose2d to) {
            this.kind = kind;
            this.from = from;
            this.control = Collections.unmodifiableList(control);
            this.to = to;
        }
    }

    /** How the chassis is pointed along a path. See site/docs/file-format.md. */
    public static final class Heading {
        /**
         * {@code tangent}, {@code tangentReversed}, {@code constant}, {@code linear}, {@code facePoint} or
         * {@code piecewise}.
         */
        public final String mode;
        /** {@code constant} only, radians. */
        public final double headingRad;
        /** {@code linear} only, radians. */
        public final double fromRad;
        /** {@code linear} only, radians. */
        public final double toRad;
        /** {@code facePoint} only, inches. */
        public final double pointXIn;
        /** {@code facePoint} only, inches. */
        public final double pointYIn;
        /** {@code piecewise} only: the ranges in order, covering t 0 to 1; empty for every other mode. */
        public final List<HeadingRange> ranges;

        Heading(String mode, double headingRad, double fromRad, double toRad,
                double pointXIn, double pointYIn) {
            this(mode, headingRad, fromRad, toRad, pointXIn, pointYIn, Collections.<HeadingRange>emptyList());
        }

        Heading(String mode, double headingRad, double fromRad, double toRad,
                double pointXIn, double pointYIn, List<HeadingRange> ranges) {
            this.mode = mode;
            this.headingRad = headingRad;
            this.fromRad = fromRad;
            this.toRad = toRad;
            this.pointXIn = pointXIn;
            this.pointYIn = pointYIn;
            this.ranges = Collections.unmodifiableList(ranges);
        }
    }

    /**
     * One range of a {@code piecewise} heading: from {@code startT} to {@code endT}, fractions of the
     * step's arc length, the robot points the way {@code heading} says.
     */
    public static final class HeadingRange {
        public final double startT;
        public final double endT;
        /** Never {@code piecewise}. */
        public final Heading heading;

        HeadingRange(double startT, double endT, Heading heading) {
            this.startT = startT;
            this.endT = endT;
            this.heading = heading;
        }
    }

    /** A command fired part-way along a path. Exactly one of the three positions is set. */
    public static final class Marker {
        /** Arc-length fraction of the whole step, 0 to 1, or {@code null}. */
        public final Double t;
        /** Inches from the start of the step, or {@code null}. */
        public final Double distanceIn;
        /** Inches before the end of the step, or {@code null}. */
        public final Double distanceFromEndIn;
        public final String commandName;
        public final Map<String, Object> args;

        private final AutoFile.Marker file;

        Marker(AutoFile.Marker file) {
            this.file = file;
            this.t = file.t;
            this.distanceIn = file.distanceIn;
            this.distanceFromEndIn = file.distanceFromEndIn;
            this.commandName = file.commandName;
            this.args = file.args;
        }

        /**
         * Where this marker fires, in inches from the start of the step. {@link AutoFile.Marker}'s rule.
         *
         * @param totalLengthIn the step's whole arc length, from {@link PathBuilder.Built#totalLengthIn}
         * @return inches from the start of the step
         */
        public double distanceAlongIn(double totalLengthIn) {
            return file.distanceAlongIn(totalLengthIn);
        }
    }
}
