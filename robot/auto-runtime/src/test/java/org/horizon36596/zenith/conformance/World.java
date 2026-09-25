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

package org.horizon36596.zenith.conformance;

import com.pedropathing.follower.Follower;
import com.pedropathing.math.Pose;
import com.pedropathing.paths.Path;
import com.pedropathing.paths.PathSegment;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.UnaryOperator;

/**
 * The robot and field both runtimes drive in the conformance suite, written without naming either
 * command library.
 *
 * <p>The clock is {@link #loop} times 20 ms and only moves when the harness calls {@link #advance}. The
 * follower moves {@link #INCHES_PER_LOOP} along the path it was given on every {@code update()}, and
 * reports its segment and completion by arc length, so markers fire by geometry. A named command is an
 * {@link Action} that runs for a fixed number of loops. Every event lands in {@link #log} stamped with
 * the loop it happened in: a step starting or ending, a named command starting, executing or ending, a
 * path being followed, arriving or held, and a condition being read. The two runtimes must produce the
 * same log.
 */
public final class World {

    /** One loop of the OpMode, 20 ms. */
    public static final long LOOP_NANOS = 20_000_000L;

    /** How far the fake follower moves along its path on each update. */
    public static final double INCHES_PER_LOOP = 2.0;

    /** The robot's subsystems, by name; each runtime maps a name to its own requirement object. */
    public static final String DRIVE = "drive";
    public static final String INTAKE = "intake";
    public static final String SHOOTER = "shooter";

    public final List<String> log = new ArrayList<String>();

    /** The loop the OpMode is on: 0 at init and start, then one more per {@link #advance}. */
    public int loop;

    /** The loop from which {@code holdingPiece} reads true. */
    public int holdingPieceFrom = 12;

    /** The loop from which {@code hopperFull} reads true. */
    public int hopperFullFrom = 30;

    /** BIOBUZZ's mirror, a point symmetry through the field centre, as a team writes it. */
    public static final UnaryOperator<Pose> POINT_SYMMETRY = new UnaryOperator<Pose>() {
        @Override
        public Pose apply(Pose pose) {
            return new Pose(-pose.x(), -pose.y(), pose.heading() + Math.PI);
        }
    };

    /** A reflection across the field's x axis: no season's, but it reverses turns, as a point symmetry does not. */
    public static final UnaryOperator<Pose> MIRROR_X = new UnaryOperator<Pose>() {
        @Override
        public Pose apply(Pose pose) {
            return new Pose(pose.x(), -pose.y(), -pose.heading());
        }
    };

    /** The field's symmetry between the alliances; each run's {@code ZenithRobot.mirror} is this. */
    public UnaryOperator<Pose> mirror = POINT_SYMMETRY;

    /** Every path the follower was handed, in order. */
    public final List<Path> followed = new ArrayList<Path>();

    private List<PathSegment> segments = Collections.emptyList();
    private double[] lengths = new double[0];
    private double totalIn;
    private double travelledIn;
    private boolean following;
    private Pose pose = new Pose(0, 0, 0);

    /** A Pedro follower with no hardware behind it; see the class comment. */
    public final Follower follower = new Follower(null, null, null) {
        @Override
        public void update() {
            World.this.update();
        }

        @Override
        public void follow(Path path) {
            World.this.follow(path);
        }

        @Override
        public void hold(Pose target) {
            following = false;
            event("hold " + format(target));
        }

        @Override
        public Pose pose() {
            return pose;
        }

        @Override
        public boolean following() {
            return following;
        }

        @Override
        public int pathIndex() {
            return segmentAt(travelledIn);
        }

        @Override
        public double curveCompletion() {
            int index = segmentAt(travelledIn);
            if (index >= lengths.length) {
                return 1;
            }
            double before = 0;
            for (int i = 0; i < index; i++) {
                before += lengths[i];
            }
            return lengths[index] <= 0 ? 1 : (travelledIn - before) / lengths[index];
        }
    };

    /** @return the clock both runtimes read */
    public long nanoTime() {
        return loop * LOOP_NANOS;
    }

    /** One OpMode loop: the clock moves. The follower moves when the runtime updates it. */
    public void advance() {
        loop++;
    }

    /** Record {@code text}, stamped with the current loop. */
    public void event(String text) {
        log.add(loop + " " + text);
    }

    /** Place the robot at the start pose. */
    public void place(Pose where) {
        pose = where;
        event("start at " + format(where));
    }

    /**
     * @param name a condition name a fixture uses
     * @return whether it holds now
     */
    public boolean condition(String name) {
        boolean holds = holds(name);
        event("read " + name + " " + holds);
        return holds;
    }

    private boolean holds(String name) {
        if ("holdingPiece".equals(name)) {
            return loop >= holdingPieceFrom;
        }
        if ("hopperFull".equals(name)) {
            return loop >= hopperFullFrom;
        }
        if ("pastHalfway".equals(name)) {
            return following && travelledIn >= totalIn / 2;
        }
        if ("always".equals(name)) {
            return true;
        }
        if ("never".equals(name)) {
            return false;
        }
        throw new IllegalArgumentException("the conformance world has no condition \"" + name + "\"");
    }

    /** The conditions every run registers. */
    public static final String[] CONDITIONS = {"holdingPiece", "hopperFull", "pastHalfway", "always", "never"};

    /** The named commands every run registers; see {@link #action}. */
    public static final String[] COMMANDS = {
        "score", "intakeOn", "intakeOff", "spinUp", "instant", "take", "forever", "throwInStart",
        "throwInExecute", "failToBuild",
    };

    /**
     * The named command {@code name}, as a library-neutral action.
     *
     * <ul>
     *   <li>{@code score}, {@code spinUp}: 4 and 10 loops, needing the shooter.</li>
     *   <li>{@code intakeOn}, {@code intakeOff}, {@code instant}: done on their first loop.</li>
     *   <li>{@code take}: {@code args.loops} loops, needing {@code args.requires} when given.</li>
     *   <li>{@code forever}: never done.</li>
     *   <li>{@code throwInStart}, {@code throwInExecute}: throw where they say.</li>
     *   <li>{@code failToBuild}: its factory throws, at init.</li>
     * </ul>
     */
    public Action action(String name, Map<String, Object> args) {
        String label = args.isEmpty() ? name : name + " " + readable(args);
        if ("score".equals(name)) {
            return new Action(this, label, 4, SHOOTER, null);
        }
        if ("spinUp".equals(name)) {
            return new Action(this, label, 10, SHOOTER, null);
        }
        if ("intakeOn".equals(name) || "intakeOff".equals(name)) {
            return new Action(this, label, 0, INTAKE, null);
        }
        if ("instant".equals(name)) {
            return new Action(this, label, 0, null, null);
        }
        if ("take".equals(name)) {
            Object requires = args.get("requires");
            return new Action(this, label, ((Number) args.get("loops")).intValue(),
                    requires == null ? null : requires.toString(), null);
        }
        if ("forever".equals(name)) {
            return new Action(this, label, -1, null, null);
        }
        if ("throwInStart".equals(name)) {
            return new Action(this, label, 1, null, "start");
        }
        if ("throwInExecute".equals(name)) {
            return new Action(this, label, 5, null, "execute");
        }
        if ("failToBuild".equals(name)) {
            throw new IllegalStateException("failToBuild refused to build");
        }
        throw new IllegalArgumentException("the conformance world has no command \"" + name + "\"");
    }

    private void follow(Path path) {
        followed.add(path);
        segments = path.getSegments();
        lengths = new double[segments.size()];
        totalIn = 0;
        for (int i = 0; i < lengths.length; i++) {
            lengths[i] = segments.get(i).curve.length();
            totalIn += lengths[i];
        }
        travelledIn = 0;
        following = true;
        event(String.format(Locale.ROOT, "follow %d segments, %.2f in, to %s", lengths.length, totalIn,
                format(path.endPose())));
    }

    private void update() {
        if (!following) {
            return;
        }
        travelledIn = Math.min(totalIn, travelledIn + INCHES_PER_LOOP);
        int index = Math.min(segmentAt(travelledIn), segments.size() - 1);
        pose = segments.get(index).get(Math.max(0, Math.min(1, follower.curveCompletion())));
        if (travelledIn >= totalIn) {
            following = false;
            event("arrive " + format(pose));
        }
    }

    private int segmentAt(double alongIn) {
        double before = 0;
        for (int i = 0; i < lengths.length; i++) {
            before += lengths[i];
            if (alongIn < before) {
                return i;
            }
        }
        return lengths.length;
    }

    /** {@code args} sorted by key, with whole numbers written without a decimal point. */
    private static String readable(Map<String, Object> args) {
        Map<String, Object> sorted = new TreeMap<String, Object>();
        for (Map.Entry<String, Object> arg : args.entrySet()) {
            Object value = arg.getValue();
            if (value instanceof Double && ((Double) value) == Math.rint((Double) value)) {
                value = Long.valueOf(((Double) value).longValue());
            }
            sorted.put(arg.getKey(), value);
        }
        return sorted.toString();
    }

    static String format(Pose p) {
        return String.format(Locale.ROOT, "(%.2f, %.2f, %.3f)", p.x(), p.y(), p.heading());
    }

    /** A named command's behaviour; each runtime wraps it in its own command type. */
    public static final class Action {
        private final World world;
        public final String label;
        private final int loops;
        public final String requires;
        private final String throwIn;
        private int executed;

        Action(World world, String label, int loops, String requires, String throwIn) {
            this.world = world;
            this.label = label;
            this.loops = loops;
            this.requires = requires;
            this.throwIn = throwIn;
        }

        public void start() {
            executed = 0;
            world.event(label + " start");
            if ("start".equals(throwIn)) {
                throw new IllegalStateException(label + " threw in start");
            }
        }

        public void execute() {
            executed++;
            world.event(label + " execute " + executed);
            if ("execute".equals(throwIn) && executed == 2) {
                throw new IllegalStateException(label + " threw in execute");
            }
        }

        public boolean done() {
            return loops >= 0 && executed >= loops;
        }

        public void end(boolean interrupted) {
            world.event(label + (interrupted ? " interrupted" : " end"));
        }

        /** Ivy only: the command was set aside for a higher-priority one and may resume. */
        public void suspend() {
            world.event(label + " suspended");
        }
    }
}
