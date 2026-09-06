import { DEFAULTS } from './defaults.js';
import { withLock } from './lock.js';
import { refuse } from './safety.js';
import { createSql } from './sql.js';
import { applied, forget, record, verify } from './storage.js';
import type {
  Config,
  Driver,
  Guard,
  Hook,
  Migration,
  Queryable,
  Session,
} from './types.js';

/**
 * Applying and reverting — the same way on a developer machine and in a
 * container, which is what makes a migration's result reproducible.
 */

/**
 * Where progress output goes — one line per event, and that is the whole
 * interface, because it is progress rather than a logger. Injected so a test
 * can read it back; every verb defaults it to the console.
 */
export interface Progress {
  line: (text: string) => void;
}

// The one global the runtime half assumes. Declared here rather than through
// `@types/node`, because this graph must compile with no platform libs at all
// (see tsconfig.ship.json) and every runtime it targets has a console.
declare const console: { log: (text: string) => void };

export const toConsole: Progress = { line: (text) => console.log(text) };

export interface Plan {
  migrations: readonly Migration[];
  table: string;
  before?: readonly Hook[];
  /** Consulted by `down`, the one destructive verb here. Defaults to `refuse`. */
  guard?: Guard;
}

/**
 * A plan from a config and migrations already loaded — the shape an entrypoint
 * built from a manifest is in, where there is nothing to read off a disk.
 *
 * The table default is settled here from the same constant `loadConfig` uses,
 * deliberately: two spellings of one default is how an image ends up recording
 * migrations in a table the CLI does not look in.
 */
export const planFrom = (
  config: Config,
  migrations: readonly Migration[],
): Plan => ({
  migrations,
  table: config.table ?? DEFAULTS.table,
  before: config.before,
  guard: config.guard,
});

const contextOver = (db: Queryable) => ({ sql: createSql(db), db });

/**
 * Everything a run needs held at once: one pinned connection, the advisory
 * lock on it, and the bookkeeping read inside that lock.
 *
 * Reading `applied` *inside* the lock is the point. Read it outside and two
 * processes can both see the same empty table before either takes the lock,
 * which is the race the lock exists to close.
 */
const inRun = async <T>(
  driver: Driver,
  plan: Plan,
  run: (session: Session, done: Set<string>) => Promise<T>,
): Promise<T> =>
  driver.session((session) =>
    withLock(session, plan.table, async () => {
      const rows = await applied(session, plan.table);

      verify(rows, plan.migrations);

      return run(session, new Set(rows.map((row) => row.name)));
    }),
  );

/**
 * Each migration commits in a transaction of its own together with the row that
 * records it, so a failure can never leave the DDL applied and the bookkeeping
 * unwritten.
 */
export const up = async (
  driver: Driver,
  plan: Plan,
  reporter: Progress = toConsole,
): Promise<Migration[]> =>
  inRun(driver, plan, async (session, done) => {
    // Before the pending check, not after: a hook syncs things a migration may
    // reference, and whether it needs syncing has nothing to do with whether a
    // *new* migration was added. Registering something that contributes a type
    // has to take effect on the next `migrate`, with no migration written.
    for (const hook of plan.before ?? []) await hook(contextOver(session));

    const pending = plan.migrations.filter(({ name }) => !done.has(name));

    if (!pending.length) {
      reporter.line('nothing to do');

      return [];
    }

    for (const migration of pending) {
      const { name, checksum, module } = migration;

      reporter.line(`  migrating  ${name}`);

      const started = Date.now();

      const apply = async (db: Queryable) => {
        await module.up(contextOver(db));
        await record(db, plan.table, {
          name,
          checksum,
          duration: Math.round(Date.now() - started),
        });
      };

      // The opt-out is not a detail to hide: an untransacted migration that
      // fails half way leaves the schema changed and unrecorded, and the
      // operator needs to know which one that was.
      if (module.transaction === false) {
        reporter.line(`  (untransacted)`);
        await apply(session);
      } else {
        await session.transaction(apply);
      }

      reporter.line(
        `  migrated   ${name}  ${Math.round(Date.now() - started)}ms`,
      );
    }

    reporter.line(`applied ${pending.length}`);

    return pending;
  });

/**
 * Revert the most recently applied migration.
 *
 * Only one, and only the last: reverting is a decision taken a step at a time,
 * and a command unwinding an unbounded number of them empties a database by
 * typo.
 *
 * Guarded like `reset`. "No `down` against production" has to sit on the
 * function to mean anything — a verb withheld from one entrypoint's command
 * table says nothing about the same function imported directly.
 */
export const down = async (
  driver: Driver,
  plan: Plan,
  reporter: Progress = toConsole,
): Promise<Migration | undefined> => {
  await (plan.guard ?? refuse)(driver, 'down reverts a migration');

  return inRun(driver, plan, async (session, done) => {
    const last = [...plan.migrations]
      .reverse()
      .find(({ name }) => done.has(name));

    if (!last) {
      reporter.line('nothing to do');

      return undefined;
    }

    if (!last.module.down) {
      throw new Error(
        `"${last.name}" has no "down", so it cannot be reverted.`,
      );
    }

    reporter.line(`  reverting  ${last.name}`);

    const started = Date.now();

    const revert = async (db: Queryable) => {
      await last.module.down?.(contextOver(db));
      await forget(db, plan.table, last.name);
    };

    if (last.module.transaction === false) await revert(session);
    else await session.transaction(revert);

    reporter.line(
      `  reverted   ${last.name}  ${Math.round(Date.now() - started)}ms`,
    );

    return last;
  });
};

export interface Status {
  name: string;
  applied: boolean;
  /** Applied, and the file has changed since — what `up` will refuse on. */
  changed: boolean;
}

/**
 * What is applied and what is pending, in the order they would run.
 *
 * Writes nothing beyond the `CREATE TABLE IF NOT EXISTS` that reading requires:
 * asking a database what it holds should not change what it holds.
 *
 * **And it never refuses.** An edited migration is the likeliest reason someone
 * is running this, so it reports `changed` and finishes the report rather than
 * answering with a stack trace and no lines. `up` and `down` still refuse.
 */
export const status = async (
  driver: Driver,
  plan: Plan,
  reporter: Progress = toConsole,
): Promise<Status[]> => {
  const rows = await applied(driver, plan.table);
  const done = new Map(rows.map((row) => [row.name, row.checksum]));

  const lines = plan.migrations.map(({ name, checksum }) => ({
    name,
    applied: done.has(name),
    changed: done.has(name) && done.get(name) !== checksum,
  }));

  for (const { name, applied: isApplied, changed } of lines) {
    reporter.line(
      changed
        ? `  changed  ${name}  (edited after it was applied)`
        : `  ${isApplied ? 'up     ' : 'pending'}  ${name}`,
    );
  }

  if (!lines.length) reporter.line('  no migrations');

  // A name in the table with no file behind it is what a squash looks like from
  // the database's side, and saying so is more useful than staying quiet.
  for (const row of rows) {
    if (!plan.migrations.some(({ name }) => name === row.name)) {
      reporter.line(`  orphan   ${row.name}  (recorded, not on disk)`);
    }
  }

  return lines;
};
