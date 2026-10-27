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

package org.horizon36596.zenith.meepmeep.check;

import com.acmerobotics.roadrunner.Action;
import com.acmerobotics.roadrunner.Pose2d;
import com.acmerobotics.roadrunner.Vector2d;
import com.noahbres.meepmeep.MeepMeep;
import com.noahbres.meepmeep.roadrunner.DefaultBotBuilder;
import com.noahbres.meepmeep.roadrunner.entity.ActionEvent;
import com.noahbres.meepmeep.roadrunner.entity.ActionTimeline;
import com.noahbres.meepmeep.roadrunner.entity.RoadRunnerBotEntity;
import org.horizon36596.zenith.meepmeep.ZenithTrajectoryExport;

import javax.imageio.ImageIO;
import java.awt.Rectangle;
import java.awt.Robot;
import java.awt.Toolkit;
import java.io.File;
import java.io.PrintWriter;
import java.nio.file.Paths;
import java.util.List;
import java.util.Locale;

/**
 * Runs a real MeepMeep bot through a line, a wait, a spline and a turn, exports it with
 * {@link ZenithTrajectoryExport}, and writes beside the export the pose MeepMeep itself gives the robot
 * at every 0.1 s ({@code RoadRunnerBotEntity.update}, the pose it draws), so the two can be compared.
 * With a display it also opens the MeepMeep window and saves a screenshot at a few times.
 *
 * <p>Usage: {@code ExportCheck <output directory> [--screenshots]}.
 */
public final class ExportCheck {

    private ExportCheck() {}

    public static void main(String[] args) throws Exception {
        File out = new File(args.length > 0 ? args[0] : ".");
        boolean screenshots = args.length > 1 && "--screenshots".equals(args[1]);
        if (!out.isDirectory() && !out.mkdirs()) {
            throw new IllegalStateException("Cannot create " + out);
        }
        MeepMeep meepMeep = new MeepMeep(800);

        RoadRunnerBotEntity myBot = new DefaultBotBuilder(meepMeep)
                .setConstraints(60, 60, Math.toRadians(180), Math.toRadians(180), 15)
                .setDimensions(18, 18)
                .build();
        Action action = myBot.getDrive().actionBuilder(new Pose2d(63, -40, Math.PI))
                .lineToX(45)
                .waitSeconds(0.5)
                .splineTo(new Vector2d(36, 0), Math.PI / 2)
                .turn(Math.toRadians(90))
                .build();
        myBot.runAction(action);

        ZenithTrajectoryExport.Options options = new ZenithTrajectoryExport.Options("biobuzz", "RED", 18, 18);
        options.title = "MeepMeep line, wait, spline and turn";
        options.sizeProvenance = "SET BY HAND: MeepMeep setDimensions(18, 18)";
        ZenithTrajectoryExport.write(myBot, Paths.get(out.getPath(), "trajectory.json"), options);
        // The same action through the Action overload, which lays it out with MeepMeep's actionTimeline.
        ZenithTrajectoryExport.write(action, Paths.get(out.getPath(), "trajectory-from-action.json"), options);

        ActionTimeline timeline = myBot.getCurrentActionTimeline();
        System.out.printf(Locale.ROOT, "timeline: %.6f s%n", timeline.getDuration());
        for (ActionEvent event : timeline.getEvents()) {
            System.out.printf(Locale.ROOT, "  at %.6f s: %s for %.6f s%n", event.getTime(),
                    event.getA().getClass().getSimpleName(), event.getA().getDuration());
        }

        // What MeepMeep itself shows, from its own update, at the times the exporter samples.
        myBot.start();
        myBot.pause();
        try (PrintWriter w = new PrintWriter(new File(out, "meepmeep-poses.csv"), "UTF-8")) {
            w.println("t,x,y,heading");
            int count = (int) Math.ceil(timeline.getDuration() * ZenithTrajectoryExport.RATE_HZ - 1e-9) + 1;
            for (int k = 0; k < count; k++) {
                double t = Math.min(k / ZenithTrajectoryExport.RATE_HZ, timeline.getDuration());
                myBot.setTrajectoryProgressSeconds(t);
                myBot.update(0L);
                Pose2d p = myBot.getPose();
                w.printf(Locale.ROOT, "%.3f,%.9f,%.9f,%.9f%n", t, p.position.x, p.position.y, p.heading.toDouble());
            }
        }

        // A trailing wait: MeepMeep shows (0, 0, 0) after the last trajectory; the exporter holds the last pose.
        RoadRunnerBotEntity tailBot = new DefaultBotBuilder(meepMeep)
                .setConstraints(60, 60, Math.toRadians(180), Math.toRadians(180), 15)
                .build();
        tailBot.runAction(tailBot.getDrive().actionBuilder(new Pose2d(0, 0, 0)).lineToX(10).waitSeconds(1).build());
        tailBot.start();
        tailBot.pause();
        tailBot.setTrajectoryProgressSeconds(tailBot.getCurrentActionTimeline().getDuration() - 0.2);
        tailBot.update(0L);
        List<double[]> tail = ZenithTrajectoryExport.sample(tailBot.getCurrentActionTimeline());
        double[] last = tail.get(tail.size() - 1);
        System.out.printf(Locale.ROOT, "trailing wait: MeepMeep shows %s; the exporter holds (%.3f, %.3f, %.4f)%n",
                tailBot.getPose(), last[0], last[1], last[2]);

        if (screenshots) {
            meepMeep.setBackground(MeepMeep.Background.GRID_GRAY)
                    .setDarkMode(false)
                    .setBackgroundAlpha(0.95f)
                    .addEntity(myBot)
                    .start();
            myBot.pause();
            Robot robot = new Robot();
            Rectangle screen = new Rectangle(Toolkit.getDefaultToolkit().getScreenSize());
            double[] times = {0.0, 1.0, 2.3, 3.4, timeline.getDuration() - 0.05};
            for (double t : times) {
                myBot.setTrajectoryProgressSeconds(t);
                Thread.sleep(1500);
                Pose2d p = myBot.getPose();
                System.out.printf(Locale.ROOT, "screenshot at %.2f s: (%.3f, %.3f, %.4f)%n", t, p.position.x, p.position.y, p.heading.toDouble());
                ImageIO.write(robot.createScreenCapture(screen), "png",
                        new File(out, String.format(Locale.ROOT, "meepmeep-%.2fs.png", t)));
            }
        }
        System.exit(0);
    }
}
