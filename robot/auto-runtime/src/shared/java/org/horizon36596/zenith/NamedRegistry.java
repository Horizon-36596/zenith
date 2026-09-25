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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.function.BooleanSupplier;

/**
 * The two tables behind each runtime's {@code NamedCommands}: command name to factory, and condition
 * name to {@link BooleanSupplier}. It names no command library, so the rules - a name registered twice
 * is an error, an unknown name lists every registered one - and every message are the same on both
 * runtimes.
 *
 * <p>Each runtime keeps one of these in a static field. One OpMode runs at a time, and each
 * {@code AutoFromFile} clears its runtime's table before {@code registerCommands}.
 *
 * @param <F> the runtime's factory type
 */
public final class NamedRegistry<F> {

    private final Map<String, F> commands = new LinkedHashMap<String, F>();
    private final Map<String, BooleanSupplier> conditions = new LinkedHashMap<String, BooleanSupplier>();

    /** Forget everything. */
    public void reset() {
        commands.clear();
        conditions.clear();
    }

    /**
     * Register a command name.
     *
     * @param name    the name an auto file uses in a {@code command} step or a marker
     * @param factory builds a fresh command each time the name is used
     */
    public void register(String name, F factory) {
        if (commands.containsKey(name)) {
            throw new IllegalStateException("the command name \"" + name + "\" is registered twice");
        }
        commands.put(name, factory);
    }

    /**
     * Register a condition name.
     *
     * @param name      the name an auto file uses
     * @param condition read once per loop while it matters
     */
    public void registerCondition(String name, BooleanSupplier condition) {
        if (conditions.containsKey(name)) {
            throw new IllegalStateException("the condition name \"" + name + "\" is registered twice");
        }
        conditions.put(name, condition);
    }

    /** @return every registered command name, sorted */
    public List<String> commandNames() {
        return Collections.unmodifiableList(new ArrayList<String>(new TreeSet<String>(commands.keySet())));
    }

    /** @return every registered condition name, sorted */
    public List<String> conditionNames() {
        return Collections.unmodifiableList(new ArrayList<String>(new TreeSet<String>(conditions.keySet())));
    }

    /**
     * The factory registered as {@code name}. Throws, listing every registered name, when there is none.
     *
     * @param name the registered name
     * @return the factory
     */
    public F factory(String name) {
        F factory = commands.get(name);
        if (factory == null) {
            throw new IllegalArgumentException("no auto command named \"" + name
                    + "\" is registered on this robot. Registered commands: " + commandNames()
                    + ". Register it in your ZenithRobot's registerCommands(), or fix the auto file.");
        }
        return factory;
    }

    /**
     * What a factory built, checked. A factory that returns {@code null} is a bug in the team's code,
     * and failing here names it rather than failing later somewhere in the scheduler.
     *
     * @param name  the name the factory is registered as
     * @param built what it returned
     * @param <C>   the command type
     * @return {@code built}
     */
    public static <C> C checkBuilt(String name, C built) {
        if (built == null) {
            throw new IllegalStateException("the factory for \"" + name + "\" returned null");
        }
        return built;
    }

    /**
     * The condition called {@code name}. Throws, listing every registered name, when it is not there.
     *
     * @param name the registered name
     * @return the condition
     */
    public BooleanSupplier condition(String name) {
        BooleanSupplier found = conditions.get(name);
        if (found == null) {
            throw new IllegalArgumentException("no auto condition named \"" + name
                    + "\" is registered on this robot. Registered conditions: " + conditionNames()
                    + ". Register it in your ZenithRobot's registerCommands(), or fix the auto file.");
        }
        return found;
    }
}
