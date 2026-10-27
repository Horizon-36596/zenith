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

import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Where a path's speed comes from on the robot, and how a runtime notices that nothing applies it.
 *
 * <p>A path step's {@code speedFraction} changes the editor's times, but the robot only drives at it
 * when the team's {@code ZenithRobot} implements {@code atSpeed}: the runtime's {@code FollowPath} hands
 * the fraction to {@code atSpeed(path, fraction)} and the default returns the path unchanged. This class
 * is the one place both runtimes share for the two things that keep that from being silent:
 *
 * <ul>
 *   <li>{@link #defaultFromRobotFile}: the fraction a path with none of its own uses, read from the
 *       deployed {@code robot.json}'s {@code kinematics.defaultPathSpeedFraction}, so the robot and the
 *       editor start from the same number;</li>
 *   <li>{@link #unappliedWarning}: the init warning naming each path step that would drive below full
 *       speed with no {@code atSpeed} to apply it.</li>
 * </ul>
 *
 * <p>Nothing here reads a clock or anything else that changes between runs.
 */
public final class PathSpeeds {

    /** The robot file {@code zenith deploy} copies next to the auto files. */
    public static final String ROBOT_FILE = "robot.json";

    /** What a path drives at when nothing says otherwise: full speed, which is what the follower does. */
    public static final double FALLBACK = 1.0;

    /** How many steps a warning names before it says "and N more", to keep a Driver Station line short. */
    static final int NAMED_STEPS = 4;

    private PathSpeeds() {
    }

    /**
     * Read {@code kinematics.defaultPathSpeedFraction} from {@code robot.json} in {@code source}.
     *
     * <p>When the file is not there, cannot be read, has no such number or the number is not over 0 and
     * at most 1, the result is {@link #FALLBACK} and a message saying why is added to {@code warnings}.
     * It never throws, because a robot whose speed default could not be read still has to start.
     *
     * @param source   where the auto files are, the same source the auto itself was read from
     * @param warnings receives one message when the fallback is used
     * @return the fraction, over 0 and at most 1
     */
    public static double defaultFromRobotFile(AutoSource source, List<String> warnings) {
        String fallback = "; a path with no speed of its own drives at " + FALLBACK
                + ". Run zenith deploy, or set defaultSpeedFraction() in your ZenithRobot.";
        InputStream stream;
        try {
            stream = source.open(ROBOT_FILE);
        } catch (FileNotFoundException absent) {
            warnings.add(ROBOT_FILE + " is not in " + source.describe() + fallback);
            return FALLBACK;
        } catch (IOException problem) {
            warnings.add(ROBOT_FILE + " could not be read from " + source.describe() + " ("
                    + problem.getMessage() + ")" + fallback);
            return FALLBACK;
        }
        try {
            Json root = Json.parse(stream, ROBOT_FILE);
            Json kinematics = root.opt("kinematics");
            Json entry = kinematics == null ? null : kinematics.opt("defaultPathSpeedFraction");
            // The file wraps every constant as { "value": ..., "provenance": ... }.
            Json value = entry == null ? null : entry.opt("value");
            if (value == null) {
                warnings.add(ROBOT_FILE + " has no kinematics.defaultPathSpeedFraction" + fallback);
                return FALLBACK;
            }
            double fraction = value.num();
            if (!(fraction > 0.0 && fraction <= 1.0)) {
                warnings.add(ROBOT_FILE + ": kinematics.defaultPathSpeedFraction is " + fraction
                        + ", which is not over 0 and at most 1" + fallback);
                return FALLBACK;
            }
            return fraction;
        } catch (IOException unreadable) {
            warnings.add(ROBOT_FILE + " in " + source.describe() + " could not be read ("
                    + unreadable.getMessage() + ")" + fallback);
            return FALLBACK;
        } catch (RuntimeException malformed) {
            warnings.add(ROBOT_FILE + " in " + source.describe() + " could not be read ("
                    + malformed.getMessage() + ")" + fallback);
            return FALLBACK;
        } finally {
            try {
                stream.close();
            } catch (IOException ignored) {
                // Nothing left to read; the number is already in hand.
            }
        }
    }

    /**
     * Whether {@code robot}'s class replaces {@code method} of {@code library}, the runtime's
     * {@code ZenithRobot}, or leaves the interface's default.
     *
     * @param robot      the team's robot
     * @param library    the runtime's {@code ZenithRobot} interface
     * @param method     the method name
     * @param parameters the method's parameter types
     * @return true when the robot's class (or a class it extends) declares its own
     */
    public static boolean overrides(Object robot, Class<?> library, String method, Class<?>... parameters) {
        try {
            Method found = robot.getClass().getMethod(method, parameters);
            return found.getDeclaringClass() != library;
        } catch (NoSuchMethodException missing) {
            return false;
        }
    }

    /**
     * The init warning for a routine whose speeds nothing on the robot applies, or {@code null} when
     * there is nothing to say.
     *
     * <p>A path step is named when the fraction it resolves to, its own or {@code defaultFraction},
     * is below 1. At 1 the follower already drives at full speed, so no cap is missing.
     *
     * @param steps           the routine
     * @param defaultFraction the fraction a step with none of its own uses
     * @return the message, or null
     */
    public static String unappliedWarning(List<AutoFile.Step> steps, double defaultFraction) {
        List<String> named = new ArrayList<String>();
        collect(steps, defaultFraction, named);
        if (named.isEmpty()) {
            return null;
        }
        StringBuilder list = new StringBuilder();
        for (int i = 0; i < named.size() && i < NAMED_STEPS; i++) {
            list.append(i == 0 ? "" : ", ").append(named.get(i));
        }
        if (named.size() > NAMED_STEPS) {
            list.append(", and ").append(named.size() - NAMED_STEPS).append(" more");
        }
        boolean one = named.size() == 1;
        return "path speed is not applied: " + (one ? "step " : "steps ") + list
                + (one ? " is" : " are") + " set below full speed, but this robot's atSpeed() is still"
                + " the default, so the robot drives at full speed while the editor times the path at"
                + " that speed. Implement atSpeed() in your ZenithRobot to apply it.";
    }

    private static void collect(List<AutoFile.Step> steps, double defaultFraction, List<String> out) {
        for (AutoFile.Step step : steps) {
            if (step instanceof AutoFile.PathStep) {
                Double own = ((AutoFile.PathStep) step).speedFraction;
                double fraction = own != null ? own.doubleValue() : defaultFraction;
                if (fraction < 1.0) {
                    out.add("\"" + step.id + "\" (" + shown(fraction) + ")");
                }
            } else if (step instanceof AutoFile.ParallelStep) {
                collect(((AutoFile.ParallelStep) step).steps, defaultFraction, out);
            } else if (step instanceof AutoFile.SequenceStep) {
                collect(((AutoFile.SequenceStep) step).steps, defaultFraction, out);
            } else if (step instanceof AutoFile.BranchStep) {
                collect(((AutoFile.BranchStep) step).then, defaultFraction, out);
                collect(((AutoFile.BranchStep) step).otherwise, defaultFraction, out);
            }
        }
    }

    /** {@code 0.3} not {@code 0.30000000000000004}: two decimals, a trailing zero dropped. */
    private static String shown(double fraction) {
        String text = String.format(Locale.ROOT, "%.2f", fraction);
        return text.endsWith("0") ? text.substring(0, text.length() - 1) : text;
    }
}
