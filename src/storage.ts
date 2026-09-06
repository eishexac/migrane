import { quoteIdent } from './sql.js';
import type { Queryable, Row } from './types.js';

/**
 * The bookkeeping table, and the two questions it answers: what has run, and
 * whether what ran is still what is on disk.
 */

export interface Applied extends Row {
  name: string;
  checksum: string;
  run_at: string;
}

/**
 * A migration was edited after it was applied.
 *
 * A class rather than a plain `Error` so a caller that *knows* its database is
 * disposable — a test lane, a scratch container — can recover from exactly this
 * and nothing else. Matching on the message would catch the next error whose
 * wording happened to look similar, which is how a recovery path ends up
 * dropping a schema it was never meant to touch.
 */
export class MigrationChangedError extends Error {
  constructor(public readonly migration: string) {
    super(
      `"${migration}" changed after it was applied.\n` +
        `  Reset the database if it is disposable, or add a new migration if it is not.`,
    );
    this.name = 'MigrationChangedError';
  }
}

/**
 * Written on first contact rather than by a setup command, so a database that
 * has never been migrated needs no preparation — `status` against an empty one
 * answers "everything is pending" instead of failing on a missing table.
 */
export const ensure = async (db: Queryable, table: string): Promise<void> => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (
      name         TEXT PRIMARY KEY,
      checksum     TEXT NOT NULL DEFAULT '',
      run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms  INTEGER
    )
  `);
};

export const applied = async (
  db: Queryable,
  table: string,
): Promise<Applied[]> => {
  await ensure(db, table);

  return db.query<Applied>(
    `SELECT name, checksum, run_at FROM ${quoteIdent(table)} ORDER BY run_at, name`,
  );
};

/**
 * Refuses a migration that changed after it was applied.
 *
 * A migration already run is a fact about the database, and editing one makes
 * the file stop describing what the database actually holds — silently, and
 * only on the machines that already ran it. So it is caught before anything
 * else runs.
 *
 * A name recorded but absent from disk is *not* an error: deleting or renaming
 * migrations is what squashing them into one looks like, and refusing that
 * would make a legitimate operation impossible.
 */
export const verify = (
  rows: readonly Applied[],
  migrations: readonly { name: string; checksum: string }[],
): void => {
  const disk = new Map(
    migrations.map(({ name, checksum }) => [name, checksum]),
  );

  for (const row of rows) {
    const current = disk.get(row.name);

    if (current === undefined || current === row.checksum) continue;

    throw new MigrationChangedError(row.name);
  }
};

export const record = async (
  db: Queryable,
  table: string,
  entry: { name: string; checksum: string; duration: number },
): Promise<void> => {
  await db.query(
    `INSERT INTO ${quoteIdent(table)} (name, checksum, duration_ms) VALUES ($1, $2, $3)`,
    [entry.name, entry.checksum, entry.duration],
  );
};

export const forget = async (
  db: Queryable,
  table: string,
  name: string,
): Promise<void> => {
  await db.query(`DELETE FROM ${quoteIdent(table)} WHERE name = $1`, [name]);
};
