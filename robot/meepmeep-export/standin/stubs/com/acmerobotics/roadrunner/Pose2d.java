package com.acmerobotics.roadrunner;
// Stand-in: data class Pose2d(@JvmField val position: Vector2d, @JvmField val heading: Rotation2d)
public final class Pose2d {
  public final Vector2d position; public final Rotation2d heading;
  public Pose2d(Vector2d position, Rotation2d heading) { this.position = position; this.heading = heading; }
  public Pose2d(Vector2d position, double heading) { this(position, Rotation2d.exp(heading)); }
  public Pose2d(double x, double y, double heading) { this(new Vector2d(x, y), Rotation2d.exp(heading)); }
}
