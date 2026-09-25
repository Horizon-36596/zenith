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
import com.pedropathing.ivy.behaviors.BlockedBehavior;
import com.pedropathing.ivy.behaviors.ConflictBehavior;
import com.pedropathing.ivy.behaviors.EndCondition;
import com.pedropathing.ivy.behaviors.InterruptedBehavior;

import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * What every command this runtime builds has in common: a requirement set in the order requirements
 * were added, and Ivy's own defaults for everything else (priority 0, {@link InterruptedBehavior#END},
 * {@link ConflictBehavior#OVERRIDE}, {@link BlockedBehavior#CANCEL}), which are the defaults of Ivy's
 * {@code CommandBuilder}.
 *
 * <p>Not {@code CommandBuilder} itself, because its {@code start}, {@code execute}, {@code done} and
 * {@code end} are final and take lambdas, and the runtime's groups need to hold state between them.
 */
abstract class BaseCommand implements Command {

    /** Requirements in the order they were added, so iterating them is the same on every run. */
    private final Set<Object> requirements = new LinkedHashSet<Object>();
    private final Set<Object> readOnlyRequirements = Collections.unmodifiableSet(requirements);
    private int priority;

    /** @param requirement one more thing this command needs to itself */
    protected final void addRequirement(Object requirement) {
        requirements.add(requirement);
    }

    /** @param more more things this command needs to itself */
    protected final void addRequirements(Set<Object> more) {
        requirements.addAll(more);
    }

    /** @param priority this command's Ivy priority */
    protected final void setPriority(int priority) {
        this.priority = priority;
    }

    @Override
    public Set<Object> requirements() {
        return readOnlyRequirements;
    }

    @Override
    public int priority() {
        return priority;
    }

    @Override
    public InterruptedBehavior interruptedBehavior() {
        return InterruptedBehavior.END;
    }

    @Override
    public ConflictBehavior conflictBehavior() {
        return ConflictBehavior.OVERRIDE;
    }

    @Override
    public BlockedBehavior blockedBehavior() {
        return BlockedBehavior.CANCEL;
    }

    @Override
    public void start() {}

    @Override
    public void execute() {}

    @Override
    public boolean done() {
        return false;
    }

    @Override
    public void end(EndCondition endCondition) {}
}
