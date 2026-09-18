import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import {
  GITHUB_HOSTS,
  INSTEAD_OF_LINES,
  detectGithubSsh,
  httpsFlagLine,
  isSshUrl,
  parseSshGreeting,
  sshWorkspaceLines,
  usingLine,
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
