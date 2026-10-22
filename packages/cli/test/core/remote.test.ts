import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DEFAULT_HOST,
  SSH_HOST,
  classifyProbe,
  currentSshUrl,
  probeRemote,
  repoUrl,
  sameRemote,
} from '../../src/core/remote.ts'
import { makeBareRepo } from '../helpers/git.ts'

test('repoUrl joins host, org and repo for https, ssh and file hosts', () => {
  assert.equal(
    repoUrl(DEFAULT_HOST, 'acme', 'web'),
    'https://github.com/acme/web.git'
  )
  assert.equal(repoUrl(SSH_HOST, 'acme', 'web'), 'git@github.com:acme/web.git')
  assert.equal(
    repoUrl('file:///tmp/gh/', 'acme', '.rness'),
    'file:///tmp/gh/acme/.rness.git'
  )
})

test('sameRemote: one repository whatever the transport, the case, a user or a trailing .git', () => {
  const ssh = 'git@github.com:acme/dApp.git'
  for (const other of [
    'git@github.com:acme/dapp.git',
    'https://github.com/acme/dapp.git',
    'https://github.com/Acme/DAPP',
    'https://x-access-token:secret@github.com/acme/dApp.git',
    'ssh://git@github.com/acme/dApp.git',
    'ssh://git@github.com:22/acme/dApp.git',
    'https://github.com/acme/dApp/',
    'https://github.com/acme/dApp.git/',
  ])
    assert.equal(sameRemote(ssh, other), true, other)
  for (const other of [
    'git@github.com:other/dApp.git',
    'git@github.com:acme/dApp2.git',
    'git@gitlab.com:acme/dApp.git',
    'https://github.com/acme/team/dApp.git',
  ])
    assert.equal(sameRemote(ssh, other), false, other)
  // A local remote is its path.
  assert.equal(
    sameRemote('file:///tmp/gh/acme/dApp.git', 'file:///tmp/gh/acme/dapp.git'),
    true
  )
  assert.equal(
    sameRemote(
      'file:///tmp/gh/acme/dApp.git',
      'file:///tmp/other/acme/dApp.git'
    ),
    false
  )
})

test('Bitbucket: ssh.bitbucket.org and bitbucket.org are one host (spec 0039 §5.2)', () => {
  const ssh = 'git@ssh.bitbucket.org:acme/api.git'
  for (const other of [
    'git@bitbucket.org:acme/api.git',
    'https://bitbucket.org/acme/api.git',
    'https://x-bitbucket-api-token-auth@bitbucket.org/acme/api.git',
    'ssh://git@ssh.bitbucket.org/acme/api.git',
    'ssh://git@bitbucket.org/acme/API',
  ])
    assert.equal(sameRemote(ssh, other), true, other)
  for (const other of [
    'git@ssh.bitbucket.org:other/api.git',
    'git@gitlab.com:acme/api.git',
    'https://ssh.bitbucket.org.evil/acme/api.git',
  ])
    assert.equal(sameRemote(ssh, other), false, other)
})

test('currentSshUrl: the old Bitbucket SSH host, as the API gives it, is rewritten; anything else is kept', () => {
  assert.equal(
    currentSshUrl('git@bitbucket.org:acme/api.git'),
    'git@ssh.bitbucket.org:acme/api.git'
  )
  assert.equal(
    currentSshUrl('ssh://git@bitbucket.org/acme/api.git'),
    'ssh://git@ssh.bitbucket.org/acme/api.git'
  )
  for (const kept of [
    'git@ssh.bitbucket.org:acme/api.git',
    'https://bitbucket.org/acme/api.git',
    'git@github.com:acme/api.git',
    'git@bitbucket.org.evil:acme/api.git',
  ])
    assert.equal(currentSshUrl(kept), kept, kept)
})

test('classifyProbe: auth beats not-found; exit 2 is an empty but existing repository', () => {
  const url = 'https://github.com/acme/.rness.git'
  assert.deepEqual(classifyProbe(url, 0, ''), { kind: 'found' })
  assert.deepEqual(classifyProbe(url, 2, ''), { kind: 'found' })
  assert.deepEqual(
    classifyProbe(
      url,
      128,
      'remote: Repository not found.\nfatal: repository not found'
    ),
    { kind: 'not-found' }
  )
  assert.deepEqual(
    classifyProbe(
      url,
      128,
      "fatal: '/tmp/x' does not appear to be a git repository\nfatal: Could not read from remote repository."
    ),
    { kind: 'not-found' }
  )
  assert.equal(
    classifyProbe(
      url,
      128,
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled"
    ).kind,
    'error'
  )
  assert.equal(
    classifyProbe(
      url,
      128,
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'
    ).kind,
    'error'
  )
  assert.equal(
    classifyProbe(
      url,
      128,
      "fatal: unable to access 'https://github.com/x/': Could not resolve host: github.com"
    ).kind,
    'error'
  )
})

test('probeRemote against local bare repositories', async (t) => {
  const url = await makeBareRepo(t, 'probe')
  assert.deepEqual(await probeRemote(url), { kind: 'found' })
  assert.deepEqual(await probeRemote('file:///no/such/place/nothing.git'), {
    kind: 'not-found',
  })
})

test('probeRemote refuses a url git would read as an option', async () => {
  await assert.rejects(
    () => probeRemote('--upload-pack=x'),
    /refusing suspicious repository url/
  )
})

test('probeRemote times out even while a grandchild holds stderr open', async (t) => {
  // A fake `git` that hangs *and* leaves a background child holding the stderr
  // pipe — what a stuck credential helper does. Killing the child git does not
  // reap that grandchild, so this is what proves the answer never waits on
  // `'close'`. Both pids are recorded and killed afterwards.
  const binDir = await mkdtemp(join(tmpdir(), 'rness-bin-'))
  const pidFile = join(binDir, 'pid')
  const gitPath = join(binDir, 'git')
  await writeFile(
    gitPath,
    [
      '#!/bin/sh',
      'sleep 30 >&2 &',
      `echo "$! $$" > "${pidFile}"`,
      // `exec`, so that the hanging process *is* this pid: killing the child
      // then leaves no orphaned foreground sleep behind.
      'exec sleep 30',
      '',
    ].join('\n')
  )
  await chmod(gitPath, 0o755)
  const originalPath = process.env['PATH']
  process.env['PATH'] = `${binDir}:${originalPath ?? ''}`
  t.after(async () => {
    if (originalPath === undefined) delete process.env['PATH']
    else process.env['PATH'] = originalPath
    try {
      for (const field of (await readFile(pidFile, 'utf8')).trim().split(' ')) {
        const pid = Number(field)
        try {
          if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    } catch {
      // the fake git never ran
    }
    await rm(binDir, { recursive: true, force: true })
  })

  const started = Date.now()
  const probe = await probeRemote('file:///x.git', 500)
  const elapsed = Date.now() - started
  assert.equal(probe.kind, 'error')
  assert.match(
    probe.kind === 'error' ? probe.message : '',
    /cannot reach file:\/\/\/x\.git: timed out after 1s/
  )
  assert.ok(elapsed < 2000, `resolved in ${elapsed}ms, expected under 2000ms`)
})
