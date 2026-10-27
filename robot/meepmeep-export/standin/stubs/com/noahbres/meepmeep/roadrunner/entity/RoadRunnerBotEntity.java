package com.noahbres.meepmeep.roadrunner.entity;
// Stand-in: var currentActionTimeline: ActionTimeline?. The real class is built by DefaultBotBuilder
// and has no no-argument constructor; the harness uses this one to hold a stand-in timeline.
public class RoadRunnerBotEntity { private ActionTimeline t; public ActionTimeline getCurrentActionTimeline() { return t; } public void setCurrentActionTimeline(ActionTimeline t) { this.t = t; } }
