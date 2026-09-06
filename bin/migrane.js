#!/usr/bin/env sh
':' //; f=; case "$1" in --runtime=*) f=${1#--runtime=}; shift;; esac; for r in ${f:-${MIGRANE_RUNTIME:-node bun}}; do command -v "$r" >/dev/null 2>&1 && exec "$r" "$0" "$@"; done; echo 'migrane: needs node or bun on PATH' >&2; exit 1

import { run } from '../dist/cli.js';

/**
 * The `migrane` executable. Argument handling lives in `src/cli.ts`; this file
 * turns its answer into an exit code.
 *
 * Plain JavaScript rather than part of the build, because `cli.ts` is also a
 * library export: an entrypoint runs on import, and what `index.ts` re-exports
 * must never do that.
 *
 * ## Line 2 is sh and JavaScript at once
 *
 * `#!/usr/bin/env node` makes this package unusable on a bun-only machine — the
 * kernel reads the shebang, so nothing of ours runs and no error of ours can
 * explain why. Naming `sh` instead lets the line below pick a runtime and
 * `exec` it on this same file.
 *
 * sh reads `:` called with the argument `//`, then a loop. JavaScript reads the
 * string `':'` and a `//` comment swallowing the rest — which is why the whole
 * dispatch has to stay on one line. Both runtimes strip a `#!` first line, so
 * what arrives is a valid module.
 *
 * **`.prettierignore` names this file, and that is load-bearing.** Prettier
 * reformats the line to `':'; //;`, which is still valid JavaScript and no
 * longer valid sh: `:` loses its argument, the shell tries to run `//`, and
 * every command prints `//: is a directory` before working.
 *
 * ## Which runtime, and why node first
 *
 * `migrane --runtime=bun up` names it per command, `MIGRANE_RUNTIME=bun` for
 * the shell, and the flag wins. It must come first and use the `=` form: this
 * line reads exactly one argument, because scanning the whole list would take
 * more shell than fits in a JavaScript comment. It never reaches `run()`, which
 * is why the usage `cli.ts` prints does not list it.
 *
 * Node is tried first as a compatibility promise, not a preference — a machine
 * holding both behaved as node before this line existed. The two differ in one
 * way that matters: bun loads `.env` from the *working directory*, while
 * everything else here resolves against the config file, so `cd apps/api &&
 * migrane up` can pick up a different `.env` than the repository root. A
 * variable already set in the environment still wins, so CI and containers are
 * unaffected. See the README for the full trade and `bun --no-env-file`.
 *
 * ## The cost is Windows
 *
 * npm writes the `.cmd` shim from this shebang, so it emits one calling `sh`:
 * present under Git Bash, absent otherwise. `#!/bin/sh` would emit a literal
 * path cmd.exe can never resolve, so the `env` form degrades rather than dies.
 */

process.exit(await run(process.argv.slice(2)));
