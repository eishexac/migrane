/**
 * A project whose config and migrations are TypeScript.
 *
 * The syntax here is deliberately TS-only — an `interface`, a `satisfies`, a
 * return type — so a runtime that does not strip types fails loudly rather than
 * quietly reading the file as JavaScript. It imports nothing from `migrane`,
 * because the executable under test resolves the package from `dist/` and a
 * fixture reaching for it would be testing resolution instead of stripping.
 */
interface Fixture {
  dirs: string[];
  driver: () => never;
}

export default {
  dirs: ['./migrations'],
  driver: (): never => {
    throw new Error('the fixture driver must not be reached');
  },
} satisfies Fixture;
