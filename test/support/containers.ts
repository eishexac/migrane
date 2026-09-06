import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

/**
 * One PostgreSQL, for the whole `int` lane.
 *
 * The lane exists because most of this package is only true against a real
 * database: an advisory lock two sessions contend for, a transaction that rolls
 * a failed migration back, `CREATE TABLE IF NOT EXISTS` being idempotent twice
 * over. A fake driver can be asked what it was told; it cannot be asked what
 * PostgreSQL did with it.
 *
 * One container with a database per spec file, rather than a container each:
 * starting a server costs seconds and creating a database costs milliseconds,
 * and what a file needs is isolation, not a server of its own.
 *
 * The image is pinned, because a lane that silently follows `latest` is a lane
 * that can fail for a reason nobody changed.
 */

declare module 'vitest' {
  interface ProvidedContext {
    postgres: string;
  }
}

const IMAGE = 'postgres:18-alpine';

export default async function setup(project: TestProject) {
  const container = await new PostgreSqlContainer(IMAGE).start();

  project.provide('postgres', container.getConnectionUri());

  return async () => {
    await container.stop();
  };
}
