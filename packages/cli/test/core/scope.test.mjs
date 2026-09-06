// cli/test/core/scope.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveScope, scopeChain } from '../../src/core/scope.mjs'

const manifest = {
  contract: 1,
  repos: {},
  scopes: {
    web: { path: 'org/platform/apps/web', extends: ['platform'] },
    platform: { path: 'org/platform', extends: [] },
    ui: { path: 'org/platform/packages/ui', extends: ['platform'] },
    sdk: { path: 'org/sdk', extends: [] },
  },
}

test('longest-prefix match wins', () => {
  assert.equal(resolveScope(manifest, 'org/platform/apps/web/src'), 'web')
  assert.equal(resolveScope(manifest, 'org/platform/lib'), 'platform')
  assert.equal(resolveScope(manifest, 'org/sdk'), 'sdk')
})

test('no match is global', () => {
  assert.equal(resolveScope(manifest, ''), null)
  assert.equal(resolveScope(manifest, 'tooling'), null)
})

test('segment boundary respected', () => {
  assert.equal(resolveScope(manifest, 'org/platform-www'), null)
})

test('scopeChain is nearest-first and deduped', () => {
  assert.deepEqual(scopeChain(manifest, 'web'), ['web', 'platform'])
  assert.deepEqual(scopeChain(manifest, null), [])
})

test('scopeChain detects a cycle', () => {
  const cyclic = { ...manifest, scopes: { a: { path: 'a', extends: ['b'] }, b: { path: 'b', extends: ['a'] } } }
  assert.throws(() => scopeChain(cyclic, 'a'), /cycle/)
})
