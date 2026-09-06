import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULTS } from './defaults.js';
import type { Config } from './types.js';

/**
 * Finding and reading the consumer's config, and resolving everything in it to
 * an absolute path. `defineConfig` lives in `index.ts` rather than here, so
 * that importing it — which every config file does, and every config file gets
 * bundled into an image — never drags a directory reader along.
 *
 * Paths are resolved against **the config file**, not the working directory, so
 * `pnpm db:migrate` answers the same from the repository root as from the app.
 */

/**
 * Where the config is looked for, in order.
 *
 * `database/config.ts` first because everything a database needs belongs
 * together in one directory; the `migrate.config.*` names after it, since that
 * is what a consumer who has never read this will try.
 */
const CANDIDATES = [
  'database/config.ts',
  'migrate.config.ts',
  'migrate.config.js',
  'migrate.config.mjs',
];

export const findConfig = (cwd: string, explicit?: string): string => {
  if (explicit) {
    const path = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);

    if (!existsSync(path)) throw new Error(`no config at ${path}`);

    return path;
  }

  for (const candidate of CANDIDATES) {
    const path = resolve(cwd, candidate);

    if (existsSync(path)) return path;
  }

  throw new Error(
    `no migration config found. Looked for ${CANDIDATES.join(', ')} under ${cwd}.`,
  );
};

/** A config with every optional key settled and every path absolute. */
export interface Resolved extends Config {
  dirs: string[];
  table: string;
  seedTable: string;
  schema: string;
}

export const loadConfig = async (file: string): Promise<Resolved> => {
  const module = (await import(pathToFileURL(file).href)) as {
    default?: Config;
  };

  const config = module.default;

  if (!config) throw new Error(`${file} has no default export.`);
  if (!config.dirs?.length) throw new Error(`${file} declares no "dirs".`);
  if (typeof config.driver !== 'function') {
    throw new Error(`${file} declares no "driver" factory.`);
  }

  const base = dirname(file);
  const at = (path: string) => (isAbsolute(path) ? path : resolve(base, path));

  return {
    ...config,
    dirs: config.dirs.map(at),
    seeds: config.seeds ? at(config.seeds) : undefined,
    manifest: config.manifest ? at(config.manifest) : undefined,
    table: config.table ?? DEFAULTS.table,
    seedTable: config.seedTable ?? DEFAULTS.seedTable,
    schema: config.schema ?? DEFAULTS.schema,
  };
};
