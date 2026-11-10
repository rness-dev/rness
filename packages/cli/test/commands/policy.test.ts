import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { type TestContext, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { run } from '../../src/cli.ts'
import { policyCheckCommand } from '../../src/commands/policy.ts'
import { blockHash, bodyOf, parseHeader } from '../../src/core/block.ts'
import { OWN_COMMANDS } from '../../src/core/catch-up.ts'
import { POLICY_REFUSED_EXIT } from '../../src/core/git-hooks.ts'
import { findBlock } from '../../src/core/merge.ts'
import { readRefusals } from '../../src/core/refusals.ts'
import { capture } from '../helpers/capture.ts'
import { makeContract1Workspace, makeWorkspace } from '../helpers/workspace.ts'

// The developer's git configuration never reaches these repositories: a
// global `commit.verbose` or `core.hooksPath` would change what they show.
process.env['GIT_CONFIG_GLOBAL'] = '/dev/null'
process.env['GIT_CONFIG_NOSYSTEM'] = '1'
process.env['GIT_AUTHOR_NAME'] = 'rness-test'
process.env['GIT_AUTHOR_EMAIL'] = 'test@rness.invalid'
process.env['GIT_COMMITTER_NAME'] = 'rness-test'
process.env['GIT_COMMITTER_EMAIL'] = 'test@rness.invalid'
// Run from a hook (this repository's pre-commit), the tests would inherit it.
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_EDITOR'])
  delete process.env[name]
delete process.env['CLAUDE_CODE_SESSION_ID']

const execFileP = promisify(execFile)
const binPath = fileURLToPath(
  new URL('../../src/bin/rness.ts', import.meta.url)
)

const DASH = '\u2014'
const SCISSORS = [
  '# ------------------------ >8 ------------------------',
  '# Do not modify or remove the line above.',
  '# Everything below it will be ignored.',
].join('\n')

const NO_EM_DASH = `---
status: Enabled
rules:
  - check: added-lines
    deny: '\\u2014'
    fix: Write " - " instead of the em dash.
  - check: commit-message
    deny: '\\u2014'
    fix: Write " - " instead of the em dash.
---

# No em dash
`
const NO_TRAILERS = `---
status: Enabled
rules:
  - check: commit-message
    deny: '^co-authored-by: .*claude'
    fix: Remove the agent's Co-Authored-By trailer, then commit again.
---

# No agent trailers
`
const NO_FORCE_PUSH = `---
status: Enabled
rules:
  - check: push
    deny: non-fast-forward
    fix: Rebase on the remote branch and push again.
---

# No force push
`
const NO_TODO = `---
status: Enabled
rules:
  - check: added-lines
    deny: 'TODO'
    fix: Open an issue instead.
  - check: commit-message
    deny: '^wip'
    fix: Say what the commit does.
---

# No TODO
`

interface Ran {
  code: number
  stdout: string
  stderr: string
}

/** `git <args>`, its exit code kept. */
async function gitRun(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {}
): Promise<Ran> {
  try {
    const { stdout, stderr } = await execFileP('git', args, {
      cwd,
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    const err = e as { code?: unknown; stdout?: string; stderr?: string }
    return {
      code: typeof err.code === 'number' ? err.code : -1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    }
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await gitRun(args, cwd)
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

async function put(dir: string, rel: string, text: string): Promise<void> {
  const file = join(dir, ...rel.split('/'))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

interface Options {
  files?: Record<string, string>
  agents?: string[]
}

/**
 * A workspace with clones `org/web` (scope web) and `org/mono` (scope mono,
 * its package `org/mono/packages/pkg` a scope extending it), and `org/stray`,
 * a repository no scope declares: each one a fresh repository.
 */
async function workspace(t: TestContext, opts: Options = {}) {
  const root = await makeWorkspace(t, {
    org: 'acme',
    ...(opts.agents === undefined ? {} : { agents: opts.agents }),
    scopes: {
      web: { url: 'file:///nowhere/web.git' },
      mono: {
        url: 'file:///nowhere/mono.git',
        scopes: { pkg: { path: 'packages/pkg' } },
      },
    },
    files: {
      'policy/no-em-dash.md': NO_EM_DASH,
      'policy/no-agent-trailers.md': NO_TRAILERS,
      'policy/no-force-push.md': NO_FORCE_PUSH,
      'policy/pkg/no-todo.md': NO_TODO,
      ...opts.files,
    },
    dirs: ['org/web', 'org/mono', 'org/stray'],
  })
  const web = join(root, 'org', 'web')
  const mono = join(root, 'org', 'mono')
  const stray = join(root, 'org', 'stray')
  for (const dir of [web, mono, stray])
    await git(['init', '-q', '-b', 'main'], dir)
  return { root, web, mono, stray }
}

/** The command in-process, as a hook would run it from `cwd`. */
async function check(
  hook: string | undefined,
  cwd: string,
  opts: { args?: string[]; input?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number; err: string }> {
  let err = ''
  const error = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      err += String(chunk)
      done()
    },
  })
  const code = await policyCheckCommand(hook, opts.args ?? [], {
    input: Readable.from([opts.input ?? '']),
    error,
    env: { ...process.env, ...opts.env },
    cwd,
  })
  return { code, err }
}

/** A git hook that runs this checkout's CLI, as task 5's scripts will. */
async function installHook(clone: string, hook: string): Promise<void> {
  const file = join(clone, '.git', 'hooks', hook)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    `#!/bin/sh\nexec "${process.execPath}" "${binPath}" policy check ${hook} "$@"\n`
  )
  await chmod(file, 0o755)
}

// --- pre-commit --------------------------------------------------------------

test('pre-commit: an added em dash is refused, exit 1, the refusal on stderr, and recorded', async (t) => {
  const { web } = await workspace(t)
  await put(web, 'src/a.ts', `ok\nx ${DASH} y\n`)
  await git(['add', 'src/a.ts'], web)
  const r = await check('pre-commit', web)
  assert.equal(r.code, POLICY_REFUSED_EXIT)
  assert.equal(
    r.err,
    [
      'rness: policy no-em-dash refused this commit',
      `  org/web/src/a.ts:2: x ${DASH} y`,
      '  fix: Write " - " instead of the em dash.',
      '  policy: .rness/policy/no-em-dash.md',
      '',
    ].join('\n')
  )
  const records = await readRefusals(web)
  assert.equal(records.length, 1)
  assert.deepEqual(
    { ...records[0], time: undefined },
    {
      time: undefined,
      policy: 'no-em-dash',
      check: 'added-lines',
      by: 'pre-commit',
    }
  )
  assert.ok(Date.now() - Date.parse(records[0]?.time ?? '') < 60_000)
})

test('pre-commit: a line already there passes; only what the commit adds is checked', async (t) => {
  const { web } = await workspace(t)
  await put(web, 'old.md', `kept ${DASH} line\nsecond\n`)
  await git(['add', 'old.md'], web)
  await git(['commit', '-q', '-m', 'old'], web)
  await put(web, 'old.md', `kept ${DASH} line\nsecond, edited\nthird\n`)
  await put(web, 'bin.dat', Buffer.from([0, 0xe2, 0x80, 0x94, 0]).toString())
  await git(['add', 'old.md', 'bin.dat'], web)
  assert.deepEqual(await check('pre-commit', web), { code: 0, err: '' })
  // A renamed file brings no line of its own.
  await git(['commit', '-q', '-m', 'edit'], web)
  await git(['mv', 'old.md', 'moved.md'], web)
  assert.deepEqual(await check('pre-commit', web), { code: 0, err: '' })
})

test('pre-commit: each file under its own scope, the deepest that holds it', async (t) => {
  const { mono } = await workspace(t)
  await put(mono, 'packages/pkg/a.ts', 'TODO: later\n')
  await put(mono, 'README.md', 'TODO: later\n')
  await git(['add', '-A'], mono)
  const r = await check('pre-commit', mono)
  assert.equal(r.code, POLICY_REFUSED_EXIT)
  assert.match(r.err, /^rness: policy no-todo refused this commit\n/)
  assert.match(r.err, /\n {2}org\/mono\/packages\/pkg\/a\.ts:1: TODO: later\n/)
  assert.doesNotMatch(r.err, /README/)
})

test('pre-commit: every failing rule of every policy in one message', async (t) => {
  const { mono } = await workspace(t)
  await put(mono, 'packages/pkg/a.ts', `TODO ${DASH}\n`)
  await git(['add', '-A'], mono)
  const r = await check('pre-commit', mono)
  assert.equal(r.code, POLICY_REFUSED_EXIT)
  assert.match(r.err, /rness: policy no-todo refused this commit/)
  assert.match(r.err, /rness: policy no-em-dash refused this commit/)
  assert.deepEqual((await readRefusals(mono)).map((x) => x.policy).sort(), [
    'no-em-dash',
    'no-todo',
  ])
})

test('an invalid policy is named in one line; the valid ones still apply', async (t) => {
  const { web } = await workspace(t, {
    files: {
      'policy/broken.md': NO_TRAILERS.replace('status: Enabled', 'status: On'),
      'policy/broken-off.md': `${NO_TRAILERS.replace('status: Enabled', 'status: Disabled').replace('rules:', 'extra: 1\nrules:')}`,
    },
  })
  const notApplied =
    'rness: policy not applied (invalid, run rness validate): policy/broken.md\n'
  await put(web, 'a.md', 'clean\n')
  await git(['add', 'a.md'], web)
  assert.deepEqual(await check('pre-commit', web), {
    code: 0,
    err: notApplied,
  })
  await put(web, 'a.md', `clean ${DASH}\n`)
  await git(['add', 'a.md'], web)
  const r = await check('pre-commit', web)
  assert.equal(r.code, POLICY_REFUSED_EXIT)
  assert.ok(r.err.startsWith(notApplied), r.err)
  assert.match(r.err, /rness: policy no-em-dash refused this commit/)
})

test('an invalid policy, then a failure to check: one line, the failure', async (t) => {
  const { web } = await workspace(t, {
    files: {
      'policy/broken.md': NO_TRAILERS.replace('status: Enabled', 'status: On'),
    },
  })
  assert.deepEqual(await check('commit-msg', web), {
    code: 0,
    err: 'rness: policies not checked: no commit message file was given\n',
  })
})

test('no enabled policy using the check: exit 0, not a word', async (t) => {
  const off = (text: string) =>
    text.replace('status: Enabled', 'status: Disabled')
  const { web } = await workspace(t, {
    files: {
      'policy/no-em-dash.md': off(NO_EM_DASH),
      'policy/no-force-push.md': off(NO_FORCE_PUSH),
    },
  })
  await put(web, 'a.md', `x ${DASH}\n`)
  await git(['add', 'a.md'], web)
  assert.deepEqual(await check('pre-commit', web), { code: 0, err: '' })
  const zeros = '0'.repeat(40)
  assert.deepEqual(
    await check('pre-push', web, {
      args: ['origin', 'file:///x'],
      input: `refs/heads/main ${'a'.repeat(40)} refs/heads/main ${'b'.repeat(40)}\n`,
    }),
    { code: 0, err: '' }
  )
  assert.deepEqual(
    await check('pre-push', web, {
      input: `(delete) ${zeros} refs/heads/x ${'b'.repeat(40)}\n`,
    }),
    { code: 0, err: '' }
  )
  assert.deepEqual(await readRefusals(web), [])
})

test('the context repository .rness answers to the global policies', async (t) => {
  const { root } = await workspace(t)
  const rness = join(root, '.rness')
  await git(['init', '-q', '-b', 'main'], rness)
  await put(rness, 'standards/style.md', `# Style\n\nA ${DASH} B\n`)
  await put(rness, 'policy/pkg/note.md', 'TODO\n')
  await git(['add', '-A'], rness)
  const r = await check('pre-commit', rness)
  assert.equal(r.code, POLICY_REFUSED_EXIT)
  assert.match(r.err, /\n {2}\.rness\/standards\/style\.md:3: A /)
  // The scoped policy of pkg is not the context repository's.
  assert.doesNotMatch(r.err, /no-todo/)
  assert.equal((await readRefusals(rness))[0]?.policy, 'no-em-dash')
})

test('a linked worktree is checked as its clone, and recorded there', async (t) => {
  const { web } = await workspace(t)
  await put(web, 'a.md', 'a\n')
  await git(['add', 'a.md'], web)
  await git(['commit', '-q', '-m', 'a'], web)
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-wt-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const wt = join(base, 'wt')
  await git(['worktree', 'add', '-q', '-b', 'side', wt], web)
  await put(wt, 'b.md', `b ${DASH}\n`)
  await git(['add', 'b.md'], wt)
  const r = await check('pre-commit', wt)
  assert.equal(r.code, POLICY_REFUSED_EXIT)
  assert.match(r.err, /\n {2}org\/web\/b\.md:1: b /)
  assert.equal((await readRefusals(web)).length, 1)
})

test("a linked worktree through git: its hook runs the main clone's, the record goes to the clone", async (t) => {
  const { web } = await workspace(t)
  await put(web, 'a.md', 'a\n')
  await git(['add', 'a.md'], web)
  await git(['commit', '-q', '-m', 'a'], web)
  await installHook(web, 'pre-commit')
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-wt-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const wt = join(base, 'wt')
  await git(['worktree', 'add', '-q', '-b', 'side', wt], web)
  await put(wt, 'b.md', `b ${DASH}\n`)
  await git(['add', 'b.md'], wt)
  const refused = await gitRun(['commit', '-q', '-m', 'b'], wt)
  assert.notEqual(refused.code, 0)
  assert.match(refused.stderr, /\n {2}org\/web\/b\.md:1: b /)
  assert.equal((await readRefusals(web)).length, 1)
})

test('a separate git directory named by GIT_DIR: the record goes there, process.env untouched', async (t) => {
  const { web } = await workspace(t)
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-gitdir-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const gitDir = join(base, 'web.git')
  await rm(join(web, '.git'), { recursive: true, force: true })
  await git(['init', '-q', '-b', 'main', `--separate-git-dir=${gitDir}`], web)
  // No `.git` in the work tree: only the hook's environment knows the repository.
  await rm(join(web, '.git'), { force: true })
  const env = { GIT_DIR: gitDir, GIT_WORK_TREE: web }
  await put(web, 'a.md', `x ${DASH}\n`)
  assert.equal((await gitRun(['add', 'a.md'], web, env)).code, 0)
  const before = { ...process.env }
  const r = await check('pre-commit', web, { env })
  assert.equal(r.code, POLICY_REFUSED_EXIT, r.err)
  assert.deepEqual({ ...process.env }, before)
  const record = await readFile(join(gitDir, 'rness', 'refusals.jsonl'), 'utf8')
  assert.match(
    record,
    /"policy":"no-em-dash","check":"added-lines","by":"pre-commit"/
  )
})

// --- rness's own outputs -------------------------------------------------------

test('a file sync writes under .claude/skills/rness/ is exempt only when it is what sync writes', async (t) => {
  const { root, web } = await workspace(t, { agents: ['claude'] })
  const c = capture()
  const code = await run(['sync', '--yes', '--cwd', root])
  c.restore()
  assert.equal(code, 0, c.err())
  const rel = '.claude/skills/rness/hooks/register.tsx'
  const synced = await readFile(join(web, ...rel.split('/')), 'utf8')
  // The mod's module holds the em dash: what sync writes, nobody can fix here.
  assert.ok(synced.includes(DASH))
  await git(['add', rel], web)
  assert.deepEqual(await check('pre-commit', web), { code: 0, err: '' })

  await appendFile(join(web, ...rel.split('/')), `// mine ${DASH}\n`)
  await git(['add', rel], web)
  const r = await check('pre-commit', web)
  assert.equal(r.code, POLICY_REFUSED_EXIT)
  assert.match(
    r.err,
    /org\/web\/\.claude\/skills\/rness\/hooks\/register\.tsx:\d+: \/\/ mine /
  )
})

test('the block sync writes is exempt; a block forged with its own hash is not', async (t) => {
  const { root, web } = await workspace(t, {
    files: { 'standards/coding.md': `# Coding\n\nWrite x ${DASH} y.\n` },
  })
  const c = capture()
  const code = await run(['sync', '--yes', '--cwd', root])
  c.restore()
  assert.equal(code, 0, c.err())
  const agents = join(web, 'AGENTS.md')
  const synced = await readFile(agents, 'utf8')
  assert.ok(synced.includes(`Write x ${DASH} y.`))
  await git(['add', 'AGENTS.md'], web)
  assert.deepEqual(await check('pre-commit', web), { code: 0, err: '' })

  // A block written by hand, its hash recomputed so that header and body agree.
  const lines = synced.split('\n')
  const span = findBlock(lines)
  assert.equal(span.kind, 'one')
  if (span.kind !== 'one') return
  const at = lines.findIndex((l) => l.startsWith('Write x'))
  lines[at] = `Forged ${DASH} here.`
  const block = lines.slice(span.begin, span.end + 1)
  const old = parseHeader(block[1] ?? '')?.hash ?? ''
  lines[span.begin + 1] = (lines[span.begin + 1] ?? '').replace(
    old,
    blockHash(bodyOf(block))
  )
  await writeFile(agents, lines.join('\n'))
  await git(['add', 'AGENTS.md'], web)
  const r = await check('pre-commit', web)
  assert.equal(r.code, POLICY_REFUSED_EXIT)
  assert.match(r.err, /org\/web\/AGENTS\.md:\d+: Forged /)
})

// --- commit-msg ----------------------------------------------------------------

test('commit-msg: a trailer refused, a clean message passes; $1 read from the work tree root', async (t) => {
  const { web } = await workspace(t)
  const msg = join(web, '.git', 'COMMIT_EDITMSG')
  await writeFile(
    msg,
    'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n'
  )
  const r = await check('commit-msg', web, {
    args: ['.git/COMMIT_EDITMSG'],
    env: { CLAUDE_CODE_SESSION_ID: 'session-1' },
  })
  assert.equal(r.code, POLICY_REFUSED_EXIT)
  assert.equal(
    r.err,
    [
      'rness: policy no-agent-trailers refused this commit',
      '  commit message, line 3: Co-Authored-By: Claude <noreply@anthropic.com>',
      "  fix: Remove the agent's Co-Authored-By trailer, then commit again.",
      '  policy: .rness/policy/no-agent-trailers.md',
      '',
    ].join('\n')
  )
  const [record] = await readRefusals(web)
  assert.equal(record?.by, 'commit-msg')
  assert.equal(record?.check, 'commit-message')
  assert.equal(record?.session, 'session-1')

  await writeFile(msg, 'feat: x\n\nA body.\n')
  assert.deepEqual(
    await check('commit-msg', web, { args: ['.git/COMMIT_EDITMSG'] }),
    { code: 0, err: '' }
  )
})

test('commit-msg: every scope of the clone applies, not only its root', async (t) => {
  const { mono, web } = await workspace(t)
  for (const dir of [mono, web])
    await writeFile(join(dir, '.git', 'COMMIT_EDITMSG'), 'wip: later\n')
  const args = ['.git/COMMIT_EDITMSG']
  const r = await check('commit-msg', mono, { args })
  assert.equal(r.code, POLICY_REFUSED_EXIT)
  assert.match(r.err, /^rness: policy no-todo refused this commit\n/)
  assert.deepEqual(await check('commit-msg', web, { args }), {
    code: 0,
    err: '',
  })
})

test('commit-msg through git: refused, then the scissors cut only where git cuts', async (t) => {
  const { web } = await workspace(t)
  await installHook(web, 'commit-msg')
  const trailer = 'Co-Authored-By: Claude <noreply@anthropic.com>'
  const commit = (
    args: string[],
    config: string[] = [],
    env?: NodeJS.ProcessEnv
  ) =>
    gitRun(
      [
        ...config.flatMap((c) => ['-c', c]),
        'commit',
        '-q',
        '--allow-empty',
        ...args,
      ],
      web,
      env
    )
  const log = async () => (await git(['log', '-1', '--format=%B'], web)).trim()

  const refused = await commit(['-m', `feat: x\n\n${trailer}`])
  assert.notEqual(refused.code, 0)
  assert.match(
    refused.stderr,
    /rness: policy no-agent-trailers refused this commit/
  )
  assert.equal((await gitRun(['rev-parse', 'HEAD'], web)).code, 128)

  // Typed under -m, git keeps a scissors block and what follows it.
  const below = `feat: x\n${SCISSORS}\n${trailer}`
  assert.notEqual((await commit(['-m', below])).code, 0)
  // commit.cleanup=scissors cuts only an edited message: not under -m.
  assert.notEqual(
    (await commit(['-m', below], ['commit.cleanup=scissors'])).code,
    0
  )
  // A scissors block of another comment character: git keeps it.
  assert.notEqual(
    (
      await commit(
        ['-m', `feat: x\n${SCISSORS.replaceAll('#', ';')}\n${trailer}`],
        ['commit.verbose=true']
      )
    ).code,
    0
  )
  // A message not edited is never cut: commit.verbose cuts under -m, but
  // `--no-verbose` (which the hook cannot see) keeps it all.
  assert.notEqual(
    (await commit(['-m', below], ['commit.verbose=true'])).code,
    0
  )
  assert.notEqual(
    (await commit(['--no-verbose', '-m', below], ['commit.verbose=true'])).code,
    0
  )
  assert.equal((await gitRun(['rev-parse', 'HEAD'], web)).code, 128)

  // An edited message (the editor a script that writes it): git cuts at
  // its exact line only, and so does the check.
  const editing = async (name: string, text: string): Promise<string> => {
    const file = join(web, '..', `${name}-msg`)
    await writeFile(file, text)
    return `cp "${file}"`
  }
  const spaced = below.replace(
    '>8 ------------------------',
    '>8 ------------------------ '
  )
  const kept = await commit([], ['commit.cleanup=scissors'], {
    GIT_EDITOR: await editing('spaced', `${spaced}\n`),
  })
  assert.notEqual(kept.code, 0)
  assert.match(
    kept.stderr,
    /rness: policy no-agent-trailers refused this commit/
  )
  assert.equal((await gitRun(['rev-parse', 'HEAD'], web)).code, 128)

  const cut = await commit([], ['commit.cleanup=scissors'], {
    GIT_EDITOR: await editing('exact', `${below}\n`),
  })
  assert.equal(cut.code, 0, cut.stderr)
  assert.equal(await log(), 'feat: x')
})

test("commit-msg through git: an edited verbose commit is cut at git's block, its diff not checked", async (t) => {
  const { web } = await workspace(t)
  await installHook(web, 'commit-msg')
  await put(web, 'a.md', `x ${DASH} y\n`)
  await git(['add', 'a.md'], web)
  // The editor keeps git's template (its scissors block, then the diff,
  // which holds the em dash) and writes the subject above it.
  const editor = join(web, '..', 'subject-editor')
  await writeFile(
    editor,
    '#!/bin/sh\n{ printf \'feat: x\\n\'; cat "$1"; } > "$1.new" && mv "$1.new" "$1"\n'
  )
  await chmod(editor, 0o755)
  const r = await gitRun(
    ['-c', 'commit.verbose=true', 'commit', '-q', '-v'],
    web,
    { GIT_EDITOR: editor }
  )
  assert.equal(r.code, 0, r.stderr)
  assert.equal((await git(['log', '-1', '--format=%B'], web)).trim(), 'feat: x')
})

test('commit-msg through git: a merge message is never cut, commit.verbose aside', async (t) => {
  const { web } = await workspace(t)
  await git(['commit', '-q', '--allow-empty', '-m', 'one'], web)
  await git(['checkout', '-q', '-b', 'side'], web)
  await git(['commit', '-q', '--allow-empty', '-m', 'side'], web)
  await git(['checkout', '-q', 'main'], web)
  await git(['commit', '-q', '--allow-empty', '-m', 'two'], web)
  await installHook(web, 'commit-msg')
  const merged = await gitRun(
    [
      '-c',
      'commit.verbose=true',
      'merge',
      '-q',
      '--no-ff',
      '-m',
      `merge side\n${SCISSORS}\nCo-Authored-By: Claude <noreply@anthropic.com>`,
      'side',
    ],
    web
  )
  assert.notEqual(merged.code, 0)
  assert.match(
    merged.stderr,
    /rness: policy no-agent-trailers refused this commit/
  )
  assert.equal((await git(['log', '-1', '--format=%s'], web)).trim(), 'two')
})

// --- pre-commit through git: the index git hands the hook -----------------------

test('pre-commit through git: git commit <path> is checked on its temporary index', async (t) => {
  const { web } = await workspace(t)
  await put(web, 'a.md', 'a\n')
  await put(web, 'b.md', 'b\n')
  await git(['add', '-A'], web)
  await git(['commit', '-q', '-m', 'init'], web)
  await installHook(web, 'pre-commit')
  // a.md staged with a refused line; b.md changed in the work tree only.
  await put(web, 'a.md', `a ${DASH}\n`)
  await git(['add', 'a.md'], web)
  await put(web, 'b.md', 'b, clean\n')
  // `git commit b.md` commits b.md alone, from a temporary index.
  const only = await gitRun(['commit', '-q', '-m', 'b only', 'b.md'], web)
  assert.equal(only.code, 0, only.stderr)
  assert.equal((await git(['log', '-1', '--format=%s'], web)).trim(), 'b only')
  // And the other way: the path committed holds the refused line.
  await put(web, 'b.md', `b ${DASH}\n`)
  const refused = await gitRun(['commit', '-q', '-m', 'b again', 'b.md'], web)
  assert.notEqual(refused.code, 0)
  assert.match(refused.stderr, /org\/web\/b\.md:1: b /)
  assert.doesNotMatch(refused.stderr, /a\.md/)
})

test('pre-commit through git: concluding a conflicted merge checks its resolution, never what either branch brought', async (t) => {
  const { web } = await workspace(t)
  const base = ['one', 'two', 'three', 'four', 'five', 'six', ''].join('\n')
  await put(web, 'a.md', base)
  await git(['add', 'a.md'], web)
  await git(['commit', '-q', '-m', 'base'], web)
  // The other branch brings a refused line into the conflicted file and a
  // file of its own; both were committed there, before any hook.
  await git(['checkout', '-q', '-b', 'side'], web)
  await put(web, 'a.md', `${base.replace('two', 'two, side')}side ${DASH}\n`)
  await put(web, 's.md', `from side ${DASH}\n`)
  await git(['add', 'a.md', 's.md'], web)
  await git(['commit', '-q', '-m', 'side'], web)
  await git(['checkout', '-q', 'main'], web)
  await put(web, 'a.md', base.replace('two', 'two, main'))
  await git(['add', 'a.md'], web)
  await git(['commit', '-q', '-m', 'main'], web)
  await installHook(web, 'pre-commit')

  const conclude = async (resolution: string): Promise<Ran> => {
    const merged = await gitRun(['merge', '-q', 'side'], web)
    assert.notEqual(merged.code, 0, 'the merge conflicts')
    await put(web, 'a.md', resolution)
    await git(['add', 'a.md'], web)
    return gitRun(['commit', '-q', '--no-edit'], web)
  }
  const kept = `${base.replace('two', 'two, main\ntwo, side')}side ${DASH}\n`
  const ok = await conclude(kept)
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(
    (await git(['log', '-1', '--format=%p'], web)).trim().split(' ').length,
    2
  )
  assert.deepEqual(await readRefusals(web), [])

  // A resolution that writes a refused line of its own is refused, alone.
  await git(['reset', '-q', '--hard', 'HEAD^1'], web)
  const refused = await conclude(
    `${base.replace('two', `two ${DASH} both`)}side ${DASH}\n`
  )
  assert.notEqual(refused.code, 0)
  assert.match(refused.stderr, /\n {2}org\/web\/a\.md:2: two /)
  assert.doesNotMatch(refused.stderr, /a\.md:8|s\.md/)
  assert.equal((await readRefusals(web)).length, 1)
})

// --- pre-push ------------------------------------------------------------------

async function remoteFor(t: TestContext, clone: string): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-remote-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  const bare = join(base, 'web.git')
  await git(['init', '-q', '--bare', '-b', 'main', bare], base)
  await git(['remote', 'add', 'origin', bare], clone)
  return bare
}

test('pre-push through git: a new branch and a fast-forward pass, a force push is refused', async (t) => {
  const { web } = await workspace(t)
  const bare = await remoteFor(t, web)
  await installHook(web, 'pre-push')
  const commit = (m: string) =>
    git(['commit', '-q', '--allow-empty', '-m', m], web)
  await commit('one')
  assert.equal((await gitRun(['push', '-q', 'origin', 'main'], web)).code, 0)
  await commit('two')
  assert.equal((await gitRun(['push', '-q', 'origin', 'main'], web)).code, 0)
  await git(['reset', '-q', '--hard', 'HEAD~1'], web)
  await commit('rewritten')
  const forced = await gitRun(['push', '-q', '-f', 'origin', 'main'], web)
  assert.notEqual(forced.code, 0)
  assert.match(forced.stderr, /rness: policy no-force-push refused this push\n/)
  assert.match(
    forced.stderr,
    /\n {2}refs\/heads\/main: non-fast-forward: remote [0-9a-f]{7} is not an ancestor of [0-9a-f]{7}\n/
  )
  assert.equal((await readRefusals(web))[0]?.by, 'pre-push')
  // A deletion passes.
  assert.equal(
    (await gitRun(['push', '-q', 'origin', 'HEAD:refs/heads/side'], web)).code,
    0
  )
  assert.equal(
    (await gitRun(['push', '-q', 'origin', ':refs/heads/side'], web)).code,
    0
  )
  assert.ok(bare.length > 0)
})

test('pre-push: a remote object not here is refused, with a fix to fetch first', async (t) => {
  const { web } = await workspace(t)
  await git(['commit', '-q', '--allow-empty', '-m', 'one'], web)
  const local = (await git(['rev-parse', 'HEAD'], web)).trim()
  const unknown = 'c'.repeat(40)
  const r = await check('pre-push', web, {
    args: ['origin', 'file:///x'],
    input: `refs/heads/main ${local} refs/heads/main ${unknown}\n`,
  })
  assert.equal(r.code, POLICY_REFUSED_EXIT)
  assert.match(
    r.err,
    /\n {2}refs\/heads\/main: remote object ccccccc is not here, so the push cannot be shown to be a fast-forward\n {2}fix: Fetch first, then push again\. /
  )
  // A new branch: the remote object is all zeros.
  assert.deepEqual(
    await check('pre-push', web, {
      input: `refs/heads/main ${local} refs/heads/new ${'0'.repeat(40)}\n`,
    }),
    { code: 0, err: '' }
  )
})

// --- failing open ----------------------------------------------------------------

test('a clone that holds no scope passes silently: nothing applies there', async (t) => {
  const { stray } = await workspace(t)
  await put(stray, 'a.md', `x ${DASH}\n`)
  await git(['add', 'a.md'], stray)
  assert.deepEqual(await check('pre-commit', stray), { code: 0, err: '' })
  await put(stray, 'msg', 'Co-Authored-By: Claude <noreply@anthropic.com>\n')
  assert.deepEqual(await check('commit-msg', stray, { args: ['msg'] }), {
    code: 0,
    err: '',
  })
  assert.deepEqual(await readRefusals(stray), [])
})

test('fails open with one line: no workspace, a broken rness.json, no repository, no hook', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-alone-')))
  t.after(() => rm(base, { recursive: true, force: true }))
  await git(['init', '-q', '-b', 'main'], base)
  await put(base, 'a.md', `x ${DASH}\n`)
  await git(['add', 'a.md'], base)
  assert.deepEqual(await check('pre-commit', base), {
    code: 0,
    err: `rness: policies not checked: .rness/ is not reachable from ${base}\n`,
  })

  const { root, stray } = await workspace(t)

  const plain = join(base, 'plain')
  await mkdir(plain)
  const outside = await check('pre-commit', plain, {
    env: { GIT_CEILING_DIRECTORIES: base },
  })
  assert.deepEqual(outside, {
    code: 0,
    err: 'rness: policies not checked: not in the work tree of a git repository\n',
  })

  assert.deepEqual(await check('post-merge', stray), {
    code: 0,
    err: 'rness: policies not checked: unknown hook "post-merge" (expected pre-commit, commit-msg, pre-push)\n',
  })
  assert.deepEqual(await check('commit-msg', join(root, 'org', 'web')), {
    code: 0,
    err: 'rness: policies not checked: no commit message file was given\n',
  })

  await writeFile(join(root, '.rness', 'rness.json'), '{ not json')
  const broken = await check('pre-commit', join(root, 'org', 'web'))
  assert.equal(broken.code, 0)
  assert.match(
    broken.err,
    /^rness: policies not checked: rness\.json: invalid JSON/
  )
  assert.equal(broken.err.split('\n').length, 2)
})

test('through the CLI: hidden, its own command (never installs, never delegates), git arguments taken as they come', async () => {
  assert.ok(OWN_COMMANDS.includes('policy'))
  const c = capture()
  const help = await run(['--help'])
  c.restore()
  assert.equal(help, 0)
  assert.doesNotMatch(c.out(), /policy/)
  const base = await realpath(await mkdtemp(join(tmpdir(), 'rness-cli-')))
  try {
    const { stderr } = await execFileP(
      process.execPath,
      [binPath, 'policy', 'check', 'pre-push', '--weird', 'file:///x'],
      {
        cwd: base,
        env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(base) },
      }
    )
    assert.equal(
      stderr,
      'rness: policies not checked: not in the work tree of a git repository\n'
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('contract 1: every hook fails open with one line naming upgrade, exit 0', async (t) => {
  const root = await makeContract1Workspace(t)
  const web = join(root, 'org', 'web')
  await git(['init', '-q', '-b', 'main'], web)
  // The same line whatever ran the hook: `upgrade` never delegates, so it
  // names the latest copy, not the runner of this one.
  const saved = process.env['npm_config_user_agent']
  t.after(() => {
    if (saved === undefined) delete process.env['npm_config_user_agent']
    else process.env['npm_config_user_agent'] = saved
  })
  process.env['npm_config_user_agent'] = 'pnpm/12.5.1 npm/? node/v24.0.0'
  for (const hook of ['pre-commit', 'commit-msg', 'pre-push']) {
    const r = await check(hook, web, { input: '' })
    assert.equal(r.code, 0, hook)
    assert.equal(
      r.err,
      'rness: policies not checked: rness.json is contract 1: run npx @rness/cli@latest upgrade\n',
      hook
    )
  }
})
