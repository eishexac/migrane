import { beforeEach, describe, expect, it } from 'vitest';
import { reset, type Progress } from 'migrane/ship';
import { pgDriver } from 'migrane/drivers/pg';
import { database } from '../support/database.js';

/**
 * The most destructive thing in the package, against a schema it can really
 * empty.
 *
 * `safety.spec.ts` covers the refusal itself over fake drivers. What it cannot
 * cover is the half that matters here: that `DROP SCHEMA … CASCADE` followed by
 * `CREATE SCHEMA` leaves a database that is empty rather than unusable, and
 * that the refusal happens before a connection is ever opened.
 */

const db = database('migrane_reset');

const lines: string[] = [];
const reporter: Progress = { line: (text) => void lines.push(text) };

const tables = () =>
  db()
    .query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    )
    .then((rows) => rows.map((row) => row.name));

beforeEach(async () => {
  await db().query(
    'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public',
  );
  lines.length = 0;
});

describe('reset', () => {
  it('drops everything in the schema and leaves the schema usable', async () => {
    await db().query(
      'CREATE TABLE people (id int); CREATE TABLE orders (id int)',
    );
    expect(await tables()).toEqual(['orders', 'people']);

    await reset(db(), { schema: 'public', guard: () => {} }, reporter);

    expect(await tables()).toEqual([]);
    // Recreated, not merely dropped — the next migration has to have somewhere
    // to run, and a database with no `public` is not an empty database.
    await expect(
      db().query('CREATE TABLE after (id int)'),
    ).resolves.toBeDefined();
    expect(lines).toContain('schema dropped');
  });

  it('takes a view and a sequence with it', async () => {
    // CASCADE is the reason this is one statement rather than a table loop: an
    // object that depends on another has to go without being named.
    await db().query(`
      CREATE TABLE people (id serial PRIMARY KEY);
      CREATE VIEW everyone AS SELECT * FROM people
    `);

    await reset(db(), { schema: 'public', guard: () => {} }, reporter);

    const rows = await db().query<{ count: string }>(
      `SELECT count(*) FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'`,
    );

    expect(rows[0]?.count).toBe('0');
  });

  it('works on a database whose schema is already gone', async () => {
    await db().query('DROP SCHEMA public CASCADE');

    // `IF EXISTS`, so a reset interrupted half way can simply be run again.
    await expect(
      reset(db(), { schema: 'public', guard: () => {} }, reporter),
    ).resolves.toBeUndefined();
    expect(await tables()).toEqual([]);
  });

  it('refuses a guardless plan before it connects', async () => {
    // The host is unreachable on purpose: if the refusal ran after the
    // connection this would fail with a DNS or timeout error instead.
    const remote = pgDriver('postgres://someone@db.invalid:5432/production');

    await expect(reset(remote, { schema: 'public' }, reporter)).rejects.toThrow(
      /"production" on "db\.invalid" is disposable/,
    );

    await remote.close();
  });
});
