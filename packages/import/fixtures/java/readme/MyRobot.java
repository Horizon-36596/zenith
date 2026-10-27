package org.firstinspires.ftc.teamcode.zenith;

import com.seattlesolvers.solverslib.command.InstantCommand;
import org.horizon36596.zenith.solverslib.AutoFromFile;
import org.horizon36596.zenith.solverslib.NamedCommands;
import org.horizon36596.zenith.solverslib.ZenithRobot;

/** The registration example from robot/README.md, as a team would write it. */
public class MyRobot implements ZenithRobot {
    private Intake intake;

    @Override public void init(AutoFromFile opMode) {
        intake = new Intake(opMode.hardwareMap);
    }

    @Override public void registerCommands(AutoFromFile opMode) {
        NamedCommands.register("intakeOn", (args, ctx) -> new InstantCommand(intake::on, intake));
        NamedCommands.register("score", (args, ctx) ->
                new ScoreCommand(NamedCommands.argInt(args, "score", "count")));
        NamedCommands.registerCondition("holdingPiece", intake::hasPiece);
    }
}
