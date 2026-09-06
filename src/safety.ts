import type { Driver } from './types.js';

/**
 * The refusal every destructive command falls back to, and the terminal every
 * consumer-written guard ends in.
 *
 * The library consults **nothing** here — no environment variable, no notion
 * of which hosts are local. Locality was a bad proxy anyway: on a droplet
 * running Postgres host-networked, production *is* `127.0.0.1`. Which
 * databases are disposable is the config's opinion, so the config is where it
 * is declared, and until it is declared nothing destructive runs.
 */

/**
 * Thrown by {@link refuse}, and nothing else. A class of its own so the CLI
 * can answer with its exit code for "the guard said no" — matching on the
 * message would catch the next error whose wording happened to look similar.
 */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refusal';
  }
}

/**
 * Always throws. Its whole job is the message: a guard snippet naming the
 * exact coordinates the driver holds, ready to paste into the config once a
 * person has read them and decided they name a database that is theirs to
 * lose. Reached as the default when the config declares no guard, and as the
 * last line of a guard for whatever it did not allow — the message is written
 * to be true from both.
 *
 * @param what what the command does, as a clause — `reset drops every table`.
 * It opens the message, so the refusal reads as a sentence about the command
 * rather than about the guard.
 */
export const refuse = (driver: Driver, what: string): never => {
  const { host, database } = driver;

  throw new Refusal(
    `${what}, and nothing says "${database}" on "${host}" is disposable.\n` +
      `  If it is, say so in the config — the guard replaces this refusal:\n` +
      `\n` +
      `    guard: (driver, what) => {\n` +
      `      if (driver.host === '${host}' && driver.database === '${database}') return;\n` +
      `\n` +
      `      refuse(driver, what);\n` +
      `    },`,
  );
};
