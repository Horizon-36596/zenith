package com.acmerobotics.roadrunner;
// Stand-in: data class Rotation2d(@JvmField val real: Double, @JvmField val imag: Double), fun log() = atan2(imag, real), fun toDouble() = log()
public final class Rotation2d {
  public final double real; public final double imag;
  public Rotation2d(double real, double imag) { this.real = real; this.imag = imag; }
  public static Rotation2d exp(double theta) { return new Rotation2d(Math.cos(theta), Math.sin(theta)); }
  public double log() { return Math.atan2(imag, real); }
  public double toDouble() { return log(); }
}
