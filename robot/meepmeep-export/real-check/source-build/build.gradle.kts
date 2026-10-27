import org.jetbrains.kotlin.gradle.dsl.KotlinJvmProjectExtension
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

// The Kotlin plugin version all three projects use at their tags.
plugins {
    kotlin("jvm") version "1.9.0" apply false
}

val sources = providers.gradleProperty("sources").orNull
    ?: throw GradleException("Pass -Psources=<dir holding the dash, rr and mm clones>.")
val repo = providers.gradleProperty("repo").orNull
    ?: throw GradleException("Pass -Prepo=<dir to publish the local Maven repository to>.")

// Each project: its group, version, artifact id, and the source directories its own build uses at its tag.
data class Module(val group: String, val version: String, val artifact: String, val kotlin: Boolean, val src: String, val resources: String? = null)

val modules = mapOf(
    "dashcore" to Module("com.acmerobotics.dashboard", "0.4.7", "core", false, "$sources/dash/DashboardCore/src/main/java"),
    "rrcore" to Module("com.acmerobotics.roadrunner", "1.0.1", "core", true, "$sources/rr/road-runner/core/src/main/kotlin"),
    "rractions" to Module("com.acmerobotics.roadrunner", "1.0.1", "actions", true, "$sources/rr/road-runner/actions/src/main/kotlin"),
    "meepmeep" to Module("com.acmerobotics.roadrunner", "0.1.7", "MeepMeep", true, "$sources/mm/src/main/kotlin", "$sources/mm/src/main/resources"),
)

subprojects {
    val module = modules.getValue(name)
    group = module.group
    version = module.version
    repositories {
        providers.gradleProperty("centralMirror").orNull?.let { maven { url = uri(it) } }
        mavenCentral()
    }
    apply(plugin = "java-library")
    apply(plugin = "maven-publish")
    if (module.kotlin) apply(plugin = "org.jetbrains.kotlin.jvm")

    extensions.configure<JavaPluginExtension> {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    val main = extensions.getByType<SourceSetContainer>()["main"]
    if (module.kotlin) {
        extensions.configure<KotlinJvmProjectExtension> { sourceSets["main"].kotlin.setSrcDirs(listOf(module.src)) }
        tasks.withType<KotlinCompile>().configureEach { kotlinOptions.jvmTarget = "1.8" }
    } else {
        main.java.setSrcDirs(listOf(module.src))
    }
    if (module.resources != null) main.resources.setSrcDirs(listOf(module.resources))

    extensions.configure<PublishingExtension> {
        publications { create<MavenPublication>("maven") { artifactId = module.artifact; from(components["java"]) } }
        repositories { maven { url = uri(repo) } }
    }
}

// The dependencies each project's own build.gradle declares at its tag.
project(":dashcore") {
    dependencies { "implementation"("com.google.code.gson:gson:2.8.6") }
}
project(":rrcore") {
    dependencies { "api"("org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.9.0") }
}
project(":rractions") {
    dependencies {
        "api"("org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.9.0")
        "api"(project(":rrcore"))
        "api"(project(":dashcore"))
    }
    // road-runner/actions/build.gradle.kts at v1.0.1 compiles with -Xjvm-default=all.
    tasks.withType<KotlinCompile>().configureEach { kotlinOptions.freeCompilerArgs += listOf("-Xjvm-default=all") }
}
project(":meepmeep") {
    dependencies {
        "implementation"("org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.9.0")
        "api"(project(":rrcore"))
        "api"(project(":rractions"))
    }
}
