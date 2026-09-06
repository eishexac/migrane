import type { Session } from './types.js';

/**
 * A session-level advisory lock held for the length of a run.
 *
 * Two containers starting at once is the ordinary case, not the exotic one.
 * Without this both read the same empty bookkeeping table and both run the same
 * `CREATE TABLE`, and the loser fails a deploy over a schema that was in fact
 * applied correctly.
 *
 * Session-level rather than transaction-level because each migration commits in
 * a transaction of its own, and a lock scoped to one would be released between
 * migrations — exactly when the other process slips in.
 */

/**
 * A stable key from the table name, so two applications sharing a database
 * usually do not block each other.
 *
 * *Usually*: two names can collide into one key, and thirty-two bits makes that
 * unlikely rather than impossible. A collision costs waiting, never
 * correctness, so a wider key would buy a guarantee against a harmless outcome.
 *
 * Kept inside a signed 32-bit range because PostgreSQL wants a bigint and any
 * int is one, well clear of what a JS number could no longer represent exactly.
 */
export const lockKey = (table: string): number => {
  let hash = 5381;

  for (const character of table) {
    hash = (Math.imul(hash, 33) ^ character.charCodeAt(0)) | 0;
  }

  return hash;
};

/**
 * Choosing the key is this file's business; knowing how a lock is spelled is
 * the driver's, in a package whose opening line says it names no database.
 */
export const withLock = <T>(
  session: Session,
  table: string,
  run: () => Promise<T>,
): Promise<T> => session.lock(lockKey(table), run);
