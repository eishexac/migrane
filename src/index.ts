/**
 * A migration runner that knows nothing about your application.
 *
 * Handed a {@link Driver} and a list of directories, and that is all it knows:
 * no ORM, no container, no module registry, no dependency it makes you adopt.
 * Drivers live behind their own import path, so reaching for one is a choice.
 *
 * Three entry points, cut by audience. This one is for **authoring**: what a
 * config file, a migration, or an integration imports. `migrane/ship` holds
 * the runtime for container entries — every job that does not touch a
 * filesystem — and the `migrane` executable owns every job that does. Nothing
 * here reads a disk, so a config that imports from this file bundles for any
 * target.
 *
 * ```ts
 * // database/config.ts
 * import { defineConfig } from 'migrane';
 * import { pgDriver } from 'migrane/drivers/pg';
 *
 * export default defineConfig({
 *   dirs: ['./migrations'],
 *   seeds: './seeders',
 *   driver: () => pgDriver(process.env.DATABASE_URL!),
 * });
 * ```
 */

import type { Config } from './types.js';

/** Identity, but it types the object literal at the point it is written. */
export const defineConfig = (config: Config): Config => config;

export { compose } from './load.js';
export { refuse } from './safety.js';
export { createSql } from './sql.js';
export type {
  Config,
  Context,
  Driver,
  Fragment,
  Guard,
  Hook,
  Migration,
  Module,
  Part,
  Queryable,
  Row,
  Session,
  Sql,
  Transacted,
} from './types.js';
