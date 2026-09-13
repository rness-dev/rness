import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { findDelegate } from '../../src/core/delegate.ts'

async function workspaceWithPinned(version: string | null): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rness-delegate-')))
  await mkdir(join(root, '.rness'), { recursive: true })
  await writeFile(
    join(root, '.rness', 'rness.json'),
    '{"contract":1,"repos":{},"scopes":{}}'
  )
  if (version !== null) {
    const pkg = join(root, '.rness', 'node_modules', '@rness', 'cli')
    await mkdir(join(pkg, 'dist'), { recursive: true })
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@rness/cli', version })
    )
    await writeFile(
      join(pkg, 'dist', 'index.js'),
      'export async function run() { return 0 }\n'
    )
  }
  return root
}

test('returns the pinned copy when its version differs', async (t) => {
  const root = await workspaceWithPinned('9.9.9')
  t.after(() => rm(root, { recursive: true, force: true }))
  const d = await findDelegate(join(root, 'org'), '0.2.0')
  assert.deepEqual(d, {
    entry: join(
      root,
      '.rness',
      'node_modules',
      '@rness',
      'cli',
      'dist',
      'index.js'
    ),
    version: '9.9.9',
    root,
  })
})

test('returns null when the pinned copy has the same version', async (t) => {
  const root = await workspaceWithPinned('0.2.0')
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(await findDelegate(root, '0.2.0'), null)
})

test('returns null when nothing is pinned', async (t) => {
  const root = await workspaceWithPinned(null)
  t.after(() => rm(root, { recursive: true, force: true }))
  assert.equal(await findDelegate(root, '0.2.0'), null)
})

test('returns null outside a workspace', async (t) => {
  const lonely = await realpath(await mkdtemp(join(tmpdir(), 'rness-lonely-')))
  t.after(() => rm(lonely, { recursive: true, force: true }))
  assert.equal(await findDelegate(lonely, '0.2.0'), null)
})
