import { describe, expect, it } from 'vitest';
import { verify, type Applied } from './storage.js';
import { lockKey } from './lock.js';

const row = (name: string, checksum: string): Applied => ({
  name,
  checksum,
  run_at: '2026-08-27T00:00:00.000Z',
});

describe('verify', () => {
  it('passes when what ran is what is on disk', () => {
    expect(() =>
      verify(
        [row('001-initial', 'abc')],
        [{ name: '001-initial', checksum: 'abc' }],
      ),
    ).not.toThrow();
  });

  it('refuses a migration edited after it was applied', () => {
    expect(() =>
      verify(
        [row('001-initial', 'abc')],
        [{ name: '001-initial', checksum: 'xyz' }],
      ),
    ).toThrow(/changed after it was applied/);
  });

  it('allows a recorded migration that is no longer on disk', () => {
    // Deleting or renaming migrations is what squashing them looks like, and
    // refusing it would make a legitimate operation impossible.
    expect(() => verify([row('001-old', 'abc')], [])).not.toThrow();
  });
});

describe('lockKey', () => {
  it('is stable for a name', () => {
    expect(lockKey('migrations')).toBe(lockKey('migrations'));
  });

  it('differs between names, so two applications do not block each other', () => {
    expect(lockKey('migrations')).not.toBe(lockKey('other_migrations'));
  });

  it('stays inside a safe integer range', () => {
    expect(Number.isSafeInteger(lockKey('migrations'))).toBe(true);
  });
});
