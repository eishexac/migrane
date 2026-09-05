import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * Why an ESM-only package costs a CJS consumer nothing, pinned.
 *
 * Every engine this package supports (`node >= 22.18`) can `require()` an ES
 * module — provided nothing in the required graph awaits at the top level.
 * That proviso is the fragile half: one top-level `await` anywhere `ship`
 * reaches and `require('migrane/ship')` starts throwing, for CJS consumers
 * only, on their machines, with nothing in this repository having failed. So
 * a spawned CJS consumer requires every export, and a refactor that adds one
 * fails here instead of there.
 *
 * Spawned rather than required in-process, because the suite runs under
 * vitest's ESM loader and this question is about node's own.
 */
describe('a CJS consumer', () => {
  // Self-referencing requires, so the specifiers are the ones a consumer
  // writes and the answers come through the `exports` map — `pack:check`
  // verifies that map for `import` only (`attw --profile esm-only`), which
  // makes this the one place the `require` path is walked at all.
  const consumer = [
    "const root = require('migrane');",
    "const ship = require('migrane/ship');",
    "require('migrane/drivers/pg');",
    "console.log(typeof root.defineConfig, typeof ship.up, typeof ship.MigrationChangedError);",
  ].join('\n');

  it('requires every export of the built package', () => {
    const result = spawnSync('node', ['-e', consumer], {
      encoding: 'utf8',
      cwd: ROOT,
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // The error class matters as much as the verbs: exit codes 2 and 3 are
    // assigned by `instanceof`, which a consumer can only evaluate against
    // the class it was able to load.
    expect(result.stdout.trim()).toBe('function function function');
  });
});
