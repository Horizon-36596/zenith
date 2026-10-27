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
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
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
 * <h2>Contacts, the ledger and events</h2>
 * A sim that models more than the drive records it too, each at the time of the last {@link #tick}:
 *
 * <pre>{@code
 * trace.capability(AutoTrace.STRUCTURE_CONTACTS);   // once, before the run: this sim checks contacts
 * trace.capability(AutoTrace.LEDGER);               // and counts game pieces
 * ...each tick...
 * trace.structureContact("hiveRedPivotBar", 1.3);   // the chassis overlaps a structure by 1.3 in
 * trace.ledger().held(1).launches(3).tips("RED", 0); // the robot's game state changed
 * trace.event("tipStarted", "RED");                 // something worth a mark on the timeline
 * }</pre>
 *
 * <h2>capabilities</h2>
 * The {@code capabilities} list names what this trace actually carries, so a report can say "no
 * structure contacts were checked" rather than "no structure contacts happened". Those are different
 * sentences, and until a sim measures contacts, spills or retrievals, the corresponding sections of a
 * trace are empty because nothing measures them.
 *
 * <p>Recording a contact, a ledger row or an event adds its capability, but a clean run records no
 * contacts at all, so a sim that checks them declares {@link #STRUCTURE_CONTACTS} with
 * {@link #capability} before the run; otherwise a run with no contacts reads as one where nothing
 * looked. The same goes for {@link #LEDGER}.
 *
 * <h2>Determinism</h2>
 * Numbers are formatted with {@link Locale#ROOT} to three decimals, so two runs of the same scenario
 * produce byte-identical files and a diff of two traces is a diff of two runs.
 */
public class AutoTrace {

    /** The trace format this writer emits. */
    public static final int FORMAT_VERSION = 1;

    /** The capability that says this sim checks the chassis against the field's structures. */
    public static final String STRUCTURE_CONTACTS = "structureContacts";

    /** The capability that says this sim counts the game pieces the robot holds, launches and tips. */
    public static final String LEDGER = "ledger";

    /** The capability that says this sim records game events, such as a tip starting. */
    public static final String EVENTS = "events";

    private final String autoName;
    private final double tickS;

    private final List<double[]> poses = new ArrayList<double[]>();
    private final List<double[]> truthPoses = new ArrayList<double[]>();
    private final List<StepRecord> steps = new ArrayList<StepRecord>();
    private final List<ContactRecord> contacts = new ArrayList<ContactRecord>();
    private final List<LedgerRow> ledger = new ArrayList<LedgerRow>();
    private final List<EventRecord> events = new ArrayList<EventRecord>();
    private final Set<String> capabilities = new LinkedHashSet<String>();

    private String sha;
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
     * The commit the sim ran, written into the trace as {@code sha}. Left unset, the trace has no
     * {@code sha} and Zenith reads it as unknown.
     *
     * @param commit the commit, as the test knows it, such as {@code git rev-parse HEAD}
     */
    public void sha(String commit) {
        sha = commit;
    }

    /**
     * Record that the chassis touched a field structure, at the time of the last {@link #tick}. Record
     * one per tick of overlap, or one per touch; a report counts the entries.
     *
     * @param obstacle      the structure's name, as the sim's field model calls it
     * @param penetrationIn how far the chassis overlaps it, inches
     */
    public void structureContact(String obstacle, double penetrationIn) {
        capabilities.add(STRUCTURE_CONTACTS);
        contacts.add(new ContactRecord(nowS, obstacle, penetrationIn));
    }

    /**
     * Start a ledger row at the time of the last {@link #tick}: the robot's game state when it changed.
     * Fill in what changed on the row this returns; a value left unset is left out of the row.
     *
     * @return the new row
     */
    public LedgerRow ledger() {
        capabilities.add(LEDGER);
        LedgerRow row = new LedgerRow(nowS);
        ledger.add(row);
        return row;
    }

    /**
     * Record a game event, at the time of the last {@link #tick}.
     *
     * @param kind what happened, such as {@code tipStarted}
     */
    public void event(String kind) {
        event(kind, null);
    }

    /**
     * Record a game event that belongs to one alliance, at the time of the last {@link #tick}.
     *
     * @param kind     what happened, such as {@code tipStarted}
     * @param alliance the alliance it happened to, such as {@code RED}, or null for none
     */
    public void event(String kind, String alliance) {
        capabilities.add(EVENTS);
        events.add(new EventRecord(nowS, kind, alliance));
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
        if (sha != null) {
            json.append("  \"sha\": \"").append(escape(sha)).append("\",\n");
        }
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

        // Empty when the sim measures none of these; the capabilities list above is what tells an empty
        // section that was checked from one nobody measured.
        json.append("  \"structureContacts\": [");
        for (int i = 0; i < contacts.size(); i++) {
            ContactRecord contact = contacts.get(i);
            json.append(i == 0 ? "\n" : ",\n");
            json.append("    { \"timeS\": ").append(number(contact.timeS))
                    .append(", \"obstacle\": \"").append(escape(contact.obstacle))
                    .append("\", \"penetrationIn\": ").append(number(contact.penetrationIn)).append(" }");
        }
        closeList(json, !contacts.isEmpty(), true);

        json.append("  \"ledger\": [");
        for (int i = 0; i < ledger.size(); i++) {
            json.append(i == 0 ? "\n" : ",\n");
            ledger.get(i).appendTo(json);
        }
        closeList(json, !ledger.isEmpty(), true);

        json.append("  \"events\": [");
        for (int i = 0; i < events.size(); i++) {
            EventRecord event = events.get(i);
            json.append(i == 0 ? "\n" : ",\n");
            json.append("    { \"timeS\": ").append(number(event.timeS))
                    .append(", \"kind\": \"").append(escape(event.kind)).append('"');
            if (event.alliance != null) {
                json.append(", \"alliance\": \"").append(escape(event.alliance)).append('"');
            }
            json.append(" }");
        }
        closeList(json, !events.isEmpty(), false);

        json.append("}\n");
        return json.toString();
    }

    private static void closeList(StringBuilder json, boolean hasRows, boolean comma) {
        if (hasRows) {
            json.append("\n  ");
        }
        json.append(']').append(comma ? ",\n" : "\n");
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
        closeList(json, !rows.isEmpty(), comma);
    }

    /** Three decimals, always a dot, never an exponent, never a locale's comma. */
    private static String number(double value) {
        return String.format(Locale.ROOT, "%.3f", value);
    }

    private static String escape(String text) {
        StringBuilder out = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\\' || c == '"') {
                out.append('\\').append(c);
            } else if (c < 0x20) {
                out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    /**
     * One row of the ledger: the robot's game state at one moment. Every value is optional; one left
     * unset is left out of the row, and Zenith reads it as not reported rather than zero.
     */
    public static final class LedgerRow {
        final double timeS;
        private Integer held;
        private Integer launches;
        private final Map<String, Integer> tips = new LinkedHashMap<String, Integer>();

        LedgerRow(double timeS) {
            this.timeS = timeS;
        }

        /**
         * @param count how many game pieces the robot holds now
         * @return this row
         */
        public LedgerRow held(int count) {
            held = count;
            return this;
        }

        /**
         * @param count how many game pieces the robot launched since the previous row; a report adds
         *              these up over the run
         * @return this row
         */
        public LedgerRow launches(int count) {
            launches = count;
            return this;
        }

        /**
         * @param alliance the alliance, such as {@code RED}
         * @param count    how many tips that alliance has achieved so far in the run; a report reads
         *                 the latest row that names the alliance
         * @return this row
         */
        public LedgerRow tips(String alliance, int count) {
            tips.put(alliance, count);
            return this;
        }

        void appendTo(StringBuilder json) {
            json.append("    { \"timeS\": ").append(number(timeS));
            if (held != null) {
                json.append(", \"held\": ").append(held.intValue());
            }
            if (launches != null) {
                json.append(", \"launches\": ").append(launches.intValue());
            }
            if (!tips.isEmpty()) {
                json.append(", \"tips\": {");
                boolean first = true;
                for (Map.Entry<String, Integer> tip : tips.entrySet()) {
                    json.append(first ? " \"" : ", \"").append(escape(tip.getKey())).append("\": ")
                            .append(tip.getValue().intValue());
                    first = false;
                }
                json.append(" }");
            }
            json.append(" }");
        }
    }

    private static final class ContactRecord {
        final double timeS;
        final String obstacle;
        final double penetrationIn;

        ContactRecord(double timeS, String obstacle, double penetrationIn) {
            this.timeS = timeS;
            this.obstacle = obstacle;
            this.penetrationIn = penetrationIn;
        }
    }

    private static final class EventRecord {
        final double timeS;
        final String kind;
        final String alliance;

        EventRecord(double timeS, String kind, String alliance) {
            this.timeS = timeS;
            this.kind = kind;
            this.alliance = alliance;
        }
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
