import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManifest } from '../../src/core/manifest.mjs'

async function fixture(json) {
  const dir = await mkdtemp(join(tmpdir(), 'rness-'))
  const rnessDir = join(dir, '.rness')
  await mkdir(rnessDir)
  await writeFile(join(rnessDir, 'rness.json'), typeof json === 'string' ? json : JSON.stringify(json))
  return rnessDir
}

test('loads a valid manifest and defaults extends to []', async () => {
  const d = await fixture({ contract: 1, repos: {}, scopes: { web: { path: 'org/web' }, ui: { path: 'org/p/pkg/ui', extends: ['web'] } } })
  const m = await loadManifest(d)
  assert.equal(m.contract, 1)
  assert.deepEqual(m.scopes.web.extends, [])
  assert.deepEqual(m.scopes.ui.extends, ['web'])
})

test('rejects wrong contract version', async () => {
  const d = await fixture({ contract: 2, repos: {}, scopes: {} })
  await assert.rejects(() => loadManifest(d), /rness\.json:.*contract/)
})

test('rejects an extends target that is not a scope', async () => {
  const d = await fixture({ contract: 1, repos: {}, scopes: { web: { path: 'org/web', extends: ['ghost'] } } })
  await assert.rejects(() => loadManifest(d), /rness\.json:.*ghost/)
})

test('rejects an extends target that only exists on the prototype chain (I3)', async () => {
  const d = await fixture({ contract: 1, repos: {}, scopes: { web: { path: 'org/web', extends: ['constructor'] } } })
  await assert.rejects(() => loadManifest(d), /rness\.json:.*constructor/)
})

test('rejects a path with ..', async () => {
  const d = await fixture({ contract: 1, repos: {}, scopes: { web: { path: '../escape' } } })
  await assert.rejects(() => loadManifest(d), /rness\.json:/)
})

test('missing file throws', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rness-'))
  await assert.rejects(() => loadManifest(dir), /rness\.json:/)
})

test('rejects a JSON null document with a prefixed error', async () => {
  const d = await fixture('null')
  await assert.rejects(() => loadManifest(d), /rness\.json:.*JSON object/)
})

test('rejects a non-object JSON document (array) with a prefixed error', async () => {
  const d = await fixture('[]')
  await assert.rejects(() => loadManifest(d), /rness\.json:.*JSON object/)
})

test('rejects genuinely malformed JSON with a prefixed error', async () => {
  const d = await fixture('{ not valid json')
  await assert.rejects(() => loadManifest(d), /rness\.json:.*invalid JSON/)
})
