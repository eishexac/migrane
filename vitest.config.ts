import { defineConfig } from 'vitest/config';

/**
 * Three lanes, split by what has to be true before a case can run.
 *
 * | lane | holds                                  | needs        |
 * | ---- | -------------------------------------- | ------------ |
 * | unit | pure functions, colocated in `src/`    | nothing      |
 * | int  | everything that is really SQL          | docker       |
 * | e2e  | the executable, over a built `dist/`   | a build      |
 *
 * A lane is a directory rather than a filename suffix, so where a spec lives
 * says what it may assume — and `test/support/` and `test/fixtures/` sit beside
 * them, belonging to no single lane.
 */
export default defineConfig({
  // Specs import `migrane` and `migrane/drivers/pg`, the same specifiers a
  // consumer writes, and this condition points them at `src/` rather than a
  // built `dist/`. Two things follow: a spec can only reach what the package
  // actually exports, and `@source` in `exports` has a user instead of being a
  // line nothing resolves. The `e2e` lane is unaffected — it spawns the real
  // executable, which imports `dist/` by path.
  ssr: {
    resolve: { conditions: ['@source'] },
  },
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts'],
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['src/**/*.spec.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'int',
          include: ['test/int/**/*.spec.ts'],
          globalSetup: './test/support/containers.ts',
          // Starting a container is slow and pulling one is slower; the hook
          // timeout covers a machine that has never run this lane.
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.spec.ts'],
          globalSetup: './test/support/build.ts',
        },
      },
    ],
  },
});
