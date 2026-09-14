import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DEFAULT_HOST,
  SSH_HOST,
  classifyProbe,
  probeRemote,
  repoUrl,
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
  // pipe — what a stuck credential helper does. Waiting for `'close'` would
  // never return; the timeout kills the whole process group instead.
  const binDir = await mkdtemp(join(tmpdir(), 'rness-bin-'))
  const pidFile = join(binDir, 'pid')
  const gitPath = join(binDir, 'git')
  await writeFile(
    gitPath,
    [
      '#!/bin/sh',
      `echo $$ > "${pidFile}"`,
      'sleep 30 >&2 &',
      'sleep 30',
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
      const pid = Number((await readFile(pidFile, 'utf8')).trim())
      if (Number.isInteger(pid)) process.kill(-pid, 'SIGKILL')
    } catch {
      // already gone: the timeout killed the group
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
