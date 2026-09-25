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

import com.pedropathing.ivy.Command;
import com.pedropathing.ivy.behaviors.EndCondition;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Runs commands side by side: all of them, a race, or a deadline. The Ivy runtime's own replacement for
 * Ivy's {@code Groups.parallel}, {@code Groups.race} and {@code Groups.deadline}, with exactly the
 * behaviour of the SolversLib runtime's {@code org.horizon36596.zenith.solverslib.Parallel}.
 *
 * <p><b>Why not Ivy's groups.</b>
 * <ul>
 *   <li>All three keep their members in a {@code HashMap} keyed on identity hash codes, so the order
 *       members start and run within one loop changes from run to run, and so does which members of a
 *       race execute on the loop it is won.</li>
 *   <li>{@code deadline} ends its other members twice: once when the deadline finishes and again when
 *       the group itself is ended.</li>
 *   <li>Every Ivy group asks a member {@code done()} before calling its {@code execute()}, where the
 *       scheduler and SolversLib ask after. A member that finishes because of its own {@code execute()}
 *       would end a loop later than on the SolversLib runtime.</li>
 * </ul>
 *
 * <p><b>What this group guarantees instead.</b>
 * <ul>
 *   <li>Every member's {@code end} is called exactly once per run of the group:
 *       {@link EndCondition#NATURALLY} on the loop the member reports itself done, or
 *       {@link EndCondition#INTERRUPTED} when the group ends while the member is still running.</li>
 *   <li>Members start, execute and end in the order they were given, which for a file-driven auto is the
 *       order the file lists them. A {@link #deadline deadline} group puts its deadline first.</li>
 *   <li>Each loop a running member executes and is then asked {@code done()}, including the loop a race
 *       is won or a deadline arrives on, and the group reports done at the end of that loop.</li>
 *   <li>{@link EndCondition#SUSPENDED} is passed on to the members still running, and they keep their
 *       place, so the group carries on where it stopped when Ivy resumes it.</li>
 *   <li>Its requirements are the union of its members', and its priority the highest of theirs, which
 *       is Ivy's own rule for groups. Two members that share a requirement are refused here, when the
 *       routine is built, with the SolversLib runtime's message.</li>
 * </ul>
 */
public final class Parallel extends BaseCommand {

    private enum Mode { ALL, RACE, DEADLINE }

    private final Mode mode;
    private final List<Command> members;
    private final boolean[] running;
    private boolean anyFinished;
    private boolean deadlineFinished;

    private Parallel(Mode mode, List<Command> members) {
        this.mode = mode;
        int highest = Integer.MIN_VALUE;
        for (int i = 0; i < members.size(); i++) {
            for (int j = 0; j < i; j++) {
                if (members.get(i) == members.get(j)) {
                    throw new IllegalArgumentException("A command cannot be in a parallel group twice");
                }
            }
            Command member = members.get(i);
            if (!Collections.disjoint(member.requirements(), requirements())) {
                throw new IllegalArgumentException("Multiple commands in a parallel group cannot"
                        + " require the same subsystems");
            }
            addRequirements(member.requirements());
            highest = Math.max(highest, member.priority());
        }
        setPriority(members.isEmpty() ? 0 : highest);
        this.members = Collections.unmodifiableList(new ArrayList<Command>(members));
        this.running = new boolean[members.size()];
    }

    /**
     * Every command, until the last one finishes.
     *
     * @param commands the members, in the order they run
     * @return the group
     */
    public static Parallel all(Command... commands) {
        return new Parallel(Mode.ALL, list(commands));
    }

    /**
     * Every command, until the first one finishes; the rest are interrupted.
     *
     * @param commands the members, in the order they run
     * @return the group
     */
    public static Parallel race(Command... commands) {
        return new Parallel(Mode.RACE, list(commands));
    }

    /**
     * Every command, until {@code deadline} finishes; the rest are interrupted then. Commands that finish
     * before the deadline are ended as they finish.
     *
     * @param deadline the member whose finish ends the group; it runs first
     * @param others   the other members, in the order they run
     * @return the group
     */
    public static Parallel deadline(Command deadline, Command... others) {
        List<Command> members = new ArrayList<Command>(others.length + 1);
        members.add(deadline);
        Collections.addAll(members, others);
        return new Parallel(Mode.DEADLINE, members);
    }

    private static List<Command> list(Command... commands) {
        List<Command> members = new ArrayList<Command>(commands.length);
        Collections.addAll(members, commands);
        return members;
    }

    /** @return the members, in the order they run */
    public List<Command> members() {
        return members;
    }

    @Override
    public void start() {
        anyFinished = false;
        deadlineFinished = false;
        for (int i = 0; i < members.size(); i++) {
            members.get(i).start();
            running[i] = true;
        }
    }

    @Override
    public void execute() {
        for (int i = 0; i < members.size(); i++) {
            if (!running[i]) {
                continue;
            }
            Command member = members.get(i);
            member.execute();
            if (member.done()) {
                running[i] = false;
                member.end(EndCondition.NATURALLY);
                anyFinished = true;
                if (i == 0) {
                    deadlineFinished = true;
                }
            }
        }
    }

    @Override
    public boolean done() {
        switch (mode) {
            case RACE:
                return anyFinished || members.isEmpty();
            case DEADLINE:
                return deadlineFinished;
            default:
                for (boolean stillRunning : running) {
                    if (stillRunning) {
                        return false;
                    }
                }
                return true;
        }
    }

    @Override
    public void end(EndCondition endCondition) {
        if (endCondition == EndCondition.SUSPENDED) {
            for (int i = 0; i < members.size(); i++) {
                if (running[i]) {
                    members.get(i).end(EndCondition.SUSPENDED);
                }
            }
            return;
        }
        for (int i = 0; i < members.size(); i++) {
            if (running[i]) {
                running[i] = false;
                members.get(i).end(EndCondition.INTERRUPTED);
            }
        }
    }
}
