import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { type TestContext, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as boardCommand from '../../src/commands/board.ts'
import { hookCommand } from '../../src/commands/hook.ts'
import type { Terminal } from '../../src/core/terminal.ts'
import { capture } from '../helpers/capture.ts'
import { type Reply, withEnv } from '../helpers/fake-github.ts'
import { board } from '../helpers/fake-project.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

// The golden session (plan 0046, task 1): what one Claude Code session
// writes on Agent Pulse — its start, an edit of a document, its end — as
// 0.20.1's hooks write it, recorded before the hooks became declared
// actions. Each process a hook would start is run here, in turn.
// `RNESS_GOLDEN=write` records the fixture again.

const FIXTURE = fileURLToPath(
  new URL('../fixtures/sessions/agent-pulse.json', import.meta.url)
)
const WRITE = process.env['RNESS_GOLDEN'] === 'write'

const NO_TTY: Terminal = {
  isTty: () => false,
  prompts: async () => {
    throw new Error('no prompt without a terminal')
  },
}
const asUser = (r: { method: string; path: string }): Reply | undefined =>
  r.method === 'GET' && r.path === '/user'
    ? {
        json: { login: 'octo' },
        headers: { 'X-OAuth-Scopes': 'repo, read:org, project' },
      }
    : undefined

async function machine(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-golden-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  withEnv(t, { XDG_CONFIG_HOME: dir, GITHUB_TOKEN: 'tok', GH_TOKEN: undefined })
}

const doc = (status: string, title: string) =>
  `---\nstatus: ${status}\n---\n\n# ${title}\n`
const FILES = {
  'adr/0001-org.md': doc('Accepted', '0001 — A workspace is an org'),
  'specs/0001-a.md': doc('Draft', '0001 — First'),
  'plans/0001-x.md': doc('In progress', '0001 — Do it'),
  'plans/0002-y.md': doc('In progress', '0002 — Do that'),
  'plans/0003-z.md': doc('Completed', '0003 — Done'),
}
const ID = '1a2b3c4d-5e6f-7a8b-9c0d-e1f2a3b4c5d6'

/** A hook as Claude Code runs it; the processes it would start, returned. */
async function hook(event: string, input: unknown): Promise<string[][]> {
  const spawned: string[][] = []
  const sink = new Writable({
    write(_chunk, _enc, done) {
      done()
    },
  })
  await hookCommand(event, {
    input: Readable.from([JSON.stringify(input)]),
    output: sink,
    error: sink,
    env: {},
    spawn: (args) => spawned.push(args),
  })
  return spawned
}

/** A process a hook starts (`board run …`), run in this one. */
async function runSpawned(args: string[], cwd: string, githubApi: string) {
  const values = (flag: string) =>
    args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ''] : []))
  const session = values('--session')[0] ?? ''
  const c = capture()
  try {
    if (args[0] === 'board' && args[1] === 'run')
      await boardCommand.boardRunCommand({
        cwd,
        githubApi,
        event: args[2] ?? '',
        session,
        paths: values('--path'),
        ...(values('--scope')[0] === undefined
          ? {}
          : { scope: values('--scope')[0] }),
      })
    else throw new Error(`no such process in this test: ${args.join(' ')}`)
  } finally {
    c.restore()
  }
}

test('golden: a session writes on Agent Pulse what 0.20.1 writes — its start, an edit, its end', async (t) => {
  await machine(t)
  const g = await board(t, {
    other: asUser,
    memory: { label: false, linked: false },
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    files: FILES,
  })
  const c = capture()
  try {
    assert.equal(
      await boardCommand.boardPushCommand(
        { cwd, yes: true, githubApi: g.base },
        { terminal: NO_TTY }
      ),
      0
    )
  } finally {
    c.restore()
  }
  g.mutations.length = 0

  const session = async (event: string, input: unknown) => {
    for (const args of await hook(event, input))
      await runSpawned(args, cwd, g.base)
  }
  await session('session-start', { cwd, source: 'startup', session_id: ID })
  const spec = join(cwd, '.rness', 'specs', '0001-a.md')
  await writeFile(spec, doc('Proposed', '0001 — First'))
  await session('post-tool-use', {
    cwd,
    session_id: ID,
    tool_name: 'Edit',
    tool_input: { file_path: spec },
  })
  await session('session-end', { cwd, session_id: ID })

  const written = g.mutations.map((m) => ({
    op: m.op,
    variables: m.variables,
  }))
  if (WRITE) {
    await writeFile(FIXTURE, `${JSON.stringify(written, null, 2)}\n`)
    return
  }
  assert.deepEqual(written, JSON.parse(await readFile(FIXTURE, 'utf8')))
})
