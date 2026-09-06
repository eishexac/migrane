import { describe, expect, it } from 'vitest';
import { database } from '../support/database.js';

/**
 * The reference driver, which had no test at all.
 *
 * Everything downstream is written against `Driver`, so a consumer writing
 * their own has nothing but this file and the interface to tell them what the
 * three methods are actually required to do. These are those requirements,
 * stated as cases: what `query` does with and without parameters, what pinning
 * a session buys, and what a transaction does when the body throws.
 */

const db = database('migrane_pg_driver');

describe('coordinates', () => {
  it('reads the database name off the connection it will open', () => {
    // What a guard matches on, so it must come from the URL and not a guess.
    expect(db().database).toBe('migrane_pg_driver');
  });
});

describe('query', () => {
  it('binds its parameters', async () => {
    const rows = await db().query<{ answer: number }>(
      'SELECT $1::int + $2::int AS answer',
      [1, 2],
    );

    expect(rows[0]?.answer).toBe(3);
  });

  it('does not interpolate a parameter into the statement', async () => {
    const rows = await db().query<{ value: string }>(
      'SELECT $1::text AS value',
      ["'; DROP TABLE migrations; --"],
    );

    expect(rows[0]?.value).toBe("'; DROP TABLE migrations; --");
  });

  it('takes several statements when there are no parameters', async () => {
    // The simple query protocol, and the reason `values` is optional rather
    // than defaulted to an empty array: a `.sql` migration is one template
    // holding many statements, and one bind parameter would forbid that.
    const rows = await db().query<{ two: number }>(
      'SELECT 1 AS one; SELECT 2 AS two',
    );

    // Rows come from the last statement, which is what a caller reading a
    // trailing SELECT expects.
    expect(rows[0]?.two).toBe(2);
  });
});

describe('session', () => {
  it('pins one connection for the length of the run', async () => {
    const temp = await db().session(async (session) => {
      // A temporary table is visible only to the connection that made it, so
      // reading it back proves the two statements went to the same one.
      await session.query('CREATE TEMP TABLE pinned (id int)');
      await session.query('INSERT INTO pinned VALUES (1)');

      return session.query<{ count: string }>('SELECT count(*) FROM pinned');
    });

    expect(temp[0]?.count).toBe('1');
  });

  it('gives the connection back afterwards', async () => {
    // More runs than the pool's default maximum. A session that failed to
    // release its client would not fail this — it would hang, which is how the
    // mistake shows up in production: the eleventh migration never starts.
    for (let n = 0; n < 12; n++) {
      await db().session((session) => session.query('SELECT 1'));
    }

    await expect(db().query('SELECT 1')).resolves.toHaveLength(1);
  });

  it('does not reset what a session left on the connection', async () => {
    // Released, not reset: `pg` does not `DISCARD ALL` on release, so the next
    // session over the same physical connection still sees a temp table, a
    // `SET`, or a changed `search_path`.
    //
    // Harmless to the runner, which takes one session for a whole run and
    // closes the pool afterwards — but a consumer calling `session()` directly
    // is entitled to know, and pinning it here means that adding a reset later
    // has to be a decision rather than an accident.
    await db().session(async (session) => {
      await session.query('CREATE TEMP TABLE carried_over (id int)');
    });

    const pid = () =>
      db()
        .session((session) =>
          session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'),
        )
        .then((rows) => rows[0]?.pid);

    expect(await pid()).toBe(await pid());

    await expect(
      db().session((session) => session.query('SELECT * FROM carried_over')),
    ).resolves.toEqual([]);
  });
});

describe('transaction', () => {
  it('commits what the body did', async () => {
    await db().session((session) =>
      session.transaction(async (tx) => {
        await tx.query('CREATE TABLE committed (id int)');
      }),
    );

    await expect(db().query('SELECT * FROM committed')).resolves.toEqual([]);
  });

  it('rolls back when the body throws', async () => {
    await expect(
      db().session((session) =>
        session.transaction(async (tx) => {
          await tx.query('CREATE TABLE rolled_back (id int)');
          throw new Error('the migration failed');
        }),
      ),
    ).rejects.toThrow('the migration failed');

    await expect(db().query('SELECT * FROM rolled_back')).rejects.toThrow(
      /does not exist/,
    );
  });

  it('reports what the body failed on, not the rollback', async () => {
    // A rollback that fails must not replace the error that caused it: the
    // original is the answer to what went wrong, and the driver swallows the
    // rollback's own error for exactly this reason.
    await expect(
      db().session((session) =>
        session.transaction(async (tx) => {
          await tx.query('SELECT * FROM no_such_table');
        }),
      ),
    ).rejects.toThrow(/no_such_table/);
  });
});
