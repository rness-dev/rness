import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { loadManifest } from '../../src/core/manifest.ts'
import { assembleContext } from '../../src/core/context.ts'
import type { Context } from '../../src/core/types.ts'

const rnessDir = fileURLToPath(new URL('../fixtures/ws-scoped/.rness', import.meta.url))
const routingDir = fileURLToPath(new URL('../fixtures/ws-routing/.rness', import.meta.url))

function standards(ctx: Context) {
  const c = ctx.collections.find((x) => x.name === 'standards')
  assert.ok(c)
  return c
}

test('web scope pulls web + platform + global standards, nearest first', async () => {
  const manifest = await loadManifest(rnessDir)
  const ctx = await assembleContext({ rnessDir, manifest, scope: 'web' })
  assert.deepEqual(standards(ctx).files.map((f) => f.rel), ['web/seo.md', 'platform/deploy.md', 'global.md'])
  assert.deepEqual(standards(ctx).files.map((f) => f.scope), ['web', 'platform', null])
})

test('global scope pulls only collection-root files', async () => {
  const manifest = await loadManifest(rnessDir)
  const ctx = await assembleContext({ rnessDir, manifest, scope: null })
  assert.deepEqual(standards(ctx).files.map((f) => f.rel), ['global.md'])
  const adr = ctx.collections.find((c) => c.name === 'adr')
  assert.deepEqual(adr?.files.map((f) => f.rel), ['0001-x.md'])
})

test('front-matter scopes routes a file from another dir into that scope group', async () => {
  const manifest = await loadManifest(routingDir)
  const ctx = await assembleContext({ rnessDir: routingDir, manifest, scope: 'a' })
  const routed = standards(ctx).files.find((f) => f.rel === 'misc/routed.md')
  assert.ok(routed, 'misc/routed.md is included')
  assert.equal(routed.scope, 'b')
})

test('a file tagged scope: global inside a scope dir is excluded', async () => {
  const manifest = await loadManifest(routingDir)
  const ctx = await assembleContext({ rnessDir: routingDir, manifest, scope: 'a' })
  assert.equal(standards(ctx).files.some((f) => f.rel === 'a/tagged-global.md'), false)
})

test('a 3-deep extends chain orders a-group, b-group, c-group, then global', async () => {
  const manifest = await loadManifest(routingDir)
  const ctx = await assembleContext({ rnessDir: routingDir, manifest, scope: 'a' })
  assert.deepEqual(
    standards(ctx).files.map((f) => f.rel),
    ['a/one.md', 'b/two.md', 'misc/routed.md', 'c/three.md', 'misc/listed.md', 'root.md'],
  )
  assert.deepEqual(standards(ctx).files.map((f) => f.scope), ['a', 'b', 'b', 'c', 'c', null])
})

test('front-matter scopes as a YAML list routes into the first listed scope of the chain', async () => {
  const manifest = await loadManifest(routingDir)
  const ctx = await assembleContext({ rnessDir: routingDir, manifest, scope: 'a' })
  const listed = standards(ctx).files.find((f) => f.rel === 'misc/listed.md')
  assert.ok(listed, 'misc/listed.md is included')
  assert.equal(listed.scope, 'c')
})
