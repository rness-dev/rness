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
  gitPath,
  init,
  isClean,
  originUrl,
  pullFastForward,
  seenPaths,
} from '../../src/core/git.ts'
import { commitDir, commitTo, git, makeBareRepo } from '../helpers/git.ts'

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

test("seenPaths: what HEAD's history holds — kept, deleted, on a branch merged back — not what it never held, nor what git cannot answer for", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-seen-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const dir = join(base, 'memory')
  await mkdir(dir)
  await writeFile(join(dir, 'kept.md'), 'k\n')
  await writeFile(join(dir, 'deleted.md'), 'd\n')
  await commitDir(dir, 'first')
  await rm(join(dir, 'deleted.md'))
  await commitDir(dir, 'deleted.md gone')
  // Added then removed on a branch merged with no change to main: history
  // simplification alone would skip the branch.
  await git(['checkout', '-q', '-b', 'side'], dir)
  await writeFile(join(dir, 'side.md'), 's\n')
  await commitDir(dir, 'side.md')
  await rm(join(dir, 'side.md'))
  await commitDir(dir, 'side.md gone')
  await git(['checkout', '-q', 'main'], dir)
  await git(['merge', '-q', '--no-ff', '-m', 'merge side', 'side'], dir)
  // A teammate's document fetched, not merged: on a ref, not in HEAD's history.
  await git(['checkout', '-q', '-b', 'fetched'], dir)
  await writeFile(join(dir, 'fetched.md'), 'f\n')
  await commitDir(dir, 'fetched.md')
  await git(['checkout', '-q', 'main'], dir)
  await writeFile(join(dir, 'untracked.md'), 'u\n')

  const seen = await seenPaths(dir, [
    'kept.md',
    'deleted.md',
    'side.md',
    'fetched.md',
    'untracked.md',
    'never.md',
    '*.md',
    '../outside.md',
    '--output=x',
  ])
  assert.deepEqual([...seen].sort(), ['deleted.md', 'kept.md', 'side.md'])

  const plain = join(base, 'plain')
  await mkdir(plain)
  assert.deepEqual([...(await seenPaths(plain, ['kept.md']))], [])
  assert.deepEqual([...(await seenPaths(dir, []))], [])
})

test('gitPath: a file of the git directory, absolute — its own for a linked worktree; null without a repository', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-gitpath-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const main = join(base, 'memory')
  await mkdir(main)
  await writeFile(join(main, 'a.md'), 'a\n')
  await commitDir(main, 'first')
  await git(['worktree', 'add', '-q', '-b', 'wt', join(base, 'wt')], main)
  assert.equal(
    await gitPath(main, 'rness/opened'),
    join(main, '.git', 'rness', 'opened')
  )
  assert.equal(
    await gitPath(join(base, 'wt'), 'rness/opened'),
    join(main, '.git', 'worktrees', 'wt', 'rness', 'opened')
  )
  const plain = join(base, 'plain')
  await mkdir(plain)
  assert.equal(await gitPath(plain, 'rness/opened'), null)
})
