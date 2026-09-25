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

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * A named command's arguments: building the map, for code {@code zenith codegen} writes, and reading
 * it, for a team's command factories. Both runtimes' {@code NamedCommands.arg*} helpers are these.
 *
 * <p><b>Reading.</b> Values come from the JSON reader, so a number is a {@link Double}, a string is a
 * {@link String} and a flag is a {@link Boolean}. The readers do the checking and produce messages that
 * name the command and the argument.
 *
 * <p><b>Building.</b> Not {@code Map.of}: that is Java 9 and Android API 30, and a Control Hub runs API 24, so a
 * generated class that called it would fail with {@code NoSuchMethodError} on the robot. This is
 * plain Java 8. Keys keep the order they are given.
 */
public final class Args {

    private Args() {}

    /**
     * @param keysAndValues {@code key1, value1, key2, value2, ...}; keys are strings
     * @return an unmodifiable map of them, in the order given
     * @throws IllegalArgumentException for an odd count, a key that is not a string, or a repeated key
     */
    public static Map<String, Object> of(Object... keysAndValues) {
        if (keysAndValues.length % 2 != 0) {
            throw new IllegalArgumentException("Args.of takes key, value pairs; got "
                    + keysAndValues.length + " values");
        }
        Map<String, Object> args = new LinkedHashMap<String, Object>();
        for (int i = 0; i < keysAndValues.length; i += 2) {
            if (!(keysAndValues[i] instanceof String)) {
                throw new IllegalArgumentException("Args.of: key " + (i / 2) + " is not a string");
            }
            String key = (String) keysAndValues[i];
            if (args.containsKey(key)) {
                throw new IllegalArgumentException("Args.of: key \"" + key + "\" is given twice");
            }
            args.put(key, keysAndValues[i + 1]);
        }
        return Collections.unmodifiableMap(args);
    }

    // ---------------------------------------------------------------------------------------------
    // Reading arguments
    // ---------------------------------------------------------------------------------------------

    /** A required whole-number argument. */
    public static int argInt(Map<String, Object> args, String command, String key) {
        double raw = argDouble(args, command, key);
        if (raw != Math.rint(raw)) {
            throw new IllegalArgumentException(command + ": argument \"" + key
                    + "\" must be a whole number, found " + raw);
        }
        return (int) raw;
    }

    /** A required numeric argument. */
    public static double argDouble(Map<String, Object> args, String command, String key) {
        Object value = require(args, command, key);
        if (!(value instanceof Double)) {
            throw new IllegalArgumentException(command + ": argument \"" + key
                    + "\" must be a number, found " + value);
        }
        return ((Double) value).doubleValue();
    }

    /** An optional numeric argument. */
    public static double argDouble(Map<String, Object> args, String command, String key, double fallback) {
        return args.containsKey(key) ? argDouble(args, command, key) : fallback;
    }

    /** A required string argument. */
    public static String argString(Map<String, Object> args, String command, String key) {
        Object value = require(args, command, key);
        if (!(value instanceof String)) {
            throw new IllegalArgumentException(command + ": argument \"" + key
                    + "\" must be a string, found " + value);
        }
        return (String) value;
    }

    /** An optional string argument. */
    public static String argString(Map<String, Object> args, String command, String key, String fallback) {
        return args.containsKey(key) ? argString(args, command, key) : fallback;
    }

    /**
     * An optional enum-valued argument, matched case-sensitively against the constant names, so a file
     * that says {@code "FORWARD"} gets the constant {@code FORWARD} of {@code type}.
     */
    public static <E extends Enum<E>> E argEnum(Map<String, Object> args, String command, String key,
            Class<E> type, E fallback) {
        if (!args.containsKey(key)) {
            return fallback;
        }
        String raw = argString(args, command, key);
        for (E value : type.getEnumConstants()) {
            if (value.name().equals(raw)) {
                return value;
            }
        }
        StringBuilder known = new StringBuilder();
        for (E value : type.getEnumConstants()) {
            if (known.length() > 0) {
                known.append(", ");
            }
            known.append(value.name());
        }
        throw new IllegalArgumentException(command + ": argument \"" + key + "\" is \"" + raw
                + "\"; expected one of " + known);
    }

    private static Object require(Map<String, Object> args, String command, String key) {
        if (!args.containsKey(key) || args.get(key) == null) {
            throw new IllegalArgumentException(command + ": missing required argument \"" + key
                    + "\"; this step supplied " + args.keySet());
        }
        return args.get(key);
    }
}
