import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  parseManifest,
  readContract1,
  writeManifest,
} from '../../src/core/manifest.ts'
import { scopeChain } from '../../src/core/scope.ts'
import type { Manifest } from '../../src/core/types.ts'

/** The text of a fixture's file under `.rness/`. */
const fixtureText = (ws: string, file: string): Promise<string> =>
  readFile(
    fileURLToPath(new URL(`../fixtures/${ws}/.rness/${file}`, import.meta.url)),
    'utf8'
  )

/** `manifest` as `writeManifest` writes it, in a directory removed after the test. */
async function written(t: TestContext, manifest: Manifest): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rness-c1-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeManifest(dir, manifest)
  return readFile(join(dir, 'rness.json'), 'utf8')
}

/** A contract-1 file, as 0.24.0 read it: `repos` and flat `scopes`. */
const c1 = (data: Record<string, unknown>): string =>
  JSON.stringify({ contract: 1, ...data })

const url = (name: string): string => `https://github.com/acme/${name}.git`

/** The manifest `readContract1` gives, or the test fails with its lines. */
function shaped(raw: string): { manifest: Manifest; notes: string[] } {
  const read = readContract1(raw)
  assert.deepEqual(read.refusals, [])
  assert.ok(read.manifest !== null)
  return { manifest: read.manifest, notes: read.notes }
}

/** The lines that stop `upgrade`, and nothing else given. */
const refused = (raw: string): string[] => {
  const read = readContract1(raw)
  assert.equal(read.manifest, null)
  assert.deepEqual(read.notes, [])
  return read.refusals
}

test('the contract-1 copies of ws-basic, ws-routing, ws-scoped: written back as their contract-2 file, byte for byte; read again identical', async (t) => {
  for (const ws of ['ws-basic', 'ws-routing', 'ws-scoped']) {
    const before = await fixtureText(ws, 'rness.contract-1.json')
    const after = await fixtureText(ws, 'rness.json')
    // Every other command refuses the former file (spec 0038 §2).
    assert.throws(
      () => parseManifest(before),
      new Error('rness.json is contract 1: run rness upgrade (ADR 0012)')
    )
    const { manifest, notes } = shaped(before)
    assert.deepEqual(notes, [], ws)
    assert.deepEqual(manifest, parseManifest(after), ws)
    assert.deepEqual(
      Object.keys(manifest.scopes),
      Object.keys(parseManifest(after).scopes),
      ws
    )
    const text = await written(t, manifest)
    assert.equal(text, after, ws)
    assert.deepEqual(parseManifest(text), manifest, ws)
  }
})

test("spec 0038 §1's example, as contract 1 held it: written back as the example, byte for byte", async (t) => {
  const raw = `{
  "contract": 1,
  "provider": "github",
  "org": "acme",
  "agents": ["claude"],
  "boards": { "pulse": 3 },
  "repos": {
    "app": { "url": "git@github.com:acme/app.git" },
    "platform": { "url": "https://github.com/acme/platform.git" }
  },
  "scopes": {
    "app": { "path": "org/app" },
    "platform": { "path": "org/platform" },
    "web": { "path": "org/platform/apps/web", "extends": ["platform"] },
    "ui": { "path": "org/platform/packages/ui", "extends": ["platform", "web"] }
  }
}
`
  const { manifest, notes } = shaped(raw)
  assert.deepEqual(notes, [])
  assert.deepEqual(manifest.scopes, {
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
  assert.equal(
    await written(t, manifest),
    `{
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
  )
})

test('a scope nests under the deepest scope whose path holds it, segment by segment; its path made relative; its ancestors dropped from extends', async (t) => {
  const { manifest, notes } = shaped(
    c1({
      repos: { platform: { url: url('platform') } },
      scopes: {
        icons: {
          path: 'org/platform/apps/web/icons',
          extends: ['web', 'platform', 'webx'],
        },
        platform: { path: 'org/platform' },
        webx: { path: 'org/platform/apps/web-x', extends: ['platform'] },
        web: { path: 'org/platform/apps/web', extends: ['platform'] },
      },
    })
  )
  assert.deepEqual(notes, [])
  // The order the written file reads in: a scope before its parts.
  assert.deepEqual(Object.keys(manifest.scopes), [
    'platform',
    'webx',
    'web',
    'icons',
  ])
  assert.deepEqual(manifest.scopes['icons'], {
    path: 'org/platform/apps/web/icons',
    url: null,
    parent: 'web',
    extends: ['web', 'webx'],
  })
  assert.equal(manifest.scopes['webx']?.parent, 'platform')
  assert.deepEqual(scopeChain(manifest, 'icons'), [
    'icons',
    'web',
    'platform',
    'webx',
  ])
  const text = await written(t, manifest)
  assert.equal(
    text,
    `{
  "contract": 2,
  "scopes": {
    "platform": {
      "url": "https://github.com/acme/platform.git",
      "scopes": {
        "webx": { "path": "apps/web-x" },
        "web": {
          "path": "apps/web",
          "scopes": {
            "icons": { "path": "icons", "extends": ["webx"] }
          }
        }
      }
    }
  }
}
`
  )
  assert.deepEqual(parseManifest(text), manifest)
})

test('a repository extending another that has parts keeps its extends: no note, no line', async (t) => {
  const { manifest, notes } = shaped(
    c1({
      repos: { app: { url: url('app') }, platform: { url: url('platform') } },
      scopes: {
        app: { path: 'org/app', extends: ['platform'] },
        platform: { path: 'org/platform' },
        web: { path: 'org/platform/apps/web', extends: ['platform'] },
      },
    })
  )
  assert.deepEqual(notes, [])
  assert.deepEqual(manifest.scopes['app'], {
    path: 'org/app',
    url: url('app'),
    parent: null,
    extends: ['platform'],
  })
  assert.deepEqual(scopeChain(manifest, 'app'), ['app', 'platform'])
  const text = await written(t, manifest)
  assert.match(
    text,
    /"app": \{ "url": "https:\/\/github\.com\/acme\/app\.git", "extends": \["platform"\] \},/
  )
  assert.deepEqual(parseManifest(text), manifest)
})

test('a repository meets its scope at org/<name> case-insensitively: org/Web is web, its parts below as written', async (t) => {
  const { manifest } = shaped(
    c1({
      repos: { web: { url: url('web') } },
      scopes: {
        web: { path: 'org/Web' },
        docs: { path: 'Org/Web/apps/Docs', extends: ['web'] },
      },
    })
  )
  assert.deepEqual(manifest.scopes, {
    web: { path: 'org/web', url: url('web'), parent: null, extends: [] },
    docs: {
      path: 'org/web/apps/Docs',
      url: null,
      parent: 'web',
      extends: ['web'],
    },
  })
  const text = await written(t, manifest)
  assert.match(text, /"docs": \{ "path": "apps\/Docs" \}/)
  assert.deepEqual(parseManifest(text), manifest)
})

test('nesting changes what a scope inherits: one note per scope, its new chain (spec 0038 §11)', () => {
  const { manifest, notes } = shaped(
    c1({
      repos: {
        app: { url: url('app') },
        platform: { url: url('platform') },
        shared: { url: url('shared') },
      },
      scopes: {
        // A repository extending a part that now inherits its repository.
        app: { path: 'org/app', extends: ['web'] },
        platform: { path: 'org/platform' },
        shared: { path: 'org/shared' },
        // A sub-scope that did not extend its repository.
        web: { path: 'org/platform/apps/web' },
        // An extends order the parent now precedes.
        ui: {
          path: 'org/platform/packages/ui',
          extends: ['shared', 'platform'],
        },
        // As `rness add --scopes` wrote it: nothing changes.
        docs: { path: 'org/platform/apps/docs', extends: ['platform'] },
      },
    })
  )
  assert.deepEqual(notes, [
    'scope "app" now inherits web, platform (nested)',
    'scope "web" now inherits platform (nested)',
    'scope "ui" now inherits platform, shared (nested)',
  ])
  assert.deepEqual(manifest.scopes['ui']?.extends, ['platform', 'shared'])
  assert.deepEqual(manifest.scopes['docs']?.extends, ['platform'])
})

test('what contract 2 cannot hold stops upgrade, each with its line (spec 0038 §2, §11)', () => {
  const repo = (name: string) => ({ [name]: { url: url(name) } })
  for (const [data, lines] of [
    [
      { repos: repo('api'), scopes: {} },
      ['repo "api" has no scope at org/api'],
    ],
    [
      { repos: {}, scopes: { api: { path: 'org/api' } } },
      ['scope "api" at org/api has no repository: add its url, or remove it'],
    ],
    [
      { repos: {}, scopes: { web: { path: 'org/platform/apps/web' } } },
      [
        'scope "web" at org/platform/apps/web is inside no repository of rness.json',
      ],
    ],
    [
      { repos: {}, scopes: { web: { path: 'org' } } },
      ['scope "web" at org is inside no repository of rness.json'],
    ],
    [
      { repos: {}, scopes: { tools: { path: 'tools' } } },
      ['scope "tools" at tools/ is outside org/'],
    ],
    [
      { repos: {}, scopes: { shared: { path: '.rness/shared' } } },
      ['scope "shared" at .rness/shared/ is outside org/'],
    ],
    [
      { repos: repo('web'), scopes: { frontend: { path: 'org/web' } } },
      ['repo "web": its scope at org/web is named "frontend"; rename it web'],
    ],
    [
      { repos: repo('web'), scopes: { frontend: { path: 'org/WEB' } } },
      ['repo "web": its scope at org/web is named "frontend"; rename it web'],
    ],
    // Chosen here: what the binding lines do not cover.
    [
      {
        repos: repo('web'),
        scopes: { site: { path: 'org/web' }, web: { path: 'org/web' } },
      },
      ['scope "site" at org/web is a second scope of repo "web": remove it'],
    ],
    [
      {
        repos: repo('web'),
        scopes: { frontend: { path: 'org/web' }, site: { path: 'org/web' } },
      },
      [
        'repo "web": its scope at org/web is named "frontend"; rename it web',
        'scope "site" at org/web is a second scope of repo "web": remove it',
      ],
    ],
    [
      {
        repos: { ...repo('web'), ...repo('platform') },
        scopes: {
          platform: { path: 'org/platform' },
          web: { path: 'org/platform/apps/web' },
        },
      },
      [
        'repo "web" has no scope at org/web',
        'scope "web" at org/platform/apps/web has the name of repo "web": rename it',
      ],
    ],
    [
      {
        repos: repo('platform'),
        scopes: {
          platform: { path: 'org/platform' },
          web: { path: 'org/platform/apps/./web' },
        },
      },
      ['scope "web" path must not contain "."'],
    ],
    [
      {
        repos: { web: { url: url('web'), branch: 'main' } },
        scopes: { web: { path: 'org/web', url: url('web') } },
      },
      ['repo "web": unknown key "branch"', 'scope "web": unknown key "url"'],
    ],
    // One line per cause: a part of a scope that has no repository says nothing more.
    [
      {
        repos: {},
        scopes: {
          platform: { path: 'org/platform' },
          web: { path: 'org/platform/apps/web' },
        },
      },
      [
        'scope "platform" at org/platform has no repository: add its url, or remove it',
      ],
    ],
    // So does a part of a repository without its scope.
    [
      {
        repos: repo('platform'),
        scopes: { web: { path: 'org/platform/apps/web' } },
      },
      ['repo "platform" has no scope at org/platform'],
    ],
    // A repository extending its own part: nested, the part inherits it back.
    [
      {
        repos: repo('platform'),
        scopes: {
          platform: { path: 'org/platform', extends: ['web'] },
          web: { path: 'org/platform/apps/web' },
        },
      },
      [
        'scope "platform": once nested, its chain loops (platform, web, platform); remove an extends on that loop',
      ],
    ],
  ] as const) {
    assert.deepEqual(refused(c1(data)), lines, JSON.stringify(data))
  }
})

test('every line at once, the repositories first, then the scopes in the order written', () => {
  assert.deepEqual(
    refused(
      c1({
        repos: {
          api: { url: url('api') },
          web: { url: url('web') },
          docs: { url: url('docs'), branch: 'main' },
        },
        scopes: {
          tools: { path: 'tools' },
          frontend: { path: 'org/web' },
          docs: { path: 'org/docs' },
          lib: { path: 'org/lib' },
          ui: { path: 'org/platform/packages/ui' },
        },
      })
    ),
    [
      'repo "docs": unknown key "branch"',
      'repo "api" has no scope at org/api',
      'repo "web": its scope at org/web is named "frontend"; rename it web',
      'scope "tools" at tools/ is outside org/',
      'scope "lib" at org/lib has no repository: add its url, or remove it',
      'scope "ui" at org/platform/packages/ui is inside no repository of rness.json',
    ]
  )
})

test('two sub-scopes rness add wrote, one inside the other: the inner nests under the outer, and says so', async (t) => {
  // `rness add platform --scopes apps --scopes apps/web` in 0.24.0.
  const { manifest, notes } = shaped(
    c1({
      repos: { platform: { url: url('platform') } },
      scopes: {
        platform: { path: 'org/platform' },
        apps: { path: 'org/platform/apps', extends: ['platform'] },
        web: { path: 'org/platform/apps/web', extends: ['platform'] },
      },
    })
  )
  assert.deepEqual(notes, ['scope "web" now inherits apps, platform (nested)'])
  assert.deepEqual(manifest.scopes['web'], {
    path: 'org/platform/apps/web',
    url: null,
    parent: 'apps',
    extends: ['apps'],
  })
  assert.match(
    await written(t, manifest),
    /"apps": \{\n {10}"path": "apps",\n {10}"scopes": \{\n {12}"web": \{ "path": "web" \}\n/
  )
})

test('an extends cycle 0.24.0 already had is left to scopeChain, as contract 2 leaves it', () => {
  const { manifest, notes } = shaped(
    c1({
      repos: { alpha: { url: url('alpha') }, beta: { url: url('beta') } },
      scopes: {
        alpha: { path: 'org/alpha', extends: ['beta'] },
        beta: { path: 'org/beta', extends: ['alpha'] },
      },
    })
  )
  assert.deepEqual(notes, [])
  assert.throws(() => scopeChain(manifest, 'alpha'), /extends cycle/)
})

test('a file 0.24.0 refused is refused as 0.24.0 refused it; not JSON, or not contract 1, throws', () => {
  for (const [raw, message] of [
    ['{ "contract": 1, ', /^Error: rness\.json: invalid JSON \(/],
    ['[]', /^Error: rness\.json: must be a JSON object$/],
    [
      '{ "contract": 2, "scopes": {} }',
      /^Error: rness\.json: unsupported contract: 2 \(expected 1\)$/,
    ],
    [c1({ repo: {} }), /^Error: rness\.json: unknown key "repo"$/],
    [
      c1({ repos: { web: {} } }),
      /^Error: rness\.json: repo "web" needs a string "url"$/,
    ],
    [
      c1({ scopes: { web: { path: 'org/../web' } } }),
      /^Error: rness\.json: scope "web" path must not contain "\.\."$/,
    ],
    [
      c1({ scopes: { web: { path: 'org/web', extends: ['ghost'] } } }),
      /^Error: rness\.json: scope "web" extends unknown scope "ghost"$/,
    ],
    [
      c1({ scopes: { Web: { path: 'org/web' } } }),
      /^Error: rness\.json: scope name "Web" may only contain /,
    ],
  ] as const) {
    assert.throws(() => readContract1(raw), message, raw)
  }
})

test('the scaffold of 0.24.0, empty: written as an empty contract 2', async (t) => {
  const { manifest, notes } = shaped(c1({ repos: {}, scopes: {} }))
  assert.deepEqual(notes, [])
  assert.equal(
    await written(t, manifest),
    '{\n  "contract": 2,\n  "scopes": {}\n}\n'
  )
})

// --- the former names of boards (spec 0033 §3), through readContract1 -------

test('the former pulse: { "project": n } reads as boards.pulse (spec 0025 §2), its key said', () => {
  const { manifest } = shaped(
    c1({ pulse: { project: 3 }, repos: {}, scopes: {} })
  )
  assert.deepEqual(manifest.boards, { pulse: 3 })
  assert.equal(manifest.formerKey, 'pulse')
})

test('the former projects reads as boards (spec 0033 §3), its key said; boards says none', () => {
  const { manifest } = shaped(
    c1({
      projects: { pulse: 4, marketing: 'collection' },
      repos: {},
      scopes: {},
    })
  )
  assert.deepEqual(manifest.boards, { pulse: 4, marketing: 'collection' })
  assert.equal(manifest.formerKey, 'projects')
  assert.equal(
    shaped(c1({ boards: { pulse: 4 }, repos: {}, scopes: {} })).manifest
      .formerKey,
    undefined
  )
})

test('the former pulse: anything but { "project": <positive integer> } is an error', () => {
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
    assert.throws(
      () => readContract1(c1({ pulse, repos: {}, scopes: {} })),
      new Error(
        `rness.json: "pulse" must be { "project": <number> } (got ${JSON.stringify(pulse)})`
      )
    )
  }
})

test('more than one of boards, projects and pulse at once is refused, naming them', () => {
  for (const [keys, message] of [
    [
      { projects: { pulse: 3 }, pulse: { project: 3 } },
      '"projects" and "pulse" at once',
    ],
    [
      { boards: { pulse: 3 }, projects: { pulse: 3 } },
      '"boards" and "projects" at once',
    ],
    [
      { boards: { pulse: 3 }, projects: { pulse: 3 }, pulse: { project: 3 } },
      '"boards" and "projects" and "pulse" at once',
    ],
  ] as const) {
    assert.throws(
      () => readContract1(c1({ ...keys, repos: {}, scopes: {} })),
      new Error(`rness.json: ${message}: keep "boards" only`)
    )
  }
})

test('a file read with the former pulse or projects is written back with boards only', async (t) => {
  const pulse = await written(
    t,
    shaped(c1({ org: 'acme', pulse: { project: 3 }, repos: {}, scopes: {} }))
      .manifest
  )
  assert.equal(pulse.includes('"boards": { "pulse": 3 },'), true)
  assert.equal(pulse.includes('"pulse": {'), false)
  const projects = await written(
    t,
    shaped(
      c1({
        projects: { pulse: 3, marketing: 'collection' },
        repos: {},
        scopes: {},
      })
    ).manifest
  )
  assert.equal(
    projects.includes('"boards": { "pulse": 3, "marketing": "collection" },'),
    true
  )
  assert.equal(projects.includes('projects'), false)
  const read = parseManifest(projects)
  assert.deepEqual(read.boards, { pulse: 3, marketing: 'collection' })
  assert.equal(read.formerKey, undefined)
})

test('jira survives the rewrite unchanged, with the provider and the rest', async (t) => {
  const { manifest } = shaped(
    c1({
      provider: 'atlassian',
      org: 'rness-dev',
      jira: { site: 'rness.atlassian.net', space: 'RNESS' },
      repos: { web: { url: 'git@bitbucket.org:rness-dev/web.git' } },
      scopes: { web: { path: 'org/web' } },
    })
  )
  assert.deepEqual(manifest.jira, {
    site: 'rness.atlassian.net',
    space: 'RNESS',
  })
  const text = await written(t, manifest)
  assert.equal(
    text,
    `{
  "contract": 2,
  "provider": "atlassian",
  "org": "rness-dev",
  "jira": { "site": "rness.atlassian.net", "space": "RNESS" },
  "scopes": {
    "web": { "url": "git@bitbucket.org:rness-dev/web.git" }
  }
}
`
  )
  assert.deepEqual(parseManifest(text), manifest)
})
