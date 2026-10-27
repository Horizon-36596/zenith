import {
  NO_COMMAND_LIBRARY_MESSAGE,
  type CommandLibrary,
} from "@horizon36596/zenith-core";
import type { Link } from "@horizon36596/zenith-schema";
import { ProjectError } from "./project.js";

/**
 * The command library the robot runtime builds on, from `zenith.json` `deploy.commandLibrary`
 * (site/docs/command-libraries.md). Neither library is a default: every command that writes Java
 * refuses until the project names one. The names and packages live in core beside the generator.
 */
export { LIBRARIES, LIBRARY_LABEL, RUNTIME_PACKAGE, type CommandLibrary } from "@horizon36596/zenith-core";

/**
 * @returns the project's command library
 * @throws ProjectError when `zenith.json` does not name one; Zenith never picks one for a team
 */
export function commandLibraryOf(link: Link): CommandLibrary {
  const library = link.deploy?.commandLibrary;
  if (library === undefined) {
    throw new ProjectError(NO_COMMAND_LIBRARY_MESSAGE);
  }
  return library;
}