import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { type TestContext, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { hookCommand } from '../../src/commands/hook.ts'
import { OWN_COMMANDS } from '../../src/core/catch-up.ts'
import { recordFailure } from '../../src/pulse/detached.ts'
import { VERSION } from '../../src/version.ts'
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
  spawned?: Spawned[]
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
    spawn: (args: string[], cwd: string) => (spawned ?? []).push({ args, cwd }),
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
      args: [
        'pulse',
        'mark',
        '--session',
        'claude · 1a2b3c4d',
        '--path',
        'plans/web/0027-web.md',
        '--path',
        'plans/0026-cli-pulse.md',
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
  assert.deepEqual(spawned[0]?.args.slice(0, 4), [
    'pulse',
    'mark',
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
        'mark',
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
      args: ['pulse', 'mark', '--end', '--session', 'claude · 1a2b3c4d'],
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
