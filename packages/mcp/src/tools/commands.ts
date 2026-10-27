import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { importCommands } from "@horizon36596/zenith-cli/lib";
import { z } from "zod";
import { resolveProject } from "../project.js";
import { guarded, jsonResult } from "../result.js";
import { projectField } from "../schemas.js";

/**
 * `zenith.importCommands`: robot.json against the robot's Java, through the same code as
 * `zenith import-commands --json` (Zenith's ADR 0014). It writes robot.json
 * only when asked to, and never reads outside the project.
 */
export function registerCommandTools(server: McpServer): void {
  server.registerTool(
    "zenith.importCommands",
    {
      title: "Read robot.json's commands from the robot's Java",
      description:
        "Scans the robot's Java and Kotlin for NamedCommands.register and registerCondition calls, reads the " +
        "arguments each factory takes through argInt, argDouble, argString and argEnum, and compares them with " +
        "robot.json, the same as `zenith import-commands --json`. `changes` are what would be added: commands, " +
        "conditions and params robot.json lacks, new commands with estimateS \"unknown\" and a provenance naming " +
        "the Java file. Nothing a person wrote is changed and nothing is removed. `findings` are every remaining " +
        "disagreement, and anything the scanner could not read, with the file and line; `diff` is the robot.json " +
        "lines that change. robot.json is written only when `write` is true.",
      inputSchema: {
        dirs: z
          .array(z.string().min(1))
          .optional()
          .describe("Directories or files of the robot's Java or Kotlin, relative to the project root. Default the whole project; build output and test sources are skipped."),
        write: z.boolean().optional().describe("Write the additions into robot.json. Default false: report only."),
        project: projectField,
      },
    },
    guarded(({ dirs, write, project }) => {
      const proj = resolveProject(project);
      const result = importCommands(dirs ?? [], { cwd: proj.root, project: proj.root, check: write !== true });
      return jsonResult({
        ...result,
        errors: result.findings.filter((finding) => finding.severity === "error").length,
        warnings: result.findings.filter((finding) => finding.severity === "warning").length,
      });
    }),
  );
}
