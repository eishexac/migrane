import type { Fragment, Queryable, Row, Sql } from './types.js';

/**
 * The runtime half of {@link Fragment}'s brand.
 *
 * `types.ts` declares the property with a `unique symbol` that has no value, so
 * the brand costs nothing at run time and cannot be forged by writing an object
 * literal. This is the only place that gap is bridged.
 */
const MARK = Symbol('migrane.fragment');

interface Marked {
  readonly [MARK]: string;
}

const isFragment = (value: unknown): value is Marked =>
  typeof value === 'object' && value !== null && MARK in value;

/**
 * Splice text into a statement verbatim.
 *
 * DDL is mostly things that cannot be bind parameters — table names, types,
 * defaults, whole constraint bodies — so this has to exist. Making it a
 * function call rather than the default behaviour means every unescaped
 * interpolation is visible in a diff.
 */
export const raw = (text: string): Fragment =>
  ({ [MARK]: text }) as unknown as Fragment;

/**
 * Quote an identifier as a plain string.
 *
 * Separate from {@link id} because the package builds statements of its own —
 * the bookkeeping table — where a `Fragment` would have to be unwrapped again
 * to reach the text.
 */
export const quoteIdent = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;

/** Quote an identifier. `id('user table')` is `"user table"`. */
export const id = (name: string): Fragment => raw(quoteIdent(name));

/** Join fragments — a column list, a set of constraints. */
export const join = (parts: readonly Fragment[], separator = ', '): Fragment =>
  raw(parts.map((part) => (part as unknown as Marked)[MARK]).join(separator));

export interface Statement {
  text: string;
  params: unknown[];
}

/**
 * Turns a template into a statement and its bind parameters.
 *
 * Anything that is not a {@link Fragment} becomes a `$n` placeholder, so the
 * ordinary way to interpolate a value is also the safe one and injecting SQL
 * takes a deliberate `sql.raw`.
 */
export const build = (
  strings: TemplateStringsArray,
  values: readonly unknown[],
): Statement => {
  let text = strings[0] ?? '';
  const params: unknown[] = [];

  for (const [index, value] of values.entries()) {
    if (isFragment(value)) text += value[MARK];
    else {
      params.push(value);
      text += `$${params.length}`;
    }

    text += strings[index + 1] ?? '';
  }

  return { text, params };
};

/**
 * The tagged template bound to one connection — the same `sql` a migration
 * receives in its {@link Context}, constructed over any {@link Queryable}.
 *
 * Exported because it is the only constructor for the `Sql` and `Fragment`
 * types (the brand is a private symbol), and because a {@link Hook} is allowed
 * to run over a connection this package did not open. There is deliberately no
 * second `sql` namespace object: the tag is the namespace, so there is exactly
 * one way to spell `sql.raw` everywhere.
 *
 * A template with no interpolated values sends no bind parameters, which is
 * what lets a migration write several statements in one template: PostgreSQL
 * only restricts a request to a single statement once the extended protocol is
 * in play, and that starts at the first parameter.
 */
export const createSql = (db: Queryable): Sql => {
  const tag = <R extends Row = Row>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<R[]> => {
    const { text, params } = build(strings, values);

    return db.query<R>(text, params.length ? params : undefined);
  };

  return Object.assign(tag, { raw, id, join });
};
