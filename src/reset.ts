import { DEFAULTS } from './defaults.js';
import { toConsole, type Progress } from './runner.js';
import { refuse } from './safety.js';
import { quoteIdent } from './sql.js';
import type { Config, Driver, Guard } from './types.js';

/**
 * Drops every object in a schema.
 *
 * This exists so new DDL can be folded back into an unreleased migration
 * instead of accumulating one-line migrations nobody has run — which is the
 * normal way to work before a first release, and impossible without it, since
 * an applied migration cannot be edited.
 *
 * It is also the only command that leaves a database with *nothing* in it:
 * `up` runs the `before` hooks, so `fresh` always ends with whatever they
 * install, and this does not.
 */

export interface ResetPlan {
  schema: string;
  /** Consulted before anything is dropped. Defaults to `refuse`. */
  guard?: Guard;
}

/** A reset plan from a config, defaulting the schema from the same constant. */
export const resetPlanFrom = (config: Config): ResetPlan => ({
  schema: config.schema ?? DEFAULTS.schema,
  guard: config.guard,
});

/** The guard runs before the schema name is even quoted. See `safety.ts`. */
export const reset = async (
  driver: Driver,
  plan: ResetPlan,
  reporter: Progress = toConsole,
): Promise<void> => {
  await (plan.guard ?? refuse)(driver, 'reset drops every table');

  await driver.query(
    `DROP SCHEMA IF EXISTS ${quoteIdent(plan.schema)} CASCADE`,
  );
  await driver.query(`CREATE SCHEMA ${quoteIdent(plan.schema)}`);

  reporter.line('schema dropped');
};
