import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import {
  pulseCreateCommand,
  pulseMarkCommand,
  pulseSyncCommand,
} from '../../src/commands/pulse.ts'
import type { Prompts, Terminal } from '../../src/core/terminal.ts'
import { takeFailure } from '../../src/pulse/detached.ts'
import { capture } from '../helpers/capture.ts'
import { type Reply, withEnv } from '../helpers/fake-github.ts'
import { type FField, type FItem, board } from '../helpers/fake-project.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const doc = (status: string, title: string) =>
  `---\nstatus: ${status}\n---\n\n# ${title}\n`
const FILES = {
  'adr/0001-a.md': doc('Accepted', '0001 — A'),
  'plans/0002-b.md': doc('In progress', '0002 — B'),
}

const NO_TTY: Terminal = {
  isTty: () => false,
  prompts: async () => {
    throw new Error('no prompt without a terminal')
  },
}

/** A private config dir and a token; `scopes` is what GET /user says it holds. */
async function machine(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-pulse-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  withEnv(t, {
    XDG_CONFIG_HOME: dir,
    GITHUB_TOKEN: 'tok',
    GH_TOKEN: undefined,
  })
}

const asUser =
  (scopes: string) =>
  (r: { method: string; path: string }): Reply | undefined =>
    r.method === 'GET' && r.path === '/user'
      ? { json: { login: 'octo' }, headers: { 'X-OAuth-Scopes': scopes } }
      : undefined

async function run<T>(work: () => Promise<T>) {
  const c = capture()
  try {
    const code = await work()
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

const seededFields = (): FField[] => [
  {
    id: 'F_status',
    databaseId: 1,
    name: 'Status',
    options: ['Accepted', 'In progress', 'Draft'].map((name) => ({
      id: `s_${name}`,
      name,
    })),
  },
  {
    id: 'F_Type',
    databaseId: 2,
    name: 'Type',
    options: ['ADR', 'Specs', 'Plans'].map((name) => ({ id: name, name })),
  },
  {
    id: 'F_Agent',
    databaseId: 3,
    name: 'Agent',
    options: [{ id: 'a1', name: 'working' }],
  },
  { id: 'F_Session', databaseId: 4, name: 'Session', options: null },
  { id: 'F_Path', databaseId: 5, name: 'Path', options: null },
]
const VIEWS = ['ADR', 'Specs', 'Plans', 'Working']
const item = (
  id: string,
  values: Record<string, string>,
  title = id
): FItem => ({ id, draftId: `D_${id}`, title, archived: false, values })

test('create in a blank workspace: no organization, refused', async (t) => {
  await machine(t)
  const cwd = await makeWorkspace(t, {})
  const r = await run(() => pulseCreateCommand({ cwd }, { terminal: NO_TTY }))
  assert.equal(r.code, 1)
  assert.equal(
    r.err.trim(),
    'the pulse needs an organization: rness.json has no "org"'
  )
})

test('create with a pulse declared: refused, sync is the way', async (t) => {
  await machine(t)
  const cwd = await makeWorkspace(t, { org: 'acme', pulse: { project: 7 } })
  const r = await run(() => pulseCreateCommand({ cwd }, { terminal: NO_TTY }))
  assert.equal(r.code, 1)
  assert.equal(
    r.err.trim(),
    'already declared: https://github.com/orgs/acme/projects/7 — rness pulse sync'
  )
})

test('a written provider that is not available is refused first', async (t) => {
  await machine(t)
  const cwd = await makeWorkspace(t, { provider: 'gitlab', org: 'acme' })
  const r = await run(() => pulseSyncCommand({ cwd }, { terminal: NO_TTY }))
  assert.equal(r.code, 1)
  assert.match(r.err, /provider "gitlab" is not supported/)
})

test('scopes without project: refused; -y does not log in', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo, read:org') })
  const cwd = await makeWorkspace(t, { org: 'acme', files: FILES })
  const r = await run(() =>
    pulseCreateCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 1)
  assert.equal(
    r.err.trim(),
    'the pulse needs the project scope: run rness login'
  )
  assert.equal(g.mutations.length, 0)
})

test('in a terminal, create offers the login; declined, it is refused', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo') })
  const cwd = await makeWorkspace(t, { org: 'acme', files: FILES })
  const asked: string[] = []
  const terminal: Terminal = {
    isTty: () => true,
    prompts: async () =>
      ({
        async confirm(o: { message: string }) {
          asked.push(o.message)
          return false
        },
        isCancel: () => false,
      }) as unknown as Prompts,
  }
  const r = await run(() =>
    pulseCreateCommand({ cwd, githubApi: g.base }, { terminal })
  )
  assert.equal(r.code, 1)
  assert.equal(asked.length, 1)
  assert.match(asked[0]!, /project scope/)
  assert.equal(
    r.err.trim(),
    'the pulse needs the project scope: run rness login'
  )
})

test("GitHub's refusal comes as GitHub: <message>, without a stack", async (t) => {
  await machine(t)
  const g = await board(t, {
    other: (r) =>
      asUser('repo, project')(r) ??
      (r.path === '/graphql' &&
      JSON.stringify(r.body).includes('createProjectV2(')
        ? {
            json: {
              errors: [{ message: 'octo cannot create projects in acme' }],
            },
          }
        : undefined),
  })
  const cwd = await makeWorkspace(t, { org: 'acme', files: FILES })
  const r = await run(() =>
    pulseCreateCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 1)
  assert.equal(r.err.trim(), 'GitHub: octo cannot create projects in acme')
  assert.doesNotMatch(r.err, /\n\s+at /)
  assert.equal(
    JSON.parse(await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')).pulse,
    undefined
  )
})

test('an organization that restricts OAuth apps: its 403 message, as it comes', async (t) => {
  await machine(t)
  const message =
    'Although you appear to have the correct authorization credentials, the `rness-dev` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.'
  const g = await board(t, {
    other: (r) =>
      asUser('repo, project')(r) ??
      (r.path === '/graphql' &&
      JSON.stringify(r.body).includes('createProjectV2(')
        ? { status: 403, json: { message } }
        : undefined),
  })
  const cwd = await makeWorkspace(t, { org: 'acme', files: FILES })
  const r = await run(() =>
    pulseCreateCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 1)
  assert.equal(r.err.trim(), `GitHub: ${message}`)
  assert.doesNotMatch(r.err, /\n\s+at |add repositories/)
})

test('create: the lines of the spec in order, and the manifest declares the pulse', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo, read:org, project') })
  const cwd = await makeWorkspace(t, { org: 'acme', files: FILES })
  const r = await run(() =>
    pulseCreateCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.err, '')
  assert.equal(r.code, 0)
  const lines = r.out.trim().split('\n')
  assert.match(
    lines[0]!,
    /^checked\s+github, logged in as octo, scope project$/
  )
  assert.match(
    lines[1]!,
    /^created\s+Agent Pulse — https:\/\/github\.com\/orgs\/acme\/projects\/7$/
  )
  assert.match(
    lines[2]!,
    /^created\s+fields Status, Type, Agent, Session, Path$/
  )
  assert.match(lines[3]!, /^created\s+views ADR, Specs, Plans, Working$/)
  assert.match(lines[4]!, /^synced\s+2 items: 2 created$/)
  assert.match(
    lines[5]!,
    /^declared\s+pulse in \.rness\/rness\.json — commit it: git -C \.rness commit -am "chore: rness pulse"$/
  )
  assert.equal(lines.length, 6)
  const manifest = JSON.parse(
    await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')
  )
  assert.equal(manifest.provider, 'github')
  assert.deepEqual(manifest.pulse, { project: 7 })
  assert.deepEqual(
    g.mutations
      .filter((m) => m.op === 'addDraft')
      .map((m) => m.variables['title']),
    ['0001 — A', '0002 — B']
  )
})

test('sync without a pulse: refused', async (t) => {
  await machine(t)
  const cwd = await makeWorkspace(t, { org: 'acme' })
  const r = await run(() => pulseSyncCommand({ cwd }, { terminal: NO_TTY }))
  assert.equal(r.code, 1)
  assert.equal(r.err.trim(), 'no pulse declared — rness pulse create')
})

test('sync: created, updated, unchanged and archived, each counted, the steps applied', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    items: [
      item(
        'i1',
        { Path: 'adr/0001-a.md', Type: 'ADR', Status: 'Accepted' },
        '0001 — A'
      ),
      item(
        'i2',
        { Path: 'plans/0002-b.md', Type: 'Plans', Status: 'Draft' },
        '0002 — B'
      ),
      item('i9', { Path: 'adr/0009-gone.md', Type: 'ADR', Status: 'Draft' }),
    ],
    other: asUser('repo, project'),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: { ...FILES, 'specs/0003-c.md': doc('Draft', '0003 — C') },
  })
  const r = await run(() =>
    pulseSyncCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(r.err, '')
  assert.equal(r.code, 0)
  assert.match(
    r.out.trim(),
    /^synced\s+3 items: 1 created, 1 updated, 1 unchanged, 1 archived$/
  )
  assert.deepEqual(
    g.mutations
      .filter((m) => ['addDraft', 'editDraft', 'archive'].includes(m.op))
      .map((m) => m.op),
    ['addDraft', 'editDraft', 'archive']
  )
})

test('sync says what it added to the layout first', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: ['ADR', 'Specs', 'Working'],
    other: asUser('repo, project'),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: FILES,
  })
  const r = await run(() =>
    pulseSyncCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  const lines = r.out.trim().split('\n')
  assert.match(lines[0]!, /^added\s+view Plans$/)
  assert.match(lines[1]!, /^synced\s+2 items: 2 created$/)
})

test('mark sets Agent and Session on the items of the paths; --end clears only that session, then syncs', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    items: [
      item(
        'i1',
        { Path: 'adr/0001-a.md', Type: 'ADR', Status: 'Accepted' },
        '0001 — A'
      ),
      item(
        'i2',
        {
          Path: 'plans/0002-b.md',
          Type: 'Plans',
          Status: 'In progress',
          Agent: 'working',
          Session: 'claude · s1',
        },
        '0002 — B'
      ),
      item('i3', {
        Path: 'plans/0004-d.md',
        Agent: 'working',
        Session: 'claude · s2',
      }),
    ],
    other: asUser('repo, project'),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: FILES,
  })
  const sets = () =>
    g.mutations
      .filter((m) => m.op === 'set' || m.op === 'clear')
      .map((m) => [m.op, m.variables['itemId'], m.variables['fieldId']])

  const marked = await run(() =>
    pulseMarkCommand({
      cwd,
      githubApi: g.base,
      session: 'claude · s3',
      paths: ['adr/0001-a.md'],
    })
  )
  assert.equal(marked.code, 0)
  assert.deepEqual(sets(), [
    ['set', 'i1', 'F_Agent'],
    ['set', 'i1', 'F_Session'],
  ])

  g.mutations.length = 0
  const ended = await run(() =>
    pulseMarkCommand({
      cwd,
      githubApi: g.base,
      session: 'claude · s1',
      paths: [],
      end: true,
    })
  )
  assert.equal(ended.code, 0)
  assert.deepEqual(sets(), [
    ['clear', 'i2', 'F_Agent'],
    ['clear', 'i2', 'F_Session'],
  ])
  assert.match(ended.out, /^synced\s+2 items: /m)
})

test('mark that cannot reach the pulse records why, for the next session start, and exits 0', async (t) => {
  await machine(t)
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: FILES,
  })
  const r = await run(() =>
    pulseMarkCommand({
      cwd,
      githubApi: 'http://127.0.0.1:1',
      session: 'claude · s1',
      paths: ['adr/0001-a.md'],
    })
  )
  assert.equal(r.code, 0)
  const reason = await takeFailure()
  assert.ok(reason !== null && reason !== '')
  assert.equal(await takeFailure(), null)
})
