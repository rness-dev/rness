import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  HOOK_MARKER,
  HOOK_NAMES,
  hookManagerLine,
  hookScript,
  installHooks,
} from '../../src/core/git-hooks.ts'
import { commitDir, git } from '../helpers/git.ts'

const execFileP = promisify(execFile)

async function tmp(t: import('node:test').TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-hooks-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function repo(t: import('node:test').TestContext): Promise<string> {
  const dir = join(await tmp(t), 'clone')
  await mkdir(dir)
  await writeFile(join(dir, 'a.txt'), 'a\n')
  await commitDir(dir)
  return dir
}

const WS = '/work/space'

test('writes the three hooks, executable, with the marker and the workspace path', async (t) => {
  const clone = await repo(t)
  const r = await installHooks(clone, WS)
  assert.deepEqual(r.written, [...HOOK_NAMES])
  for (const hook of HOOK_NAMES) {
    const file = join(clone, '.git', 'hooks', hook)
    const text = await readFile(file, 'utf8')
    assert.equal(text, hookScript(hook, WS))
    assert.ok(text.startsWith('#!/bin/sh\n'))
    assert.ok(text.includes(HOOK_MARKER))
    assert.ok(
      text.includes(`'${WS}/.rness/node_modules/@rness/cli/dist/bin/rness.js'`)
    )
    assert.ok(text.includes(`policy check ${hook} "$@"`))
    assert.equal((await stat(file)).mode & 0o777, 0o755)
  }
  // A second run changes nothing and says nothing.
  const again = await installHooks(clone, WS)
  assert.deepEqual(again.written, [])
  assert.deepEqual(again.foreign, [])
})

test('a stale rness hook is rewritten, a lost execute bit restored', async (t) => {
  const clone = await repo(t)
  await installHooks(clone, WS)
  const file = join(clone, '.git', 'hooks', 'pre-commit')
  await writeFile(file, `#!/bin/sh\n${HOOK_MARKER}\nexit 0\n`)
  await chmod(file, 0o644)
  const r = await installHooks(clone, WS)
  assert.deepEqual(r.written, ['pre-commit'])
  assert.equal(await readFile(file, 'utf8'), hookScript('pre-commit', WS))
  await chmod(file, 0o644)
  await installHooks(clone, WS)
  assert.equal((await stat(file)).mode & 0o777, 0o755)
})

test('a hook without the marker is kept and reported; the others are written', async (t) => {
  const clone = await repo(t)
  const file = join(clone, '.git', 'hooks', 'commit-msg')
  await mkdir(join(clone, '.git', 'hooks'), { recursive: true })
  await writeFile(file, '#!/bin/sh\necho mine\n')
  const r = await installHooks(clone, WS)
  assert.deepEqual(r.foreign, ['commit-msg'])
  assert.deepEqual(r.written, ['pre-commit', 'pre-push'])
  assert.equal(await readFile(file, 'utf8'), '#!/bin/sh\necho mine\n')
})

test('a clone with core.hooksPath is left whole and reported', async (t) => {
  const clone = await repo(t)
  await git(['config', 'core.hooksPath', '.githooks'], clone)
  const r = await installHooks(clone, WS)
  assert.equal(r.hooksPath, '.githooks')
  assert.deepEqual(r.written, [])
  await assert.rejects(stat(join(clone, '.git', 'hooks', 'pre-commit')))
  assert.equal(
    hookManagerLine('commit-msg', WS),
    `node '${WS}/.rness/node_modules/@rness/cli/dist/bin/rness.js' policy check commit-msg "$@"`
  )
})

test('a directory that is no repository is left alone', async (t) => {
  const dir = await tmp(t)
  const r = await installHooks(dir, WS)
  assert.equal(r.notARepository, true)
  assert.deepEqual(r.written, [])
})

test('a linked worktree gets the hooks in the main repository', async (t) => {
  const clone = await repo(t)
  const wt = join(await tmp(t), 'wt')
  await git(['worktree', 'add', '-q', '-b', 'side', wt], clone)
  const r = await installHooks(wt, WS)
  assert.deepEqual(r.written, [...HOOK_NAMES])
  await stat(join(clone, '.git', 'hooks', 'pre-push'))
})

test('the script fails open with one line when the pinned CLI is missing', async (t) => {
  const ws = await tmp(t)
  const file = join(ws, 'hook')
  await writeFile(file, hookScript('pre-commit', ws))
  const r = await execFileP('sh', [file]).then(
    (o) => ({ code: 0, ...o }),
    (e: { code: number; stdout: string; stderr: string }) => e
  )
  assert.equal(r.code, 0)
  assert.equal(
    r.stderr,
    `rness: policies not checked: ${ws}/.rness/node_modules/@rness/cli/dist/bin/rness.js not found\n`
  )
})

test('the script fails open with one line when node is missing', async (t) => {
  const ws = await tmp(t)
  const file = join(ws, 'hook')
  await writeFile(file, hookScript('pre-commit', ws))
  const r = await execFileP('/bin/sh', [file], {
    env: { PATH: '/nonexistent' },
  })
  assert.equal(r.stderr, 'rness: policies not checked: node not found\n')
})

async function standIn(ws: string, body: string): Promise<void> {
  const bin = join(ws, '.rness', 'node_modules', '@rness', 'cli', 'dist', 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'rness.js'), body)
  await writeFile(join(bin, '..', '..', 'package.json'), '{"type":"module"}')
}

async function hookedClone(ws: string): Promise<string> {
  const clone = join(ws, 'org', 'web')
  await mkdir(clone, { recursive: true })
  await git(['init', '-q', '-b', 'main'], clone)
  await installHooks(clone, ws)
  await writeFile(join(clone, 'a.txt'), 'a\n')
  await git(['add', 'a.txt'], clone)
  return clone
}

// A stand-in for the pinned CLI: refuses (20) a message naming "forbidden",
// crashes (1) on one naming "crash".
const STAND_IN = `import { readFileSync } from 'node:fs'
const [, , a, b, hook, file] = process.argv
if (a === 'policy' && b === 'check' && hook === 'commit-msg') {
  const text = readFileSync(file, 'utf8')
  if (text.includes('forbidden')) {
    process.stderr.write('rness: policy stand-in refused this commit\\n')
    process.exit(20)
  }
  if (text.includes('crash')) process.exit(1)
}
`

for (const dirName of ['ws', "my ws 'quoted'"])
  test(`a commit through the written hook: refusal 20 blocks, a crash (1) passes with one line, in ${dirName}`, async (t) => {
    const ws = join(await tmp(t), dirName)
    await standIn(ws, STAND_IN)
    const clone = await hookedClone(ws)
    await assert.rejects(
      git(['commit', '-q', '-m', 'a forbidden word'], clone),
      { stderr: /rness: policy stand-in refused this commit/ }
    )
    const crashed = await execFileP(
      'git',
      ['commit', '-m', 'a crash', '--no-gpg-sign'],
      {
        cwd: clone,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'x',
          GIT_AUTHOR_EMAIL: 'x@x.invalid',
          GIT_COMMITTER_NAME: 'x',
          GIT_COMMITTER_EMAIL: 'x@x.invalid',
        },
      }
    )
    const lines = crashed.stderr.split('\n').filter((l) => l.includes('rness:'))
    assert.deepEqual(lines, [
      'rness: policies not checked: the rness CLI exited 1',
    ])
    assert.match(await git(['log', '--format=%s'], clone), /^a crash$/m)
    await writeFile(join(clone, 'b.txt'), 'b\n')
    await git(['add', 'b.txt'], clone)
    await git(['commit', '-q', '-m', 'fine'], clone)
  })

test('pre-push still reads the lines git gives on stdin', async (t) => {
  const ws = await tmp(t)
  await standIn(
    ws,
    `import { readFileSync } from 'node:fs'
if (process.argv[4] === 'pre-push' && readFileSync(0, 'utf8').includes('refs/heads/main')) process.exit(20)
`
  )
  const clone = await hookedClone(ws)
  await git(['commit', '-q', '-m', 'one'], clone)
  const bare = join(await tmp(t), 'remote.git')
  await git(['init', '-q', '--bare', bare], ws)
  await git(['remote', 'add', 'origin', bare], clone)
  await assert.rejects(git(['push', '-q', 'origin', 'main'], clone))
})
