package org.firstinspires.ftc.teamcode.commandbase.subsystems;

/** Two roller intakes, front and back. Only the parts the scanner reads are here. */
public class Intake {
    /** Which intake a command drives. */
    public enum Side {
        FRONT,
        BACK,
        BOTH
    }

    /** What the rollers do. */
    public enum MotorState {
        STOP(0.0),
        FORWARD(1.0),
        REVERSE(-1.0);

        public final double power;

        MotorState(double power) {
            this.power = power;
        }
    }

    public boolean isFull() {
        return false;
    }

    public boolean columnEmpty() {
        return true;
    }
}
