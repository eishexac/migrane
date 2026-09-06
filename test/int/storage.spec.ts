import { beforeEach, describe, expect, it } from 'vitest';
import { applied, ensure, forget, record } from '../../src/storage.js';
import { database } from '../support/database.js';

/**
 * The bookkeeping table, against a database that actually has one.
 *
 * `storage.spec.ts` covers `verify`, which compares two arrays. Everything else
 * in the module is SQL, and none of it had been executed: whether `ensure` is
 * really idempotent, whether `applied` creates the table it reads, what the
 * primary key does to a migration recorded twice.
 */

const db = database('migrane_storage');
const TABLE = 'migrations';

const entry = (name: string, checksum = 'abc') => ({
  name,
  checksum,
  duration: 12,
});

// Every case starts on a database that has never been migrated, and arranges
// whatever more it needs. That `record` and `forget` need an `ensure` first is
// the point rather than an inconvenience: neither calls it, and they are
// entitled not to, because in the real flow `up` reads `applied` first and that
// is what creates the table.
beforeEach(async () => {
  await db().query(`DROP TABLE IF EXISTS "${TABLE}", "odd name"`);
});

describe('ensure', () => {
  it('creates the table', async () => {
    await ensure(db(), TABLE);

    expect(await applied(db(), TABLE)).toEqual([]);
  });

  it('is idempotent, which is what makes it safe on every command', async () => {
    await ensure(db(), TABLE);
    await record(db(), TABLE, entry('001-initial'));
    await ensure(db(), TABLE);

    // The second call must not have replaced the table, taking the row with it.
    expect(await applied(db(), TABLE)).toHaveLength(1);
  });

  it('quotes the table name', async () => {
    await ensure(db(), 'odd name');

    expect(await applied(db(), 'odd name')).toEqual([]);
  });
});

describe('applied', () => {
  it('answers on a database that has never been migrated', async () => {
    // The promise the module opens with: no setup command, so `status` against
    // an empty database says everything is pending rather than failing on a
    // missing table.
    expect(await applied(db(), TABLE)).toEqual([]);
  });

  it('returns what was recorded', async () => {
    await ensure(db(), TABLE);
    await record(db(), TABLE, entry('001-initial', 'sum-1'));

    const [row, ...rest] = await applied(db(), TABLE);

    expect(rest).toEqual([]);
    expect(row).toMatchObject({ name: '001-initial', checksum: 'sum-1' });
    expect(new Date(row!.run_at).getTime()).not.toBeNaN();
  });

  it('orders by when it ran, then by name', async () => {
    await ensure(db(), TABLE);

    for (const name of ['003-third', '001-first', '002-second']) {
      await record(db(), TABLE, entry(name));
    }

    // Insertion order, not alphabetical: what ran first is what comes back
    // first, which is what makes `down` reverse the right one.
    expect((await applied(db(), TABLE)).map((row) => row.name)).toEqual([
      '003-third',
      '001-first',
      '002-second',
    ]);
  });
});

describe('record', () => {
  it('refuses the same migration twice', async () => {
    await ensure(db(), TABLE);
    await record(db(), TABLE, entry('001-initial'));

    // The primary key is the guard against a double-apply surviving as two
    // rows, which would make `down` revert one and leave the other.
    await expect(record(db(), TABLE, entry('001-initial'))).rejects.toThrow(
      /duplicate key/,
    );
  });
});

describe('forget', () => {
  it('removes one migration and leaves the rest', async () => {
    await ensure(db(), TABLE);
    await record(db(), TABLE, entry('001-initial'));
    await record(db(), TABLE, entry('002-products'));

    await forget(db(), TABLE, '001-initial');

    expect((await applied(db(), TABLE)).map((row) => row.name)).toEqual([
      '002-products',
    ]);
  });

  it('says nothing about a migration that was never there', async () => {
    await ensure(db(), TABLE);

    await expect(forget(db(), TABLE, '404-absent')).resolves.toBeUndefined();
  });
});
