import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
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
import { digestOf, headerOf, issueBody } from '../../src/pulse/body.ts'
import { oneSyncAtATime, takeFailure } from '../../src/pulse/detached.ts'
import { capture } from '../helpers/capture.ts'
import { type Reply, withEnv } from '../helpers/fake-github.ts'
import {
  type FField,
  type FIssue,
  type FItem,
  anIssue,
  board,
} from '../helpers/fake-project.ts'
import { commitDir } from '../helpers/git.ts'
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
/** rness's item: an issue of acme/.rness numbered after its id (`i2` → #2), with no body yet. */
const item = (
  id: string,
  values: Record<string, string>,
  title = id
): FItem => ({
  id,
  draftId: null,
  issue: anIssue(Number(id.replace(/\D/g, '')), { title }),
  title,
  archived: false,
  values,
})
/** A draft of 0.12.0. */
const draft = (
  id: string,
  values: Record<string, string>,
  title = id
): FItem => ({
  id,
  draftId: `D_${id}`,
  title,
  archived: false,
  values,
})
/** Output lines, the column's padding folded. */
const lines = (out: string): string[] =>
  out
    .trim()
    .split('\n')
    .map((l) => l.replace(/\s+/, ' '))

/** A declared pulse on a laid-out board, synced once: every document has its issue and its body. */
async function settled(
  t: TestContext,
  seed: NonNullable<Parameters<typeof board>[1]> = {}
) {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    other: asUser('repo, project'),
    ...seed,
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
  assert.equal(first.code, 0, first.err)
  g.mutations.length = 0
  return { g, cwd, sync }
}

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
  const g = await board(t, {
    other: asUser('repo, read:org, project'),
    memory: { label: false, linked: false },
  })
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
  assert.match(lines[5]!, /^created\s+label rness$/)
  assert.match(lines[6]!, /^linked\s+Agent Pulse to acme\/\.rness$/)
  assert.match(lines[7]!, /^created\s+2 issues$/)
  assert.match(lines[8]!, /^synced\s+2 items: 2 created$/)
  assert.match(
    lines[9]!,
    /^declared\s+pulse in \.rness\/rness\.json — commit it: git -C \.rness commit -am "chore: rness pulse"$/
  )
  assert.equal(lines.length, 10)
  const manifest = JSON.parse(
    await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')
  )
  assert.equal(manifest.provider, 'github')
  assert.deepEqual(manifest.pulse, { project: 7 })
  assert.deepEqual(
    g.mutations
      .filter((m) => m.op === 'createIssue')
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
      'created 2 issues',
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

test('a new document: its issue (labelled, the first line as body), added to the board, its fields, then its body — in that order', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
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
  assert.equal(r.err, '')
  assert.deepEqual(lines(r.out), [
    'created 2 issues',
    'synced 2 items: 2 created',
  ])
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    [
      'createIssue',
      'addItem',
      'set',
      'set',
      'set',
      'set',
      'createIssue',
      'addItem',
      'set',
      'set',
      'set',
      'set',
      'updateIssue',
      'updateIssue',
    ]
  )
  assert.deepEqual(g.mutations[0]!.variables, {
    repositoryId: 'R_1',
    title: '0001 — A',
    body: headerOf('adr/0001-a.md', 'acme'),
    labelIds: ['L_1'],
  })
  assert.ok(
    g.issues.every(
      (i) => i.labels.includes('rness') && digestOf(i.body) !== null
    )
  )
})

test('sync again: nothing to do, nothing written', async (t) => {
  const { g, sync } = await settled(t)
  const r = await sync()
  assert.deepEqual(lines(r.out), ['synced 2 items: 2 unchanged'])
  assert.deepEqual(g.mutations, [])
})

test('a changed document: only its body is written', async (t) => {
  const { g, cwd, sync } = await settled(t)
  await writeFile(
    join(cwd, '.rness', 'adr', '0001-a.md'),
    `${FILES['adr/0001-a.md']}\nA new paragraph.\n`
  )
  const r = await sync()
  assert.deepEqual(lines(r.out), ['synced 2 items: 1 updated, 1 unchanged'])
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    ['updateIssue']
  )
  assert.match(String(g.mutations[0]!.variables['body']), /A new paragraph\./)
})

test('hand changes on GitHub are written back: a body edited under its digest, a title, a closed issue reopened', async (t) => {
  const { g, sync } = await settled(t)
  const issueAt = (path: string) =>
    g.items.find((i) => i.values['Path'] === path)!.issue!
  const a = issueAt('adr/0001-a.md')
  const b = issueAt('plans/0002-b.md')
  const written = a.body
  a.body = a.body.replace('on GitHub', 'on GitHub, edited by hand')
  b.title = 'renamed by hand'
  b.state = 'CLOSED'
  const r = await sync()
  assert.deepEqual(lines(r.out), [
    'reopened 1 issue',
    'synced 2 items: 2 updated',
  ])
  assert.deepEqual(
    g.mutations.map((m) => [m.op, m.variables]),
    [
      ['reopenIssue', { id: b.id }],
      ['updateIssue', { id: b.id, title: '0002 — B' }],
      ['updateIssue', { id: a.id, body: written }],
    ]
  )
  g.mutations.length = 0
  assert.deepEqual(
    lines((await sync()).out),
    ['synced 2 items: 2 unchanged'],
    'written once, then stable'
  )
})

test("a gone document — committed, then deleted: its issue closed as not planned, its item archived; a path this clone's git never saw, on an issue it did not open, is left alone", async (t) => {
  const { g, cwd, sync } = await settled(t)
  const memory = join(cwd, '.rness')
  await commitDir(memory, 'docs')
  await rm(join(memory, 'plans', '0002-b.md'))
  await commitDir(memory, 'plans: 0002 gone')
  const b = g.items.find((i) => i.values['Path'] === 'plans/0002-b.md')!
  // A teammate's new document: on the board, not pulled into this clone.
  const theirs = item(
    'i9',
    {
      Path: 'specs/0009-theirs.md',
      Collection: 'Specs',
      Status: 'Draft',
      'Specs status': 'Draft',
    },
    '0009 — Theirs'
  )
  g.items.push(theirs)
  const r = await sync()
  assert.equal(r.err, '')
  assert.deepEqual(lines(r.out), ['synced 1 item: 1 unchanged, 1 archived'])
  assert.deepEqual(
    g.mutations.map((m) => [m.op, m.variables['id'] ?? m.variables['itemId']]),
    [
      ['closeIssue', b.issue!.id],
      ['archive', b.id],
    ]
  )
  assert.match(g.mutations[0]!.query!, /stateReason: NOT_PLANNED/)
  assert.equal(theirs.archived, false)
  assert.equal(theirs.issue?.state, 'OPEN')
})

/** Where this clone records the issues its syncs opened: `.rness`'s git directory. */
const recordOf = (cwd: string): string =>
  join(cwd, '.rness', '.git', 'rness', 'opened')
/** The record as JSON; null when there is none. */
async function recorded(cwd: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(recordOf(cwd), 'utf8'))
  } catch {
    return null
  }
}

/**
 * A document written and synced in a clone of `.rness` — its issue recorded
 * as this clone's — then renamed before any commit; `before` runs ahead of
 * the second sync.
 */
async function renamedBeforeCommit(
  t: TestContext,
  before: (cwd: string) => Promise<void> = async () => {}
) {
  const { g, cwd, sync } = await settled(t)
  const specs = join(cwd, '.rness', 'specs')
  await commitDir(join(cwd, '.rness'), 'docs')
  await writeDoc(cwd, 'specs/0003-c.md', doc('Draft', '0003 — C'))
  assert.equal((await sync()).code, 0)
  const c = g.items.find((i) => i.values['Path'] === 'specs/0003-c.md')!
  assert.deepEqual(await recorded(cwd), {
    [c.issue!.number]: 'specs/0003-c.md',
  })
  await rename(join(specs, '0003-c.md'), join(specs, '0003-renamed.md'))
  await before(cwd)
  g.mutations.length = 0
  return { g, c, cwd, r: await sync() }
}

test('a document renamed before any commit: the issue this clone opened is closed, archived and forgotten; the new path gets its own, recorded', async (t) => {
  const { g, c, cwd, r } = await renamedBeforeCommit(t)
  assert.equal(r.err, '')
  assert.deepEqual(lines(r.out), [
    'created 1 issue',
    'synced 3 items: 1 created, 2 unchanged, 1 archived',
  ])
  assert.deepEqual(
    g.mutations
      .filter((m) => m.op === 'closeIssue' || m.op === 'archive')
      .map((m) => m.variables['id'] ?? m.variables['itemId']),
    [c.issue!.id, c.id]
  )
  const renamed = g.items.find(
    (i) => i.values['Path'] === 'specs/0003-renamed.md'
  )!
  assert.deepEqual(await recorded(cwd), {
    [renamed.issue!.number]: 'specs/0003-renamed.md',
  })
})

test("the same path, its issue not recorded here — the same login's from another clone: left alone", async (t) => {
  const { c, r } = await renamedBeforeCommit(t, (cwd) =>
    rm(recordOf(cwd), { force: true })
  )
  assert.equal(r.err, '')
  assert.deepEqual(lines(r.out), [
    'created 1 issue',
    'synced 3 items: 1 created, 2 unchanged',
  ])
  assert.equal(c.archived, false)
  assert.equal(c.issue?.state, 'OPEN')
})

test('a corrupt record reads as none: the same path left alone, the sync goes on and writes a sound one', async (t) => {
  const { g, c, cwd, r } = await renamedBeforeCommit(t, (cwd) =>
    writeFile(recordOf(cwd), '{"12": oops')
  )
  assert.equal(r.code, 0)
  assert.equal(r.err, '')
  assert.equal(c.archived, false)
  const renamed = g.items.find(
    (i) => i.values['Path'] === 'specs/0003-renamed.md'
  )!
  assert.deepEqual(await recorded(cwd), {
    [renamed.issue!.number]: 'specs/0003-renamed.md',
  })
})

test('an issue this clone opened is forgotten once its git has seen the path', async (t) => {
  const { g, cwd, sync } = await settled(t)
  const memory = join(cwd, '.rness')
  await commitDir(memory, 'docs')
  await writeDoc(cwd, 'specs/0003-c.md', doc('Draft', '0003 — C'))
  assert.equal((await sync()).code, 0)
  const c = g.items.find((i) => i.values['Path'] === 'specs/0003-c.md')!
  assert.deepEqual(await recorded(cwd), {
    [c.issue!.number]: 'specs/0003-c.md',
  })
  await commitDir(memory, 'specs: 0003')
  assert.equal((await sync()).code, 0)
  assert.equal(await recorded(cwd), null, 'none left, no file')
})

test("the first sync with 0.13.0: 0.12.0's drafts converted in place, labelled, their bodies written, the board linked; the next writes nothing", async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    memory: { label: false, linked: false },
    items: [
      draft(
        'i1',
        {
          Path: 'adr/0001-a.md',
          Collection: 'ADR',
          Status: 'Accepted',
          'ADR status': 'Accepted',
        },
        '0001 — A'
      ),
      draft(
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
  assert.deepEqual(lines(first.out), [
    'added label rness',
    'added link acme/.rness',
    'converted 2 drafts into issues of acme/.rness',
    'synced 2 items: 2 converted',
  ])
  assert.deepEqual(
    g.items.map((i) => [i.id, i.issue?.number, i.issue?.labels]),
    [
      ['i1', 1, ['rness']],
      ['i2', 2, ['rness']],
    ]
  )
  assert.ok(
    g.items.every((i) => digestOf(i.issue?.body ?? '') !== null),
    'every body written'
  )
  assert.deepEqual(
    g.mutations.filter((m) => m.op === 'set'),
    [],
    'the fields stay as they were'
  )
  g.mutations.length = 0
  assert.deepEqual(lines((await sync()).out), ['synced 2 items: 2 unchanged'])
  assert.deepEqual(g.mutations, [])
})

test("a 0.12.0 CLI's drafts on a migrated board: archived, the issues kept", async (t) => {
  const { g, sync } = await settled(t)
  g.items.push(
    draft(
      'd9',
      { Path: 'adr/0001-a.md', Collection: 'ADR', Status: 'Accepted' },
      '0001 — A'
    )
  )
  const r = await sync()
  assert.deepEqual(lines(r.out), ['synced 2 items: 2 unchanged, 1 archived'])
  assert.deepEqual(
    g.mutations.map((m) => [m.op, m.variables['itemId']]),
    [['archive', 'd9']]
  )
})

test("the team's items are left alone: a draft without Path, another repository's issue, an issue of .rness without Path, a pull request", async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    items: [
      {
        id: 't1',
        draftId: 'D_t1',
        title: 'a note',
        archived: false,
        values: {},
      },
      {
        id: 't2',
        draftId: null,
        issue: anIssue(40, { repository: 'acme/web' }),
        title: '',
        archived: false,
        values: { Path: 'adr/0001-a.md' },
      },
      {
        id: 't3',
        draftId: null,
        issue: anIssue(41),
        title: '',
        archived: false,
        values: {},
      },
      {
        id: 't4',
        draftId: null,
        title: '',
        archived: false,
        values: { Path: 'plans/0002-b.md' },
      },
    ],
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
  assert.equal(r.err, '')
  assert.deepEqual(lines(r.out), [
    'created 2 issues',
    'synced 2 items: 2 created',
  ])
  assert.doesNotMatch(JSON.stringify(g.mutations), /"t[1-4]"|ISSUE_4[01]/)
})

test('a body links another document to its issue, both new in the same sync: two passes', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    other: asUser('repo, project'),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: {
      'adr/0001-a.md': `${doc('Accepted', '0001 — A')}\nSee [B](../plans/0002-b.md).\n`,
      'plans/0002-b.md': `${doc('In progress', '0002 — B')}\nFollows [ADR 0001](../adr/0001-a.md#context).\n`,
    },
  })
  const r = await run(() =>
    pulseSyncCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(r.code, 0, r.err)
  const [a, b] = [g.issues[0]!, g.issues[1]!]
  assert.match(
    a.body,
    new RegExp(
      `\\[B\\]\\(https://github\\.com/acme/\\.rness/issues/${b.number}\\)`
    )
  )
  assert.match(
    b.body,
    new RegExp(
      `\\[ADR 0001\\]\\(https://github\\.com/acme/\\.rness/issues/${a.number}\\)`
    )
  )
})

test('Issues off on .rness: sync refused before any write', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: ['ADR'],
    memory: { issues: false, label: false, linked: false },
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
  assert.equal(r.code, 1)
  assert.equal(
    r.err.trim(),
    'the pulse needs Issues on acme/.rness: turn them on in its Settings'
  )
  assert.deepEqual(g.mutations, [])
  assert.deepEqual(g.restViews, [])
  assert.deepEqual(g.restLabels, [])
})

test('Issues off on .rness: create refused before the project is made', async (t) => {
  await machine(t)
  const g = await board(t, {
    memory: { issues: false },
    other: asUser('repo, read:org, project'),
  })
  const cwd = await makeWorkspace(t, { org: 'acme', files: FILES })
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
    'the pulse needs Issues on acme/.rness: turn them on in its Settings'
  )
  assert.deepEqual(g.mutations, [])
  assert.equal(
    await readFile(join(cwd, '.rness', 'rness.json'), 'utf8'),
    before
  )
})

/**
 * A fake that answers the requests carrying `needle` with a rate limit,
 * `times` of them (Infinity: always), once `after` of them went through.
 */
const limitedOn =
  (needle: string, retryAfter: string, times: number, after = 0) =>
  () => {
    let seen = 0
    return (r: {
      method: string
      path: string
      body?: unknown
    }): Reply | undefined => {
      const mine = asUser('repo, project')(r)
      if (mine !== undefined) return mine
      if (!JSON.stringify(r.body ?? '').includes(needle)) return undefined
      seen++
      return seen > after && seen <= after + times
        ? {
            status: 403,
            json: { message: 'You have exceeded a secondary rate limit.' },
            headers: { 'retry-after': retryAfter },
          }
        : undefined
    }
  }
/** A fake that answers createIssue with a rate limit, `times` times (Infinity: always). */
const limitedCreate = (retryAfter: string, times: number) =>
  limitedOn('createIssue(', retryAfter, times)

test('a secondary rate limit is waited on as GitHub says, and said', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    other: limitedCreate('7', 1)(),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: FILES,
  })
  const slept: number[] = []
  const r = await run(() =>
    pulseSyncCommand(
      {
        cwd,
        githubApi: g.base,
        sleep: async (ms) => {
          slept.push(ms)
        },
      },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(slept, [7_000])
  assert.deepEqual(lines(r.out), [
    "waiting 7 s — GitHub's rate limit",
    'created 2 issues',
    'synced 2 items: 2 created',
  ])
})

test('a rate limit past the 10 minutes stops the sync with what is left; the next sync finishes, without duplicates', async (t) => {
  await machine(t)
  let limit = true
  const limited = limitedCreate('601', Infinity)()
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    other: (r) => (limit ? limited(r) : asUser('repo, project')(r)),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: FILES,
  })
  const slept: number[] = []
  const sync = () =>
    run(() =>
      pulseSyncCommand(
        {
          cwd,
          githubApi: g.base,
          sleep: async (ms) => {
            slept.push(ms)
          },
        },
        { terminal: NO_TTY }
      )
    )
  const stopped = await sync()
  assert.equal(stopped.code, 1)
  assert.equal(
    stopped.err.trim(),
    "GitHub's rate limit outlasted the 10 minutes rness waits: 2 of 2 changes not made — the next rness pulse sync makes them"
  )
  assert.deepEqual(slept, [])
  limit = false
  const next = await sync()
  assert.deepEqual(lines(next.out), [
    'created 2 issues',
    'synced 2 items: 2 created',
  ])
  assert.equal(g.issues.length, 2)
})

/** A declared pulse on a laid-out board, FILES written; `sync` records its waits in `slept`. */
async function declared(
  t: TestContext,
  seed: NonNullable<Parameters<typeof board>[1]>
) {
  await machine(t)
  const g = await board(t, { fields: seededFields(), views: VIEWS, ...seed })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: FILES,
  })
  const slept: number[] = []
  const sync = () =>
    run(() =>
      pulseSyncCommand(
        {
          cwd,
          githubApi: g.base,
          sleep: async (ms) => {
            slept.push(ms)
          },
        },
        { terminal: NO_TTY }
      )
    )
  return { g, sync, slept }
}

test('a rate limit after the first issue: the stop says 1 of 2; the next sync makes the other and writes both bodies', async (t) => {
  const { g, sync, slept } = await declared(t, {
    other: limitedOn('createIssue(', '601', 1, 1)(),
  })
  const stopped = await sync()
  assert.equal(stopped.code, 1)
  assert.equal(
    stopped.err.trim(),
    "GitHub's rate limit outlasted the 10 minutes rness waits: 1 of 2 changes not made — the next rness pulse sync makes them"
  )
  assert.equal(g.issues.length, 1)
  g.mutations.length = 0
  const next = await sync()
  assert.equal(next.code, 0, next.err)
  assert.deepEqual(lines(next.out), [
    'created 1 issue',
    'synced 2 items: 1 created, 1 updated',
  ])
  assert.deepEqual(
    g.mutations
      .filter((m) => m.op === 'updateIssue' && 'body' in m.variables)
      .map((m) => m.variables['id'])
      .sort(),
    g.issues.map((i) => i.id).sort(),
    'both bodies written in pass 2'
  )
  assert.ok(g.issues.every((i) => digestOf(i.body) !== null))
  assert.deepEqual(slept, [])
})

test('a sync stopped after an issue joined the board, before its Path: the next adopts it — its Path, fields and body; one issue, one card', async (t) => {
  const { g, sync } = await declared(t, {
    other: limitedOn('updateProjectV2ItemFieldValue(', '601', 1)(),
  })
  const stopped = await sync()
  assert.equal(stopped.code, 1)
  assert.match(
    stopped.err,
    /^GitHub's rate limit outlasted the 10 minutes rness waits: /
  )
  const [stray] = g.items
  assert.equal(g.items.length, 1)
  assert.deepEqual(stray!.values, {}, 'on the board, without Path')
  assert.equal(stray!.issue?.body, headerOf('adr/0001-a.md', 'acme'))

  const next = await sync()
  assert.equal(next.code, 0, next.err)
  assert.deepEqual(lines(next.out), [
    'created 1 issue',
    'synced 2 items: 1 created, 1 updated',
  ])
  assert.equal(g.issues.length, 2, 'no second issue for adr/0001-a.md')
  const cards = g.items.filter((i) => !i.archived)
  assert.deepEqual(
    cards.map((i) => i.values['Path']).sort(),
    ['adr/0001-a.md', 'plans/0002-b.md'],
    'one card per document'
  )
  assert.deepEqual(stray!.values, {
    Path: 'adr/0001-a.md',
    Collection: 'ADR',
    Status: 'Accepted',
    'ADR status': 'Accepted',
  })
  assert.equal(
    stray!.issue?.body,
    issueBody({
      path: 'adr/0001-a.md',
      text: FILES['adr/0001-a.md'],
      org: 'acme',
      numbers: new Map(),
      files: new Set(),
    })
  )
  g.mutations.length = 0
  assert.deepEqual(lines((await sync()).out), ['synced 2 items: 2 unchanged'])
  assert.deepEqual(g.mutations, [])
})

test("an issue of .rness without Path stays the team's unless labelled rness and its body starts with a wanted document's first line", async (t) => {
  const team = (id: string, number: number, over: Partial<FIssue>): FItem => ({
    id,
    draftId: null,
    issue: anIssue(number, over),
    title: '',
    archived: false,
    values: {},
  })
  const header = (path: string) => headerOf(path, 'acme')
  const { g, sync } = await declared(t, {
    other: asUser('repo, project'),
    items: [
      team('t1', 41, { body: 'Notes on the ADR process.' }),
      team('t2', 42, { body: `${header('adr/0009-gone.md')}\n\nOld.` }),
      team('t3', 43, { body: header('adr/0001-a.md'), labels: [] }),
      team('t4', 44, { body: `See ${header('adr/0001-a.md')}` }),
    ],
  })
  const r = await sync()
  assert.equal(r.err, '')
  assert.deepEqual(lines(r.out), [
    'created 2 issues',
    'synced 2 items: 2 created',
  ])
  assert.doesNotMatch(JSON.stringify(g.mutations), /"t[1-4]"|"ISSUE_4[1-4]"/)
})

test('a label renamed Rness on GitHub is still rness: nothing to do', async (t) => {
  const { g, sync } = await settled(t)
  for (const i of g.issues) i.labels = ['Rness']
  assert.deepEqual(lines((await sync()).out), ['synced 2 items: 2 unchanged'])
  assert.deepEqual(g.mutations, [])
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
  assert.match(lines[1]!, /^created\s+2 issues$/)
  assert.match(lines[2]!, /^synced\s+2 items: 2 created$/)
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
  // The item's status is the document's, so the mark needs no sync.
  const g = await board(t, {
    fields: seededFields().filter((f) => f.name !== 'Agent'),
    items: [item('i1', { Path: 'adr/0001-a.md', Status: 'Accepted' })],
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
  assert.deepEqual(
    listingQueries(g).map((q) => /\bbody\b/.test(q)),
    [false, true],
    "the marks' listing reads no body; the sync's does"
  )
})

/** Listings of the board so far: a sync lists once more. */
const listings = (g: Awaited<ReturnType<typeof board>>): number =>
  g.requests.filter((r) => JSON.stringify(r.body ?? '').includes('items(first'))
    .length
/** The GraphQL queries of the board's listings so far, in order. */
const listingQueries = (g: Awaited<ReturnType<typeof board>>): string[] =>
  g.requests
    .map((r) => (r.body as { query?: unknown } | undefined)?.query)
    .filter(
      (q): q is string => typeof q === 'string' && q.includes('items(first')
    )

async function writeDoc(cwd: string, path: string, text: string) {
  const file = join(cwd, '.rness', ...path.split('/'))
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, text)
}

test('mark: a document just written has no item yet — it gets its issue, then its mark, in one run', async (t) => {
  const { g, cwd } = await settled(t)
  await writeDoc(cwd, 'specs/0003-c.md', doc('Draft', '0003 — C'))
  const r = await run(() =>
    pulseMarkCommand({
      cwd,
      githubApi: g.base,
      session: 'claude · s1',
      paths: ['specs/0003-c.md'],
    })
  )
  assert.equal(r.code, 0)
  assert.equal(await takeFailure(), null)
  const made = g.items.find((i) => i.values['Path'] === 'specs/0003-c.md')
  assert.equal(made?.issue?.title, '0003 — C')
  assert.equal(made?.values['Agent'], 'working')
  assert.equal(made?.values['Session'], 'claude · s1')
  assert.equal(g.mutations.filter((m) => m.op === 'createIssue').length, 1)
})

test('mark: a document already on the board costs no sync, and its listing reads no body', async (t) => {
  const { g, cwd } = await settled(t)
  const before = listings(g)
  assert.match(listingQueries(g)[0]!, /\bbody\b/, "sync's listing reads them")
  const r = await run(() =>
    pulseMarkCommand({
      cwd,
      githubApi: g.base,
      session: 'claude · s1',
      paths: ['adr/0001-a.md'],
    })
  )
  assert.equal(r.code, 0)
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    ['set', 'set']
  )
  assert.equal(listings(g) - before, 1, 'one listing, no sync')
  assert.doesNotMatch(listingQueries(g).at(-1)!, /\bbody\b/)
})

test('mark: an edit that changes a status syncs, and the card moves within the session', async (t) => {
  const { g, cwd } = await settled(t)
  await writeDoc(cwd, 'adr/0001-a.md', doc('Superseded', '0001 — A'))
  const before = listings(g)
  const r = await run(() =>
    pulseMarkCommand({
      cwd,
      githubApi: g.base,
      session: 'claude · s1',
      paths: ['adr/0001-a.md'],
    })
  )
  assert.equal(r.code, 0)
  assert.equal(await takeFailure(), null)
  const item = g.items.find((i) => i.values['Path'] === 'adr/0001-a.md')
  assert.equal(item?.values['Status'], 'Superseded')
  assert.equal(item?.values['Session'], 'claude · s1')
  assert.ok(
    listingQueries(g)
      .slice(before)
      .some((q) => /\bbody\b/.test(q)),
    'a sync ran: its listing reads the bodies'
  )
})

test('mark: a file of .rness that is no document of rness status costs no sync and marks nothing', async (t) => {
  const { g, cwd } = await settled(t)
  await writeDoc(cwd, 'README.md', '# Memory\n')
  const before = listings(g)
  const r = await run(() =>
    pulseMarkCommand({
      cwd,
      githubApi: g.base,
      session: 'claude · s1',
      paths: ['README.md', 'specs/9999-nowhere.md'],
    })
  )
  assert.equal(r.code, 0)
  assert.deepEqual(g.mutations, [])
  assert.equal(listings(g) - before, 1, 'at most one sync: here none')
})

test("mark: while a hook's sync runs, an edit of a new document makes no second issue", async (t) => {
  const { g, cwd } = await settled(t)
  await writeDoc(cwd, 'specs/0003-c.md', doc('Draft', '0003 — C'))
  let code: number | undefined
  const ran = await oneSyncAtATime('acme-7', async () => {
    code = (
      await run(() =>
        pulseMarkCommand({
          cwd,
          githubApi: g.base,
          session: 'claude · s1',
          paths: ['specs/0003-c.md'],
        })
      )
    ).code
  })
  assert.equal(ran, true)
  assert.equal(code, 0)
  assert.deepEqual(
    g.mutations,
    [],
    'the running sync gives it its issue; the next edit marks it'
  )
})

test("--end waits for a hook's running sync, then syncs", async (t) => {
  const { g, cwd } = await settled(t)
  const slept: number[] = []
  let out = ''
  await oneSyncAtATime('acme-7', async () => {
    out = (
      await run(() =>
        pulseMarkCommand({
          cwd,
          githubApi: g.base,
          session: 'claude · s1',
          paths: [],
          end: true,
          sleep: async (ms) => {
            slept.push(ms)
            // The other sync ends: its lock goes.
            await rm(
              join(
                process.env['XDG_CONFIG_HOME']!,
                'rness',
                'pulse-acme-7.lock'
              ),
              { force: true }
            )
          },
        })
      )
    ).out
  })
  assert.deepEqual(slept, [1_000])
  assert.match(out, /^synced\s+2 items: 2 unchanged$/m)
})
