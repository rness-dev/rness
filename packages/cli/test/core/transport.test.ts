import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { HOSTS } from '../../src/core/hosts.ts'
import {
  CHECKING,
  GITHUB_HOSTS,
  INSTEAD_OF_LINES,
  checking,
  detectGithubSsh,
  detectSsh,
  httpsFlagLine,
  insteadOfLines,
  isSshUrl,
  parseSshGreeting,
  sshWorkspaceLines,
  transportFor,
  usingLine,
  usingSentence,
} from '../../src/core/transport.ts'

const GREETING =
  "Hi octo! You've successfully authenticated, but GitHub does not provide shell access."

/**
 * An executable standing in for `ssh`: it records its arguments next to
 * itself, then runs `body` (JavaScript). Called by path, never through PATH.
 */
async function fakeSsh(
  t: TestContext,
  body: string
): Promise<{ command: string; argv: () => Promise<string[]> }> {
  const dir = await mkdtemp(join(tmpdir(), 'rness-ssh-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const command = join(dir, 'ssh')
  const log = join(dir, 'argv.json')
  await writeFile(
    command,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))\n${body}\n`
  )
  await chmod(command, 0o755)
  return {
    command,
    argv: async () => JSON.parse(await readFile(log, 'utf8')) as string[],
  }
}

test("GitHub's greeting is SSH access, whatever the exit code; the login is kept", async (t) => {
  const ssh = await fakeSsh(
    t,
    `process.stderr.write(${JSON.stringify(`${GREETING}\n`)}); process.exit(1)`
  )
  assert.deepEqual(
    await detectGithubSsh({ interactive: false, command: ssh.command }),
    { ok: true, login: 'octo' }
  )
})

test('a refused key, a silent failure and a missing ssh are each a reason, never a throw', async (t) => {
  const denied = await fakeSsh(
    t,
    `process.stderr.write('\\ngit@github.com: Permission denied (publickey).\\n'); process.exit(255)`
  )
  assert.deepEqual(
    await detectGithubSsh({ interactive: false, command: denied.command }),
    { ok: false, reason: 'git@github.com: Permission denied (publickey).' }
  )
  const silent = await fakeSsh(t, 'process.exit(255)')
  assert.deepEqual(
    await detectGithubSsh({ interactive: false, command: silent.command }),
    { ok: false, reason: 'ssh exited with code 255' }
  )
  const missing = await detectGithubSsh({
    interactive: false,
    command: join(tmpdir(), 'rness-no-such-ssh'),
  })
  assert.equal(missing.ok, false)
  assert.match(missing.ok ? '' : missing.reason, /ENOENT/)
})

test('a hanging ssh is killed at the deadline', async (t) => {
  const ssh = await fakeSsh(t, 'setTimeout(() => {}, 30_000)')
  const started = Date.now()
  assert.deepEqual(
    await detectGithubSsh({
      interactive: false,
      command: ssh.command,
      timeoutMs: 300,
    }),
    { ok: false, reason: 'timed out after 0.3s' }
  )
  assert.ok(Date.now() - started < 2000)
})

test('BatchMode forbids prompts only without a terminal', async (t) => {
  const ssh = await fakeSsh(t, 'process.exit(255)')
  await detectGithubSsh({ interactive: false, command: ssh.command })
  assert.deepEqual(await ssh.argv(), [
    '-T',
    '-o',
    'ConnectTimeout=5',
    '-o',
    'BatchMode=yes',
    'git@github.com',
  ])
  await detectGithubSsh({ interactive: true, command: ssh.command })
  assert.deepEqual(await ssh.argv(), [
    '-T',
    '-o',
    'ConnectTimeout=5',
    'git@github.com',
  ])
})

test('parseSshGreeting reads the login past ssh warnings', () => {
  assert.equal(
    parseSshGreeting(
      `Warning: Permanently added 'github.com' to the list of known hosts.\nHi octo-cat! You've successfully authenticated, but…\n`
    ),
    'octo-cat'
  )
  assert.equal(parseSshGreeting('Hi there'), null)
  assert.equal(parseSshGreeting(''), null)
})

test('isSshUrl is about the ssh base only', () => {
  assert.equal(isSshUrl('git@github.com:acme/api.git', GITHUB_HOSTS), true)
  assert.equal(isSshUrl('https://github.com/acme/api.git', GITHUB_HOSTS), false)
  assert.equal(isSshUrl('file:///tmp/acme/api.git', GITHUB_HOSTS), false)
  assert.equal(
    isSshUrl('file:///tmp/ssh/acme/api.git', {
      ssh: 'file:///tmp/ssh/',
      https: 'file:///tmp/https/',
    }),
    true
  )
})

test('the lines, verbatim', () => {
  assert.equal(
    usingLine({ ok: true, login: 'octo' }),
    'using    ssh (github.com as octo)'
  )
  assert.equal(
    usingLine({ ok: false, reason: 'Permission denied (publickey).' }),
    'using    https (ssh to github.com unavailable: Permission denied (publickey).)'
  )
  assert.equal(
    usingLine({ ok: false, reason: 'Permission denied.' }, 'octo'),
    'using    https (ssh to github.com unavailable: Permission denied., logged in as octo)'
  )
  assert.equal(
    usingLine({ ok: true, login: 'octo' }, 'octo'),
    'using    ssh (github.com as octo)'
  )
  assert.deepEqual(sshWorkspaceLines('Permission denied (publickey).'), [
    'this workspace clones over SSH (rness.json) but ssh to github.com fails: Permission denied (publickey).',
    'set up an SSH key: https://docs.github.com/authentication/connecting-to-github-with-ssh',
  ])
  assert.deepEqual(INSTEAD_OF_LINES, [
    'or make git use HTTPS for github.com on this machine:',
    '  git config --global url."https://github.com/".insteadOf git@github.com:',
  ])
  assert.equal(
    httpsFlagLine('api'),
    'or clone this repository over HTTPS: rness add api --https'
  )
})

// GitLab (spec 0037 §5.2), as plan 0049 task 1 saw gitlab.com answer: the
// greeting on stdout, exit 0 (GitHub: stderr, exit 1).
test("GitLab's greeting is SSH access; each host reads its own greeting only", async (t) => {
  const welcome = 'Welcome to GitLab, @cedricmagne!\n'
  assert.equal(parseSshGreeting(welcome, HOSTS.gitlab), 'cedricmagne')
  assert.equal(parseSshGreeting(welcome), null)
  assert.equal(parseSshGreeting(`${GREETING}\n`, HOSTS.gitlab), null)

  const ssh = await fakeSsh(
    t,
    `process.stdout.write(${JSON.stringify(welcome)}); process.exit(0)`
  )
  assert.deepEqual(
    await detectSsh(HOSTS.gitlab, {
      interactive: false,
      command: ssh.command,
    }),
    { ok: true, login: 'cedricmagne' }
  )
  assert.deepEqual(await ssh.argv(), [
    '-T',
    '-o',
    'ConnectTimeout=5',
    '-o',
    'BatchMode=yes',
    'git@gitlab.com',
  ])

  const unknownHost = await fakeSsh(
    t,
    `process.stderr.write('Host key verification failed.\\n'); process.exit(255)`
  )
  assert.deepEqual(
    await detectSsh(HOSTS.gitlab, {
      interactive: false,
      command: unknownHost.command,
    }),
    { ok: false, reason: 'Host key verification failed.' }
  )
})

test('a transport for GitLab: its bases, and the lines name gitlab.com', () => {
  assert.deepEqual(transportFor(HOSTS.gitlab).hosts, {
    ssh: 'git@gitlab.com:',
    https: 'https://gitlab.com/',
  })
  assert.deepEqual(transportFor(HOSTS.github).hosts, GITHUB_HOSTS)
  assert.equal(
    usingLine({ ok: true, login: 'cedricmagne' }, null, HOSTS.gitlab),
    'using    ssh (gitlab.com as cedricmagne)'
  )
  assert.equal(
    usingLine(
      { ok: false, reason: 'Permission denied (publickey).' },
      'cedricmagne',
      HOSTS.gitlab
    ),
    'using    https (ssh to gitlab.com unavailable: Permission denied (publickey)., logged in as cedricmagne)'
  )
  assert.equal(
    usingSentence({ ok: true, login: 'cedricmagne' }, null, HOSTS.gitlab),
    'SSH works for gitlab.com (as cedricmagne): repositories are cloned over SSH'
  )
  assert.deepEqual(
    sshWorkspaceLines('Permission denied (publickey).', HOSTS.gitlab),
    [
      'this workspace clones over SSH (rness.json) but ssh to gitlab.com fails: Permission denied (publickey).',
      'set up an SSH key: https://docs.gitlab.com/user/ssh/',
    ]
  )
  assert.deepEqual(insteadOfLines(HOSTS.gitlab), [
    'or make git use HTTPS for gitlab.com on this machine:',
    '  git config --global url."https://gitlab.com/".insteadOf git@gitlab.com:',
  ])
  assert.deepEqual(checking(HOSTS.gitlab), [
    'checking',
    'ssh access to gitlab.com…',
    'Checking SSH access to gitlab.com: ssh may ask for your passphrase',
  ])
  assert.deepEqual(checking(HOSTS.github), CHECKING)
  assert.deepEqual(insteadOfLines(HOSTS.github), INSTEAD_OF_LINES)
})
