import { describe, expect, it } from 'vitest';
import { refuse, Refusal } from './safety.js';
import type { Driver } from './types.js';

/**
 * `refuse` always throws, so what is tested is the message — which is its
 * whole job: it has to carry a guard a person can paste into their config once
 * they have read the coordinates in it and decided that database is theirs to
 * lose. There is deliberately no case where it returns, and no environment
 * variable to stub: the library consults nothing.
 */
const driverAt = (host: string, database: string): Driver => ({
  host,
  database,
  query: () => Promise.resolve([]),
  session: () => Promise.reject(new Error('the guard runs before any query')),
  close: () => Promise.resolve(),
});

const WHAT = 'reset drops every table';

describe('refuse', () => {
  it('refuses everything, localhost included', () => {
    // Locality was v1's proxy for disposability, and it was wrong on any
    // droplet running Postgres host-networked: production *is* 127.0.0.1.
    for (const host of [
      'localhost',
      '127.0.0.1',
      '::1',
      '',
      'db.example.com',
    ]) {
      expect(() => refuse(driverAt(host, 'app'), WHAT)).toThrow(Refusal);
    }
  });

  it('opens the refusal with what the command does', () => {
    expect(() => refuse(driverAt('localhost', 'app'), WHAT)).toThrow(
      /^reset drops every table,/,
    );
  });

  it('names the exact coordinates it refused', () => {
    expect(() =>
      refuse(driverAt('db.example.com', 'drift_test'), WHAT),
    ).toThrow(/"drift_test" on "db\.example\.com"/);
  });

  it('carries a paste-ready guard naming those coordinates', () => {
    const thrown = (() => {
      try {
        refuse(driverAt('127.0.0.1', 'drift_test'), WHAT);
      } catch (error) {
        return error as Error;
      }

      throw new Error('refuse returned');
    })();

    // The fix is the message: a guard that allows exactly this database and
    // ends in refuse for everything else. Asserted line by line so the snippet
    // cannot drift into something that no longer compiles as a config field.
    expect(thrown.message).toContain('guard: (driver, what) => {');
    expect(thrown.message).toContain(
      "if (driver.host === '127.0.0.1' && driver.database === 'drift_test') return;",
    );
    expect(thrown.message).toContain('refuse(driver, what);');
  });

  it('throws its own class, so the CLI can answer with the guard exit code', () => {
    expect(() => refuse(driverAt('localhost', 'app'), WHAT)).toThrow(Refusal);
    expect(new Refusal('x').name).toBe('Refusal');
  });
});
