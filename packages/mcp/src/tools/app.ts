import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openInDesktop, type DesktopAppEnv, type Launcher } from "@horizon36596/zenith-cli/lib";
import { z } from "zod";
import { guarded, jsonResult } from "../result.js";
import { projectField } from "../schemas.js";

/** Test seams: where the app is looked for, and how it is started. */
export interface AppToolDeps {
  host?: DesktopAppEnv;
  launch?: Launcher;
}

/**
 * `zenith.app.open`: opens a project, and optionally one auto, in the Zenith desktop app, the same
 * as `zenith open` (site/docs/agents-mcp.md). It starts the app, or reaches the copy already
 * running, which then shows the project to the person at the computer. Desktop only: where the app
 * is not installed the tool returns an error saying so, and changes nothing.
 */
export function registerAppTools(server: McpServer, deps: AppToolDeps = {}): void {
  server.registerTool(
    "zenith.app.open",
    {
      title: "Open a project in the Zenith desktop app",
      description:
        "Opens the project (the folder holding zenith.json) in the Zenith desktop app on this computer, so " +
        "the person at it sees the auto you are working on. Starts the app, or reaches the copy already " +
        "running; unsaved edits there are asked about before anything is replaced. Name `auto` to open that " +
        "auto first. Returns the folder and auto opened. An error, with nothing opened, when the folder has " +
        "no zenith.json, the auto does not exist, or the desktop app is not installed (it is Windows only; " +
        "ZENITH_DESKTOP can name its Zenith.exe).",
      inputSchema: {
        project: projectField,
        auto: z
          .string()
          .min(1)
          .optional()
          .describe("The auto to open first, by bare name (close-cycle) or file name (close-cycle.auto.json)."),
      },
    },
    guarded(async ({ project, auto }) => {
      const plan = await openInDesktop(
        { cwd: process.cwd(), ...(project === undefined ? {} : { dir: project }), ...(auto === undefined ? {} : { auto }) },
        { ...(deps.host === undefined ? {} : { host: deps.host }), ...(deps.launch === undefined ? {} : { launch: deps.launch }) },
      );
      return jsonResult({ opened: true, root: plan.root, auto: plan.auto });
    }),
  );
}
