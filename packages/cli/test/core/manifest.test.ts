import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  loadManifest,
  parseRepoSpec,
  resolveOrg,
  writeManifest,
} from '../../src/core/manifest.ts'

async function fixture(json: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rness-'))
  const rnessDir = join(dir, '.rness')
  await mkdir(rnessDir)
  await writeFile(
    join(rnessDir, 'rness.json'),
    typeof json === 'string' ? json : JSON.stringify(json)
  )
  return rnessDir
}

test('loads a valid manifest and defaults extends to []', async (t) => {
  const d = await fixture({
    contract: 1,
    repos: { web: { url: 'https://github.com/acme/web.git' } },
    scopes: {
      web: { path: 'org/web' },
      ui: { path: 'org/p/pkg/ui', extends: ['web'] },
    },
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
  const d = await fixture({
    contract: 1,
    repos: {},
    scopes: { web: { path: 'org/web', extends: ['ghost'] } },
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(d), /rness\.json:.*ghost/)
})

test('rejects an extends target that only exists on the prototype chain', async (t) => {
  const d = await fixture({
    contract: 1,
    repos: {},
    scopes: { web: { path: 'org/web', extends: ['constructor'] } },
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(d), /rness\.json:.*constructor/)
})

test('rejects a path with ..', async (t) => {
  const d = await fixture({
    contract: 1,
    repos: {},
    scopes: { web: { path: '../escape' } },
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(d), /rness\.json:/)
})

test('rejects a path with an empty segment', async (t) => {
  const d = await fixture({
    contract: 1,
    repos: {},
    scopes: { web: { path: 'org/web/' } },
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(d), /rness\.json:.*empty segments/)
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

test('rejects an unknown top-level key', async (t) => {
  const d = await fixture({
    contract: 1,
    repos: {},
    scopes: {},
    scope: { web: { path: 'org/web' } },
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(
    () => loadManifest(d),
    /rness\.json: unknown key "scope"/
  )
})

test('org is optional, validated as a GitHub organization name', async (t) => {
  const withOrgDir = await fixture({
    contract: 1,
    org: 'acme-dev',
    repos: {},
    scopes: {},
  })
  t.after(() => rm(dirname(withOrgDir), { recursive: true, force: true }))
  const withOrg = await loadManifest(withOrgDir)
  assert.equal(withOrg.org, 'acme-dev')

  const withoutDir = await fixture({ contract: 1, repos: {}, scopes: {} })
  t.after(() => rm(dirname(withoutDir), { recursive: true, force: true }))
  const without = await loadManifest(withoutDir)
  assert.equal(without.org, null)

  const badDir = await fixture({
    contract: 1,
    org: 'Acme Inc',
    repos: {},
    scopes: {},
  })
  t.after(() => rm(dirname(badDir), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(badDir), /rness\.json:.*"org"/)
})

test('org follows GitHub: case kept, single inner hyphens, at most 39 characters', async (t) => {
  const org = async (value: string) => {
    const d = await fixture({ contract: 1, org: value, repos: {}, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    return loadManifest(d)
  }
  assert.equal((await org('Acme-Corp')).org, 'Acme-Corp')
  assert.equal((await org('a'.repeat(39))).org, 'a'.repeat(39))
  for (const bad of ['-acme', 'acme-', 'ac--me', 'a'.repeat(40)]) {
    await assert.rejects(
      () => org(bad),
      /^Error: rness\.json: "org" must be a GitHub organization name \(got "/,
      bad
    )
  }
})

test('resolveOrg falls back to the root directory name with a warning', async (t) => {
  const d = await fixture({ contract: 1, repos: {}, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const manifest = await loadManifest(d)
  const { org, warning } = resolveOrg(manifest, '/tmp/workspaces/acme')
  assert.equal(org, 'acme')
  assert.match(warning ?? '', /no "org"; using the directory name "acme"/)
  const pinned = resolveOrg(
    { ...manifest, org: 'acme-dev' },
    '/tmp/workspaces/acme'
  )
  assert.deepEqual(pinned, { org: 'acme-dev', warning: null })
})

test('writeManifest keeps the key order and omits empty extends and a null org', async (t) => {
  const d = await fixture({ contract: 1, repos: {}, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await writeManifest(d, {
    contract: 1,
    org: null,
    repos: { web: { url: 'https://github.com/acme/web.git' } },
    scopes: {
      web: { path: 'org/web', extends: [] },
      ui: { path: 'org/web/packages/ui', extends: ['web'] },
    },
  })
  const text = await readFile(join(d, 'rness.json'), 'utf8')
  assert.equal(
    text,
    `{
  "contract": 1,
  "repos": {
    "web": { "url": "https://github.com/acme/web.git" }
  },
  "scopes": {
    "web": { "path": "org/web" },
    "ui": { "path": "org/web/packages/ui", "extends": ["web"] }
  }
}
`
  )
  await writeManifest(d, { contract: 1, org: 'acme', repos: {}, scopes: {} })
  assert.match(
    await readFile(join(d, 'rness.json'), 'utf8'),
    /^\{\n {2}"contract": 1,\n {2}"org": "acme",\n/
  )
  assert.deepEqual(await loadManifest(d), {
    contract: 1,
    org: 'acme',
    repos: {},
    scopes: {},
  })
})

test('parseRepoSpec accepts repo, owner/repo and full URLs, and validates the name', () => {
  const host = 'https://github.com/'
  assert.deepEqual(parseRepoSpec('web', 'acme', host), {
    name: 'web',
    url: 'https://github.com/acme/web.git',
  })
  assert.deepEqual(parseRepoSpec('other/api', 'acme', host), {
    name: 'api',
    url: 'https://github.com/other/api.git',
  })
  assert.deepEqual(parseRepoSpec('git@github.com:acme/sdk.git', 'acme', host), {
    name: 'sdk',
    url: 'git@github.com:acme/sdk.git',
  })
  assert.deepEqual(
    parseRepoSpec('file:///tmp/gh/acme/tools.git', 'acme', host),
    { name: 'tools', url: 'file:///tmp/gh/acme/tools.git' }
  )
  assert.deepEqual(parseRepoSpec('https://github.com/acme/web', 'acme', host), {
    name: 'web',
    url: 'https://github.com/acme/web',
  })
  assert.throws(
    () => parseRepoSpec('Bad_Name', 'acme', host),
    /repository name "Bad_Name" may only contain lowercase letters, digits, '\.', '_' and '-'/
  )
  // What GitHub allows in a repository name is a name: dots and underscores.
  for (const name of ['my_lib', 'angular.js', 'v2.api-client', '.github', '_x'])
    assert.equal(parseRepoSpec(name, 'acme', host).name, name)
  // A directory under org/ and a git argument: never `.`, `..` or an option.
  for (const name of ['.', '..', '-rf', 'a b', 'Caps'])
    assert.throws(() => parseRepoSpec(name, 'acme', host), /repository name/)
  assert.throws(() => parseRepoSpec('a/b/c', 'acme', host), /repository name/)
})
