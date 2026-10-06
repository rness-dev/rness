import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { digestOf, headerOf, issueBody } from '../../src/board/body.ts'
import { oneSyncAtATime, takeFailure } from '../../src/board/detached.ts'
import {
  boardPushCommand,
  boardRunCommand,
  pulseCreateCommand,
} from '../../src/commands/board.ts'
import { presetTemplate } from '../../src/core/presets.ts'
import type { Prompts, Terminal } from '../../src/core/terminal.ts'
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
  { id: 'F_Session', databaseId: 4, name: 'Working session', options: null },
  { id: 'F_Path', databaseId: 5, name: 'Path', options: null },
  { id: 'F_Sessions', databaseId: 6, name: 'Session history', options: null },
  { id: 'F_title', databaseId: 7, name: 'Title', options: null },
]
const VIEWS = ['All', 'ADR', 'Specs', 'Plans', 'Working']
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
/** What rness.json declares, by board: its project number and the preset it was made from. */
async function declaredIn(cwd: string) {
  const boards = JSON.parse(
    await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')
  ).boards as Record<
    string,
    number | string | { number: number; preset?: string }
  >
  return Object.fromEntries(
    Object.entries(boards).map(([name, p]) => [
      name,
      typeof p === 'object' ? `${p.number} ${p.preset ?? ''}`.trim() : p,
    ])
  )
}

/**
 * What a hook starts for the marks (spec 0032 §4): `board run edit` with
 * the paths edited, or, with `end`, `board run session-end`; Agent Pulse's
 * preset declares `mark` and `clear-marks`.
 */
const markAs = (o: {
  cwd: string
  githubApi: string
  session: string
  paths: string[]
  end?: boolean
  sleep?: (ms: number) => Promise<void>
}) => {
  const { end, ...rest } = o
  return boardRunCommand({
    ...rest,
    event: end === true ? 'session-end' : 'edit',
  })
}

/** A board declared in rness.json as a team writes it, then `board push --yes`. */
async function declareAndPush(
  cwd: string,
  githubApi: string,
  name: string,
  value: unknown
) {
  const file = join(cwd, '.rness', 'rness.json')
  const m = JSON.parse(await readFile(file, 'utf8'))
  m.boards = { ...m.boards, [name]: value }
  await writeFile(file, JSON.stringify(m, null, 2))
  return boardPushCommand({ cwd, githubApi, yes: true }, { terminal: NO_TTY })
}

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
      boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
    )
  const first = await sync()
  assert.equal(first.code, 0, first.err)
  g.mutations.length = 0
  return { g, cwd, sync }
}

test('push in a blank workspace: no organization, refused', async (t) => {
  await machine(t)
  const cwd = await makeWorkspace(t, { boards: { pulse: 'agent-pulse' } })
  const r = await run(() => boardPushCommand({ cwd }, { terminal: NO_TTY }))
  assert.equal(r.code, 1)
  assert.equal(
    r.err.trim(),
    'boards need an organization: rness.json has no "org"'
  )
})

test('a board not created yet, named after no collection: refused before GitHub is asked anything', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo, project') })
  for (const name of ['standards', 'nowhere']) {
    const cwd = await makeWorkspace(t, {
      org: 'acme',
      boards: { [name]: 'collection' },
      files: FILES,
    })
    const r = await run(() =>
      boardPushCommand(
        { cwd, yes: true, githubApi: g.base },
        { terminal: NO_TTY }
      )
    )
    assert.equal(r.code, 1)
    assert.equal(
      r.err.trim(),
      `"boards.${name}": ${name} is no collection of .rness: none of its documents carries a status`
    )
  }
  assert.deepEqual(g.requests, [])
})

test('a written provider that is not available is refused first', async (t) => {
  await machine(t)
  const cwd = await makeWorkspace(t, { provider: 'gitlab', org: 'acme' })
  const r = await run(() => boardPushCommand({ cwd }, { terminal: NO_TTY }))
  assert.equal(r.code, 1)
  assert.match(r.err, /provider "gitlab" is not supported/)
})

test('a board to create where the repositories look like an unavailable provider: refused before GitHub is asked anything', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo, read:org, project') })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    repos: { api: { url: 'https://gitlab.com/acme/api.git' } },
    files: FILES,
  })
  const before = await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')
  const r = await run(() =>
    boardPushCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 1)
  assert.equal(r.out, '')
  assert.equal(
    r.err.trim(),
    'boards need a GitHub organization, and this workspace\'s repositories look like gitlab (detected): write "provider": "github" in rness.json if the organization is on GitHub'
  )
  assert.deepEqual(g.requests, [], 'no GitHub call at all')
  assert.equal(
    await readFile(join(cwd, '.rness', 'rness.json'), 'utf8'),
    before,
    'rness.json untouched'
  )
})

test('a board created where the repositories are on GitHub writes the detected provider', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo, read:org, project') })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    repos: { api: { url: 'git@github.com:acme/api.git' } },
    files: FILES,
  })
  const r = await run(() =>
    boardPushCommand(
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
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    files: FILES,
  })
  const r = await run(() =>
    boardPushCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 1)
  assert.equal(r.err.trim(), 'boards need the project scope: run rness login')
  assert.equal(g.mutations.length, 0)
})

test('in a terminal, push asks once to create, then offers the login; declined, it is refused', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo') })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    files: FILES,
  })
  const asked: string[] = []
  const terminal: Terminal = {
    isTty: () => true,
    prompts: async () =>
      ({
        async confirm(o: { message: string }) {
          asked.push(o.message)
          // Yes to the creation, no to the login.
          return asked.length === 1
        },
        isCancel: () => false,
      }) as unknown as Prompts,
  }
  const r = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal })
  )
  assert.equal(r.code, 1)
  assert.deepEqual(asked.slice(0, 1), [
    'Create Agent Pulse (pulse) on GitHub, in acme?',
  ])
  assert.equal(asked.length, 2)
  assert.match(asked[1]!, /project scope/)
  assert.equal(r.err.trim(), 'boards need the project scope: run rness login')
})

test('the login push offers asks nothing about git', async (t) => {
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
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    files: FILES,
  })
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
    boardPushCommand({ cwd, githubApi: g.base }, { terminal })
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(asked.length, 2, `asked: ${asked.join(' | ')}`)
  assert.equal(asked[0], 'Create Agent Pulse (pulse) on GitHub, in acme?')
  assert.match(asked[1]!, /project scope/)
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
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    files: FILES,
  })
  const r = await run(() =>
    boardPushCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 1)
  assert.equal(r.err.trim(), 'GitHub: octo cannot create projects in acme')
  assert.doesNotMatch(r.err, /\n\s+at /)
  assert.deepEqual(
    JSON.parse(await readFile(join(cwd, '.rness', 'rness.json'), 'utf8'))
      .boards,
    { pulse: 'agent-pulse' },
    'still not created'
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
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    files: FILES,
  })
  const r = await run(() =>
    boardPushCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 1)
  assert.equal(r.err.trim(), `GitHub: ${message}`)
  assert.doesNotMatch(r.err, /\n\s+at |add repositories/)
})

test('push creates a board declared by its preset: the project, then the layout it built and a first sync; the board written whole with its number', async (t) => {
  await machine(t)
  const g = await board(t, {
    other: asUser('repo, read:org, project'),
    memory: { label: false, linked: false },
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    files: FILES,
  })
  const r = await run(() =>
    boardPushCommand(
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
    /^created\s+fields Path, Collection, ADR status, Specs status, Plans status, Agent, Working session, Session history$/
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
    /^declared\s+pulse in \.rness\/rness\.json — commit it: git -C \.rness commit -am "chore: board pulse"$/
  )
  assert.equal(lines.length, 10)
  const manifest = JSON.parse(
    await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')
  )
  assert.equal(manifest.provider, 'github')
  assert.deepEqual(await declaredIn(cwd), { pulse: '7 agent-pulse/1' })
  assert.equal(manifest.boards.pulse.title, 'Agent Pulse')
  assert.deepEqual(
    g.mutations
      .filter((m) => m.op === 'createIssue')
      .map((m) => m.variables['title']),
    ['0001 — A', '0002 — B']
  )
})

test('a view GitHub refuses once the project exists — its number written all the same, and the next push completes the layout', async (t) => {
  await machine(t)
  let refuseViews = true
  const g = await board(t, {
    other: (r) =>
      asUser('repo, project')(r) ??
      (refuseViews && r.path.endsWith('/views')
        ? { status: 422, json: { message: 'Validation Failed' } }
        : undefined),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    files: FILES,
  })
  const created = await run(() =>
    boardPushCommand(
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
  assert.deepEqual(await declaredIn(cwd), { pulse: '7 agent-pulse/1' })
  assert.equal(manifest.boards.pulse.title, 'Agent Pulse')

  refuseViews = false
  const synced = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
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

test('a field GitHub refuses once the project exists — its number written all the same', async (t) => {
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
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    files: FILES,
  })
  const r = await run(() =>
    boardPushCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 1)
  assert.equal(r.err.trim(), 'GitHub: Name has already been taken')
  assert.deepEqual(await declaredIn(cwd), { pulse: '7 agent-pulse/1' })
})

test('push without a board: refused, naming how to declare one', async (t) => {
  await machine(t)
  const cwd = await makeWorkspace(t, { org: 'acme' })
  const r = await run(() => boardPushCommand({ cwd }, { terminal: NO_TTY }))
  assert.equal(r.code, 1)
  assert.equal(
    r.err.trim(),
    'no board declared — declare one in .rness/rness.json, as "boards": { "pulse": "agent-pulse" }, then rness board push'
  )
})

test('off a terminal without --yes, nothing is created: the boards created are pushed, the others named, exit 1', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    other: asUser('repo, project'),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 7, marketing: 'collection' },
    files: { ...FILES, 'marketing/a.md': doc('Idea', 'A post') },
  })
  const r = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(r.code, 1)
  assert.equal(
    r.err.trim(),
    'not created: marketing — rness board push in a terminal, or with --yes, creates it'
  )
  // Agent Pulse holds marketing's document until its own board exists.
  assert.match(r.out, /^synced\s+3 items/m)
  assert.equal(g.mutations.filter((m) => m.op === 'createProject').length, 0)
  assert.deepEqual(await declaredIn(cwd), { pulse: 7, marketing: 'collection' })
})

test('declined in a terminal, nothing is created; a second push with --yes creates it, a third creates nothing', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo, project') })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    files: FILES,
  })
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
  const declined = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal })
  )
  assert.equal(declined.code, 1)
  assert.deepEqual(asked, ['Create Agent Pulse (pulse) on GitHub, in acme?'])
  assert.equal(
    declined.err.trim(),
    'not created: pulse — rness board push in a terminal, or with --yes, creates it'
  )
  assert.deepEqual(g.requests, [], 'GitHub not asked')
  const made = await run(() =>
    boardPushCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(made.code, 0, made.err)
  assert.deepEqual(await declaredIn(cwd), { pulse: '7 agent-pulse/1' })
  g.mutations.length = 0
  const again = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal })
  )
  assert.equal(again.code, 0, again.err)
  assert.equal(asked.length, 1, 'nothing asked: nothing to create')
  assert.deepEqual(g.mutations, [])
})

test('a board declared whole without its number: push adds the number, nothing else', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo, project') })
  const declared = {
    title: 'Agent Pulse',
    collections: 'all',
    fields: {
      Collection: { type: 'select', from: '$collection' },
    },
    views: [{ name: 'All', layout: 'table' }],
  }
  const cwd = await declaredWorkspace(t, { pulse: declared })
  const r = await run(() =>
    boardPushCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 0, r.err)
  const written = JSON.parse(
    await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')
  ).boards.pulse
  assert.deepEqual(written, { number: 7, ...declared })
  assert.deepEqual(Object.keys(written)[0], 'number')
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
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
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
      boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
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
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
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
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
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
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(r.code, 1)
  assert.equal(
    r.err.trim(),
    'boards need Issues on acme/.rness: turn them on in its Settings'
  )
  assert.deepEqual(g.mutations, [])
  assert.deepEqual(g.restViews, [])
  assert.deepEqual(g.restLabels, [])
})

test('Issues off on .rness: a board to create refused before the project is made', async (t) => {
  await machine(t)
  const g = await board(t, {
    memory: { issues: false },
    other: asUser('repo, read:org, project'),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    files: FILES,
  })
  const before = await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')
  const r = await run(() =>
    boardPushCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 1)
  assert.equal(r.out, '')
  assert.equal(
    r.err.trim(),
    'boards need Issues on acme/.rness: turn them on in its Settings'
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
    boardPushCommand(
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
      boardPushCommand(
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
    "GitHub's rate limit outlasted the 10 minutes rness waits: 2 of 2 changes not made — the next rness board push makes them"
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
      boardPushCommand(
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
    "GitHub's rate limit outlasted the 10 minutes rness waits: 1 of 2 changes not made — the next rness board push makes them"
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
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  const lines = r.out.trim().split('\n')
  assert.match(lines[0]!, /^added\s+view All$/)
  assert.match(lines[1]!, /^added\s+view Plans$/)
  assert.match(
    lines[2]!,
    /^note\s+views are not in the declared order: GitHub keeps them as they were made$/
  )
  assert.match(lines[3]!, /^created\s+2 issues$/)
  assert.match(lines[4]!, /^synced\s+2 items: 2 created$/)
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
          'Working session': 'claude · s1',
        },
        '0002 — B'
      ),
      item('i3', {
        Path: 'plans/0004-d.md',
        Agent: 'working',
        'Working session': 'claude · s2',
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
    markAs({
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
    markAs({
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

/** What `board run` recorded for the next session start, once. */
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
    markAs({
      cwd,
      githubApi,
      session: 'claude · s1',
      paths: ['adr/0001-a.md'],
    })
  )
  assert.equal(r.code, 0)
  assert.equal(r.out + r.err, '', 'no one reads a detached run')
  const reason = await takeFailure()
  assert.equal(await takeFailure(), null, 'said once')
  return reason
}

test('mark without a login records that boards need one, and exits 0', async (t) => {
  await machine(t, null)
  assert.equal(
    await recordedBy(t, 'http://127.0.0.1:1'),
    'boards need a GitHub login: run rness login'
  )
})

test('mark with a login that lacks the project scope records the scope', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo, read:org') })
  assert.equal(
    await recordedBy(t, g.base),
    'boards need the project scope: run rness login'
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

test('a board to create offline: GitHub cannot be reached, and no login is offered', async (t) => {
  await machine(t)
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 'agent-pulse' },
    files: FILES,
  })
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
  const githubApi = await offline()
  const r = await run(() => boardPushCommand({ cwd, githubApi }, { terminal }))
  assert.equal(r.code, 1)
  assert.match(r.err.trim(), /^cannot reach GitHub: \S/)
  assert.deepEqual(asked, ['Create Agent Pulse (pulse) on GitHub, in acme?'])
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
    markAs({
      cwd,
      githubApi: g.base,
      session: 'claude · s1',
      paths: ['adr/0001-a.md'],
    })
  )
  assert.equal(r.code, 0)
  assert.equal(
    await takeFailure(),
    'mark on Agent Pulse failed: the board has no field Agent'
  )
})

test('--end clears the session and its subagents (same id, any agent type), not another session', async (t) => {
  await machine(t)
  const marked = (session: string) => ({
    Path: 'plans/0002-b.md',
    Agent: 'working',
    'Working session': session,
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
    markAs({
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
    markAs({
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
  assert.equal(made?.values['Working session'], 'claude · s1')
  assert.equal(g.mutations.filter((m) => m.op === 'createIssue').length, 1)
})

test('mark: a document already on the board costs no sync, and its listing reads no body', async (t) => {
  const { g, cwd } = await settled(t)
  const before = listings(g)
  assert.match(listingQueries(g)[0]!, /\bbody\b/, "sync's listing reads them")
  const r = await run(() =>
    markAs({
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
    markAs({
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
  assert.equal(item?.values['Working session'], 'claude · s1')
  assert.ok(
    listingQueries(g)
      .slice(before)
      .some((q) => /\bbody\b/.test(q)),
    'a sync ran: its listing reads the bodies'
  )
})

test('a board made by 0.14.0 gains Sessions at its first 0.15.0 sync, which writes it in the same run', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields().filter((f) => f.name !== 'Session history'),
    views: VIEWS,
    other: asUser('repo, project'),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: {
      ...FILES,
      'plans/0002-b.md':
        '---\nstatus: In progress\nsessions: [s1]\n---\n\n# 0002 — B\n',
    },
  })
  const r = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^added\s+field Session history$/m)
  assert.equal(
    g.items.find((i) => i.values['Path'] === 'plans/0002-b.md')?.values[
      'Session history'
    ],
    's1'
  )
})

test('Sessions: a sync writes the sessions a document records, and a session end leaves them', async (t) => {
  const { g, cwd, sync } = await settled(t)
  await writeDoc(
    cwd,
    'plans/0002-b.md',
    '---\nstatus: In progress\nsessions:\n  - s1\n  - s2\n---\n\n# 0002 — B\n'
  )
  const r = await sync()
  assert.equal(r.code, 0, r.err)
  const plan = () => g.items.find((i) => i.values['Path'] === 'plans/0002-b.md')
  assert.equal(plan()?.values['Session history'], 's1, s2')
  assert.equal((await sync()).code, 0)
  assert.equal(
    g.mutations.filter((m) => JSON.stringify(m).includes('F_Sessions')).length,
    1,
    'written once, then unchanged'
  )
  const ended = await run(() =>
    markAs({
      cwd,
      githubApi: g.base,
      session: 'claude · s1',
      paths: [],
      end: true,
    })
  )
  assert.equal(ended.code, 0)
  assert.equal(plan()?.values['Session history'], 's1, s2')
})

test('mark: a file of .rness that is no document of rness status costs no sync and marks nothing', async (t) => {
  const { g, cwd } = await settled(t)
  await writeDoc(cwd, 'README.md', '# Memory\n')
  const before = listings(g)
  const r = await run(() =>
    markAs({
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
        markAs({
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
        markAs({
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
                'board-acme-7.lock'
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

/** A board laid out, FILES plus `specs/0003-c.md`, and what `seed` adds. */
async function withThirdDocument(
  t: TestContext,
  seed: NonNullable<Parameters<typeof board>[1]>
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
    files: { ...FILES, 'specs/0003-c.md': doc('Draft', '0003 — C') },
  })
  const r = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  const onPath = g.items.filter((i) => i.values['Path'] === 'specs/0003-c.md')
  return { g, r, onPath }
}

const THIRD = headerOf('specs/0003-c.md', 'acme')

test('an open issue already made for a document, on no board, is adopted — not made again', async (t) => {
  const { g, r, onPath } = await withThirdDocument(t, {
    issues: [anIssue(9, { title: 'stale', body: `${THIRD}\n\nold text` })],
  })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^adopted\s+1 issue already made for its document$/m)
  assert.match(r.out, /^created\s+2 issues$/m, 'the two other documents')
  assert.equal(onPath.length, 1)
  assert.equal(onPath[0]?.issue?.number, 9)
  assert.equal(onPath[0]?.issue?.title, '0003 — C', 'its title set again')
  assert.equal(
    g.mutations.filter(
      (m) => m.op === 'createIssue' && m.variables['title'] === '0003 — C'
    ).length,
    0
  )
})

test("an item the board's listing leaves out yet: its issue is added again as the item it is — no second issue", async (t) => {
  const made = anIssue(9, { title: '0003 — C', body: `${THIRD}\n\nbody` })
  const { g, r, onPath } = await withThirdDocument(t, {
    items: [
      {
        id: 'i9',
        draftId: null,
        issue: made,
        title: '0003 — C',
        archived: false,
        values: { Path: 'specs/0003-c.md' },
      },
    ],
    lagging: ['i9'],
  })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^adopted\s+1 issue already made for its document$/m)
  assert.deepEqual(
    onPath.map((i) => i.id),
    ['i9']
  )
  assert.equal(
    g.mutations.filter((m) => m.op === 'createIssue').length,
    2,
    'only the two other documents'
  )
})

test('a closed issue, or one without the rness label, is never adopted', async (t) => {
  const { r, onPath } = await withThirdDocument(t, {
    issues: [
      anIssue(8, { body: THIRD, state: 'CLOSED' }),
      anIssue(9, { body: THIRD, labels: [] }),
    ],
  })
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.out, /adopted/)
  assert.equal(onPath.length, 1)
  assert.ok((onPath[0]?.issue?.number ?? 0) > 9, 'a new issue')
})

/** A board as 0.15 laid it out: the session fields under their former names. */
const fields015 = (): FField[] =>
  seededFields().map((f) =>
    f.name === 'Working session'
      ? { ...f, name: 'Session' }
      : f.name === 'Session history'
        ? { ...f, name: 'Sessions' }
        : f
  )

test('a 0.15 board: sync renames Session and Sessions in place, values and ids kept (spec 0022 §2)', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: fields015(),
    views: VIEWS,
    other: asUser('repo, project'),
    items: [
      item('i1', {
        Path: 'adr/0001-a.md',
        Status: 'Accepted',
        Session: 'claude · s9',
        Sessions: 'old-id',
      }),
    ],
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: FILES,
  })
  const r = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^renamed\s+field Session → Working session$/m)
  assert.match(r.out, /^renamed\s+field Sessions → Session history$/m)
  assert.deepEqual(
    g.fields
      .filter((f) => /[Ss]ession/.test(f.name))
      .map((f) => [f.id, f.name]),
    [
      ['F_Session', 'Working session'],
      ['F_Sessions', 'Session history'],
    ]
  )
  const a = g.items.find((i) => i.id === 'i1')
  assert.equal(a?.values['Working session'], 'claude · s9', 'a mark survives')
  assert.equal(
    g.mutations.filter((m) => m.op === 'renameField').length,
    2,
    'once each'
  )
  const again = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.doesNotMatch(again.out, /renamed/)
})

test('a 0.15 board before its first 0.16 sync: a mark sets, and a session end clears, the former Session', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: fields015(),
    views: VIEWS,
    other: asUser('repo, project'),
    items: [item('i1', { Path: 'adr/0001-a.md', Status: 'Accepted' })],
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    pulse: { project: 7 },
    files: FILES,
  })
  const mark = (end: boolean) =>
    run(() =>
      markAs({
        cwd,
        githubApi: g.base,
        session: 'claude · s1',
        paths: end ? [] : ['adr/0001-a.md'],
        ...(end ? { end: true } : {}),
      })
    )
  assert.equal((await mark(false)).code, 0)
  assert.equal(await takeFailure(), null)
  const a = () => g.items.find((i) => i.id === 'i1')
  assert.equal(a()?.values['Session'], 'claude · s1')
  assert.equal((await mark(true)).code, 0)
  assert.equal(await takeFailure(), null)
  assert.equal(a()?.values['Working session'], undefined)
  assert.equal(a()?.values['Session'], undefined)
})

// --- a collection's own project (spec 0025) ---------------------------------------

const README = `---
description: The launch, from 1 October.
statuses: [Idea, Draft, Published]
fields:
  Publish date: { type: date, from: [published_at, scheduled_at] }
  Kind: { type: select, from: kind }
labels: directory
---

# The launch

Strategy.
`
const card = (status: string, extra: string, title: string) =>
  `---\nstatus: ${status}\n${extra}---\n\n# ${title}\n`
const POST = 'marketing/linkedin/2026-09-30-post.md'
const HN = 'marketing/hn/2026-09-30-hn.md'
const MARKETING_FILES = {
  ...FILES,
  'marketing/README.md': README,
  [POST]: card(
    'Draft',
    'kind: post\nscheduled_at: 2026-10-01T08:30+02:00\n',
    'First post'
  ),
  [HN]: card('Idea', 'kind: launch\n', 'Show HN'),
  'marketing/updates/2026-10-05.md':
    '---\nhealth: on-track\n---\nFirst week.\n',
}

/** Agent Pulse declared (7) with the post's card on it; the marketing collection not declared yet. */
async function beforeMarketing(t: TestContext) {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    other: asUser('repo, project'),
    existing: true,
    items: [
      {
        id: 'I_2',
        draftId: null,
        issue: anIssue(2, {
          title: '2026-09-30 — First post',
          body: headerOf(POST, 'acme'),
        }),
        title: '2026-09-30 — First post',
        archived: false,
        values: { Path: POST, Collection: 'Marketing', Status: 'Draft' },
      },
    ],
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 7 },
    files: MARKETING_FILES,
  })
  return { g, cwd }
}

test('marketing declared by its preset: its project made, its number written, synced; its documents there with their declared fields and labels; the card leaves Agent Pulse, its issue kept', async (t) => {
  const { g, cwd } = await beforeMarketing(t)
  const r = await run(() =>
    declareAndPush(cwd, g.base, 'marketing', 'collection')
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(await declaredIn(cwd), {
    pulse: 7,
    marketing: '8 collection/1',
  })
  const p = g.project(8)
  assert.equal(p.title, 'Marketing')
  assert.deepEqual(
    p.fields.find((f) => f.name === 'Status')?.options?.map((o) => o.name),
    ['Idea', 'Draft', 'Published']
  )
  const post = p.items.find((i) => i.values['Path'] === POST)
  assert.equal(post?.issue?.number, 2, 'the issue it had, adopted')
  assert.equal(post?.values['Publish date'], '2026-10-01')
  assert.equal(post?.values['Kind'], 'post')
  assert.deepEqual(post?.issue?.labels, ['rness', 'linkedin'])
  const hn = p.items.find((i) => i.values['Path'] === HN)
  assert.deepEqual(hn?.issue?.labels, ['rness', 'hn'])
  assert.equal(hn?.values['Publish date'], undefined)
  assert.equal(p.readme, '# The launch\n\nStrategy.')
  assert.equal(p.shortDescription, 'The launch, from 1 October.')
  assert.deepEqual(
    p.statusUpdates.map((u) => u.status),
    ['ON_TRACK']
  )
  // Agent Pulse keeps the others; the card is off it, its issue open.
  const pulse = g.project(7)
  assert.deepEqual(pulse.items.map((i) => i.values['Path']).sort(), [
    'adr/0001-a.md',
    'plans/0002-b.md',
  ])
  assert.equal(g.issues.find((i) => i.number === 2)?.state, 'OPEN')
  const out = lines(r.out)
  for (const line of [
    'created Marketing — https://github.com/orgs/acme/projects/8',
    "moved 1 item to their collection's project",
    `declared marketing in .rness/rness.json — commit it: git -C .rness commit -am "chore: board marketing"`,
  ])
    assert.ok(out.includes(line), `${line}\n${r.out}`)
})

test('push after marketing is created: nothing to write on either board', async (t) => {
  const { g, cwd } = await beforeMarketing(t)
  const first = await run(() =>
    declareAndPush(cwd, g.base, 'marketing', 'collection')
  )
  assert.equal(first.code, 0, first.err)
  g.mutations.length = 0
  const again = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(again.code, 0, again.err)
  assert.deepEqual(g.mutations, [])
  assert.deepEqual(lines(again.out), [
    'synced 2 items on Marketing: 2 unchanged',
    'synced 2 items: 2 unchanged',
  ])
})

test('rness pulse create marketing: declared by its preset, then pushed without asking, said on stderr', async (t) => {
  const { g, cwd } = await beforeMarketing(t)
  const r = await run(() =>
    pulseCreateCommand(
      'marketing',
      { cwd, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(r.code, 0, r.err)
  assert.equal(
    r.err.trim(),
    'boards are declared in rness.json now: added "marketing": "collection", then rness board push'
  )
  assert.deepEqual(await declaredIn(cwd), {
    pulse: 7,
    marketing: '8 collection/1',
  })
  g.mutations.length = 0
  const again = await run(() =>
    pulseCreateCommand(
      'marketing',
      { cwd, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  assert.equal(again.code, 0, again.err)
  assert.equal(again.err.trim(), 'rness pulse create is now rness board push')
  assert.deepEqual(g.mutations, [])
})

test('rness pulse create <collection>: a directory with no documents, refused before rness.json or GitHub is written', async (t) => {
  const { g, cwd } = await beforeMarketing(t)
  const before = await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')
  for (const collection of ['standards', 'nowhere']) {
    const r = await run(() =>
      pulseCreateCommand(
        collection,
        { cwd, githubApi: g.base },
        { terminal: NO_TTY }
      )
    )
    assert.equal(r.code, 1)
    assert.equal(
      r.err.trim(),
      `"boards.${collection}": ${collection} is no collection of .rness: none of its documents carries a status`
    )
  }
  assert.equal(
    await readFile(join(cwd, '.rness', 'rness.json'), 'utf8'),
    before
  )
  assert.deepEqual(g.mutations, [])
})

test('marks: on the boards that declare mark, as a hook runs them (spec 0032); the session end clears them', async (t) => {
  const { g, cwd } = await beforeMarketing(t)
  const made = await run(() =>
    declareAndPush(cwd, g.base, 'marketing', 'collection')
  )
  assert.equal(made.code, 0, made.err)
  const session = 'claude · 284bf03e'
  assert.equal(
    await markAs({
      cwd,
      githubApi: g.base,
      session,
      paths: [POST, 'adr/0001-a.md'],
    }),
    0
  )
  assert.equal(await takeFailure(), null)
  const on = (number: number, path: string) =>
    g.project(number).items.find((i) => i.values['Path'] === path)?.values
  // The collection preset declares no hooks: its cards are not marked.
  assert.equal(on(8, POST)?.['Agent'], undefined)
  assert.equal(on(7, 'adr/0001-a.md')?.['Agent'], 'working')
  assert.equal(on(7, 'adr/0001-a.md')?.['Working session'], session)
  assert.equal(
    await markAs({
      cwd,
      githubApi: g.base,
      session,
      paths: [],
      end: true,
    }),
    0
  )
  assert.equal(on(8, POST)?.['Agent'], undefined)
  assert.equal(on(7, 'adr/0001-a.md')?.['Agent'], undefined)
})

test('marks with only a collection declared: a document of another collection has no board, and its edit costs no sync', async (t) => {
  await machine(t)
  const g = await board(t, { other: asUser('repo, project') })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { marketing: 7 },
    files: MARKETING_FILES,
  })
  assert.equal(
    await markAs({
      cwd,
      githubApi: g.base,
      session: 'claude · 284bf03e',
      paths: ['adr/0001-a.md'],
    }),
    0
  )
  assert.equal(await takeFailure(), null)
  assert.deepEqual(g.mutations, [])
})

// --- boards declared in rness.json (spec 0031, plan 0045) ---------------------

/** Agent Pulse as rness ships it, on project 7, with `over` written over it. */
const pulseBoard = (
  over: Record<string, unknown> = {}
): Record<string, unknown> => ({
  number: 7,
  preset: 'agent-pulse/1',
  ...presetTemplate('agent-pulse/1', { collection: 'pulse' }),
  ...over,
})

/** A workspace whose rness.json declares `boards` as given, `.rness` a repository. */
async function declaredWorkspace(
  t: TestContext,
  boards: Record<string, unknown>,
  files: Record<string, string> = FILES
) {
  const cwd = await makeWorkspace(t, { org: 'acme', files })
  const file = join(cwd, '.rness', 'rness.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...manifest, boards }, null, 2))
  await commitDir(join(cwd, '.rness'))
  return cwd
}

test('a team view and a field no longer declared are named once per clone; a view rness made and no longer declared is deleted', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: [
      ...seededFields(),
      { id: 'F_Reach', databaseId: 30, name: 'Reach', options: null },
    ],
    views: [
      ...VIEWS,
      { name: 'Roadmap', column: 'Status', filter: 'label:launch' },
      'Marketing',
    ],
    other: asUser('repo, project'),
  })
  const cwd = await declaredWorkspace(t, { pulse: pulseBoard() })
  const sync = () =>
    run(() =>
      boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
    )
  const first = await sync()
  assert.equal(first.code, 0, first.err)
  const said = lines(first.out)
  for (const line of [
    'note field Reach is no longer declared: delete it on GitHub if unwanted',
    'deleted view Marketing',
    'note view Roadmap is not declared: delete it on GitHub if unwanted',
  ])
    assert.ok(said.includes(line), `${line}\n${first.out}`)
  assert.deepEqual(g.views, [...VIEWS, 'Roadmap'])
  const again = await sync()
  assert.equal(again.code, 0, again.err)
  assert.deepEqual(
    lines(again.out).filter((l) => /^(note|deleted) /.test(l)),
    []
  )
})

test('a collection taken off a board: its cards leave it, their issues open; declared again, the same issues come back', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    other: asUser('repo, project'),
  })
  const contract = (label: string) => ({
    statuses: 'contract',
    field: `${label} status`,
  })
  const without = pulseBoard({
    collections: { adr: contract('ADR'), specs: contract('Specs') },
    views: [
      {
        name: 'All',
        layout: 'table',
        fields: ['Title', 'Collection', 'Status', 'Working session'],
      },
      {
        name: 'ADR',
        layout: 'board',
        collection: 'adr',
        columns: 'ADR status',
      },
    ],
  })
  const all = await declaredWorkspace(t, { pulse: pulseBoard() })
  const first = await run(() =>
    boardPushCommand({ cwd: all, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(first.code, 0, first.err)
  const plan = () => g.items.find((i) => i.values['Path'] === 'plans/0002-b.md')
  const number = plan()?.issue?.number
  assert.ok(number !== undefined)

  const narrowed = await declaredWorkspace(t, { pulse: without })
  const off = await run(() =>
    boardPushCommand({ cwd: narrowed, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(off.code, 0, off.err)
  assert.equal(plan(), undefined, 'off the board')
  assert.equal(g.issues.find((i) => i.number === number)?.state, 'OPEN')

  const back = await run(() =>
    boardPushCommand({ cwd: all, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(back.code, 0, back.err)
  assert.equal(plan()?.issue?.number, number, 'the same issue, adopted')
})

test('a select from front matter on Agent Pulse: its options, then each card its value', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    other: asUser('repo, project'),
  })
  const preset = pulseBoard()
  const cwd = await declaredWorkspace(
    t,
    {
      pulse: {
        ...preset,
        fields: {
          ...(preset['fields'] as Record<string, unknown>),
          Owner: { type: 'select', from: 'owner', options: ['alice'] },
        },
      },
    },
    {
      'adr/0001-a.md': '---\nstatus: Accepted\nowner: bob\n---\n\n# 0001 — A\n',
      'plans/0002-b.md':
        '---\nstatus: In progress\nowner: alice\n---\n\n# 0002 — B\n',
    }
  )
  const r = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(
    g.fields.find((f) => f.name === 'Owner')?.options?.map((o) => o.name),
    ['alice', 'bob']
  )
  const owner = (path: string) =>
    g.items.find((i) => i.values['Path'] === path)?.values['Owner']
  assert.equal(owner('adr/0001-a.md'), 'bob')
  assert.equal(owner('plans/0002-b.md'), 'alice')
})

test('a colour changed in rness.json reaches GitHub at the next sync; every card keeps its value', async (t) => {
  const { g, cwd } = await settled(t)
  const file = join(cwd, '.rness', 'rness.json')
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  const board = pulseBoard()
  await writeFile(
    file,
    JSON.stringify({
      ...manifest,
      pulse: undefined,
      boards: {
        pulse: {
          ...board,
          colors: { ...(board['colors'] as object), Accepted: 'orange' },
        },
      },
    })
  )
  // As 0.20.1 coloured it: GitHub gives every option a colour.
  const colors = board['colors'] as Record<string, string>
  for (const o of g.fields.find((f) => f.name === 'Status')?.options ?? [])
    o.color = (colors[o.name] ?? 'gray').toUpperCase()
  const before = g.items.map((i) => i.values['Status'])
  const r = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(r.code, 0, r.err)
  const accepted = g.fields
    .find((f) => f.name === 'Status')
    ?.options?.find((o) => o.name === 'Accepted')
  assert.equal(accepted?.color, 'ORANGE')
  assert.equal(accepted?.id, 's_Accepted', 'its id kept')
  assert.deepEqual(
    g.items.map((i) => i.values['Status']),
    before
  )
})

test("a collection's README that is a link out of .rness: the sync stops on it, nothing of the file published", async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    other: asUser('repo, project'),
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 7, marketing: 8 },
    files: { ...FILES, 'marketing/a.md': '---\nstatus: Idea\n---\n# A\n' },
  })
  const secret = join(cwd, 'secret.txt')
  await writeFile(secret, 'ghp_a-developer-token\n')
  await symlink(secret, join(cwd, '.rness', 'marketing', 'README.md'))
  const r = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(r.code, 1)
  assert.match(r.err, /marketing\/README\.md leads out of \.rness/)
  assert.ok(
    g.projects.every((p) => !p.readme.includes('ghp_')),
    'nothing published'
  )
})

test("a board whose collection's README still declares: skipped by pulse sync, until rness sync moves it", async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    other: asUser('repo, project'),
  })
  const cwd = await declaredWorkspace(
    t,
    {
      pulse: pulseBoard(),
      marketing: {
        number: 8,
        ...presetTemplate('collection/1', { collection: 'marketing' }),
      },
    },
    {
      ...FILES,
      'marketing/a.md': '---\nstatus: Idea\n---\n# A\n',
      'marketing/README.md': '---\nstatuses: [Idea, Done]\n---\n# M\n',
    }
  )
  const r = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(r.code, 0, r.err)
  assert.ok(
    lines(r.out).includes(
      'skipped marketing: marketing/README.md declares statuses, which rness.json declares now — rness sync moves it'
    ),
    r.out
  )
})

// --- pulse run: what each board declares (spec 0032, plan 0046) --------------

/** Agent Pulse with its marks in fields of other names, as a team may declare them. */
const renamedBoard = () => {
  const preset = pulseBoard()
  const fields = { ...(preset['fields'] as Record<string, unknown>) }
  delete fields['Agent']
  delete fields['Working session']
  return {
    ...preset,
    fields: {
      ...fields,
      Busy: { type: 'select', from: '$agent', options: ['working'] },
      Who: { type: 'text', from: '$session' },
    },
    views: (preset['views'] as Record<string, unknown>[]).map((v) =>
      Array.isArray(v['fields'])
        ? {
            ...v,
            fields: (v['fields'] as string[]).map((f) =>
              f === 'Working session' ? 'Who' : f
            ),
          }
        : v
    ),
  }
}

test('pulse run: session start marks what mark-in-progress names, through the fields from $agent and $session whatever their names; session end clears them', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: [
      ...seededFields(),
      {
        id: 'F_Busy',
        databaseId: 40,
        name: 'Busy',
        options: [{ id: 'b1', name: 'working' }],
      },
      { id: 'F_Who', databaseId: 41, name: 'Who', options: null },
    ],
    views: VIEWS,
    other: asUser('repo, project'),
  })
  const cwd = await declaredWorkspace(t, { pulse: renamedBoard() })
  const first = await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.equal(first.code, 0, first.err)
  const session = 'claude · 1a2b3c4d'
  assert.equal(
    await boardRunCommand({
      cwd,
      githubApi: g.base,
      event: 'session-start',
      session,
      paths: [],
    }),
    0
  )
  assert.equal(await takeFailure(), null)
  const plan = () => g.items.find((i) => i.values['Path'] === 'plans/0002-b.md')
  assert.equal(plan()?.values['Busy'], 'working')
  assert.equal(plan()?.values['Who'], session)
  assert.equal(plan()?.values['Agent'], undefined)
  await boardRunCommand({
    cwd,
    githubApi: g.base,
    event: 'session-end',
    session,
    paths: [],
  })
  assert.equal(plan()?.values['Busy'], undefined)
  assert.equal(plan()?.values['Who'], undefined)
})

test('pulse run: mark-in-progress names other collections and statuses; an edit marks what a board with mark holds', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    other: asUser('repo, project'),
  })
  const cwd = await declaredWorkspace(t, {
    pulse: pulseBoard({
      hooks: {
        'session-start': [
          {
            action: 'mark-in-progress',
            collections: ['adr'],
            statuses: ['Accepted'],
          },
        ],
        edit: ['mark'],
      },
    }),
  })
  await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  const on = (path: string) =>
    g.items.find((i) => i.values['Path'] === path)?.values['Agent']
  const session = 'claude · 1a2b3c4d'
  await boardRunCommand({
    cwd,
    githubApi: g.base,
    event: 'session-start',
    session,
    paths: [],
  })
  assert.equal(on('adr/0001-a.md'), 'working')
  assert.equal(on('plans/0002-b.md'), undefined, 'not In progress here')
  await boardRunCommand({
    cwd,
    githubApi: g.base,
    event: 'edit',
    session,
    paths: ['plans/0002-b.md'],
  })
  assert.equal(on('plans/0002-b.md'), 'working')
  assert.equal(await takeFailure(), null)
})

test('pulse run: a failure on one board leaves the other done, the recorded line naming the board and the action', async (t) => {
  await machine(t)
  const g = await board(t, {
    fields: seededFields(),
    views: VIEWS,
    other: asUser('repo, project'),
    projects: [
      {
        number: 8,
        fields: [
          {
            id: 'F_status_8',
            databaseId: 81,
            name: 'Status',
            options: [{ id: 'm1', name: 'Idea' }],
          },
          { id: 'F_title_8', databaseId: 82, name: 'Title', options: null },
          {
            id: 'F_Path_8',
            databaseId: 83,
            name: 'Path',
            options: null,
          },
        ],
        views: ['All', 'Marketing', 'Working'],
      },
    ],
  })
  const files = { ...FILES, 'marketing/a.md': '---\nstatus: Idea\n---\n# A\n' }
  const marketing = {
    number: 8,
    preset: 'collection/1',
    ...presetTemplate('collection/1', { collection: 'marketing' }),
    hooks: { edit: ['mark'] },
  }
  const cwd = await declaredWorkspace(
    t,
    { marketing, pulse: pulseBoard({ hooks: { edit: ['mark'] } }) },
    files
  )
  await run(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  // The marketing board lost its Agent field on GitHub: its mark fails.
  const p8 = g.project(8)
  p8.fields = p8.fields.filter((f) => f.name !== 'Agent')
  g.mutations.length = 0
  await boardRunCommand({
    cwd,
    githubApi: g.base,
    event: 'edit',
    session: 'claude · 1a2b3c4d',
    paths: ['marketing/a.md', 'plans/0002-b.md'],
  })
  assert.equal(
    g.items.find((i) => i.values['Path'] === 'plans/0002-b.md')?.values[
      'Agent'
    ],
    'working',
    'Agent Pulse marked all the same'
  )
  assert.equal(
    await takeFailure(),
    'mark on Marketing failed: the board has no field Agent'
  )
})
