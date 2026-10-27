import com.acmerobotics.roadrunner.Pose2d;
import com.noahbres.meepmeep.roadrunner.entity.*;
import org.horizon36596.zenith.meepmeep.ZenithTrajectoryExport;
import java.nio.file.Paths;
import java.util.Arrays;

// A stand-in timeline shaped like lineToX(33) from (63, -40, pi), a 0.5 s wait, then turn(pi / 2):
// the line runs a triangular profile (30 in at 30 in/s^2, 2 s), the turn a trapezoid (pi/2 at
// pi/3 rad/s and pi/3 rad/s^2, 2.5 s).
public class Harness {
  static double lineS(double t) { return t <= 1 ? 15 * t * t : 30 - 15 * (2 - t) * (2 - t); }
  static double turnA(double t) {
    double a = Math.PI / 3, v = Math.PI / 3;
    if (t <= 1) return 0.5 * a * t * t;
    if (t <= 1.5) return Math.PI / 6 + v * (t - 1);
    double r = 2.5 - t; return Math.PI / 2 - 0.5 * a * r * r;
  }
  public static void main(String[] args) throws Exception {
    ActionStub line = new ActionStub() {
      public double getDuration() { return 2.0; }
      public Pose2d get(double t) { return new Pose2d(63 - lineS(Math.min(Math.max(t, 0), 2)), -40, Math.PI); }
    };
    ActionStub turn = new ActionStub() {
      public double getDuration() { return 2.5; }
      public Pose2d get(double t) { return new Pose2d(33, -40, Math.PI + turnA(Math.min(Math.max(t, 0), 2.5))); }
    };
    ActionTimeline timeline = new ActionTimeline(5.0, Arrays.asList(new ActionEvent(0, line), new ActionEvent(2.5, turn)));
    RoadRunnerBotEntity bot = new RoadRunnerBotEntity();
    bot.setCurrentActionTimeline(timeline);
    ZenithTrajectoryExport.Options options = new ZenithTrajectoryExport.Options("biobuzz", "RED", 18, 18);
    options.title = "MeepMeep line and turn";
    options.sizeProvenance = "SET BY HAND: MeepMeep setDimensions(18, 18)";
    ZenithTrajectoryExport.write(bot, Paths.get(args[0]), options);
  }
}
