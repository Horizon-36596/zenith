import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hasErrors, loadAuto } from "@horizon36596/zenith-core";
import { buildProjectionFile, importDocument, type ImportDocumentOptions } from "@horizon36596/zenith-cli/lib";
import { z } from "zod";
import { errorCount, helpFor, loadAutoAndPlan, warningCount } from "../findings.js";
import { confinePath, ProjectError, readJsonFile, relativeToRoot, resolveAutoPath, resolveProject } from "../project.js";
import { guarded, jsonResult } from "../result.js";
import { autoRefField, projectField } from "../schemas.js";

const outField = z
  .string()
  .min(1)
  .optional()
  .describe("Where to write the result: a path relative to the project root, or absolute (inside it). Without it nothing is written.");

const forceField = z.boolean().optional().describe("Overwrite `out` if it exists. Default false: an existing file is refused.");

/** Refuses an existing `out` unless the caller said to overwrite it, and returns where to write. */
function outPathFor(root: string, out: string | undefined, force: boolean | undefined): string | undefined {
  if (out === undefined) return undefined;
  const path = confinePath(root, out);
  if (existsSync(path) && force !== true) throw new ProjectError(`${out} already exists. Pass force: true to overwrite it.`);
  return path;
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/**
 * `zenith.import` and `zenith.projection`: the two file conversions of spec 13 sections 8 and 11,
 * returning what `zenith import --json` and `zenith projection --json` print, through the same
 * code (`importDocument` and `buildProjectionFile` from the CLI). Neither writes unless given `out`,
 * and neither writes outside the project.
 */
export function registerInterchangeTools(server: McpServer): void {
  server.registerTool(
    "zenith.import",
    {
      title: "Import a path from another planner",
      description:
        "Imports a Pedro Pathing Visualizer project (.pp) or an interchange path.json as an auto, or an " +
        "interchange trajectory.json as a view projection for the alliance view (or, with asAuto, as an auto " +
        "that can be edited and shared), against the project's field, the same as `zenith import --json`. " +
        "An imported auto comes back with `findings`: what zenith.validate would say of it in this project, " +
        "which do not stop the import. `warnings` are the importer's full sentences about what it changed or " +
        "left out, and `robotFootprint` is the robot size the file records (never written to robot.json). " +
        "A file that cannot be imported is an error naming every wrong field by its JSON path. Nothing is " +
        "written unless `out` is given.",
      inputSchema: {
        file: z.string().min(1).describe("The file to import: a path relative to the project root, or absolute (inside it)."),
        out: outField,
        name: z.string().min(1).optional().describe("The imported auto's name. Default: the file's own name."),
        alliance: z
          .enum(["RED", "BLUE"])
          .optional()
          .describe("The alliance a .pp path was drawn for; a .pp file does not say. Default the field's own alliance."),
        pedroCentreIn: z
          .number()
          .optional()
          .describe("The Pedro Visualizer's field centre in its own inches, for a .pp file. Default 70.75; some teams place points about 72."),
        asAuto: z.boolean().optional().describe("For a trajectory.json: make an auto instead of a projection. Default false."),
        force: forceField,
        project: projectField,
      },
    },
    guarded(({ file, out, name, alliance, pedroCentreIn, asAuto, force, project }) => {
      const proj = resolveProject(project);
      const path = confinePath(proj.root, file);
      const doc = readJsonFile(path);
      const outPath = outPathFor(proj.root, out, force);
      const options: ImportDocumentOptions = {};
      if (name !== undefined) options.name = name;
      if (alliance !== undefined) options.alliance = alliance;
      if (pedroCentreIn !== undefined) options.pedroCentreIn = pedroCentreIn;
      if (asAuto === true) options.asAuto = true;
      const imported = importDocument(path, doc, proj, options);
      if (outPath !== undefined) writeText(outPath, imported.text);
      const written = outPath === undefined ? null : relativeToRoot(proj, outPath);
      if (imported.result === "projection") {
        return jsonResult({ kind: imported.kind, written, projection: imported.projection, warnings: imported.warnings });
      }
      return jsonResult({
        kind: imported.kind,
        written,
        auto: imported.auto,
        ...(imported.robotFootprint === undefined ? {} : { robotFootprint: imported.robotFootprint }),
        findings: imported.findings,
        errors: errorCount(imported.findings),
        warnings: imported.warnings,
        help: helpFor(imported.findings),
      });
    }),
  );

  server.registerTool(
    "zenith.projection",
    {
      title: "Write an auto's share projection",
      description:
        "Builds the projection a share of the auto would send, without the cloud: the instant sim's run, the " +
        "season's ledger and core's projectShare, in canonical form, byte for byte what the editor's Download " +
        "share file and `zenith projection --json` give. `level` \"view\" shows another team the trajectory, " +
        "phases and claims; \"propose\" adds the step structure under opaque ids so they can propose changes. " +
        "The auto's own title, notes and provenance are never in it, and commands are opaque tokens unless " +
        "`includeCommands` is true, which adds a `commands` list naming each token's command and its arguments. " +
        "Refused for an auto with an " +
        "error finding. Returns the projection and its size in bytes; nothing is written unless `out` is given.",
      inputSchema: {
        auto: autoRefField,
        level: z.enum(["view", "propose"]).optional().describe("How much the other team sees. Default view."),
        title: z.string().min(1).max(200).optional().describe("The title the other team sees. Default none."),
        coarsen: z.boolean().optional().describe("Round the timed layer to 2 in, 5 degrees and 0.25 s. Default false."),
        includeCommands: z
          .boolean()
          .optional()
          .describe(
            "Add the `commands` list: each command token's name and arguments, as the share dialog's Include " +
              "command names checkbox does. Default false, which leaves every command an opaque token.",
          ),
        out: outField,
        force: forceField,
        project: projectField,
      },
    },
    guarded(({ auto, level, title, coarsen, includeCommands, out, force, project }) => {
      const proj = resolveProject(project);
      const autoPath = resolveAutoPath(proj, auto);
      const loaded = loadAutoAndPlan(loadAuto(readJsonFile(autoPath)), proj);
      if (hasErrors(loaded.findings)) {
        return jsonResult({
          auto: relativeToRoot(proj, autoPath),
          written: null,
          notWritten: "This auto has errors, so there is nothing to share yet. Fix them first.",
          findings: loaded.findings,
          errors: errorCount(loaded.findings),
          warnings: warningCount(loaded.findings),
          help: helpFor(loaded.findings),
        });
      }
      const outPath = outPathFor(proj.root, out, force);
      const built = buildProjectionFile(loaded, {
        level: level ?? "view",
        ...(title === undefined ? {} : { title }),
        ...(coarsen === true ? { coarsen: true } : {}),
        ...(includeCommands === true ? { includeCommands: true } : {}),
      });
      if (outPath !== undefined) writeText(outPath, built.text);
      return jsonResult({
        auto: relativeToRoot(proj, autoPath),
        level: level ?? "view",
        written: outPath === undefined ? null : relativeToRoot(proj, outPath),
        bytes: built.bytes,
        projection: built.projection,
        seasonWarnings: loaded.seasonWarnings,
      });
    }),
  );
}
