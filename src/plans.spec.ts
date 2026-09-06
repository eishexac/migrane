import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Resolved } from './config.js';
import { createPlans } from './ship.js';
import type { Manifest } from './load.js';
import type { Config } from './types.js';

/**
 * The one agreement between the CLI and an image that nothing else checks.
 *
 * `loadConfig` settles a consumer's optional names for the CLI. An entrypoint
 * built from a manifest never sees that file — it imports the consumer's config
 * object directly, unresolved — so `createPlans` settles them again. Two
 * spellings of one default is how an image ends up recording migrations in a
 * table the CLI does not look in, and the failure is silent on both sides:
 * each is convinced it is looking at an empty database.
 *
 * So this asserts the two paths from one file, rather than either against a
 * literal, which a rename would keep passing.
 */

let root: string;
let raw: Config;
let resolved: Resolved;

const EMPTY: Manifest = { migrations: [], seeds: [] };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'migrane-plans-'));

  const file = join(root, 'migrate.config.mjs');

  // Declaring only what is required, which is the case the defaults are for.
  writeFileSync(
    file,
    "export default { dirs: ['./migrations'], driver: () => ({}) };\n",
  );

  raw = (await import(pathToFileURL(file).href)).default as Config;
  resolved = await loadConfig(file);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('createPlans', () => {
  it('settles the bookkeeping table the way loadConfig does', () => {
    expect(createPlans(raw, EMPTY).migrations.table).toBe(resolved.table);
  });

  it('settles the seed table the way loadConfig does', () => {
    expect(createPlans(raw, EMPTY).seeds.table).toBe(resolved.seedTable);
  });

  it('settles the schema the way loadConfig does', () => {
    expect(createPlans(raw, EMPTY).reset.schema).toBe(resolved.schema);
  });

  it('carries a declared guard into every plan', () => {
    const guard = () => {};
    const plans = createPlans({ ...raw, guard }, EMPTY);

    // Or a command run from an image would refuse while the same command from
    // the CLI was allowed by the consumer's guard — and the one that silently
    // disagreed would be the deployed one.
    expect(plans.migrations.guard).toBe(guard);
    expect(plans.seeds.guard).toBe(guard);
    expect(plans.reset.guard).toBe(guard);
  });

  it('prefers what the config declares over the default', () => {
    const named: Config = {
      ...raw,
      table: 'schema_history',
      seedTable: 'fixtures',
      schema: 'app',
    };

    const plans = createPlans(named, EMPTY);

    expect(plans.migrations.table).toBe('schema_history');
    expect(plans.seeds.table).toBe('fixtures');
    expect(plans.reset.schema).toBe('app');
  });

  it('turns both manifest arrays into loaded units', () => {
    const plans = createPlans(raw, {
      migrations: [
        {
          name: '001-initial',
          sequence: 1,
          checksum: 'ab12',
          parts: [{ sql: '-- migrate:up\nSELECT 1;' }],
        },
      ],
      seeds: [
        {
          name: 'demo',
          sequence: 0,
          checksum: 'cd34',
          parts: [{ up: async () => {} }],
        },
      ],
    });

    expect(plans.migrations.migrations.map(({ name }) => name)).toEqual([
      '001-initial',
    ]);
    expect(plans.seeds.units.map(({ name }) => name)).toEqual(['demo']);
  });
});
