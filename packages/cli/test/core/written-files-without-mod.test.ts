import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { writtenFiles } from '../../src/core/agent-targets.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

// A file of its own: its process has never read the mod, so nothing is
// cached. `upgrade` runs from the copy the workspace pinned; with pnpm, the
// install of the new version removes that copy's folder from the store, and
// `upgrade` then lists the files to commit in the clones (`writtenFiles`).
// Seen on 0.20.0 → 0.20.1: "mod directory not found next to the @rness/cli
// package".

const MOD = fileURLToPath(new URL('../../mod', import.meta.url))

const gone = (path: fs.PathLike): void => {
  if (String(path).startsWith(MOD))
    throw Object.assign(new Error(`ENOENT: ${String(path)}`), {
      code: 'ENOENT',
    })
}

test('the files a clone gets are listed without the mod on disk: upgrade lists them once the install has removed the running copy', async (t) => {
  const root = await makeWorkspace(t, { org: 'acme', agents: ['claude'] })
  const manifest = await loadManifest(join(root, '.rness'))
  const { statSync, readFileSync } = fs
  t.mock.method(fs, 'statSync', ((path: fs.PathLike, ...rest: unknown[]) => {
    gone(path)
    return (statSync as (...a: unknown[]) => unknown)(path, ...rest)
  }) as typeof fs.statSync)
  t.mock.method(fs, 'readFileSync', ((
    path: fs.PathOrFileDescriptor,
    ...rest: unknown[]
  ) => {
    if (typeof path !== 'number') gone(path as fs.PathLike)
    return (readFileSync as (...a: unknown[]) => unknown)(path, ...rest)
  }) as typeof fs.readFileSync)
  syncBuiltinESMExports()
  t.after(() => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  })

  const files = writtenFiles(manifest)
  assert.ok(files.includes('.claude/skills/rness/hooks/register.tsx'))
  assert.ok(files.includes('.claude/skills/rness/types/index.d.ts'))
})
