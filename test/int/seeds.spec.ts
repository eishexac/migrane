import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  seed,
  seedStatus,
  unseed,
  type Progress,
  type SeedPlan,
} from 'migrane/ship';
import { loadAll, unitsIn } from '../../src/discover.js';
import { database } from '../support/database.js';

/**
 * Fixtures, and the one rule that separates them from migrations: a unit is
 * recorded but never refused.
 *
 * Editing a fixture set and running it again is the normal way to use one, so
 * the second run has to move the row rather than fail on its primary key — the
 * opposite of what `verify` does to an edited migration. That is an upsert
 * against a real primary key, which is why it belongs in this lane.
 */

const db = database('migrane_seeds');

const DIR = join(import.meta.dirname, '..', 'fixtures', 'seeds');

// Discovered and loaded once, here, because that is the split under test: every
// case below hands the executor units it did not read off a disk, which is the
// same thing a generated manifest does inside an image.
const plan: SeedPlan = {
  units: await loadAll(unitsIn(DIR)),
  table: 'seeds',
  // A guardless plan refuses every `seed` and `unseed` before the part under
  // test here.
  guard: () => {},
};

const lines: string[] = [];
const reporter: Progress = { line: (text) => void lines.push(text) };

const widgets = () =>
  db()
    .query<{ name: string }>('SELECT name FROM widgets ORDER BY name')
    .then((rows) => rows.map((row) => row.name));

const recorded = () =>
  db().query<{ name: string; run_at: string }>(
    'SELECT name, run_at FROM seeds ORDER BY name',
  );

beforeEach(async () => {
  await db().query(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    CREATE TABLE widgets (name text)
  `);
  lines.length = 0;
});

describe('unitsIn', () => {
  it('lists every directory under the root, sorted', () => {
    expect(unitsIn(DIR).map(({ name }) => name)).toEqual(['demo', 'no-down']);
  });

  it('skips a directory holding nothing runnable', () => {
    // `hollow/` is a name with no fixture in it yet, which is ordinary work in
    // progress — the same thing `discover` does with an empty migration
    // directory rather than refusing it.
    expect(unitsIn(DIR).map(({ name }) => name)).not.toContain('hollow');
  });

  it('is empty for a root that does not exist', () => {
    // A consumer with no seeds at all is the ordinary case, not an error.
    expect(unitsIn(join(DIR, 'nowhere'))).toEqual([]);
  });
});

describe('seed', () => {
  it('runs the unit and records it', async () => {
    await seed(db(), plan, 'demo', reporter);

    expect(await widgets()).toEqual(['one', 'two']);
    expect((await recorded()).map((row) => row.name)).toEqual(['demo']);
    expect(lines).toContain('seeded demo');
  });

  it('can be run again, moving the row rather than failing', async () => {
    await seed(db(), plan, 'demo', reporter);
    const [before] = await recorded();

    await seed(db(), plan, 'demo', reporter);
    const after = await recorded();

    // One row, not two, and not a duplicate-key error: units are alternatives
    // you re-run, so the primary key has to be upserted through.
    expect(after).toHaveLength(1);
    expect(await widgets()).toEqual(['one', 'one', 'two', 'two']);
    expect(new Date(after[0]!.run_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before!.run_at).getTime(),
    );
  });

  it('leaves nothing behind when the fixture fails', async () => {
    await db().query('DROP TABLE widgets');

    // The insert and the bookkeeping share one transaction, so a fixture that
    // fails half way cannot leave a database claiming to hold it.
    await expect(seed(db(), plan, 'demo', reporter)).rejects.toThrow(
      /does not exist/,
    );
    expect(await recorded()).toEqual([]);
  });

  it('refuses a unit that is not there', async () => {
    await expect(seed(db(), plan, 'absent', reporter)).rejects.toThrow(
      /"absent" does not exist/,
    );
  });

  it('refuses a unit the plan does not carry', async () => {
    // `hollow/` is on disk and is not a unit, so the executor — which is handed
    // units rather than a directory — cannot tell it from a name never written.
    await expect(seed(db(), plan, 'hollow', reporter)).rejects.toThrow(
      /"hollow" does not exist/,
    );
  });
});

describe('unseed', () => {
  it('reverts the unit and forgets it', async () => {
    await seed(db(), plan, 'demo', reporter);
    await unseed(db(), plan, 'demo', reporter);

    expect(await widgets()).toEqual([]);
    expect(await recorded()).toEqual([]);
    expect(lines).toContain('unseeded demo');
  });

  it('refuses a unit with no down', async () => {
    await seed(db(), plan, 'no-down', reporter);

    await expect(unseed(db(), plan, 'no-down', reporter)).rejects.toThrow(
      /has no "down"/,
    );

    // The refusal must leave the record alone: the database still holds those
    // fixtures, and saying otherwise would be worse than refusing.
    expect((await recorded()).map((row) => row.name)).toEqual(['no-down']);
  });
});

describe('seedStatus', () => {
  it('says nothing about a database that has never been seeded', async () => {
    expect(await seedStatus(db(), plan, reporter)).toEqual([]);
  });

  it('reports the unit in place as current', async () => {
    await seed(db(), plan, 'demo', reporter);
    lines.length = 0;

    await seedStatus(db(), plan, reporter);

    expect(lines.join('\n')).toMatch(/seeded {3}demo .* \(current\)/);
  });

  it('reports a unit that is no longer on disk', async () => {
    await seed(db(), plan, 'demo', reporter);
    lines.length = 0;

    // How a database seeded from a deleted branch explains itself: the row is
    // read from the database, so it answers even when the plan no longer
    // carries the unit — a later image built without it included.
    await seedStatus(db(), { ...plan, units: [] }, reporter);

    expect(lines.join('\n')).toContain('(unit is gone)');
  });
});
