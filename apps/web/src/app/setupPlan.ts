/**
 * What Set up prefills from a robot repository's own code (issue #159). It scans TeamCode with the
 * same scanner as Import commands from Java, and:
 *
 * - prefills the command library only from an import that names one, never as a default;
 * - prefills the robot class from the one class that implements `ZenithRobot`;
 * - seeds `robot.json`'s commands and conditions from the registrations it finds, each estimate
 *   NEEDS MEASUREMENT, on core's skeleton robot.
 *
 * And the Gradle lines it shows once the files are written. Pure: sources in, a plan out.
 */
import { skeletonRobot, type CommandLibrary } from "@horizon36596/zenith-core";
import {
  importedCommandLibrary,
  mergeCommandScan,
  scanCommands,
  zenithRobotClasses,
  type LibraryImport,
  type SourceFile,
} from "@horizon36596/zenith-import";
import type { Robot } from "@horizon36596/zenith-schema";
import { SETUP_WRITTEN_BY } from "../project/setupFiles";

/** The folder Set up scans, where an FTC SDK project keeps the team's code. */
export const SETUP_SCAN_DIR = "TeamCode";

export interface SetupPlan {
  /** How many Java and Kotlin files the scan read. */
  filesScanned: number;
  /** Every class that implements `ZenithRobot`, sorted. */
  robotClasses: string[];
  /** The robot class to prefill: the only one found, or "" when there are none or several. */
  robotClass: string;
  /** The library the imports name, or null when none does or both do. */
  library: CommandLibrary | null;
  /** The imports that name a library, for saying where the prefill came from. */
  libraryImports: LibraryImport[];
  /** The commands and conditions the code registers, by name. */
  commands: string[];
  conditions: string[];
  /** The skeleton robot named after the folder, with those commands and conditions. */
  robot: Robot;
}

/** Scans `sources` (TeamCode's, or none) and plans what Set up prefills for the folder `name`. */
export function planSetup(name: string, sources: readonly SourceFile[]): SetupPlan {
  const scan = scanCommands(sources);
  const robot = mergeCommandScan(skeletonRobot(name, SETUP_WRITTEN_BY), scan).robot;
  const robotClasses = zenithRobotClasses(sources);
  const { library, found } = importedCommandLibrary(sources);
  return {
    filesScanned: scan.filesScanned,
    robotClasses,
    robotClass: robotClasses.length === 1 ? (robotClasses[0] as string) : "",
    library,
    libraryImports: found,
    commands: robot.commands.map((command) => command.name),
    conditions: (robot.conditions ?? []).map((condition) => condition.name),
    robot,
  };
}

/**
 * The dependencies the runtime needs, as site/docs/robot-runtime.md ("Install") gives them: Pedro
 * Pathing v3 at the build Zenith is checked against, and each command library at the version the
 * runtime is built against.
 */
const PEDRO = "com.pedropathing:core:3.0.0-20260828.185437-17";
const LIBRARY_GRADLE: Readonly<Record<CommandLibrary, { repository: string | null; dependency: string }>> = {
  ivy: { repository: null, dependency: "com.pedropathing.ivy:pedro:1.1.1" },
  solverslib: {
    repository: "    maven { url = 'https://repo.dairy.foundation/releases' }                   // SolversLib",
    dependency: "org.solverslib:core:0.3.6",
  },
};

/**
 * What to add to `build.dependencies.gradle` for the runtime, at `version` (this release's), for
 * `library`. With no library chosen, the library's own line is left for the team to add, and a
 * comment says so.
 */
export function gradleLines(library: CommandLibrary | null, version: string): string {
  const chosen = library === null ? null : LIBRARY_GRADLE[library];
  return [
    "repositories {",
    "    maven { url = 'https://jitpack.io' }                                       // Zenith",
    ...(chosen?.repository === null || chosen === null ? [] : [chosen.repository]),
    "    maven { url = 'https://central.sonatype.com/repository/maven-snapshots' }  // Pedro Pathing v3",
    "}",
    "",
    "dependencies {",
    chosen === null
      ? "    // and your command library, SolversLib or Ivy: see Robot runtime, Install"
      : `    implementation '${chosen.dependency}'`,
    `    implementation '${PEDRO}'`,
    `    implementation 'com.github.Horizon-36596:zenith:v${version}'`,
    "}",
  ].join("\n");
}
