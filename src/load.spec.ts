import { describe, expect, it, vi } from 'vitest';
import { compose, parseSql } from './load.js';
import { createSql } from './sql.js';
import type { Context, Module } from './types.js';

const contextOver = (query = vi.fn().mockResolvedValue([])): Context => ({
  sql: createSql({ query }),
  db: { query },
});

describe('parseSql', () => {
  it('reads the up and down sections', async () => {
    const module = parseSql(
      [
        '-- migrate:up',
        'CREATE TABLE users ();',
        '-- migrate:down',
        'DROP TABLE users;',
      ].join('\n'),
      'x.sql',
    );

    const query = vi.fn().mockResolvedValue([]);

    await module.up(contextOver(query));
    await module.down?.(contextOver(query));

    expect(query).toHaveBeenNthCalledWith(1, 'CREATE TABLE users ();');
    expect(query).toHaveBeenNthCalledWith(2, 'DROP TABLE users;');
  });

  it('leaves down undefined when there is no down section', () => {
    expect(parseSql('-- migrate:up\nSELECT 1;', 'x.sql').down).toBeUndefined();
  });

  it('refuses a file with no up section, since there is nothing to run', () => {
    expect(() => parseSql('SELECT 1;', 'x.sql')).toThrow(/no "-- migrate:up"/);
  });

  it('reads the transaction opt-out off the marker', () => {
    const module = parseSql(
      '-- migrate:up transaction:false\nCREATE INDEX CONCURRENTLY i ON t (c);',
      'x.sql',
    );

    expect(module.transaction).toBe(false);
  });

  it('sends a section as one statement, leaving splitting to PostgreSQL', async () => {
    // Splitting on `;` here would be wrong the first time a function body or a
    // quoted string contained one.
    const query = vi.fn().mockResolvedValue([]);
    const module = parseSql(
      '-- migrate:up\nCREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;',
      'x.sql',
    );

    await module.up(contextOver(query));

    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('compose', () => {
  const part = (name: string, order: string[]): Module => ({
    up: () => Promise.resolve(void order.push(`up:${name}`)),
    down: () => Promise.resolve(void order.push(`down:${name}`)),
  });

  it('runs up forwards and down in reverse, so foreign keys hold both ways', async () => {
    const order: string[] = [];
    const composed = compose([part('a', order), part('b', order)]);

    await composed.up(contextOver());
    await composed.down?.(contextOver());

    expect(order).toEqual(['up:a', 'up:b', 'down:b', 'down:a']);
  });

  it('has no down at all when no part has one', () => {
    expect(compose([{ up: () => Promise.resolve() }]).down).toBeUndefined();
  });

  it('skips parts without a down rather than failing the revert', async () => {
    const order: string[] = [];
    const composed = compose([
      part('a', order),
      { up: () => Promise.resolve() },
      part('c', order),
    ]);

    await composed.down?.(contextOver());

    expect(order).toEqual(['down:c', 'down:a']);
  });

  it('drops the transaction for the whole migration if any part opts out', () => {
    // Wrapping the others while leaving one bare would mean a failure rolling
    // back some of a migration and not the rest.
    const composed = compose([
      { up: () => Promise.resolve() },
      { up: async () => {}, transaction: false },
    ]);

    expect(composed.transaction).toBe(false);
  });
});
