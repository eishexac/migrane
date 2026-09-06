import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { entryFor } from './bundle.js';
import { findConfig, loadConfig, type Resolved } from './config.js';
import { withDriver } from './connect.js';
import { discover, loadAll, unitsIn } from './discover.js';
import { reset, resetPlanFrom } from './reset.js';
import { toConsole, down, status, up, type Plan } from './runner.js';
import { Refusal } from './safety.js';
import { seed, seedStatus, unseed, type SeedPlan } from './seeds.js';
import { MigrationChangedError } from './storage.js';

/**
 * The command surface. `bin/migrane.js` puts it behind the `migrane`
 * executable; {@link run} is exported for that file alone, not for the
 * package — an application that wants these commands under its own runtime
 * writes its own entry over `migrane/ship`.
 */

const USAGE = [
  'usage: up | down | status',
  '       reset | fresh [unit]',
  '       seed <unit> | unseed <unit>',
  '       manifest',
  '',
  'options: --config <path>   the config to read, instead of looking for one',
  '         --out <path>      where `manifest` writes',
].join('\n');

/** Reads `--name <value>` out of the arguments, leaving the rest in place. */
const take = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(name);

  return at === -1 ? undefined : args.splice(at, 2)[1];
};

const planOf = async (config: Resolved): Promise<Plan> => ({
  migrations: await loadAll(discover(config.dirs)),
  table: config.table,
  before: config.before,
  guard: config.guard,
});

const seedsIn = (config: Resolved): string => {
  if (!config.seeds)
    throw new Error('this project declares no "seeds" directory.');

  return config.seeds;
};

/** The seed half of {@link planOf}: read the directory, then load what it found. */
const seedPlanOf = async (config: Resolved): Promise<SeedPlan> => ({
  units: await loadAll(unitsIn(seedsIn(config))),
  table: config.seedTable,
  guard: config.guard,
});

/**
 * Where the manifest goes: what `--out` names, or what the config declares.
 *
 * Neither is an error rather than a default, the same way a missing `seeds`
 * directory is. Two reasons, and the second is the load-bearing one: a path
 * this package invents is a generated file appearing in somebody's repository
 * that they never named — and `entryFor` writes every specifier *relative to
 * the destination*, so guessing where it goes guesses what is in it.
 *
 * `--out` resolves against the caller's cwd, because a path someone typed means
 * what it says from where they typed it. The config's resolves against the
 * config file, like every other path it declares.
 */
const manifestOut = (
  config: Resolved,
  out: string | undefined,
  cwd: string,
): string => {
  if (out) return isAbsolute(out) ? out : resolve(cwd, out);
  if (config.manifest) return config.manifest;

  throw new Error(
    'this project declares no "manifest" path. Add one to the config, or name it with --out <path>.',
  );
};

const unitArg = (config: Resolved, given: string | undefined): string => {
  const available = unitsIn(seedsIn(config)).map(({ name }) => name);

  if (!given) {
    throw new Error(
      `no seed unit given. Available: ${available.join(', ') || '(none)'}`,
    );
  }

  if (!available.includes(given)) {
    // A directory holding nothing runnable is not on this list, and that is the
    // whole of what "unknown" means here — see `unitsIn`.
    throw new Error(
      `unknown seed unit "${given}". Available: ${available.join(', ') || '(none)'}`,
    );
  }

  return given;
};

/**
 * The exit code is the contract a deploy reads: a one-shot migrate container
 * that exits non-zero holds the previous release in place rather than starting
 * a server against a schema that never got written.
 *
 * A code, never a sentence — what lets a consumer's tooling go fully through
 * the CLI and still distinguish outcomes by contract instead of matching
 * stderr:
 *
 * | code | meaning                                          |
 * | ---- | ------------------------------------------------ |
 * | 0    | ok                                               |
 * | 1    | failure                                          |
 * | 2    | refused: a migration changed after it was applied |
 * | 3    | refused: the guard said no                        |
 */
export const run = async (
  argv: readonly string[],
  cwd: string = process.cwd(),
): Promise<number> => {
  const args = [...argv];
  const explicit = take(args, '--config');
  const out = take(args, '--out');

  const [command, argument] = args;

  if (!command) {
    console.error(`\n  no command given.\n\n${USAGE}\n`);

    return 1;
  }

  try {
    const config = await loadConfig(findConfig(cwd, explicit));

    switch (command) {
      case 'up':
        await withDriver(config, async (driver) =>
          up(driver, await planOf(config)),
        );
        break;

      case 'down':
        await withDriver(config, async (driver) =>
          down(driver, await planOf(config)),
        );
        break;

      case 'status':
        await withDriver(config, async (driver) => {
          await status(driver, await planOf(config));

          if (config.seeds) await seedStatus(driver, await seedPlanOf(config));
        });
        break;

      case 'reset':
        await withDriver(config, (driver) =>
          reset(driver, resetPlanFrom(config)),
        );
        break;

      case 'fresh':
        await withDriver(config, async (driver) => {
          await reset(driver, resetPlanFrom(config));
          await up(driver, await planOf(config));

          if (argument) {
            await seed(
              driver,
              await seedPlanOf(config),
              unitArg(config, argument),
            );
          }
        });
        break;

      case 'seed':
        await withDriver(config, async (driver) =>
          seed(driver, await seedPlanOf(config), unitArg(config, argument)),
        );
        break;

      case 'unseed':
        await withDriver(config, async (driver) =>
          unseed(driver, await seedPlanOf(config), unitArg(config, argument)),
        );
        break;

      // The one command that opens no database: a build runs where there is
      // nothing to connect to.
      case 'manifest': {
        const to = manifestOut(config, out, cwd);

        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, entryFor({ config, to }));

        toConsole.line(`wrote ${to}`);
        break;
      }

      default:
        console.error(`\n  unknown command: ${command}\n\n${USAGE}\n`);

        return 1;
    }
  } catch (error) {
    toConsole.line('');
    console.error(error instanceof Error ? error.message : error);
    toConsole.line('');

    // The two refusals a consumer's tooling is entitled to tell apart from a
    // crash, each behind a class rather than a wording — see the table above.
    if (error instanceof MigrationChangedError) return 2;
    if (error instanceof Refusal) return 3;

    return 1;
  }

  return 0;
};
