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
 * Runs commands one after another. The Ivy runtime's own replacement for Ivy's
 * {@code Groups.sequential}, with exactly the behaviour of SolversLib's {@code SequentialCommandGroup},
 * which the SolversLib runtime uses.
 *
 * <p><b>Why not Ivy's group.</b> When it is interrupted it ends every member after
 * the current one too, including members that never started, so a traced step would record an end with
 * no start. And it asks a member {@code done()} before its {@code execute()}, so a member that finishes
 * because of its own {@code execute()} ends a loop later than on the SolversLib runtime.
 *
 * <p><b>What this group does.</b> It starts the first member when it starts. Each loop it executes the
 * current member and then asks it {@code done()}; when it is done the member is ended with
 * {@link EndCondition#NATURALLY} and the next one is started, in the same loop. The group is done when
 * the last member is. Ended early, it interrupts the current member only; a member that never started
 * is never ended. {@link EndCondition#SUSPENDED} is passed to the current member, which keeps its place.
 *
 * <p>Its requirements are the union of its members' and its priority the highest of theirs, Ivy's rule
 * for groups. Members may share requirements, because they never run at the same time.
 */
public final class Sequence extends BaseCommand {

    private final List<Command> members;
    private int index = -1;

    /**
     * @param commands the members, in the order they run
     */
    public Sequence(Command... commands) {
        List<Command> members = new ArrayList<Command>(commands.length);
        Collections.addAll(members, commands);
        int highest = Integer.MIN_VALUE;
        for (int i = 0; i < members.size(); i++) {
            for (int j = 0; j < i; j++) {
                if (members.get(i) == members.get(j)) {
                    throw new IllegalArgumentException("A command cannot be in a sequence twice");
                }
            }
            addRequirements(members.get(i).requirements());
            highest = Math.max(highest, members.get(i).priority());
        }
        setPriority(members.isEmpty() ? 0 : highest);
        this.members = Collections.unmodifiableList(members);
    }

    /** @return the members, in the order they run */
    public List<Command> members() {
        return members;
    }

    @Override
    public void start() {
        index = 0;
        if (!members.isEmpty()) {
            members.get(0).start();
        }
    }

    @Override
    public void execute() {
        if (index < 0 || index >= members.size()) {
            return;
        }
        Command current = members.get(index);
        current.execute();
        if (current.done()) {
            current.end(EndCondition.NATURALLY);
            index++;
            if (index < members.size()) {
                members.get(index).start();
            }
        }
    }

    @Override
    public boolean done() {
        return index >= members.size();
    }

    @Override
    public void end(EndCondition endCondition) {
        if (index < 0 || index >= members.size()) {
            index = -1;
            return;
        }
        if (endCondition == EndCondition.SUSPENDED) {
            members.get(index).end(EndCondition.SUSPENDED);
            return;
        }
        members.get(index).end(EndCondition.INTERRUPTED);
        index = -1;
    }
}
