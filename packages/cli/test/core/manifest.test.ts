import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import {
  EXCLUDED_NAMES,
  NAME_RULE,
  contextRepo,
  isMemberRepo,
  isWorkspaceClone,
  loadManifest,
  parseRepoSpec,
  projectNumber,
  providerOf,
  redundantExtends,
  repositories,
  workspaceName,
  writeManifest,
} from '../../src/core/manifest.ts'
import { resolveScope, scopeChain } from '../../src/core/scope.ts'
import type { Manifest, ScopeEntry } from '../../src/core/types.ts'

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

/** Spec 0038 §1: two repositories, one with two parts, `ui` sharing `web`. */
const EXAMPLE = `{
  "contract": 2,
  "provider": "github",
  "org": "acme",
  "agents": ["claude"],
  "boards": { "pulse": 3 },
  "scopes": {
    "app": { "url": "git@github.com:acme/app.git" },
    "platform": {
      "url": "https://github.com/acme/platform.git",
      "scopes": {
        "web": { "path": "apps/web" },
        "ui": { "path": "packages/ui", "extends": ["web"] }
      }
    }
  }
}
`

test('contract 2: a repository by its url at org/<name>, a part nested by its path; parents first in extends', async (t) => {
  const d = await fixture(EXAMPLE)
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const m = await loadManifest(d)
  assert.equal(m.contract, 2)
  assert.deepEqual(Object.keys(m.scopes), ['app', 'platform', 'web', 'ui'])
  assert.deepEqual(m.scopes, {
    app: {
      path: 'org/app',
      url: 'git@github.com:acme/app.git',
      parent: null,
      extends: [],
    },
    platform: {
      path: 'org/platform',
      url: 'https://github.com/acme/platform.git',
      parent: null,
      extends: [],
    },
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
      extends: ['platform', 'web'],
    },
  })
  assert.deepEqual(scopeChain(m, 'ui'), ['ui', 'platform', 'web'])
  assert.equal(resolveScope(m, 'org/platform/apps/web/src'), 'web')
  assert.deepEqual(repositories(m), [
    { name: 'app', url: 'git@github.com:acme/app.git', dir: 'org/app' },
    {
      name: 'platform',
      url: 'https://github.com/acme/platform.git',
      dir: 'org/platform',
    },
  ])
})

test('contract 2: nesting is recursive, each part under its parent', async (t) => {
  const d = await fixture({
    contract: 2,
    scopes: {
      platform: {
        url: 'https://github.com/acme/platform.git',
        scopes: {
          web: { path: 'apps/web', scopes: { icons: { path: 'src/icons' } } },
        },
      },
    },
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const m = await loadManifest(d)
  assert.deepEqual(m.scopes['icons'], {
    path: 'org/platform/apps/web/src/icons',
    url: null,
    parent: 'web',
    extends: ['web'],
  })
  assert.deepEqual(scopeChain(m, 'icons'), ['icons', 'web', 'platform'])
  assert.deepEqual(
    repositories(m).map((r) => r.name),
    ['platform']
  )
})

test('contract 2: what a scope cannot be is refused, each with its line', async (t) => {
  const url = 'https://github.com/acme/platform.git'
  for (const [scopes, message] of [
    [
      { app: { url: 'git@github.com:acme/app.git', path: 'org/app' } },
      'scope "app": a repository has no path; it is org/app',
    ],
    [{ app: {} }, 'scope "app" needs a string "url"'],
    [
      { app: { path: 'org/app' } },
      'scope "app": a repository has no path; it is org/app',
    ],
    [
      { platform: { url, scopes: { web: { path: 'apps/web', url } } } },
      'scope "web": a part has no url; its repository is platform',
    ],
    [
      {
        platform: {
          url,
          scopes: { web: { path: 'apps/web', scopes: { icons: { url } } } },
        },
      },
      'scope "icons": a part has no url; its repository is platform',
    ],
    [
      { platform: { url, scopes: { web: {} } } },
      'scope "web" needs a string "path"',
    ],
    [
      { platform: { url, scopes: { web: { path: '/apps/web' } } } },
      'scope "web" path must be relative',
    ],
    [
      { platform: { url, scopes: { web: { path: '../escape' } } } },
      'scope "web" path must not contain ".."',
    ],
    [
      { platform: { url, scopes: { web: { path: 'apps/web/' } } } },
      'scope "web" path must not contain empty segments',
    ],
    [
      { platform: { url, scopes: { web: { path: 'apps/./web' } } } },
      'scope "web" path must not contain "."',
    ],
    [
      { platform: { url, scope: { web: { path: 'apps/web' } } } },
      'scope "platform": unknown key "scope"',
    ],
    [
      { platform: { url, scopes: { web: { path: 'apps/web', url: 1 } } } },
      'scope "web": a part has no url; its repository is platform',
    ],
    [
      { platform: { url, scopes: { web: { path: 'apps/web', ext: [] } } } },
      'scope "web": unknown key "ext"',
    ],
    [
      {
        platform: { url, scopes: { web: { path: 'apps/web' } } },
        app: { url, scopes: { web: { path: 'web' } } },
      },
      'scope "web" is declared twice: under platform and under app',
    ],
    [
      {
        web: { url },
        platform: { url, scopes: { web: { path: 'apps/web' } } },
      },
      'scope "web" is declared twice: as a repository and under platform',
    ],
    [
      { platform: { url, scopes: { Web: { path: 'apps/web' } } } },
      `scope name "Web" may only contain ${NAME_RULE}`,
    ],
    [
      { platform: { url, scopes: { web: 'apps/web' } } },
      'scope "web" must be an object',
    ],
    [
      { platform: { url, scopes: [] } },
      'scope "platform": "scopes" must be an object',
    ],
    [
      { platform: { url, extends: 'web' } },
      'scope "platform" extends must be an array of scope names',
    ],
    [
      {
        platform: {
          url,
          scopes: { web: { path: 'apps/web', extends: ['ghost'] } },
        },
      },
      'scope "web" extends unknown scope "ghost"',
    ],
    [
      { web: { url, extends: ['constructor'] } },
      'scope "web" extends unknown scope "constructor"',
    ],
  ] as const) {
    const d = await fixture({ contract: 2, scopes })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    await assert.rejects(
      () => loadManifest(d),
      new Error(`rness.json: ${message}`),
      message
    )
  }
  // As JSON.parse reads it: an own key, which an object literal cannot
  // write; assigned to a scope map, it would be the map's prototype.
  for (const json of [
    '{ "contract": 2, "scopes": { "__proto__": { "url": "x" } } }',
    '{ "contract": 2, "scopes": { "web": { "url": "x", "scopes": { "__proto__": { "path": "p" } } } } }',
  ]) {
    const proto = await fixture(json)
    t.after(() => rm(dirname(proto), { recursive: true, force: true }))
    await assert.rejects(
      () => loadManifest(proto),
      new Error(
        `rness.json: scope name "__proto__" may only contain ${NAME_RULE}`
      ),
      json
    )
  }
})

test('a scope named prototype or constructor is a name like any other: read, written back, read again identical', async (t) => {
  const text = `{
  "contract": 2,
  "scopes": {
    "prototype": {
      "url": "https://github.com/acme/prototype.git",
      "scopes": {
        "constructor": { "path": "apps/constructor" }
      }
    },
    "web": { "url": "https://github.com/acme/web.git", "extends": ["constructor"] }
  }
}
`
  const d = await fixture(text)
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const read = await loadManifest(d)
  assert.deepEqual(Object.keys(read.scopes), [
    'prototype',
    'constructor',
    'web',
  ])
  assert.deepEqual(read.scopes['constructor'], {
    path: 'org/prototype/apps/constructor',
    url: null,
    parent: 'prototype',
    extends: ['prototype'],
  })
  assert.deepEqual(
    repositories(read).map((r) => r.name),
    ['prototype', 'web']
  )
  assert.deepEqual(scopeChain(read, 'web'), ['web', 'constructor', 'prototype'])
  assert.equal(
    resolveScope(read, 'org/prototype/apps/constructor/src'),
    'constructor'
  )
  await writeManifest(d, read)
  assert.equal(await readFile(join(d, 'rness.json'), 'utf8'), text)
  assert.deepEqual(await loadManifest(d), read)
})

test('contract 2: an ancestor named in extends is read, left out of extends for validate to report; never written back', async (t) => {
  const text = JSON.stringify({
    contract: 2,
    scopes: {
      app: { url: 'git@github.com:acme/app.git' },
      platform: {
        url: 'https://github.com/acme/platform.git',
        scopes: {
          web: {
            path: 'apps/web',
            extends: ['platform', 'app'],
            scopes: { icons: { path: 'icons', extends: ['platform', 'web'] } },
          },
        },
      },
    },
  })
  const d = await fixture(text)
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const m = await loadManifest(d)
  assert.deepEqual(m.scopes['web'], {
    path: 'org/platform/apps/web',
    url: null,
    parent: 'platform',
    extends: ['platform', 'app'],
    redundant: ['platform'],
  })
  assert.deepEqual(m.scopes['icons'], {
    path: 'org/platform/apps/web/icons',
    url: null,
    parent: 'web',
    extends: ['web'],
    redundant: ['platform', 'web'],
  })
  assert.equal(Object.hasOwn(m.scopes['platform'] ?? {}, 'redundant'), false)
  assert.deepEqual(scopeChain(m, 'icons'), ['icons', 'web', 'platform', 'app'])
  assert.deepEqual(redundantExtends(m), [
    'scope "web": extends "platform" is already its parent; remove it',
    'scope "icons": extends "platform" is already its ancestor; remove it',
    'scope "icons": extends "web" is already its parent; remove it',
  ])
  await writeManifest(d, m)
  const written = await readFile(join(d, 'rness.json'), 'utf8')
  assert.match(
    written,
    /"web": \{\n {10}"path": "apps\/web",\n {10}"extends": \["app"\],/
  )
  assert.match(written, /"icons": \{ "path": "icons" \}/)
  const again = await loadManifest(d)
  assert.deepEqual(redundantExtends(again), [])
  assert.deepEqual(again.scopes['icons']?.extends, ['web'])
  await writeManifest(d, again)
  assert.equal(await readFile(join(d, 'rness.json'), 'utf8'), written)
})

test('writeManifest refuses a manifest the reader could not have given: no url and no parent, a part with a url, a parent not declared, parents in a loop, a part outside its parent', async (t) => {
  const d = await fixture({ contract: 2, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const base: Manifest = await loadManifest(d)
  const repo = (name: string): ScopeEntry => ({
    path: `org/${name}`,
    url: `https://github.com/acme/${name}.git`,
    parent: null,
    extends: [],
  })
  const part = (path: string, parent: string): ScopeEntry => ({
    path,
    url: null,
    parent,
    extends: [parent],
  })
  const cases: [Record<string, ScopeEntry>, string][] = [
    [
      { web: { ...repo('web'), url: null } },
      'scope "web" has no url and no parent',
    ],
    [
      {
        platform: repo('platform'),
        web: { ...part('org/platform/web', 'platform'), url: 'x' },
      },
      'scope "web" is a part of platform and has a url',
    ],
    [
      { web: part('org/platform/web', 'platform') },
      'scope "web" is a part of platform, which is not a scope',
    ],
    [
      {
        a: part('org/x/a', 'b'),
        b: part('org/x/a/b', 'a'),
      },
      'scope "a": its parents never reach a repository',
    ],
    [
      { platform: repo('platform'), web: part('org/web', 'platform') },
      'scope "web" at org/web is not inside platform',
    ],
  ]
  for (const [scopes, message] of cases) {
    await assert.rejects(
      () => writeManifest(d, { ...base, scopes }),
      new Error(`rness.json: ${message}`),
      message
    )
  }
  assert.deepEqual(await loadManifest(d), base, 'nothing written')
})

test('contract 2: extends names any scope of the tree, a cycle left to scopeChain', async (t) => {
  const d = await fixture({
    contract: 2,
    scopes: {
      app: { url: 'git@github.com:acme/app.git', extends: ['web'] },
      platform: {
        url: 'https://github.com/acme/platform.git',
        extends: ['app'],
        scopes: { web: { path: 'apps/web' } },
      },
    },
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const m = await loadManifest(d)
  assert.deepEqual(m.scopes['app']?.extends, ['web'])
  assert.throws(() => scopeChain(m, 'app'), /extends cycle/)
})

test('contract 1 names upgrade; another contract is unsupported', async (t) => {
  for (const json of [
    { contract: 1, repos: {}, scopes: {} },
    { contract: 1, repos: { web: { url: 'x' } }, projects: { pulse: 3 } },
  ]) {
    const d = await fixture(json)
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    await assert.rejects(
      () => loadManifest(d),
      new Error(
        'rness.json is contract 1: run npx @rness/cli@latest upgrade (ADR 0012)'
      )
    )
  }
  // `upgrade` never delegates: the line names the latest copy whatever ran
  // this one, never a runner that may resolve to a copy reading no contract 1.
  const saved = process.env['npm_config_user_agent']
  t.after(() => {
    if (saved === undefined) delete process.env['npm_config_user_agent']
    else process.env['npm_config_user_agent'] = saved
  })
  process.env['npm_config_user_agent'] = 'pnpm/12.5.1 npm/? node/v24.0.0'
  const d = await fixture({ contract: 1, repos: {}, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(
    () => loadManifest(d),
    new Error(
      'rness.json is contract 1: run npx @rness/cli@latest upgrade (ADR 0012)'
    )
  )
  for (const contract of [3, '2', undefined]) {
    const d = await fixture({ contract, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    await assert.rejects(
      () => loadManifest(d),
      new Error(
        `rness.json: unsupported contract: ${JSON.stringify(contract)} (expected 2)`
      )
    )
  }
})

test('repos, projects and pulse are unknown keys of contract 2', async (t) => {
  for (const [key, value] of [
    ['repos', {}],
    ['projects', { pulse: 3 }],
    ['pulse', { project: 3 }],
  ] as const) {
    const d = await fixture({ contract: 2, [key]: value, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    await assert.rejects(
      () => loadManifest(d),
      new Error(`rness.json: unknown key "${key}"`)
    )
  }
})

test('contract 2 is written as read: a repository on one line, its parts nested; a second write changes nothing', async (t) => {
  const d = await fixture(EXAMPLE)
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const read = await loadManifest(d)
  await writeManifest(d, read)
  assert.equal(await readFile(join(d, 'rness.json'), 'utf8'), EXAMPLE)
  assert.deepEqual(await loadManifest(d), read)
  await writeManifest(d, await loadManifest(d))
  assert.equal(await readFile(join(d, 'rness.json'), 'utf8'), EXAMPLE)
})

test('writeManifest: extends only when it has names, a part with parts expanded, no scope as {}', async (t) => {
  const text = `{
  "contract": 2,
  "scopes": {
    "shared": { "url": "https://github.com/acme/shared.git" },
    "app": { "url": "git@github.com:acme/app.git", "extends": ["shared"] },
    "platform": {
      "url": "https://github.com/acme/platform.git",
      "extends": ["shared"],
      "scopes": {
        "web": {
          "path": "apps/web",
          "extends": ["app"],
          "scopes": {
            "icons": { "path": "src/icons" }
          }
        }
      }
    }
  }
}
`
  const d = await fixture(text)
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const read = await loadManifest(d)
  assert.deepEqual(read.scopes['web']?.extends, ['platform', 'app'])
  await writeManifest(d, read)
  assert.equal(await readFile(join(d, 'rness.json'), 'utf8'), text)
  await writeManifest(d, { ...read, scopes: {} })
  assert.equal(
    await readFile(join(d, 'rness.json'), 'utf8'),
    '{\n  "contract": 2,\n  "scopes": {}\n}\n'
  )
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
    contract: 2,
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
    contract: 2,
    org: 'acme-dev',
    scopes: {},
  })
  t.after(() => rm(dirname(withOrgDir), { recursive: true, force: true }))
  const withOrg = await loadManifest(withOrgDir)
  assert.equal(withOrg.org, 'acme-dev')

  const withoutDir = await fixture({ contract: 2, scopes: {} })
  t.after(() => rm(dirname(withoutDir), { recursive: true, force: true }))
  const without = await loadManifest(withoutDir)
  assert.equal(without.org, null)

  const badDir = await fixture({
    contract: 2,
    org: 'Acme Inc',
    scopes: {},
  })
  t.after(() => rm(dirname(badDir), { recursive: true, force: true }))
  await assert.rejects(() => loadManifest(badDir), /rness\.json:.*"org"/)
})

test('org follows GitHub: case kept, single inner hyphens, at most 39 characters', async (t) => {
  const org = async (value: string) => {
    const d = await fixture({ contract: 2, org: value, scopes: {} })
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
  const d = await fixture({ contract: 2, scopes: {} })
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
  const d = await fixture({ contract: 2, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await writeManifest(d, {
    contract: 2,
    provider: null,
    org: null,
    agents: null,
    boards: null,
    scopes: {
      web: {
        path: 'org/web',
        url: 'https://github.com/acme/web.git',
        parent: null,
        extends: [],
      },
      ui: {
        path: 'org/web/packages/ui',
        url: null,
        parent: 'web',
        extends: ['web'],
      },
    },
  })
  const text = await readFile(join(d, 'rness.json'), 'utf8')
  assert.equal(
    text,
    `{
  "contract": 2,
  "scopes": {
    "web": {
      "url": "https://github.com/acme/web.git",
      "scopes": {
        "ui": { "path": "packages/ui" }
      }
    }
  }
}
`
  )
  await writeManifest(d, {
    contract: 2,
    provider: null,
    org: 'acme',
    agents: null,
    boards: null,
    scopes: {},
  })
  assert.match(
    await readFile(join(d, 'rness.json'), 'utf8'),
    /^\{\n {2}"contract": 2,\n {2}"org": "acme",\n/
  )
  assert.deepEqual(await loadManifest(d), {
    contract: 2,
    provider: null,
    org: 'acme',
    agents: null,
    boards: null,
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
    const d = await fixture({ contract: 2, agents, scopes: {} })
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
    const d = await fixture({ contract: 2, agents, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    await assert.rejects(
      () => loadManifest(d),
      /^Error: rness\.json: "agents" must be a list of unique agent names/,
      JSON.stringify(agents)
    )
  }
})

test('writeManifest puts agents after org, and writes [] too', async (t) => {
  const d = await fixture({ contract: 2, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await writeManifest(d, {
    contract: 2,
    provider: null,
    org: 'acme',
    agents: ['claude'],
    boards: null,
    scopes: {},
  })
  assert.match(
    await readFile(join(d, 'rness.json'), 'utf8'),
    /^\{\n {2}"contract": 2,\n {2}"org": "acme",\n {2}"agents": \["claude"\],\n {2}"scopes"/
  )
  await writeManifest(d, {
    contract: 2,
    provider: null,
    org: null,
    agents: [],
    boards: null,
    scopes: {},
  })
  assert.match(
    await readFile(join(d, 'rness.json'), 'utf8'),
    /^\{\n {2}"contract": 2,\n {2}"agents": \[\],\n/
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
    const d = await fixture({ contract: 2, provider, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    assert.equal((await loadManifest(d)).provider, expected)
  }
  for (const provider of ['svn', 'GitHub', 1, null]) {
    const d = await fixture({ contract: 2, provider, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    await assert.rejects(
      () => loadManifest(d),
      new Error(
        `rness.json: "provider" must be one of github, gitlab, atlassian (got ${JSON.stringify(provider)})`
      )
    )
  }
})

/** A board declared whole, without its number: not created yet (spec 0033 §4). */
const UNNUMBERED = {
  collections: { marketing: { statuses: 'found' } },
  views: [{ name: 'Board', layout: 'board' }],
}

test('boards: a name to a project number or a preset; absent is null', async (t) => {
  for (const [boards, expected] of [
    [undefined, null],
    [{ pulse: 4 }, { pulse: 4 }],
    [
      { pulse: 4, marketing: 5 },
      { pulse: 4, marketing: 5 },
    ],
    [{ marketing: 5 }, { marketing: 5 }],
    [{ pulse: 'agent-pulse' }, { pulse: 'agent-pulse' }],
    [
      { pulse: 'agent-pulse/1', marketing: 'collection' },
      { pulse: 'agent-pulse/1', marketing: 'collection' },
    ],
  ] as const) {
    const d = await fixture({ contract: 2, boards, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    assert.deepEqual((await loadManifest(d)).boards, expected)
  }
})

test('on GitLab a board is named by ids, in view order; number is refused there, ids elsewhere', async (t) => {
  const load = async (provider: string, boards: unknown) => {
    const d = await fixture({
      contract: 2,
      provider,
      boards,
      scopes: {},
    })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    return loadManifest(d)
  }
  const ids = { ADR: 12, Specs: 13, Plans: 14 }
  const ok = await load('gitlab', { pulse: { ...UNNUMBERED, ids } })
  const pulse = ok.boards?.['pulse']
  assert.ok(typeof pulse === 'object' && pulse !== null)
  assert.deepEqual(pulse.ids, ids)
  assert.deepEqual(Object.keys(pulse.ids ?? {}), ['ADR', 'Specs', 'Plans'])
  const numbered = await load('gitlab', {
    pulse: { ...UNNUMBERED, number: 4 },
  })
  assert.deepEqual(
    numbered.refused?.map((r) => r.reason),
    [
      '"boards.pulse.number" is GitHub\'s: a GitLab board is named by "ids", one per view',
    ]
  )
  const bare = await load('gitlab', { pulse: 4 })
  assert.deepEqual(
    bare.refused?.map((r) => r.reason),
    [
      '"boards.pulse.number" is GitHub\'s: a GitLab board is named by "ids", one per view',
    ]
  )
  const github = await load('github', { pulse: { ...UNNUMBERED, ids } })
  assert.deepEqual(
    github.refused?.map((r) => r.reason),
    ['"boards.pulse.ids" are GitLab\'s: a GitHub board is named by "number"']
  )
})

test('boards keeps the order it is written in', async (t) => {
  const d = await fixture({
    contract: 2,
    boards: { marketing: 5, pulse: 4, roadmap: 6 },
    scopes: {},
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const boards = (await loadManifest(d)).boards
  assert.deepEqual(Object.keys(boards ?? {}), ['marketing', 'pulse', 'roadmap'])
})

test('boards: anything but names to boards on distinct projects is an error', async (t) => {
  for (const boards of [
    3,
    null,
    [],
    {},
    { pulse: 0 },
    { pulse: -1 },
    { pulse: 1.5 },
    { pulse: true },
    { pulse: 4, marketing: 4 },
    { '../x': 5 },
    { '.hidden': 5 },
    { 'a b': 5 },
    { '': 5 },
  ]) {
    const d = await fixture({ contract: 2, boards, scopes: {} })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    await assert.rejects(
      () => loadManifest(d),
      new Error(
        `rness.json: "boards" must map names to boards on distinct projects, as { "pulse": "agent-pulse", "marketing": 5 } (got ${JSON.stringify(boards)})`
      )
    )
  }
})

test('boards: a preset not of its name, or not of this rness, is refused, the others read (spec 0033 §4)', async (t) => {
  const d = await fixture({
    contract: 2,
    boards: {
      pulse: 'collection',
      marketing: 'agent-pulse',
      research: 'collection/9',
      roadmap: '3',
      specs: 'collection/1',
    },
    scopes: {},
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const m = await loadManifest(d)
  assert.deepEqual(m.boards, { specs: 'collection/1' })
  assert.deepEqual(
    m.refused?.map((r) => [r.reason, r.source]),
    [
      [
        '"boards.pulse" names collection: pulse is made from agent-pulse',
        'collection',
      ],
      [
        '"boards.marketing" names agent-pulse: a collection\'s board is made from collection',
        'agent-pulse',
      ],
      [
        '"boards.research" names collection/9, which this rness does not have',
        'collection/9',
      ],
      ['"boards.roadmap" must name a preset, as "collection"', '3'],
    ]
  )
})

test('boards: a board declared without its number is not created yet; the numbers of the others stay distinct', async (t) => {
  const d = await fixture({
    contract: 2,
    boards: { pulse: 5, marketing: UNNUMBERED, research: UNNUMBERED },
    scopes: {},
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const board = (await loadManifest(d)).boards?.['marketing']
  assert.ok(typeof board === 'object')
  assert.equal(board.number, null)
  assert.equal(projectNumber(board), null)
  assert.equal(projectNumber('collection'), null)
  assert.equal(projectNumber(5), 5)
})

test('writeManifest writes provider after contract and boards after agents', async (t) => {
  const d = await fixture({ contract: 2, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const manifest: Manifest = {
    contract: 2,
    provider: 'github',
    org: 'acme',
    agents: ['claude'],
    boards: { pulse: 3, marketing: 5 },
    scopes: {},
  }
  await writeManifest(d, manifest)
  assert.equal(
    await readFile(join(d, 'rness.json'), 'utf8'),
    `{
  "contract": 2,
  "provider": "github",
  "org": "acme",
  "agents": ["claude"],
  "boards": { "pulse": 3, "marketing": 5 },
  "scopes": {}
}
`
  )
  assert.deepEqual(await loadManifest(d), manifest)
  await writeManifest(d, { ...manifest, provider: null, boards: null })
  const text = await readFile(join(d, 'rness.json'), 'utf8')
  assert.equal(text.includes('provider'), false)
  assert.equal(text.includes('boards'), false)
})

/** A board declared whole (spec 0031 §2.2), as small as one can be. */
const BOARD = {
  number: 5,
  collections: { marketing: { statuses: 'found' } },
  views: [{ name: 'Board', layout: 'board' }],
}

test('boards: a board declared whole is read as one, its source kept; a number stays a number', async (t) => {
  const d = await fixture({
    contract: 2,
    boards: { pulse: 4, marketing: BOARD },
    scopes: {},
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const { boards, refused } = await loadManifest(d)
  assert.equal(boards?.['pulse'], 4)
  const board = boards?.['marketing']
  assert.ok(typeof board === 'object')
  assert.equal(board.number, 5)
  assert.deepEqual(board.source, BOARD)
  assert.equal(refused, undefined)
})

test('boards: a board refused is set aside with its reason, the others and the rest of rness.json read', async (t) => {
  const bad = { ...BOARD, number: 6, views: [] }
  const d = await fixture({
    contract: 2,
    org: 'acme',
    boards: { pulse: 4, marketing: bad, research: { ...BOARD, number: 7 } },
    scopes: {},
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const m = await loadManifest(d)
  assert.equal(m.org, 'acme')
  assert.deepEqual(Object.keys(m.boards ?? {}), ['pulse', 'research'])
  assert.deepEqual(m.refused, [
    {
      name: 'marketing',
      reason: '"boards.marketing.views" must list at least one view',
      source: bad,
    },
  ])
})

test('boards: two boards on one project number are refused, whatever their form', async (t) => {
  const d = await fixture({
    contract: 2,
    boards: { pulse: 5, marketing: BOARD },
    scopes: {},
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  await assert.rejects(
    () => loadManifest(d),
    /^Error: rness\.json: "boards" must map names to boards on distinct projects/
  )
})

test('writeManifest: a board declared whole on several lines, numbers as they are, a refused board kept; read back the same', async (t) => {
  const bad = { ...BOARD, number: 6, views: [] }
  const d = await fixture({
    contract: 2,
    boards: { pulse: 4, marketing: BOARD, research: bad },
    scopes: {},
  })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const read = await loadManifest(d)
  await writeManifest(d, read)
  assert.equal(
    await readFile(join(d, 'rness.json'), 'utf8'),
    `{
  "contract": 2,
  "boards": {
    "pulse": 4,
    "marketing": {
      "number": 5,
      "collections": {
        "marketing": {
          "statuses": "found"
        }
      },
      "views": [
        {
          "name": "Board",
          "layout": "board"
        }
      ]
    },
    "research": {
      "number": 6,
      "collections": {
        "marketing": {
          "statuses": "found"
        }
      },
      "views": []
    }
  },
  "scopes": {}
}
`
  )
  assert.deepEqual(await loadManifest(d), read)
})

test('providerOf: the key wins, else the first repository host, else github', () => {
  const base: Manifest = {
    contract: 2,
    provider: null,
    org: null,
    agents: null,
    boards: null,
    scopes: {},
  }
  const web = (url: string) => ({
    web: { path: 'org/web', url, parent: null, extends: [] },
  })
  assert.equal(providerOf(base), 'github')
  assert.equal(
    providerOf({
      ...base,
      provider: 'atlassian',
      scopes: web('https://gitlab.com/acme/web.git'),
    }),
    'atlassian'
  )
  assert.equal(
    providerOf({ ...base, scopes: web('https://gitlab.com/acme/web.git') }),
    'gitlab'
  )
  assert.equal(
    providerOf({ ...base, scopes: web('git@github.com:acme/web.git') }),
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
    () => parseRepoSpec('Bad Name', 'acme', host),
    /repository name "Bad Name" may only contain lowercase letters, digits, '\.', '_' and '-'/
  )
  // What GitHub allows in a repository name is a name: dots and underscores.
  for (const name of ['my_lib', 'angular.js', 'v2.api-client', '.github', '_x'])
    assert.equal(parseRepoSpec(name, 'acme', host).name, name)
  // A directory under org/ and a git argument: never `.`, `..` or an option.
  for (const name of ['.', '..', '-rf', 'a b', 'A B'])
    assert.throws(() => parseRepoSpec(name, 'acme', host), /repository name/)
  assert.throws(() => parseRepoSpec('a/b/c', 'acme', host), /repository name/)
})

test('parseRepoSpec on GitLab: a full path of three segments or more; the key its last segment', () => {
  const host = 'git@gitlab.com:'
  assert.deepEqual(parseRepoSpec('api', 'acme', host, 'gitlab'), {
    name: 'api',
    url: 'git@gitlab.com:acme/api.git',
  })
  assert.deepEqual(parseRepoSpec('other/api', 'acme', host, 'gitlab'), {
    name: 'api',
    url: 'git@gitlab.com:other/api.git',
  })
  assert.deepEqual(
    parseRepoSpec('acme/platform/Mobile', 'acme', host, 'gitlab'),
    { name: 'mobile', url: 'git@gitlab.com:acme/platform/Mobile.git' }
  )
  // GitHub has no third segment.
  assert.throws(
    () => parseRepoSpec('acme/platform/mobile', 'acme', 'https://github.com/'),
    /is not a name \(use <repo>, <owner>\/<repo>, or a URL\)/
  )
  // A blank workspace: the provider's word.
  assert.throws(
    () => parseRepoSpec('api', null, host, 'gitlab'),
    /^Error: this workspace has no GitLab group: give <group>\/<project> or a git URL$/
  )
  assert.throws(
    () => parseRepoSpec('api', null, 'https://github.com/'),
    /^Error: this workspace has no GitHub organization: give <owner>\/<repo> or a git URL$/
  )
})

test('parseRepoSpec takes a name in any case: the key is lowercase, the URL as typed', () => {
  // GitHub resolves names case-insensitively, a file:// remote on Linux does
  // not: the URL keeps the spelling the user typed, the key and the directory
  // under org/ are lowercase, as `create` declares them.
  const host = 'https://github.com/'
  assert.deepEqual(parseRepoSpec('dApp', 'acme', host), {
    name: 'dapp',
    url: 'https://github.com/acme/dApp.git',
  })
  assert.deepEqual(parseRepoSpec('Other/My_Lib', 'acme', host), {
    name: 'my_lib',
    url: 'https://github.com/Other/My_Lib.git',
  })
  assert.deepEqual(
    parseRepoSpec('git@github.com:acme/dApp.git', 'acme', host),
    { name: 'dapp', url: 'git@github.com:acme/dApp.git' }
  )
  assert.deepEqual(
    parseRepoSpec('file:///tmp/gh/acme/Tools.git', 'acme', host),
    { name: 'tools', url: 'file:///tmp/gh/acme/Tools.git' }
  )
  // The context repository is the same name in any case.
  assert.equal(parseRepoSpec('.RNESS', 'acme', host).name, '.rness')
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

test('org on GitLab is a group path: dots and underscores, no subgroup, the message names GitLab', async (t) => {
  const org = async (value: string, provider = 'gitlab') => {
    const d = await fixture({
      contract: 2,
      provider,
      org: value,
      scopes: {},
    })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    return loadManifest(d)
  }
  for (const good of ['acme', 'acme.io', 'acme_corp', 'Acme-Dev', '_acme'])
    assert.equal((await org(good)).org, good)
  for (const bad of [
    '-acme',
    'acme.',
    'acme.git',
    'acme.atom',
    'acme/platform',
    'ac me',
  ]) {
    await assert.rejects(
      () => org(bad),
      /^Error: rness\.json: "org" must be a GitLab group path \(got "/,
      bad
    )
  }
  // GitHub's rule is unchanged.
  await assert.rejects(
    () => org('acme.io', 'github'),
    /"org" must be a GitHub organization name/
  )
})

test('the context repository is .rness, rness on GitLab: excluded there only', () => {
  assert.equal(contextRepo('github'), '.rness')
  assert.equal(contextRepo(null), '.rness')
  assert.equal(contextRepo('gitlab'), 'rness')
  assert.equal(isMemberRepo({ name: 'rness', archived: false }), true)
  assert.equal(
    isMemberRepo({ name: 'rness', archived: false }, 'gitlab'),
    false
  )
  assert.equal(isMemberRepo({ name: 'web', archived: false }, 'gitlab'), true)
  assert.equal(isWorkspaceClone('rness'), true)
  assert.equal(isWorkspaceClone('rness', 'gitlab'), false)
  assert.equal(isWorkspaceClone('web', 'gitlab'), true)
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
  // A key of rness.json is read into an object: `__proto__` would be its
  // prototype. Its other built-in names are own keys there, harmless.
  assert.equal(isWorkspaceClone('__proto__'), false)
  assert.equal(isWorkspaceClone('constructor'), true)
  assert.equal(isWorkspaceClone('prototype'), true)
})

test('the exclusion list is one place, shared by both rules', () => {
  for (const name of EXCLUDED_NAMES) {
    assert.equal(isWorkspaceClone(name), false, name)
    assert.equal(isMemberRepo({ name, archived: false }), false, name)
  }
})

// Atlassian (spec 0039 §2).
test('org on Atlassian is a Bitbucket workspace slug: lowercase, digits, - and _; the message names Bitbucket', async (t) => {
  const org = async (value: string) => {
    const d = await fixture({
      contract: 2,
      provider: 'atlassian',
      org: value,
      scopes: {},
    })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    return loadManifest(d)
  }
  for (const good of ['acme', 'rness-dev', 'acme_corp', 'acme2'])
    assert.equal((await org(good)).org, good)
  for (const bad of ['Acme', '-acme', 'acme.io', 'ac me', 'acme/api', ''])
    await assert.rejects(
      () => org(bad),
      /^Error: rness\.json: "org" must be a Bitbucket workspace slug \(got "/,
      bad
    )
})

test('jira: read with provider atlassian only; a site on atlassian.net and a space key; written after org', async (t) => {
  const jira = { site: 'rness-dev.atlassian.net', space: 'RNESS' }
  const read = async (json: Record<string, unknown>) => {
    const d = await fixture({ contract: 2, scopes: {}, ...json })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    return loadManifest(d)
  }
  assert.deepEqual(
    (await read({ provider: 'atlassian', org: 'rness-dev', jira })).jira,
    jira
  )
  assert.equal(
    Object.hasOwn(
      await read({ provider: 'atlassian', org: 'rness-dev' }),
      'jira'
    ),
    false
  )
  for (const provider of ['github', 'gitlab', undefined])
    await assert.rejects(
      () => read({ provider, jira }),
      new Error(
        'rness.json: "jira" is for an Atlassian workspace: it needs "provider": "atlassian"'
      ),
      String(provider)
    )
  for (const bad of [
    { site: 'rness-dev.example.com', space: 'RNESS' },
    { site: 'https://rness-dev.atlassian.net', space: 'RNESS' },
    { site: 'rness-dev.atlassian.net', space: 'rness' },
    { site: 'rness-dev.atlassian.net', space: 'R' },
    { site: 'rness-dev.atlassian.net', space: 'RNESS', board: 1 },
    { site: 'rness-dev.atlassian.net' },
    'RNESS',
  ])
    await assert.rejects(
      () => read({ provider: 'atlassian', jira: bad }),
      new Error(
        `rness.json: "jira" must be { "site": "<name>.atlassian.net", "space": "<KEY>" } (got ${JSON.stringify(bad)})`
      ),
      JSON.stringify(bad)
    )

  const d = await fixture({ contract: 2, scopes: {} })
  t.after(() => rm(dirname(d), { recursive: true, force: true }))
  const manifest: Manifest = {
    contract: 2,
    provider: 'atlassian',
    org: 'rness-dev',
    jira,
    agents: ['claude'],
    boards: null,
    scopes: {
      cli: {
        path: 'org/cli',
        url: 'git@ssh.bitbucket.org:rness-dev/cli.git',
        parent: null,
        extends: [],
      },
    },
  }
  await writeManifest(d, manifest)
  assert.equal(
    await readFile(join(d, 'rness.json'), 'utf8'),
    `{
  "contract": 2,
  "provider": "atlassian",
  "org": "rness-dev",
  "jira": { "site": "rness-dev.atlassian.net", "space": "RNESS" },
  "agents": ["claude"],
  "scopes": {
    "cli": { "url": "git@ssh.bitbucket.org:rness-dev/cli.git" }
  }
}
`
  )
  assert.deepEqual(await loadManifest(d), manifest)
})

test('providerOf: a Bitbucket URL, either SSH host, is Atlassian', () => {
  const base: Manifest = {
    contract: 2,
    provider: null,
    org: null,
    agents: null,
    boards: null,
    scopes: {},
  }
  for (const url of [
    'git@ssh.bitbucket.org:acme/api.git',
    'git@bitbucket.org:acme/api.git',
    'https://bitbucket.org/acme/api.git',
    'https://x-bitbucket-api-token-auth@bitbucket.org/acme/api.git',
  ])
    assert.equal(
      providerOf({
        ...base,
        scopes: { api: { path: 'org/api', url, parent: null, extends: [] } },
      }),
      'atlassian',
      url
    )
})

test('the context repository on Atlassian is .rness, excluded as on GitHub', () => {
  assert.equal(contextRepo('atlassian'), '.rness')
  assert.equal(
    isMemberRepo({ name: '.rness', archived: false }, 'atlassian'),
    false
  )
  assert.equal(
    isMemberRepo({ name: 'rness', archived: false }, 'atlassian'),
    true
  )
  assert.equal(isWorkspaceClone('rness', 'atlassian'), true)
})

test('parseRepoSpec: a URL on the old Bitbucket SSH host is written on the new one', () => {
  assert.deepEqual(
    parseRepoSpec(
      'git@bitbucket.org:acme/api.git',
      'acme',
      'https://bitbucket.org/',
      'atlassian'
    ),
    { name: 'api', url: 'git@ssh.bitbucket.org:acme/api.git' }
  )
  assert.deepEqual(
    parseRepoSpec('api', 'acme', 'git@ssh.bitbucket.org:', 'atlassian'),
    { name: 'api', url: 'git@ssh.bitbucket.org:acme/api.git' }
  )
})

test('on Atlassian a board names nothing: number and ids are refused, naming the key (spec 0039 §2)', async (t) => {
  const load = async (boards: unknown) => {
    const d = await fixture({
      contract: 2,
      provider: 'atlassian',
      boards,
      scopes: {},
    })
    t.after(() => rm(dirname(d), { recursive: true, force: true }))
    return loadManifest(d)
  }
  const plain = await load({ pulse: 'agent-pulse' })
  assert.equal(plain.refused, undefined)
  const said =
    "on Atlassian the board is the Jira space's own: nothing names it"
  assert.deepEqual(
    (await load({ pulse: { ...UNNUMBERED, number: 4 } })).refused?.map(
      (r) => r.reason
    ),
    [`"boards.pulse.number" is GitHub's: ${said}`]
  )
  assert.deepEqual(
    (await load({ pulse: 4 })).refused?.map((r) => r.reason),
    [`"boards.pulse.number" is GitHub's: ${said}`]
  )
  assert.deepEqual(
    (await load({ pulse: { ...UNNUMBERED, ids: { ADR: 1 } } })).refused?.map(
      (r) => r.reason
    ),
    [`"boards.pulse.ids" are GitLab's: ${said}`]
  )
})
