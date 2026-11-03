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
    `node "${WS}/.rness/node_modules/@rness/cli/dist/bin/rness.js" policy check commit-msg "$@"`
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

test('a commit through the written hook is refused by the CLI it runs,', async (t) => {
  const ws = await tmp(t)
  const bin = join(ws, '.rness', 'node_modules', '@rness', 'cli', 'dist', 'bin')
  await mkdir(bin, { recursive: true })
  // A stand-in for the pinned CLI: refuses a commit message naming "forbidden".
  await writeFile(
    join(bin, 'rness.js'),
    `import { readFileSync } from 'node:fs'
const [, , a, b, hook, file] = process.argv
if (a !== 'policy' || b !== 'check') process.exit(0)
if (hook === 'commit-msg' && readFileSync(file, 'utf8').includes('forbidden')) {
  process.stderr.write('rness: policy stand-in refused this commit\\n')
  process.exit(1)
}
`
  )
  await writeFile(join(bin, '..', '..', 'package.json'), '{"type":"module"}')
  const clone = join(ws, 'org', 'web')
  await mkdir(clone, { recursive: true })
  await git(['init', '-q', '-b', 'main'], clone)
  await installHooks(clone, ws)
  await writeFile(join(clone, 'a.txt'), 'a\n')
  await git(['add', 'a.txt'], clone)
  await assert.rejects(git(['commit', '-q', '-m', 'a forbidden word'], clone), {
    stderr: /rness: policy stand-in refused this commit/,
  })
  await git(['commit', '-q', '-m', 'fine'], clone)
  assert.match(await git(['log', '--format=%s'], clone), /^fine$/m)
})
