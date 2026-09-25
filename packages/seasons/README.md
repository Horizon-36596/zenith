# @horizon36596/zenith-seasons

The season registry of [Zenith](https://libraries.horizon36596.org/zenith/), the FTC autonomous
planner by Horizon (FTC 36596). It turns a field file into the season rules the feasibility checks
run against, so the editor, the CLI and the MCP server always agree on which season a project is.

```
npm install @horizon36596/zenith-seasons
```

```ts
import { resolveSeason } from "@horizon36596/zenith-seasons";

const { rules, warnings } = resolveSeason(field);
```

A field that names no known season gets no season rules and a warning, never an error. Seasons
bundled today: BIOBUZZ ([`@horizon36596/zenith-season-biobuzz`](https://www.npmjs.com/package/@horizon36596/zenith-season-biobuzz)).

Documentation: https://libraries.horizon36596.org/zenith/. Licence: MIT.
