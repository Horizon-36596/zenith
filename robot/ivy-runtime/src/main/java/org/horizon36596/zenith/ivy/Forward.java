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

import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * A command that picks, or builds, the command it runs when it starts, and then forwards every call to
 * it: {@code execute}, then {@code done}, then {@code end}, in the order it is called, with nothing
 * skipped. The runtime's {@code branch} and its deferred {@code "current"} path are both this.
 *
 * <p><b>Why not Ivy's {@code Commands.conditional} and {@code Commands.lazy}.</b> Both ask the chosen
 * command {@code done()} inside their own {@code execute()} and skip its {@code execute()} when it is
 * already done, so a command that is done as soon as it starts is never executed. SolversLib's
 * {@code ConditionalCommand} and {@code DeferredCommand} always execute it once, and the two runtimes
 * have to agree on every call a team's command sees.
 */
final class Forward extends BaseCommand {

    private final Supplier<Command> choose;
    private Command selected;

    private Forward(Supplier<Command> choose, Set<Object> requirements, int priority) {
        this.choose = choose;
        addRequirements(requirements);
        setPriority(priority);
    }

    /**
     * {@code ifTrue} or {@code ifFalse}, decided once, when the command starts.
     *
     * @param condition read once, at start
     * @param ifTrue    run when it is true
     * @param ifFalse   run when it is false
     * @return the command
     */
    static Forward branch(final BooleanSupplier condition, final Command ifTrue, final Command ifFalse) {
        Forward branch = new Forward(new Supplier<Command>() {
            @Override
            public Command get() {
                return condition.getAsBoolean() ? ifTrue : ifFalse;
            }
        }, ifTrue.requirements(), Math.max(ifTrue.priority(), ifFalse.priority()));
        branch.addRequirements(ifFalse.requirements());
        return branch;
    }

    /**
     * A command built when this one starts. The requirements have to be known before then, so they are
     * given here.
     *
     * @param build        called at start; must not return {@code null}
     * @param requirements what the built command will need
     * @param priority     the priority to report until the command is built, which should be the one it
     *                     will have
     * @return the command
     */
    static Forward deferred(Supplier<Command> build, Set<Object> requirements, int priority) {
        return new Forward(build, requirements, priority);
    }

    @Override
    public void start() {
        selected = choose.get();
        if (selected == null) {
            throw new IllegalStateException("a deferred command built nothing");
        }
        selected.start();
    }

    @Override
    public void execute() {
        selected.execute();
    }

    @Override
    public boolean done() {
        return selected != null && selected.done();
    }

    @Override
    public void end(EndCondition endCondition) {
        if (selected != null) {
            selected.end(endCondition);
        }
    }
}
