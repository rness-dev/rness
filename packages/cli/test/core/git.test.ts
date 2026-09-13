import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  clone,
  commitAll,
  init,
  isClean,
  originUrl,
  pullFastForward,
} from '../../src/core/git.ts'
import { commitTo, makeBareRepo } from '../helpers/git.ts'

process.env['GIT_AUTHOR_NAME'] = 'rness-test'
process.env['GIT_AUTHOR_EMAIL'] = 'test@rness.invalid'
process.env['GIT_COMMITTER_NAME'] = 'rness-test'
process.env['GIT_COMMITTER_EMAIL'] = 'test@rness.invalid'

const execFileP = promisify(execFile)

test('clone, originUrl, isClean, pullFastForward against a local bare repository', async (t) => {
  const url = await makeBareRepo(t, 'api')
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-clone-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const dir = join(base, 'api')
  await clone(url, dir)
  assert.equal(await originUrl(dir), url)
  assert.equal(await isClean(dir), true)
  await commitTo(url, 'NEW.md', 'new\n')
  await pullFastForward(dir)
  const { access } = await import('node:fs/promises')
  await access(join(dir, 'NEW.md'))
  await writeFile(join(dir, 'dirty.txt'), 'x')
  assert.equal(await isClean(dir), false)
})

test('failures are one-line errors naming the verb', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-clone-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  await assert.rejects(
    clone('file:///no/such/repo.git', join(base, 'x')),
    /^Error: git clone failed: /
  )
  assert.equal(await originUrl(base), null)
})

test('a plain directory inside a repository is not a clone: git never walks up to the ancestor', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-ceiling-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  await execFileP('git', ['init', '-q', '-b', 'main', base])
  await execFileP('git', ['remote', 'add', 'origin', 'file:///ancestor.git'], {
    cwd: base,
  })
  await writeFile(join(base, 'tracked.txt'), 'x')
  const sub = join(base, 'org', 'web')
  await mkdir(sub, { recursive: true })
  // Without GIT_CEILING_DIRECTORIES both calls would succeed against `base`
  // and report the ancestor's dirty status and origin.
  await assert.rejects(isClean(sub), /git status failed: /)
  assert.equal(await originUrl(sub), null)
})

test('a repository url or directory starting with - is refused, never handed to git', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-argv-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  await assert.rejects(
    clone('--upload-pack=touch /tmp/pwned', join(base, 'x')),
    /refusing suspicious repository url/
  )
  await assert.rejects(
    clone('file:///tmp/nowhere.git', '-C'),
    /refusing suspicious directory/
  )
})

test('init and commitAll create a repository on main with one commit', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-init-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  await init(base)
  await writeFile(join(base, 'a.txt'), 'a\n')
  await commitAll(base, 'chore: first')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)(
    'git',
    ['log', '--oneline', 'main'],
    { cwd: base }
  )
  assert.equal(stdout.trim().split('\n').length, 1)
})
