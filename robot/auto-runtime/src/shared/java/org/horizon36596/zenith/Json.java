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

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A small, complete JSON reader, and a cursor over the tree it produces. Zenith's auto files are read
 * with this and nothing else.
 *
 * <h2>Why this exists rather than org.json</h2>
 * {@code org.json} ships inside {@code android.jar}, so on the robot it is free. It is <b>not</b>
 * dependable in a robot project's JVM unit tests: the Android Gradle plugin replaces {@code android.jar}
 * with a mockable stub for {@code testDebugUnitTest}, and a project that sets
 * {@code unitTests.returnDefaultValues = true} gets a default back from every stubbed method instead of
 * an exception. Probed on 2026-09-21 in such a project: {@code new JSONObject("{\"a\":1}")} constructs
 * without error and then reports {@code has("a") == false}, {@code opt("a") == null} and
 * {@code length() == 0}. A parser that silently returns an empty document in the one place the runtime
 * is actually tested is worse than no parser, so the runtime carries its own.
 *
 * <p>It is also the cheaper half of the promise the runtime makes: the robot and the headless sim parse
 * the same bytes through the same code, which is what makes "runs twice and decodes identically" mean
 * anything. No dependency of its own, no clock, no randomness, no reflection.
 *
 * <h2>What it accepts</h2>
 * RFC 8259 JSON: objects, arrays, strings (with {@code \\u} escapes), numbers (the grammar exactly, so
 * {@code +1}, {@code .5}, {@code 01} and {@code 1.} are errors, and so is a magnitude a {@code double}
 * cannot hold), {@code true},
 * {@code false} and {@code null}. Objects keep their file order ({@link LinkedHashMap}), which is what
 * lets an error message quote keys in the order a human wrote them. Duplicate keys are an error rather
 * than a silent last-one-wins. Trailing commas, comments and unquoted keys are errors: these files are
 * written by Zenith's canonicaliser, and a file this parser rejects is a file the app did not write.
 *
 * <h2>Reading a tree</h2>
 * Every accessor carries the path it was reached by, so a wrong type or a missing key names itself:
 * <pre>{@code
 * Json root = Json.parse(stream, "first-auto.auto.json");
 * double x = root.get("start").get("pose").num("xIn");
 * // first-auto.auto.json: start.pose.xIn: expected a number, found a string
 * }</pre>
 */
public final class Json {

    private final Object value;
    private final String path;

    private Json(Object value, String path) {
        this.value = value;
        this.path = path;
    }

    // ---------------------------------------------------------------------------------------------
    // Parsing
    // ---------------------------------------------------------------------------------------------

    /**
     * Parse a whole UTF-8 stream. The stream is closed.
     *
     * @param stream the bytes; UTF-8, with or without a leading byte-order mark
     * @param name   what to call this document in error messages, usually the file name
     */
    public static Json parse(InputStream stream, String name) throws IOException {
        Reader reader = new InputStreamReader(stream, "UTF-8");
        try {
            StringBuilder text = new StringBuilder();
            char[] buffer = new char[8192];
            int read;
            while ((read = reader.read(buffer)) >= 0) {
                text.append(buffer, 0, read);
            }
            return parse(text.toString(), name);
        } finally {
            reader.close();
        }
    }

    /** Parse a whole document held in memory. See {@link #parse(InputStream, String)}. */
    public static Json parse(String text, String name) {
        Parser parser = new Parser(text, name);
        Object root = parser.parseValue();
        parser.skipWhitespace();
        if (!parser.atEnd()) {
            throw parser.error("trailing content after the top-level value");
        }
        return new Json(root, name);
    }

    // ---------------------------------------------------------------------------------------------
    // Navigating
    // ---------------------------------------------------------------------------------------------

    /** The dotted path this node was reached by, for error messages. */
    public String path() {
        return path;
    }

    public boolean isObject() {
        return value instanceof Map;
    }

    public boolean isArray() {
        return value instanceof List;
    }

    public boolean isString() {
        return value instanceof String;
    }

    public boolean isNumber() {
        return value instanceof Double;
    }

    /** True when this object has {@code key}. Throws if this node is not an object. */
    public boolean has(String key) {
        return asMap().containsKey(key);
    }

    /** The keys of this object, in file order. */
    public List<String> keys() {
        return Collections.unmodifiableList(new ArrayList<String>(asMap().keySet()));
    }

    /** The value at {@code key}. Throws when it is absent; use {@link #opt} for an optional one. */
    public Json get(String key) {
        Map<String, Object> map = asMap();
        if (!map.containsKey(key)) {
            throw fail("no key \"" + key + "\"; this object has " + map.keySet());
        }
        return new Json(map.get(key), child(key));
    }

    /**
     * The value at {@code key}, or {@code null} when the key is absent or its value is JSON
     * {@code null}. An absent optional key and an explicit {@code null} mean the same thing in these
     * files, and collapsing them here keeps every caller from having to say so.
     */
    public Json opt(String key) {
        Map<String, Object> map = asMap();
        if (!map.containsKey(key) || map.get(key) == null) {
            return null;
        }
        return new Json(map.get(key), child(key));
    }

    /** Element count of this array. */
    public int size() {
        return asList().size();
    }

    /** Element {@code index} of this array. */
    public Json at(int index) {
        List<Object> list = asList();
        if (index < 0 || index >= list.size()) {
            throw fail("no element " + index + "; this array has " + list.size());
        }
        return new Json(list.get(index), path + "[" + index + "]");
    }

    /** This array as a list of cursors, so it can be walked with a for-each. */
    public List<Json> items() {
        List<Object> raw = asList();
        List<Json> out = new ArrayList<Json>(raw.size());
        for (int i = 0; i < raw.size(); i++) {
            out.add(new Json(raw.get(i), path + "[" + i + "]"));
        }
        return out;
    }

    // ---------------------------------------------------------------------------------------------
    // Reading leaves
    // ---------------------------------------------------------------------------------------------

    /** This node as a string. */
    public String text() {
        if (!(value instanceof String)) {
            throw fail("expected a string, found " + describe());
        }
        return (String) value;
    }

    /** This node as a number. Every number in a Zenith file is a {@code double} in the file format. */
    public double num() {
        if (!(value instanceof Double)) {
            throw fail("expected a number, found " + describe());
        }
        return ((Double) value).doubleValue();
    }

    /** This node as a whole number. A fractional part is an error, not something to truncate. */
    public int integer() {
        double raw = num();
        if (raw != Math.rint(raw) || Double.isInfinite(raw)) {
            throw fail("expected a whole number, found " + raw);
        }
        return (int) raw;
    }

    /** This node as a boolean. */
    public boolean bool() {
        if (!(value instanceof Boolean)) {
            throw fail("expected true or false, found " + describe());
        }
        return ((Boolean) value).booleanValue();
    }

    /** Shorthand for {@code get(key).text()}. */
    public String str(String key) {
        return get(key).text();
    }

    /** Shorthand for {@code get(key).num()}. */
    public double num(String key) {
        return get(key).num();
    }

    /** Shorthand for {@code get(key).integer()}. */
    public int integer(String key) {
        return get(key).integer();
    }

    /** {@code key}'s string, or {@code fallback} when the key is absent or null. */
    public String optText(String key, String fallback) {
        Json node = opt(key);
        return node == null ? fallback : node.text();
    }

    /** {@code key}'s number, or {@code fallback} when the key is absent or null. */
    public double optNum(String key, double fallback) {
        Json node = opt(key);
        return node == null ? fallback : node.num();
    }

    /**
     * This object as a {@code Map<String, Object>} of raw values ({@code String}, {@code Double},
     * {@code Boolean}, {@code List}, {@code Map}), in file order. Used for a named command's
     * {@code args}, which the registry reads by name rather than against a schema.
     */
    public Map<String, Object> rawMap() {
        return Collections.unmodifiableMap(asMap());
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private Map<String, Object> asMap() {
        if (!(value instanceof Map)) {
            throw fail("expected an object, found " + describe());
        }
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private List<Object> asList() {
        if (!(value instanceof List)) {
            throw fail("expected an array, found " + describe());
        }
        return (List<Object>) value;
    }

    private String child(String key) {
        return path + (path.endsWith(".json") ? ": " : ".") + key;
    }

    private String describe() {
        if (value == null) {
            return "null";
        }
        if (value instanceof Map) {
            return "an object";
        }
        if (value instanceof List) {
            return "an array";
        }
        if (value instanceof String) {
            return "a string";
        }
        if (value instanceof Boolean) {
            return "a boolean";
        }
        return "a number";
    }

    private IllegalArgumentException fail(String message) {
        return new IllegalArgumentException(path + ": " + message);
    }

    /** Recursive descent over the document text. One instance per parse; not thread safe. */
    private static final class Parser {
        private final String text;
        private final String name;
        private int index;

        Parser(String text, String name) {
            this.text = text;
            this.name = name;
            // A UTF-8 byte-order mark survives the decode as U+FEFF and is not JSON whitespace.
            this.index = text.startsWith("\uFEFF") ? 1 : 0;
        }

        boolean atEnd() {
            return index >= text.length();
        }

        void skipWhitespace() {
            while (index < text.length()) {
                char c = text.charAt(index);
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                    index++;
                } else {
                    return;
                }
            }
        }

        Object parseValue() {
            skipWhitespace();
            if (atEnd()) {
                throw error("expected a value");
            }
            char c = text.charAt(index);
            switch (c) {
                case '{':
                    return parseObject();
                case '[':
                    return parseArray();
                case '"':
                    return parseString();
                case 't':
                    expect("true");
                    return Boolean.TRUE;
                case 'f':
                    expect("false");
                    return Boolean.FALSE;
                case 'n':
                    expect("null");
                    return null;
                default:
                    return parseNumber();
            }
        }

        private Map<String, Object> parseObject() {
            Map<String, Object> map = new LinkedHashMap<String, Object>();
            index++; // the opening brace
            skipWhitespace();
            if (peek() == '}') {
                index++;
                return map;
            }
            while (true) {
                skipWhitespace();
                if (peek() != '"') {
                    throw error("expected a quoted key");
                }
                String key = parseString();
                if (map.containsKey(key)) {
                    throw error("duplicate key \"" + key + "\"");
                }
                skipWhitespace();
                if (peek() != ':') {
                    throw error("expected a colon after key \"" + key + "\"");
                }
                index++;
                map.put(key, parseValue());
                skipWhitespace();
                char c = peek();
                if (c == ',') {
                    index++;
                    continue;
                }
                if (c == '}') {
                    index++;
                    return map;
                }
                throw error("expected a comma or a closing brace in an object");
            }
        }

        private List<Object> parseArray() {
            List<Object> list = new ArrayList<Object>();
            index++; // the opening bracket
            skipWhitespace();
            if (peek() == ']') {
                index++;
                return list;
            }
            while (true) {
                list.add(parseValue());
                skipWhitespace();
                char c = peek();
                if (c == ',') {
                    index++;
                    continue;
                }
                if (c == ']') {
                    index++;
                    return list;
                }
                throw error("expected a comma or a closing bracket in an array");
            }
        }

        private String parseString() {
            index++; // the opening quote
            StringBuilder out = new StringBuilder();
            while (true) {
                if (atEnd()) {
                    throw error("unterminated string");
                }
                char c = text.charAt(index++);
                if (c == '"') {
                    return out.toString();
                }
                if (c != '\\') {
                    if (c < 0x20) {
                        throw error("a raw control character is not allowed inside a string");
                    }
                    out.append(c);
                    continue;
                }
                if (atEnd()) {
                    throw error("unterminated escape");
                }
                char escape = text.charAt(index++);
                switch (escape) {
                    case '"': out.append('"'); break;
                    case '\\': out.append('\\'); break;
                    case '/': out.append('/'); break;
                    case 'b': out.append('\b'); break;
                    case 'f': out.append('\f'); break;
                    case 'n': out.append('\n'); break;
                    case 'r': out.append('\r'); break;
                    case 't': out.append('\t'); break;
                    case 'u':
                        if (index + 4 > text.length()) {
                            throw error("a \\u escape needs four hex digits");
                        }
                        String hex = text.substring(index, index + 4);
                        try {
                            out.append((char) Integer.parseInt(hex, 16));
                        } catch (NumberFormatException bad) {
                            throw error("\\u" + hex + " is not four hex digits");
                        }
                        index += 4;
                        break;
                    default:
                        throw error("unknown escape backslash-" + escape);
                }
            }
        }

        /**
         * One number, exactly as RFC 8259 spells it: an optional minus, an integer part with no leading
         * zero, an optional fraction with at least one digit, an optional exponent with at least one
         * digit.
         *
         * <p>Scanning the grammar rather than gathering a run of number-ish characters and handing it to
         * {@code Double.valueOf} is what keeps {@code +1}, {@code .5}, {@code 01}, {@code 1.} and
         * {@code 0x1p3} out: {@code Double.valueOf} accepts all of those and a file Zenith did not write
         * would be read as though it had. And a magnitude {@code double} cannot hold is refused here
         * rather than becoming {@code Infinity} - a {@code timeoutS} of {@code 1e999} silently became a
         * timeout of {@code Long.MAX_VALUE} milliseconds in {@code RobotTimeout.of}, which is a step
         * that never times out.
         */
        private Double parseNumber() {
            int start = index;
            if (!atEnd() && text.charAt(index) == '-') {
                index++;
            }
            if (atEnd() || !isDigit(text.charAt(index))) {
                throw error("a number starts with a digit or a minus sign, found " + found());
            }
            if (text.charAt(index) == '0') {
                index++;
                if (!atEnd() && isDigit(text.charAt(index))) {
                    throw error("a number may not have a leading zero");
                }
            } else {
                while (!atEnd() && isDigit(text.charAt(index))) {
                    index++;
                }
            }
            if (!atEnd() && text.charAt(index) == '.') {
                index++;
                if (atEnd() || !isDigit(text.charAt(index))) {
                    throw error("a decimal point needs at least one digit after it, found " + found());
                }
                while (!atEnd() && isDigit(text.charAt(index))) {
                    index++;
                }
            }
            if (!atEnd() && (text.charAt(index) == 'e' || text.charAt(index) == 'E')) {
                index++;
                if (!atEnd() && (text.charAt(index) == '+' || text.charAt(index) == '-')) {
                    index++;
                }
                if (atEnd() || !isDigit(text.charAt(index))) {
                    throw error("an exponent needs at least one digit, found " + found());
                }
                while (!atEnd() && isDigit(text.charAt(index))) {
                    index++;
                }
            }

            String raw = text.substring(start, index);
            double value = Double.parseDouble(raw);
            if (Double.isInfinite(value)) {
                index = start;
                throw error("the number " + raw + " is outside the range of a double");
            }
            return Double.valueOf(value);
        }

        /** What is at the cursor, quoted, or "the end of the document". For a message about a number. */
        private String found() {
            return atEnd() ? "the end of the document" : "\"" + text.charAt(index) + "\"";
        }

        private static boolean isDigit(char c) {
            return c >= '0' && c <= '9';
        }

        private char peek() {
            if (atEnd()) {
                throw error("unexpected end of document");
            }
            return text.charAt(index);
        }

        private void expect(String literal) {
            if (!text.startsWith(literal, index)) {
                throw error("expected " + literal);
            }
            index += literal.length();
        }

        IllegalArgumentException error(String message) {
            int line = 1;
            int column = 1;
            for (int i = 0; i < Math.min(index, text.length()); i++) {
                if (text.charAt(i) == '\n') {
                    line++;
                    column = 1;
                } else {
                    column++;
                }
            }
            return new IllegalArgumentException(
                    name + " line " + line + " column " + column + ": " + message);
        }
    }
}
