import assert from 'node:assert/strict'
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
