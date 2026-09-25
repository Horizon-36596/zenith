import type { Link } from "@horizon36596/zenith-schema";
import { ProjectError } from "./project.js";

/**
 * The command library the robot runtime builds on, from `zenith.json` `deploy.commandLibrary`
 * (site/docs/command-libraries.md). Neither library is a default: every command that writes Java
 * refuses until the project names one.
 */
export type CommandLibrary = "solverslib" | "ivy";

/** Both libraries, in the order Zenith lists them. Neither is a default. */
export const LIBRARIES: readonly CommandLibrary[] = ["solverslib", "ivy"];

/** The Java package each library's runtime classes live in. */
export const RUNTIME_PACKAGE: Readonly<Record<CommandLibrary, string>> = {
  solverslib: "org.horizon36596.zenith.solverslib",
  ivy: "org.horizon36596.zenith.ivy",
};

/** The name a person reads, for CLI output and the desktop deploy preview. */
export const LIBRARY_LABEL: Readonly<Record<CommandLibrary, string>> = {
  solverslib: "SolversLib",
  ivy: "Ivy",
};

/**
 * @returns the project's command library
 * @throws ProjectError when `zenith.json` does not name one; Zenith never picks one for a team
 */
export function commandLibraryOf(link: Link): CommandLibrary {
  const library = link.deploy?.commandLibrary;
  if (library === undefined) {
    throw new ProjectError(
      'zenith.json does not say which command library your robot code uses, and Zenith does not pick one. ' +
        'Add "commandLibrary": "solverslib" or "commandLibrary": "ivy" to its "deploy" section. ' +
        "See https://libraries.horizon36596.org/zenith/command-libraries/.",
    );
  }
  return library;
}
