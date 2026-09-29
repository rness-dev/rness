import assert from 'node:assert/strict'
import { type TestContext, test } from 'node:test'

import { GitHubOAuthProvider } from '../../src/core/github-oauth-provider.ts'
import type { Layout } from '../../src/pulse/layout.ts'
import { type FItem, board } from '../helpers/fake-project.ts'

const layout: Layout = {
  statuses: ['draft', 'accepted'],
  types: ['ADR', 'Marketing'],
  views: [
    { name: 'ADR', type: 'ADR' },
    { name: 'Marketing', type: 'Marketing' },
  ],
}

const BOARD = {
  org: 'acme',
  number: 7,
  url: 'https://github.com/orgs/acme/projects/7',
}

test('createBoard: the project, its fields, the Status options, one view per type and the Working table', async (t) => {
  const g = await board(t)
  const created = await g.provider.createBoard('acme', layout)
  assert.deepEqual(created, BOARD)

  assert.deepEqual(
    g.mutations.find((m) => m.op === 'createProject')?.variables,
    {
      ownerId: 'O_1',
      title: 'Agent Pulse',
    }
  )
  assert.deepEqual(
    g.fields.map((f) => [f.name, f.options?.map((o) => o.name) ?? 'text']),
    [
      ['Status', ['draft', 'accepted']],
      ['Type', ['ADR', 'Marketing']],
      ['Agent', ['working']],
      ['Session', 'text'],
      ['Path', 'text'],
    ]
  )
  const statusId = g.fields[0]!.databaseId
  assert.deepEqual(g.restViews, [
    {
      name: 'ADR',
      layout: 'board',
      filter: 'type:"ADR"',
      vertical_group_by: [statusId],
    },
    {
      name: 'Marketing',
      layout: 'board',
      filter: 'type:"Marketing"',
      vertical_group_by: [statusId],
    },
    { name: 'Working', layout: 'table', filter: 'agent:working' },
  ])
})

test('board: the project of a number, or null', async (t) => {
  const g = await board(t)
  assert.deepEqual(await g.provider.board('acme', 7), BOARD)
})

test('ensureLayout adds only what is missing, and removes nothing', async (t) => {
  const g = await board(t, {
    fields: [
      {
        id: 'F_status',
        databaseId: 1,
        name: 'Status',
        options: [
          { id: 's1', name: 'draft' },
          { id: 's2', name: 'obsolete' },
        ],
      },
      {
        id: 'F_Type',
        databaseId: 2,
        name: 'Type',
        options: [{ id: 't1', name: 'ADR' }],
      },
      {
        id: 'F_Agent',
        databaseId: 3,
        name: 'Agent',
        options: [{ id: 'a1', name: 'working' }],
      },
      { id: 'F_Session', databaseId: 4, name: 'Session', options: null },
      { id: 'F_Path', databaseId: 5, name: 'Path', options: null },
    ],
    views: ['ADR', 'Working'],
  })
  const added = await g.provider.ensureLayout(BOARD, layout)
  assert.deepEqual(added, [
    'option accepted',
    'option Marketing',
    'view Marketing',
  ])
  assert.deepEqual(
    g.fields[0]!.options?.map((o) => o.name),
    ['draft', 'obsolete', 'accepted']
  )
  assert.equal(
    g.fields[0]!.options?.[0]?.id,
    's1',
    'kept options keep their id'
  )
  assert.deepEqual(
    g.fields[1]!.options?.map((o) => o.name),
    ['ADR', 'Marketing']
  )
  assert.equal(g.restViews.length, 1)

  const again = await g.provider.ensureLayout(BOARD, layout)
  assert.deepEqual(again, [])
})

test('items: values by field name, missing ones null, archived ones not listed', async (t) => {
  const g = await board(t, {
    fields: [
      {
        id: 'F_status',
        databaseId: 1,
        name: 'Status',
        options: [{ id: 's1', name: 'draft' }],
      },
      { id: 'F_Path', databaseId: 5, name: 'Path', options: null },
    ],
    items: [
      {
        id: 'I_gone',
        draftId: 'D_0',
        title: '0001 — A',
        archived: true,
        values: { Status: 'draft', Path: 'adr/a.md' },
      },
      {
        id: 'I_1',
        draftId: 'D_1',
        title: '0001 — A',
        archived: false,
        values: { Status: 'draft', Path: 'adr/a.md' },
      },
      {
        id: 'I_2',
        draftId: 'D_2',
        title: 'by hand',
        archived: false,
        values: {},
      },
    ],
  })
  assert.deepEqual(await g.provider.items(BOARD), [
    {
      id: 'I_1',
      path: 'adr/a.md',
      title: '0001 — A',
      status: 'draft',
      type: null,
      agent: null,
      session: null,
    },
    {
      id: 'I_2',
      path: null,
      title: 'by hand',
      status: null,
      type: null,
      agent: null,
      session: null,
    },
  ])
})

async function laidOut(t: TestContext, items: FItem[] = []) {
  const g = await board(t, { items })
  await g.provider.createBoard('acme', layout)
  g.mutations.length = 0
  return g
}

const want = {
  path: 'adr/a.md',
  title: '0001 — A',
  body: 'adr/a.md\n\nlink',
  status: 'draft',
  type: 'ADR',
}

test('apply create: a draft, then Path, Type and Status', async (t) => {
  const g = await laidOut(t)
  await g.provider.apply(BOARD, { kind: 'create', want })
  const ops = g.mutations.map((m) => m.op)
  assert.deepEqual(ops, ['addDraft', 'set', 'set', 'set'])
  assert.deepEqual(g.mutations[0]!.variables, {
    projectId: 'P_1',
    title: '0001 — A',
    body: 'adr/a.md\n\nlink',
  })
  const sent = g.mutations
    .slice(1)
    .map((m) => [m.variables['fieldId'], m.variables['value']])
  const optionId = (field: string, name: string) =>
    g.fields
      .find((f) => f.name === field)!
      .options!.find((o) => o.name === name)!.id
  assert.deepEqual(sent, [
    ['F_Path', { text: 'adr/a.md' }],
    ['F_Type', { singleSelectOptionId: optionId('Type', 'ADR') }],
    ['F_status', { singleSelectOptionId: optionId('Status', 'draft') }],
  ])
})

test('apply create without a status sets no Status', async (t) => {
  const g = await laidOut(t)
  await g.provider.apply(BOARD, {
    kind: 'create',
    want: { ...want, status: null },
  })
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    ['addDraft', 'set', 'set']
  )
})

test('apply update: the draft is edited, only the values that differ are sent, a lost status is cleared', async (t) => {
  const g = await laidOut(t, [
    {
      id: 'I_1',
      draftId: 'D_1',
      title: 'old',
      archived: false,
      values: { Path: 'adr/a.md', Type: 'ADR', Status: 'accepted' },
    },
  ])
  await g.provider.items(BOARD)
  await g.provider.apply(BOARD, { kind: 'update', id: 'I_1', want })
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    ['editDraft', 'set']
  )
  assert.deepEqual(g.mutations[0]!.variables, {
    draftIssueId: 'D_1',
    title: '0001 — A',
    body: 'adr/a.md\n\nlink',
  })
  assert.equal(g.mutations[1]!.variables['fieldId'], 'F_status')

  g.mutations.length = 0
  await g.provider.apply(BOARD, {
    kind: 'update',
    id: 'I_1',
    want: { ...want, status: null },
  })
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    ['editDraft', 'clear']
  )
})

test('apply archive and unchanged', async (t) => {
  const g = await laidOut(t)
  await g.provider.apply(BOARD, { kind: 'unchanged', id: 'I_1' })
  assert.equal(g.mutations.length, 0)
  await g.provider.apply(BOARD, { kind: 'archive', id: 'I_1' })
  assert.deepEqual(
    g.mutations.map((m) => [m.op, m.variables]),
    [['archive', { projectId: 'P_1', itemId: 'I_1' }]]
  )
})

test('mark sets Agent and Session, or clears both', async (t) => {
  const g = await laidOut(t)
  await g.provider.mark(BOARD, ['I_1', 'I_2'], 'claude · 1a2b3c4d')
  assert.deepEqual(
    g.mutations.map((m) => [
      m.op,
      m.variables['itemId'],
      m.variables['fieldId'],
    ]),
    [
      ['set', 'I_1', 'F_Agent'],
      ['set', 'I_1', 'F_Session'],
      ['set', 'I_2', 'F_Agent'],
      ['set', 'I_2', 'F_Session'],
    ]
  )
  assert.deepEqual(g.mutations[1]!.variables['value'], {
    text: 'claude · 1a2b3c4d',
  })
  g.mutations.length = 0
  await g.provider.mark(BOARD, ['I_1'], null)
  assert.deepEqual(
    g.mutations.map((m) => [m.op, m.variables['fieldId']]),
    [
      ['clear', 'F_Agent'],
      ['clear', 'F_Session'],
    ]
  )
})

test('anonymous: every board method needs a login', async () => {
  const provider = new GitHubOAuthProvider({ token: null })
  const refused = { message: 'the pulse needs a GitHub login: run rness login' }
  await assert.rejects(provider.createBoard('acme', layout), refused)
  await assert.rejects(provider.board('acme', 7), refused)
  await assert.rejects(provider.ensureLayout(BOARD, layout), refused)
  await assert.rejects(provider.items(BOARD), refused)
  await assert.rejects(
    provider.apply(BOARD, { kind: 'archive', id: 'I' }),
    refused
  )
  await assert.rejects(provider.mark(BOARD, ['I'], null), refused)
})
