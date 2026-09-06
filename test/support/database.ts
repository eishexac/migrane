import { Client } from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';
import { pgDriver } from 'migrane/drivers/pg';
import type { Driver } from 'migrane';

/**
 * A database of this spec file's own, inside the lane's one server.
 *
 * Every case here writes DDL — bookkeeping tables, migrated tables, a dropped
 * schema — so files cannot share one database and cases within a file cannot be
 * rolled back around: `reset` drops the schema out from under a transaction,
 * and an advisory lock is only interesting across two connections that are both
 * real. Isolation is therefore a database per file and truncation between
 * cases, which each spec does for the tables it made.
 *
 * The name comes from the caller rather than a counter, so a container left
 * running after a failure can be opened and read by the name of the spec that
 * failed.
 */
export function database(name: string): () => Driver {
  let driver: Driver;

  beforeAll(async () => {
    const uri = inject('postgres');
    const admin = new Client({ connectionString: uri });

    await admin.connect();

    try {
      // Quoted, and the name is ours rather than a fixture's — but this is the
      // one statement in the lane that cannot take a parameter, so it is worth
      // being explicit that it is not reachable from test data.
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }

    driver = pgDriver(new URL(`/${name}`, uri).href);
  });

  afterAll(async () => {
    await driver?.close();
  });

  return () => driver;
}
