package com.noahbres.meepmeep.roadrunner.entity;
import java.util.List;
// Stand-in: data class ActionTimeline(val duration: Double, val events: List<ActionEvent>)
public final class ActionTimeline { private final double duration; private final List<ActionEvent> events;
  public ActionTimeline(double duration, List<ActionEvent> events) { this.duration = duration; this.events = events; }
  public double getDuration() { return duration; } public List<ActionEvent> getEvents() { return events; } }
