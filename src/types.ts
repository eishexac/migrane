/**
 * The vocabulary everything downstream is written against. Nothing here names a
 * database, an ORM or an application: a consumer supplies a {@link Driver} and
 * the runner never learns what it is talking to.
 */

/** A result row. */
export type Row = Record<string, unknown>;

/**
 * Anything a statement can be sent to — a pool, a pinned connection, or a
 * connection inside a transaction. A migration body cannot tell them apart.
 *
 * Omitting `values` is meaningful: with no bind parameters PostgreSQL uses the
 * simple query protocol, which is what lets one template carry several
 * statements separated by `;`. Pass a parameter and exactly one is legal.
 */
export interface Queryable {
  query<R extends Row = Row>(
    text: string,
    values?: readonly unknown[],
  ): Promise<R[]>;
}

/**
 * One pinned connection.
 *
 * Separate from {@link Driver} because a transaction and a session-level lock
 * are only meaningful on a connection that stays the same between statements,
 * and a pool hands out whichever is free.
 */
export interface Session extends Queryable {
  transaction<T>(run: (tx: Queryable) => Promise<T>): Promise<T>;

  /**
   * Hold an exclusive lock named by `key` for the length of `run`, releasing it
   * however `run` ends.
   *
   * Must **block** rather than fail when the lock is held: whoever holds it is
   * applying the migrations this process wants applied, so waiting is correct
   * and failing fast turns a wait into a red deploy.
   */
  lock<T>(key: number, run: () => Promise<T>): Promise<T>;
}

/**
 * How the runner reaches a database. Implement these and everything else in
 * this package works — `drivers/pg.ts` is the reference, at under a hundred
 * lines.
 */
export interface Driver extends Queryable {
  /**
   * The machine these coordinates reach: a hostname, an address, or `''` for a
   * unix socket.
   *
   * Required rather than optional, because it is what a {@link Guard} matches
   * on. A driver that could omit it would silently opt its databases out of
   * every guard written against it. State it even when it is `'localhost'`.
   */
  readonly host: string;

  /**
   * The database these coordinates open, named beside {@link host} for the
   * same reason: a guard that matches on the name must read it off the
   * connection it is guarding, not re-derive it from the environment.
   */
  readonly database: string;

  /** Pin one connection for the length of `run`. */
  session<T>(run: (session: Session) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * SQL spliced verbatim rather than bound as a parameter.
 *
 * A branded object rather than a string, so reaching for the escape is visible
 * in a diff instead of being what happens by default.
 */
declare const FRAGMENT: unique symbol;

export interface Fragment {
  readonly [FRAGMENT]: string;
}

/**
 * The tagged template a migration writes against. Interpolations become bind
 * parameters unless they are {@link Fragment}s, so the ordinary way to write a
 * value is also the safe one.
 */
export interface Sql {
  <R extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<R[]>;

  /** Splice text in unescaped, for DDL the template cannot express. */
  raw: (text: string) => Fragment;

  /** Quote an identifier — `sql.id('user table')` is `"user table"`. */
  id: (name: string) => Fragment;

  /** Join fragments — a column list, a set of constraints. */
  join: (parts: readonly Fragment[], separator?: string) => Fragment;
}

/** What every migration and seed part receives. */
export interface Context {
  sql: Sql;
  /** The connection underneath, for what the template cannot say. */
  db: Queryable;
}

/**
 * What a migration file exports.
 *
 * `down` is optional: many migrations have no honest reverse, and requiring one
 * only ever produces an empty body that lies about being reversible.
 */
export interface Part {
  up: (context: Context) => Promise<void>;
  down?: (context: Context) => Promise<void>;
}

/**
 * Export `transaction = false` to opt out of the wrapping transaction, for
 * statements PostgreSQL refuses to run inside one such as
 * `CREATE INDEX CONCURRENTLY`.
 *
 * The cost is stated where it is taken: an untransacted migration that fails
 * half way leaves the schema changed and its row unwritten.
 */
export interface Transacted {
  transaction?: boolean;
}

/** A migration file's module, once loaded. */
export type Module = Part & Transacted;

/** One migration, found on disk but not yet loaded. */
export interface Discovered {
  /** The storage key — the file or directory name, without extension. */
  name: string;
  /** The leading number, which orders it. */
  sequence: number;
  /** Absolute path of the file, or of the directory. */
  path: string;
  /**
   * What actually runs, in order: one entry for a file or a directory with an
   * `index.ts`, every part in path order for a directory without one.
   */
  run: readonly string[];
  /**
   * Every file the migration is made of, including parts reached only through
   * an `index.ts` — the checksum has to cover what it *executes*, not what
   * discovery happened to open.
   */
  files: readonly string[];
  /** Hash of all of {@link files}, so editing an applied migration is refused. */
  checksum: string;
}

/**
 * A migration, loaded and ready to run. Carries no paths: the same runner
 * applies it from a laptop and from an image where the files no longer exist.
 */
export interface Migration extends Omit<Discovered, 'files' | 'path' | 'run'> {
  module: Module;
}

/** Run before any pending migration, in declaration order. */
export type Hook = (context: Context) => Promise<void>;

/**
 * What every destructive command runs through before it touches anything.
 *
 * A guard interrogates the **driver** — the config's own product, the one true
 * record of the connection — or queries through it, and it ends with `refuse`
 * for whatever it does not allow:
 *
 * ```ts
 * guard: async (driver, what) => {
 *   if (await isDisposable(driver)) return;
 *
 *   refuse(driver, what);
 * },
 * ```
 *
 * Returning is allowing; **throwing is refusing** — the same shape `refuse()`
 * has, so ending with it is composition rather than convention.
 *
 * @param what what the command does, as a clause — `reset drops every table`.
 */
export type Guard = (driver: Driver, what: string) => void | Promise<void>;

/** What a consumer's `database/config.ts` exports. */
export interface Config {
  /**
   * Directories holding migrations, in order. Inside a root, a `.ts` or `.sql`
   * file is one migration and so is a directory.
   */
  dirs: readonly string[];

  /** How to reach the database. A factory, so `status` can skip opening one. */
  driver: () => Driver | Promise<Driver>;

  /** Where seed units live, one directory per unit. Omit for no seeds. */
  seeds?: string;

  /**
   * Where `migrane manifest` writes. Omit it and the command says so rather
   * than inventing a path — `entryFor` writes every specifier relative to this
   * destination, so guessing where it goes would guess what is in it.
   */
  manifest?: string;

  /** Bookkeeping table names. Default to `migrations` and `seeds`. */
  table?: string;
  seedTable?: string;

  /** The schema `reset` drops and recreates. Defaults to `public`. */
  schema?: string;

  /**
   * Who may run a destructive command against this database.
   *
   * Omit it and every destructive verb — `down`, `reset`, `fresh`, `seed`,
   * `unseed` — refuses. `up` and `status` are never guarded. The library
   * consults nothing else: no environment variable, no notion of which hosts
   * are local. Which databases are disposable is this config's opinion, and
   * the config is the one place that opinion is correct.
   */
  guard?: Guard;

  /**
   * Run once before pending migrations, and even when none are pending. Not
   * before `status` or `reset`, neither of which has business writing DDL.
   *
   * The seam for anything you want true *before* a migration but do not want to
   * write as one: a synced type, a search path, an extension. Also the only
   * place the runner executes code it did not discover.
   */
  before?: readonly Hook[];
}
