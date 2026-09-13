import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { assembleContext, ownerScope } from '../../src/core/context.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import type { Context } from '../../src/core/types.ts'

const rnessDir = fileURLToPath(
  new URL('../fixtures/ws-scoped/.rness', import.meta.url)
)
const routingDir = fileURLToPath(
  new URL('../fixtures/ws-routing/.rness', import.meta.url)
)

function standards(ctx: Context) {
  const c = ctx.collections.find((x) => x.name === 'standards')
  assert.ok(c)
  return c
}

test('ownerScope is the first path segment, null at the collection root', () => {
  assert.equal(ownerScope('coding.md'), null)
  assert.equal(ownerScope('web/seo.md'), 'web')
  assert.equal(ownerScope('web/nested/deep.md'), 'web')
})

test('web scope pulls web + platform + global standards, nearest first', async () => {
  const manifest = await loadManifest(rnessDir)
  const ctx = await assembleContext({ rnessDir, manifest, scope: 'web' })
  assert.deepEqual(
    standards(ctx).files.map((f) => f.rel),
    ['web/seo.md', 'platform/deploy.md', 'global.md']
  )
  assert.deepEqual(
    standards(ctx).files.map((f) => f.scope),
    ['web', 'platform', null]
  )
})

test('global scope pulls only collection-root files', async () => {
  const manifest = await loadManifest(rnessDir)
  const ctx = await assembleContext({ rnessDir, manifest, scope: null })
  assert.deepEqual(
    standards(ctx).files.map((f) => f.rel),
    ['global.md']
  )
  const adr = ctx.collections.find((c) => c.name === 'adr')
  assert.deepEqual(
    adr?.files.map((f) => f.rel),
    ['0001-x.md']
  )
})

test('a file under a directory outside the chain is ignored, whatever its front matter says', async () => {
  // misc/routed.md carries `scopes: b`; `misc` is not a scope, so the file
  // belongs nowhere — the directory decides, front matter never re-routes.
  const manifest = await loadManifest(routingDir)
  const ctx = await assembleContext({
    rnessDir: routingDir,
    manifest,
    scope: 'a',
  })
  assert.equal(
    standards(ctx).files.some((f) => f.rel === 'misc/routed.md'),
    false
  )
  const global = await assembleContext({
    rnessDir: routingDir,
    manifest,
    scope: null,
  })
  assert.equal(
    standards(global).files.some((f) => f.rel === 'misc/routed.md'),
    false
  )
})

test('a 3-deep extends chain orders a-group, b-group, c-group, then global', async () => {
  const manifest = await loadManifest(routingDir)
  const ctx = await assembleContext({
    rnessDir: routingDir,
    manifest,
    scope: 'a',
  })
  assert.deepEqual(
    standards(ctx).files.map((f) => f.rel),
    ['a/one.md', 'b/two.md', 'c/three.md', 'root.md']
  )
  assert.deepEqual(
    standards(ctx).files.map((f) => f.scope),
    ['a', 'b', 'c', null]
  )
})
