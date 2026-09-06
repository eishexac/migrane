import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compose, parseSql } from './load.js';
import type { Discovered, Migration, Module } from './types.js';

/**
 * Everything that reads the source tree: finding migrations and seed units on
 * disk, putting them in the order they run, and loading what was found. It is
 * one file so the boundary is one import — the runtime half of the package
 * (`ship.ts` and below) never touches this, which is what lets it compile for
 * a target with no filesystem at all.
 *
 * One rule at every level: **a leading number orders it, a glob finds it.**
 * That holds for a migration inside a root and for a part inside a directory
 * migration, so there is no index file listing parts and no array to remember
 * to edit — adding a table is adding a file.
 */

/** `001-initial`, `20260826143000-add-products`. Both work, and they can mix. */
const NAMED = /^(\d+)-\S+$/;

const LEADING = /^(\d+)/;

const RUNNABLE = new Set(['.ts', '.sql']);

const stripExtension = (segment: string): string => {
  const extension = extname(segment);

  return RUNNABLE.has(extension)
    ? segment.slice(0, -extension.length)
    : segment;
};

/**
 * Orders two relative paths segment by segment, comparing leading numbers as
 * numbers.
 *
 * Plain lexicographic ordering would put `10-users` before `9-people`, which
 * makes correctness depend on remembering to zero-pad. Comparing the number
 * itself means `9-` and `10-` sort the way they read, and a directory whose
 * segments are all numbered sorts correctly by path alone.
 */
export const compareNatural = (a: string, b: string): number => {
  const left = a.split(sep);
  const right = b.split(sep);

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const one = left[index];
    const other = right[index];

    // The shorter path is a prefix of the longer: a file beside a directory
    // runs before what is inside it.
    if (one === undefined) return -1;
    if (other === undefined) return 1;

    const first = LEADING.exec(one)?.[1];
    const second = LEADING.exec(other)?.[1];

    if (first !== undefined && second !== undefined) {
      const difference = Number(first) - Number(second);
      if (difference !== 0) return difference;
    }

    // Compared without the extension, so `010-users.ts` sits beside a
    // `010-users/` directory rather than being ordered against it by `.ts`.
    // Once they tie, the prefix rule above runs the file before the directory's
    // contents, which is the order the names were chosen to mean.
    const difference = stripExtension(one).localeCompare(stripExtension(other));
    if (difference !== 0) return difference;
  }

  return 0;
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) return walk(path);

    return RUNNABLE.has(extname(entry.name)) ? [path] : [];
  });

/**
 * Shared with seed units, which are directories of parts composed exactly like
 * a directory migration and differ only in being picked by name.
 */
export const filesIn = (path: string, directory: boolean): string[] =>
  directory
    ? walk(path).sort((a, b) =>
        compareNatural(relative(path, a), relative(path, b)),
      )
    : [path];

/**
 * Hashes everything the migration would execute — every file of a directory
 * migration, not only its first. Editing a part has to be as visible as
 * editing the whole, or the applied-migration check has a hole in it.
 *
 * **SHA-256 truncated to sixteen hex characters** — sixty-four bits, and worth
 * stating because the value is stored in a row per migration and every
 * consumer's database holds it. The question it answers is *did these bytes
 * change since they were applied*, not *could someone construct a second file
 * that hashes the same*, and sixty-four bits settles the first comfortably. It
 * is short on purpose: a refusal naming it is a line a person has to read.
 */
/**
 * The `index.ts` a directory composes itself with, if it has one. Directly
 * inside it — one nested deeper is a part like any other.
 */
export const indexIn = (
  dir: string,
  files: readonly string[],
): string | undefined => files.find((file) => file === join(dir, 'index.ts'));

export const checksumOf = (files: readonly string[]): string => {
  const hash = createHash('sha256');

  for (const file of files) hash.update(readFileSync(file));

  return hash.digest('hex').slice(0, 16);
};

/**
 * A `.ts`/`.sql` file is one migration; a directory is one migration of parts.
 *
 * **An `index.ts` in a directory is the migration.** Given one it is the only
 * file imported, and the array it composes is the order — data rather than
 * import order, so it survives an IDE reordering the imports above it.
 *
 * Without an index, every runnable file composes in path order and the numbers
 * carry the dependency order. The choice is per directory: an index earns
 * itself on a large migration and is ceremony on two files.
 */
const inRoot = (root: string): Omit<Discovered, 'checksum' | 'sequence'>[] =>
  readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);

      if (entry.isDirectory()) {
        const files = filesIn(path, true);

        // A directory holding nothing runnable is a directory, not a migration
        // someone forgot to fill in — scaffolding a name before writing it is
        // normal, and refusing that would be refusing work in progress.
        if (!files.length) return [];

        const index = indexIn(path, files);

        return [
          { name: entry.name, path, run: index ? [index] : files, files },
        ];
      }

      const extension = extname(entry.name);

      return RUNNABLE.has(extension)
        ? [
            {
              name: basename(entry.name, extension),
              path,
              run: [path],
              files: [path],
            },
          ]
        : [];
    })
    .sort((a, b) => compareNatural(a.name, b.name));

/**
 * Every migration across every root, in the order they run: the roots' order,
 * then the leading number within a root.
 *
 * The name is the storage key, so it has to be unique across all of them — the
 * one thing here that is global rather than local to a directory.
 */
export const discover = (roots: readonly string[]): Discovered[] => {
  const found = roots.flatMap(inRoot).map((entry) => {
    const sequence = NAMED.exec(entry.name)?.[1];

    if (sequence === undefined) {
      // Skipping it would mean a migration that never runs and never says so.
      throw new Error(
        `Migration "${entry.name}" must be named <number>-<slug>, e.g. 001-initial or 20260826143000-add-products.`,
      );
    }

    return {
      ...entry,
      sequence: Number(sequence),
      checksum: checksumOf(entry.files),
    };
  });

  const duplicate = found.find(
    (entry, index) =>
      found.findIndex((other) => other.name === entry.name) !== index,
  );

  if (duplicate) {
    throw new Error(
      `Two migrations are named "${duplicate.name}". The name is the storage key, so it has to be unique across every root.`,
    );
  }

  return found;
};

/**
 * Every directory under the seeds root holding something runnable — the seed
 * half of {@link discover}.
 *
 * A unit composes exactly like a directory migration, `index.ts` rule
 * included. `discover()` cannot find it because that enforces a
 * `<number>-<slug>` name, and a unit has no number: you pick it by name, so
 * `sequence` is `0` for all of them. A directory holding nothing runnable is
 * skipped, as `discover` does.
 */
export const unitsIn = (dir: string): Discovered[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          const path = join(dir, entry.name);
          const files = filesIn(path, true);

          if (!files.length) return [];

          const index = indexIn(path, files);

          return [
            {
              name: entry.name,
              sequence: 0,
              path,
              run: index ? [index] : files,
              files,
              checksum: checksumOf(files),
            },
          ];
        })
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

const loadFile = async (file: string, root: string): Promise<Module> => {
  const label = relative(root, file) || file;

  if (extname(file) === '.sql') {
    return parseSql(readFileSync(file, 'utf8'), label);
  }

  // A file URL rather than the path: on Windows a bare absolute path is not a
  // valid specifier, and this is the one place the package touches the loader.
  const module = (await import(pathToFileURL(file).href)) as Partial<Module>;

  if (typeof module.up !== 'function') {
    throw new Error(`${label} does not export an "up" function.`);
  }

  return module as Module;
};

/**
 * Loads one discovered migration, composing its parts if it has several.
 *
 * `run` rather than `files`: a directory with an `index.ts` runs that one file,
 * and the rest are its imports. They still count towards the checksum, which is
 * discovery's business rather than this one's.
 */
export const load = async (entry: Discovered): Promise<Migration> => {
  const parts = await Promise.all(
    entry.run.map((file) => loadFile(file, entry.path)),
  );

  return {
    name: entry.name,
    sequence: entry.sequence,
    checksum: entry.checksum,
    module: parts.length === 1 ? (parts[0] as Module) : compose(parts),
  };
};

export const loadAll = (entries: readonly Discovered[]): Promise<Migration[]> =>
  Promise.all(entries.map(load));
