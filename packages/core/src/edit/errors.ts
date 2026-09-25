/**
 * Thrown by every structural edit primitive in this directory: an id that does not exist, a
 * target that does not fit the step kind, or a mutation that would leave the auto invalid. The
 * message is written for whoever is holding the file, human or agent.
 */
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}
