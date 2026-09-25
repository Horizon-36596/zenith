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

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Writes {@code <auto>.trace.json}: what a headless sim saw an auto do, in the trace format Zenith reads
 * back (site/docs/simulation.md), so the editor can lay the estimate over
 * what actually happened.
 *
 * <p>It is for tests. Nothing on a robot needs it, and it reads no clock: every time stamp is the sim
 * time the caller passes in.
 *
 * <p>This is the part that names no command library. Each runtime's {@code AutoTraceWriter} extends it
 * and adds {@code traced(id, body)}, which wraps one of that library's commands, so the file a trace
 * writes is byte for byte the same whichever library ran the auto.
 *
 * <h2>Using it</h2>
 * Wrap every step through the runtime's {@code AutoTraceWriter.traced}, which is exactly the shape of its
 * {@code ZenithRobot.step}:
 *
 * <pre>{@code
 * AutoTraceWriter trace = new AutoTraceWriter("first-auto", TICK_SECONDS);
 * // in the test's ZenithRobot:  step(id, body) returns trace.traced(id, body)
 * ...each tick...
 * trace.tick(timeS);                    // stamps the clock the step records use
 * trace.pose(xIn, yIn, headingRad);     // what the robot believes
 * trace.truthPose(...);                 // what the sim knows, when it is different
 * ...afterwards...
 * trace.write(new File("build/sim/first-auto.trace.json"));
 * }</pre>
 *
 * <p>A test that already has its own step wrapper calls {@link #stepStarted} and {@link #stepEnded}
 * from it instead.
 *
 * <h2>capabilities</h2>
 * The {@code capabilities} list names what this trace actually carries, so a report can say "no
 * structure contacts were checked" rather than "no structure contacts happened". Those are different
 * sentences, and until a sim measures contacts, spills or retrievals, the corresponding sections of a
 * trace are empty because nothing measures them.
 *
 * <h2>Determinism</h2>
 * Numbers are formatted with {@link Locale#ROOT} to three decimals, so two runs of the same scenario
 * produce byte-identical files and a diff of two traces is a diff of two runs.
 */
public class AutoTrace {

    /** The trace format this writer emits. */
    public static final int FORMAT_VERSION = 1;

    private final String autoName;
    private final double tickS;

    private final List<double[]> poses = new ArrayList<double[]>();
    private final List<double[]> truthPoses = new ArrayList<double[]>();
    private final List<StepRecord> steps = new ArrayList<StepRecord>();
    private final Set<String> capabilities = new LinkedHashSet<String>();

    private double nowS;
    private double lastS;

    /**
     * @param autoName the auto's file stem, written into the trace
     * @param tickS    the sim's fixed tick, seconds
     */
    public AutoTrace(String autoName, double tickS) {
        this.autoName = autoName;
        this.tickS = tickS;
        capabilities.add("steps");
    }

    /**
     * Set the sim clock for everything recorded until the next call. Call once per tick.
     *
     * @param timeS sim time, seconds
     */
    public void tick(double timeS) {
        nowS = timeS;
        lastS = Math.max(lastS, timeS);
    }

    /**
     * The robot's belief about where it is.
     *
     * @param xIn        field frame, inches
     * @param yIn        field frame, inches
     * @param headingRad field frame, radians
     */
    public void pose(double xIn, double yIn, double headingRad) {
        capabilities.add("poses");
        poses.add(new double[] {nowS, xIn, yIn, headingRad});
    }

    /**
     * Where the sim knows the robot actually is. Absent means localisation error is not visible.
     *
     * @param xIn        field frame, inches
     * @param yIn        field frame, inches
     * @param headingRad field frame, radians
     */
    public void truthPose(double xIn, double yIn, double headingRad) {
        capabilities.add("truthPoses");
        truthPoses.add(new double[] {nowS, xIn, yIn, headingRad});
    }

    /**
     * Declare a capability this trace carries that nothing above implies.
     *
     * @param name the capability's name
     */
    public void capability(String name) {
        capabilities.add(name);
    }

    /**
     * Record that a step started, at the time of the last {@link #tick}.
     *
     * @param id the step's id
     */
    public void stepStarted(String id) {
        steps.add(new StepRecord(id, nowS));
    }

    /**
     * Record that a step ended, at the time of the last {@link #tick}. Closes the latest open record
     * with this id.
     *
     * @param id          the step's id
     * @param interrupted whether it was cut off rather than finishing
     */
    public void stepEnded(String id, boolean interrupted) {
        for (int i = steps.size() - 1; i >= 0; i--) {
            StepRecord record = steps.get(i);
            if (record.id.equals(id) && Double.isNaN(record.endS)) {
                record.endS = nowS;
                record.interrupted = interrupted;
                return;
            }
        }
    }

    /**
     * Write the file, creating its folder if it is not there.
     *
     * @param file where to write
     * @throws IOException when it cannot be written
     */
    public void write(File file) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("could not create " + parent);
        }
        Writer out = new OutputStreamWriter(new FileOutputStream(file), "UTF-8");
        try {
            out.write(render());
        } finally {
            out.close();
        }
    }

    /** @return the trace as text; separate from {@link #write} so a test can assert on it without a file */
    public String render() {
        StringBuilder json = new StringBuilder();
        json.append("{\n");
        json.append("  \"formatVersion\": ").append(FORMAT_VERSION).append(",\n");
        json.append("  \"auto\": \"").append(autoName).append("\",\n");
        json.append("  \"simTimeS\": ").append(number(lastS)).append(",\n");
        json.append("  \"tickS\": ").append(number(tickS)).append(",\n");

        json.append("  \"capabilities\": [");
        boolean firstCapability = true;
        for (String capability : capabilities) {
            if (!firstCapability) {
                json.append(", ");
            }
            json.append('"').append(capability).append('"');
            firstCapability = false;
        }
        json.append("],\n");

        json.append("  \"steps\": [\n");
        for (int i = 0; i < steps.size(); i++) {
            StepRecord record = steps.get(i);
            json.append("    { \"id\": \"").append(escape(record.id)).append("\", \"startS\": ")
                    .append(number(record.startS)).append(", \"endS\": ")
                    .append(Double.isNaN(record.endS) ? number(lastS) : number(record.endS))
                    .append(", \"interrupted\": ").append(record.interrupted).append(" }")
                    .append(i == steps.size() - 1 ? "\n" : ",\n");
        }
        json.append("  ],\n");

        appendPoses(json, "poses", poses, true);
        appendPoses(json, "truthPoses", truthPoses, true);

        // Nothing in this sim build measures these yet; the capabilities list above is what says so.
        json.append("  \"structureContacts\": [],\n");
        json.append("  \"ledger\": [],\n");
        json.append("  \"events\": []\n");
        json.append("}\n");
        return json.toString();
    }

    private void appendPoses(StringBuilder json, String key, List<double[]> rows, boolean comma) {
        json.append("  \"").append(key).append("\": [");
        for (int i = 0; i < rows.size(); i++) {
            double[] row = rows.get(i);
            json.append(i == 0 ? "\n" : ",\n");
            json.append("    [").append(number(row[0])).append(", ").append(number(row[1]))
                    .append(", ").append(number(row[2])).append(", ").append(number(row[3]))
                    .append(']');
        }
        if (!rows.isEmpty()) {
            json.append("\n  ");
        }
        json.append(']').append(comma ? ",\n" : "\n");
    }

    /** Three decimals, always a dot, never an exponent, never a locale's comma. */
    private static String number(double value) {
        return String.format(Locale.ROOT, "%.3f", value);
    }

    private static String escape(String text) {
        return text.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static final class StepRecord {
        final String id;
        final double startS;
        double endS = Double.NaN;
        boolean interrupted;

        StepRecord(String id, double startS) {
            this.id = id;
            this.startS = startS;
        }
    }
}
