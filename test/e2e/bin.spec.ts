import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const BIN = join(ROOT, 'bin', 'migrane.js');

const scratch: string[] = [];

/**
 * A PATH holding exactly the named runtimes, and nothing else.
 *
 * The stubs answer with their own name instead of running anything, so what a
 * case asserts is which runtime the dispatch line *chose* — a question the real
 * runtimes cannot answer, since both would go on to print the same usage. `sh`
 * is always linked in: the shebang is `#!/usr/bin/env sh`, so `env` resolves
 * `sh` through this PATH like any other name.
 */
function pathWith(...runtimes: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrane-path-'));

  scratch.push(dir);
  symlinkSync('/bin/sh', join(dir, 'sh'));

  for (const name of runtimes) {
    const stub = join(dir, name);

    writeFileSync(stub, `#!/bin/sh\necho "${name} $*"\n`);
    chmodSync(stub, 0o755);
  }

  return dir;
}

const at = (path: string, argv: string[] = [], env: NodeJS.ProcessEnv = {}) =>
  spawnSync(BIN, argv, { encoding: 'utf8', env: { PATH: path, ...env } });

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('choosing a runtime', () => {
  it('takes node when both are there', () => {
    expect(at(pathWith('node', 'bun')).stdout.trim()).toBe(`node ${BIN}`);
  });

  it('falls back to bun when node is absent', () => {
    expect(at(pathWith('bun')).stdout.trim()).toBe(`bun ${BIN}`);
  });

  it('takes the order MIGRANE_RUNTIME names', () => {
    const result = at(pathWith('node', 'bun'), [], { MIGRANE_RUNTIME: 'bun' });

    expect(result.stdout.trim()).toBe(`bun ${BIN}`);
  });

  it('forwards its arguments untouched', () => {
    const argv = ['up', '--config', 'db/migrate.config.ts'];

    expect(at(pathWith('node'), argv).stdout.trim()).toBe(
      `node ${BIN} ${argv.join(' ')}`,
    );
  });

  it('says so, and fails, when neither is installed', () => {
    const result = at(pathWith());

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('needs node or bun on PATH');
  });

  /**
   * The flag is the executable's, not the command surface's: it is read by the
   * dispatch line before anything of ours has parsed anything, and consumed
   * there. So what these assert is both halves at once — which runtime was
   * chosen, and that what reached it no longer carries the flag.
   */
  it('takes the runtime a --runtime= flag names', () => {
    const result = at(pathWith('node', 'bun'), ['--runtime=bun', 'up']);

    expect(result.stdout.trim()).toBe(`bun ${BIN} up`);
  });

  it('forwards the remaining arguments without the flag', () => {
    const argv = ['--runtime=bun', 'manifest', '--out', 'gen/manifest.ts'];

    expect(at(pathWith('node', 'bun'), argv).stdout.trim()).toBe(
      `bun ${BIN} manifest --out gen/manifest.ts`,
    );
  });

  it('lets the flag win over the environment variable', () => {
    // The more local of the two: an export answers for every command after it,
    // and the flag answers only for the command it is written on.
    const result = at(pathWith('node', 'bun'), ['--runtime=node', 'up'], {
      MIGRANE_RUNTIME: 'bun',
    });

    expect(result.stdout.trim()).toBe(`node ${BIN} up`);
  });

  it('falls back to the default order when the flag names nothing', () => {
    const result = at(pathWith('node', 'bun'), ['--runtime=', 'up']);

    expect(result.stdout.trim()).toBe(`node ${BIN} up`);
  });

  it('reads the flag only in first position', () => {
    // Scanning the whole list would take more shell than fits on a line that
    // also has to be a JavaScript comment, so a flag written later is left for
    // `run()` to reject rather than silently honoured.
    const result = at(pathWith('node', 'bun'), ['up', '--runtime=bun']);

    expect(result.stdout.trim()).toBe(`node ${BIN} up --runtime=bun`);
  });
});

/**
 * The dispatch cases above never reach the JavaScript, because their stubs
 * answer instead of running it. These do: the same file has to parse as a
 * module under both runtimes, which is the half of the polyglot that the stubs
 * cannot prove.
 */
describe('running the executable itself', () => {
  // A contributor who has only one of the two runtimes should still get a green
  // suite, so the missing one's case skips rather than fails. CI installs both,
  // which is what stops that leniency from hiding a broken runtime.
  const installed = (runtime: string) =>
    spawnSync(runtime, ['--version']).status === 0;

  for (const runtime of ['node', 'bun']) {
    it.skipIf(!installed(runtime))(`parses and runs under ${runtime}`, () => {
      const result = spawnSync(runtime, [BIN], { encoding: 'utf8' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no command given');
      expect(result.stderr).not.toContain('SyntaxError');
    });
  }

  it('refuses a command it does not have', () => {
    // Inside a project, because the config is resolved before the verb is
    // read — outside one, every command answers "no migration config found"
    // first and this would assert nothing about the verb table.
    const result = spawnSync(BIN, ['migrate'], {
      encoding: 'utf8',
      cwd: join(import.meta.dirname, '..', 'fixtures', 'project'),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown command: migrate');
    expect(result.stderr).not.toContain('fixture driver must not be reached');
  });

  it('says where it looked when there is no config', () => {
    const result = spawnSync(BIN, ['up'], { encoding: 'utf8', cwd: tmpdir() });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no migration config found');
  });
});

/**
 * One refusal through the real executable, pinning the guard's exit code from
 * the outside — the full mapping is `src/cli.spec.ts`'s business, but a
 * harness reads this number off a spawned process, so one case earns its spawn.
 */
describe('the guard exit code', () => {
  const project = join(
    import.meta.dirname,
    '..',
    'fixtures',
    'guardless-project',
  );

  it('answers 3, before the driver is ever reached', () => {
    const result = spawnSync(BIN, ['reset'], {
      encoding: 'utf8',
      cwd: project,
    });

    expect(result.status).toBe(3);
    expect(result.stderr).toContain('is disposable');
    expect(result.stderr).not.toContain('fixture driver must not be reached');
  });
});

/**
 * Generating a manifest is a build step, and a build runs where there is
 * nothing to connect to.
 *
 * The fixture's driver throws when it is called, which makes it the right
 * project to prove that on: a command that reached for one would fail with the
 * fixture's own message rather than writing a file.
 */
describe('the manifest command', () => {
  const project = join(import.meta.dirname, '..', 'fixtures', 'project');

  const generate = (argv: string[]) =>
    spawnSync(BIN, ['manifest', ...argv], { encoding: 'utf8', cwd: project });

  it('writes a manifest without opening a database', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'migrane-manifest-')), 'm.ts');

    scratch.push(dirname(out));

    const result = generate(['--out', out]);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('fixture driver must not be reached');
    expect(result.stdout).toContain(`wrote ${out}`);

    const written = readFileSync(out, 'utf8');

    // The fixture's migration is `.sql`, so it is carried as text and the
    // manifest imports nothing at all.
    expect(written).toContain('export const migrations = [');
    expect(written).toContain('CREATE TABLE users (id int);');
    expect(written).not.toContain('import ');
  });

  it('refuses when neither the config nor --out names a destination', () => {
    // Not a default, deliberately: the manifest's specifiers are written
    // relative to where it lands, so guessing the destination guesses the
    // contents — and a generated file would appear in a repository under a
    // name nobody chose.
    const result = generate([]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('declares no "manifest" path');
    expect(existsSync(join(project, 'manifest.gen.ts'))).toBe(false);
  });
});

/**
 * Both runtimes, running a real command, against TypeScript.
 *
 * Everything above that names bun answers with a stub on `PATH` — which is the
 * only way to ask *which* runtime the dispatch line chose, since both real ones
 * would go on to print the same thing. It is also the reason bun was otherwise
 * untested: the suite proved the line picks it and never proved it works.
 *
 * `manifest` is the command to prove it with. It loads the consumer's config
 * through `import()`, walks the migration directories and writes a file, and it
 * opens no database — so it exercises the half that differs between runtimes
 * (module resolution and type stripping) without needing one.
 *
 * The fixture's config and one of its migrations are TypeScript with syntax
 * that is not valid JavaScript, so a runtime that failed to strip types would
 * fail here rather than quietly succeed.
 */
describe('both runtimes, on a TypeScript project', () => {
  const project = join(import.meta.dirname, '..', 'fixtures', 'ts-project');

  const installed = (runtime: string) =>
    spawnSync(runtime, ['--version']).status === 0;

  const generate = (out: string, runtime?: string) =>
    spawnSync(
      BIN,
      [...(runtime ? [`--runtime=${runtime}`] : []), 'manifest', '--out', out],
      { encoding: 'utf8', cwd: project },
    );

  const scratchFile = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'migrane-runtime-'));

    scratch.push(dir);

    return join(dir, name);
  };

  for (const runtime of [undefined, 'bun'] as const) {
    const label = runtime ?? 'node';

    it.skipIf(runtime !== undefined && !installed(runtime))(
      `generates a manifest under ${label}`,
      () => {
        const out = scratchFile(`${label}.gen.ts`);
        const result = generate(out, runtime);

        expect(result.stderr).not.toContain(
          'fixture driver must not be reached',
        );
        expect(result.status).toBe(0);

        const written = readFileSync(out, 'utf8');

        // The `.ts` migration is imported and the `.sql` one is inlined, which
        // is only reachable if the TypeScript config was read at all.
        expect(written).toContain('001-users.ts');
        expect(written).toContain(
          'CREATE TABLE products (id serial PRIMARY KEY);',
        );
      },
    );
  }

  it.skipIf(!installed('bun'))(
    'agrees with node byte for byte, checksums included',
    () => {
      const fromNode = scratchFile('node.gen.ts');
      const fromBun = scratchFile('bun.gen.ts');

      expect(generate(fromNode).status).toBe(0);
      expect(generate(fromBun, 'bun').status).toBe(0);

      // The whole promise of the manifest: an image built under either runtime
      // records the same hashes, so a container cannot refuse a migration the
      // developer machine says is fine.
      expect(readFileSync(fromBun, 'utf8')).toBe(
        readFileSync(fromNode, 'utf8'),
      );
    },
  );
});
