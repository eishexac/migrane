import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareNatural, discover } from './discover.js';

/**
 * Ordering is the one thing this package cannot get wrong quietly: a migration
 * that runs before the table it references fails loudly, but one that runs in
 * the wrong order *without* failing produces a schema nobody meant. So the sort
 * is tested against the cases that motivated it rather than against a snapshot.
 */
describe('compareNatural', () => {
  it('compares leading numbers as numbers, not as text', () => {
    expect(compareNatural('9-people', '10-users')).toBeLessThan(0);
  });

  it('falls back to text when there is no leading number', () => {
    expect(compareNatural('alpha', 'beta')).toBeLessThan(0);
  });

  it('orders segment by segment, so a shallow numbering wins over a deep one', () => {
    const order = ['020-tables/010-users.ts', '010-pg/900-extensions.ts'].sort(
      compareNatural,
    );

    expect(order[0]).toBe('010-pg/900-extensions.ts');
  });

  it('runs a file before the directory that follows it', () => {
    expect(
      compareNatural('010-first.ts', '010-first/010-part.ts'),
    ).toBeLessThan(0);
  });
});

describe('discover', () => {
  let root: string;

  const write = (
    path: string,
    content = 'export const up = async () => {};',
  ) => {
    const full = join(root, path);

    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'migrate-discover-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds a flat file and a directory alike', () => {
    write('001-initial/010-users.ts');
    write('002-products.ts');

    expect(discover([root]).map((entry) => entry.name)).toEqual([
      '001-initial',
      '002-products',
    ]);
  });

  it('collects a directory migration’s parts in numeric path order', () => {
    write('001-initial/020-tables/010-users.ts');
    write('001-initial/020-tables/002-people.ts');
    write('001-initial/010-pg/010-extensions.ts');

    const [initial] = discover([root]);

    expect(initial?.files.map((file) => file.replace(`${root}/`, ''))).toEqual([
      '001-initial/010-pg/010-extensions.ts',
      '001-initial/020-tables/002-people.ts',
      '001-initial/020-tables/010-users.ts',
    ]);
  });

  it('runs only index.ts when a directory has one', () => {
    write('001-initial/index.ts');
    write('001-initial/tables/users.ts');
    write('001-initial/pg/extensions.ts');

    const [initial] = discover([root]);

    expect(initial?.run).toEqual([join(root, '001-initial/index.ts')]);
  });

  it('still hashes the parts an index only imports', () => {
    // Otherwise editing a part would slip past the applied-migration check,
    // which is exactly the hole the checksum exists to close.
    write('001-initial/index.ts');
    write('001-initial/tables/users.ts');
    const before = discover([root])[0]?.checksum;

    write('001-initial/tables/users.ts', 'export const users = { up: 1 };');

    expect(discover([root])[0]?.checksum).not.toBe(before);
  });

  it('composes every file when a directory has no index', () => {
    write('001-initial/020-tables.ts');
    write('001-initial/010-pg.ts');

    expect(discover([root])[0]?.run).toEqual([
      join(root, '001-initial/010-pg.ts'),
      join(root, '001-initial/020-tables.ts'),
    ]);
  });

  it('ignores an index.ts that is not at the top of the migration', () => {
    write('001-initial/tables/index.ts');
    write('001-initial/pg/extensions.ts');

    expect(discover([root])[0]?.run).toHaveLength(2);
  });

  it('hashes every file of a directory, so editing a part is visible', () => {
    write('001-initial/010-users.ts');
    const before = discover([root])[0]?.checksum;

    write('001-initial/010-users.ts', 'export const up = async () => { 1; };');

    expect(discover([root])[0]?.checksum).not.toBe(before);
  });

  it('keeps roots in the order they were given', () => {
    const other = mkdtempSync(join(tmpdir(), 'migrate-discover-other-'));

    try {
      write('900-late.ts');
      writeFileSync(
        join(other, '001-early.ts'),
        'export const up = async () => {};',
      );

      expect(discover([root, other]).map((entry) => entry.name)).toEqual([
        '900-late',
        '001-early',
      ]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses a migration that is not named <number>-<slug>', () => {
    write('users.ts');

    expect(() => discover([root])).toThrow(/must be named/);
  });

  it('refuses two migrations sharing a name, since the name is the storage key', () => {
    const other = mkdtempSync(join(tmpdir(), 'migrate-discover-dup-'));

    try {
      write('001-initial.ts');
      writeFileSync(
        join(other, '001-initial.ts'),
        'export const up = async () => {};',
      );

      expect(() => discover([root, other])).toThrow(/Two migrations are named/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('ignores a directory with nothing runnable in it', () => {
    mkdirSync(join(root, '001-scaffolded'), { recursive: true });
    write('002-real.ts');

    expect(discover([root]).map((entry) => entry.name)).toEqual(['002-real']);
  });

  it('ignores files that are neither .ts nor .sql', () => {
    write('001-initial/010-users.ts');
    write('001-initial/README.md', '# not a migration');

    expect(discover([root])[0]?.files).toHaveLength(1);
  });
});
