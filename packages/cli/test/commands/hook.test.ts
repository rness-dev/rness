import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { type TestContext, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { hookCommand } from '../../src/commands/hook.ts'
import { configDir } from '../../src/core/auth.ts'
import { OWN_COMMANDS } from '../../src/core/catch-up.ts'
import { presetTemplate } from '../../src/core/presets.ts'
import { recordFailure } from '../../src/pulse/detached.ts'
import { recordNotice } from '../../src/pulse/journal-state.ts'
import { VERSION } from '../../src/version.ts'
import { commitDir } from '../helpers/git.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const binPath = fileURLToPath(
  new URL('../../src/bin/rness.ts', import.meta.url)
)

const ADR = `---
status: Accepted
---

# 0006 — A workspace is a GitHub organisation
`
const spec = (status: string, title = '0001 — A spec') => `---
status: ${status}
---

# ${title}
`

async function workspace(
  t: TestContext,
  files: Record<string, string> = {},
  pulse?: { project: number }
) {
  return makeWorkspace(t, {
    org: 'acme',
    ...(pulse === undefined ? {} : { pulse }),
    repos: { web: { url: 'https://github.com/acme/web.git' } },
    scopes: { web: { path: 'org/web' } },
    files: {
      'standards/style.md': '# Style\n',
      'standards/web/seo.md': '# SEO\n',
      'adr/0006-org.md': ADR,
      ...files,
    },
    dirs: ['org/web'],
  })
}

interface Spawned {
  args: string[]
  cwd: string
}

interface Ran {
  code: number
  out: string
  err: string
}

/** Run a hook the way Claude Code does: its input as JSON on stdin. */
async function hook(
  event: string,
  input: unknown,
  env: NodeJS.ProcessEnv = {},
  spawned?: Spawned[],
  /** Runs when the mark is spawned: what the hook does after that sees it. */
  onSpawn?: () => void
): Promise<Ran> {
  let out = ''
  let err = ''
  const sink = (write: (s: string) => void) =>
    new Writable({
      write(chunk: Buffer, _enc, done) {
        write(chunk.toString())
        done()
      },
    })
  const code = await hookCommand(event, {
    input: Readable.from([
      typeof input === 'string' ? input : JSON.stringify(input),
    ]),
    output: sink((s) => (out += s)),
    error: sink((s) => (err += s)),
    env,
    // Always injected: a hook must never start a real process from a test.
    spawn: (args: string[], cwd: string) => {
      ;(spawned ?? []).push({ args, cwd })
      onSpawn?.()
    },
  })
  return { code, out, err }
}

// --- session-start (spec 0015 §3) --------------------------------------------

test('session start in a clone: a banner for the developer, the scope for the model', async (t) => {
  const root = await workspace(t)
  const r = await hook('session-start', {
    cwd: join(root, 'org', 'web'),
    source: 'startup',
  })
  assert.equal(r.code, 0)
  assert.equal(r.err, '')
  const answer = JSON.parse(r.out)
  assert.equal(
    answer.systemMessage,
    `rness ${VERSION} · acme · scope web — 2 standards, 1 decision`
  )
  assert.equal(answer.hookSpecificOutput.hookEventName, 'SessionStart')
  const context: string = answer.hookSpecificOutput.additionalContext
  assert.match(context, /^Workspace acme · scope web \(org\/web\)\n/)
  assert.match(context, /\nStandards \(2\):\n/)
  assert.match(
    context,
    /\n- 0006 Accepted — A workspace is a GitHub organisation — adr\/0006-org\.md\n/
  )
  assert.match(
    context,
    /\nThese documents are in \.\.\/\.\.\/\.rness: read one there, or with rness_read when the rness MCP server is connected\.$/
  )
})

test('after a compaction the context comes back, the banner does not', async (t) => {
  const root = await workspace(t)
  const r = await hook('session-start', { cwd: root, source: 'compact' })
  const answer = JSON.parse(r.out)
  assert.equal(answer.systemMessage, undefined)
  assert.match(
    answer.hookSpecificOutput.additionalContext,
    /^Workspace acme · global scope\n/
  )
})

test('the safety net: no workspace, a refused rness.json — said to both, exit 0', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-nows-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const none = await hook('session-start', { cwd: dir })
  assert.equal(none.code, 0)
  const a = JSON.parse(none.out)
  assert.equal(a.systemMessage, `rness: no rness workspace found above ${dir}`)
  assert.equal(
    a.hookSpecificOutput.additionalContext,
    `rness: no rness workspace found above ${dir}`
  )

  const root = await workspace(t)
  await writeFile(join(root, '.rness', 'rness.json'), '{ oops')
  const bad = JSON.parse(
    (await hook('session-start', { cwd: join(root, 'org', 'web') })).out
  )
  assert.match(bad.systemMessage, /^rness: rness\.json: invalid JSON/)
})

test('the safety net: a pin the installed copy does not match, and the problems validate would report', async (t) => {
  const root = await workspace(t, {
    'specs/0001-a.md': spec('Done'),
  })
  await writeFile(
    join(root, '.rness', 'package.json'),
    JSON.stringify({ devDependencies: { '@rness/cli': '9.9.9' } })
  )
  const answer = JSON.parse(
    (await hook('session-start', { cwd: join(root, 'org', 'web') })).out
  )
  const lines: string[] = answer.systemMessage.split('\n')
  assert.match(lines[0] ?? '', /^rness \S+ · acme · scope web — /)
  assert.deepEqual(lines.slice(1), [
    'rness: .rness pins @rness/cli 9.9.9 but nothing is installed — run npm install in .rness',
    'rness: 1 problem in the workspace context — run rness validate',
    'rness:   specs/0001-a.md: unknown status "Done" (expected Draft, Proposed, Approved, Implemented, Superseded, Rejected)',
  ])
  assert.match(
    answer.hookSpecificOutput.additionalContext,
    /\nrness: 1 problem in the workspace context — run rness validate\n/
  )
})

test('unreadable input: the project directory is used', async (t) => {
  const root = await workspace(t)
  const r = await hook('session-start', 'not json', {
    CLAUDE_PROJECT_DIR: join(root, 'org', 'web'),
  })
  assert.match(JSON.parse(r.out).systemMessage, / · scope web — /)
})

test('through the launcher: one JSON object on stdout, nothing around it', async (t) => {
  const root = await workspace(t)
  const child = spawn(process.execPath, [binPath, 'hook', 'session-start'], {
    cwd: join(root, 'org', 'web'),
    env: { ...process.env, RNESS_NO_DELEGATE: '' },
  })
  let out = ''
  child.stdout.on('data', (d: Buffer) => (out += d.toString()))
  child.stdin.end(
    JSON.stringify({ cwd: join(root, 'org', 'web'), source: 'startup' })
  )
  const code = await new Promise<number | null>((ok) => child.on('close', ok))
  assert.equal(code, 0)
  assert.match(out, /^\{.*\}\n$/s)
  assert.equal(out.split('\n').length, 2)
  assert.match(JSON.parse(out).systemMessage, /^rness /)
})

test('hook is served by the copy that runs it: no catch-up install, no delegation', () => {
  assert.ok(OWN_COMMANDS.includes('hook'))
})

test('an unknown event is refused', async () => {
  const r = await hook('pre-compact', {})
  assert.equal(r.code, 1)
  assert.match(r.err, /unknown hook event "pre-compact"/)
})

// --- post-tool-use (spec 0015 §4) --------------------------------------------

const edit = (file: string, cwd: string) => ({
  cwd,
  tool_name: 'Edit',
  tool_input: { file_path: file },
})

test('an edit outside .rness, or with no path, or under node_modules: exit 0, silent', async (t) => {
  const root = await workspace(t, { 'specs/0001-a.md': spec('Done') })
  const web = join(root, 'org', 'web')
  for (const input of [
    edit(join(web, 'src', 'app.ts'), web),
    { cwd: web, tool_name: 'Write', tool_input: {} },
    edit(join(root, '.rness', 'node_modules', 'x', 'README.md'), web),
    edit(join(root, '.rness', '.git', 'config'), web),
  ])
    assert.deepEqual(await hook('post-tool-use', input), {
      code: 0,
      out: '',
      err: '',
    })
})

test("a valid edit is silent; a broken one gets that file's problems back, exit 2", async (t) => {
  const root = await workspace(t, {
    'specs/0001-a.md': spec('Approved'),
    'specs/0002-b.md': spec('Nope', '0002 — Another'),
  })
  const web = join(root, 'org', 'web')
  const file = join(root, '.rness', 'specs', '0001-a.md')
  assert.deepEqual(await hook('post-tool-use', edit(file, web)), {
    code: 0,
    out: '',
    err: '',
  })

  await writeFile(file, spec('Done'))
  const r = await hook('post-tool-use', edit(file, web))
  assert.equal(r.code, 2)
  assert.equal(r.out, '')
  assert.equal(
    r.err,
    'rness: specs/0001-a.md: unknown status "Done" (expected Draft, Proposed, Approved, Implemented, Superseded, Rejected)\n' +
      'Fix it in specs/0001-a.md; rness validate checks the whole workspace.\n'
  )
  // A path relative to the session's directory works too.
  const relative = await hook(
    'post-tool-use',
    edit('../../.rness/specs/0001-a.md', web)
  )
  assert.equal(relative.code, 2)
})

test('an edit that gives a document the number of another: exit 2, that file named', async (t) => {
  const root = await workspace(t, {
    'specs/0029-a.md': spec('Draft', '0029 — A'),
    'specs/0029-b.md': spec('Draft', '0029 — B'),
  })
  const web = join(root, 'org', 'web')
  const r = await hook(
    'post-tool-use',
    edit(join(root, '.rness', 'specs', '0029-b.md'), web)
  )
  assert.equal(r.code, 2)
  assert.equal(
    r.err,
    'rness: specs/0029-b.md: the number 0029 is also that of specs/0029-a.md\n' +
      'Fix it in specs/0029-b.md; rness validate checks the whole workspace.\n'
  )
})

test('a plan written without a number: exit 2, the next number given', async (t) => {
  const root = await workspace(t, {
    'plans/0001-a.md': spec('Completed', '0001 — A'),
    'plans/2026-10-02-copy-fix.md': spec('Draft', 'Copy fix'),
  })
  const web = join(root, 'org', 'web')
  const r = await hook(
    'post-tool-use',
    edit(join(root, '.rness', 'plans', '2026-10-02-copy-fix.md'), web)
  )
  assert.equal(r.code, 2)
  assert.equal(
    r.err,
    'rness: plans/2026-10-02-copy-fix.md: not numbered; name it 0002-<slug>.md, the next number of plans\n' +
      'Fix it in plans/2026-10-02-copy-fix.md; rness validate checks the whole workspace.\n'
  )
})

test('an edit of rness.json that rness refuses: exit 2 with the reason', async (t) => {
  const root = await workspace(t)
  const file = join(root, '.rness', 'rness.json')
  await writeFile(file, JSON.stringify({ contract: 1, repos: {}, scope: {} }))
  const r = await hook('post-tool-use', edit(file, root))
  assert.equal(r.code, 2)
  assert.match(r.err, /^rness: rness\.json: unknown key "scope"\n/)
})

test('an edit elsewhere in .rness (a script, a README at the root) is not checked', async (t) => {
  const root = await workspace(t)
  await mkdir(join(root, '.rness', 'scripts'))
  const file = join(root, '.rness', 'scripts', 'x.mjs')
  await writeFile(file, '')
  assert.equal((await hook('post-tool-use', edit(file, root))).code, 0)
})

// --- the pulse (spec 0017 §5) ------------------------------------------------

const plan = (status: string) => `---
status: ${status}
---

# 0026 — A plan
`
const PULSE_FILES = {
  'plans/0026-cli-pulse.md': plan('In progress'),
  'plans/web/0027-web.md': plan('In progress'),
  'plans/0028-done.md': plan('Completed'),
}
const ID = '1a2b3c4d-5e6f-7a8b-9c0d-e1f2a3b4c5d6'

test('session start with a pulse: marks the plans in progress of the scope, detached; the answer is unchanged', async (t) => {
  const root = await workspace(t, PULSE_FILES, { project: 7 })
  const web = join(root, 'org', 'web')
  const spawned: Spawned[] = []
  const r = await hook(
    'session-start',
    { cwd: web, source: 'startup', session_id: ID },
    {},
    spawned
  )
  assert.equal(r.code, 0)
  assert.deepEqual(spawned, [
    {
      cwd: root,
      // The run finds the documents itself, from the scope (spec 0032 §4).
      args: [
        'pulse',
        'run',
        'session-start',
        '--session',
        'claude · 1a2b3c4d',
        '--scope',
        'web',
      ],
    },
  ])
  assert.deepEqual(
    JSON.parse(r.out),
    JSON.parse(
      (
        await hook('session-start', {
          cwd: web,
          source: 'startup',
          session_id: ID,
        })
      ).out
    )
  )
})

test('session start of a subagent: its type is in the session', async (t) => {
  const root = await workspace(t, PULSE_FILES, { project: 7 })
  const spawned: Spawned[] = []
  await hook(
    'session-start',
    { cwd: root, session_id: ID, agent_type: 'reviewer' },
    {},
    spawned
  )
  assert.deepEqual(spawned[0]?.args.slice(0, 5), [
    'pulse',
    'run',
    'session-start',
    '--session',
    'claude · reviewer · 1a2b3c4d',
  ])
})

test('no pulse declared, no session, or no plan in progress: nothing is spawned', async (t) => {
  const spawned: Spawned[] = []
  const none = await workspace(t, PULSE_FILES)
  await hook('session-start', { cwd: none, session_id: ID }, {}, spawned)
  await hook(
    'post-tool-use',
    edit(join(none, '.rness', 'plans', '0026-cli-pulse.md'), none),
    {},
    spawned
  )
  await hook('session-end', { cwd: none, session_id: ID }, {}, spawned)
  const idle = await workspace(
    t,
    { 'plans/0028-done.md': plan('Completed') },
    { project: 7 }
  )
  await hook('session-start', { cwd: idle, session_id: ID }, {}, spawned)
  const pulse = await workspace(t, PULSE_FILES, { project: 7 })
  await hook('session-start', { cwd: pulse }, {}, spawned)
  assert.deepEqual(spawned, [])
})

test('post-tool-use marks the edited document, after the check; outside .rness, nothing', async (t) => {
  const root = await workspace(
    t,
    { 'specs/0001-a.md': spec('Approved') },
    { project: 7 }
  )
  const web = join(root, 'org', 'web')
  const spawned: Spawned[] = []
  const file = join(root, '.rness', 'specs', '0001-a.md')
  const input = { ...edit(file, web), session_id: ID }
  assert.equal((await hook('post-tool-use', input, {}, spawned)).code, 0)
  assert.deepEqual(spawned, [
    {
      cwd: root,
      args: [
        'pulse',
        'run',
        'edit',
        '--session',
        'claude · 1a2b3c4d',
        '--path',
        'specs/0001-a.md',
      ],
    },
  ])
  spawned.length = 0
  await hook(
    'post-tool-use',
    { ...edit(join(web, 'src', 'app.ts'), web), session_id: ID },
    {},
    spawned
  )
  assert.deepEqual(spawned, [])
})

test('post-tool-use checks the edit before it marks it; a broken edit is marked too', async (t) => {
  const root = await workspace(
    t,
    { 'specs/0001-a.md': spec('Approved') },
    { project: 7 }
  )
  const file = join(root, '.rness', 'specs', '0001-a.md')
  const input = { ...edit(file, root), session_id: ID }
  // Whatever the file holds once the mark is started is not what was checked.
  const breakIt = () => writeFileSync(file, spec('Done'))
  const valid = await hook('post-tool-use', input, {}, [], breakIt)
  assert.deepEqual(valid, { code: 0, out: '', err: '' })

  const spawned: Spawned[] = []
  const broken = await hook('post-tool-use', input, {}, spawned)
  assert.equal(broken.code, 2)
  assert.match(broken.err, /^rness: specs\/0001-a\.md: unknown status "Done"/)
  assert.equal(spawned.length, 1)
})

test('session end spawns the clearing mark, and says nothing', async (t) => {
  const root = await workspace(t, {}, { project: 7 })
  const spawned: Spawned[] = []
  const r = await hook(
    'session-end',
    { cwd: root, session_id: ID },
    {},
    spawned
  )
  assert.deepEqual(r, { code: 0, out: '', err: '' })
  assert.deepEqual(spawned, [
    {
      cwd: root,
      args: ['pulse', 'run', 'session-end', '--session', 'claude · 1a2b3c4d'],
    },
  ])
})

test('a failure recorded by an earlier mark is in the next session start, once', async (t) => {
  const root = await workspace(t)
  const reason = 'the pulse needs the project scope: run rness login'
  await recordFailure(reason)
  const line = `rness: pulse not updated — ${reason}`
  const first = JSON.parse((await hook('session-start', { cwd: root })).out)
  assert.ok(first.systemMessage.split('\n').includes(line))
  assert.ok(
    first.hookSpecificOutput.additionalContext.split('\n').includes(line)
  )
  const second = JSON.parse((await hook('session-start', { cwd: root })).out)
  assert.doesNotMatch(second.systemMessage, /pulse not updated/)
  assert.doesNotMatch(
    second.hookSpecificOutput.additionalContext,
    /pulse not updated/
  )
})

// --- a Claude Code too old for the mod (plan 0041) ---------------------------

const TOO_OLD =
  'rness: Claude Code 2.1.240 shows no rness band, footer label or pane; 2.1.280 or later does — claude update'

/** No version told yet: the file the hook records them in, removed. */
const noneTold = () =>
  rm(join(configDir(), 'claude-code.json'), { force: true })

test('a Claude Code too old for the mod: the line for the developer, after the banner, once', async (t) => {
  const root = await workspace(t)
  await noneTold()
  const env = { AI_AGENT: 'claude-code_2-1-240_harness' }
  const first = JSON.parse(
    (await hook('session-start', { cwd: root, source: 'startup' }, env)).out
  )
  const lines: string[] = first.systemMessage.split('\n')
  assert.match(lines[0] ?? '', /^rness \S+ · acme · global scope — /)
  assert.deepEqual(lines.slice(1), [TOO_OLD])
  assert.doesNotMatch(
    first.hookSpecificOutput.additionalContext,
    /Claude Code 2\.1\.240/
  )
  const second = JSON.parse(
    (await hook('session-start', { cwd: root, source: 'startup' }, env)).out
  )
  assert.equal(second.systemMessage.split('\n').length, 1)
  assert.doesNotMatch(second.systemMessage, /Claude Code/)
})

test('after a compaction, a Claude Code too old for the mod is not told: the next start tells it', async (t) => {
  const root = await workspace(t)
  await noneTold()
  const env = { AI_AGENT: 'claude-code_2-1-240_harness' }
  const compact = JSON.parse(
    (await hook('session-start', { cwd: root, source: 'compact' }, env)).out
  )
  assert.equal(compact.systemMessage, undefined)
  const start = JSON.parse(
    (await hook('session-start', { cwd: root, source: 'startup' }, env)).out
  )
  assert.deepEqual(start.systemMessage.split('\n').slice(1), [TOO_OLD])
})

test('a Claude Code at or above the floor, or no AI_AGENT: no line', async (t) => {
  const root = await workspace(t)
  await noneTold()
  for (const env of [{ AI_AGENT: 'claude-code_2-1-289_harness' }, {}]) {
    const answer = JSON.parse(
      (await hook('session-start', { cwd: root, source: 'startup' }, env)).out
    )
    assert.equal(answer.systemMessage.split('\n').length, 1)
    assert.doesNotMatch(answer.systemMessage, /Claude Code/)
  }
})

// --- pre-tool-use (spec 0029 §4) ----------------------------------------------

const AGENTS = `# Web

Notes.

<!-- BEGIN rness -->
<!-- rness · scope: web · contract: 1 · hash: 0123456789ab · generated: run \`rness sync\`, never edit inside this block -->
This directory is scope \`web\`.

## Rules
<!-- rness: standards/style.md -->
# Style
Use tabs.

<!-- rness: standards/web/seo.md -->
# SEO
Titles matter.
<!-- END rness -->

Tail.
`

/** A workspace whose clone `org/web` carries a block, as `sync` writes it. */
async function guarded(t: TestContext, files: Record<string, string> = {}) {
  const root = await workspace(t, files)
  await writeFile(join(root, 'org', 'web', 'AGENTS.md'), AGENTS)
  return root
}

const editOf = (
  file: string,
  cwd: string,
  old_string: string,
  new_string: string,
  replace_all?: boolean
) => ({
  cwd,
  tool_name: 'Edit',
  tool_input: {
    file_path: file,
    old_string,
    new_string,
    ...(replace_all === undefined ? {} : { replace_all }),
  },
})

const writeOf = (file: string, cwd: string, content: string) => ({
  cwd,
  tool_name: 'Write',
  tool_input: { file_path: file, content },
})

test('pre-tool-use: an Edit inside the block is refused, its source named', async (t) => {
  const root = await guarded(t)
  const web = join(root, 'org', 'web')
  const r = await hook(
    'pre-tool-use',
    editOf(join(web, 'AGENTS.md'), web, 'Titles matter.', 'Titles rule.')
  )
  assert.equal(r.code, 2)
  assert.equal(
    r.err,
    'rness: lines 5–17 of org/web/AGENTS.md are generated by rness sync from .rness/standards/web/seo.md. Edit that file, then run rness sync.\n'
  )
})

test('pre-tool-use: an Edit of the block above any rule names .rness and rness.json', async (t) => {
  const root = await guarded(t)
  const web = join(root, 'org', 'web')
  const r = await hook(
    'pre-tool-use',
    editOf(join(web, 'AGENTS.md'), web, 'is scope `web`', 'is the web')
  )
  assert.equal(r.code, 2)
  assert.match(r.err, / from \.rness\/ and rness\.json\. /)
})

test('pre-tool-use: an Edit outside the block passes', async (t) => {
  const root = await guarded(t)
  const web = join(root, 'org', 'web')
  const r = await hook(
    'pre-tool-use',
    editOf(join(web, 'AGENTS.md'), web, 'Notes.', 'More notes.')
  )
  assert.deepEqual(r, { code: 0, out: '', err: '' })
})

test('pre-tool-use: an old_string found twice passes unless replace_all, as the Edit tool decides', async (t) => {
  const root = await guarded(t, {})
  const web = join(root, 'org', 'web')
  await writeFile(join(web, 'AGENTS.md'), AGENTS.replace('Tail.', 'Use tabs.'))
  const once = await hook(
    'pre-tool-use',
    editOf(join(web, 'AGENTS.md'), web, 'Use tabs.', 'Use spaces.')
  )
  assert.equal(once.code, 0, 'the tool refuses an ambiguous old_string itself')
  const all = await hook(
    'pre-tool-use',
    editOf(join(web, 'AGENTS.md'), web, 'Use tabs.', 'Use spaces.', true)
  )
  assert.equal(all.code, 2)
  assert.match(all.err, /from \.rness\/standards\/style\.md\./)
})

test('pre-tool-use: an old_string not found passes', async (t) => {
  const root = await guarded(t)
  const web = join(root, 'org', 'web')
  const r = await hook(
    'pre-tool-use',
    editOf(join(web, 'AGENTS.md'), web, 'nowhere', 'x')
  )
  assert.equal(r.code, 0)
})

test('pre-tool-use: a Write that keeps the block byte for byte passes; one that changes or drops it is refused', async (t) => {
  const root = await guarded(t)
  const web = join(root, 'org', 'web')
  const file = join(web, 'AGENTS.md')
  assert.equal(
    (
      await hook(
        'pre-tool-use',
        writeOf(file, web, AGENTS.replace('Notes.', 'More notes.'))
      )
    ).code,
    0
  )
  const changed = await hook(
    'pre-tool-use',
    writeOf(file, web, AGENTS.replace('Titles matter.', 'Titles rule.'))
  )
  assert.equal(changed.code, 2)
  assert.match(changed.err, /from \.rness\/standards\/web\/seo\.md\./)
  const dropped = await hook(
    'pre-tool-use',
    writeOf(file, web, '# Web\n\nNotes.\n')
  )
  assert.equal(dropped.code, 2)
  assert.match(dropped.err, /^rness: lines 5–17 of org\/web\/AGENTS\.md /)
})

test('pre-tool-use: a file of the rness plugin is refused, in a clone and at the root', async (t) => {
  const root = await guarded(t)
  const web = join(root, 'org', 'web')
  for (const [cwd, file, label] of [
    [
      web,
      join(web, '.claude', 'skills', 'rness', 'skills', 'status', 'SKILL.md'),
      'org/web/.claude/skills/rness/skills/status/SKILL.md',
    ],
    [
      root,
      join(root, '.claude', 'skills', 'rness', 'hooks', 'register.tsx'),
      '.claude/skills/rness/hooks/register.tsx',
    ],
  ] as const) {
    const r = await hook('pre-tool-use', writeOf(file, cwd, 'mine'))
    assert.equal(r.code, 2, label)
    assert.equal(
      r.err,
      `rness: ${label} is written whole by rness sync, and the next sync overwrites it. Leave it to rness.\n`
    )
  }
})

test('pre-tool-use: an Edit that breaks the contract of a document is refused before it is written', async (t) => {
  const root = await guarded(t, { 'specs/0001-a.md': spec('Draft') })
  const file = join(root, '.rness', 'specs', '0001-a.md')
  const r = await hook(
    'pre-tool-use',
    editOf(file, root, 'status: Draft', 'status: Done')
  )
  assert.equal(r.code, 2)
  assert.equal(
    r.err,
    [
      'rness: specs/0001-a.md: unknown status "Done" (expected Draft, Proposed, Approved, Implemented, Superseded, Rejected)',
      'Fix the edit of specs/0001-a.md; rness validate checks the whole workspace.',
      '',
    ].join('\n')
  )
})

test('pre-tool-use: a document already broken can still be edited, when the edit adds no problem', async (t) => {
  const root = await guarded(t, { 'specs/0001-a.md': spec('Done') })
  const file = join(root, '.rness', 'specs', '0001-a.md')
  const r = await hook(
    'pre-tool-use',
    editOf(file, root, '# 0001 — A spec', '# 0001 — A better spec')
  )
  assert.deepEqual(r, { code: 0, out: '', err: '' })
})

test('pre-tool-use: a new plan without a number is refused before it lands', async (t) => {
  const root = await guarded(t)
  const file = join(root, '.rness', 'plans', 'draft.md')
  const r = await hook(
    'pre-tool-use',
    writeOf(file, root, spec('Draft', 'A draft'))
  )
  assert.equal(r.code, 2)
  assert.match(
    r.err,
    /^rness: plans\/draft\.md: not numbered; name it 0001-<slug>\.md/
  )
})

test('pre-tool-use: a Write of rness.json that is not JSON is refused', async (t) => {
  const root = await guarded(t)
  const file = join(root, '.rness', 'rness.json')
  const r = await hook('pre-tool-use', writeOf(file, root, '{ oops'))
  assert.equal(r.code, 2)
  assert.match(r.err, /^rness: rness\.json: invalid JSON/)
})

test('pre-tool-use: outside a workspace, or with no path, exit 0 and silent', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-nows-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  for (const input of [
    writeOf(join(dir, 'AGENTS.md'), dir, 'x'),
    { cwd: dir, tool_name: 'Write', tool_input: {} },
    'not json',
  ])
    assert.deepEqual(await hook('pre-tool-use', input), {
      code: 0,
      out: '',
      err: '',
    })
})

test('pre-tool-use: straight quotes for the block’s curly ones are matched as the Edit tool matches them, and refused', async (t) => {
  const root = await guarded(t)
  const web = join(root, 'org', 'web')
  await writeFile(
    join(web, 'AGENTS.md'),
    AGENTS.replace('Titles matter.', 'The product’s titles matter.')
  )
  const r = await hook(
    'pre-tool-use',
    editOf(
      join(web, 'AGENTS.md'),
      web,
      "The product's titles matter.",
      'Titles rule.'
    )
  )
  assert.equal(r.code, 2)
  assert.match(r.err, /from \.rness\/standards\/web\/seo\.md\./)
})

// --- what a session does to a board, declared (spec 0032, plan 0046) --------

/** A workspace whose rness.json declares `projects` as given. */
async function declaredBoards(
  t: TestContext,
  projects: Record<string, unknown>,
  files: Record<string, string> = {}
) {
  const root = await workspace(t, files)
  const file = join(root, '.rness', 'rness.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...manifest, projects }))
  return root
}
const pulseWith = (over: Record<string, unknown> = {}) => ({
  number: 7,
  ...presetTemplate('agent-pulse/1', { collection: 'pulse' }),
  ...over,
})
const marketingWith = (over: Record<string, unknown> = {}) => ({
  number: 8,
  ...presetTemplate('collection/1', { collection: 'marketing' }),
  ...over,
})

test('an edit spawns a run only for a board that declares mark and holds the document; outside every board, or rness.json, nothing', async (t) => {
  const root = await declaredBoards(
    t,
    {
      marketing: marketingWith({ hooks: { edit: ['mark'] } }),
      pulse: pulseWith({ hooks: {} }),
    },
    {
      'marketing/a.md': '---\nstatus: Idea\n---\n# A\n',
      'specs/0001-a.md': spec('Approved'),
    }
  )
  const spawned: Spawned[] = []
  const editing = (rel: string) =>
    hook(
      'post-tool-use',
      {
        ...edit(join(root, '.rness', ...rel.split('/')), root),
        session_id: ID,
      },
      {},
      spawned
    )
  await editing('marketing/a.md')
  assert.deepEqual(
    spawned.map((s) => s.args.slice(0, 3)),
    [['pulse', 'run', 'edit']]
  )
  spawned.length = 0
  await editing('specs/0001-a.md')
  await editing('rness.json')
  await editing('standards/style.md')
  assert.deepEqual(
    spawned,
    [],
    'Agent Pulse declares no mark; no board holds the rest'
  )
})

test('no hooks declared on any board: nothing spawned at any event', async (t) => {
  const root = await declaredBoards(
    t,
    { pulse: pulseWith({ hooks: {} }) },
    PULSE_FILES
  )
  const spawned: Spawned[] = []
  await hook('session-start', { cwd: root, session_id: ID }, {}, spawned)
  await hook(
    'post-tool-use',
    {
      ...edit(join(root, '.rness', 'plans', '0026-cli-pulse.md'), root),
      session_id: ID,
    },
    {},
    spawned
  )
  await hook('session-end', { cwd: root, session_id: ID }, {}, spawned)
  assert.deepEqual(spawned, [])
})

test('a board rness.json refuses runs nothing, and the session start names it', async (t) => {
  const root = await declaredBoards(
    t,
    { pulse: pulseWith({ views: [] }) },
    PULSE_FILES
  )
  const spawned: Spawned[] = []
  const r = await hook(
    'session-start',
    { cwd: root, source: 'startup', session_id: ID },
    {},
    spawned
  )
  assert.deepEqual(spawned, [])
  assert.match(
    JSON.parse(r.out).systemMessage,
    /"projects\.pulse\.views" must list at least one view/
  )
})

// --- the journal at session start (spec 0030 §6, §7) ----------------------------

const journalBoard = (to: 'plan' | 'repo', limit?: number) =>
  pulseWith({
    hooks: {
      'session-start': [
        {
          action: 'journal',
          to,
          ...(limit === undefined ? {} : { limit }),
        },
      ],
      'session-end': ['journal-summary'],
    },
  })

const contextOf = (r: Ran): string =>
  JSON.parse(r.out).hookSpecificOutput.additionalContext as string

test('journal "repo": the model is told how to write it, with its session and its plan; the pull request sentence', async (t) => {
  const root = await declaredBoards(
    t,
    { pulse: journalBoard('repo', 3) },
    {
      'plans/web/0027-web.md': plan('In progress'),
    }
  )
  const r = await hook('session-start', {
    cwd: join(root, 'org', 'web'),
    source: 'startup',
    session_id: ID,
  })
  const context = contextOf(r)
  assert.ok(
    context.includes(
      'Journal: post a note with `rness pulse note` (or rness_note, its session "claude · 1a2b3c4d") when you choose an approach, deviate from plan plans/web/0027-web.md, are blocked, and when done. At most 3: decisions and their reasons, not steps. The first note prints the issue to reference; the pull request that completes this plan here carries `Closes <issue>`, an earlier one `Refs <issue>`.'
    ),
    context
  )
  assert.doesNotMatch(
    JSON.parse(r.out).systemMessage ?? '',
    /Journal:/,
    "the banner is the developer's: unchanged"
  )
})

test('journal "plan": the same, without the pull request sentence; no plan in progress, or no journal: no line', async (t) => {
  const root = await declaredBoards(
    t,
    { pulse: journalBoard('plan') },
    {
      'plans/0026-a.md': plan('In progress'),
      'plans/0029-b.md': plan('In progress'),
    }
  )
  const context = contextOf(
    await hook('session-start', {
      cwd: root,
      source: 'startup',
      session_id: ID,
    })
  )
  assert.match(context, /Journal: post a note with `rness pulse note`/)
  assert.match(
    context,
    /deviate from plan plans\/0026-a\.md or plans\/0029-b\.md \(pass --plan\)/
  )
  assert.doesNotMatch(context, /Closes/)
  const idle = await declaredBoards(
    t,
    { pulse: journalBoard('plan') },
    {
      'plans/0028-done.md': plan('Completed'),
    }
  )
  assert.doesNotMatch(
    contextOf(await hook('session-start', { cwd: idle, session_id: ID })),
    /Journal:/
  )
  const none = await declaredBoards(t, { pulse: pulseWith() }, PULSE_FILES)
  assert.doesNotMatch(
    contextOf(await hook('session-start', { cwd: none, session_id: ID })),
    /Journal:/
  )
})

test("the session's start is recorded in the clone it works in, for the summary; a fallback of the journal is said once", async (t) => {
  const root = await declaredBoards(
    t,
    { pulse: journalBoard('repo') },
    PULSE_FILES
  )
  const web = join(root, 'org', 'web')
  await writeFile(join(web, 'a.md'), 'a\n')
  await commitDir(web)
  await recordNotice(
    "journal — acme/web takes no issues, notes go to the plan's issue"
  )
  const first = JSON.parse(
    (
      await hook('session-start', {
        cwd: web,
        source: 'startup',
        session_id: ID,
      })
    ).out
  )
  const recorded = JSON.parse(
    readFileSync(join(web, '.git', 'rness', 'sessions', '1a2b3c4d'), 'utf8')
  )
  assert.match(recorded.head, /^[0-9a-f]{40}$/)
  assert.equal(typeof recorded.at, 'number')
  assert.ok(
    first.systemMessage
      .split('\n')
      .includes(
        "rness: journal — acme/web takes no issues, notes go to the plan's issue"
      )
  )
  const again = JSON.parse(
    (
      await hook('session-start', {
        cwd: web,
        source: 'startup',
        session_id: ID,
      })
    ).out
  )
  assert.doesNotMatch(again.systemMessage ?? '', /takes no issues/)
  assert.deepEqual(
    JSON.parse(
      readFileSync(join(web, '.git', 'rness', 'sessions', '1a2b3c4d'), 'utf8')
    ),
    recorded,
    'a resumed session keeps its first start'
  )
})

test('session end with a summary declared: the run told the scope and the clone the session worked in; at the root, neither', async (t) => {
  const root = await declaredBoards(
    t,
    { pulse: journalBoard('repo') },
    PULSE_FILES
  )
  const spawned: Spawned[] = []
  const web = join(root, 'org', 'web')
  await hook('session-end', { cwd: web, session_id: ID }, {}, spawned)
  await hook('session-end', { cwd: root, session_id: ID }, {}, spawned)
  assert.deepEqual(
    spawned.map((s) => s.args),
    [
      [
        'pulse',
        'run',
        'session-end',
        '--session',
        'claude · 1a2b3c4d',
        '--scope',
        'web',
        '--clone',
        'web',
      ],
      ['pulse', 'run', 'session-end', '--session', 'claude · 1a2b3c4d'],
    ]
  )
})
