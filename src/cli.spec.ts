import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { run } from './cli.js';

/**
 * The exit-code contract, from the outside: a code, never a sentence, is what
 * lets a consumer's tooling go fully through the CLI and still distinguish
 * outcomes without matching stderr. Each non-zero code is pinned against the
 * one condition that owns it, because the codes are the API here — a refusal
 * that started answering `1` would break a harness without changing a single
 * message.
 *
 * The project is real files in a temp directory and the driver is a fake the
 * config itself declares, keeping its bookkeeping in a JSON file beside it —
 * the CLI loads configs with `import()`, so the fake has to live in the
 * config's own module, not in this spec.
 */

let root: string;

const write = (path: string, content: string) => {
  const full = join(root, path);

  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
};

const DRIVER = `
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('./rows.json', import.meta.url));
const rows = () => JSON.parse(readFileSync(file, 'utf8'));
const save = (data) => writeFileSync(file, JSON.stringify(data));

const query = async (text, values) => {
  const sql = text.trim();

  if (sql.startsWith('SELECT name, checksum')) return rows();
  if (sql.startsWith('INSERT INTO')) {
    save([...rows(), { name: values[0], checksum: values[1], run_at: 'x' }]);

    return [];
  }
  if (sql.startsWith('DELETE FROM')) {
    save(rows().filter((row) => row.name !== values[0]));

    return [];
  }

  return [];
};

const session = (use) =>
  use({
    query,
    lock: (key, use) => use(),
    transaction: (use) => use({ query }),
  });

export const driver = () => ({
  host: 'db.example.com',
  database: 'app',
  query,
  session,
  close: async () => {},
});
`;

const MIGRATION =
  '-- migrate:up\nCREATE TABLE users (id int);\n-- migrate:down\nDROP TABLE users;\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'migrane-cli-'));

  write('fake-driver.mjs', DRIVER);
  write('rows.json', '[]');
  write('migrations/001-initial.sql', MIGRATION);
  write(
    'migrate.config.mjs',
    "import { driver } from './fake-driver.mjs';\n" +
      "export default { dirs: ['./migrations'], driver };\n",
  );
  write(
    'guarded.config.mjs',
    "import { driver } from './fake-driver.mjs';\n" +
      "export default { dirs: ['./migrations'], driver, guard: () => {} };\n",
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const guarded = ['--config', 'guarded.config.mjs'];

describe('the exit codes', () => {
  it('answers 0 when the command did its work', async () => {
    expect(await run(['up'], root)).toBe(0);
  });

  it('answers 1 for a plain failure', async () => {
    expect(await run(['seed', 'demo'], root)).toBe(1);
  });

  it('answers 2 when a migration changed after it was applied', async () => {
    write(
      'rows.json',
      JSON.stringify([{ name: '001-initial', checksum: 'stale', run_at: 'x' }]),
    );

    expect(await run(['up'], root)).toBe(2);
  });

  it('answers 3 when the guard said no', async () => {
    // No guard in the config is the guard saying no — every destructive verb
    // refuses until the config names who may run one.
    expect(await run(['reset'], root)).toBe(3);
    expect(await run(['down'], root)).toBe(3);
  });

  it('answers 0 when the config’s guard allows what the default refuses', async () => {
    expect(await run(['up', ...guarded], root)).toBe(0);
    expect(await run(['down', ...guarded], root)).toBe(0);
    expect(await run(['reset', ...guarded], root)).toBe(0);
  });

  it('keeps 2 and 3 apart from each other', async () => {
    // The same project can hold both conditions; the changed migration is
    // found only once the guard has allowed the connection to proceed, so the
    // guard's code wins on a guarded verb and the checksum's on an unguarded
    // one.
    write(
      'rows.json',
      JSON.stringify([{ name: '001-initial', checksum: 'stale', run_at: 'x' }]),
    );

    expect(await run(['down'], root)).toBe(3);
    expect(await run(['down', ...guarded], root)).toBe(2);
  });
});
