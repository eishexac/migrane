import { describe, expect, it, vi } from 'vitest';
import { build, id, join, quoteIdent, raw, createSql } from './sql.js';

const tag = (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): [TemplateStringsArray, readonly unknown[]] => [strings, values];

describe('build', () => {
  it('binds an interpolated value rather than splicing it', () => {
    const [strings, values] = tag`SELECT ${'x'}`;

    expect(build(strings, values)).toEqual({
      text: 'SELECT $1',
      params: ['x'],
    });
  });

  it('numbers parameters in the order they appear', () => {
    const [strings, values] = tag`${1} ${2} ${3}`;

    expect(build(strings, values).text).toBe('$1 $2 $3');
  });

  it('splices a fragment verbatim and does not count it as a parameter', () => {
    const [strings, values] = tag`SELECT * FROM ${id('users')} WHERE a = ${1}`;

    expect(build(strings, values)).toEqual({
      text: 'SELECT * FROM "users" WHERE a = $1',
      params: [1],
    });
  });

  it('treats a fragment-shaped object literal as a value, so the brand cannot be forged', () => {
    const [strings, values] = tag`${{ text: 'DROP TABLE users' }}`;
    const { params } = build(strings, values);

    expect(params).toHaveLength(1);
  });
});

describe('quoteIdent', () => {
  it('doubles an embedded quote', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});

describe('join', () => {
  it('joins fragments with a separator', () => {
    const [strings, values] = tag`(${join([id('a'), id('b')])})`;

    expect(build(strings, values).text).toBe('("a", "b")');
  });
});

describe('createSql', () => {
  it('sends no parameter array when the template interpolates nothing', () => {
    // The distinction is load-bearing: with no bind parameters PostgreSQL uses
    // the simple query protocol, which is what allows several statements in one
    // template. One parameter switches it to extended, where that is illegal.
    const query = vi.fn().mockResolvedValue([]);
    const sql = createSql({ query });

    void sql`CREATE TABLE a (); CREATE TABLE b ()`;

    expect(query).toHaveBeenCalledWith(
      'CREATE TABLE a (); CREATE TABLE b ()',
      undefined,
    );
  });

  it('sends parameters when the template has them', () => {
    const query = vi.fn().mockResolvedValue([]);
    const sql = createSql({ query });

    void sql`SELECT ${7}`;

    expect(query).toHaveBeenCalledWith('SELECT $1', [7]);
  });

  it('carries raw text through untouched', () => {
    const query = vi.fn().mockResolvedValue([]);
    const sql = createSql({ query });

    void sql`${raw('SET search_path = public')}`;

    expect(query).toHaveBeenCalledWith('SET search_path = public', undefined);
  });
});
