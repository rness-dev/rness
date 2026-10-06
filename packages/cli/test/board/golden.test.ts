import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  boardPushCommand,
  pulseCreateCommand,
} from '../../src/commands/board.ts'
import { syncCommand } from '../../src/commands/sync.ts'
import type { Terminal } from '../../src/core/terminal.ts'
import { capture } from '../helpers/capture.ts'
import { type Reply, withEnv } from '../helpers/fake-github.ts'
import {
  type FField,
  type FItem,
  type FProject,
  type FView,
  board,
} from '../helpers/fake-project.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

// The golden boards (plan 0045, task 1): Agent Pulse and a collection's own
// project as 0.20.1 builds them, recorded before boards became declarations.
// Every change after keeps them: the same fields, options, colours, views,
// cards and labels, and a sync of a board 0.20.1 made writes nothing.
// `RNESS_GOLDEN=write` records the fixtures again.

const FIXTURES = fileURLToPath(new URL('../fixtures/boards/', import.meta.url))
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

async function quiet(work: () => Promise<number>): Promise<void> {
  const c = capture()
  try {
    const code = await work()
    assert.equal(code, 0, c.err())
  } finally {
    c.restore()
  }
}

const doc = (status: string, title: string, extra = '') =>
  `---\nstatus: ${status}\n${extra}---\n\n# ${title}\n`

/** ADR, specs, plans and a discovered collection: every kind of tab Agent Pulse shows. */
const PULSE_FILES = {
  'adr/0001-org.md': doc('Accepted', '0001 — A workspace is an org'),
  'specs/0001-a.md': doc('Draft', '0001 — First'),
  'specs/0002-b.md': doc('Approved', '0002 — Second'),
  'plans/0001-x.md': doc(
    'In progress',
    '0001 — Do it',
    'sessions:\n  - { id: 1a2b3c4d, agent: Claude Opus 5.5 }\n'
  ),
  'research/0001-r.md': doc('Exploring', '0001 — A question'),
}

const README = `---
description: The launch, from 1 October.
statuses: [Idea, Draft, Published]
fields:
  Publish date: { type: date, from: [published_at, scheduled_at] }
  Kind: { type: select, from: kind, options: [post, launch] }
  Reach: { type: number, from: reach }
labels: directory
---

# The launch

Strategy.
`
const MARKETING_FILES = {
  'adr/0001-org.md': doc('Accepted', '0001 — A workspace is an org'),
  'marketing/README.md': README,
  'marketing/linkedin/2026-09-30-post.md': doc(
    'Draft',
    'First post',
    'kind: post\nscheduled_at: 2026-10-01T08:30+02:00\nreach: 120\n'
  ),
  'marketing/hn/2026-09-30-hn.md': doc('Idea', 'Show HN', 'kind: launch\n'),
  'marketing/updates/2026-10-05.md':
    '---\nhealth: on-track\nstart_date: 2026-10-01\n---\nFirst week.\n',
}

/** A project as a team sees it: no ids, cards by path. */
function snapshot(p: FProject, issues: { number: number; labels: string[] }[]) {
  const issueOf = (i: FItem) =>
    i.issue == null
      ? null
      : {
          title: i.issue.title,
          state: i.issue.state,
          labels: [
            ...(issues.find((x) => x.number === i.issue?.number)?.labels ??
              i.issue.labels),
          ].sort(),
        }
  return {
    title: p.title,
    readme: p.readme,
    shortDescription: p.shortDescription,
    linked: p.linked,
    statusUpdates: p.statusUpdates.map((u) => ({
      body: u.body,
      status: u.status,
      startDate: u.startDate,
      targetDate: u.targetDate,
    })),
    fields: [...p.fields]
      .map((f) => ({
        name: f.name,
        dataType: f.dataType ?? (f.options === null ? 'TEXT' : 'SINGLE_SELECT'),
        options:
          f.options?.map((o) => ({ name: o.name, color: o.color ?? null })) ??
          null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    views: p.viewList.map((v) => ({
      name: v.name,
      layout: v.layout,
      column: v.column,
      filter: v.filter,
      // GitHub lists them in the project's order, whatever was sent.
      fields: v.fields === null ? null : [...v.fields].sort(),
    })),
    cards: p.items
      .filter((i) => !i.archived)
      .map((i) => ({ values: i.values, issue: issueOf(i) }))
      .sort((a, b) =>
        String(a.values['Path']).localeCompare(String(b.values['Path']))
      ),
  }
}

async function golden(name: string, actual: unknown): Promise<void> {
  const file = join(FIXTURES, `${name}.json`)
  if (WRITE) {
    await writeFile(file, `${JSON.stringify(actual, null, 2)}\n`)
    return
  }
  assert.deepEqual(actual, JSON.parse(await readFile(file, 'utf8')))
}

/** A board seeded as a fixture records it: what 0.20.1 left on GitHub. */
function seeded(fixture: ReturnType<typeof snapshot>, number: number) {
  let n = 0
  const fields: FField[] = fixture.fields.map((f) => ({
    id: `F_${f.name}`,
    databaseId: 500 + n++,
    name: f.name,
    dataType: f.dataType,
    options:
      f.options?.map((o) => ({
        id: `o_${f.name}_${o.name}`,
        name: o.name,
        ...(o.color === null ? {} : { color: o.color }),
      })) ?? null,
  }))
  const views: FView[] = fixture.views.map((v) => ({ ...v }))
  const items: FItem[] = fixture.cards.map((c, i) => ({
    id: `I_${number}_${i}`,
    draftId: null,
    issue:
      c.issue === null
        ? null
        : {
            id: `ISSUE_${number}_${i}`,
            number: number * 100 + i,
            title: c.issue.title,
            body: '',
            state: c.issue.state as 'OPEN' | 'CLOSED',
            labels: [...c.issue.labels],
            repository: 'acme/.rness',
          },
    title: c.issue?.title ?? '',
    archived: false,
    values: { ...c.values },
  }))
  return {
    number,
    title: fixture.title,
    fields,
    views,
    items,
    linked: fixture.linked,
    readme: fixture.readme,
    shortDescription: fixture.shortDescription,
    statusUpdates: fixture.statusUpdates.map((u, i) => ({
      id: `SU_${i}`,
      ...u,
    })),
  }
}

test('golden: Agent Pulse as 0.20.1 makes it, and a second sync writes nothing', async (t) => {
  await machine(t)
  const g = await board(t, {
    other: asUser,
    memory: { label: false, linked: false },
  })
  const cwd = await makeWorkspace(t, { org: 'acme', files: PULSE_FILES })
  await quiet(() =>
    pulseCreateCommand(
      { cwd, yes: true, githubApi: g.base },
      { terminal: NO_TTY }
    )
  )
  await golden('agent-pulse', snapshot(g.project(7), g.issues))
  g.mutations.length = 0
  await quiet(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.deepEqual(g.mutations, [])
})

test("golden: a collection's own project as 0.20.1 makes it, and a second sync writes nothing on either", async (t) => {
  await machine(t)
  const pulse = JSON.parse(
    await readFile(join(FIXTURES, 'agent-pulse.json'), 'utf8')
  ) as ReturnType<typeof snapshot>
  const first = seeded(pulse, 7)
  const g = await board(t, {
    other: asUser,
    existing: true,
    fields: first.fields,
    views: first.views,
    items: [],
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 7 },
    files: MARKETING_FILES,
  })
  await quiet(() =>
    pulseCreateCommand(
      { cwd, githubApi: g.base, collection: 'marketing' },
      { terminal: NO_TTY }
    )
  )
  await golden('marketing', snapshot(g.project(8), g.issues))
  g.mutations.length = 0
  await quiet(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.deepEqual(g.mutations, [])
})

test('golden: boards 0.20.1 made, declared by number, synced: nothing written', async (t) => {
  await machine(t)
  const read = async (name: string) =>
    JSON.parse(
      await readFile(join(FIXTURES, `${name}.json`), 'utf8')
    ) as ReturnType<typeof snapshot>
  const first = seeded(await read('agent-pulse'), 7)
  const second = seeded(await read('marketing'), 8)
  const g = await board(t, {
    other: asUser,
    existing: true,
    fields: first.fields,
    views: first.views,
    items: first.items,
    projects: [second],
  })
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 7 },
    files: PULSE_FILES,
  })
  // The issues' bodies are the documents': the first sync writes them, the
  // fixture keeps no body. Then nothing.
  await quiet(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.deepEqual(
    g.mutations.filter((m) => m.op !== 'updateIssue'),
    []
  )
  const both = await makeWorkspace(t, {
    org: 'acme',
    boards: { marketing: 8 },
    files: MARKETING_FILES,
  })
  g.mutations.length = 0
  await quiet(() =>
    boardPushCommand({ cwd: both, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.deepEqual(
    g.mutations.filter((m) => m.op !== 'updateIssue'),
    []
  )
})

test('golden: rness sync writes the boards 0.20.1 declared by number whole, the README cleaned; a pulse sync then writes nothing', async (t) => {
  await machine(t)
  const read = async (name: string) =>
    JSON.parse(
      await readFile(join(FIXTURES, `${name}.json`), 'utf8')
    ) as ReturnType<typeof snapshot>
  const first = seeded(await read('agent-pulse'), 7)
  const second = seeded(await read('marketing'), 8)
  const g = await board(t, {
    other: asUser,
    existing: true,
    fields: first.fields,
    views: first.views,
    items: first.items,
    projects: [second],
  })
  const files = { ...PULSE_FILES, ...MARKETING_FILES }
  const cwd = await makeWorkspace(t, {
    org: 'acme',
    boards: { pulse: 7, marketing: 8 },
    files,
  })
  await quiet(() => syncCommand({ cwd, yes: true }, { terminal: NO_TTY }))
  const manifest = JSON.parse(
    await readFile(join(cwd, '.rness', 'rness.json'), 'utf8')
  )
  assert.equal(manifest.boards.pulse.preset, 'agent-pulse/1')
  assert.equal(manifest.boards.marketing.preset, 'collection/1')
  assert.equal(
    manifest.boards.marketing.description,
    'The launch, from 1 October.'
  )
  assert.equal(
    await readFile(join(cwd, '.rness', 'marketing', 'README.md'), 'utf8'),
    '# The launch\n\nStrategy.\n'
  )
  await quiet(() =>
    boardPushCommand({ cwd, githubApi: g.base }, { terminal: NO_TTY })
  )
  assert.deepEqual(
    g.mutations.filter((m) => m.op !== 'updateIssue'),
    []
  )
})
