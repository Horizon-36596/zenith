package com.noahbres.meepmeep.roadrunner.entity;
import com.acmerobotics.roadrunner.Pose2d;
// Stand-in: sealed interface ActionStub { val duration: Double; operator fun get(t: Double): Pose2d }.
// On the JVM (jvmTarget 1.8) it is a plain interface with exactly these two methods.
public interface ActionStub { double getDuration(); Pose2d get(double t); }
