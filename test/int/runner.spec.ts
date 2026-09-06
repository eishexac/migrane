import { beforeEach, describe, expect, it } from 'vitest';
import type { Migration, Module } from 'migrane';
import {
  MigrationChangedError,
  down,
  status,
  up,
  type Plan,
  type Progress,
} from 'migrane/ship';
import { applied } from '../../src/storage.js';
import { database } from '../support/database.js';

/**
 * What the runner promises, against a database that can refuse it.
 *
 * `runner.spec.ts` in `src/` drives a fake driver, which answers what it was
 * told. It cannot answer the question this file exists for: whether a failed
 * migration actually left the schema alone. That is a property of PostgreSQL's
 * rollback, not of the runner's control flow, and the two are only the same
 * thing when they really are.
 */

const db = database('migrane_runner');

const TABLE = 'migrations';

const migration = (
  name: string,
  module: Module,
  checksum = `sum-${name}`,
): Migration => ({ name, sequence: 1, checksum, module });

/** Creates a table named after itself, and drops it again on the way down. */
const creates = (name: string, table: string): Migration =>
  migration(name, {
    up: async ({ sql }) => {
      await sql`CREATE TABLE ${sql.id(table)} (id int)`;
    },
    down: async ({ sql }) => {
      await sql`DROP TABLE ${sql.id(table)}`;
    },
  });

const recorded = () =>
  applied(db(), TABLE).then((rows) => rows.map((row) => row.name));

const exists = (table: string) =>
  db()
    .query<{ found: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS found`, [
      table,
    ])
    .then((rows) => rows[0]?.found ?? false);

const lines: string[] = [];
const reporter: Progress = { line: (text) => void lines.push(text) };

const plan = (migrations: Migration[], before?: Plan['before']): Plan => ({
  migrations,
  table: TABLE,
  before,
  // A guardless plan refuses every `down` before the part under test here.
  guard: () => {},
});

beforeEach(async () => {
  // The whole schema, not just the bookkeeping: these cases create tables, and
  // one of them deliberately leaves one behind.
  await db().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  lines.length = 0;
});

describe('up', () => {
  it('applies what is pending and records it', async () => {
    await up(db(), plan([creates('001-people', 'people')]), reporter);

    expect(await exists('people')).toBe(true);
    expect(await recorded()).toEqual(['001-people']);
  });

  it('does nothing the second time', async () => {
    const only = plan([creates('001-people', 'people')]);

    await up(db(), only, reporter);
    lines.length = 0;

    // The second run must not re-run the migration — `CREATE TABLE` would fail,
    // so a runner that ignored the bookkeeping could not even be silently wrong
    // here. It could be for a migration that is merely not idempotent.
    await expect(up(db(), only, reporter)).resolves.toEqual([]);
    expect(lines).toContain('nothing to do');
  });

  it('leaves nothing behind when a migration fails', async () => {
    const failing = migration('001-half', {
      up: async ({ sql }) => {
        await sql`CREATE TABLE half_written (id int)`;
        throw new Error('the second statement failed');
      },
    });

    await expect(up(db(), plan([failing]), reporter)).rejects.toThrow(
      'the second statement failed',
    );

    // The promise the module opens with: never the state where the DDL ran and
    // the bookkeeping did not.
    expect(await exists('half_written')).toBe(false);
    expect(await recorded()).toEqual([]);
  });

  it('does leave something behind when the migration opted out', async () => {
    const failing = migration('001-half', {
      up: async ({ sql }) => {
        await sql`CREATE TABLE half_written (id int)`;
        throw new Error('the second statement failed');
      },
    });

    failing.module.transaction = false;

    await expect(up(db(), plan([failing]), reporter)).rejects.toThrow(
      'the second statement failed',
    );

    // Stated as a case because it is the cost of the opt-out, and an operator
    // reading `(untransacted)` in the output needs it to mean something exact:
    // the schema changed, the row did not.
    expect(await exists('half_written')).toBe(true);
    expect(await recorded()).toEqual([]);
    expect(lines).toContain('  (untransacted)');
  });

  it('refuses a migration that changed after it was applied', async () => {
    await up(db(), plan([creates('001-people', 'people')]), reporter);

    const edited = creates('001-people', 'people');
    edited.checksum = 'edited';

    await expect(up(db(), plan([edited]), reporter)).rejects.toThrow(
      MigrationChangedError,
    );
  });

  it('runs its hooks even when no migration is pending', async () => {
    await up(
      db(),
      plan(
        [],
        [
          async ({ sql }) => {
            await sql`CREATE TABLE synced (id int)`;
          },
        ],
      ),
      reporter,
    );

    // Before the pending check, not after: a hook syncs what a migration may
    // reference, and needing to sync has nothing to do with whether anyone
    // wrote a new migration.
    expect(await exists('synced')).toBe(true);
    expect(lines).toContain('nothing to do');
  });
});

describe('down', () => {
  it('reverts the last applied migration and forgets it', async () => {
    const both = plan([
      creates('001-people', 'people'),
      creates('002-orders', 'orders'),
    ]);

    await up(db(), both, reporter);
    await down(db(), both, reporter);

    expect(await exists('orders')).toBe(false);
    expect(await exists('people')).toBe(true);
    expect(await recorded()).toEqual(['001-people']);
  });

  it('refuses one that has no down', async () => {
    const irreversible = migration('001-backfill', {
      up: async ({ sql }) => {
        await sql`CREATE TABLE backfilled (id int)`;
      },
    });

    await up(db(), plan([irreversible]), reporter);

    await expect(down(db(), plan([irreversible]), reporter)).rejects.toThrow(
      /cannot be reverted/,
    );

    // The refusal must not have taken the bookkeeping with it.
    expect(await recorded()).toEqual(['001-backfill']);
  });
});

describe('status', () => {
  it('writes nothing', async () => {
    await status(
      db(),
      plan(
        [creates('001-people', 'people')],
        [
          async ({ sql }) => {
            await sql`CREATE TABLE must_not_exist (id int)`;
          },
        ],
      ),
      reporter,
    );

    // Asking a database what it holds must not change what it holds — including
    // by running the hooks, which `up` runs and this deliberately does not.
    expect(await exists('must_not_exist')).toBe(false);
    expect(await exists('people')).toBe(false);
  });

  it('names a migration the database has but the disk does not', async () => {
    await up(db(), plan([creates('001-people', 'people')]), reporter);
    lines.length = 0;

    await status(db(), plan([]), reporter);

    // What a squash looks like from the database's side.
    expect(lines.join('\n')).toContain('orphan   001-people');
  });
});
