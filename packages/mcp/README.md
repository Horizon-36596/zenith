# @horizon36596/zenith-mcp

The MCP server for [Zenith](https://libraries.horizon36596.org/zenith/), the FTC autonomous planner
by Horizon (FTC 36596). It gives an agent the same verbs as the `zenith` CLI, plus structural edit
tools, over stdio, so the agent can write and fix an auto without hand-editing JSON.

Add it to a robot repository's `.mcp.json`:

```json
{
  "mcpServers": {
    "zenith": {
      "command": "npx",
      "args": ["-y", "@horizon36596/zenith-mcp"]
    }
  }
}
```

Requires Node 22 or newer. The PNG render and sim tools run the `zenith` CLI from
`@horizon36596/zenith-cli`, which installs with this package. Documentation:
https://libraries.horizon36596.org/zenith/. Licence: MIT.

## Package reference

The Zenith MCP server: the same verbs `packages/cli` has, plus structural edit tools, exposed over
stdio so an agent (Claude Code, or any other MCP-capable client) can author and edit an auto end
to end without hand-editing JSON. The usage guide, written for the agent side, is the docs site's
Agents and MCP page (https://libraries.horizon36596.org/zenith/agents-mcp/); this file is the package's own reference.

### Running it

```
npx -y @horizon36596/zenith-mcp
```

or, inside this workspace, `node packages/mcp/dist/index.js` after `pnpm build`, or
`pnpm exec tsx packages/mcp/src/index.ts` straight from source. It speaks the MCP stdio protocol
and expects to be launched by a client (an `.mcp.json` entry, an SDK `StdioClientTransport`), not
run interactively. The Agents and MCP page's Setup section has the `.mcp.json` snippet.

The server finds its project by walking up from its own working directory looking for
`zenith.json`, the same way `zenith validate` does; run it from inside the robot repo, or pass
`project` (`dir` on `zenith.project.open`) on each call.

### Tools

| tool | does |
|---|---|
| `zenith.project.open` | Robot/field/waypoints summary and the autos list. |
| `zenith.auto.read` | Reads and schema-validates one auto file. |
| `zenith.validate` | Schema + feasibility findings for one auto. |
| `zenith.estimate` | Per-step timing table and total. |
| `zenith.render` | Renders to SVG or PNG. |
| `zenith.diff` | Structural diff between two autos. |
| `zenith.sim` | Runs the robot repo's simulator via the CLI. |
| `zenith.registry` | `robot.json`'s `commands`/`conditions` in full. |
| `zenith.waypoints` | `waypoints.json`'s named poses in full. |
| `zenith.edit.*` | One tool per structural edit primitive in `@horizon36596/zenith-core`'s `edit/` — see the Agents and MCP page. |

Every tool takes structured JSON input (a precise `zod` schema per tool — `src/schemas.ts`) and
returns structured JSON text. Every tool above is implemented and exercised end to end
(`src/integration.test.ts`, `test/flowB.test.ts`); a call still comes back as
a tool error (`isError: true`) rather than crashing the server when the input is bad or an edit is
rejected.

Every tool that calls `check`/`ledger` (`zenith.validate`, `zenith.render`, `zenith.edit.*`) resolves
season rules through `@horizon36596/zenith-seasons` and includes a `seasonWarnings` array (full sentences,
usually empty) in its result — see the Agents and MCP page's Seasons section.

### Resources

- `zenith://spec/file-format` — the File format page (https://libraries.horizon36596.org/zenith/file-format/).
- `zenith://spec/checks` — the Checks and findings page (https://libraries.horizon36596.org/zenith/checks-and-findings/), every finding code.

`spec/*.md` in this package are byte-for-byte copies of `site/docs/file-format.md` and
`site/docs/checks-and-findings.md` (not symlinks, for a clean publish and a clean Windows checkout), so
they ship with the published package. `src/specCopies.test.ts` fails when they drift; re-copy them
whenever those pages change.

### Layout

```
src/
  project.ts       find zenith.json, load the robot/field/waypoints it points at, resolve an
                    "auto" argument (name, relative path, or absolute path) to a file
  findings.ts       resolve -> plan -> check for a parsed Auto, robot/field override included
  editIo.ts         read-current / write-canonical-and-findings, the common tail of every
                    zenith.edit.* tool
  schemas.ts        zod (v4, the MCP SDK's peer version) input schemas mirroring
                    @horizon36596/zenith-schema's (zod 3) auto.ts shapes structurally
  spawnCli.ts       spawns the zenith CLI's own built entry point (resolved via `require.resolve`,
                    not `npx`, so it works offline against this workspace's build) for the
                    render --png and sim tools, so this server's own stdout (the MCP transport)
                    never receives the CLI's output directly
  result.ts         jsonResult / errorResult / guarded (turn a thrown error into a tool error)
  resources.ts      the two zenith://spec/* resources
  specCopies.test.ts  checks spec/*.md still match the docs pages they copy
  tools/            one module per tool group: project, auto, analysis, edit
  server.ts         createServer(): wires every tool and resource onto an McpServer
  index.ts          the stdio binary entry point; also re-exports createServer for embedding
```

`@horizon36596/zenith-mcp` may depend on `@horizon36596/zenith-core`, `@horizon36596/zenith-schema`, `@horizon36596/zenith-seasons` and Node.
It never touches `apps/web` or `@horizon36596/zenith-github`, and it reaches a
season's rules only through `@horizon36596/zenith-seasons`'s registry, never by depending on a `season-*`
package directly.

Note on `zod`: this package's own tool-input schemas (`src/schemas.ts`) are written against `zod`
4 (the MCP SDK's peer dependency) and are a structural, not nominal, mirror of `@horizon36596/zenith-schema`'s
`zod` 3 definitions. A value that passes the MCP-facing schema still re-validates fully inside the
`@horizon36596/zenith-core` edit primitive it reaches (`parseAuto`, via `finish()`), so the two schemas are a
convenience for precise tool descriptions and early rejection, not the sole source of truth.

### Testing

`pnpm exec vitest run --project mcp` (or `pnpm test` for the whole workspace).
`src/integration.test.ts` spawns the real server over stdio with the MCP SDK's own client — not
`createServer()` called in-process — against the example project, so it exercises the actual stdio
framing an agent host uses: it lists tools and resources, validates an example auto, and
runs `zenith.edit.setPose` on a temporary copy, asserting the returned findings shape and that the
file it wrote round-trips through `canonicalize` byte for byte.

`test/flowB.test.ts` drives the agent flow (an agent authoring a new auto from nothing)
against a small clean fixture, also over real stdio: `newAutoFromTemplate`, a path step added
without a heading (so there is a real `HEADING_MISSING` error to fix), `setHeadingMode`, a
`shootAll` command step, `validate`, an edit loop until the auto has zero errors, a PNG render (the
one test in this repository that exercises `spawnCli.ts`'s child-process path end to end) and an
`estimate` — asserting zero errors at the end and that the file on disk is canonical.
