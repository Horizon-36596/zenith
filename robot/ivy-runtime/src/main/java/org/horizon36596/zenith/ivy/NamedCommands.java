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

import org.horizon36596.zenith.Args;
import org.horizon36596.zenith.NamedRegistry;

import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * The bridge between a name in an auto file and a real Ivy command on this robot. The Ivy side's copy of
 * the SolversLib runtime's {@code NamedCommands}: the same rules and the same messages, from the shared
 * {@link NamedRegistry}, with factories that return Ivy commands.
 *
 * <p>{@link ZenithRobot#registerCommands} fills it once per OpMode init, before the routine is built.
 *
 * <pre>{@code
 * NamedCommands.register("intakeOn", (args, ctx) -> Commands.instant(intake::on));
 * NamedCommands.register("score", (args, ctx) ->
 *         lift.score(NamedCommands.argInt(args, "score", "level")));
 * NamedCommands.registerCondition("holdingPiece", intake::hasPiece);
 * }</pre>
 *
 * <p><b>A factory is called every time its name is used.</b> An Ivy command built with
 * {@code CommandBuilder} holds its own state, so one instance in two places in a routine would share it.
 * A factory must return a new command each time.
 *
 * <p><b>Unknown names fail loudly.</b> {@link #build} and {@link #condition} throw and list every name
 * that is registered, because the alternative - a silently skipped step - is a robot that drives its
 * path and never shoots, at a competition, with no error anywhere.
 *
 * <p><b>The registry is static and is cleared on every fill.</b> Registering the same name twice within
 * one fill is an error, not a silent overwrite.
 *
 * <p><b>Argument types.</b> Values come from the JSON reader, so a number is a {@link Double}, a string
 * is a {@link String} and a flag is a {@link Boolean}. The {@code arg*} helpers are {@link Args}'s.
 */
public final class NamedCommands {

    /** Builds one command from a file's arguments. */
    public interface Factory {
        /**
         * @param args the step's {@code args}, as the JSON reader produced them; see the class javadoc
         * @param ctx  the running auto
         * @return a new command; never {@code null}, and never one returned before
         */
        Command build(Map<String, Object> args, AutoContext ctx);
    }

    private static final NamedRegistry<Factory> REGISTRY = new NamedRegistry<Factory>();

    private NamedCommands() {}

    /** Forget everything. {@link AutoFromFile} calls it before {@link ZenithRobot#registerCommands}. */
    public static void reset() {
        REGISTRY.reset();
    }

    /**
     * Register a command name.
     *
     * @param name    the name an auto file uses in a {@code command} step or a marker
     * @param factory builds a fresh command each time the name is used
     */
    public static void register(String name, Factory factory) {
        REGISTRY.register(name, factory);
    }

    /**
     * Register a condition name, for {@code branch}, {@code wait until} and {@code endCondition}.
     *
     * @param name      the name an auto file uses
     * @param condition read once per loop while it matters
     */
    public static void registerCondition(String name, BooleanSupplier condition) {
        REGISTRY.registerCondition(name, condition);
    }

    /** @return every registered command name, sorted */
    public static List<String> commandNames() {
        return REGISTRY.commandNames();
    }

    /** @return every registered condition name, sorted */
    public static List<String> conditionNames() {
        return REGISTRY.conditionNames();
    }

    /**
     * Build the command called {@code name}. Throws when it is not registered.
     *
     * @param name the registered name
     * @param args the step's arguments
     * @param ctx  the running auto, passed to the factory
     * @return the built command
     */
    public static Command build(String name, Map<String, Object> args, AutoContext ctx) {
        return NamedRegistry.checkBuilt(name, REGISTRY.factory(name).build(args, ctx));
    }

    /**
     * The condition called {@code name}. Throws when it is not registered.
     *
     * @param name the registered name
     * @return the condition
     */
    public static BooleanSupplier condition(String name) {
        return REGISTRY.condition(name);
    }

    // ---------------------------------------------------------------------------------------------
    // Reading arguments, the same helpers as the SolversLib runtime's
    // ---------------------------------------------------------------------------------------------

    /** A required whole-number argument; {@link Args#argInt}. */
    public static int argInt(Map<String, Object> args, String command, String key) {
        return Args.argInt(args, command, key);
    }

    /** A required numeric argument; {@link Args#argDouble(Map, String, String)}. */
    public static double argDouble(Map<String, Object> args, String command, String key) {
        return Args.argDouble(args, command, key);
    }

    /** An optional numeric argument; {@link Args#argDouble(Map, String, String, double)}. */
    public static double argDouble(Map<String, Object> args, String command, String key, double fallback) {
        return Args.argDouble(args, command, key, fallback);
    }

    /** A required string argument; {@link Args#argString(Map, String, String)}. */
    public static String argString(Map<String, Object> args, String command, String key) {
        return Args.argString(args, command, key);
    }

    /** An optional string argument; {@link Args#argString(Map, String, String, String)}. */
    public static String argString(Map<String, Object> args, String command, String key, String fallback) {
        return Args.argString(args, command, key, fallback);
    }

    /** An optional enum-valued argument; {@link Args#argEnum}. */
    public static <E extends Enum<E>> E argEnum(Map<String, Object> args, String command, String key,
            Class<E> type, E fallback) {
        return Args.argEnum(args, command, key, type, fallback);
    }
}
