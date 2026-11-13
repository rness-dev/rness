import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { exists } from '../../src/core/fs.ts'
import { originUrl } from '../../src/core/git.ts'
import {
  loadManifest,
  repositories,
  writeManifest,
} from '../../src/core/manifest.ts'
import {
  addRepository,
  cloneHolding,
  workspaceDirs,
} from '../../src/core/repos.ts'
import { git, makeBareRepo } from '../helpers/git.ts'
import { makeRemoteOrg } from '../helpers/remote-org.ts'
import { ignoresCase, makeWorkspace } from '../helpers/workspace.ts'

process.env['GIT_AUTHOR_NAME'] = 'rness-test'
process.env['GIT_AUTHOR_EMAIL'] = 'test@rness.invalid'
process.env['GIT_COMMITTER_NAME'] = 'rness-test'
process.env['GIT_COMMITTER_EMAIL'] = 'test@rness.invalid'

async function ws(t: Parameters<typeof makeWorkspace>[0]) {
  const root = await makeWorkspace(t, { org: 'acme', dirs: ['org'] })
  const rnessDir = join(root, '.rness')
  return { root, rnessDir, manifest: await loadManifest(rnessDir) }
}

test('clones a new repository, declares repo and scope, writes the manifest after the clone', async (t) => {
  const url = await makeBareRepo(t, 'api')
  const { root, rnessDir, manifest } = await ws(t)
  const result = await addRepository({
    root,
    rnessDir,
    manifest,
    spec: url,
    org: 'acme',
    host: 'file:///unused/',
    scopes: [],
  })
  assert.equal(result.action, 'cloned')
  assert.equal(result.name, 'api')
  assert.deepEqual(result.declared, ['api'])
  assert.equal(await originUrl(join(root, 'org', 'api')), url)
  const written = await loadManifest(rnessDir)
  assert.deepEqual(repositories(written), [
    { name: 'api', url, dir: 'org/api' },
  ])
  assert.deepEqual(written.scopes, {
    api: { path: 'org/api', url, parent: null, extends: [] },
  })
})

test('adopts an existing clone of the same URL; refuses a different origin or a plain directory', async (t) => {
  const url = await makeBareRepo(t, 'api')
  const other = await makeBareRepo(t, 'other')
  const { root, rnessDir, manifest } = await ws(t)
  const first = await addRepository({
    root,
    rnessDir,
    manifest,
    spec: url,
    org: 'acme',
    host: 'file:///unused/',
    scopes: [],
  })
  const second = await addRepository({
    root,
    rnessDir,
    manifest: first.manifest,
    spec: url,
    org: 'acme',
    host: 'file:///unused/',
    scopes: [],
  })
  assert.equal(second.action, 'adopted')
  await assert.rejects(
    addRepository({
      root,
      rnessDir,
      manifest: second.manifest,
      spec: `${other.replace(/other\.git$/, 'api.git')}`,
      org: 'acme',
      host: 'file:///unused/',
      scopes: [],
    }),
    /org\/api is a clone of .*api\.git, not /
  )
  await mkdir(join(root, 'org', 'plain'))
  await assert.rejects(
    addRepository({
      root,
      rnessDir,
      manifest: second.manifest,
      spec: 'file:///tmp/nowhere/plain.git',
      org: 'acme',
      host: 'file:///unused/',
      scopes: [],
    }),
    /org\/plain exists and is not a git clone/
  )
  assert.deepEqual(
    repositories(await loadManifest(rnessDir)).map((r) => r.name),
    ['api'],
    'failures write nothing'
  )
})

test('adopts a clone whose origin differs only by transport or case; the URL chosen is the one declared', async (t) => {
  const url = await makeBareRepo(t, 'api')
  const { root, rnessDir, manifest } = await ws(t)
  const dir = join(root, 'org', 'api')
  await git(['clone', '-q', url, dir], root)
  // Adopting reads the origin and never fetches: a GitHub URL is enough.
  await git(['remote', 'set-url', 'origin', 'https://github.com/Acme/API'], dir)
  const adopted = await addRepository({
    root,
    rnessDir,
    manifest,
    spec: 'api',
    org: 'acme',
    host: 'git@github.com:',
    scopes: [],
  })
  assert.equal(adopted.action, 'adopted')
  assert.deepEqual(repositories(await loadManifest(rnessDir)), [
    { name: 'api', url: 'git@github.com:acme/api.git', dir: 'org/api' },
  ])
  // Another repository is still another repository.
  await assert.rejects(
    addRepository({
      root,
      rnessDir,
      manifest: adopted.manifest,
      spec: 'other/api',
      org: 'acme',
      host: 'git@github.com:',
      scopes: [],
    }),
    /^Error: org\/api is a clone of https:\/\/github\.com\/Acme\/API, not git@github\.com:other\/api\.git$/
  )
})

test('a clone whose directory differs from its key only by case is renamed to the key', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const url = await remote.addRepo('dApp', { 'apps/Web/README.md': '# web\n' })
  const { root, rnessDir, manifest } = await ws(t)
  await git(['clone', '-q', url, join(root, 'org', 'dApp')], root)
  const result = await addRepository({
    root,
    rnessDir,
    manifest,
    spec: 'dapp',
    org: 'acme',
    host: remote.host,
    scopes: ['apps/Web'],
  })
  assert.equal(result.action, 'adopted')
  assert.equal(result.renamed, 'dApp')
  // readdir, not exists(): on macOS exists('org/dapp') is true for org/dApp,
  // and a teammate on Linux would have no org/dapp.
  assert.deepEqual(await readdir(join(root, 'org')), ['dapp'])
  assert.equal(await originUrl(join(root, 'org', 'dapp')), url)
  const written = await loadManifest(rnessDir)
  // A sub-scope's key is lowercase too; its path is the directory as it is.
  assert.deepEqual(written.scopes, {
    dapp: {
      path: 'org/dapp',
      url: `${remote.host}acme/dapp.git`,
      parent: null,
      extends: [],
    },
    web: {
      path: 'org/dapp/apps/Web',
      url: null,
      parent: 'dapp',
      extends: ['dapp'],
    },
  })
})

test('a case variant cloned from another repository is refused and left as it is', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const other = await remote.addRepo('other', { 'README.md': '# other\n' })
  await remote.addRepo('dApp', { 'README.md': '# dApp\n' })
  const { root, rnessDir, manifest } = await ws(t)
  await git(['clone', '-q', other, join(root, 'org', 'dApp')], root)
  await assert.rejects(
    addRepository({
      root,
      rnessDir,
      manifest,
      spec: 'dApp',
      org: 'acme',
      host: remote.host,
      scopes: [],
    }),
    /^Error: org\/dApp is a clone of .*\/acme\/other\.git, not .*\/acme\/dApp\.git$/
  )
  assert.deepEqual(await readdir(join(root, 'org')), ['dApp'])
  assert.deepEqual(repositories(await loadManifest(rnessDir)), [])
})

test('a scope path that differs from the clone only by case is repaired, not a collision', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const url = await remote.addRepo('dApp', { 'README.md': '# dApp\n' })
  const { root, rnessDir, manifest } = await ws(t)
  await git(['clone', '-q', url, join(root, 'org', 'dApp')], root)
  // Contract 2 computes a repository's path: only a manifest built in
  // memory can hold this one.
  const stale = {
    ...manifest,
    scopes: { dapp: { path: 'org/dApp', url, parent: null, extends: [] } },
  }
  const result = await addRepository({
    root,
    rnessDir,
    manifest: stale,
    spec: 'dApp',
    org: 'acme',
    host: remote.host,
    scopes: [],
  })
  assert.deepEqual(result.manifest.scopes, {
    dapp: { path: 'org/dapp', url: result.url, parent: null, extends: [] },
  })
  assert.deepEqual(await readdir(join(root, 'org')), ['dapp'])
})

test('two directories that differ from the key only by case are refused (Linux)', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const url = await remote.addRepo('dApp', { 'README.md': '# dApp\n' })
  const { root, rnessDir, manifest } = await ws(t)
  if (await ignoresCase(join(root, 'org'))) {
    t.skip(
      'this file system ignores case: org/dApp and org/DAPP cannot coexist'
    )
    return
  }
  await git(['clone', '-q', url, join(root, 'org', 'dApp')], root)
  await git(['clone', '-q', url, join(root, 'org', 'DAPP')], root)
  await assert.rejects(
    addRepository({
      root,
      rnessDir,
      manifest,
      spec: 'dapp',
      org: 'acme',
      host: remote.host,
      scopes: [],
    }),
    /^Error: org\/DAPP and org\/dApp both differ from org\/dapp only by case: keep one, then run rness add again$/
  )
  assert.deepEqual((await readdir(join(root, 'org'))).sort(), ['DAPP', 'dApp'])
  // The exact name wins over a variant: org/dapp is adopted, org/dApp left.
  await rm(join(root, 'org', 'DAPP'), { recursive: true })
  await git(['clone', '-q', url, join(root, 'org', 'dapp')], root)
  const result = await addRepository({
    root,
    rnessDir,
    manifest,
    spec: 'dapp',
    org: 'acme',
    host: remote.host,
    scopes: [],
  })
  assert.equal(result.renamed, null)
  assert.deepEqual((await readdir(join(root, 'org'))).sort(), ['dApp', 'dapp'])
})

test('a malformed sub-scope is rejected before cloning: no partial clone is left behind', async (t) => {
  const url = await makeBareRepo(t, 'bad')
  const { root, rnessDir, manifest } = await ws(t)
  await assert.rejects(
    addRepository({
      root,
      rnessDir,
      manifest,
      spec: url,
      org: 'acme',
      host: 'file:///unused/',
      scopes: ['apps/Bad Name'],
    }),
    /the last segment of sub-scope "apps\/Bad Name" may only contain lowercase letters/
  )
  assert.equal(await exists(join(root, 'org', 'bad')), false)
  await assert.rejects(
    addRepository({
      root,
      rnessDir,
      manifest,
      spec: url,
      org: 'acme',
      host: 'file:///unused/',
      scopes: ['../outside'],
    }),
    /must be a relative path/
  )
  assert.equal(await exists(join(root, 'org', 'bad')), false)
})

test('a fresh clone is removed when a sub-scope directory does not exist', async (t) => {
  const url = await makeBareRepo(t, 'fresh')
  const { root, rnessDir, manifest } = await ws(t)
  await assert.rejects(
    addRepository({
      root,
      rnessDir,
      manifest,
      spec: url,
      org: 'acme',
      host: 'file:///unused/',
      scopes: ['apps/missing'],
    }),
    /org\/fresh\/apps\/missing does not exist/
  )
  assert.equal(
    await exists(join(root, 'org', 'fresh')),
    false,
    'the clone this call made is rolled back'
  )
  assert.deepEqual(
    repositories(await loadManifest(rnessDir)),
    [],
    'the manifest still has no repository'
  )
})

test('declares sub-scopes that extend the repository scope; missing dirs and collisions are errors', async (t) => {
  const url = await makeBareRepo(t, 'platform')
  const { root, rnessDir, manifest } = await ws(t)
  const cloned = await addRepository({
    root,
    rnessDir,
    manifest,
    spec: url,
    org: 'acme',
    host: 'file:///unused/',
    scopes: [],
  })
  await mkdir(join(root, 'org', 'platform', 'apps', 'web'), { recursive: true })
  await mkdir(join(root, 'org', 'platform', 'packages', 'ui'), {
    recursive: true,
  })
  const withSubs = await addRepository({
    root,
    rnessDir,
    manifest: cloned.manifest,
    spec: url,
    org: 'acme',
    host: 'file:///unused/',
    scopes: ['apps/web', 'packages/ui'],
  })
  assert.deepEqual(withSubs.declared, ['platform', 'web', 'ui'])
  assert.deepEqual(withSubs.manifest.scopes['web'], {
    path: 'org/platform/apps/web',
    url: null,
    parent: 'platform',
    extends: ['platform'],
  })
  await assert.rejects(
    addRepository({
      root,
      rnessDir,
      manifest: withSubs.manifest,
      spec: url,
      org: 'acme',
      host: 'file:///unused/',
      scopes: ['apps/missing'],
    }),
    /org\/platform\/apps\/missing does not exist/
  )
  assert.equal(
    await exists(join(root, 'org', 'platform')),
    true,
    'a missing sub-scope on an adopted repository leaves the adopted clone in place'
  )
  await mkdir(join(root, 'org', 'platform', 'tools', 'web'), {
    recursive: true,
  })
  await assert.rejects(
    addRepository({
      root,
      rnessDir,
      manifest: withSubs.manifest,
      spec: url,
      org: 'acme',
      host: 'file:///unused/',
      scopes: ['tools/web'],
    }),
    /scope "web" is already declared under platform/
  )
})

test('re-adding a repository keeps a part nested deeper where it is: its parent and its extends', async (t) => {
  const url = await makeBareRepo(t, 'app')
  const { root, rnessDir, manifest } = await ws(t)
  await addRepository({
    root,
    rnessDir,
    manifest,
    spec: url,
    org: 'acme',
    host: 'file:///unused/',
    scopes: [],
  })
  // A part of a part, as a maintainer would nest it by hand, extending
  // another repository.
  await writeFile(
    join(rnessDir, 'rness.json'),
    JSON.stringify({
      contract: 2,
      org: 'acme',
      scopes: {
        shared: { url: 'https://github.com/acme/shared.git' },
        app: {
          url,
          scopes: {
            platform: {
              path: 'platform',
              scopes: { web: { path: 'web', extends: ['shared'] } },
            },
          },
        },
      },
    })
  )
  const nested = await loadManifest(rnessDir)
  await writeManifest(rnessDir, nested)
  const before = await readFile(join(rnessDir, 'rness.json'), 'utf8')
  assert.match(before, /"web": \{ "path": "web", "extends": \["shared"\] \}/)
  await mkdir(join(root, 'org', 'app', 'platform', 'web'), { recursive: true })

  const readded = await addRepository({
    root,
    rnessDir,
    manifest: nested,
    spec: url,
    org: 'acme',
    host: 'file:///unused/',
    scopes: ['platform/web'],
  })
  assert.equal(readded.action, 'adopted')
  assert.deepEqual(readded.declared, ['app', 'web'])
  assert.deepEqual(readded.manifest.scopes['web'], {
    path: 'org/app/platform/web',
    url: null,
    parent: 'platform',
    extends: ['platform', 'shared'],
  })
  assert.equal(
    await readFile(join(rnessDir, 'rness.json'), 'utf8'),
    before,
    'the file is unchanged: web stays under platform, its extends as written'
  )
})

test('refuses a repository scope already pointing elsewhere, and keeps a hand-added extends', async (t) => {
  const url = await makeBareRepo(t, 'api')
  const taken = await makeWorkspace(t, {
    org: 'acme',
    dirs: ['org'],
    scopes: {
      other: {
        url: 'https://github.com/acme/other.git',
        scopes: { api: { path: 'apps/api' } },
      },
    },
  })
  await assert.rejects(
    addRepository({
      root: taken,
      rnessDir: join(taken, '.rness'),
      manifest: await loadManifest(join(taken, '.rness')),
      spec: url,
      org: 'acme',
      host: 'file:///unused/',
      scopes: [],
    }),
    /scope "api" is already declared under other/
  )
  assert.equal(
    await exists(join(taken, 'org', 'api')),
    false,
    'the collision is caught before anything is cloned'
  )

  const { root, rnessDir, manifest } = await ws(t)
  const cloned = await addRepository({
    root,
    rnessDir,
    manifest,
    spec: url,
    org: 'acme',
    host: 'file:///unused/',
    scopes: [],
  })
  // What a maintainer would hand-edit into rness.json: the repository scope
  // extends a shared parent scope.
  const edited = {
    ...cloned.manifest,
    scopes: {
      shared: {
        path: 'org/shared',
        url: 'https://github.com/acme/shared.git',
        parent: null,
        extends: [],
      },
      api: { path: 'org/api', url, parent: null, extends: ['shared'] },
    },
  }
  const adopted = await addRepository({
    root,
    rnessDir,
    manifest: edited,
    spec: url,
    org: 'acme',
    host: 'file:///unused/',
    scopes: [],
  })
  assert.equal(adopted.action, 'adopted')
  assert.deepEqual(adopted.manifest.scopes['api'], {
    path: 'org/api',
    url,
    parent: null,
    extends: ['shared'],
  })
  assert.deepEqual((await loadManifest(rnessDir)).scopes['api'], {
    path: 'org/api',
    url,
    parent: null,
    extends: ['shared'],
  })
})

test('a repository named constructor, a sub-scope named constructor: names like any other, never an object built-in', async (t) => {
  const url = await makeBareRepo(t, 'constructor')
  const first = await ws(t)
  const added = await addRepository({
    ...first,
    spec: url,
    org: 'acme',
    host: 'file:///unused/',
    scopes: [],
  })
  assert.deepEqual(added.declared, ['constructor'])
  assert.deepEqual(
    repositories(await loadManifest(first.rnessDir)).map((r) => r.name),
    ['constructor']
  )

  const platform = await makeBareRepo(t, 'platform')
  const second = await ws(t)
  const cloned = await addRepository({
    ...second,
    spec: platform,
    org: 'acme',
    host: 'file:///unused/',
    scopes: [],
  })
  await mkdir(join(second.root, 'org', 'platform', 'apps', 'constructor'), {
    recursive: true,
  })
  const withSub = await addRepository({
    ...second,
    manifest: cloned.manifest,
    spec: platform,
    org: 'acme',
    host: 'file:///unused/',
    scopes: ['apps/constructor'],
  })
  assert.deepEqual(withSub.declared, ['platform', 'constructor'])
  assert.deepEqual(
    (await loadManifest(second.rnessDir)).scopes['constructor'],
    {
      path: 'org/platform/apps/constructor',
      url: null,
      parent: 'platform',
      extends: ['platform'],
    }
  )
})

test('cloneHolding: the repository whose clone holds a directory, a part of it included; none elsewhere', async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    scopes: {
      app: { url: 'git@github.com:acme/app.git' },
      platform: {
        url: 'https://github.com/acme/platform.git',
        scopes: { web: { path: 'apps/web' } },
      },
    },
  })
  const repos = repositories(await loadManifest(join(root, '.rness')))
  const platform = {
    name: 'platform',
    dir: join(root, 'org', 'platform'),
    url: 'https://github.com/acme/platform.git',
  }
  assert.deepEqual(
    cloneHolding(root, repos, join(root, 'org', 'platform', 'apps', 'web')),
    platform
  )
  assert.deepEqual(
    cloneHolding(root, repos, join(root, 'org', 'platform')),
    platform
  )
  assert.equal(
    cloneHolding(root, repos, join(root, 'org', 'app', 'src'))?.name,
    'app'
  )
  for (const dir of [root, join(root, '.rness'), join(root, 'org', 'other')])
    assert.equal(cloneHolding(root, repos, dir), null, dir)
})

test('workspaceDirs lists the package directories declared in package.json#workspaces', async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    dirs: [
      'org/mono/apps/web',
      'org/mono/packages/ui',
      'org/mono/packages/empty',
    ],
  })
  const mono = join(root, 'org', 'mono')
  await writeFile(
    join(mono, 'package.json'),
    JSON.stringify({ name: 'mono', workspaces: ['apps/*', 'packages/*'] })
  )
  await writeFile(join(mono, 'apps', 'web', 'package.json'), '{"name":"web"}')
  await writeFile(join(mono, 'packages', 'ui', 'package.json'), '{"name":"ui"}')
  assert.deepEqual(await workspaceDirs(mono), ['apps/web', 'packages/ui'])
  assert.deepEqual(await workspaceDirs(join(root, 'org')), [])
})

test('re-adding a repository and a part keeps their declared skills', async (t) => {
  const url = await makeBareRepo(t, 'app')
  const { root, rnessDir, manifest } = await ws(t)
  await addRepository({
    root,
    rnessDir,
    manifest,
    spec: url,
    org: 'acme',
    host: 'file:///unused/',
    scopes: [],
  })
  const tree = '017c56061194a965f77e1b265569ad105348c8b2'
  const skill = (name: string) => ({
    [name]: { source: 'github:o/r', tree },
  })
  await writeFile(
    join(rnessDir, 'rness.json'),
    JSON.stringify({
      contract: 2,
      org: 'acme',
      scopes: {
        app: {
          url,
          skills: skill('deploy'),
          scopes: { web: { path: 'web', skills: skill('tokens') } },
        },
      },
    })
  )
  const declared = await loadManifest(rnessDir)
  await mkdir(join(root, 'org', 'app', 'web'), { recursive: true })
  const readded = await addRepository({
    root,
    rnessDir,
    manifest: declared,
    spec: url,
    org: 'acme',
    host: 'file:///unused/',
    scopes: ['web'],
  })
  assert.deepEqual(readded.manifest.scopes['app']?.skills, skill('deploy'))
  assert.deepEqual(readded.manifest.scopes['web']?.skills, skill('tokens'))
  const written = await loadManifest(rnessDir)
  assert.deepEqual(written.scopes['app']?.skills, skill('deploy'))
  assert.deepEqual(written.scopes['web']?.skills, skill('tokens'))
})
