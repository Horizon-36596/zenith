package com.acmerobotics.roadrunner;
// Stand-in for the Kotlin fun interface Action (Actions.kt). The real one declares
// boolean run(TelemetryPacket) and a default preview(Canvas), from FTC Dashboard core; the exporter
// calls neither, so they are left out here to keep FTC Dashboard off the stand-in classpath.
public interface Action {}
