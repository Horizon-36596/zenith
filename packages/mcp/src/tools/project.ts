import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listAutoNames, resolveProject } from "../project.js";
import { guarded, jsonResult } from "../result.js";
import { projectField } from "../schemas.js";

/** `zenith.project.open`, `zenith.registry`, `zenith.waypoints`. */
export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    "zenith.project.open",
    {
      title: "Open a Zenith project",
      description:
        "Finds zenith.json (walking up from `dir`, or the server's working directory when `dir` is " +
        "omitted) and returns a summary: the robot's name, footprint and command/condition registry, " +
        "the field's name and size, the waypoint names, and the list of autos in the project. Call " +
        "this first, before any other tool, to learn what an auto file may reference.",
      inputSchema: { dir: projectField },
    },
    guarded(({ dir }) => {
      const project = resolveProject(dir);
      return jsonResult({
        root: project.root,
        link: project.link,
        robot: {
          name: project.robot.name,
          footprint: project.robot.footprint,
          commands: project.robot.commands.map((command) => command.name),
          conditions: (project.robot.conditions ?? []).map((condition) => condition.name),
        },
        field: {
          name: project.field.name,
          season: project.field.season,
          sizeIn: project.field.sizeIn,
          canonicalAlliance: project.field.frame.canonicalAlliance,
          mirror: project.field.frame.mirror,
        },
        waypoints: project.waypoints === undefined ? [] : Object.keys(project.waypoints.waypoints),
        autos: listAutoNames(project),
      });
    }),
  );

  server.registerTool(
    "zenith.registry",
    {
      title: "Read the robot's command and condition registry",
      description:
        "Returns robot.json's `commands` (name, params, estimateS expression, requires, stationary, " +
        "movesRobot, ledger) and `conditions` in full, so an agent knows the exact vocabulary a " +
        "command step, a marker or a branch/endCondition may use before it writes one.",
      inputSchema: { dir: projectField },
    },
    guarded(({ dir }) => {
      const project = resolveProject(dir);
      return jsonResult({
        commands: project.robot.commands,
        conditions: project.robot.conditions ?? [],
      });
    }),
  );

  server.registerTool(
    "zenith.waypoints",
    {
      title: "Read the project's named waypoints",
      description:
        "Returns waypoints.json's named poses in full. An auto references one of these by " +
        '`{ "ref": name }`; changing a waypoint changes every auto that uses it.',
      inputSchema: { dir: projectField },
    },
    guarded(({ dir }) => {
      const project = resolveProject(dir);
      return jsonResult({ waypoints: project.waypoints?.waypoints ?? {} });
    }),
  );
}
