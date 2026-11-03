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
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import {
  HOOK_MARKER,
  HOOK_NAMES,
  hookManagerSnippet,
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
})

test("the hook manager's snippet finds the CLI from the clone, never by this machine's path", () => {
  const snippet = hookManagerSnippet('commit-msg')
  assert.ok(!snippet.includes(WS))
  assert.ok(
    snippet.startsWith(
      'rness_dir="$(git rev-parse --show-toplevel)/../../.rness"\n'
    ),
    snippet
  )
  assert.match(snippet, /policy check commit-msg "\$@"/)
  // Pasted into a team's hook: it never ends it, but on a refusal.
  assert.doesNotMatch(snippet, /exit 0/)
  assert.match(snippet, /exit 1/)
})

/** An enabled policy in the workspace's `.rness/policy/`. */
async function enabledPolicy(ws: string, status = 'Enabled'): Promise<void> {
  await mkdir(join(ws, '.rness', 'policy'), { recursive: true })
  await writeFile(
    join(ws, '.rness', 'policy', 'no-force-push.md'),
    `---\nstatus: ${status}\nrules:\n  - check: push\n    deny: non-fast-forward\n    fix: Push a new commit.\n---\n\n# No force push\n`
  )
}

async function runScript(
  file: string,
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; stderr: string }> {
  return execFileP('/bin/sh', [file], env === undefined ? {} : { env }).then(
    (o) => ({ code: 0, stderr: o.stderr }),
    (e: { code: number; stderr: string }) => ({
      code: e.code,
      stderr: e.stderr,
    })
  )
}

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

test('the script fails open with one line when the pinned CLI is missing and a policy is enabled', async (t) => {
  const ws = await tmp(t)
  await enabledPolicy(ws)
  const file = join(ws, 'hook')
  await writeFile(file, hookScript('pre-commit', ws))
  assert.deepEqual(await runScript(file), {
    code: 0,
    stderr: `rness: policies not checked: ${ws}/.rness/node_modules/@rness/cli/dist/bin/rness.js not found\n`,
  })
})

test('a missing CLI says nothing while no policy is enabled; a .rness that is not there is said', async (t) => {
  const ws = await tmp(t)
  const file = join(ws, 'hook')
  await writeFile(file, hookScript('pre-commit', ws))
  // No .rness at all: the workspace moved, or is gone.
  assert.match((await runScript(file)).stderr, /^rness: policies not checked: /)
  // A .rness without policies, then with the example still disabled.
  await mkdir(join(ws, '.rness'))
  assert.deepEqual(await runScript(file), { code: 0, stderr: '' })
  await enabledPolicy(ws, 'Disabled')
  assert.deepEqual(await runScript(file), { code: 0, stderr: '' })
})

/** A PATH where `grep` is found and `node` is not. */
async function pathWithoutNode(t: import('node:test').TestContext) {
  const bin = join(await tmp(t), 'bin')
  await mkdir(bin)
  const grep = (await execFileP('/bin/sh', ['-c', 'command -v grep'])).stdout
  await symlink(grep.trim(), join(bin, 'grep'))
  return bin
}

test('the script fails open with one line when node is missing, silent with no enabled policy', async (t) => {
  const ws = await tmp(t)
  const file = join(ws, 'hook')
  await writeFile(file, hookScript('pre-commit', ws))
  const PATH = await pathWithoutNode(t)
  await enabledPolicy(ws, 'Disabled')
  assert.deepEqual(await runScript(file, { PATH }), { code: 0, stderr: '' })
  await enabledPolicy(ws)
  assert.deepEqual(await runScript(file, { PATH }), {
    code: 0,
    stderr: 'rness: policies not checked: node not found\n',
  })
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
// crashes (1) on one naming "crash", prints a lot and exits 2 (a CLI that
// knows no \`policy\`) on "noisy", says a line and passes on "notice".
const STAND_IN = `import { readFileSync } from 'node:fs'
const [, , a, b, hook, file] = process.argv
if (a === 'policy' && b === 'check' && hook === 'commit-msg') {
  const text = readFileSync(file, 'utf8')
  if (text.includes('forbidden')) {
    process.stderr.write('rness: policy stand-in refused this commit\\n  fix: say it otherwise\\n')
    process.exit(20)
  }
  if (text.includes('crash')) process.exit(1)
  if (text.includes('noisy')) {
    for (let i = 0; i < 40; i++) {
      process.stdout.write('noise ' + i + '\\n')
      process.stderr.write('noise ' + i + '\\n')
    }
    process.exit(2)
  }
  if (text.includes('notice')) process.stderr.write('rness: a notice\\n')
}
`

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'x',
  GIT_AUTHOR_EMAIL: 'x@x.invalid',
  GIT_COMMITTER_NAME: 'x',
  GIT_COMMITTER_EMAIL: 'x@x.invalid',
}

/** `git commit -m <message>` in `clone`: its exit code and the hooks' `rness:` lines. */
async function commitWith(
  clone: string,
  message: string
): Promise<{ code: number; stderr: string; rness: string[] }> {
  const r = await execFileP(
    'git',
    ['commit', '--allow-empty', '-m', message, '--no-gpg-sign'],
    { cwd: clone, env: ENV }
  ).then(
    (o) => ({ code: 0, stderr: o.stderr }),
    (e: { code: number; stderr: string }) => ({
      code: e.code,
      stderr: e.stderr,
    })
  )
  return {
    ...r,
    rness: r.stderr.split('\n').filter((l) => l.includes('rness:')),
  }
}

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

test('through the written hook, a CLI that prints a lot and exits 2 is one line; its words show on 0 and 20', async (t) => {
  const ws = await tmp(t)
  await standIn(ws, STAND_IN)
  const clone = await hookedClone(ws)
  const noisy = await commitWith(clone, 'noisy')
  assert.equal(noisy.code, 0)
  assert.doesNotMatch(noisy.stderr, /noise/)
  assert.deepEqual(noisy.rness, [
    'rness: policies not checked: the rness CLI exited 2',
  ])
  const notice = await commitWith(clone, 'notice')
  assert.equal(notice.code, 0)
  assert.deepEqual(notice.rness, ['rness: a notice'])
  const refused = await commitWith(clone, 'forbidden')
  assert.notEqual(refused.code, 0)
  assert.match(
    refused.stderr,
    /rness: policy stand-in refused this commit\n {2}fix: say it otherwise\n/
  )
})

test("the hook manager's snippet through git: 20 blocks, 0 goes on to the team's hook, a crash or a missing CLI is one line", async (t) => {
  const ws = await tmp(t)
  await standIn(ws, STAND_IN)
  await enabledPolicy(ws)
  const clone = join(ws, 'org', 'web')
  await mkdir(join(clone, '.husky'), { recursive: true })
  await git(['init', '-q', '-b', 'main'], clone)
  await git(['config', 'core.hooksPath', '.husky'], clone)
  // As husky runs a hook: under sh -e, the team's own line after ours.
  const hook = join(clone, '.husky', 'commit-msg')
  await writeFile(
    hook,
    `#!/bin/sh\nset -e\n${hookManagerSnippet('commit-msg')}echo team >> "$(git rev-parse --git-dir)/team-ran"\n`
  )
  await chmod(hook, 0o755)
  const ran = async () =>
    (await readFile(join(clone, '.git', 'team-ran'), 'utf8').catch(() => ''))
      .split('\n')
      .filter((l) => l !== '').length

  const refused = await commitWith(clone, 'a forbidden word')
  assert.notEqual(refused.code, 0)
  assert.match(refused.stderr, /rness: policy stand-in refused this commit\n/)
  assert.equal(await ran(), 0)

  assert.deepEqual(
    { ...(await commitWith(clone, 'fine')), stderr: '' },
    { code: 0, stderr: '', rness: [] }
  )
  assert.equal(await ran(), 1)
  const crash = await commitWith(clone, 'a crash')
  assert.equal(crash.code, 0)
  assert.deepEqual(crash.rness, [
    'rness: policies not checked: the rness CLI exited 1',
  ])
  const noisy = await commitWith(clone, 'noisy')
  assert.equal(noisy.code, 0)
  assert.deepEqual(noisy.rness, [
    'rness: policies not checked: the rness CLI exited 2',
  ])
  assert.equal(await ran(), 3)

  await rm(join(ws, '.rness', 'node_modules'), { recursive: true })
  const missing = await commitWith(clone, 'a forbidden word, unchecked')
  assert.equal(missing.code, 0)
  assert.equal(missing.rness.length, 1)
  assert.match(
    missing.rness[0] ?? '',
    /^rness: policies not checked: .*\/org\/web\/\.\.\/\.\.\/\.rness\/node_modules\/@rness\/cli\/dist\/bin\/rness\.js not found$/
  )
  assert.equal(await ran(), 4)
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
