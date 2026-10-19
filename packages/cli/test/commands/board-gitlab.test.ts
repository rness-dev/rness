import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { digestOf } from '../../src/board/body.ts'
import { splitFooter } from '../../src/board/footer.ts'
import { boardPushCommand } from '../../src/commands/board.ts'
import { PULSE } from '../../src/core/manifest.ts'
import { currentPreset, presetTemplate } from '../../src/core/presets.ts'
import type { Terminal } from '../../src/core/terminal.ts'
import { capture } from '../helpers/capture.ts'
import { withEnv } from '../helpers/fake-github.ts'
import { commitDir, git } from '../helpers/git.ts'
import { gitlabProject } from '../helpers/gitlab-project.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

// `rness board push` on GitLab (spec 0037 §7; plan 0049 task 6), against a
// fake gitlab.com holding acme/rness: Agent Pulse as issue boards of the
// context project, its cards the project's issues.

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

async function machine(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-gl-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  withEnv(t, {
    XDG_CONFIG_HOME: dir,
    GITLAB_TOKEN: 'glpat-test',
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
  })
}

async function push(cwd: string) {
  const c = capture()
  try {
    const code = await boardPushCommand(
      { cwd, yes: true },
      { terminal: NO_TTY }
    )
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

/** A GitLab workspace whose .rness is a repository, as a clone is: what was said once is kept there. */
async function workspace(
  t: TestContext,
  boards: unknown = { pulse: 'agent-pulse' }
) {
  const cwd = await makeWorkspace(t, {
    provider: 'gitlab',
    org: 'acme',
    boards: boards as Record<string, string>,
    files: FILES,
  })
  process.env['GIT_AUTHOR_NAME'] ??= 'rness-test'
  process.env['GIT_AUTHOR_EMAIL'] ??= 'test@rness.invalid'
  process.env['GIT_COMMITTER_NAME'] ??= 'rness-test'
  process.env['GIT_COMMITTER_EMAIL'] ??= 'test@rness.invalid'
  await commitDir(join(cwd, '.rness'))
  return cwd
}

test('a first push: one issue board per view, ids declared in view order, labels, lists in order, the cards; a second changes nothing', async (t) => {
  await machine(t)
  const gl = await gitlabProject(t)
  const cwd = await workspace(t)
  const r = await push(cwd)
  assert.equal(r.code, 0, r.err)

  // The boards: Agent Pulse's three board views, both lists hidden.
  assert.deepEqual(
    gl.boards.map((b) => [b.name, b.hide_backlog_list, b.hide_closed_list]),
    [
      ['Agent Pulse · ADR', true, true],
      ['Agent Pulse · Specs', true, true],
      ['Agent Pulse · Plans', true, true],
    ]
  )
  const manifest = JSON.parse(
    await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')
  ) as { boards: { pulse: { ids: Record<string, number>; number?: number } } }
  assert.deepEqual(manifest.boards.pulse.ids, {
    ADR: gl.boards[0]?.id,
    Specs: gl.boards[1]?.id,
    Plans: gl.boards[2]?.id,
  })
  assert.equal(manifest.boards.pulse.number, undefined)

  // The ADR board's lists: its collection's statuses, in the contract's order.
  assert.deepEqual(
    gl.boards[0]?.lists.map((l) => l.label.name),
    [
      'ADR status::Proposed',
      'ADR status::Accepted',
      'ADR status::Rejected',
      'ADR status::Superseded',
    ]
  )
  assert.ok(gl.labels.some((l) => l.name === 'rness'))
  assert.ok(gl.labels.some((l) => l.name === 'Agent::working'))

  // The cards: labels for the selects, the GitLab header, the body with its digest.
  const plan = gl.issues.find((i) => i.title === '0002 - B')
  assert.ok(plan !== undefined, JSON.stringify(gl.issues.map((i) => i.title)))
  assert.deepEqual([...plan.labels].sort(), [
    'Collection::Plans',
    'Plans status::In progress',
    'Status::In progress',
    'rness',
  ])
  const { body } = splitFooter(plan.description)
  assert.match(
    body,
    /^`plans\/0002-b\.md` · \[on GitLab\]\(https:\/\/gitlab\.com\/acme\/rness\/-\/blob\/main\/plans\/0002-b\.md\)/
  )
  assert.notEqual(digestOf(body), null)
  assert.match(
    body,
    /\[A\]\(https:\/\/gitlab\.com\/acme\/rness\/-\/issues\/\d+\)/
  )
  assert.match(body, /\\@cedric, \\#4\./)

  // The table views, said once, as GitLab's issue lists.
  assert.match(
    r.out,
    /view All: a table is not a board on GitLab - https:\/\/gitlab\.com\/acme\/rness\/-\/issues\/\?label_name\[\]=rness/
  )
  assert.match(r.out, /declared +pulse in \.rness\/rness\.json/)

  const writes = gl.issueWrites().length
  const again = await push(cwd)
  assert.equal(again.code, 0, again.err)
  assert.equal(gl.issueWrites().length, writes, 'a second push writes no issue')
  assert.equal(gl.boards.length, 3, 'and makes no board')
  assert.doesNotMatch(
    again.out,
    /a table is not a board/,
    'a note is said once'
  )
})

test('a card moved by hand is written back; a status changed in a document swaps its labels, siblings off', async (t) => {
  await machine(t)
  const gl = await gitlabProject(t)
  const cwd = await workspace(t)
  assert.equal((await push(cwd)).code, 0)
  const adr = gl.issues.find((i) => i.title.startsWith('0001'))
  assert.ok(adr !== undefined)
  // Dragged on the board from Accepted to Superseded: GitLab swaps the labels.
  adr.labels = adr.labels
    .filter((l) => l !== 'ADR status::Accepted' && l !== 'Status::Accepted')
    .concat(['ADR status::Superseded', 'Status::Superseded'])
  const r = await push(cwd)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(adr.labels.filter((l) => l.includes('::')).sort(), [
    'ADR status::Accepted',
    'Collection::ADR',
    'Status::Accepted',
  ])
})

test('rness note on GitLab: the plan card in acme/rness gets the note', async (t) => {
  await machine(t)
  const gl = await gitlabProject(t)
  // Agent Pulse with the journal kept on the plan's card.
  const template = presetTemplate(currentPreset('agent-pulse'), {
    collection: PULSE,
  }) as Record<string, unknown>
  const cwd = await workspace(t, {
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
  })
  assert.equal((await push(cwd)).code, 0)
  const plan = gl.issues.find((i) => i.title === '0002 - B')
  assert.ok(plan !== undefined)
  const { postNote } = await import('../../src/commands/note.ts')
  const posted = await postNote({
    cwd,
    text: 'Took the label route.',
    kind: 'approach',
    plan: 'plans/0002-b.md',
    session: 'claude · 1a2b3c4d',
  })
  assert.deepEqual(posted, { reference: `acme/rness#${plan.iid}`, to: 'plan' })
  const note = gl.requests.find(
    (r) =>
      r.method === 'POST' &&
      r.path.endsWith(`/projects/acme%2Frness/issues/${plan.iid}/notes`)
  )
  assert.match(
    String((note?.body as { body: string }).body),
    /^\*\*Approach\*\* · claude · 1a2b3c4d/
  )
})

test('marks: Agent::working and the footer line, the body and its digest untouched; cleared, both gone', async (t) => {
  await machine(t)
  const gl = await gitlabProject(t)
  const cwd = await workspace(t)
  assert.equal((await push(cwd)).code, 0)
  const { GitLabOAuthProvider } =
    await import('../../src/core/gitlab-oauth-provider.ts')
  const provider = new GitLabOAuthProvider({
    token: { token: 'glpat-test', source: 'GITLAB_TOKEN', login: null },
  })
  const manifest = JSON.parse(
    await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')
  ) as { boards: { pulse: { ids: Record<string, number> } } }
  const ids = manifest.boards.pulse.ids
  const board = await provider.board('acme', Object.values(ids)[0] ?? 0, ids)
  assert.ok(board !== null)
  const items = await provider.items(board, { bodies: false })
  const item = items.find((i) => i.path === 'plans/0002-b.md')
  assert.ok(item !== undefined)
  const issue = gl.issues.find((i) => String(i.iid) === item.id)
  assert.ok(issue !== undefined)
  const before = splitFooter(issue.description).body

  await provider.mark(board, [item.id], 'claude · 1a2b3c4d')
  assert.ok(issue.labels.includes('Agent::working'))
  assert.deepEqual(splitFooter(issue.description), {
    body: before,
    values: { 'Working session': 'claude · 1a2b3c4d' },
  })
  const read = (await provider.items(board)).find((i) => i.id === item.id)
  assert.equal(read?.agent, 'working')
  assert.equal(read?.session, 'claude · 1a2b3c4d')

  await provider.mark(board, [item.id], null)
  assert.ok(!issue.labels.some((l) => l.startsWith('Agent::')))
  assert.equal(issue.description.trimEnd(), before.trimEnd())
})

test('a document gone from the clone closes its card', async (t) => {
  await machine(t)
  const gl = await gitlabProject(t)
  const cwd = await workspace(t)
  assert.equal((await push(cwd)).code, 0)
  await unlink(join(cwd, '.rness', 'adr', '0001-a.md'))
  await git(['add', '-A'], join(cwd, '.rness'))
  await git(['commit', '-q', '-m', 'gone'], join(cwd, '.rness'))
  const r = await push(cwd)
  assert.equal(r.code, 0, r.err)
  const adr = gl.issues.find((i) => i.title.startsWith('0001'))
  assert.equal(adr?.state, 'closed')
})

test("the status link of a board with ids: the first view's issue board", async () => {
  const { snapshotTabs } = await import('../../src/commands/snapshot.ts')
  const { parseBoard } = await import('../../src/core/board-declaration.ts')
  const declaration = parseBoard('pulse', {
    collections: { adr: { statuses: 'contract' } },
    views: [{ name: 'ADR', layout: 'board' }],
    ids: { ADR: 12, Specs: 13 },
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
    [{ name: 'pulse', declaration }]
  )
  assert.equal(tab?.rows[0]?.link, 'https://gitlab.com/acme/rness/-/boards/12')
})

test("a clone of a subgroup project is the workspace's; another group's is not", async () => {
  const { gitlabRepo, workspaceRepo } =
    await import('../../src/commands/note.ts')
  assert.deepEqual(gitlabRepo('git@gitlab.com:acme/platform/mobile.git'), {
    owner: 'acme/platform',
    name: 'mobile',
  })
  const c = {
    org: 'acme',
    manifest: { provider: 'gitlab', repos: {} },
  } as never
  assert.deepEqual(
    workspaceRepo(c, 'https://gitlab.com/acme/platform/mobile.git'),
    { owner: 'acme/platform', name: 'mobile' }
  )
  assert.equal(workspaceRepo(c, 'git@gitlab.com:other/api.git'), null)
  assert.equal(workspaceRepo(c, 'git@gitlab.com:acmeish/api.git'), null)
})
