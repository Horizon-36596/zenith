/**
 * Thrown by the parts of the core API a later milestone fills in. The signature is exported now so
 * the editor, the CLI and the MCP server can be built against the final shape.
 */
export class NotImplementedError extends Error {
  constructor(what: string, milestone: string, where: string) {
    super(`${what} is not implemented yet: ${milestone} builds it (${where}).`);
    this.name = "NotImplementedError";
  }
}
