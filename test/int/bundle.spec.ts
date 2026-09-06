import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from 'migrane';
import { down, up, type Progress } from 'migrane/ship';
import { entryFor } from '../../src/bundle.js';
import { discover, loadAll } from '../../src/discover.js';
import { fromManifest, type ManifestEntry } from '../../src/load.js';
import { planFrom } from '../../src/runner.js';
import { applied } from '../../src/storage.js';
import { database } from '../support/database.js';

/**
 * The one thing only this package can guarantee, against a database that can
 * disagree.
 *
 * A consumer could write their own generator. The reason they should not is
 * that it has to agree with `discover()` about checksums *and* with `load()`
 * about composition — and when it does not, the symptom is a container refusing
 * a migration a developer machine says is fine, or applying a directory's parts
 * in an order the CLI never would.
 *
 * So this applies the same migrations twice against one real database: once the
 * way the CLI does, and once the way an image does, with the schema wiped
 * between. Same rows, same hashes, same order, or the promise is not kept.
 *
 * The fixture is SQL on purpose. A manifest carrying `.ts` parts imports them,
 * and resolving those imports is a bundler's job rather than a spec's — the
 * text of that manifest is asserted in `src/bundle.spec.ts` instead. What is
 * left here is everything a `.sql` project needs and nothing a bundler owns.
 */

const db = database('migrane_bundle');

const TABLE = 'migrations';

const lines: string[] = [];
const reporter: Progress = { line: (text) => void lines.push(text) };

let root: string;
let config: Config;

const write = (path: string, content: string) => {
  const full = join(root, path);

  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'migrane-agree-'));

  write(
    'migrations/001-initial.sql',
    '-- migrate:up\nCREATE TABLE users (id int);\n-- migrate:down\nDROP TABLE users;\n',
  );

  // A directory of parts, because composition is the half a hand-written
  // generator gets wrong: `up` forwards, `down` in reverse, and the checksum
  // over every file rather than the first.
  write(
    'migrations/002-products/010-table.sql',
    '-- migrate:up\nCREATE TABLE products (id int);\n-- migrate:down\nDROP TABLE products;\n',
  );
  write(
    'migrations/002-products/020-index.sql',
    '-- migrate:up\nCREATE INDEX products_id ON products (id);\n-- migrate:down\nDROP INDEX products_id;\n',
  );

  config = {
    dirs: [join(root, 'migrations')],
    driver: () => db(),
    guard: () => {},
  };
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const wipe = () =>
  db().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');

const recorded = () =>
  applied(db(), TABLE).then((rows) =>
    rows.map(({ name, checksum }) => ({ name, checksum })),
  );

const tables = () =>
  db()
    .query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
    )
    .then((rows) => rows.map((row) => row.name));

/** The manifest, generated and imported exactly as a build would produce it. */
const asShipped = async (): Promise<ManifestEntry[]> => {
  const to = join(root, 'manifest.mjs');

  writeFileSync(to, entryFor({ config: config as never, to }));

  const module = (await import(pathToFileURL(to).href)) as {
    migrations: ManifestEntry[];
  };

  return module.migrations;
};

beforeEach(async () => {
  await wipe();
  lines.length = 0;
});

describe('a manifest and the CLI', () => {
  it('record the same migrations, with the same hashes, in the same order', async () => {
    await up(db(), planFrom(config, await loadAll(discover(config.dirs))));

    const fromDisk = await recorded();

    await wipe();

    await up(db(), planFrom(config, fromManifest(await asShipped())));

    const fromImage = await recorded();

    expect(fromDisk).toHaveLength(2);
    expect(fromImage).toEqual(fromDisk);
  });

  it('leave the same schema behind', async () => {
    await up(db(), planFrom(config, await loadAll(discover(config.dirs))));

    const afterDisk = await tables();

    await wipe();

    await up(db(), planFrom(config, fromManifest(await asShipped())));

    // The bookkeeping table is in here too, and belongs in the comparison: an
    // image that recorded into a different one would show up exactly here.
    expect(await tables()).toEqual(afterDisk);
    expect(afterDisk).toEqual(['migrations', 'products', 'users']);
  });

  it('revert a directory’s parts in the same reversed order', async () => {
    const plan = planFrom(config, fromManifest(await asShipped()));

    await up(db(), plan, reporter);
    await down(db(), plan, reporter);

    // `020-index` reverts before `010-table`, or dropping the table would take
    // the index with it and the second statement would fail.
    expect(await tables()).toEqual(['migrations', 'users']);
    expect((await recorded()).map(({ name }) => name)).toEqual(['001-initial']);
  });

  it('refuse a migration the image was built before an edit to', async () => {
    await up(db(), planFrom(config, fromManifest(await asShipped())));

    const stale = fromManifest(await asShipped()).map((migration) =>
      migration.name === '001-initial'
        ? { ...migration, checksum: 'a-different-hash' }
        : migration,
    );

    // The checksum travels in the manifest, so an image built from an edited
    // migration refuses against a database holding the old one — the same
    // refusal the CLI gives, reached the same way.
    await expect(up(db(), planFrom(config, stale), reporter)).rejects.toThrow(
      /001-initial/,
    );
  });
});
