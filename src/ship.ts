import { fromManifest, type Manifest } from './load.js';
import { planFrom, type Plan } from './runner.js';
import { resetPlanFrom, type ResetPlan } from './reset.js';
import { seedPlanFrom, type SeedPlan } from './seeds.js';
import type { Config } from './types.js';

/**
 * The runtime half of the package, for **container entries**: every job that
 * does not touch a filesystem. A generated manifest plus a config becomes
 * plans, and the verbs below run them — the same verbs, against the same
 * bookkeeping, as the CLI on a developer machine.
 *
 * Filesystem-free by construction, not by tree-shaking luck: nothing imported
 * here reaches `node:fs`, and `tsconfig.ship.json` compiles this file for a
 * target with no platform libs at all, so an import sneaking in fails the
 * build rather than the review.
 *
 * ```ts
 * // database/entry.ts — ordinary source in your repository
 * import { createPlans, up, withDriver } from 'migrane/ship';
 * import config from './config.ts';
 * import * as manifest from './manifest.gen.ts';
 *
 * const plans = createPlans(config, manifest);
 *
 * await withDriver(config, (driver) => up(driver, plans.migrations));
 * ```
 */

/** Every plan a manifest can feed, one per family of verbs. */
export interface Plans {
  /** For {@link up}, {@link down} and {@link status}. */
  migrations: Plan;
  /** For {@link seed}, {@link unseed} and {@link seedStatus}. */
  seeds: SeedPlan;
  /** For {@link reset}. */
  reset: ResetPlan;
}

/**
 * A config and a generated manifest, settled into every plan the verbs take.
 *
 * One constructor rather than four builders, because there is exactly one
 * correct way to combine them and nothing worth deciding in between. The
 * defaults — table names, schema — settle here from the same constants the
 * CLI uses, so an image can never record migrations in a table the CLI does
 * not look in.
 */
export const createPlans = (config: Config, manifest: Manifest): Plans => ({
  migrations: planFrom(config, fromManifest(manifest.migrations)),
  seeds: seedPlanFrom(config, fromManifest(manifest.seeds)),
  reset: resetPlanFrom(config),
});

export { withDriver } from './connect.js';
export type { Manifest, ManifestEntry, ManifestPart } from './load.js';
export { reset, type ResetPlan } from './reset.js';
export {
  down,
  status,
  up,
  type Plan,
  type Progress,
  type Status,
} from './runner.js';
export {
  seed,
  seedStatus,
  unseed,
  type SeedPlan,
  type Seeded,
} from './seeds.js';
export { MigrationChangedError } from './storage.js';
