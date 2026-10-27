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

// Written against MeepMeep 0.1.7 and RoadRunner 1.0.1 (Zenith's ADR 0008, sections 3 and 4). On
// 2026-09-28 it was compiled, with no warnings, against MeepMeep 0.1.7, RoadRunner 1.0.1 and FTC
// Dashboard core 0.4.7 built from their source at their release tags, and a real MeepMeep bot's
// export matched the poses MeepMeep itself showed (README.md, "Status"). It has not yet been compiled
// against the jars published on maven.brott.dev. If it does not compile in your MeepMeep project,
// please open an issue with the error.

package org.horizon36596.zenith.meepmeep;

import com.acmerobotics.roadrunner.Action;
import com.acmerobotics.roadrunner.Pose2d;
import com.noahbres.meepmeep.roadrunner.entity.ActionEntityKt;
import com.noahbres.meepmeep.roadrunner.entity.ActionEvent;
import com.noahbres.meepmeep.roadrunner.entity.ActionStub;
import com.noahbres.meepmeep.roadrunner.entity.ActionTimeline;
import com.noahbres.meepmeep.roadrunner.entity.RoadRunnerBotEntity;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Writes a RoadRunner 1.0 trajectory, as MeepMeep runs it, to a Zenith interchange
 * {@code trajectory.json}, so a team that plans in MeepMeep can show its robot's path in Zenith's
 * alliance view.
 *
 * <p>Copy this one file into your MeepMeep module (the {@code MeepMeepTesting} module of the MeepMeep
 * README), change the package line if you like, and add one line after {@code runAction}:
 *
 * <pre>{@code
 * RoadRunnerBotEntity myBot = new DefaultBotBuilder(meepMeep)
 *         .setConstraints(60, 60, Math.toRadians(180), Math.toRadians(180), 15)
 *         .setDimensions(18, 18)
 *         .build();
 * myBot.runAction(myBot.getDrive().actionBuilder(new Pose2d(63, -40, Math.PI))
 *         .lineToX(33)
 *         .turn(Math.toRadians(90))
 *         .build());
 * ZenithTrajectoryExport.write(myBot, Paths.get("trajectory.json"),
 *         new ZenithTrajectoryExport.Options("biobuzz", "RED", 18, 18));
 * }</pre>
 *
 * <p>What it writes: the pose every 0.1 s from the start of the action to its end, in MeepMeep's own
 * coordinates (inches, radians, centre origin), with {@code "frame": { "preset": "roadrunner" }} so
 * Zenith converts them into the season's frame on import.
 *
 * <p>How a time maps to a pose is how MeepMeep draws the robot ({@code RoadRunnerBotEntity.update}):
 * MeepMeep's {@code actionTimeline} lays the action out in time (a {@code SequentialAction} one after
 * another, a {@code ParallelAction} together, a {@code SleepAction} for its {@code dt}, every other
 * action instantly), and at time t the robot is inside the trajectory or turn running then, or, in a gap,
 * at the start of the next one. The one difference: after the last trajectory or turn, MeepMeep shows
 * the robot at (0, 0) until the action ends, and this class holds the last pose instead.
 *
 * <p>Plain Java 8, like a MeepMeep module; no dependency beyond MeepMeep itself.
 */
public final class ZenithTrajectoryExport {

    /** Samples per second: the interchange guidelines ask for 10 Hz or better. */
    public static final double RATE_HZ = 10.0;

    /** The schema the file declares. */
    public static final String SCHEMA_ID = "https://libraries.horizon36596.org/zenith/schema/v1/trajectory.json";

    private ZenithTrajectoryExport() {}

    /** What the file says about the routine besides its poses. */
    public static final class Options {
        /** The season id of the field the routine was planned on, such as {@code "biobuzz"}. */
        public final String season;
        /** {@code "RED"} or {@code "BLUE"}: the alliance the routine was planned for. */
        public final String alliance;
        /** The robot's length along its heading, in inches: MeepMeep's {@code setDimensions} height. */
        public final double lengthIn;
        /** The robot's width side to side, in inches: MeepMeep's {@code setDimensions} width. */
        public final double widthIn;
        /** Optional: a title for the alliance view; null leaves it out. */
        public String title;
        /** Optional: where the robot size came from, in Zenith's provenance words; null leaves it out. */
        public String sizeProvenance;

        public Options(String season, String alliance, double lengthIn, double widthIn) {
            if (!"RED".equals(alliance) && !"BLUE".equals(alliance)) {
                throw new IllegalArgumentException("alliance must be RED or BLUE, not " + alliance);
            }
            if (!(lengthIn > 0) || !(widthIn > 0)) {
                throw new IllegalArgumentException("lengthIn and widthIn must be positive inches");
            }
            this.season = season;
            this.alliance = alliance;
            this.lengthIn = lengthIn;
            this.widthIn = widthIn;
        }
    }

    /** Writes the action the bot last ran with {@code runAction}. */
    public static void write(RoadRunnerBotEntity bot, Path file, Options options) throws IOException {
        ActionTimeline timeline = bot.getCurrentActionTimeline();
        if (timeline == null) {
            throw new IllegalStateException("The bot has no action: call runAction before exporting.");
        }
        write(timeline, file, options);
    }

    /** Writes an action built with {@code actionBuilder(...).build()}, laid out the way MeepMeep lays it out. */
    public static void write(Action action, Path file, Options options) throws IOException {
        write(ActionEntityKt.actionTimeline(action), file, options);
    }

    /** Writes a timeline MeepMeep has already laid out. */
    public static void write(ActionTimeline timeline, Path file, Options options) throws IOException {
        Files.write(file, toJson(timeline, options).getBytes(StandardCharsets.UTF_8));
    }

    /**
     * The poses at 0, 0.1, 0.2 s and so on, each {@code {x, y, heading}} in inches and radians. The
     * last sample is at the end of the action or up to 0.1 s after it, holding the final pose, so the
     * file never stops short of where the robot ends.
     */
    public static List<double[]> sample(ActionTimeline timeline) {
        List<ActionEvent> events = timeline.getEvents();
        if (events.isEmpty()) {
            throw new IllegalStateException("The action has no trajectory and no turn, so there is no path to export.");
        }
        double duration = timeline.getDuration();
        int count = (int) Math.ceil(duration * RATE_HZ - 1e-9) + 1;
        List<double[]> poses = new ArrayList<>(count);
        for (int k = 0; k < count; k++) {
            double t = Math.min(k / RATE_HZ, duration);
            Pose2d pose = poseAt(events, t);
            poses.add(new double[] {pose.position.x, pose.position.y, pose.heading.toDouble()});
        }
        return poses;
    }

    /** Where the robot is at time t, seconds from the start of the action. */
    static Pose2d poseAt(List<ActionEvent> events, double t) {
        for (ActionEvent event : events) {
            ActionStub stub = event.getA();
            if (event.getTime() > t) {
                return stub.get(0.0);
            }
            double offset = t - event.getTime();
            if (offset < stub.getDuration()) {
                return stub.get(offset);
            }
        }
        ActionStub last = events.get(events.size() - 1).getA();
        return last.get(last.getDuration());
    }

    /** The whole file, as text. */
    public static String toJson(ActionTimeline timeline, Options options) {
        List<double[]> poses = sample(timeline);
        StringBuilder out = new StringBuilder();
        out.append("{\n");
        out.append("  \"$schema\": ").append(quote(SCHEMA_ID)).append(",\n");
        out.append("  \"formatVersion\": 1,\n");
        out.append("  \"kind\": \"trajectory\",\n");
        out.append("  \"season\": ").append(quote(options.season)).append(",\n");
        out.append("  \"alliance\": ").append(quote(options.alliance)).append(",\n");
        if (options.title != null) {
            out.append("  \"title\": ").append(quote(options.title)).append(",\n");
        }
        out.append("  \"source\": { \"planner\": \"MeepMeep 0.1.7 with RoadRunner 1.0\", \"exporter\": \"ZenithTrajectoryExport 1\" },\n");
        out.append("  \"frame\": { \"preset\": \"roadrunner\" },\n");
        out.append("  \"rateHz\": ").append(number(RATE_HZ, 1)).append(",\n");
        out.append("  \"poses\": [\n");
        for (int i = 0; i < poses.size(); i++) {
            double[] p = poses.get(i);
            out.append("    [").append(number(p[0], 4)).append(", ").append(number(p[1], 4)).append(", ")
                    .append(number(p[2], 6)).append("]").append(i + 1 < poses.size() ? ",\n" : "\n");
        }
        out.append("  ],\n");
        out.append("  \"boundingBox\": { \"lengthIn\": ").append(number(options.lengthIn, 4))
                .append(", \"widthIn\": ").append(number(options.widthIn, 4));
        if (options.sizeProvenance != null) {
            out.append(", \"provenance\": ").append(quote(options.sizeProvenance));
        }
        out.append(" }\n");
        out.append("}\n");
        return out.toString();
    }

    private static String number(double value, int decimals) {
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            throw new IllegalArgumentException("A pose held " + value + "; the trajectory cannot be written.");
        }
        String text = String.format(Locale.ROOT, "%." + decimals + "f", value);
        if (text.startsWith("-") && Double.parseDouble(text) == 0.0) {
            text = text.substring(1);
        }
        return text;
    }

    private static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') {
                out.append('\\').append(c);
            } else if (c < 0x20) {
                out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
            } else {
                out.append(c);
            }
        }
        return out.append('"').toString();
    }
}
