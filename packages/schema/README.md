# @horizon36596/zenith-schema

The file formats of [Zenith](https://libraries.horizon36596.org/zenith/), the FTC autonomous planner
by Horizon (FTC 36596): `zenith.json`, `robot.json`, `*.field.json`, `waypoints.json` and
`*.auto.json`, as zod schemas and the TypeScript types inferred from them, plus the migrations
between format versions and the `estimateS` expression grammar.

```
npm install @horizon36596/zenith-schema
```

```ts
import { parseAuto, SCHEMA_ID } from "@horizon36596/zenith-schema";

const auto = parseAuto(JSON.parse(text)); // throws SchemaError with every issue listed
```

The same schemas ship as JSON Schema (draft 2020-12) under `json/`, for example
`@horizon36596/zenith-schema/json/auto.json`, and are served at
`https://libraries.horizon36596.org/zenith/schema/v1/<kind>.json`.

The package is pure: no DOM, no clock, no randomness and no Node APIs, so it runs anywhere.

Documentation: https://libraries.horizon36596.org/zenith/. Licence: MIT.
