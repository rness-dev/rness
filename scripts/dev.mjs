#!/usr/bin/env node
// Run the CLI straight from this checkout's sources:
//
//   pnpm dev validate            from anywhere in this repository
//   rness-dev validate           from anywhere at all, once linked (below)
//
// Node ≥ 24 strips the types, so there is no build step between an edit and
// the next run — `dist/` is only for what the registry serves.
//
// Delegation is off by default: inside a workspace the launcher would hand the
// command to the `@rness/cli` pinned in `.rness/`, which is the published copy,
// not the one being worked on. `RNESS_NO_DELEGATE=0 pnpm dev …` puts it back,
// to exercise delegation itself.
//
// To reach it from a test workspace, link it once:
//
//   ln -s "$PWD/scripts/dev.mjs" ~/.local/bin/rness-dev   # from this package
//
// `create` is never delegated, so it always runs these sources; it also
// refuses to run inside a workspace, so call it from an empty directory.
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'packages', 'cli', 'src', 'bin', 'rness.ts')

const { status, error } = spawnSync(
  process.execPath,
  [BIN, ...process.argv.slice(2)],
  {
    // The caller's directory is the workspace under test, never this repository.
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { RNESS_NO_DELEGATE: '1', ...process.env },
  }
)
if (error !== undefined) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
} else {
  process.exitCode = status ?? 1
}
