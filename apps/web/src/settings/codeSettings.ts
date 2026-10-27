/**
 * The Code section's facts about the open project (issue #97), as pure logic.
 *
 * Both choices belong to the project, not to the person, so they live in its files and every
 * teammate, the CLI and the desktop Deploy read the same answer:
 *
 * - The command library is `zenith.json` `deploy.commandLibrary`, `"solverslib"` or `"ivy"`. Neither
 *   is a default (owner ruling 2026-09-24), so Zenith
 *   never fills it in for a team; the person picks one here, for the open project, and Settings
 *   writes that one key into `zenith.json`. It decides what the generated OpMode stubs and classes
 *   import; no `*.auto.json` names a library.
 * - The pathing system is `robot.json` `kinematics.follower.library`, and the schema allows only `"pedro"`:
 *   both runtimes follow paths with Pedro Pathing. RoadRunner and MeepMeep paths come in through
 *   Import. So it is shown, not chosen, until a second follower exists.
 */
import type { CommandLibrary } from "../project/commandLibrary";
import type { Project, ProjectSource } from "../project/types";

export { COMMAND_LIBRARIES, type CommandLibrary } from "../project/commandLibrary";

export const LIBRARY_LABEL: Readonly<Record<CommandLibrary, string>> = { solverslib: "SolversLib", ivy: "Ivy" };

/** What choosing each library changes, for its tooltip. */
export const LIBRARY_DOES: Readonly<Record<CommandLibrary, string>> = {
  solverslib: "The stubs and generated classes import org.horizon36596.zenith.solverslib, for robot code built on SolversLib commands.",
  ivy: "The stubs and generated classes import org.horizon36596.zenith.ivy, for robot code built on Ivy, Pedro Pathing's command library.",
};

/** The follower names `robot.json` allows, as a person reads them. */
export const FOLLOWER_LABEL: Readonly<Record<string, string>> = { pedro: "Pedro Pathing" };

export interface CodeSettings {
  /** The project's name as the title bar shows it. */
  projectName: string;
  /** The library `zenith.json` names, or null when it names none. */
  library: CommandLibrary | null;
  /** Why the library cannot be changed here, or null when it can. */
  whyCannotChange: string | null;
  /** The follower `robot.json` names, as a person reads it. */
  follower: string;
}

/** Why Zenith cannot write `zenith.json` for a project from `source`, or null when it can. */
export function whyLinkIsReadOnly(source: ProjectSource): string | null {
  switch (source.kind) {
    case "example":
      return "The example project is read only. Open your own robot project to choose its library.";
    case "files":
      return "These files were opened one at a time, so Zenith cannot write zenith.json. Open the project folder instead.";
    case "github":
      return "This project was opened from GitHub. Change commandLibrary in zenith.json on a branch, then open a pull request.";
    case "host":
      return "The app that opened this auto owns its project, so the library is set there.";
    case "directory":
    case "desktop":
      return null;
  }
}

/**
 * The Code section for `project`. `canWrite` says whether its backend can write `zenith.json` at
 * all (an older desktop build cannot), which is checked after the source's own reason.
 */
export function codeSettingsOf(project: Project, canWrite: boolean): CodeSettings {
  const library = project.link.deploy?.commandLibrary ?? null;
  const readOnly = whyLinkIsReadOnly(project.source);
  const whyCannotChange =
    readOnly ??
    (project.link.deploy === undefined
      ? "zenith.json has no deploy section, so this project writes no Java and needs no command library."
      : canWrite
        ? null
        : "This version of the desktop app cannot write zenith.json. Update it, or set commandLibrary by hand.");
  const followerId = project.robot.kinematics.follower.library;
  return {
    projectName: project.name,
    library,
    whyCannotChange,
    follower: FOLLOWER_LABEL[followerId] ?? followerId,
  };
}

