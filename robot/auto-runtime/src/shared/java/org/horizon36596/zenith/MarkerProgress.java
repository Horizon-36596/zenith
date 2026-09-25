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

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.DoubleSupplier;

/**
 * When each marker on a path is due, with no command library in it. Each runtime's {@code PathMarkers}
 * runner owns one and asks it, loop by loop, which marker command to start next; so the rule for where
 * a marker fires is written once, and a marker fires on the same loop whichever library runs it.
 *
 * <h2>How progress is measured, and why this way</h2>
 * Progress is <b>{@code follower.pathIndex()} plus {@code follower.curveCompletion()}, mapped onto the
 * file's arc length through {@link PedroPaths.Built#segmentLengthsIn}</b>. One Pedro path per file
 * segment means {@code pathIndex()} is the index of the file segment being driven (an
 * {@code AtomicPath} contributes exactly one {@code PathSegment}, verified in the pinned snapshot's
 * sources), and {@code curveCompletion()} is {@code 1 - remainingDistance / curve.length()}, which is
 * already an arc-length fraction of that segment rather than a raw Bezier parameter. So
 *
 * <pre>{@code distance = sum(lengths[0 .. index - 1]) + completion * lengths[index]}</pre>
 *
 * <p>is distance along the <i>planned path</i>, in the same inches the editor uses when it writes
 * {@code {"t": 0.6}}. That is the whole point: a marker placed six tenths of the way along a path in
 * the editor fires six tenths of the way along that path on the robot.
 *
 * <p>The alternative the spec allowed - accumulating {@code |delta pose|} from the follower's own pose
 * each loop - measures how far the <i>robot</i> travelled, which is a different number. It includes
 * cross-track wander, the correction that follows it, and any pushing about at the start of a leg, so
 * it always runs ahead of plan and fires markers late; it also cannot be reproduced by the planner from
 * the file alone, so the editor and the robot would quietly disagree. It is the right fallback only if
 * a future Pedro build stops reporting segment progress, and the mapping above is the reason this is
 * not that fallback.
 *
 * <p>Progress is held <b>monotone</b>: a follower that is briefly closer to an earlier part of the path
 * cannot un-fire a marker, and a marker fires exactly once.
 *
 * <p><b>The end of the path is a special case, and it has to be.</b> Pedro declares a path finished
 * while {@code curveCompletion()} is still a little short of 1, and the group ends the runner on the
 * same loop it notices, so a marker written {@code {"t": 1}} or {@code {"distanceFromEndIn": 0}} would
 * be passed over and never run. Once the follower has been seen driving this path, a follower that has
 * stopped following counts as the whole length travelled, which fires those markers on the last loop
 * the runner gets. The "has been seen" latch is what keeps that from firing every marker when the
 * runner starts, before the path has been handed over.
 *
 * @param <C> the command type of the library that runs the markers
 */
public final class MarkerProgress<C> {

    /** One marker: where it fires, and what it runs. */
    public static final class Entry<C> {
        /** Inches along the planned path from its start. */
        public final double distanceIn;
        /** What it runs. */
        public final C command;

        /**
         * @param distanceIn where the marker fires, inches along the planned path from its start
         * @param command    what it runs
         */
        public Entry(double distanceIn, C command) {
            this.distanceIn = distanceIn;
            this.command = command;
        }
    }

    /** A thousandth of a millionth of an inch, so a marker at exactly the reached distance is due. */
    private static final double TOLERANCE_IN = 1e-9;

    private final double[] segmentLengthsIn;
    private final List<Entry<C>> markers;
    private final boolean[] fired;

    /** Greatest distance reached so far, inches. Never decreases while the step runs. */
    private double furthestIn;

    /** True once the follower has been seen driving this path. See the class javadoc. */
    private boolean seenFollowing;

    /**
     * @param segmentLengthsIn each file segment's arc length, from {@link PedroPaths.Built}
     * @param markers          in any order; they are sorted by distance, stably
     */
    public MarkerProgress(double[] segmentLengthsIn, List<Entry<C>> markers) {
        this.segmentLengthsIn = segmentLengthsIn.clone();
        this.markers = Collections.unmodifiableList(sortedByDistance(markers));
        this.fired = new boolean[this.markers.size()];
    }

    /** @return the markers in the order they fire */
    public List<Entry<C>> markers() {
        return markers;
    }

    /** Forget all progress. Called when the runner starts. */
    public void reset() {
        furthestIn = 0;
        seenFollowing = false;
        for (int i = 0; i < fired.length; i++) {
            fired[i] = false;
        }
    }

    /**
     * Take one loop's reading of the follower. {@code stillFollowing} is read first and
     * {@code followerDistanceIn} only when it is needed, which is the order the follower was always
     * asked in.
     *
     * @param stillFollowing     true while Pedro is still driving this step's path
     * @param followerDistanceIn progress as the follower reports it, inches along the planned path
     */
    public void update(boolean stillFollowing, DoubleSupplier followerDistanceIn) {
        double reached;
        if (stillFollowing) {
            seenFollowing = true;
            reached = followerDistanceIn.getAsDouble();
        } else if (seenFollowing) {
            reached = totalIn();
        } else {
            reached = followerDistanceIn.getAsDouble();
        }
        furthestIn = Math.max(furthestIn, reached);
    }

    /**
     * The next marker the robot has passed and which has not fired yet, marked as fired; or
     * {@code null} when none is due. Call it until it returns {@code null}.
     *
     * @return the next due marker's command, or {@code null}
     */
    public C nextDue() {
        for (int i = 0; i < markers.size(); i++) {
            if (fired[i]) {
                continue;
            }
            if (furthestIn + TOLERANCE_IN < markers.get(i).distanceIn) {
                // Sorted, so nothing after this one is due either.
                return null;
            }
            fired[i] = true;
            return markers.get(i).command;
        }
        return null;
    }

    /** @return the whole path's arc length, inches */
    public double totalIn() {
        double sum = 0;
        for (double length : segmentLengthsIn) {
            sum += length;
        }
        return sum;
    }

    /**
     * Progress as the follower reports it, inches along the planned path.
     *
     * @param segmentLengthsIn each file segment's arc length
     * @param pathIndex        {@code follower.pathIndex()}
     * @param curveCompletion  {@code follower.curveCompletion()}, read only when the index is in range
     * @return inches along the planned path
     */
    public static double alongIn(double[] segmentLengthsIn, int pathIndex, DoubleSupplier curveCompletion) {
        if (pathIndex < 0) {
            return 0;
        }
        if (pathIndex >= segmentLengthsIn.length) {
            // The follower is past the last segment this step knows about. Nothing is left to fire
            // early, so report the end.
            double sum = 0;
            for (double length : segmentLengthsIn) {
                sum += length;
            }
            return sum;
        }
        double before = 0;
        for (int i = 0; i < pathIndex; i++) {
            before += segmentLengthsIn[i];
        }
        double completion = curveCompletion.getAsDouble();
        if (Double.isNaN(completion)) {
            completion = 0;
        }
        completion = Math.max(0, Math.min(1, completion));
        return before + completion * segmentLengthsIn[pathIndex];
    }

    private static <C> List<Entry<C>> sortedByDistance(List<Entry<C>> markers) {
        List<Entry<C>> sorted = new ArrayList<Entry<C>>(markers);
        // Insertion sort: a handful of markers, and it is stable, so two markers at the same
        // distance fire in the order the file lists them.
        for (int i = 1; i < sorted.size(); i++) {
            Entry<C> moving = sorted.get(i);
            int j = i - 1;
            while (j >= 0 && sorted.get(j).distanceIn > moving.distanceIn) {
                sorted.set(j + 1, sorted.get(j));
                j--;
            }
            sorted.set(j + 1, moving);
        }
        return sorted;
    }
}
