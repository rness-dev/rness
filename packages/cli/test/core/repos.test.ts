import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { exists } from '../../src/core/fs.ts'
import { originUrl } from '../../src/core/git.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { addRepository, workspaceDirs } from '../../src/core/repos.ts'
import { makeBareRepo } from '../helpers/git.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

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
  assert.deepEqual(written.repos, { api: { url } })
  assert.deepEqual(written.scopes, { api: { path: 'org/api', extends: [] } })
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
    Object.keys((await loadManifest(rnessDir)).repos),
    ['api'],
    'failures write nothing'
  )
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
      scopes: ['apps/Bad_Name'],
    }),
    /needs a \[a-z0-9-\] last segment/
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
    Object.keys((await loadManifest(rnessDir)).repos),
    [],
    'the manifest still has no repos entry'
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
    /scope "web" already points at org\/platform\/apps\/web/
  )
})

test('refuses a repository scope already pointing elsewhere, and keeps a hand-added extends', async (t) => {
  const url = await makeBareRepo(t, 'api')
  const taken = await makeWorkspace(t, {
    org: 'acme',
    dirs: ['org'],
    scopes: {
      other: { path: 'org/other' },
      api: { path: 'org/other/apps/api', extends: ['other'] },
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
    /scope "api" already points at org\/other\/apps\/api/
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
      shared: { path: '.rness/shared', extends: [] },
      api: { path: 'org/api', extends: ['shared'] },
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
    extends: ['shared'],
  })
  assert.deepEqual((await loadManifest(rnessDir)).scopes['api'], {
    path: 'org/api',
    extends: ['shared'],
  })
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
