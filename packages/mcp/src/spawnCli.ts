import { spawn } from "node:child_process";
import { createRequire } from "node:module";

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The CLI's own entry point, resolved through Node's module resolution rather than shelled out to by
 * name. `@horizon36596/zenith-cli` is a dependency of this package, so it resolves from here both in
 * the monorepo (pnpm links the workspace package) and after `npx -y @horizon36596/zenith-mcp`, where
 * npm installs it next to this one. Its `exports["."]` is `./dist/index.js`, the same file the
 * `zenith` bin points at and the same file that guards `main(process.argv)` behind an
 * `import.meta.url === pathToFileURL(process.argv[1]).href` check, so `node <this path> <args>`
 * behaves exactly like running the `zenith` binary.
 *
 * Resolving locally, rather than spawning `npx`, works offline and always runs the CLI version this
 * server was installed with.
 */
export function resolveCliEntry(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("@horizon36596/zenith-cli");
}

/**
 * Runs the `zenith` CLI as a child process: `zenith.render`'s PNG path and `zenith.sim` shell out
 * to it rather than reimplementing resvg or the trace conversion in this package
 * (site/docs/agents-mcp.md — "png via the CLI's resvg path"). A subprocess,
 * rather than importing the CLI's `run*` functions in-process, is deliberate: those functions write
 * their output straight to `process.stdout`/`process.stderr`, and this server's own `process.stdout`
 * is the MCP stdio transport's JSON-RPC framing, which any stray text would corrupt.
 */
export function runZenithCli(args: readonly string[], cwd: string): Promise<CliRunResult> {
  return new Promise((resolvePromise, reject) => {
    let entry: string;
    try {
      entry = resolveCliEntry();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}
