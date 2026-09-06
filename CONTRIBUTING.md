# Contributing

## Setup

```sh
pnpm install
pnpm test         # vitest, colocated *.spec.ts
pnpm lint         # eslint
pnpm type:check   # tsc --noEmit
pnpm build        # tsc → dist/
```

Requires node ≥ 22.18 (or bun ≥ 1.0) and pnpm — the pinned version in
`package.json` is picked up automatically.

## Commits and history

`main` is linear and reads like a changelog; every commit on it follows
[Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add a mysql driver
fix: quote schema name in reset
docs: explain the lock contract
chore: bump typescript
```

- Open a **pull request** for anything with substance. PRs are **squash-merged**
  — the PR title becomes the commit on `main`, so write the title as the
  Conventional Commit and let the branch's own commits be as messy as work is.
- **Rebase** your branch on `main` while it lives; merge commits never land on
  `main`.
- A change in behaviour comes with a test. The suite runs against a fake driver
  by design — see `runner.spec.ts` — so it needs no database.

## What belongs here

The package's one promise is that it knows nothing about your application: no
runtime dependencies, no ORM, no framework hooks. Features that would make it
know something — a config format for a specific stack, a dependency to parse
one — belong in a consumer, or in a driver package of their own. New drivers
are welcome behind their own subpath (`migrane/drivers/<name>`) with their
client as an optional peer dependency, `drivers/pg.ts` being the shape to copy.
