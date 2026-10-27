import { loadAuto } from "@horizon36596/zenith-core";
import { interchangeKindOf, validateInterchange } from "@horizon36596/zenith-cli/lib";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { findingsForAuto, errorCount, helpFor, warningCount } from "../findings.js";
import { readJsonFile, relativeToRoot, resolveAutoPath, resolveProject } from "../project.js";
import { guarded, jsonResult } from "../result.js";
import { autoRefField, projectField } from "../schemas.js";

/** `zenith.auto.read` and `zenith.validate`. */
export function registerAutoTools(server: McpServer): void {
  server.registerTool(
    "zenith.auto.read",
    {
      title: "Read an auto file",
      description:
        "Reads and schema-validates one *.auto.json file and returns its full parsed contents " +
        "(name, alliance, start, steps with their ids). Use this to see the current state of an " +
        "auto before editing it, or to read the id an addStep/newAutoFromTemplate call assigned.",
      inputSchema: { auto: autoRefField, project: projectField },
    },
    guarded(({ auto, project }) => {
      const proj = resolveProject(project);
      const path = resolveAutoPath(proj, auto);
      const parsed = loadAuto(readJsonFile(path));
      return jsonResult({ path: relativeToRoot(proj, path), auto: parsed });
    }),
  );

  server.registerTool(
    "zenith.validate",
    {
      title: "Validate an auto or an interchange file",
      description:
        "Schema-validates and checks one auto against its project's robot and field (or the auto's " +
        "own robot/field override), the same rules `zenith validate` runs. Returns every Finding: " +
        "severity, the step id and path parameter it points at, the check code, and a human-readable " +
        "message, plus `help`: for each code present, a plain title, what it means and how to fix it. " +
        "Call this after every edit to see whether the auto is closer to done. `auto` may also be an " +
        "interchange trajectory.json or path.json file (a JSON file whose `kind` is \"trajectory\" or " +
        "\"path\"), given by its path: it is checked the way `zenith import` reads it, against the " +
        "project's field, the result carries its `kind`, and each finding carries `field`, the JSON " +
        "path of the value it is about.",
      inputSchema: { auto: autoRefField, project: projectField },
    },
    guarded(({ auto, project }) => {
      const proj = resolveProject(project);
      const path = resolveAutoPath(proj, auto);
      const doc = readJsonFile(path);
      const kind = interchangeKindOf(doc);
      if (kind !== null) {
        const { findings } = validateInterchange(kind, doc, proj.field);
        return jsonResult({
          path: relativeToRoot(proj, path),
          kind,
          findings,
          errors: errorCount(findings),
          warnings: warningCount(findings),
          seasonWarnings: [],
          help: helpFor(findings),
        });
      }
      const parsed = loadAuto(doc);
      const { findings, seasonWarnings } = findingsForAuto(parsed, proj);
      return jsonResult({
        path: relativeToRoot(proj, path),
        findings,
        errors: errorCount(findings),
        warnings: warningCount(findings),
        seasonWarnings,
        help: helpFor(findings),
      });
    }),
  );
}
