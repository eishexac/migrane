import { Pool, type PoolClient, type PoolConfig, type QueryResult } from 'pg';
import type { Driver, Queryable, Row, Session } from '../types.js';

/**
 * The reference driver, and the shortest statement of what a driver is: three
 * methods over `node-postgres`, and the host they reach.
 *
 * `pg` is an optional peer dependency — importing `migrane` does not reach
 * it, only importing this file does. A consumer on another client writes sixty
 * lines like these instead of adopting ours.
 */

/**
 * The simple query protocol answers a multi-statement request with one result
 * per statement. Rows come from the last of them, which is what a caller
 * reading `SELECT 1` at the end of a script expects.
 */
const rowsOf = <R extends Row>(result: QueryResult | QueryResult[]): R[] =>
  (Array.isArray(result) ? (result.at(-1)?.rows ?? []) : result.rows) as R[];

const queryable = (client: Pool | PoolClient): Queryable => ({
  async query<R extends Row = Row>(text: string, values?: readonly unknown[]) {
    // Passing no array at all rather than an empty one: `pg` switches to the
    // extended protocol the moment values are present, and that protocol
    // permits exactly one statement per request.
    const result = values?.length
      ? await client.query(text, [...values])
      : await client.query(text);

    return rowsOf<R>(result);
  },
});

const sessionOver = (client: PoolClient): Session => ({
  ...queryable(client),

  /**
   * PostgreSQL's spelling of the lock `withLock` asks for. Blocking rather than
   * `pg_try_advisory_lock`, per the contract on {@link Session.lock}; why it is
   * session-level is `lock.ts`'s business.
   */
  async lock<T>(key: number, run: () => Promise<T>): Promise<T> {
    await client.query('SELECT pg_advisory_lock($1)', [key]);

    try {
      return await run();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    }
  },

  async transaction<T>(run: (tx: Queryable) => Promise<T>): Promise<T> {
    await client.query('BEGIN');

    try {
      const result = await run(queryable(client));
      await client.query('COMMIT');

      return result;
    } catch (error) {
      // A rollback that itself fails must not replace the error that caused it
      // — that one is the answer to what went wrong.
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  },
});

/**
 * Where these coordinates point, read the way `pg` itself reads them.
 *
 * It is worth the twenty lines because `Driver.host` is what a guard matches
 * on: a host this cannot make out must never come back looking like one a
 * guard allows. So every branch either produces the real host or produces
 * something plainly no guard names — including the last one, which declines to
 * guess. It also never returns the string it was given, because a connection
 * string carries a password and this value is printed.
 */
const hostOf = (config: string | PoolConfig): string => {
  if (typeof config !== 'string') {
    return config.connectionString
      ? hostOf(config.connectionString)
      : // `pg`'s own precedence, so the guard and the pool cannot disagree: an
        // omitted host means PGHOST, and then the local socket.
        (config.host ?? process.env.PGHOST ?? '');
  }

  try {
    // Brackets around an IPv6 address belong to the URL syntax, not to the
    // address, and a guard has to be writable against what is printed.
    return new URL(config).hostname.replace(/^\[|\]$/g, '');
  } catch {
    // The libpq keyword form — `host=db.example.com port=5432 …`. Anything
    // else is unreadable, and an unreadable host matches no guard.
    return /(?:^|\s)host=(\S+)/.exec(config)?.[1] ?? 'unknown';
  }
};

/**
 * Which database these coordinates open, read with the same care as the host
 * and for the same reason: a guard matching on the name must never be answered
 * with a guess. `pg` itself falls back to the *user name* when nothing names a
 * database; that branch deliberately answers `'unknown'` instead, because a
 * wrong "unknown" refuses where a wrong guess would drop — the failure that is
 * an inconvenience rather than a loss.
 */
const databaseOf = (config: string | PoolConfig): string => {
  if (typeof config !== 'string') {
    return config.connectionString
      ? databaseOf(config.connectionString)
      : (config.database ?? process.env.PGDATABASE ?? 'unknown');
  }

  try {
    const name = new URL(config).pathname.replace(/^\//, '');

    // Percent-decoded because the URL syntax owns the escapes, not the name —
    // a guard compares against what `CREATE DATABASE` was told.
    return name
      ? decodeURIComponent(name)
      : (process.env.PGDATABASE ?? 'unknown');
  } catch {
    return (
      /(?:^|\s)dbname=(\S+)/.exec(config)?.[1] ??
      process.env.PGDATABASE ??
      'unknown'
    );
  }
};

/**
 * A driver over a `pg` pool.
 *
 * Takes a connection string or a `PoolConfig`, so `pgDriver(process.env.DATABASE_URL)`
 * is the whole setup for most consumers.
 */
export const pgDriver = (config: string | PoolConfig): Driver => {
  const pool = new Pool(
    typeof config === 'string' ? { connectionString: config } : config,
  );

  return {
    ...queryable(pool),

    host: hostOf(config),
    database: databaseOf(config),

    async session<T>(run: (session: Session) => Promise<T>): Promise<T> {
      const client = await pool.connect();

      try {
        return await run(sessionOver(client));
      } finally {
        client.release();
      }
    },

    close: () => pool.end(),
  };
};
