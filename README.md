# migrane

A SQL migration runner that knows nothing about your application.

It is handed a driver and a list of directories. That is all it knows — no ORM,
no container, no module registry, no dependency it makes you adopt. The package
itself has no runtime dependencies. Everything specific to an application lives
in that application's config file.

Three entry points, cut by audience:

| entry                | for                                | holds                                            |
| -------------------- | ---------------------------------- | ------------------------------------------------ |
| `migrane`            | config & migration authors         | `defineConfig`, `compose`, `createSql`, `refuse` |
| `migrane/ship`       | container entries                  | `createPlans` and the verbs — no filesystem      |
| `migrane/drivers/pg` | consumers of the bundled pg driver | `pgDriver`                                       |

The CLI owns every job that touches a filesystem; `migrane/ship` owns every job
that does not — it compiles for a target with no filesystem at all, checked in
this repository's build.

```sh
pnpm add -D migrane
pnpm add pg        # only if you use the bundled postgres driver
```

```ts
// database/config.ts
import { defineConfig } from 'migrane';
import { pgDriver } from 'migrane/drivers/pg';

export default defineConfig({
  dirs: ['./migrations'],
  seeds: './seeders',
  manifest: './manifest.gen.ts', // only if you ship a container
  driver: () => pgDriver(process.env.DATABASE_URL!),
});
```

```sh
migrane up | down | status
migrane reset | fresh [unit]
migrane seed <unit> | unseed <unit>
migrane manifest [--out <path>]
```

Config is looked for at `database/config.ts`, then `migrate.config.{ts,js,mjs}`,
or wherever `--config` points. Paths in it resolve against the config file, not
the working directory, so the commands answer the same from anywhere in a
repository.

## Exit codes

A code, never a sentence — what lets your tooling go fully through the CLI and
still distinguish outcomes by contract instead of matching stderr:

| code | meaning                                           |
| ---- | ------------------------------------------------- |
| 0    | ok                                                |
| 1    | failure                                           |
| 2    | refused: a migration changed after it was applied |
| 3    | refused: the guard said no                        |

## Runtimes

The published package is plain ES modules; the interesting question is who runs
_your_ config and migrations, because both may be TypeScript and the CLI loads
them with `import()`.

The executable answers it without being told. Its shebang names `sh`, and the
first line `exec`s the first of **node** then **bun** that is on `PATH` — so a
machine holding only bun runs it, and a machine holding node behaves exactly as
it always did.

- **node ≥ 22.18** strips types natively — `migrane up` just works.
- **bun** always ran TypeScript, and is taken when node is absent. To take it on
  a machine that has both, name it per command with `migrane --runtime=bun up`,
  or for the shell with `MIGRANE_RUNTIME=bun migrane up`. The flag wins, and
  must come first — it is read by the executable before any of this package
  runs, and never reaches the command surface.
  Node is preferred by default because **bun loads `.env` from the working
  directory and node does not** — and bun reads it from where you _ran_ the
  command, while everything else here resolves against the config file. A
  variable already set in the environment still wins, so in CI or a container
  both runtimes reach the same database; the difference shows up on a laptop,
  where `cd apps/api && migrane up` can pick up a different `.env` than the
  repository root. `bun --no-env-file` turns that off, for a project that wants
  bun without it.
- **older node** works when the config is `.js` and the migrations are `.sql`.
- **Windows** gets a `.cmd` shim that calls `sh`, which Git Bash provides.

## Writing a migration

A migration is `<number>-<slug>.ts`, `<number>-<slug>.sql`, or a directory of
that name. `001-initial` and `20260826143000-add-products` both work and can be
mixed, because ordering compares the number itself — `9-` sorts before `10-`
without anyone zero-padding.

```ts
import type { Part } from 'migrane';

export const up: Part['up'] = async ({ sql }) => {
  await sql`CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL)`;
};

export const down: Part['down'] = async ({ sql }) => {
  await sql`DROP TABLE users`;
};
```

`down` is optional. A great many migrations have no honest reverse, and a
required one only ever gets an empty body that lies about being reversible.

### The `sql` tag

Interpolations become **bind parameters**:

```ts
await sql`INSERT INTO users (email) VALUES (${email})`; // → $1
```

DDL is mostly things that cannot be parameters, so the escape is explicit and
visible in a diff:

|                       |                                                     |
| --------------------- | --------------------------------------------------- |
| `sql.raw(text)`       | splice verbatim                                     |
| `sql.id(name)`        | quote an identifier — `sql.id('order')` → `"order"` |
| `sql.join(fragments)` | a column list, a set of constraints                 |

A template that interpolates **nothing** sends no parameters, and may therefore
carry several statements separated by `;` — PostgreSQL only restricts a request
to one statement once a bind parameter is present.

The tag a migration receives is constructed by `createSql`, which is exported:
hand it anything with a `query(text, values)` and you hold the same tag —
`raw`, `id` and `join` included — over a connection this package did not open.
That is how a `before` hook runs against an ORM's connection, and it is the
only constructor for the `Sql` and `Fragment` types, so there is exactly one
way to spell `sql.raw` everywhere.

### Directory migrations

A directory is one migration made of parts. Two ways to order them, and the
choice is per directory:

**An `index.ts` is the migration.** The array it composes is the order, read top
to bottom in one place, and the files need no prefixes:

```
001-initial/
├── index.ts          compose([extensions, users, devices])
├── pg/extensions.ts
└── tables/users.ts, devices.ts
```

```ts
export const { up, down } = compose([extensions, users, devices]);
```

Order is _data_ here, not import order — which is what makes it survive an IDE
reordering the imports above it.

**Without an index**, every `.ts`/`.sql` file under the directory is composed in
path order, and the numbers carry the order:

```
001-initial/
├── 010-pg/010-extensions.ts
└── 020-tables/010-users.ts
```

Either way `up` runs forwards and `down` in reverse, so foreign keys hold in
both directions — and either way the checksum covers **every file**, including
parts only an index imports.

### `.sql` migrations

```sql
-- migrate:up
CREATE TABLE users (id uuid PRIMARY KEY);

-- migrate:down
DROP TABLE users;
```

Each section is sent as one statement. Splitting on `;` would be wrong the first
time a function body or a quoted string contained one.

## What it guarantees

- **Each migration commits in a transaction with the row that records it.** A
  failure can never leave DDL applied and the bookkeeping unwritten. Add
  `export const transaction = false` for `CREATE INDEX CONCURRENTLY` and friends
  — the runner says so on the line when it does.
- **A session advisory lock spans the run**, taken before the bookkeeping is
  read. Two containers starting at once is the ordinary case, not the exotic
  one, and without this both see the same empty table and both run the same DDL.
- **Editing an applied migration is refused**, by checksum, before anything
  runs. A recorded migration that is no longer on disk is _not_ an error —
  that is what squashing looks like from the database's side, and `status` says
  `orphan` rather than failing.
- **`status` never refuses.** An edited migration is the likeliest reason you
  are running it, so it reports `changed` and finishes the report rather than
  failing on the very thing you asked about. `up` and `down` still refuse, which
  is where refusing belongs.

## What it refuses to do

`down`, `reset`, `fresh`, `seed` and `unseed` all rewrite data somebody may be
using, so all five run through the config's `guard` before they touch anything —
on the functions themselves, so importing one directly does not walk around it.
`up` and `status` are never guarded.

**Declare no guard and every one of them refuses.** The library consults
nothing else: no `NODE_ENV`, no environment variable, no notion of which hosts
are local — locality was always a poor proxy, because on a droplet running
Postgres host-networked, production _is_ `127.0.0.1`. Which databases are
disposable is your config's opinion, and the config is the one place that
opinion is correct.

The refusal carries the fix. It names the exact coordinates the driver holds,
in a guard ready to paste once you have read them and decided that database is
yours to lose:

```
reset drops every table, and nothing says "app_dev" on "127.0.0.1" is disposable.
  If it is, say so in the config — the guard replaces this refusal:

    guard: (driver, what) => {
      if (driver.host === '127.0.0.1' && driver.database === 'app_dev') return;

      refuse(driver, what);
    },
```

A guard interrogates the **driver** — the config's own product, the one true
record of the connection — or queries through it, and ends with `refuse` for
whatever it does not allow. The strongest shape puts the permission on the
database itself, where it survives a schema drop, needs ownership to set, and
cannot be typed onto the wrong machine:

```sql
ALTER DATABASE preview SET migrane.disposable = 'yes';
```

```ts
// database/config.ts
import { defineConfig, refuse } from 'migrane';

export default defineConfig({
  // …
  guard: async (driver, what) => {
    const [row] = await driver.query<{ on: string | null }>(
      `SELECT current_setting('migrane.disposable', true) AS on`,
    );

    if (row?.on === 'yes') return; // this database says it is disposable

    refuse(driver, what);
  },
});
```

One guard, not a list. A guard yields a verdict, and combining verdicts needs
an operator a config field cannot spell — so write the composition you mean, as
above.

## Hooks

`before` runs once per `up`, on the pinned connection, ahead of anything
pending — and **even when nothing is pending**, because whether a hook needs to
run has nothing to do with whether a new migration was added.

```ts
before: [async ({ sql }) => void (await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`)],
```

It is the seam for anything you want true _before_ a migration but do not want
to write as one — types synced from a registry, a search path, an extension. It
is also the only place the runner will execute code it did not discover.
`status` and `reset` do not run hooks; neither has business writing DDL.

## Seeds

Seed units are **alternatives, not increments** — one directory is one dataset
and you run exactly one against a fresh database. A unit is recorded but never
refused: editing a fixture set and running it again is how one is used, so the
row moves rather than the insert failing.

`status` reads that row back as `current`, `changed since`, or `unit is gone` —
which answers _which fixtures is this database holding_, and is the only
question the table exists for.

Make a unit safe to run twice: `ON CONFLICT DO NOTHING`, `IF NOT EXISTS`, or
truncate first. Nothing above it will stop a second run.

## Shipping it in a container

Discovery is a directory read and loading is `import(file)` or `readFileSync`;
no bundler follows any of them, and an image has no directories. So the build
generates a **manifest** — imports and two arrays, and nothing else:

```sh
migrane manifest            # writes where `manifest` in the config points
migrane manifest --out gen/manifest.ts
```

Declare the destination rather than letting this package pick one — every
specifier in the manifest is written **relative to where it lands**, so
guessing where it goes would guess what is in it. With neither `manifest` nor
`--out`, the command says so instead of inventing a path. It opens no database,
which is what makes it a build step: nothing to connect to, and nothing it
could reach.

```ts
// @generated by migrane. DO NOT EDIT.
// Regenerated by every build; edits here are overwritten.

import * as m1_0 from '../migrations/002-backfill.ts';

export const migrations = [
  {
    name: '001-initial',
    sequence: 1,
    checksum: 'ab12…',
    parts: [{ sql: `…` }],
  },
  { name: '002-backfill', sequence: 2, checksum: '77aa…', parts: [m1_0] },
];

export const seeds = [];
```

The header is the file's own warning: `@generated` sits on the first line
because that is where IDEs and diff tools look for it. Gitignore the file —
every build rewrites it, so nothing done to it by hand survives.

A `.ts` part is imported, a `.sql` part is carried as text — the same split
loading makes, because it is the same split. A project written entirely in SQL
generates a manifest that imports nothing at all, which is to say: data.

The lists are discovery's own output, so the image applies the same units in
the same order and records the same checksums as the CLI. That agreement is the
whole reason this lives in the library rather than in your build script.

### The entry is yours

The manifest calls nothing, so nothing worth reading lives where a linter, a
checker and a test cannot reach it. What to do with the arrays is ordinary
source in your repository, over `migrane/ship` — which holds every job that
does not touch a filesystem, and nothing that does:

```ts
// database/migrate.ts
import { createPlans, status, up, withDriver } from 'migrane/ship';
import config from './config.ts';
import * as manifest from './manifest.gen.ts';

const [verb = 'up'] = process.argv.slice(2);
const plans = createPlans(config, manifest); // { migrations, seeds, reset }

process.exit(
  await withDriver(config, async (driver) => {
    try {
      if (verb === 'up') await up(driver, plans.migrations);
      else if (verb === 'status') await status(driver, plans.migrations);
      else throw new Error(`unknown command: ${verb}`);

      return 0;
    } catch (error) {
      console.error(error);

      return 1;
    }
  }),
);
```

The exit code is the contract a deploy reads: a one-shot migrate container that
exits non-zero holds the previous release in place rather than starting a server
against a schema that never got written. Waiting for the database is the
orchestrator's job, not the entry's — `depends_on: condition: service_healthy`
in a compose file says it where a timeout can be tuned without a release.

Offering `down`, `seed` or `reset` there is your call, not this package's — and
every one of them still runs through the guard above before it touches
anything.

## Writing a driver

Three methods and two coordinates, over a session that can lock and transact.
`drivers/pg.ts` is the reference, and `pg` is an optional peer dependency —
importing `migrane` does not reach it, only importing `migrane/drivers/pg`
does.

```ts
import type { Driver, Session } from 'migrane';

interface Driver {
  readonly host: string; // where these coordinates point; '' for a unix socket
  readonly database: string; // which database they open
  query(text, values?): Promise<Row[]>;
  session<T>(run: (session: Session) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface Session extends Queryable {
  transaction<T>(run: (tx: Queryable) => Promise<T>): Promise<T>;
  lock<T>(key: number, run: () => Promise<T>): Promise<T>;
}
```

`host` and `database` are required rather than optional-with-a-default because
they are what a guard matches on, and a driver that could leave them out would
be a driver that silently opts its databases out of every guard. State them
even when they are `'localhost'` and obvious.

`session` pins one connection: a lock and a transaction are only meaningful on a
connection that stays the same between statements, and a pool hands out
whichever is free.

`lock` is a **method rather than a statement the runner sends**, because taking
a lock is a database-agnostic idea and `SELECT pg_advisory_lock($1)` is not —
this package names no database, and that statement was the one place it did. It
takes and releases around `run`, so no caller can forget to give a lock back,
and it must block rather than fail: whoever holds it is applying the migrations
this process wants applied, so waiting is the correct outcome. Where a database
has nothing like one, a driver that runs one migrator at a time may implement it
as `run()` and say so.

One honest caveat: the core is agnostic by contract, PostgreSQL-first in
dialect. The `sql` tag emits `$n` placeholders, the bookkeeping tables use
`TIMESTAMPTZ`/`now()`, and `reset` speaks `DROP SCHEMA … CASCADE`. A driver for
another database is absolutely writable — its `query` translates what its
database spells differently — but that translation is the driver's job until a
second first-party driver moves the seams here.

## License

[MIT](LICENSE)
