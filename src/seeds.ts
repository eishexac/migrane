import { DEFAULTS } from './defaults.js';
import { toConsole, type Progress } from './runner.js';
import { refuse } from './safety.js';
import { createSql, quoteIdent } from './sql.js';
import type {
  Config,
  Driver,
  Guard,
  Migration,
  Queryable,
  Row,
} from './types.js';

/**
 * Seed units — fixtures, and the deliberate opposite of a migration.
 *
 * Units are **alternatives, not increments**: one directory is one dataset and
 * you run exactly one against a fresh database. So a unit is recorded but never
 * refused — editing a fixture set and running it again is how one is used.
 *
 * The row answers a different question from a migration's: *which fixtures is
 * this database holding, and do they still match the units in hand.*
 *
 * Split the way migrations are: `unitsIn` in `discover.ts` reads a directory,
 * everything here takes units already loaded. A seed that loads itself cannot
 * ship, and an image has no `seeders/` directory to load from.
 */

export interface Seeded extends Row {
  name: string;
  checksum: string;
  run_at: string;
}

const ensure = async (db: Queryable, table: string): Promise<void> => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (
      name      TEXT PRIMARY KEY,
      checksum  TEXT NOT NULL DEFAULT '',
      run_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
};

export interface SeedPlan {
  /**
   * The units, already loaded — `loadAll(unitsIn(dir))` on a developer machine,
   * and a generated array in an image. Paths are deliberately absent: where a
   * unit came from was discovery's problem, and the code that runs it is the
   * same code in both places.
   */
  units: readonly Migration[];
  table: string;
  /** Consulted by `seed` and `unseed`. Defaults to `refuse`. */
  guard?: Guard;
}

/**
 * A seed plan from a config and units already loaded — `planFrom`'s twin, and
 * defaulting its table from the same constant for the same reason.
 */
export const seedPlanFrom = (
  config: Config,
  units: readonly Migration[],
): SeedPlan => ({
  units,
  table: config.seedTable ?? DEFAULTS.seedTable,
  guard: config.guard,
});

/**
 * Picking the named unit out of the plan.
 *
 * The message says *does not exist* rather than naming a directory, because by
 * here there is no directory to name — only the units this plan was handed.
 */
const chosen = (plan: SeedPlan, unit: string): Migration => {
  const found = plan.units.find(({ name }) => name === unit);

  if (!found) throw new Error(`seed unit "${unit}" does not exist.`);

  return found;
};

export const seed = async (
  driver: Driver,
  plan: SeedPlan,
  unit: string,
  reporter: Progress = toConsole,
): Promise<void> => {
  // Guarded like `reset`, and for the same reason rather than a lesser one: a
  // unit is allowed to truncate before it inserts, so "it only adds rows" is
  // not something the runner can promise about somebody's fixtures.
  await (plan.guard ?? refuse)(driver, 'seed writes fixtures');

  const loaded = chosen(plan, unit);

  await driver.session(async (session) => {
    await ensure(session, plan.table);

    await session.transaction(async (tx) => {
      await loaded.module.up({ sql: createSql(tx), db: tx });

      // Upserted, not inserted: seeding the same unit twice is expected, and
      // should move the timestamp rather than fail on the primary key.
      await tx.query(
        `INSERT INTO ${quoteIdent(plan.table)} (name, checksum) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE
              SET checksum = excluded.checksum, run_at = now()`,
        [unit, loaded.checksum],
      );
    });
  });

  reporter.line(`seeded ${unit}`);
};

export const unseed = async (
  driver: Driver,
  plan: SeedPlan,
  unit: string,
  reporter: Progress = toConsole,
): Promise<void> => {
  await (plan.guard ?? refuse)(
    driver,
    'unseed deletes rows a fixture set made',
  );

  const loaded = chosen(plan, unit);
  const revert = loaded.module.down;

  if (!revert) throw new Error(`seed unit "${unit}" has no "down".`);

  await driver.session(async (session) => {
    await ensure(session, plan.table);

    await session.transaction(async (tx) => {
      await revert({ sql: createSql(tx), db: tx });
      await tx.query(`DELETE FROM ${quoteIdent(plan.table)} WHERE name = $1`, [
        unit,
      ]);
    });
  });

  reporter.line(`unseeded ${unit}`);
};

/**
 * What this database was seeded with, and whether that unit still matches disk.
 *
 * Read from the database rather than inferred from a checkout, which is the
 * point: the plan tells you which units exist, only the row tells you which one
 * you are looking at. A unit the plan no longer carries still reports — it is
 * how a database seeded from a deleted branch explains itself, and how an image
 * explains fixtures that were dropped from a later build.
 */
export const seedStatus = async (
  driver: Driver,
  plan: SeedPlan,
  reporter: Progress = toConsole,
): Promise<Seeded[]> => {
  await ensure(driver, plan.table);

  const rows = await driver.query<Seeded>(
    `SELECT name, checksum, run_at FROM ${quoteIdent(plan.table)} ORDER BY run_at DESC`,
  );

  const present = new Map(
    plan.units.map(({ name, checksum }) => [name, checksum]),
  );

  for (const row of rows) {
    const held = present.get(row.name);

    const state =
      held === undefined
        ? 'unit is gone'
        : held === row.checksum
          ? 'current'
          : 'changed since';

    const on = new Date(row.run_at)
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ');

    reporter.line(`  seeded   ${row.name}  ${on}  (${state})`);
  }

  return rows;
};
