// cli/test/core/context.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { loadManifest } from '../../src/core/manifest.mjs'
import { assembleContext } from '../../src/core/context.mjs'

const rnessDir = fileURLToPath(new URL('../fixtures/ws-scoped/.rness', import.meta.url))

test('web scope pulls web + platform + global standards, nearest first', async () => {
  const manifest = await loadManifest(rnessDir)
  const ctx = await assembleContext({ rnessDir, manifest, scope: 'web' })
  const standards = ctx.collections.find((c) => c.name === 'standards')
  assert.deepEqual(standards.files.map((f) => f.rel), ['web/seo.md', 'platform/deploy.md', 'global.md'])
  assert.deepEqual(standards.files.map((f) => f.scope), ['web', 'platform', null])
})

test('global scope pulls only collection-root files', async () => {
  const manifest = await loadManifest(rnessDir)
  const ctx = await assembleContext({ rnessDir, manifest, scope: null })
  const standards = ctx.collections.find((c) => c.name === 'standards')
  assert.deepEqual(standards.files.map((f) => f.rel), ['global.md'])
  const adr = ctx.collections.find((c) => c.name === 'adr')
  assert.deepEqual(adr.files.map((f) => f.rel), ['0001-x.md'])
})
