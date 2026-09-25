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

import com.seattlesolvers.solverslib.command.Command;
import com.seattlesolvers.solverslib.command.CommandBase;
import com.seattlesolvers.solverslib.command.CommandGroupBase;
import com.seattlesolvers.solverslib.command.Subsystem;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Runs commands side by side: all of them, a race, or a deadline. The runtime's own replacement for
 * SolversLib's {@code ParallelCommandGroup}, {@code ParallelRaceGroup} and {@code ParallelDeadlineGroup}.
 *
 * <p><b>Why not SolversLib's groups.</b> Two behaviours of SolversLib 0.3.6, both visible on a robot:
 * <ul>
 *   <li>{@code ParallelRaceGroup.end} calls {@code end(true)} on the members that have not finished and
 *       nothing at all on the one that has. A path under a {@code timeoutS} that arrives in time never
 *       gets {@code end(false)}, and when the member that finished is itself a group (a path with
 *       markers is one), that group is never ended, so a marker command still running when its path
 *       arrives is never ended either.</li>
 *   <li>All three keep their members in a {@code HashMap} or {@code HashSet} keyed on identity hash
 *       codes, so the order members start and run within one loop changes from run to run.</li>
 * </ul>
 *
 * <p><b>What this group guarantees instead.</b>
 * <ul>
 *   <li>Every member's {@code end} is called exactly once per run of the group: {@code end(false)} on
 *       the loop the member reports itself finished, or {@code end(true)} when the group ends while the
 *       member is still running.</li>
 *   <li>Members initialise, execute and end in the order they were given, which for a file-driven auto
 *       is the order the file lists them. A {@link #deadline deadline} group puts its deadline first.</li>
 *   <li>Loop timing matches SolversLib's: every running member executes each loop, including the loop a
 *       race is won or a deadline arrives on, and the group reports finished at the end of that loop.</li>
 * </ul>
 *
 * <p>It does not depend on the SolversLib bug being there, so a SolversLib that fixes it changes nothing.
 *
 * <p>SolversLib keeps its registry of grouped commands package-private, so these groups check that a
 * member is not already in a SolversLib group but cannot add their own members to that registry.
 * Putting one command in two groups is a mistake either way.
 */
public final class Parallel extends CommandBase {

    private enum Mode { ALL, RACE, DEADLINE }

    private final Mode mode;
    private final List<Command> members;
    private final boolean[] running;
    private boolean anyFinished;
    private boolean deadlineFinished;

    private Parallel(Mode mode, List<Command> members) {
        this.mode = mode;
        CommandGroupBase.requireUngrouped(members);
        for (int i = 0; i < members.size(); i++) {
            for (int j = 0; j < i; j++) {
                if (members.get(i) == members.get(j)) {
                    throw new IllegalArgumentException("A command cannot be in a parallel group twice");
                }
            }
            Command member = members.get(i);
            if (!Collections.disjoint(member.getRequirements(), m_requirements)) {
                throw new IllegalArgumentException("Multiple commands in a parallel group cannot"
                        + " require the same subsystems");
            }
            m_requirements.addAll(member.getRequirements());
        }
        this.members = Collections.unmodifiableList(new ArrayList<Command>(members));
        this.running = new boolean[members.size()];
    }

    /** Every command, until the last one finishes. */
    public static Parallel all(Command... commands) {
        return new Parallel(Mode.ALL, list(commands));
    }

    /** Every command, until the first one finishes; the rest are interrupted. */
    public static Parallel race(Command... commands) {
        return new Parallel(Mode.RACE, list(commands));
    }

    /**
     * Every command, until {@code deadline} finishes; the rest are interrupted then. Commands that finish
     * before the deadline are ended as they finish.
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

    /** The members, in the order they run. */
    public List<Command> members() {
        return members;
    }

    @Override
    public void initialize() {
        anyFinished = false;
        deadlineFinished = false;
        for (int i = 0; i < members.size(); i++) {
            members.get(i).initialize();
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
            if (member.isFinished()) {
                running[i] = false;
                member.end(false);
                anyFinished = true;
                if (i == 0) {
                    deadlineFinished = true;
                }
            }
        }
    }

    @Override
    public boolean isFinished() {
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
    public void end(boolean interrupted) {
        for (int i = 0; i < members.size(); i++) {
            if (running[i]) {
                running[i] = false;
                members.get(i).end(true);
            }
        }
    }

    @Override
    public boolean runsWhenDisabled() {
        for (Command member : members) {
            if (!member.runsWhenDisabled()) {
                return false;
            }
        }
        return true;
    }
}
