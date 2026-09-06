---
'migrane': minor
---

First release.

A SQL migration runner that is handed a driver and a list of directories and
knows nothing else about your application — no ORM, no module registry, and no
runtime dependencies. Three entry points, cut by audience: `migrane` for
authoring, `migrane/ship` for container entries — filesystem-free by
construction — and the CLI for every job that reads a disk.

- Migrations in `.ts`, `.sql`, or directories of parts, ordered by leading
  number compared as a number. Each commits in a transaction with the row that
  records it, under a session advisory lock spanning the run, with edits to
  applied migrations refused by checksum.
- Seed units: alternatives rather than increments, recorded but never refused.
- `migrane manifest` generates imports and two arrays — `.ts` parts imported,
  `.sql` inlined — and `createPlans` turns a config and that manifest into
  every plan the verbs take, so an image with no source tree applies the same
  migrations and records the same checksums as the CLI.
- Destructive commands run through the config's `guard` on the functions
  themselves, and a config that declares none refuses them all; the refusal
  carries a paste-ready guard naming the exact coordinates the driver holds.
- The CLI answers with an exit-code contract: 0 ok, 1 failure, 2 a migration
  changed after it was applied, 3 the guard said no.
- The executable runs under node or bun, preferring node; `--runtime=` or
  `MIGRANE_RUNTIME` names the order.
