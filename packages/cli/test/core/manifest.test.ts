import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { loadManifest, resolveOrg } from '../../src/core/manifest.ts'

async function fixture(json: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rness-'))
  const rnessDir = join(dir, '.rness')
  await mkdir(rnessDir)
  await writeFile(join(rnessDir, 'rness.json'), typeof json === 'string' ? json : JSON.stringify(json))
  return rnessDir
}

test('loads a valid manifest and defaults extends to []', async (t) => {
  const d = await fixture({
    contract: 1,
    repos: { web: { url: 'https://github.com/acme/web.git' } },
    scopes: { web: { path: 'org/web' }, ui: { path: 'org/p/pkg/ui', extends: ['web'] } },
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const m = await loadManifest(d)
  assert.equal(m.contract, 1)
  assert.deepEqual(m.repos.web, { url: 'https://github.com/acme/web.git' })
  assert.deepEqual(m.scopes.web?.extends, [])
  assert.deepEqual(m.scopes.ui?.extends, ['web'])
})

test('rejects wrong contract version', async (t) => {
  const d = await fixture({ contract: 2, repos: {}, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(d), /rness\.json:.*contract/)
})

test('rejects an extends target that is not a scope', async (t) => {
  const d = await fixture({ contract: 1, repos: {}, scopes: { web: { path: 'org/web', extends: ['ghost'] } } })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(d), /rness\.json:.*ghost/)
})

test('rejects an extends target that only exists on the prototype chain', async (t) => {
  const d = await fixture({ contract: 1, repos: {}, scopes: { web: { path: 'org/web', extends: ['constructor'] } } })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(d), /rness\.json:.*constructor/)
})

test('rejects a path with ..', async (t) => {
  const d = await fixture({ contract: 1, repos: {}, scopes: { web: { path: '../escape' } } })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(d), /rness\.json:/)
})

test('rejects a repo without a string url', async (t) => {
  const d = await fixture({ contract: 1, repos: { web: {} }, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(d), /rness\.json:.*"url"/)
})

test('missing file throws', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rness-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(dir), /rness\.json:/)
})

test('rejects a JSON null document with a prefixed error', async (t) => {
  const d = await fixture('null')
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(d), /rness\.json:.*JSON object/)
})

test('rejects a non-object JSON document (array) with a prefixed error', async (t) => {
  const d = await fixture('[]')
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(d), /rness\.json:.*JSON object/)
})

test('rejects genuinely malformed JSON with a prefixed error', async (t) => {
  const d = await fixture('{ not valid json')
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(d), /rness\.json:.*invalid JSON/)
})

test('org is optional, validated like a scope name', async (t) => {
  const withOrgDir = await fixture({ contract: 1, org: 'acme-dev', repos: {}, scopes: {} })
  t.after(() => rm(dirname(withOrgDir), { recursive: true, force: true }))
  const withOrg = await loadManifest(withOrgDir)
  assert.equal(withOrg.org, 'acme-dev')

  const withoutDir = await fixture({ contract: 1, repos: {}, scopes: {} })
  t.after(() => rm(dirname(withoutDir), { recursive: true, force: true }))
  const without = await loadManifest(withoutDir)
  assert.equal(without.org, null)

  const badDir = await fixture({ contract: 1, org: 'Acme Inc', repos: {}, scopes: {} })
  t.after(() => rm(dirname(badDir), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(badDir), /rness\.json:.*"org"/)
})

test('resolveOrg falls back to the root directory name with a warning', async (t) => {
  const d = await fixture({ contract: 1, repos: {}, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const manifest = await loadManifest(d)
  const { org, warning } = resolveOrg(manifest, '/tmp/workspaces/acme')
  assert.equal(org, 'acme')
  assert.match(warning ?? '', /no "org"; using the directory name "acme"/)
  const pinned = resolveOrg({ ...manifest, org: 'acme-dev' }, '/tmp/workspaces/acme')
  assert.deepEqual(pinned, { org: 'acme-dev', warning: null })
})
