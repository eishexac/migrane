import { describe, expect, it } from 'vitest';
import { withDriver } from './connect.js';
import type { Driver, Row } from './types.js';

/**
 * Letting go of a database. A pool left open is what keeps a one-shot migrate
 * service from exiting, and that mistake never shows on a developer machine —
 * so both paths out of `withDriver` are pinned, the failing one especially.
 */

const driverThat = (answers: () => Promise<Row[]>): Driver => ({
  host: 'localhost',
  database: 'fake',
  query: <R extends Row = Row>(): Promise<R[]> => answers() as Promise<R[]>,
  session: <T>(run: (session: never) => Promise<T>) => run(null as never),
  close: async () => {},
});

describe('withDriver', () => {
  it('closes the driver when the work succeeds', async () => {
    let closed = false;
    const driver = { ...driverThat(() => Promise.resolve([])) };

    driver.close = async () => void (closed = true);

    await expect(
      withDriver({ driver: () => driver }, () => Promise.resolve('done')),
    ).resolves.toBe('done');
    expect(closed).toBe(true);
  });

  it('closes it when the work throws, and still throws', async () => {
    let closed = false;
    const driver = { ...driverThat(() => Promise.resolve([])) };

    driver.close = async () => void (closed = true);

    // A migration that fails is the ordinary case, not the exotic one — an
    // open pool there is what leaves a migrate container hanging instead of
    // exiting non-zero and holding the previous release in place.
    await expect(
      withDriver({ driver: () => driver }, () =>
        Promise.reject(new Error('migration failed')),
      ),
    ).rejects.toThrow(/migration failed/);
    expect(closed).toBe(true);
  });
});
