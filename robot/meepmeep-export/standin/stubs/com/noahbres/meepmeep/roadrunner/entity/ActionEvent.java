package com.noahbres.meepmeep.roadrunner.entity;
// Stand-in: data class ActionEvent(val time: Double, val a: ActionStub)
public final class ActionEvent { private final double time; private final ActionStub a;
  public ActionEvent(double time, ActionStub a) { this.time = time; this.a = a; }
  public double getTime() { return time; } public ActionStub getA() { return a; } }
