/**
 * What every optional setting falls back to, in one place.
 *
 * `config.ts` settles a consumer's file for the CLI; `createPlans` settles it
 * for an entrypoint built from a manifest, which never sees that file. Both
 * read these, because two spellings of one table name is how an image records
 * migrations where the CLI cannot find them.
 *
 * A file of its own rather than a corner of `config.ts`, so the shipped path
 * can read it without pulling a directory reader into an image that has no
 * directories to read.
 */
export const DEFAULTS = {
  /**
   * Deploy tooling that reads the database directly — a health check, a ship
   * script — tends to know this name too, and cannot import it. A consumer that
   * overrides `table` owns telling every such reader as well.
   */
  table: 'migrations',
  seedTable: 'seeds',
  schema: 'public',
} as const;
