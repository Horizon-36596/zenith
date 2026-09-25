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

import java.util.function.BooleanSupplier;

/**
 * One of two commands, picked once when the branch starts. What a file's {@code branch} step becomes
 * on the Ivy runtime, and what {@code zenith codegen} writes for one.
 *
 * <p>Not Ivy's {@code Commands.conditional}: that one skips the chosen command's {@code execute()} when
 * the command is already done as soon as it starts, where SolversLib's {@code ConditionalCommand}
 * executes it once. This branch does what SolversLib's does, so a team's command sees the same calls on
 * either runtime. Its requirements are both arms' together, and its priority the higher of theirs.
 */
public final class Branch {

    private Branch() {}

    /**
     * @param condition read once, when the branch starts
     * @param ifTrue    run when it is true
     * @param ifFalse   run when it is false; for an empty {@code else}, {@code Commands.instant(() -> {})}
     * @return the branch
     */
    public static Command of(BooleanSupplier condition, Command ifTrue, Command ifFalse) {
        return Forward.branch(condition, ifTrue, ifFalse);
    }
}
