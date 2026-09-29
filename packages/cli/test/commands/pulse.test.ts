import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
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

/**
 * A private config dir and a token — none with `null`, and no stored login
 * either; `scopes` is what GET /user says the token holds.
 */
async function machine(t: TestContext, token: string | null = 'tok') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-pulse-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  withEnv(t, {
    XDG_CONFIG_HOME: dir,
    GITHUB_TOKEN: token ?? undefined,
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

const ALL_STATUSES = [
  'Draft',
  'Proposed',
  'Ready',
  'Approved',
  'In progress',
  'Blocked',
  'Accepted',
  'Implemented',
  'Completed',
  'Rejected',
  'Superseded',
  'Abandoned',
]
const OWN_STATUSES: Record<string, string[]> = {
  ADR: ['Proposed', 'Accepted', 'Rejected', 'Superseded'],
  Specs: [
    'Draft',
    'Proposed',
    'Approved',
    'Implemented',
    'Rejected',
    'Superseded',
  ],
  Plans: ['Draft', 'Ready', 'In progress', 'Blocked', 'Completed', 'Abandoned'],
}
const optionsOf = (names: string[]) =>
  names.map((name) => ({ id: `s_${name}`, name }))
/** A board laid out for FILES: Status by lifecycle, one status field per collection. */
const seededFields = (): FField[] => [
  {
    id: 'F_status',
    databaseId: 1,
    name: 'Status',
    options: optionsOf(ALL_STATUSES),
  },
  {
    id: 'F_Collection',
    databaseId: 2,
    name: 'Collection',
    options: ['ADR', 'Specs', 'Plans'].map((name) => ({ id: name, name })),
  },
  ...Object.entries(OWN_STATUSES).map(([label, names], i) => ({
    id: `F_${label} status`,
    databaseId: 10 + i,
    name: `${label} status`,
    options: optionsOf(names),
  })),
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

test('create where the repositories look like an unavailable provider: refused before GitHub is asked anything', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo, read:org, project') })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    repos: { api: { url: 'https://gitlab.com/acme/api.git' } },
    files: FILES,
  })
  const before = await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')
  const r = await run(() =>
    pulseCreateCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 1)
  assert.equal(r.out, '')
  assert.equal(
    r.err.trim(),
    'the pulse needs a GitHub organization, and this workspace\'s repositories look like gitlab (detected): write "provider": "github" in rness.json if the organization is on GitHub'
  )
  assert.deepEqual(g.requests, [], 'no GitHub call at all')
  assert.equal(
    await readFile(join(cwd, '.rness', 'rness.json'), 'utf8'),
    before,
    'rness.json untouched'
  )
})

test('create where the repositories are on GitHub writes the detected provider', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo, read:org, project') })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    repos: { api: { url: 'git@github.com:acme/api.git' } },
    files: FILES,
  })
  const r = await run(() =>
    pulseCreateCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 0)
  assert.match(r.out, /^checked\s+github, /)
  assert.equal(
    JSON.parse(await readFile(join(cwd, '.rness', 'rness.json'), 'utf8'))
      .provider,
    'github'
  )
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

test('the login create offers asks nothing about git', async (t) => {
  await machine(t, null)
  const g = await board(t, {
    other: (r) => {
      if (r.path === '/login/device/code')
        return {
          json: {
            device_code: 'dev-1',
            user_code: '8F43-6B2A',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 0,
          },
        }
      if (r.path === '/login/oauth/access_token')
        return {
          json: {
            access_token: 'ghu_access',
            expires_in: 28800,
            refresh_token: 'ghr_refresh',
            refresh_token_expires_in: 15897600,
            scope: 'repo,project',
          },
        }
      return asUser('repo, project')(r)
    },
  })
  // SSH_CONNECTION keeps the login from opening a real browser.
  withEnv(t, {
    RNESS_GITHUB_WEB: g.base,
    RNESS_GITHUB_CLIENT_ID: 'client-test',
    SSH_CONNECTION: 'test',
  })
  const cwd = await makeWorkspace(t, { org: 'acme', files: FILES })
  const asked: string[] = []
  const terminal: Terminal = {
    isTty: () => true,
    prompts: async () =>
      ({
        async confirm(o: { message: string }) {
          asked.push(o.message)
          return true
        },
        isCancel: () => false,
      }) as unknown as Prompts,
  }
  const r = await run(() =>
    pulseCreateCommand({ cwd, githubApi: g.base }, { terminal })
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(asked.length, 1, `asked: ${asked.join(' | ')}`)
  assert.match(asked[0]!, /project scope/)
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

test('create: the project, then the layout it built and a first sync, and the manifest declares the pulse', async (t) => {
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
  // What ensureLayout added: Status is GitHub's own field, its options rness's.
  assert.match(
    lines[2]!,
    /^created\s+fields Collection, ADR status, Specs status, Plans status, Agent, Session, Path$/
  )
  assert.match(
    lines[3]!,
    /^created\s+options Draft, Proposed, Ready, Approved, In progress, Blocked, Accepted, Implemented, Completed, Rejected, Superseded, Abandoned$/
  )
  assert.match(lines[4]!, /^created\s+views All, ADR, Specs, Plans, Working$/)
  assert.match(lines[5]!, /^synced\s+2 items: 2 created$/)
  assert.match(
    lines[6]!,
    /^declared\s+pulse in \.rness\/rness\.json — commit it: git -C \.rness commit -am "chore: rness pulse"$/
  )
  assert.equal(lines.length, 7)
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

test('create: a view GitHub refuses once the project exists — declared all the same, and sync completes the layout', async (t) => {
  await machine(t)
  let refuseViews = true
  const g = await board(t, {
    other: (r) =>
      asUser('repo, project')(r) ??
      (refuseViews && r.path.endsWith('/views')
        ? { status: 422, json: { message: 'Validation Failed' } }
        : undefined),
  })
  const cwd = await makeWorkspace(t, { org: 'acme', files: FILES })
  const created = await run(() =>
    pulseCreateCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(created.code, 1)
  assert.equal(created.err.trim(), 'GitHub: Validation Failed')
  const lines = created.out.trim().split('\n')
  assert.match(
    lines[1]!,
    /^created\s+Agent Pulse — https:\/\/github\.com\/orgs\/acme\/projects\/7$/
  )
  assert.match(lines.at(-1)!, /^declared\s+pulse in \.rness\/rness\.json/)
  const manifest = JSON.parse(
    await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')
  )
  assert.equal(manifest.provider, 'github')
  assert.deepEqual(manifest.pulse, { project: 7 })

  refuseViews = false
  const synced = await run(() =>
    pulseSyncCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(synced.err, '')
  assert.equal(synced.code, 0)
  assert.deepEqual(
    synced.out
      .trim()
      .split('\n')
      .map((l) => l.replace(/\s+/, ' ')),
    [
      'added view ADR',
      'added view Specs',
      'added view Plans',
      'added view Working',
      'synced 2 items: 2 created',
    ]
  )
  assert.deepEqual(g.views, ['All', 'ADR', 'Specs', 'Plans', 'Working'])
  assert.equal(
    g.mutations.filter((m) => m.op === 'createProject').length,
    1,
    'one project, never a second'
  )
})

test('create: a field GitHub refuses once the project exists — declared all the same', async (t) => {
  await machine(t)
  const g = await board(t, {
    other: (r) =>
      asUser('repo, project')(r) ??
      (r.path === '/graphql' &&
      JSON.stringify(r.body).includes('createProjectV2Field') &&
      (r.body as { variables: { name: string } }).variables.name === 'Agent'
        ? { json: { errors: [{ message: 'Name has already been taken' }] } }
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
  assert.equal(r.err.trim(), 'GitHub: Name has already been taken')
  assert.deepEqual(
    JSON.parse(await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')).pulse,
    { project: 7 }
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
        {
          Path: 'adr/0001-a.md',
          Collection: 'ADR',
          Status: 'Accepted',
          'ADR status': 'Accepted',
        },
        '0001 — A'
      ),
      item(
        'i2',
        {
          Path: 'plans/0002-b.md',
          Collection: 'Plans',
          Status: 'Draft',
          'Plans status': 'Draft',
        },
        '0002 — B'
      ),
      item('i9', {
        Path: 'adr/0009-gone.md',
        Collection: 'ADR',
        Status: 'Draft',
      }),
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

test("sync: an item converted to an issue by hand is the team's — left alone, its document gets a new draft, every sync succeeds", async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    items: [
      {
        id: 'i1',
        draftId: null,
        title: '',
        archived: false,
        values: { Path: 'adr/0001-a.md', Collection: 'ADR', Status: 'Draft' },
      },
      item(
        'i2',
        {
          Path: 'plans/0002-b.md',
          Collection: 'Plans',
          Status: 'In progress',
          'Plans status': 'In progress',
        },
        '0002 — B'
      ),
    ],
    other: asUser('repo, project'),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: FILES,
  })
  const sync = () =>
    run(() =>
      pulseSyncCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
    )
  const first = await sync()
  assert.equal(first.err, '')
  assert.equal(first.code, 0)
  assert.match(first.out.trim(), /^synced\s+2 items: 1 created, 1 unchanged$/)
  assert.deepEqual(
    g.mutations
      .filter((m) => m.op === 'addDraft')
      .map((m) => m.variables['title']),
    ['0001 — A']
  )
  const second = await sync()
  assert.equal(second.code, 0)
  assert.match(second.out.trim(), /^synced\s+2 items: 2 unchanged$/)
  assert.deepEqual(
    g.mutations.filter(
      (m) =>
        m.variables['itemId'] === 'i1' ||
        m.op === 'editDraft' ||
        m.op === 'archive'
    ),
    [],
    'the converted item is neither edited, nor set, nor archived'
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
        {
          Path: 'adr/0001-a.md',
          Collection: 'ADR',
          Status: 'Accepted',
          'ADR status': 'Accepted',
        },
        '0001 — A'
      ),
      item(
        'i2',
        {
          Path: 'plans/0002-b.md',
          Collection: 'Plans',
          Status: 'In progress',
          'Plans status': 'In progress',
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

/** What `pulse mark` recorded for the next session start, once. */
async function recordedBy(
  t: TestContext,
  githubApi: string
): Promise<string | null> {
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: FILES,
  })
  const r = await run(() =>
    pulseMarkCommand({
      cwd,
      githubApi,
      session: 'claude · s1',
      paths: ['adr/0001-a.md'],
    })
  )
  assert.equal(r.code, 0)
  assert.equal(r.out + r.err, '', 'no one reads a detached mark')
  const reason = await takeFailure()
  assert.equal(await takeFailure(), null, 'said once')
  return reason
}

test('mark without a login records that the pulse needs one, and exits 0', async (t) => {
  await machine(t, null)
  assert.equal(
    await recordedBy(t, 'http://127.0.0.1:1'),
    'the pulse needs a GitHub login: run rness login'
  )
})

test('mark with a login that lacks the project scope records the scope', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo, read:org') })
  assert.equal(
    await recordedBy(t, g.base),
    'the pulse needs the project scope: run rness login'
  )
})

/** An address nothing listens on: a port just closed. */
async function offline(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

test('mark offline records that GitHub cannot be reached, not the scope', async (t) => {
  await machine(t)
  const api = await offline()
  // The platform's own words for a refused connection, as the mark sees them.
  const why = await fetch(`${api}/user`).then(
    () => assert.fail(`something listens on ${api}`),
    (e: Error) => (e.cause as Error).message
  )
  assert.match(why, /ECONNREFUSED/)
  assert.equal(await recordedBy(t, api), `cannot reach GitHub: ${why}`)
})

test('mark whose token GitHub rejects records the rejection, not the scope', async (t) => {
  await machine(t)
  const g = await board(t, {
    other: (r) =>
      r.path === '/user'
        ? { status: 401, json: { message: 'Bad credentials' } }
        : undefined,
  })
  assert.equal(await recordedBy(t, g.base), 'GitHub rejected the token (401)')
})

test('create offline: GitHub cannot be reached, and no login is offered', async (t) => {
  await machine(t)
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
  const githubApi = await offline()
  const r = await run(() =>
    pulseCreateCommand({ cwd, githubApi }, { terminal })
  )
  assert.equal(r.code, 1)
  assert.match(r.err.trim(), /^cannot reach GitHub: \S/)
  assert.deepEqual(asked, [])
})

test("rness's own errors keep their words: only GitHub's are named GitHub's", async (t) => {
  await machine(t)
  // A declared board whose layout a failed create left half-built: no Agent.
  const g = await board(t, {
    fields: seededFields().filter((f) => f.name !== 'Agent'),
    items: [item('i1', { Path: 'adr/0001-a.md' })],
    other: asUser('repo, project'),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: FILES,
  })
  const r = await run(() =>
    pulseMarkCommand({
      cwd,
      githubApi: g.base,
      session: 'claude · s1',
      paths: ['adr/0001-a.md'],
    })
  )
  assert.equal(r.code, 0)
  assert.equal(await takeFailure(), 'the board has no field Agent')
})

test('--end clears the session and its subagents (same id, any agent type), not another session', async (t) => {
  await machine(t)
  const marked = (session: string) => ({
    Path: 'plans/0002-b.md',
    Agent: 'working',
    Session: session,
  })
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    items: [
      item('i1', marked('claude · 1a2b3c4d'), '0002 — B'),
      item('i2', marked('claude · reviewer · 1a2b3c4d')),
      item('i3', marked('claude · 9f9f9f9f')),
    ],
    other: asUser('repo, project'),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: FILES,
  })
  const r = await run(() =>
    pulseMarkCommand({
      cwd,
      githubApi: g.base,
      session: 'claude · 1a2b3c4d',
      paths: [],
      end: true,
    })
  )
  assert.equal(r.code, 0)
  const cleared = g.mutations
    .filter((m) => m.op === 'clear')
    .map((m) => m.variables['itemId'])
  assert.deepEqual([...new Set(cleared)].sort(), ['i1', 'i2'])
})
