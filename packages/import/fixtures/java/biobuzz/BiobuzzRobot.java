package org.firstinspires.ftc.teamcode.zenith;

import static org.horizon36596.zenith.solverslib.NamedCommands.argEnum;

import com.seattlesolvers.solverslib.command.Command;
import com.seattlesolvers.solverslib.command.InstantCommand;
import java.util.Map;
import org.firstinspires.ftc.teamcode.commandbase.commands.CancelAll;
import org.firstinspires.ftc.teamcode.commandbase.commands.SetIntake;
import org.firstinspires.ftc.teamcode.commandbase.subsystems.Intake;
import org.horizon36596.zenith.Args;
import org.horizon36596.zenith.solverslib.AutoContext;
import org.horizon36596.zenith.solverslib.AutoFromFile;
import org.horizon36596.zenith.solverslib.NamedCommands;
import org.horizon36596.zenith.solverslib.ZenithRobot;

/**
 * BIOBUZZ-style registrations, written the several ways a team writes them: inline lambdas, a
 * block lambda, a method reference, an anonymous factory and a constant for the name.
 */
public class BiobuzzRobot implements ZenithRobot {
    /** The name the relocalize command is registered under. */
    public static final String RELOCALIZE = "relocalize";
    private static final String TIP_SEEN = "tipSeen";

    private Robot robot;

    @Override
    public void registerCommands(AutoFromFile opMode) {
        // shootAll(count) with a cadence, read as a string so the file's lower-case names match.
        NamedCommands.register(
                "shootAll",
                (args, ctx) -> {
                    int count = NamedCommands.argInt(args, "shootAll", "count");
                    String cadence = NamedCommands.argString(args, "shootAll", "cadence", "precise");
                    return cadence.equals("rapid") ? robot.shootAllFast(count) : robot.shootAll(count);
                });

        NamedCommands.register("setIntake", (args, ctx) -> new SetIntake(
                robot.intake,
                argEnum(args, "setIntake", "side", Intake.Side.class, null),
                Args.argEnum(args, "setIntake", "state", Intake.MotorState.class, Intake.MotorState.STOP)));

        NamedCommands.register("assumeTipped", (args, ctx) -> new InstantCommand(robot.hive::registerTip));
        NamedCommands.register("launcherIdle", this::launcherIdle);
        NamedCommands.register(RELOCALIZE, (args, ctx) -> robot.relocalize());
        NamedCommands.register("cancelAll", new NamedCommands.Factory() {
            @Override
            public Command build(Map<String, Object> args, AutoContext ctx) {
                return new CancelAll(robot);
            }
        });

        NamedCommands.registerCondition("hopperFull", robot.intake::isFull);
        NamedCommands.registerCondition("hopperEmpty", () -> robot.intake.columnEmpty());
        NamedCommands.registerCondition(TIP_SEEN, () -> false);
    }

    private Command launcherIdle(Map<String, Object> args, AutoContext ctx) {
        return new InstantCommand(robot.launcher::idle, robot.launcher);
    }
}
