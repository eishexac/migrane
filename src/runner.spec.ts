import { describe, expect, it } from 'vitest';
import { lockKey } from './lock.js';
import { down, status, up, type Plan, type Progress } from './runner.js';
import type { Driver, Migration, Queryable, Row, Session } from './types.js';

/**
 * The runner against a fake driver.
 *
 * A fake rather than real Postgres because what is being tested is the runner's
 * own decisions — what is pending, what gets wrapped, what order things happen
 * in — and those are decisions it makes before any SQL is sent. The driver
 * itself is sixty lines with no branches; `drivers/pg.ts` is what a real
 * database would be testing.
 */

interface Fake extends Driver {
  log: string[];
  rows: { name: string; checksum: string; run_at: string }[];
  /** Every key `lock` was asked for, in order. */
  keys: number[];
}

const fakeDriver = (): Fake => {
  const log: string[] = [];
  const keys: number[] = [];
  const rows: { name: string; checksum: string; run_at: string }[] = [];

  const query = <R extends Row = Row>(
    text: string,
    values?: readonly unknown[],
  ): Promise<R[]> => {
    const sql = text.trim().split('\n')[0]?.trim() ?? '';

    if (sql.startsWith('SELECT name, checksum')) {
      log.push('read');

      return Promise.resolve(rows as unknown as R[]);
    }

    if (sql.startsWith('INSERT INTO')) {
      log.push(`record ${String(values?.[0])}`);
      rows.push({
        name: String(values?.[0]),
        checksum: String(values?.[1]),
        run_at: '2026-08-27T00:00:00.000Z',
      });

      return Promise.resolve([] as R[]);
    }

    if (sql.startsWith('DELETE FROM')) {
      log.push(`forget ${String(values?.[0])}`);
      const index = rows.findIndex((row) => row.name === values?.[0]);
      if (index !== -1) rows.splice(index, 1);

      return Promise.resolve([] as R[]);
    }

    if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) log.push('ensure');

    return Promise.resolve([] as R[]);
  };

  const queryable: Queryable = { query };

  const session: Session = {
    query,

    // Logged here rather than sniffed out of a SQL string, which is the point
    // of the method existing: the runner asks for a lock, and what that costs
    // in statements is the driver's business and no longer visible from here.
    async lock<T>(key: number, run: () => Promise<T>): Promise<T> {
      log.push('lock');
      keys.push(key);

      try {
        return await run();
      } finally {
        log.push('unlock');
      }
    },

    async transaction<T>(run: (tx: Queryable) => Promise<T>): Promise<T> {
      log.push('begin');

      try {
        const result = await run(queryable);
        log.push('commit');

        return result;
      } catch (error) {
        log.push('rollback');
        throw error;
      }
    },
  };

  return {
    query,
    log,
    rows,
    keys,
    host: 'localhost',
    database: 'fake',
    session: (run) => run(session),
    close: async () => {},
  };
};

const migration = (
  name: string,
  log: string[],
  overrides: Partial<Migration['module']> = {},
): Migration => ({
  name,
  sequence: Number(name.split('-')[0]),
  checksum: `sum-${name}`,
  module: {
    up: () => Promise.resolve(void log.push(`up:${name}`)),
    down: () => Promise.resolve(void log.push(`down:${name}`)),
    ...overrides,
  },
});

const collect = (): Progress & { lines: string[] } => {
  const lines: string[] = [];

  return { lines, line: (text) => lines.push(text) };
};

const planOf = (migrations: Migration[]): Plan => ({
  migrations,
  table: 'migrations',
});

/** A guardless plan refuses every `down`, so cases about `down` itself allow. */
const allowed = (migrations: Migration[]): Plan => ({
  ...planOf(migrations),
  guard: () => {},
});

describe('up', () => {
  it('applies pending migrations in order and records each one', async () => {
    const driver = fakeDriver();
    const ran: string[] = [];

    await up(
      driver,
      planOf([migration('001-a', ran), migration('002-b', ran)]),
      collect(),
    );

    expect(ran).toEqual(['up:001-a', 'up:002-b']);
    expect(driver.rows.map((row) => row.name)).toEqual(['001-a', '002-b']);
  });

  it('skips what is already applied', async () => {
    const driver = fakeDriver();
    const ran: string[] = [];

    driver.rows.push({
      name: '001-a',
      checksum: 'sum-001-a',
      run_at: '2026-08-27T00:00:00.000Z',
    });

    await up(
      driver,
      planOf([migration('001-a', ran), migration('002-b', ran)]),
      collect(),
    );

    expect(ran).toEqual(['up:002-b']);
  });

  it('commits each migration with its own bookkeeping row', async () => {
    // The property that matters: a failure can never leave DDL applied with the
    // row unwritten, because both are in the same transaction.
    const driver = fakeDriver();

    await up(driver, planOf([migration('001-a', [])]), collect());

    expect(driver.log).toEqual([
      'lock',
      'ensure',
      'read',
      'begin',
      'record 001-a',
      'commit',
      'unlock',
    ]);
  });

  // The runner asks the driver to lock; which key it asks for is its own
  // decision, and it has to be the one derived from the bookkeeping table so
  // two applications sharing a database do not block each other.
  it('locks on the key derived from the table it records in', async () => {
    const driver = fakeDriver();

    await up(driver, planOf([migration('001-a', [])]), collect());

    expect(driver.keys).toEqual([lockKey('migrations')]);
  });

  it('rolls back and stops when a migration throws', async () => {
    const driver = fakeDriver();
    const ran: string[] = [];

    await expect(
      up(
        driver,
        planOf([
          migration('001-a', ran),
          migration('002-b', ran, {
            up: () => {
              throw new Error('boom');
            },
          }),
          migration('003-c', ran),
        ]),
        collect(),
      ),
    ).rejects.toThrow('boom');

    expect(ran).toEqual(['up:001-a']);
    expect(driver.rows.map((row) => row.name)).toEqual(['001-a']);
    expect(driver.log).toContain('rollback');
  });

  it('releases the lock even when a migration throws', async () => {
    const driver = fakeDriver();

    await expect(
      up(
        driver,
        planOf([
          migration('001-a', [], {
            up: () => {
              throw new Error('boom');
            },
          }),
        ]),
        collect(),
      ),
    ).rejects.toThrow();

    expect(driver.log.at(-1)).toBe('unlock');
  });

  it('does not wrap a migration that opted out', async () => {
    const driver = fakeDriver();

    await up(
      driver,
      planOf([migration('001-a', [], { transaction: false })]),
      collect(),
    );

    expect(driver.log).not.toContain('begin');
  });

  it('runs hooks before pending migrations, and even when none are pending', async () => {
    // A hook syncs things a migration may reference, and whether it needs
    // syncing has nothing to do with whether a new migration was added.
    const driver = fakeDriver();
    const ran: string[] = [];

    driver.rows.push({
      name: '001-a',
      checksum: 'sum-001-a',
      run_at: '2026-08-27T00:00:00.000Z',
    });

    await up(
      driver,
      {
        ...planOf([migration('001-a', ran)]),
        before: [() => Promise.resolve(void ran.push('hook'))],
      },
      collect(),
    );

    expect(ran).toEqual(['hook']);
  });

  it('refuses to run anything when an applied migration was edited', async () => {
    const driver = fakeDriver();
    const ran: string[] = [];

    driver.rows.push({
      name: '001-a',
      checksum: 'stale',
      run_at: '2026-08-27T00:00:00.000Z',
    });

    await expect(
      up(
        driver,
        planOf([migration('001-a', ran), migration('002-b', ran)]),
        collect(),
      ),
    ).rejects.toThrow(/changed after it was applied/);

    expect(ran).toEqual([]);
  });

  it('says so when there is nothing to do', async () => {
    const driver = fakeDriver();
    const reporter = collect();

    await up(driver, planOf([]), reporter);

    expect(reporter.lines).toEqual(['nothing to do']);
  });
});

describe('down', () => {
  it('reverts only the most recently applied migration', async () => {
    const driver = fakeDriver();
    const ran: string[] = [];

    for (const name of ['001-a', '002-b']) {
      driver.rows.push({
        name,
        checksum: `sum-${name}`,
        run_at: '2026-08-27T00:00:00.000Z',
      });
    }

    await down(
      driver,
      allowed([migration('001-a', ran), migration('002-b', ran)]),
      collect(),
    );

    expect(ran).toEqual(['down:002-b']);
    expect(driver.rows.map((row) => row.name)).toEqual(['001-a']);
  });

  it('refuses a migration that has no down', async () => {
    const driver = fakeDriver();

    driver.rows.push({
      name: '001-a',
      checksum: 'sum-001-a',
      run_at: '2026-08-27T00:00:00.000Z',
    });

    await expect(
      down(
        driver,
        allowed([migration('001-a', [], { down: undefined })]),
        collect(),
      ),
    ).rejects.toThrow(/cannot be reverted/);
  });

  // The guard sits on the function rather than on an entrypoint's command
  // table, because a table only speaks for the callers that read it. It runs
  // before the driver is touched, so a refused database is never even
  // connected to — and a plan that declares no guard refuses everything,
  // however local the database looks.
  it('refuses when the plan declares no guard, before it connects', async () => {
    const driver = fakeDriver();

    await expect(
      down(driver, planOf([migration('001-a', [])]), collect()),
    ).rejects.toThrow(/is disposable/);

    expect(driver.log).toEqual([]);
  });

  /**
   * The seam is fail-closed in both directions: a plan without a guard gets
   * the refusal, and one with a guard gets exactly that guard — which may
   * allow what the default never would, because the config is where that
   * opinion is correct.
   */
  it('takes a plan’s guard in place of the default refusal', async () => {
    const driver = { ...fakeDriver(), host: 'db.example.com' };
    const asked: string[] = [];

    driver.rows.push({
      name: '001-a',
      checksum: 'sum-001-a',
      run_at: '2026-08-27T00:00:00.000Z',
    });

    await down(
      driver,
      {
        ...planOf([migration('001-a', [])]),
        guard: (_, what) => void asked.push(what),
      },
      collect(),
    );

    // Reverted against a host the default would have refused, and the guard
    // was told what it was authorising rather than merely being called.
    expect(driver.rows).toEqual([]);
    expect(asked).toEqual(['down reverts a migration']);
  });

  it('refuses when the plan’s guard refuses', async () => {
    const driver = fakeDriver();

    await expect(
      down(
        driver,
        {
          ...planOf([migration('001-a', [])]),
          guard: () => Promise.reject(new Error('this database is not mine')),
        },
        collect(),
      ),
    ).rejects.toThrow(/not mine/);

    expect(driver.log).toEqual([]);
  });

  it('says so when nothing is applied', async () => {
    const reporter = collect();

    await down(fakeDriver(), allowed([migration('001-a', [])]), reporter);

    expect(reporter.lines).toEqual(['nothing to do']);
  });
});

describe('status', () => {
  it('reports applied and pending in the order they would run', async () => {
    const driver = fakeDriver();

    driver.rows.push({
      name: '001-a',
      checksum: 'sum-001-a',
      run_at: '2026-08-27T00:00:00.000Z',
    });

    const result = await status(
      driver,
      planOf([migration('001-a', []), migration('002-b', [])]),
      collect(),
    );

    expect(result).toEqual([
      { name: '001-a', applied: true, changed: false },
      { name: '002-b', applied: false, changed: false },
    ]);
  });

  /**
   * An edited migration is the most likely reason somebody is running this
   * command, so it is the one case `status` must not answer with a stack trace
   * and no lines. `up` still refuses — that is where refusing belongs.
   */
  it('reports an edited migration instead of refusing to say anything', async () => {
    const driver = fakeDriver();
    const reporter = collect();

    driver.rows.push({
      name: '001-a',
      checksum: 'applied-as-something-else',
      run_at: '2026-08-27T00:00:00.000Z',
    });

    const result = await status(
      driver,
      planOf([migration('001-a', []), migration('002-b', [])]),
      reporter,
    );

    expect(result).toEqual([
      { name: '001-a', applied: true, changed: true },
      { name: '002-b', applied: false, changed: false },
    ]);
    expect(reporter.lines.join('\n')).toContain(
      'changed  001-a  (edited after it was applied)',
    );
    // And the rest of the report still arrives, which is the whole point.
    expect(reporter.lines.join('\n')).toContain('pending  002-b');
  });

  it('writes nothing beyond the table it has to read', async () => {
    const driver = fakeDriver();

    await status(driver, planOf([migration('001-a', [])]), collect());

    expect(driver.log).toEqual(['ensure', 'read']);
  });

  it('names a recorded migration that is no longer on disk', async () => {
    const driver = fakeDriver();
    const reporter = collect();

    driver.rows.push({
      name: '000-squashed',
      checksum: 'x',
      run_at: '2026-08-27T00:00:00.000Z',
    });

    await status(driver, planOf([]), reporter);

    expect(reporter.lines.join('\n')).toContain('orphan   000-squashed');
  });
});
