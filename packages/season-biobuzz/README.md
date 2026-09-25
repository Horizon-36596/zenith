# @horizon36596/zenith-season-biobuzz

The FTC BIOBUZZ season for [Zenith](https://libraries.horizon36596.org/zenith/), the FTC autonomous
planner by Horizon (FTC 36596): the field file, and the season-rules plugin that reads it.

```
npm install @horizon36596/zenith-season-biobuzz
```

The field file ships as `field/biobuzz.field.json`
(`@horizon36596/zenith-season-biobuzz/field/biobuzz.field.json`); `zenith init` copies it into a
project. Every rule is derived from that file, so a team that corrects a measurement in its own copy
gets rules that match.

Most projects reach this package through
[`@horizon36596/zenith-seasons`](https://www.npmjs.com/package/@horizon36596/zenith-seasons).
Documentation: https://libraries.horizon36596.org/zenith/. Licence: MIT.
