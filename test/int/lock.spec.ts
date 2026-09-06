import { describe, expect, it } from 'vitest';
import { withLock } from '../../src/lock.js';
import { database } from '../support/database.js';

/**
 * The lock is the one feature that cannot be tested without a database.
 *
 * It exists so two deploys starting at once cannot both read an empty
 * bookkeeping table and both run the same `CREATE TABLE` — and the only way to
 * observe that is two real connections contending for a real lock. Until this
 * file, the property had never been executed: `lock.spec.ts` covers `lockKey`,
 * which is a hash.
 */

const db = database('migrane_lock');

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe('withLock', () => {
  it('makes the second holder wait for the first', async () => {
    const order: string[] = [];
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });

    const first = db().session((session) =>
      withLock(session, 'migrations', async () => {
        order.push('first in');
        await held;
        order.push('first out');
      }),
    );

    // Not a race: until the first holder says it is inside, there is no lock to
    // contend for and the second would pass for the wrong reason.
    while (!order.includes('first in')) await settle();

    const second = db().session((session) =>
      withLock(session, 'migrations', async () => {
        order.push('second in');
      }),
    );

    // Long enough that an unheld lock would certainly have let it through, so
    // the assertion is about blocking rather than about scheduling.
    await settle();
    expect(order).toEqual(['first in']);

    letGo();
    await Promise.all([first, second]);

    expect(order).toEqual(['first in', 'first out', 'second in']);
  });

  it('releases the lock when the run throws', async () => {
    await expect(
      db().session((session) =>
        withLock(session, 'migrations', () =>
          Promise.reject(new Error('the migration failed')),
        ),
      ),
    ).rejects.toThrow('the migration failed');

    // The next holder must not inherit the failure as a hang, which is what an
    // unreleased session-level lock would look like.
    await expect(
      db().session((session) =>
        withLock(session, 'migrations', () => Promise.resolve('taken')),
      ),
    ).resolves.toBe('taken');
  });

  it('does not block a different table', async () => {
    const inside: string[] = [];
    let letGo!: () => void;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });

    const first = db().session((session) =>
      withLock(session, 'migrations', async () => {
        inside.push('migrations');
        await held;
      }),
    );

    while (!inside.includes('migrations')) await settle();

    // Two applications sharing one database is the case this separates: the key
    // is derived from the table name so neither waits on the other.
    await db().session((session) =>
      withLock(session, 'seeds', async () => {
        inside.push('seeds');
      }),
    );

    expect(inside).toEqual(['migrations', 'seeds']);

    letGo();
    await first;
  });
});
