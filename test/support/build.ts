import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * The e2e lane runs the executable, and the executable imports `dist/`.
 *
 * Building here rather than leaving it to a `pretest` script is what makes the
 * lane honest: a spec that passes against yesterday's `dist/` proves nothing
 * about the change under test.
 */
export default function setup(): void {
  execFileSync(join(ROOT, 'node_modules', '.bin', 'tsc'), [
    '-p',
    join(ROOT, 'tsconfig.build.json'),
  ]);
}
