import type { Context, Migration, Module } from './types.js';

/**
 * Turning migration text and manifest entries into something runnable —
 * deliberately without touching a filesystem, so all of it ships into an
 * image. Reading files is `discover.ts`'s business; this file only ever takes
 * what a caller already holds.
 *
 * A directory migration's parts are composed here rather than by an `index.ts`
 * the author writes: `up` in path order, `down` in reverse, so foreign keys
 * hold in both directions. That is the whole reason the numbers on the files
 * are load-bearing — they are the dependency order, and there is no second
 * place stating it.
 */

/** `-- migrate:up`, optionally `-- migrate:up transaction:false`. */
const SECTION = /^\s*--\s*migrate:(up|down)\b(.*)$/;

/**
 * A `.sql` migration: two sections, marked by comments.
 *
 * The whole section is sent as one statement with no bind parameters, so
 * PostgreSQL's simple query protocol runs every statement in it. Splitting on
 * `;` ourselves would be wrong the first time a function body or a quoted
 * string contained one.
 */
export const parseSql = (text: string, label: string): Module => {
  const sections: Record<string, string[]> = {};
  let current: string[] | undefined;
  let transacted = true;

  for (const line of text.split('\n')) {
    const marker = SECTION.exec(line);

    if (marker) {
      if (/\btransaction:\s*false\b/.test(marker[2] ?? '')) transacted = false;
      current = sections[marker[1] as string] ??= [];
      continue;
    }

    current?.push(line);
  }

  if (!sections.up) {
    throw new Error(
      `${label} has no "-- migrate:up" section, so there is nothing to run.`,
    );
  }

  const body = (key: string) => sections[key]?.join('\n').trim();

  const up = body('up');
  const down = body('down');

  return {
    transaction: transacted,
    up: async ({ db }) => {
      if (up) await db.query(up);
    },
    down: down ? async ({ db }) => void (await db.query(down)) : undefined,
  };
};

/**
 * Runs parts in declaration order and reverses them for `down`.
 *
 * The transaction opt-out is taken by the whole migration if any single part
 * asks for it. A part needing `CREATE INDEX CONCURRENTLY` cannot be wrapped,
 * and wrapping the others while leaving that one bare would mean a failure
 * rolling back some of a migration and not the rest — worse than being honest
 * that this one is not atomic.
 */
export const compose = (parts: readonly Module[]): Module => ({
  transaction: parts.every((part) => part.transaction !== false),

  up: async (context: Context) => {
    for (const part of parts) await part.up(context);
  },

  down: parts.some((part) => part.down)
    ? async (context: Context) => {
        for (const part of [...parts].reverse()) await part.down?.(context);
      }
    : undefined,
});

/**
 * One part of a shipped unit: a module the manifest imported, or SQL text it
 * carried inline because an image has no file to read.
 */
export type ManifestPart = Module | { sql: string };

/** One migration or seed unit, as the generated manifest names it. */
export interface ManifestEntry {
  name: string;
  sequence: number;
  checksum: string;
  parts: readonly ManifestPart[];
}

/**
 * What `migrane manifest` generates, named here so a consumer's entry never
 * has to hand-declare the shape of a file this package wrote. The two arrays
 * are always both present — a project with no seeds gets an empty one, so an
 * entry that destructures both need not know which this project has.
 */
export interface Manifest {
  migrations: readonly ManifestEntry[];
  seeds: readonly ManifestEntry[];
}

const moduleOf = (part: ManifestPart, label: string): Module =>
  'sql' in part ? parseSql(part.sql, label) : part;

/**
 * Turns a manifest's arrays into units the runner takes — loading for a
 * machine with no source tree.
 *
 * The same composition rule applies, because it is the same rule: one part runs
 * as itself, several compose in order with `down` reversed. Parsing the inline
 * SQL happens here rather than in the generated file, which is what lets that
 * file import nothing from this package.
 */
export const fromManifest = (entries: readonly ManifestEntry[]): Migration[] =>
  entries.map(({ parts, ...rest }) => ({
    ...rest,
    module:
      parts.length === 1
        ? moduleOf(parts[0] as ManifestPart, rest.name)
        : compose(parts.map((part) => moduleOf(part, rest.name))),
  }));
