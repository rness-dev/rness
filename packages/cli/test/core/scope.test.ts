import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveScope, scopeChain } from '../../src/core/scope.ts'
import type { Manifest } from '../../src/core/types.ts'

const repository = (name: string) => ({
  path: `org/${name}`,
  url: `https://github.com/acme/${name}.git`,
  parent: null,
  extends: [],
})

const manifest: Manifest = {
  contract: 2,
  provider: null,
  org: null,
  agents: null,
  boards: null,
  scopes: {
    platform: repository('platform'),
    web: {
      path: 'org/platform/apps/web',
      url: null,
      parent: 'platform',
      extends: ['platform'],
    },
    ui: {
      path: 'org/platform/packages/ui',
      url: null,
      parent: 'platform',
      extends: ['platform'],
    },
    sdk: repository('sdk'),
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

test('scopeChain of a nested scope: its parents nearest first, then what it extends', () => {
  const nested: Manifest = {
    ...manifest,
    scopes: {
      ...manifest.scopes,
      icons: {
        path: 'org/platform/packages/ui/icons',
        url: null,
        parent: 'ui',
        extends: ['ui', 'web'],
      },
    },
  }
  assert.deepEqual(scopeChain(nested, 'icons'), [
    'icons',
    'ui',
    'platform',
    'web',
  ])
  assert.equal(
    resolveScope(nested, 'org/platform/packages/ui/icons/svg'),
    'icons'
  )
})

test('scopeChain detects a cycle', () => {
  const cyclic: Manifest = {
    ...manifest,
    scopes: {
      a: { ...repository('a'), extends: ['b'] },
      b: { ...repository('b'), extends: ['a'] },
    },
  }
  assert.throws(() => scopeChain(cyclic, 'a'), /cycle/)
})
