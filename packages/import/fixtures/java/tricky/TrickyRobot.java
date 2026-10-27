package org.firstinspires.ftc.teamcode.zenith;

import java.util.Map;
import org.horizon36596.zenith.solverslib.AutoContext;
import org.horizon36596.zenith.solverslib.NamedCommands;

/** Registrations a scanner has to read carefully, or refuse to guess at. */
public class TrickyRobot {
    // NamedCommands.register("commentedOut", (args, ctx) -> null);
    /* NamedCommands.register("blockCommented", (args, ctx) -> null); */

    /** Not a registration: the text only mentions one. */
    private static final String HELP = "call NamedCommands.register(\"inAString\", ...) to add one";

    private static final String[] EXTRAS = {"extraOne", "extraTwo"};

    private final NamedCommands.Factory waitFactory = (args, ctx) ->
            new WaitFor(NamedCommands.argDouble(args, "waitFor", "seconds", 0.5));

    void registerCommands() {
        NamedCommands.register(Names.PARK, (args, ctx) -> park(args));
        NamedCommands.register(
                Names.DRIVE_FORWARD,
                (args, ctx) -> new DriveForward(
                        NamedCommands.argDouble(args, "driveForward", Names.KEY_DISTANCE),
                        NamedCommands.argDouble(args, "driveForward", "speed", Names.DEFAULT_SPEED)));
        NamedCommands.register("waitFor", waitFactory);
        NamedCommands.register("spin" + "Up", (args, ctx) -> spinUp(-1.5));
        NamedCommands.register("lift", (args, ctx) ->
                new Lift(NamedCommands.argInt(args, "lifter", "level")));
        NamedCommands.register("raw", (args, ctx) -> new Raw((Double) args.get("power")));
        NamedCommands.register("delegated", (args, ctx) -> new Delegated(args));
        NamedCommands.register("offset", (args, ctx) ->
                new Offset(NamedCommands.argDouble(args, "offset", "byIn", -2.5)));
        for (String name : EXTRAS) {
            NamedCommands.register(name, (args, ctx) -> new Extra(name));
        }
        registerTwice("twiceA");
        registerTwice("twiceB");
    }

    private void registerTwice(String name) {
        NamedCommands.register(name, (args, ctx) -> new Twice(NamedCommands.argString(args, name, "label")));
    }

    private Park park(Map<String, Object> args) {
        String where = NamedCommands.argString(args, Names.PARK, "zone");
        return new Park(where);
    }
}
