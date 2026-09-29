import assert from 'node:assert/strict'
import { type TestContext, test } from 'node:test'

import { GitHubOAuthProvider } from '../../src/core/github-oauth-provider.ts'
import type { Layout } from '../../src/pulse/layout.ts'
import { type FItem, board } from '../helpers/fake-project.ts'

const layout: Layout = {
  statuses: ['draft', 'accepted'],
  fields: [],
  types: ['ADR', 'Marketing'],
  views: [
    { name: 'ADR', type: 'ADR', field: null },
    { name: 'Marketing', type: 'Marketing', field: null },
  ],
}

const BOARD = {
  org: 'acme',
  number: 7,
  url: 'https://github.com/orgs/acme/projects/7',
}

test('createBoard makes the project only; its first ensureLayout replaces the Status options, then adds the fields, one view per collection and the Working table', async (t) => {
  const g = await board(t)
  const created = await g.provider.createBoard('acme')
  assert.deepEqual(created, BOARD)
  assert.deepEqual(
    g.mutations.map((m) => [m.op, m.variables]),
    [['createProject', { ownerId: 'O_1', title: 'Agent Pulse' }]],
    'nothing but the project before the caller can declare it'
  )
  assert.deepEqual(
    g.fields[0]!.options?.map((o) => o.name),
    ['Todo'],
    "GitHub's default options, untouched so far"
  )

  const added = await g.provider.ensureLayout(created, layout)
  assert.deepEqual(added, [
    'option draft',
    'option accepted',
    'field Collection',
    'field Agent',
    'field Session',
    'field Path',
    'view All',
    'view ADR',
    'view Marketing',
    'view Working',
  ])
  assert.deepEqual(
    g.fields.map((f) => [f.name, f.options?.map((o) => o.name) ?? 'text']),
    [
      ['Status', ['draft', 'accepted']],
      ['Title', 'text'],
      ['Collection', ['ADR', 'Marketing']],
      ['Agent', ['working']],
      ['Session', 'text'],
      ['Path', 'text'],
    ]
  )
  const idOf = (name: string) =>
    g.fields.find((f) => f.name === name)!.databaseId
  const statusId = idOf('Status')
  const [titleId, collectionId, sessionId] = [
    idOf('Title'),
    idOf('Collection'),
    idOf('Session'),
  ]
  assert.deepEqual(g.restViews, [
    {
      name: 'ADR',
      layout: 'board',
      filter: 'collection:"ADR"',
      vertical_group_by: [statusId],
    },
    {
      name: 'Marketing',
      layout: 'board',
      filter: 'collection:"Marketing"',
      vertical_group_by: [statusId],
    },
    {
      name: 'Working',
      layout: 'table',
      filter: 'agent:working',
      visible_fields: [titleId, collectionId, statusId, sessionId],
    },
  ])

  // Once laid out, the board is like any other: extended, never replaced.
  assert.deepEqual(await g.provider.ensureLayout(created, layout), [])
  assert.deepEqual(
    await g.provider.ensureLayout(created, {
      ...layout,
      statuses: ['review'],
    }),
    ['option review']
  )
  assert.deepEqual(
    g.fields[0]!.options?.map((o) => o.name),
    ['review', 'draft', 'accepted']
  )
})

test("createBoard with no status in .rness: GitHub's default options stay", async (t) => {
  const g = await board(t)
  const created = await g.provider.createBoard('acme')
  await g.provider.ensureLayout(created, { ...layout, statuses: [] })
  assert.deepEqual(
    g.fields[0]!.options?.map((o) => o.name),
    ['Todo']
  )
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
        id: 'F_Collection',
        databaseId: 2,
        name: 'Collection',
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
    ['draft', 'accepted', 'obsolete']
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

test('items: values by field name, missing ones null, archived ones not listed, converted ones without a path', async (t) => {
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
      {
        id: 'I_3',
        draftId: null,
        title: '',
        archived: false,
        values: { Status: 'draft', Path: 'adr/b.md' },
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
      collectionStatus: null,
      agent: null,
      session: null,
    },
    {
      id: 'I_2',
      path: null,
      title: 'by hand',
      status: null,
      type: null,
      collectionStatus: null,
      agent: null,
      session: null,
    },
    // Converted to an issue by hand: the team's now, like an item without Path.
    {
      id: 'I_3',
      path: null,
      title: '',
      status: 'draft',
      type: null,
      collectionStatus: null,
      agent: null,
      session: null,
    },
  ])
})

async function laidOut(t: TestContext, items: FItem[] = []) {
  const g = await board(t, { items })
  await g.provider.ensureLayout(await g.provider.createBoard('acme'), layout)
  g.mutations.length = 0
  return g
}

const want = {
  path: 'adr/a.md',
  title: '0001 — A',
  body: 'adr/a.md\n\nlink',
  status: 'draft',
  type: 'ADR',
  statusField: null,
}

test('apply create: a draft, then Path, Collection and Status', async (t) => {
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
    ['F_Collection', { singleSelectOptionId: optionId('Collection', 'ADR') }],
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
      values: { Path: 'adr/a.md', Collection: 'ADR', Status: 'accepted' },
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
  await assert.rejects(provider.createBoard('acme'), refused)
  await assert.rejects(provider.board('acme', 7), refused)
  await assert.rejects(provider.ensureLayout(BOARD, layout), refused)
  await assert.rejects(provider.items(BOARD), refused)
  await assert.rejects(
    provider.apply(BOARD, { kind: 'archive', id: 'I' }),
    refused
  )
  await assert.rejects(provider.mark(BOARD, ['I'], null), refused)
})

const boardFields = (statuses: { id: string; name: string }[]) => [
  { id: 'F_status', databaseId: 1, name: 'Status', options: statuses },
  {
    id: 'F_Collection',
    databaseId: 2,
    name: 'Collection',
    options: [
      { id: 't1', name: 'ADR' },
      { id: 't2', name: 'Marketing' },
    ],
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

test("ensureLayout reorders an out-of-order Status, keeping ids and options it does not know after rness's", async (t) => {
  const g = await board(t, {
    fields: boardFields([
      { id: 's2', name: 'accepted' },
      { id: 's9', name: 'obsolete' },
      { id: 's1', name: 'draft' },
    ]),
    views: ['ADR', 'Marketing', 'Working'],
  })
  const lines = await g.provider.ensureLayout(BOARD, layout)
  assert.deepEqual(lines, ['ordered options'])
  assert.deepEqual(
    g.fields[0]!.options?.map((o) => [o.name, o.id]),
    [
      ['draft', 's1'],
      ['accepted', 's2'],
      ['obsolete', 's9'],
    ]
  )
  assert.equal(g.mutations.filter((m) => m.op === 'setOptions').length, 1)
})

test('ensureLayout leaves Status alone when its options are in order', async (t) => {
  const g = await board(t, {
    fields: boardFields([
      { id: 's1', name: 'draft' },
      { id: 's2', name: 'accepted' },
      { id: 's9', name: 'obsolete' },
    ]),
    views: ['ADR', 'Marketing', 'Working'],
  })
  assert.deepEqual(await g.provider.ensureLayout(BOARD, layout), [])
  assert.equal(g.mutations.filter((m) => m.op === 'setOptions').length, 0)
})

const sentColours = (
  g: Awaited<ReturnType<typeof board>>,
  op: string
): [string, string][][] =>
  g.mutations
    .filter((m) => m.op === op && m.variables['options'] !== undefined)
    .map((m) =>
      (m.variables['options'] as { name: string; color: string }[]).map((o) => [
        o.name,
        o.color,
      ])
    )

test('a new board: every option is sent with its colour', async (t) => {
  const g = await board(t)
  const created = await g.provider.createBoard('acme')
  await g.provider.ensureLayout(created, {
    statuses: ['Draft', 'Approved', 'In progress', 'Accepted', 'scheduled'],
    types: ['ADR', 'Specs', 'Plans', 'Marketing'],
    fields: [],
    views: [],
  })
  assert.deepEqual(sentColours(g, 'setOptions'), [
    [
      ['Draft', 'GRAY'],
      ['Approved', 'PURPLE'],
      ['In progress', 'YELLOW'],
      ['Accepted', 'GREEN'],
      ['scheduled', 'YELLOW'],
    ],
  ])
  assert.deepEqual(sentColours(g, 'createField'), [
    [
      ['ADR', 'PURPLE'],
      ['Specs', 'BLUE'],
      ['Plans', 'ORANGE'],
      ['Marketing', 'PINK'],
    ],
    [['working', 'GREEN']],
  ])
})

test('ensureLayout recolours gray options keeping ids, and leaves the colour of options it does not know', async (t) => {
  const gray = (id: string, name: string) => ({ id, name, color: 'GRAY' })
  const g = await board(t, {
    fields: [
      {
        id: 'F_status',
        databaseId: 1,
        name: 'Status',
        options: [
          gray('s1', 'Draft'),
          gray('s2', 'Accepted'),
          { id: 's9', name: 'obsolete', color: 'RED' },
        ],
      },
      {
        id: 'F_Collection',
        databaseId: 2,
        name: 'Collection',
        options: [gray('t1', 'ADR'), gray('t2', 'Marketing')],
      },
      {
        id: 'F_Agent',
        databaseId: 3,
        name: 'Agent',
        options: [gray('a1', 'working')],
      },
      { id: 'F_Session', databaseId: 4, name: 'Session', options: null },
      { id: 'F_Path', databaseId: 5, name: 'Path', options: null },
    ],
    views: ['ADR', 'Marketing', 'Working'],
  })
  const lines = await g.provider.ensureLayout(BOARD, {
    ...layout,
    statuses: ['Draft', 'Accepted'],
  })
  assert.deepEqual(lines, ['coloured options'])
  const shown = (i: number) =>
    g.fields[i]!.options?.map((o) => [o.id, o.name, o.color])
  assert.deepEqual(shown(0), [
    ['s1', 'Draft', 'GRAY'],
    ['s2', 'Accepted', 'GREEN'],
    ['s9', 'obsolete', 'RED'],
  ])
  assert.deepEqual(shown(1), [
    ['t1', 'ADR', 'PURPLE'],
    ['t2', 'Marketing', 'PINK'],
  ])
  assert.deepEqual(shown(2), [['a1', 'working', 'GREEN']])
  assert.deepEqual(
    await g.provider.ensureLayout(BOARD, {
      ...layout,
      statuses: ['Draft', 'Accepted'],
    }),
    [],
    'coloured once'
  )
})

test("a new board's first view becomes All: Title, Collection, Status, Session; a sync leaves views alone", async (t) => {
  const g = await board(t)
  const created = await g.provider.createBoard('acme')
  const lines = await g.provider.ensureLayout(created, layout)
  assert.ok(lines.includes('view All'), lines.join(', '))
  const updates = g.mutations.filter((m) => m.op === 'updateView')
  assert.equal(updates.length, 1)
  assert.deepEqual(updates[0]!.variables, {
    viewId: 'V_1',
    name: 'All',
    visibleFieldIds: ['F_title', 'F_Collection', 'F_status', 'F_Session'],
  })
  assert.match(updates[0]!.query!, /updateProjectV2View\(/)
  assert.match(updates[0]!.query!, /configuration: \{ visibleFieldIds:/)
  assert.deepEqual(g.views.slice(0, 1), ['All'])

  await g.provider.ensureLayout(created, layout)
  assert.equal(g.mutations.filter((m) => m.op === 'updateView').length, 1)
})

test('a new board without a first view: nothing is renamed', async (t) => {
  const g = await board(t, { defaultView: null })
  const created = await g.provider.createBoard('acme')
  const lines = await g.provider.ensureLayout(created, layout)
  assert.ok(!lines.includes('view All'))
  assert.equal(g.mutations.filter((m) => m.op === 'updateView').length, 0)
})

test('an existing board keeps its views: ensureLayout never renames a first view that is not View 1', async (t) => {
  const g = await board(t, { views: ['Roadmap'] })
  await g.provider.board('acme', 7)
  await g.provider.ensureLayout(BOARD, layout)
  assert.equal(g.mutations.filter((m) => m.op === 'updateView').length, 0)
})

const own: Layout = {
  statuses: ['Proposed', 'Accepted'],
  fields: [{ name: 'ADR status', statuses: ['Proposed', 'Accepted'] }],
  types: ['ADR', 'Marketing'],
  views: [
    { name: 'ADR', type: 'ADR', field: 'ADR status' },
    { name: 'Marketing', type: 'Marketing', field: null },
  ],
}

test('a new board: a status field per collection, coloured, each board columned by its own; a statusless directory by Status', async (t) => {
  const g = await board(t)
  const created = await g.provider.createBoard('acme')
  const lines = await g.provider.ensureLayout(created, own)
  assert.ok(lines.includes('field ADR status'), lines.join(', '))
  const adr = g.fields.find((f) => f.name === 'ADR status')!
  assert.deepEqual(
    adr.options?.map((o) => [o.name, o.color]),
    [
      ['Proposed', 'BLUE'],
      ['Accepted', 'GREEN'],
    ]
  )
  const columns = Object.fromEntries(
    g.restViews.map((v) => {
      const b = v as { name: string; vertical_group_by?: number[] }
      return [b.name, b.vertical_group_by?.[0]]
    })
  )
  assert.equal(columns['ADR'], adr.databaseId)
  assert.equal(
    columns['Marketing'],
    g.fields.find((f) => f.name === 'Status')!.databaseId
  )
})

test('an existing board columned by Status is made again by its own field; one already right and a team view are left alone', async (t) => {
  const g = await board(t, {
    fields: [
      ...boardFields([
        { id: 's1', name: 'Proposed' },
        { id: 's2', name: 'Accepted' },
      ]),
      {
        id: 'F_adr',
        databaseId: 9,
        name: 'ADR status',
        options: [
          { id: 'a1', name: 'Proposed', color: 'BLUE' },
          { id: 'a2', name: 'Accepted', color: 'GREEN' },
        ],
      },
    ],
    views: [
      { name: 'ADR', column: 'Status' },
      'Marketing',
      'Working',
      { name: 'Roadmap', column: 'Status' },
    ],
  })
  const lines = await g.provider.ensureLayout(BOARD, own)
  assert.deepEqual(lines, ['view ADR remade — columns ADR status'])
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    ['deleteView']
  )
  assert.match(
    g.mutations[0]!.query!,
    /deleteProjectV2View\(input: \{ viewId: \$viewId \}\)/
  )
  assert.equal(g.restViews.length, 1)
  assert.equal(
    (g.restViews[0] as { vertical_group_by: number[] }).vertical_group_by[0],
    9
  )
  assert.deepEqual(
    g.viewList.map((v) => [v.name, v.column]),
    [
      ['Marketing', 'Status'],
      ['Working', null],
      ['Roadmap', 'Status'],
      ['ADR', 'ADR status'],
    ]
  )
  g.mutations.length = 0
  g.restViews.length = 0
  assert.deepEqual(await g.provider.ensureLayout(BOARD, own), [])
  assert.deepEqual(g.mutations, [])
  assert.equal(g.restViews.length, 0)
})

test('an existing board: View 1 becomes All when no All exists; an All, or another first view, is left alone', async (t) => {
  const named = async (views: string[]) => {
    const g = await board(t, { views })
    await g.provider.ensureLayout(BOARD, layout)
    return g.mutations.filter((m) => m.op === 'updateView')
  }
  const renamed = await named(['View 1', 'ADR', 'Marketing', 'Working'])
  assert.equal(renamed.length, 1)
  assert.equal(renamed[0]!.variables['name'], 'All')
  assert.equal(
    (await named(['View 1', 'All', 'ADR', 'Marketing', 'Working'])).length,
    0
  )
  assert.equal(
    (await named(['Roadmap', 'ADR', 'Marketing', 'Working'])).length,
    0
  )
})

test('apply writes the collection field on create, and on update only when it differs', async (t) => {
  const g = await board(t)
  await g.provider.ensureLayout(await g.provider.createBoard('acme'), own)
  g.mutations.length = 0
  const w = { ...want, status: 'Proposed', statusField: 'ADR status' }
  await g.provider.apply(BOARD, { kind: 'create', want: w })
  assert.deepEqual(
    g.mutations
      .filter((m) => m.op === 'set')
      .map((m) => m.variables['fieldId']),
    ['F_Path', 'F_Collection', 'F_status', 'F_ADR status']
  )
  g.mutations.length = 0
  g.items.push({
    id: 'I_9',
    draftId: 'D_9',
    title: w.title,
    archived: false,
    values: {
      Path: w.path,
      Collection: 'ADR',
      Status: 'Proposed',
      'ADR status': 'Accepted',
    },
  })
  await g.provider.items(BOARD)
  await g.provider.apply(BOARD, { kind: 'update', id: 'I_9', want: w })
  assert.deepEqual(
    g.mutations
      .filter((m) => m.op === 'set')
      .map((m) => m.variables['fieldId']),
    ['F_ADR status']
  )
})
