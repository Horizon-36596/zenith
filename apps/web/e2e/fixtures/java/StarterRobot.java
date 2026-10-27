package org.firstinspires.ftc.teamcode.zenith;

import org.horizon36596.zenith.solverslib.NamedCommands;

/** The starter example's registrations, plus one command its robot.json does not have yet. */
public class StarterRobot {
    void registerCommands() {
        NamedCommands.register("intakeOn", (args, ctx) -> intake.on());
        NamedCommands.register("intakeOff", (args, ctx) -> intake.off());
        NamedCommands.register("spinUp", (args, ctx) -> launcher.spinUp());
        NamedCommands.register("score", (args, ctx) -> score(NamedCommands.argDouble(args, "score", "count", 1)));
        NamedCommands.register("wiggle", (args, ctx) -> wiggle(NamedCommands.argDouble(args, "wiggle", "seconds", 0.5)));
        NamedCommands.registerCondition("holdingPiece", intake::hasPiece);
        NamedCommands.registerCondition("hopperFull", intake::isFull);
        NamedCommands.registerCondition("hopperEmpty", intake::isEmpty);
    }
}
