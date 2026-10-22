import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { readFooter } from '../../src/board/adf.ts'
import { boardPushCommand } from '../../src/commands/board.ts'
import { type StoredLogin, writeAuthAt } from '../../src/core/auth.ts'
import type { Terminal } from '../../src/core/terminal.ts'
import { capture } from '../helpers/capture.ts'
import { withEnv } from '../helpers/fake-github.ts'
import { commitDir, git } from '../helpers/git.ts'
import { type JiraSite, jiraSite } from '../helpers/jira-site.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

// `rness board push` on Atlassian (spec 0039 §7; plan 0053 task 6), against
// a fake Jira site holding the space RNESS as the template made it: Agent
// Pulse on the space's one board, its cards the space's issues, real
// statuses moved by transitions.

const JIRA = { site: 'acme.atlassian.net', space: 'RNESS' }
const doc = (status: string, title: string, text = '') =>
  `---\nstatus: ${status}\n---\n\n# ${title}\n${text}`
const FILES = {
  'adr/0001-a.md': doc('Accepted', '0001 - A'),
  'plans/0002-b.md': doc(
    'In progress',
    '0002 - B',
    '\nSee [A](../adr/0001-a.md); @cedric, #4.\n'
  ),
}

const NO_TTY: Terminal = {
  isTty: () => false,
  prompts: async () => {
    throw new Error('no prompt without a terminal')
  },
}

const JIRA_LOGIN: StoredLogin = {
  login: 'Cédric Magne',
  email: 'me@acme.io',
  accountId: 'acc-1',
  tokens: {
    accessToken: 'jira-tok',
    expiresAt: null,
    refreshToken: null,
    refreshExpiresAt: null,
    scopes: '',
  },
}

async function machine(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-atl-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  withEnv(t, {
    XDG_CONFIG_HOME: dir,
    BITBUCKET_TOKEN: 'bb-tok',
    JIRA_EMAIL: undefined,
    JIRA_API_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
  })
  await writeAuthAt(JIRA.site, JIRA_LOGIN)
}

async function push(cwd: string, yes = true) {
  const c = capture()
  try {
    const code = await boardPushCommand(
      { cwd, ...(yes ? { yes: true } : {}) },
      { terminal: NO_TTY }
    )
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

async function workspace(t: TestContext) {
  const cwd = await makeWorkspace(t, {
    provider: 'atlassian',
    org: 'acme',
    jira: JIRA,
    boards: { pulse: 'agent-pulse' },
    files: FILES,
  })
  process.env['GIT_AUTHOR_NAME'] ??= 'rness-test'
  process.env['GIT_AUTHOR_EMAIL'] ??= 'test@rness.invalid'
  process.env['GIT_COMMITTER_NAME'] ??= 'rness-test'
  process.env['GIT_COMMITTER_EMAIL'] ??= 'test@rness.invalid'
  await commitDir(join(cwd, '.rness'))
  return cwd
}

const statusOf = (jira: JiraSite, key: string): string | undefined =>
  jira.statuses.find(
    (s) => s.id === jira.issues.find((i) => i.key === key)?.statusId
  )?.name

test('off a terminal without --yes, nothing is set up: the push says how, exit 1', async (t) => {
  await machine(t)
  const jira = await jiraSite(t)
  const cwd = await workspace(t)
  const r = await push(cwd, false)
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /RNESS is not set up for Agent Pulse \(13 statuses, any-to-any transitions\): rness board push in a terminal, or with --yes, sets it up/
  )
  assert.deepEqual(
    jira.statuses.map((s) => s.name),
    ['To Do', 'In Progress', 'In Review', 'Done'],
    'nothing renamed or made'
  )
  assert.deepEqual(jira.issues, [])
})

test('a first push: the template renamed, the statuses made with GLOBAL transitions, the cards; Gone visible; a second push writes nothing', async (t) => {
  await machine(t)
  const jira = await jiraSite(t)
  const cwd = await workspace(t)
  const r = await push(cwd)
  assert.equal(r.code, 0, r.err)

  // The setup: three renamed, the rest made, each reachable from any other.
  assert.match(
    r.out,
    /^renamed +the template's To Do, In Progress, Done: Draft, In progress, Completed$/m
  )
  assert.match(r.out, /^created +10 statuses in RNESS: /m)
  const names = jira.statuses.map((s) => s.name)
  for (const n of [
    'Draft',
    'In progress',
    'Completed',
    'Proposed',
    'Accepted',
    'Gone',
  ])
    assert.ok(names.includes(n), n)
  assert.ok(names.includes('In Review'), "the template's In Review left")
  assert.equal(
    names.filter((n) => n.toLowerCase() === 'in progress').length,
    1,
    'one In progress, whatever the case'
  )
  for (const s of jira.statuses.filter((x) => x.name !== 'In Review'))
    assert.ok(
      jira.workflow.global.has(s.id),
      `a GLOBAL transition to ${s.name}`
    )

  // The views share the board; Gone has a column on a fresh board.
  assert.match(
    r.out,
    /views ADR, Specs, Plans share the board of RNESS: filter on collection-adr, collection-specs, collection-plans/
  )
  assert.match(
    r.out,
    /^visible +Gone has a column, so gone documents show on the board: hide it once, among the hidden statuses of the board's column settings, https:\/\/acme\.atlassian\.net\/jira\/software\/projects\/RNESS\/boards\/3$/m
  )

  // The cards: labels, the real status, the Bitbucket header, links to issues, the digest in a property.
  const plan = jira.issues.find((i) => i.summary === '0002 - B')
  const adr = jira.issues.find((i) => i.summary === '0001 - A')
  assert.ok(
    plan !== undefined && adr !== undefined,
    JSON.stringify(jira.issues.map((i) => i.summary))
  )
  assert.deepEqual([...plan.labels].sort(), ['collection-plans', 'rness'])
  assert.equal(statusOf(jira, plan.key), 'In progress')
  assert.equal(statusOf(jira, adr.key), 'Accepted')
  const text = JSON.stringify(plan.description)
  assert.match(text, /"text":"plans\/0002-b\.md","marks":\[\{"type":"code"\}\]/)
  assert.match(
    text,
    /https:\/\/bitbucket\.org\/acme\/\.rness\/src\/main\/plans\/0002-b\.md/
  )
  assert.match(
    text,
    new RegExp(`https://acme\\.atlassian\\.net/browse/${adr.key}`)
  )
  assert.match(text, /@cedric, #4\./, 'nothing neutralized')
  assert.match(
    String(
      (plan.properties['rness'] as { digest?: string } | undefined)?.digest
    ),
    /^[0-9a-f]{12}$/
  )

  const writes = jira.issueWrites().length
  const again = await push(cwd)
  assert.equal(again.code, 0, again.err)
  assert.equal(
    jira.issueWrites().length,
    writes,
    'a second push writes no issue'
  )
  assert.doesNotMatch(again.out, /^(renamed|created) /m, 'nothing set up twice')
  assert.doesNotMatch(again.out, /share the board/, 'a note is said once')
})

test('Gone hidden by the team: the push checks every column; a status declared later gets none and is said unmapped', async (t) => {
  await machine(t)
  const jira = await jiraSite(t)
  const cwd = await workspace(t)
  assert.equal((await push(cwd)).code, 0)
  jira.hide('Gone')
  const checked = await push(cwd)
  assert.equal(checked.code, 0, checked.err)
  assert.match(
    checked.out,
    /^checked +board RNESS: every status in a column, Gone hidden$/m
  )
  // A status the team hides too: its cards are off the board, said.
  jira.hide('Blocked')
  const unmapped = await push(cwd)
  assert.match(
    unmapped.out,
    /^unmapped +a status has no column, their cards hidden: Blocked; map it once in the board's column settings, https:\/\/acme\.atlassian\.net\/jira\/software\/projects\/RNESS\/boards\/3$/m
  )
})

test('a card moved by hand is moved back; a document gone goes to Gone, and back when it returns', async (t) => {
  await machine(t)
  const jira = await jiraSite(t)
  const cwd = await workspace(t)
  assert.equal((await push(cwd)).code, 0)
  const adr = jira.issues.find((i) => i.summary === '0001 - A')
  assert.ok(adr !== undefined)
  const draft = jira.statuses.find((s) => s.name === 'Draft')
  assert.ok(draft !== undefined)
  adr.statusId = draft.id
  assert.equal((await push(cwd)).code, 0)
  assert.equal(statusOf(jira, adr.key), 'Accepted')

  await unlink(join(cwd, '.rness', 'adr', '0001-a.md'))
  await git(['add', '-A'], join(cwd, '.rness'))
  await git(['commit', '-q', '-m', 'gone'], join(cwd, '.rness'))
  const gone = await push(cwd)
  assert.equal(gone.code, 0, gone.err)
  assert.equal(statusOf(jira, adr.key), 'Gone')

  await git(['revert', '--no-edit', 'HEAD'], join(cwd, '.rness'))
  const back = await push(cwd)
  assert.equal(back.code, 0, back.err)
  assert.equal(statusOf(jira, adr.key), 'Accepted')
})

test('marks: agent-working and the footer paragraph, the body untouched; cleared, both gone; a body rewritten keeps the footer', async (t) => {
  await machine(t)
  const jira = await jiraSite(t)
  const cwd = await workspace(t)
  assert.equal((await push(cwd)).code, 0)
  const { AtlassianProvider } =
    await import('../../src/core/atlassian-provider.ts')
  const provider = new AtlassianProvider({
    token: { token: 'bb-tok', source: 'BITBUCKET_TOKEN', login: null },
    jira: JIRA,
  })
  const board = await provider.board('acme', 0, null)
  assert.ok(board !== null)
  assert.equal(
    board.url,
    'https://acme.atlassian.net/jira/software/projects/RNESS/boards/3'
  )
  const items = await provider.items(board, { bodies: false })
  const item = items.find((i) => i.path === 'plans/0002-b.md')
  assert.ok(item !== undefined)
  const issue = jira.issues.find((i) => i.key === item.id)
  assert.ok(issue?.description != null)
  const before = readFooter(issue.description).body

  await provider.mark(board, [item.id], 'claude · 1a2b3c4d')
  assert.ok(issue.labels.includes('agent-working'))
  assert.ok(issue.description !== null)
  assert.deepEqual(readFooter(issue.description), {
    body: before,
    values: { 'Working session': 'claude · 1a2b3c4d' },
  })
  const read = (await provider.items(board)).find((i) => i.id === item.id)
  assert.equal(read?.agent, 'working')
  assert.equal(read?.session, 'claude · 1a2b3c4d')

  // A push meanwhile rewrites no body and keeps the mark.
  assert.equal((await push(cwd)).code, 0)
  assert.ok(issue.labels.includes('agent-working'))

  await provider.mark(board, [item.id], null)
  assert.ok(!issue.labels.some((l) => l.startsWith('agent-')))
  assert.ok(issue.description !== null)
  assert.deepEqual(readFooter(issue.description), { body: before, values: {} })
})

test('rness note on Atlassian: the plan card in the space gets the note, in ADF, referred to by its key', async (t) => {
  await machine(t)
  const jira = await jiraSite(t)
  const { currentPreset, presetTemplate } =
    await import('../../src/core/presets.ts')
  const { PULSE } = await import('../../src/core/manifest.ts')
  const template = presetTemplate(currentPreset('agent-pulse'), {
    collection: PULSE,
  }) as Record<string, unknown>
  const cwd = await makeWorkspace(t, {
    provider: 'atlassian',
    org: 'acme',
    jira: JIRA,
    boards: {
      pulse: {
        ...template,
        hooks: {
          ...(template['hooks'] as Record<string, unknown>),
          'session-start': [
            'mark-in-progress',
            { action: 'journal', to: 'plan' },
          ],
        },
      },
    },
    files: FILES,
  })
  await commitDir(join(cwd, '.rness'))
  assert.equal((await push(cwd)).code, 0)
  const plan = jira.issues.find((i) => i.summary === '0002 - B')
  assert.ok(plan !== undefined)
  const { postNote } = await import('../../src/commands/note.ts')
  const posted = await postNote({
    cwd,
    text: 'Took the status route.',
    kind: 'approach',
    plan: 'plans/0002-b.md',
    session: 'claude · 1a2b3c4d',
  })
  assert.deepEqual(posted, { reference: plan.key, to: 'plan' })
  const comment = JSON.stringify(plan.comments[0])
  assert.match(comment, /"text":"Approach","marks":\[\{"type":"strong"\}\]/)
  assert.match(comment, /Took the status route\./)
  assert.doesNotMatch(comment, /rness note/, 'the marker comment dropped')
})

test("the status link on Atlassian: the space's boards page, the board's id not being in rness.json", async () => {
  const { snapshotTabs, statusSnapshot } =
    await import('../../src/commands/snapshot.ts')
  const { parseBoard } = await import('../../src/core/board-declaration.ts')
  const declaration = parseBoard('pulse', {
    collections: { adr: { statuses: 'contract' } },
    views: [{ name: 'ADR', layout: 'board' }],
  })
  const [tab] = snapshotTabs(
    [
      {
        name: 'adr',
        label: 'ADR',
        rows: [
          { id: '0001', title: 'A', status: 'Accepted', path: 'adr/0001-a.md' },
        ],
      },
    ] as never,
    'acme',
    [{ name: 'pulse', declaration }],
    JIRA
  )
  assert.equal(
    tab?.rows[0]?.link,
    'https://acme.atlassian.net/jira/software/projects/RNESS/boards'
  )
  assert.equal(typeof statusSnapshot, 'function')
})
