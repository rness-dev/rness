import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findWorkspace } from '../../src/core/workspace.ts'

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rness-')))
  await mkdir(join(root, '.rness'))
  await writeFile(join(root, '.rness', 'rness.json'), '{"contract":1,"repos":{},"scopes":{}}')
  return root
}

test('finds the workspace root from a nested cwd', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const nested = join(root, 'org', 'web', 'src')
  await mkdir(nested, { recursive: true })
  const ws = await findWorkspace(nested)
  assert.equal(ws.root, root)
  assert.equal(ws.rnessDir, join(root, '.rness'))
})

test('throws when no workspace above', async (t) => {
  const lonely = await realpath(await mkdtemp(join(tmpdir(), 'rness-')))
  t.after(() => rm(lonely, { recursive: true, force: true }))
  await assert.rejects(() => findWorkspace(lonely), /no rness workspace/)
})

test('resolves a relative startDir instead of looping', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const nested = join(root, 'a', 'b')
  await mkdir(nested, { recursive: true })
  const cwd = process.cwd()
  process.chdir(nested)
  try {
    const ws = await findWorkspace('.')
    assert.equal(ws.root, root)
  } finally {
    process.chdir(cwd)
  }
})

test('inside the context repository itself: that directory is .rness, its parent the root', async (t) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'rness-ctx-')))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const checkout = join(parent, 'context-checkout')
  await mkdir(join(checkout, 'standards'), { recursive: true })
  await writeFile(join(checkout, 'rness.json'), '{"contract":1,"repos":{},"scopes":{}}')
  const ws = await findWorkspace(join(checkout, 'standards'))
  assert.deepEqual(ws, { root: parent, rnessDir: checkout })
})

test('a directory holding both .rness/rness.json and a bare rness.json is a workspace root', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'rness.json'), '{"contract":1,"repos":{},"scopes":{}}')
  assert.deepEqual(await findWorkspace(join(root, 'org', 'web')), { root, rnessDir: join(root, '.rness') })
})

test('a bare rness.json below a real workspace never shadows it (e.g. the shipped scaffold/)', async (t) => {
  const root = await workspace()
  t.after(() => rm(root, { recursive: true, force: true }))
  const shallow = join(root, 'org', 'tool', 'scaffold')
  await mkdir(join(shallow, 'sub'), { recursive: true })
  await writeFile(join(shallow, 'rness.json'), '{"contract":1,"repos":{},"scopes":{}}')
  assert.deepEqual(await findWorkspace(join(shallow, 'sub')), { root, rnessDir: join(root, '.rness') })
})
