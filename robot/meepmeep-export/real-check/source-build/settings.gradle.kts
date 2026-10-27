// Builds FTC Dashboard core 0.4.7, RoadRunner core and actions 1.0.1, and MeepMeep 0.1.7 from their
// public sources at their release tags, and publishes them under their real Maven coordinates to a
// local repository, for an environment that cannot reach maven.brott.dev. See ../../README.md, "Status".
//
//   gradle -p source-build publish -Psources=<dir> -Prepo=<dir>
//
// <dir> for sources holds three clones: dash (acmerobotics/ftc-dashboard at v0.4.7), rr
// (acmerobotics/road-runner at v1.0.1) and mm (acmerobotics/MeepMeep at v0.1.7). A build from
// source at a tag is not the jar the project published; it has the same sources and coordinates.
// -PcentralMirror=<url> puts a Maven Central mirror ahead of Maven Central, for when Central answers 429.
pluginManagement {
    repositories {
        gradlePluginPortal()
        providers.gradleProperty("centralMirror").orNull?.let { maven { url = uri(it) } }
        mavenCentral()
    }
}
rootProject.name = "meepmeep-source-build"
include("dashcore", "rrcore", "rractions", "meepmeep")
// The projects have no files of their own: their sources are the clones. Give each an empty directory.
for (name in listOf("dashcore", "rrcore", "rractions", "meepmeep")) {
    val dir = file("build/projects/$name")
    dir.mkdirs()
    project(":$name").projectDir = dir
}
