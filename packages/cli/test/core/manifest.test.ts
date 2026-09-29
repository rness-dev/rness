import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  EXCLUDED_NAMES,
  isMemberRepo,
  isWorkspaceClone,
  loadManifest,
  parseRepoSpec,
  providerOf,
  workspaceName,
  writeManifest,
} from '../../src/core/manifest.ts'
import type { Manifest } from '../../src/core/types.ts'

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

test('workspaceName: the org, else the root directory name, without a warning', async (t) => {
  const d = await fixture({ contract: 1, repos: {}, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const manifest = await loadManifest(d)
  // A workspace without "org" is a blank one (spec 0012): a normal state.
  assert.equal(workspaceName(manifest, '/tmp/workspaces/acme'), 'acme')
  assert.equal(
    workspaceName({ ...manifest, org: 'acme-dev' }, '/tmp/workspaces/acme'),
    'acme-dev'
  )
})

test('writeManifest keeps the key order and omits empty extends and a null org', async (t) => {
  const d = await fixture({ contract: 1, repos: {}, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await writeManifest(d, {
    contract: 1,
    provider: null,
    org: null,
    agents: null,
    pulse: null,
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
  await writeManifest(d, {
    contract: 1,
    provider: null,
    org: 'acme',
    agents: null,
    pulse: null,
    repos: {},
    scopes: {},
  })
  assert.match(
    await readFile(join(d, 'rness.json'), 'utf8'),
    /^\{\n {2}"contract": 1,\n {2}"org": "acme",\n/
  )
  assert.deepEqual(await loadManifest(d), {
    contract: 1,
    provider: null,
    org: 'acme',
    agents: null,
    pulse: null,
    repos: {},
    scopes: {},
  })
})

// --- agents (spec 0011 §3.1) ----------------------------------------------------

test('agents: absent is null ("never asked"), a list is kept, [] included', async (t) => {
  for (const [agents, expected] of [
    [undefined, null],
    [[], []],
    [['claude'], ['claude']],
    [
      ['claude', 'codex'],
      ['claude', 'codex'],
    ],
  ] as const) {
    const d = await fixture({ contract: 1, agents, repos: {}, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    assert.deepEqual((await loadManifest(d)).agents, expected)
  }
})

test('agents: a list of unique lowercase names, or an error', async (t) => {
  for (const agents of [
    'claude',
    [1],
    ['Claude'],
    [''],
    ['claude', 'claude'],
  ]) {
    const d = await fixture({ contract: 1, agents, repos: {}, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    await assert.rejects(
      () => loadManifest(d),
      /^Error: rness\.json: "agents" must be a list of unique agent names/,
      JSON.stringify(agents)
    )
  }
})

test('writeManifest puts agents after org, and writes [] too', async (t) => {
  const d = await fixture({ contract: 1, repos: {}, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await writeManifest(d, {
    contract: 1,
    provider: null,
    org: 'acme',
    agents: ['claude'],
    pulse: null,
    repos: {},
    scopes: {},
  })
  assert.match(
    await readFile(join(d, 'rness.json'), 'utf8'),
    /^\{\n {2}"contract": 1,\n {2}"org": "acme",\n {2}"agents": \["claude"\],\n {2}"repos"/
  )
  await writeManifest(d, {
    contract: 1,
    provider: null,
    org: null,
    agents: [],
    pulse: null,
    repos: {},
    scopes: {},
  })
  assert.match(
    await readFile(join(d, 'rness.json'), 'utf8'),
    /^\{\n {2}"contract": 1,\n {2}"agents": \[\],\n/
  )
  assert.deepEqual((await loadManifest(d)).agents, [])
})

// --- provider and pulse (spec 0017 §2.1) ---------------------------------------

test('provider: one of the three names, absent is null, anything else is an error', async (t) => {
  for (const [provider, expected] of [
    [undefined, null],
    ['github', 'github'],
    ['gitlab', 'gitlab'],
    ['atlassian', 'atlassian'],
  ] as const) {
    const d = await fixture({ contract: 1, provider, repos: {}, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    assert.equal((await loadManifest(d)).provider, expected)
  }
  for (const provider of ['svn', 'GitHub', 1, null]) {
    const d = await fixture({ contract: 1, provider, repos: {}, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    await assert.rejects(
      () => loadManifest(d),
      new Error(
        `rness.json: "provider" must be one of github, gitlab, atlassian (got ${JSON.stringify(provider)})`
      )
    )
  }
})

test('pulse: { "project": <positive integer> }, absent is null, anything else is an error', async (t) => {
  for (const [pulse, expected] of [
    [undefined, null],
    [{ project: 3 }, { project: 3 }],
  ] as const) {
    const d = await fixture({ contract: 1, pulse, repos: {}, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    assert.deepEqual((await loadManifest(d)).pulse, expected)
  }
  for (const pulse of [
    3,
    null,
    {},
    { project: 0 },
    { project: -1 },
    { project: 1.5 },
    { project: '3' },
    { project: 3, extra: true },
  ]) {
    const d = await fixture({ contract: 1, pulse, repos: {}, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    await assert.rejects(
      () => loadManifest(d),
      new Error(
        `rness.json: "pulse" must be { "project": <number> } (got ${JSON.stringify(pulse)})`
      )
    )
  }
})

test('writeManifest writes provider after contract and pulse after agents', async (t) => {
  const d = await fixture({ contract: 1, repos: {}, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const manifest: Manifest = {
    contract: 1,
    provider: 'github',
    org: 'acme',
    agents: ['claude'],
    pulse: { project: 3 },
    repos: {},
    scopes: {},
  }
  await writeManifest(d, manifest)
  assert.equal(
    await readFile(join(d, 'rness.json'), 'utf8'),
    `{
  "contract": 1,
  "provider": "github",
  "org": "acme",
  "agents": ["claude"],
  "pulse": { "project": 3 },
  "repos": {
  },
  "scopes": {
  }
}
`
  )
  assert.deepEqual(await loadManifest(d), manifest)
  await writeManifest(d, { ...manifest, provider: null, pulse: null })
  assert.equal(
    (await readFile(join(d, 'rness.json'), 'utf8')).includes('provider'),
    false
  )
  assert.equal(
    (await readFile(join(d, 'rness.json'), 'utf8')).includes('pulse'),
    false
  )
})

test('providerOf: the key wins, else the first repository host, else github', () => {
  const base: Manifest = {
    contract: 1,
    provider: null,
    org: null,
    agents: null,
    pulse: null,
    repos: {},
    scopes: {},
  }
  const web = (url: string) => ({ web: { url } })
  assert.equal(providerOf(base), 'github')
  assert.equal(
    providerOf({
      ...base,
      provider: 'atlassian',
      repos: web('https://gitlab.com/acme/web.git'),
    }),
    'atlassian'
  )
  assert.equal(
    providerOf({ ...base, repos: web('https://gitlab.com/acme/web.git') }),
    'gitlab'
  )
  assert.equal(
    providerOf({ ...base, repos: web('git@github.com:acme/web.git') }),
    'github'
  )
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

test('parseRepoSpec without an organization: owner/repo and URLs only', () => {
  const host = 'https://github.com/'
  assert.throws(
    () => parseRepoSpec('web', null, host),
    /^Error: this workspace has no GitHub organization: give <owner>\/<repo> or a git URL$/
  )
  assert.deepEqual(parseRepoSpec('other/api', null, host), {
    name: 'api',
    url: 'https://github.com/other/api.git',
  })
  assert.deepEqual(parseRepoSpec('git@github.com:acme/sdk.git', null, host), {
    name: 'sdk',
    url: 'git@github.com:acme/sdk.git',
  })
})

test('isMemberRepo: everything active but the context repository', () => {
  // A leading dot is an ordinary first character: .github carries an
  // organization's profile, its templates and its shared workflows.
  assert.equal(isMemberRepo({ name: '.github', archived: false }), true)
  assert.equal(isMemberRepo({ name: 'web', archived: false }), true)
  // The catalogue lives there and it is already cloned as <root>/.rness.
  assert.equal(isMemberRepo({ name: '.rness', archived: false }), false)
  assert.equal(isMemberRepo({ name: '.RNESS', archived: false }), false)
  // Archived is read-only on GitHub: a block could never be pushed back.
  assert.equal(isMemberRepo({ name: 'old', archived: true }), false)
})

test('isWorkspaceClone: a name the catalogue could hold, and not an excluded one', () => {
  assert.equal(isWorkspaceClone('.github'), true)
  assert.equal(isWorkspaceClone('web'), true)
  assert.equal(isWorkspaceClone('my_lib'), true)
  // Excluded outright, however valid the name looks.
  assert.equal(isWorkspaceClone('.rness'), false)
  assert.equal(isWorkspaceClone('.git'), false)
  assert.equal(isWorkspaceClone('node_modules'), false)
  // `rness add` could never declare these, so they are not reported as
  // undeclared clones: the command suggested would refuse them.
  assert.equal(isWorkspaceClone('WebSite'), false)
  assert.equal(isWorkspaceClone('-dash'), false)
  assert.equal(isWorkspaceClone('..'), false)
})

test('the exclusion list is one place, shared by both rules', () => {
  for (const name of EXCLUDED_NAMES) {
    assert.equal(isWorkspaceClone(name), false, name)
    assert.equal(isMemberRepo({ name, archived: false }), false, name)
  }
})
