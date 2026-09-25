# @horizon36596/zenith-core

The planning core of [Zenith](https://libraries.horizon36596.org/zenith/), the FTC autonomous planner
by Horizon (FTC 36596). It turns an auto file into a plan and answers the questions about it: path
geometry and heading modes, robot footprints, the feasibility checks and their findings, the time
estimate, the structural edits an editor or agent makes, the canonical file form and the SVG render.

```
npm install @horizon36596/zenith-core
```

The package is pure: no DOM, no clock, no randomness and no Node APIs. The editor, the `zenith` CLI
and the MCP server all use it, so they give the same answer for the same files.

Most projects want [`@horizon36596/zenith-cli`](https://www.npmjs.com/package/@horizon36596/zenith-cli)
instead. Documentation: https://libraries.horizon36596.org/zenith/. Licence: MIT.
