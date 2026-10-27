/**
 * The error every project source throws with a sentence written for the person using the app. It
 * lives on its own, with no DOM types, so pure modules such as `projectFiles.ts` can throw it and
 * the desktop app's main process can import them.
 */
export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

/**
 * Thrown by Open folder when the folder has no `zenith.json` at its top (issue #159): Zenith has not
 * been set up there yet. It is not an error to report, because the app offers Set up for the folder
 * instead of saying it could not read the file.
 */
export class NoProjectLinkError extends ProjectError {
  constructor(readonly folder: string) {
    super(`${folder} has no zenith.json, so Zenith is not set up there yet.`);
    this.name = "NoProjectLinkError";
  }
}

/**
 * A save the host never answered because the session ended first (issue #519). The bar and the
 * status line already say the session closed and that Save to the host is off, so Save writes no
 * line of its own for it.
 */
export class SessionEndedError extends ProjectError {
  constructor(message: string) {
    super(message);
    this.name = "SessionEndedError";
  }
}
