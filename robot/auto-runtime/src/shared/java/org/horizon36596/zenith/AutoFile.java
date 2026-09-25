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

import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * One {@code *.auto.json} file, parsed and resolved, ready for a runtime's {@code AutoBuilder} to turn
 * into commands. It names no command library: the SolversLib runtime
 * ({@code org.horizon36596.zenith.solverslib}) reads it through {@code AutoSpec}, which hands the same model out with SolversLib poses, and the Ivy runtime
 * ({@code org.horizon36596.zenith.ivy}) reads it directly. Poses are Pedro Pathing's {@link Pose},
 * which both runtimes already depend on. Parsing happens once at OpMode init, so a bad file fails on
 * the tile rather than at the whistle.
 *
 * <h2>What "resolved" means</h2>
 * <ul>
 *   <li><b>Waypoints.</b> A pose written {@code {"ref": "scoreSpot"}} is looked up in
 *       {@code waypoints.json} and replaced with its numbers here, so nothing downstream has to know
 *       waypoints exist. An unknown name is an error naming every known one.</li>
 *   <li><b>Poses are in the alliance frame the file was written in.</b> {@link #alliance} says which
 *       one that is. A file written by hand usually says the season's canonical alliance; zenith can
 *       also mirror a whole routine and save the result for the other one. Mirroring happens in one
 *       place only, the running auto's {@code alliance(pose)}. See <b>Alliance</b> below.</li>
 *   <li><b>Every step has an id.</b> {@code id} is optional in the file; a step without one is named by
 *       its position ({@link #effectiveId}), by the same rule as {@code effectiveId} in
 *       {@code packages/core/src/edit/ids.ts}. So the string a runtime logs as {@code Auto/step} is
 *       the string the editor shows and the planner keys its findings on.</li>
 *   <li><b>{@code "current"} stays unresolved.</b> A segment whose {@code from} is the string
 *       {@code "current"} keeps a {@code null} start pose, because the answer is the follower's live
 *       pose and is not known until the step runs. Both runtimes defer building such a path until the
 *       step starts.</li>
 * </ul>
 *
 * <h2>Versioning</h2>
 * {@link #FORMAT_VERSION} is the newest {@code formatVersion} this runtime understands;
 * {@link #MIN_FORMAT_VERSION} is the oldest. 1, 2 and 3 are read today: each older number is the identity
 * migration in memory (the content means the same thing at every number, per
 * {@code packages/schema/src/migrate.ts}; v3 only added the {@code piecewise} heading mode, which an
 * older file cannot contain), so nothing here branches on which of them a file says. A file at another version is refused at init
 * with both numbers in the message, per site/docs/file-format.md, and the message says which
 * way the gap has to be closed. A file newer than the runtime needs a newer runtime: raise the
 * {@code zenith-runtime} version in the robot project's Gradle dependencies. A file older than the runtime
 * needs migrating with zenith, which rewrites a file it loads at the current version - the runtime
 * cannot migrate anything itself, and telling a human at a competition to update the runtime when the
 * file is the old half is how twenty minutes go on the wrong thing. Bumping either constant is a
 * deliberate act that comes with a migration, not a way to make a red test go green.
 *
 * <h2>Alliance</h2>
 * A file declares the alliance its poses are written for, and the runtime <b>mirrors if and only if</b>
 * the alliance the Driver Station selected is not that one ({@link #mirrorsInto}). Each runtime's
 * {@code AutoFromFile} applies it in its {@code alliance(pose)}, so every pose in the file-driven stack
 * goes through the one mirror call and no pose goes through it twice. A path's headings follow the same
 * call ({@link AllianceFrame}): a {@code constant} heading, both ends of a {@code linear} sweep, a
 * {@code facePoint} point and every {@code piecewise} range are mirrored exactly when the poses are.
 * For a routine zenith mirrored and saved for the other alliance, that is the difference between
 * driving the routine and driving it on the wrong side of the field.
 *
 * <h2>Determinism</h2>
 * No clock, no randomness, no reflection, no map iteration whose order is not the file's. Two loads of
 * the same bytes produce the same object graph in the same order, which is what a headless test that
 * "runs twice and decodes identically" rests on.
 */
public final class AutoFile {

    /** The newest {@code formatVersion} this runtime understands. See the class javadoc before changing it. */
    public static final int FORMAT_VERSION = 3;

    /** The oldest {@code formatVersion} this runtime understands. See the class javadoc before changing it. */
    public static final int MIN_FORMAT_VERSION = 1;

    /** The alliance a file is taken to be written for when it does not say. */
    public static final String CANONICAL_ALLIANCE = "RED";

    /** What a top-level step with no {@code id} is named from: {@code step1}, {@code step2}, and on. */
    private static final String ROOT_ID_PREFIX = "step";

    /** The waypoint file every auto shares, read from the same folder as the auto. */
    public static final String WAYPOINTS_FILE = "waypoints.json";

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

    /** Where the robot is placed before start, in the file's alliance frame. {@code AutoFromFile} mirrors it. */
    public final Pose startPose;

    /** The routine, in order. */
    public final List<Step> steps;

    /**
     * What the file says that this runtime read past, one message each, naming the step and where in
     * the file it is. Nothing here stops the auto; each runtime's {@code AutoFromFile} shows them on the
     * Driver Station during init. Empty for a file the editor saved.
     *
     * <p>Today the one case is a {@code timeoutS} on a {@code sequence}, {@code parallel} or
     * {@code branch}. The file format gives a timeout to {@code path}, {@code command} and {@code wait}
     * steps only, and the editor's schema drops it anywhere else, so honouring it here would run a
     * hand-written file differently from the way the editor plans and simulates it.
     */
    public final List<String> warnings;

    private AutoFile(String name, String title, String description, String alliance,
            Pose startPose, List<Step> steps, List<String> warnings) {
        this.name = name;
        this.title = title;
        this.description = description;
        this.alliance = alliance;
        this.startPose = startPose;
        this.steps = Collections.unmodifiableList(steps);
        this.warnings = Collections.unmodifiableList(warnings);
    }

    /**
     * Whether this file's poses have to be mirrored to be driven as {@code runningAlliance}.
     *
     * <p>The season's mirror is its own inverse (a point symmetry or a reflection), so "the two
     * alliances differ" is the whole test, and applying it twice puts the routine back on the side of the
     * field it came from. That is not a theoretical worry: before this method existed the runtime
     * mirrored on the selected alliance alone, so a BLUE file run as BLUE - which is what a routine
     * mirrored in the app and saved is - got mirrored a second time and the whole auto ran on RED's half.
     *
     * <p>This is the only place the question is asked. Each runtime's {@code alliance(pose)} reads it,
     * and a path's headings are mirrored through {@link AllianceFrame}, which is built from that same
     * {@code alliance(pose)}, so poses and headings are mirrored together or not at all.
     *
     * @param runningAlliance the alliance the OpMode is running as, {@code "RED"} or {@code "BLUE"}
     * @return true when the file's poses must be mirrored to be driven as {@code runningAlliance}
     */
    public boolean mirrorsInto(String runningAlliance) {
        return !alliance.equals(runningAlliance);
    }

    // ---------------------------------------------------------------------------------------------
    // Loading
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
    public static AutoFile load(AutoSource source, String autoName) throws IOException {
        String fileName = autoName + ".auto.json";
        Map<String, Pose> waypoints = loadWaypoints(source);

        Json root;
        InputStream stream = source.open(fileName);
        try {
            root = Json.parse(stream, fileName);
        } finally {
            stream.close();
        }
        return parse(root, autoName, waypoints);
    }

    /**
     * {@link #load}, with a read failure turned into an {@link IllegalStateException} that names the file
     * and where it was looked for. What each runtime's {@code AutoFromFile} calls at init, where a checked exception has
     * nowhere useful to go.
     *
     * @param source   where to read from
     * @param autoName the file stem
     * @return the parsed, resolved file
     */
    public static AutoFile loadForInit(AutoSource source, String autoName) {
        try {
            return load(source, autoName);
        } catch (IOException problem) {
            throw new IllegalStateException("could not read the auto \"" + autoName + "\" from "
                    + source.describe() + ": " + problem.getMessage(), problem);
        }
    }

    /**
     * The waypoints in {@code source}, or an empty map when the file is absent. Absent is legal: an auto
     * whose poses are all written out needs no waypoint file, and saying so here keeps the "missing
     * waypoint name" error in one place.
     *
     * @param source where to read {@code waypoints.json} from
     * @return the waypoints by name, in file order
     * @throws IOException when the file exists and cannot be read
     */
    public static Map<String, Pose> loadWaypoints(AutoSource source) throws IOException {
        InputStream stream;
        try {
            stream = source.open(WAYPOINTS_FILE);
        } catch (FileNotFoundException absent) {
            return Collections.emptyMap();
        }
        Json root;
        try {
            root = Json.parse(stream, WAYPOINTS_FILE);
        } finally {
            stream.close();
        }
        requireVersion(root, WAYPOINTS_FILE);

        Map<String, Pose> out = new LinkedHashMap<String, Pose>();
        Json table = root.get("waypoints");
        for (String key : table.keys()) {
            Json pose = table.get(key);
            out.put(key, new FilePose(pose.num("xIn"), pose.num("yIn"), pose.num("headingRad")));
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
    public static AutoFile parse(Json root, String autoName, Map<String, Pose> waypoints) {
        requireVersion(root, autoName + ".auto.json");

        String name = root.optText("name", autoName);
        String title = root.optText("title", name);
        String description = root.optText("description", "");
        String alliance = root.optText("alliance", CANONICAL_ALLIANCE);
        if (!"RED".equals(alliance) && !"BLUE".equals(alliance)) {
            throw new IllegalArgumentException(root.get("alliance").path()
                    + ": an alliance is \"RED\" or \"BLUE\", found \"" + alliance + "\"");
        }

        Json start = root.get("start");
        Pose startPose = pose(start.get("pose"), waypoints, false);

        List<String> warnings = new ArrayList<String>();
        List<Step> steps = steps(root.get("steps"), waypoints, ROOT_ID_PREFIX, warnings);
        if (steps.isEmpty()) {
            throw new IllegalArgumentException(root.get("steps").path() + ": an auto needs at least one step");
        }
        requireUniqueIds(steps, new LinkedHashSet<String>(), root.get("steps").path());
        return new AutoFile(name, title, description, alliance, startPose, steps, warnings);
    }

    private static void requireVersion(Json root, String fileName) {
        int version = root.integer("formatVersion");
        if (version > FORMAT_VERSION) {
            throw new IllegalStateException(fileName + " is formatVersion " + version
                    + "; this robot runtime understands formatVersion " + FORMAT_VERSION
                    + ". The file is the newer half: raise the zenith-runtime version in the robot"
                    + " project's Gradle dependencies to one that reads formatVersion " + version + ".");
        }
        if (version < MIN_FORMAT_VERSION) {
            throw new IllegalStateException(fileName + " is formatVersion " + version
                    + "; this robot runtime understands formatVersion " + FORMAT_VERSION
                    + ". The file is the older half: migrate it with zenith, which rewrites a file it"
                    + " loads at formatVersion " + FORMAT_VERSION + " when it saves it. This runtime"
                    + " cannot migrate anything itself.");
        }
    }

    /**
     * Refuse two steps that answer to the same id, anywhere in the routine.
     *
     * <p>One flat namespace, children included, the same as {@code collectIds} in
     * {@code packages/core/src/edit/ids.ts}. Every step is addressed by its id - {@code Auto/step} in the
     * log, a finding in the planner, a {@code deadline} reference here - so an id that names two steps
     * makes all three ambiguous, and the one that bites on the field is a {@code deadline} that ends the
     * wrong member.
     */
    private static void requireUniqueIds(List<Step> steps, Set<String> seen, String where) {
        for (Step step : steps) {
            if (!seen.add(step.id)) {
                throw new IllegalArgumentException(where + ": two steps have the id \"" + step.id
                        + "\"; every step is addressed by its id, so it has to name one step");
            }
            if (step instanceof ParallelStep) {
                requireUniqueIds(((ParallelStep) step).steps, seen, where);
            } else if (step instanceof BranchStep) {
                requireUniqueIds(((BranchStep) step).then, seen, where);
                requireUniqueIds(((BranchStep) step).otherwise, seen, where);
            } else if (step instanceof SequenceStep) {
                requireUniqueIds(((SequenceStep) step).steps, seen, where);
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Steps
    // ---------------------------------------------------------------------------------------------

    private static List<Step> steps(Json array, Map<String, Pose> waypoints, String idPrefix,
            List<String> warnings) {
        List<Json> nodes = array.items();
        List<Step> out = new ArrayList<Step>(nodes.size());
        for (int index = 0; index < nodes.size(); index++) {
            out.add(step(nodes.get(index), waypoints, idPrefix, index, warnings));
        }
        return out;
    }

    /**
     * The id a step is addressed by, whether or not it carries an explicit {@code id}.
     *
     * <p>This is {@code effectiveId} from {@code packages/core/src/edit/ids.ts}, implemented to the same
     * rule on purpose: {@code id} is optional in the schema, and the name the planner puts on a finding,
     * the name the editor's step list shows and the name this runtime logs as {@code Auto/step} have to
     * be one string or a human cannot carry a message from one to the other. A step with no {@code id}
     * is positional, so inserting a sibling in front of it renames it - which is why zenith gives every
     * step it creates an explicit id rather than leaving it to this.
     *
     * @param index  the step's position in its own list, from zero
     * @param prefix {@code "step"} at the top level, {@link #childPrefix} inside a group
     */
    static String effectiveId(Json node, int index, String prefix) {
        Json id = node.opt("id");
        return id == null ? prefix + (index + 1) : id.text();
    }

    /**
     * The prefix the children of a {@code parallel} or a {@code branch} are named from, matching
     * {@code childPrefix} in {@code packages/core/src/edit/ids.ts}. A parallel's children, and the arm
     * of a branch that has no {@code else}, are {@code parent.1}, {@code parent.2} and on; a branch with
     * both arms numbers the arms first, so its {@code else} steps are {@code parent.2.1} and on.
     *
     * @param branchCount how many arms are being named: one for a parallel, two for a branch with an
     *                    {@code else}
     */
    static String childPrefix(String parentId, int branchCount, int branchIndex) {
        return parentId + "." + (branchCount > 1 ? (branchIndex + 1) + "." : "");
    }

    /**
     * One step, with its effective id carried into anything it throws.
     *
     * <p>Spec {@code 03} section 4 keys every finding on a step id and the planner's messages do; a
     * runtime message that says {@code steps[3]} instead is something a human has to count brackets to
     * use, and in a file with two steps that look alike there is nothing to grep for. So a failure from
     * inside one step comes out as a {@link StepFailure} naming it, and a failure from inside a nested
     * step keeps the innermost name rather than collecting one per level on the way out.
     */
    private static Step step(Json node, Map<String, Pose> waypoints, String idPrefix, int index,
            List<String> warnings) {
        String id = effectiveId(node, index, idPrefix);
        try {
            return stepBody(node, id, waypoints, warnings);
        } catch (StepFailure named) {
            throw named;
        } catch (RuntimeException problem) {
            throw StepFailure.at(node, id, problem);
        }
    }

    /** One step, once its id is known. Everything it throws is named by the caller above. */
    private static Step stepBody(Json node, String id, Map<String, Pose> waypoints, List<String> warnings) {
        String kind = node.str("kind");
        // Read for path, command and wait, the kinds the file format gives a timeout. A group's is not
        // read at all, so whatever it holds cannot fail the load; warnIfTimed reports it instead.
        boolean group = "parallel".equals(kind) || "branch".equals(kind) || "sequence".equals(kind);
        Double timeoutS = group || node.opt("timeoutS") == null ? null : Double.valueOf(node.num("timeoutS"));

        if ("path".equals(kind)) {
            List<Segment> segments = new ArrayList<Segment>();
            for (Json seg : node.get("segments").items()) {
                segments.add(segment(seg, waypoints));
            }
            if (segments.isEmpty()) {
                throw new IllegalArgumentException(node.path() + ": a path step needs at least one segment");
            }
            Heading heading = heading(node.get("heading"));
            // Absent stays absent: the robot's own default (the context's defaultSpeedFraction) applies at
            // build time, so the parser needs to know nothing about any robot.
            Double speed = node.opt("speedFraction") == null
                    ? null : Double.valueOf(node.num("speedFraction"));
            List<Marker> markers = new ArrayList<Marker>();
            if (node.opt("markers") != null) {
                for (Json marker : node.get("markers").items()) {
                    markers.add(marker(marker));
                }
            }
            String endCondition = null;
            if (node.opt("endCondition") != null) {
                endCondition = node.get("endCondition").str("condition");
            }
            return new PathStep(id, timeoutS, segments, heading, speed, markers, endCondition);
        }

        if ("command".equals(kind)) {
            Map<String, Object> args = node.opt("args") == null
                    ? Collections.<String, Object>emptyMap()
                    : node.get("args").rawMap();
            return new CommandStep(id, timeoutS, node.str("name"), args);
        }

        if ("wait".equals(kind)) {
            Json until = node.opt("until");
            Json seconds = node.opt("seconds");
            if (until != null && seconds != null) {
                // Both readings are defensible and they disagree by the whole of "seconds", so the file
                // is refused rather than one of them being picked here. waitStepSchema
                // (packages/schema/src/auto.ts) refuses it too.
                throw new IllegalArgumentException(node.path()
                        + ": this wait has both seconds and until; a wait ends either after a time or on"
                        + " a condition, not both");
            }
            if (until != null) {
                return new WaitStep(id, timeoutS, null, until.text());
            }
            return new WaitStep(id, timeoutS, Double.valueOf(node.num("seconds")), null);
        }

        if ("parallel".equals(kind)) {
            String mode = node.str("mode");
            if (!"all".equals(mode) && !"race".equals(mode) && !"deadline".equals(mode)) {
                throw new IllegalArgumentException(node.path()
                        + ".mode: expected all, race or deadline, found \"" + mode + "\"");
            }
            warnIfTimed(node, id, kind, warnings);
            List<Step> members = steps(node.get("steps"), waypoints, childPrefix(id, 1, 0), warnings);
            if (members.isEmpty()) {
                throw new IllegalArgumentException(node.get("steps").path()
                        + ": a parallel needs at least one step");
            }
            String deadline = node.optText("deadline", null);
            if ("deadline".equals(mode) && !names(members, deadline)) {
                // The same rule checkGroups enforces in packages/core/src/check.ts: naming nothing,
                // naming a grandchild and naming a step outside the group are one mistake. Caught here
                // so it is caught at parse, with the members to choose from in the message.
                throw new IllegalArgumentException(node.path()
                        + ": this group runs until its deadline step finishes, and its deadline "
                        + (deadline == null ? "names no step" : "is \"" + deadline + "\", which is not"
                                + " one of its own steps") + "; name one of " + ids(members));
            }
            return new ParallelStep(id, mode, deadline, members);
        }

        if ("branch".equals(kind)) {
            Json elseArm = node.opt("else");
            int arms = elseArm == null ? 1 : 2;
            warnIfTimed(node, id, kind, warnings);
            List<Step> then = steps(node.get("then"), waypoints, childPrefix(id, arms, 0), warnings);
            List<Step> otherwise = elseArm == null
                    ? Collections.<Step>emptyList()
                    : steps(elseArm, waypoints, childPrefix(id, arms, 1), warnings);
            return new BranchStep(id, node.str("condition"), then, otherwise);
        }

        if ("sequence".equals(kind)) {
            // formatVersion 2: a group of steps addressed as one step, so it
            // can be a parallel's timed deadline member or sit anywhere else a single step can. Its
            // children are numbered the same way a parallel's are - one list, so childPrefix's
            // branchCount is 1 - which is what packages/core/src/edit/ids.ts calls effectiveId/childPrefix
            // for a sequence too.
            warnIfTimed(node, id, kind, warnings);
            List<Step> members = steps(node.get("steps"), waypoints, childPrefix(id, 1, 0), warnings);
            if (members.isEmpty()) {
                throw new IllegalArgumentException(node.get("steps").path()
                        + ": a sequence needs at least one step");
            }
            return new SequenceStep(id, members);
        }

        throw new IllegalArgumentException(node.path() + ".kind: unknown step kind \"" + kind
                + "\"; this runtime knows path, command, wait, parallel, branch and sequence");
    }

    /**
     * Report a {@code timeoutS} on a group step, which the file format does not give one, and ignore it.
     *
     * <p>A warning rather than a refusal: the editor loads the same file without complaint, having
     * dropped the key, so refusing it here would stop at the tile an auto the editor shows as fine.
     * What the robot runs is then what the editor planned. It is reported before the group's members
     * are read, so the messages come out in file order.
     */
    private static void warnIfTimed(Json node, String id, String kind, List<String> warnings) {
        if (node.opt("timeoutS") == null) {
            return;
        }
        warnings.add(node.path() + " (step \"" + id + "\"): timeoutS is ignored on a " + kind
                + " step; only path, command and wait steps take a timeout. Put timeoutS on a step"
                + " inside the group, or bound the group with a parallel deadline whose deadline is a wait.");
    }

    /** Whether {@code deadline} is the effective id of one of {@code members}. */
    private static boolean names(List<Step> members, String deadline) {
        if (deadline == null) {
            return false;
        }
        for (Step member : members) {
            if (deadline.equals(member.id)) {
                return true;
            }
        }
        return false;
    }

    /** The members' ids, quoted and comma separated, for a message that has to offer a choice. */
    private static String ids(List<Step> members) {
        StringBuilder out = new StringBuilder();
        for (Step member : members) {
            if (out.length() > 0) {
                out.append(", ");
            }
            out.append('"').append(member.id).append('"');
        }
        return out.toString();
    }

    private static Segment segment(Json node, Map<String, Pose> waypoints) {
        String kind = node.str("kind");
        Pose from = pose(node.get("from"), waypoints, true);
        Pose to = pose(node.get("to"), waypoints, false);
        List<Pose> control = new ArrayList<Pose>();
        if ("bezier".equals(kind)) {
            Json points = node.get("control");
            for (Json point : points.items()) {
                control.add(pose(point, waypoints, false));
            }
            if (control.isEmpty()) {
                // Pedro's BezierCurve(List) throws "Too few control points" under three, and a bezier
                // with none is a line anyway.
                throw new IllegalArgumentException(node.path()
                        + ".control: a bezier needs at least one control point; use kind \"line\" for none");
            }
        } else if (!"line".equals(kind)) {
            throw new IllegalArgumentException(node.path() + ".kind: unknown segment kind \"" + kind
                    + "\"; this runtime knows line and bezier");
        }
        return new Segment(kind, from, control, to);
    }

    /** How close two range ends must be to count as the same t; the same figure as {@code RANGE_T_TOLERANCE} in core. */
    static final double RANGE_T_TOLERANCE = 1e-6;

    private static Heading heading(Json node) {
        String mode = node.str("mode");
        if ("piecewise".equals(mode)) {
            return piecewise(node);
        }
        return rangeHeading(node);
    }

    /**
     * A {@code piecewise} heading: its ranges, checked the way Pedro's {@code PiecewiseInterpolator}
     * will check them on the robot ({@code until} refuses a t that does not increase or passes 1, and
     * {@code interpolate} refuses to run before the ranges reach 1), so the file fails at init with the
     * range named rather than in the middle of the path.
     */
    private static Heading piecewise(Json node) {
        Json rangesNode = node.get("ranges");
        List<Json> items = rangesNode.items();
        if (items.isEmpty()) {
            throw new IllegalArgumentException(rangesNode.path() + ": a piecewise heading needs at least one range");
        }
        List<HeadingRange> ranges = new ArrayList<HeadingRange>(items.size());
        double previousEnd = 0;
        for (int i = 0; i < items.size(); i++) {
            Json item = items.get(i);
            double startT = item.num("startT");
            double endT = item.num("endT");
            if (Math.abs(startT - previousEnd) > RANGE_T_TOLERANCE) {
                throw new IllegalArgumentException(item.path() + ".startT: range " + (i + 1) + " starts at "
                        + startT + " but must start where the one before it ends, at " + previousEnd
                        + "; the ranges must cover 0 to 1 with no gap and no overlap");
            }
            if (endT <= startT + RANGE_T_TOLERANCE || endT > 1 + RANGE_T_TOLERANCE) {
                throw new IllegalArgumentException(item.path() + ".endT: range " + (i + 1) + " ends at " + endT
                        + ", which must be after its start at " + startT + " and no later than 1");
            }
            Heading inner = rangeHeading(item.get("heading"));
            ranges.add(new HeadingRange(startT, endT, inner));
            previousEnd = endT;
        }
        if (Math.abs(previousEnd - 1) > RANGE_T_TOLERANCE) {
            throw new IllegalArgumentException(rangesNode.path() + ": the last range ends at " + previousEnd
                    + "; it must end at 1, or Pedro has no heading for the rest of the path");
        }
        return new Heading("piecewise", 0, 0, 0, 0, 0, ranges);
    }

    /** Every mode but {@code piecewise}, which is also what a piecewise range may hold. */
    private static Heading rangeHeading(Json node) {
        String mode = node.str("mode");
        if ("tangent".equals(mode) || "tangentReversed".equals(mode)) {
            return new Heading(mode, 0, 0, 0, 0, 0);
        }
        if ("constant".equals(mode)) {
            return new Heading(mode, node.num("headingRad"), 0, 0, 0, 0);
        }
        if ("linear".equals(mode)) {
            return new Heading(mode, 0, node.num("fromRad"), node.num("toRad"), 0, 0);
        }
        if ("facePoint".equals(mode)) {
            double offset = node.optNum("offsetRad", 0.0);
            if (offset != 0.0) {
                // Pedro's facingPoint interpolator has no offset.
                // Faking one would mean sampling the curve into a piecewise interpolator, which is a
                // different behaviour wearing the same name, so say so instead.
                throw new IllegalArgumentException(node.path()
                        + ".offsetRad: Pedro's facingPoint interpolator has no heading offset; only 0 is"
                        + " supported. Use linear, or aim with a mechanism.");
            }
            return new Heading(mode, 0, 0, 0, node.num("xIn"), node.num("yIn"));
        }
        throw new IllegalArgumentException(node.path() + ".mode: unknown heading mode \"" + mode
                + "\"; this runtime knows tangent, tangentReversed, constant, linear, facePoint and"
                + " piecewise (whose ranges hold any of the others)");
    }

    private static Marker marker(Json node) {
        Json at = node.get("at");
        Double t = at.opt("t") == null ? null : Double.valueOf(at.num("t"));
        Double distanceIn = at.opt("distanceIn") == null ? null : Double.valueOf(at.num("distanceIn"));
        Double fromEndIn = at.opt("distanceFromEndIn") == null
                ? null : Double.valueOf(at.num("distanceFromEndIn"));
        int given = (t == null ? 0 : 1) + (distanceIn == null ? 0 : 1) + (fromEndIn == null ? 0 : 1);
        if (given != 1) {
            throw new IllegalArgumentException(at.path()
                    + ": a marker fires at exactly one of t, distanceIn or distanceFromEndIn");
        }
        if (t != null && (t.doubleValue() < 0.0 || t.doubleValue() > 1.0)) {
            throw new IllegalArgumentException(at.path() + ".t: must be between 0 and 1, found " + t);
        }
        Json command = node.get("command");
        Map<String, Object> args = command.opt("args") == null
                ? Collections.<String, Object>emptyMap()
                : command.get("args").rawMap();
        return new Marker(t, distanceIn, fromEndIn, command.str("name"), args);
    }

    /**
     * A pose literal, a {@code {"ref": name}} waypoint, or the string {@code "current"}.
     *
     * @param allowCurrent whether {@code "current"} is legal here
     * @return the pose, or {@code null} for {@code "current"}
     */
    private static Pose pose(Json node, Map<String, Pose> waypoints, boolean allowCurrent) {
        if (node.isString()) {
            String literal = node.text();
            if ("current".equals(literal)) {
                if (!allowCurrent) {
                    throw new IllegalArgumentException(node.path()
                            + ": \"current\" is only allowed as a segment's \"from\"");
                }
                return null;
            }
            throw new IllegalArgumentException(node.path()
                    + ": the only string a pose may be is \"current\", found \"" + literal + "\"");
        }
        if (node.has("ref")) {
            String ref = node.str("ref");
            Pose found = waypoints.get(ref);
            if (found == null) {
                throw new IllegalArgumentException(node.path() + ": no waypoint named \"" + ref
                        + "\" in " + WAYPOINTS_FILE + "; it has " + waypoints.keySet());
            }
            return found;
        }
        // headingRad is optional here (poseSchema, packages/schema/src/common.ts): a Bezier control
        // point has no heading at all, and on a segment's own poses the step's heading mode supplies
        // one. Absent means zero, which is what packages/core/src/resolve.ts reads it as, and on a path
        // pose it is never read at all - Paths.line and Paths.curve take the x and y.
        return new FilePose(node.num("xIn"), node.num("yIn"), node.optNum("headingRad", 0.0));
    }

    // ---------------------------------------------------------------------------------------------
    // The step model
    // ---------------------------------------------------------------------------------------------

    /** One step of a routine. {@code id} is what the running auto's {@code step(id, command)} is called with. */
    public abstract static class Step {
        /**
         * The step's effective id ({@link AutoFile#effectiveId}): the file's {@code id} when it has one,
         * its position when it does not. Never null, which is what lets a builder compare it
         * against a parallel's {@code deadline} without a null check on every member.
         */
        public final String id;
        /**
         * Seconds this step is allowed, or {@code null}. Enforced by each runtime's {@code RobotTimeout}.
         * Always {@code null} on a group step: the file format gives a timeout to path, command and wait
         * steps only, and a group's is reported in {@link AutoFile#warnings} instead.
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
         * the running auto's {@code defaultSpeedFraction()} applies.
         */
        public final Double speedFraction;
        public final List<Marker> markers;
        /** A condition name that cuts the path short, or {@code null}. */
        public final String endCondition;

        PathStep(String id, Double timeoutS, List<Segment> segments, Heading heading,
                Double speedFraction, List<Marker> markers, String endCondition) {
            super(id, timeoutS);
            this.segments = Collections.unmodifiableList(segments);
            this.heading = heading;
            this.speedFraction = speedFraction;
            this.markers = Collections.unmodifiableList(markers);
            this.endCondition = endCondition;
        }

        /** @return true when this path starts from the live pose and so cannot be built until it runs */
        public boolean startsFromCurrentPose() {
            return segments.get(0).from == null;
        }
    }

    /** Run a named command from the runtime's {@code NamedCommands}. */
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
     * A group of steps in order, addressed as one step (formatVersion 2). Each runtime builds it as one
     * sequential group, so it can be a {@code parallel}'s {@code deadline} member,
     * an arm of a {@code branch}, or sit next to any other step - nesting does not change how a member
     * step builds, so a {@code path} step inside a sequence whose {@code from} is {@code "current"}
     * defers exactly as it would at the top level.
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
        public final Pose from;
        /** Bezier control points, empty for a line. */
        public final List<Pose> control;
        public final Pose to;

        Segment(String kind, Pose from, List<Pose> control, Pose to) {
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

        public Heading(String mode, double headingRad, double fromRad, double toRad,
                double pointXIn, double pointYIn) {
            this(mode, headingRad, fromRad, toRad, pointXIn, pointYIn, Collections.<HeadingRange>emptyList());
        }

        public Heading(String mode, double headingRad, double fromRad, double toRad,
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

        public HeadingRange(double startT, double endT, Heading heading) {
            this.startT = startT;
            this.endT = endT;
            this.heading = heading;
        }
    }

    /**
     * A parse or build failure that already names the step it happened in.
     *
     * <p>The identity lives in the exception type rather than in the text so that a nested step is not
     * prefixed once per level on its way out, and so that a builder can name the step for a
     * failure that only shows up when the routine is built - an unregistered command name, a condition
     * nobody registered - without the parser and the builder having to agree on a string format.
     *
     * <p>Public because the two runtimes' builders live in two packages and both name steps this way.
     */
    public static final class StepFailure extends IllegalArgumentException {

        private static final long serialVersionUID = 1L;

        private StepFailure(String message, Throwable cause) {
            super(message, cause);
        }

        /**
         * The same failure with {@code (step "id")} written in after the path it happened at, so the
         * message still says where in the file it is and now also says which step that is.
         */
        static StepFailure at(Json node, String id, RuntimeException cause) {
            String path = node.path();
            String here = path + " (step \"" + id + "\")";
            String message = messageOf(cause);
            return new StepFailure(message.startsWith(path)
                    ? here + message.substring(path.length())
                    : here + ": " + message, cause);
        }

        /** The same failure, for a step being built rather than parsed, where there is no file path. */
        static StepFailure of(String id, RuntimeException cause) {
            return new StepFailure("step \"" + id + "\": " + messageOf(cause), cause);
        }

        /**
         * A build failure with the step it happened in named, unless it already names one. A nested
         * step names itself first and keeps that name: the innermost step is the one a human has to go
         * and look at.
         *
         * @param stepId  the step being built
         * @param problem what went wrong
         * @return {@code problem} itself when it already names a step, otherwise a failure naming this one
         */
        public static RuntimeException inStep(String stepId, RuntimeException problem) {
            return problem instanceof StepFailure ? problem : of(stepId, problem);
        }

        private static String messageOf(RuntimeException cause) {
            return cause.getMessage() == null ? cause.toString() : cause.getMessage();
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

        Marker(Double t, Double distanceIn, Double distanceFromEndIn, String commandName,
                Map<String, Object> args) {
            this.t = t;
            this.distanceIn = distanceIn;
            this.distanceFromEndIn = distanceFromEndIn;
            this.commandName = commandName;
            this.args = args;
        }

        /**
         * Where this marker fires, in inches from the start of the step.
         *
         * @param totalLengthIn the step's whole arc length, from {@link PedroPaths.Built#totalLengthIn}
         * @return inches from the start of the step
         */
        public double distanceAlongIn(double totalLengthIn) {
            if (t != null) {
                return t.doubleValue() * totalLengthIn;
            }
            if (distanceIn != null) {
                return distanceIn.doubleValue();
            }
            return totalLengthIn - distanceFromEndIn.doubleValue();
        }
    }
}
