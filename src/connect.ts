import type { Driver } from './types.js';

/**
 * Reaching a database and letting go of it. The CLI and a container entrypoint
 * use the same shape, so both open and close a connection the same way.
 *
 * There is deliberately no "wait until the database answers" helper here:
 * waiting is orchestration, and the orchestrator already owns it —
 * `depends_on: condition: service_healthy` in a compose file says it where a
 * timeout can be tuned without a release.
 */

/**
 * Open a driver, run one thing, close it however that ends.
 *
 * A closed driver is what lets a one-shot container exit rather than hang on an
 * open pool, so there is deliberately no shape in which a caller opens one and
 * forgets to close it.
 */
export const withDriver = async <T>(
  config: { driver: () => Driver | Promise<Driver> },
  use: (driver: Driver) => Promise<T>,
): Promise<T> => {
  const driver = await config.driver();

  try {
    return await use(driver);
  } finally {
    await driver.close();
  }
};
