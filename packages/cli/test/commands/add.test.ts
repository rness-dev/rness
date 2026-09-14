import assert from 'node:assert/strict'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { run } from '../../src/cli.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { capture } from '../helpers/capture.ts'
import { makeBareRepo } from '../helpers/git.ts'
import { makeRemoteOrg } from '../helpers/remote-org.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

process.env['GIT_AUTHOR_NAME'] = 'rness-test'
process.env['GIT_AUTHOR_EMAIL'] = 'test@rness.invalid'
process.env['GIT_COMMITTER_NAME'] = 'rness-test'
process.env['GIT_COMMITTER_EMAIL'] = 'test@rness.invalid'

async function add(args: string[]) {
  const c = capture()
  const code = await run(['add', ...args])
  c.restore()
  return { code, out: c.out(), err: c.err() }
}

test('add <url> clones, declares, and syncs the new scope and the root', async (t) => {
  const url = await makeBareRepo(t, 'api')
  const root = await makeWorkspace(t, {
    org: 'acme',
    dirs: ['org'],
    files: { 'standards/coding.md': '# Coding\n' },
  })
  const r = await add(['--yes', '--cwd', root, url])
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^cloned {3}org\/api\ndeclared scope api \(org\/api\)\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n$/
  )
  await access(join(root, 'org', 'api', 'CLAUDE.md'))
  const m = await loadManifest(join(root, '.rness'))
  assert.deepEqual(m.repos, { api: { url } })
})

test('add <repo> expands with the org and --host; --scopes declares sub-scopes', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('platform', { 'README.md': '# platform\n' })
  const root = await makeWorkspace(t, { org: 'acme', dirs: ['org'] })
  const r = await add([
    '--yes',
    '--cwd',
    root,
    '--host',
    remote.host,
    'platform',
  ])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual((await loadManifest(join(root, '.rness'))).repos, {
    platform: { url: `${remote.host}acme/platform.git` },
  })
  await mkdir(join(root, 'org', 'platform', 'apps', 'web'), {
    recursive: true,
  })
  const subs = await add([
    '--yes',
    '--cwd',
    root,
    '--host',
    remote.host,
    '--scopes',
    'apps/web',
    'platform',
  ])
  assert.equal(subs.code, 0, subs.err)
  assert.match(
    subs.out,
    /^adopted {2}org\/platform\ndeclared scope platform \(org\/platform\)\ndeclared scope web \(org\/platform\/apps\/web, extends platform\)\n/
  )
  const m = await loadManifest(join(root, '.rness'))
  assert.deepEqual(m.scopes['web'], {
    path: 'org/platform/apps/web',
    extends: ['platform'],
  })
  await access(join(root, 'org', 'platform', 'apps', 'web', 'AGENTS.md'))
})

test('refuses without a TTY and --yes, outside a workspace, and on a bad name', async (t) => {
  const url = await makeBareRepo(t, 'api')
  const root = await makeWorkspace(t, { org: 'acme', dirs: ['org'] })
  const refused = await add(['--cwd', root, url])
  assert.equal(refused.code, 2)
  assert.match(refused.err, /pass --yes/)
  assert.deepEqual((await loadManifest(join(root, '.rness'))).repos, {})
  const outside = await add(['--yes', '--cwd', '/', url])
  assert.equal(outside.code, 1)
  assert.match(outside.err, /no rness workspace/)
  const bad = await add(['--yes', '--cwd', root, 'Bad_Name'])
  assert.equal(bad.code, 2)
  assert.match(bad.err, /repository name "Bad_Name"/)
})

test('a clone failure leaves the manifest untouched and exits 1', async (t) => {
  const root = await makeWorkspace(t, { org: 'acme', dirs: ['org'] })
  const r = await add(['--yes', '--cwd', root, 'file:///no/such/ghost.git'])
  assert.equal(r.code, 1)
  assert.match(r.err, /git clone failed/)
  assert.deepEqual((await loadManifest(join(root, '.rness'))).repos, {})
})
