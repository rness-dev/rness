import assert from 'node:assert/strict'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { run } from '../../src/cli.ts'
import { type AddOptions, addCommand } from '../../src/commands/add.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import type { Prompts, Terminal } from '../../src/core/terminal.ts'
import {
  type Transport,
  httpsFlagLine,
  sshWorkspaceLines,
} from '../../src/core/transport.ts'
import { capture } from '../helpers/capture.ts'
import { makeBareRepo } from '../helpers/git.ts'
import { makeRemoteOrg } from '../helpers/remote-org.ts'
import { SSH_DENIED, SSH_OK, fakeTransport } from '../helpers/transport.ts'
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

test("add's sync clones nothing else from the catalogue", async (t) => {
  const webUrl = await makeBareRepo(t, 'web')
  const apiUrl = await makeBareRepo(t, 'api')
  const root = await makeWorkspace(t, {
    org: 'acme',
    repos: { web: { url: webUrl } },
    scopes: { web: { path: 'org/web' } },
    dirs: ['org'],
  })
  const r = await add(['--yes', '--cwd', root, apiUrl])
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^cloned {3}org\/api\ndeclared scope api \(org\/api\)\nnot cloned: web \(rness add <name>, or rness sync --all\)\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n$/
  )
  await assert.rejects(access(join(root, 'org', 'web')))
  assert.deepEqual(
    Object.keys((await loadManifest(join(root, '.rness'))).repos),
    ['web', 'api']
  )
})

// --- SSH first (spec 0005) ---------------------------------------------------

const CANCEL = Symbol('cancel')
const NO_TTY: Terminal = {
  isTty: () => false,
  prompts: async () => {
    throw new Error('no prompt without a terminal')
  },
}

/** A terminal answering every confirm from `answers`, in order. */
function confirming(answers: unknown[]) {
  const asked: string[] = []
  const prompts = {
    async confirm(o: { message: string }) {
      asked.push(o.message)
      if (answers.length === 0) throw new Error(`unexpected: ${o.message}`)
      return answers.shift()
    },
    async multiselect() {
      throw new Error('unexpected multiselect')
    },
    isCancel: (v: unknown) => v === CANCEL,
  } as unknown as Prompts
  const terminal: Terminal = { isTty: () => true, prompts: async () => prompts }
  return { asked, terminal }
}

async function addWith(
  spec: string,
  opts: AddOptions,
  terminal: Terminal,
  transport: Transport
) {
  const c = capture()
  try {
    const code = await addCommand(spec, opts, terminal, transport)
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

const DENIED_LINES = sshWorkspaceLines(SSH_DENIED.ok ? '' : SSH_DENIED.reason)

test('add <repo> writes the SSH URL when the SSH test passes', async (t) => {
  const ok = await fakeTransport(t, 'acme', SSH_OK)
  await ok.ssh.addRepo('api', { 'README.md': '# api\n' })
  const root = await makeWorkspace(t, { org: 'acme', dirs: ['org'] })
  const r = await addWith('api', { yes: true, cwd: root }, NO_TTY, ok.transport)
  assert.equal(r.code, 0, r.err)
  assert.ok(
    r.out.startsWith('using    ssh (github.com as octo)\ncloned   org/api\n'),
    r.out
  )
  assert.deepEqual(ok.calls, [{ interactive: false }])
  assert.deepEqual((await loadManifest(join(root, '.rness'))).repos, {
    api: { url: `${ok.ssh.host}acme/api.git` },
  })
})

test('without SSH access, a workspace that does not clone over SSH falls back to HTTPS', async (t) => {
  const denied = await fakeTransport(t, 'acme', SSH_DENIED)
  await denied.https.addRepo('api', { 'README.md': '# api\n' })
  const webUrl = await denied.https.addRepo('web', { 'README.md': '# web\n' })
  const root = await makeWorkspace(t, {
    org: 'acme',
    repos: { web: { url: webUrl } },
    scopes: { web: { path: 'org/web' } },
    dirs: ['org'],
  })
  const r = await addWith(
    'api',
    { yes: true, cwd: root },
    NO_TTY,
    denied.transport
  )
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^using {4}https \(ssh to github\.com unavailable: /)
  assert.equal(
    (await loadManifest(join(root, '.rness'))).repos['api']?.url,
    `${denied.https.host}acme/api.git`
  )
})

test('an SSH workspace does not fall back silently: a message, then --https or the question', async (t) => {
  const denied = await fakeTransport(t, 'acme', SSH_DENIED)
  await denied.https.addRepo('api', { 'README.md': '# api\n' })
  const workspace = () =>
    makeWorkspace(t, {
      org: 'acme',
      repos: { web: { url: `${denied.ssh.host}acme/web.git` } },
      scopes: { web: { path: 'org/web' } },
      dirs: ['org'],
    })
  const untouched = async (root: string): Promise<void> => {
    assert.deepEqual(
      Object.keys((await loadManifest(join(root, '.rness'))).repos),
      ['web']
    )
    await assert.rejects(access(join(root, 'org', 'api')))
  }

  // Without a terminal: the three lines, exit 1.
  const root = await workspace()
  const r = await addWith(
    'api',
    { yes: true, cwd: root },
    NO_TTY,
    denied.transport
  )
  assert.equal(r.code, 1)
  assert.equal(r.err, `${[...DENIED_LINES, httpsFlagLine('api')].join('\n')}\n`)
  assert.equal(r.out, '')
  await untouched(root)

  // In a terminal: the two lines, then the question. No, and a cancel, stop.
  for (const answer of [false, CANCEL]) {
    const root2 = await workspace()
    const term = confirming([answer])
    const r2 = await addWith(
      'api',
      { cwd: root2 },
      term.terminal,
      denied.transport
    )
    assert.equal(r2.code, 1)
    assert.equal(r2.err, `${DENIED_LINES.join('\n')}\n`)
    assert.deepEqual(term.asked, ['Clone api over HTTPS instead?'])
    await untouched(root2)
  }

  // Yes continues as --https would.
  const root3 = await workspace()
  const yes = confirming([true, true])
  const r3 = await addWith(
    'api',
    { cwd: root3 },
    yes.terminal,
    denied.transport
  )
  assert.equal(r3.code, 0, r3.err)
  assert.equal(yes.asked[0], 'Clone api over HTTPS instead?')
  assert.match(yes.asked[1] ?? '', /^clone .*acme\/api\.git into org\/api/)
  assert.equal(
    (await loadManifest(join(root3, '.rness'))).repos['api']?.url,
    `${denied.https.host}acme/api.git`
  )

  // --https asks nothing and never runs the test.
  denied.calls.length = 0
  const root4 = await workspace()
  const r4 = await addWith(
    'api',
    { yes: true, https: true, cwd: root4 },
    NO_TTY,
    denied.transport
  )
  assert.equal(r4.code, 0, r4.err)
  assert.deepEqual(denied.calls, [])
  assert.equal(
    (await loadManifest(join(root4, '.rness'))).repos['api']?.url,
    `${denied.https.host}acme/api.git`
  )
})

test('a full URL, --host and a bad name never run the SSH test; --ssh and --https exclude each other', async (t) => {
  const ok = await fakeTransport(t, 'acme', SSH_OK)
  const url = await makeBareRepo(t, 'api')
  const root = await makeWorkspace(t, { org: 'acme', dirs: ['org'] })
  const full = await addWith(
    url,
    { yes: true, cwd: root },
    NO_TTY,
    ok.transport
  )
  assert.equal(full.code, 0, full.err)

  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('web', { 'README.md': '# web\n' })
  const hosted = await addWith(
    'web',
    { yes: true, host: remote.host, cwd: root },
    NO_TTY,
    ok.transport
  )
  assert.equal(hosted.code, 0, hosted.err)

  const bad = await addWith(
    'Bad_Name',
    { yes: true, cwd: root },
    NO_TTY,
    ok.transport
  )
  assert.equal(bad.code, 2)
  assert.deepEqual(ok.calls, [])

  const both = await addWith(
    'api',
    { yes: true, ssh: true, https: true, cwd: root },
    NO_TTY,
    ok.transport
  )
  assert.equal(both.code, 2)
  assert.equal(both.err, '--ssh and --https cannot be combined\n')
})
