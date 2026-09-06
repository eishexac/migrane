import { readFileSync } from 'node:fs';
import { dirname, extname, relative, sep } from 'node:path';
import { discover, unitsIn } from './discover.js';
import type { Resolved } from './config.js';
import type { Discovered } from './types.js';

/**
 * Writing the manifest a bundler can follow.
 *
 * Discovery is a directory read and loading is `import(file)` or
 * `readFileSync`; no bundler follows any of them, and an image has no
 * directories. So a build calls this and bundles what it writes. The lists come
 * from `discover()` and `unitsIn()`, so an image applies the same units in the
 * same order and records the same checksums as the CLI.
 *
 * **Data, not a program**: imports and two arrays, calling nothing. What to do
 * with the arrays is the consumer's entry, which is ordinary source in their
 * repository rather than generated text no linter reaches.
 */

export interface EntryOptions {
  /** The resolved config. Read for its directories, never imported. */
  config: Resolved;
  /**
   * Where the manifest will be written. Given one, every specifier is relative
   * to it, so the file resolves the same on any machine; omitted, specifiers
   * are absolute, which only suits a file going to a temporary directory.
   */
  to?: string;
}

/**
 * POSIX separators unconditionally: `relative` answers with backslashes on
 * Windows, and a backslash in an import specifier is an escape.
 */
const specifierFor = (file: string, to: string | undefined): string => {
  if (!to) return file;

  const path = relative(dirname(to), file).split(sep).join('/');

  return path.startsWith('.') ? path : `./${path}`;
};

/**
 * SQL carried as text rather than imported, because a `.sql` migration is
 * loaded with `readFileSync` and never `import`. Inlining is what that becomes
 * when there is no file to read, byte-for-byte, so the checksum still describes
 * what the image runs.
 *
 * A template literal so newlines survive; three escapes make it reversible.
 */
const inlined = (file: string): string =>
  '`' +
  readFileSync(file, 'utf8')
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('${', '\\${') +
  '`';

interface Emitted {
  imports: string[];
  rows: string[];
}

/**
 * One array's worth of entries: the imports its `.ts` parts need, and a row per
 * unit naming its parts in run order.
 *
 * Parts stay an ordered list of either kind, because a directory without an
 * index may hold both and the order is the dependency order. Composing them is
 * `fromManifest`'s job, which keeps this file importing nothing from the runner.
 */
const emit = (
  found: readonly Discovered[],
  prefix: string,
  to: string | undefined,
): Emitted => {
  const imports: string[] = [];
  const rows: string[] = [];

  found.forEach((entry, index) => {
    const parts = entry.run.map((file, part) => {
      if (extname(file) === '.sql') return `{ sql: ${inlined(file)} }`;

      const binding = `${prefix}${index}_${part}`;

      imports.push(
        `import * as ${binding} from ${JSON.stringify(specifierFor(file, to))};`,
      );

      return binding;
    });

    rows.push(
      `  { name: ${JSON.stringify(entry.name)}, sequence: ${entry.sequence}, checksum: ${JSON.stringify(entry.checksum)}, parts: [${parts.join(', ')}] },`,
    );
  });

  return { imports, rows };
};

const arrayOf = (name: string, rows: readonly string[]): string[] =>
  rows.length
    ? [`export const ${name} = [`, ...rows, '];']
    : [`export const ${name} = [];`];

export const entryFor = ({ config, to }: EntryOptions): string => {
  const migrations = emit(discover(config.dirs), 'm', to);

  // A consumer with no seeds declares none, and gets an empty array rather than
  // a missing export: an entry that destructures both should not have to know
  // which of them this project happens to have.
  const seeds = emit(config.seeds ? unitsIn(config.seeds) : [], 's', to);

  return [
    ...migrations.imports,
    ...seeds.imports,
    ...(migrations.imports.length || seeds.imports.length ? [''] : []),
    ...arrayOf('migrations', migrations.rows),
    '',
    ...arrayOf('seeds', seeds.rows),
    '',
  ].join('\n');
};
