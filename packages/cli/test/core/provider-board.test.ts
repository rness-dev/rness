import assert from 'node:assert/strict'
import { type TestContext, test } from 'node:test'

import { GitHubOAuthProvider } from '../../src/core/github-oauth-provider.ts'
import type { Layout } from '../../src/pulse/layout.ts'
import { type FItem, anIssue, board } from '../helpers/fake-project.ts'

const layout: Layout = {
  statuses: ['draft', 'accepted'],
  fields: [],
  types: ['ADR', 'Marketing'],
  views: [
    { name: 'ADR', type: 'ADR', field: null },
    { name: 'Marketing', type: 'Marketing', field: null },
  ],
  declared: [],
  labels: [],
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
    'field Working session',
    'field Path',
    'field Session history',
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
      ['Working session', 'text'],
      ['Path', 'text'],
      ['Session history', 'text'],
    ]
  )
  const idOf = (name: string) =>
    g.fields.find((f) => f.name === name)!.databaseId
  const statusId = idOf('Status')
  const [titleId, collectionId, sessionId] = [
    idOf('Title'),
    idOf('Collection'),
    idOf('Working session'),
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
      {
        id: 'F_Session',
        databaseId: 4,
        name: 'Working session',
        options: null,
      },
      { id: 'F_Path', databaseId: 5, name: 'Path', options: null },
      {
        id: 'F_Sessions',
        databaseId: 6,
        name: 'Session history',
        options: null,
      },
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

test("items: rness's are drafts and issues of acme/.rness with a Path; anything else is the team's", async (t) => {
  const g = await board(t, {
    items: [
      {
        id: 'I_gone',
        draftId: null,
        issue: anIssue(1),
        title: '',
        archived: true,
        values: { Path: 'adr/a.md' },
      },
      {
        id: 'I_1',
        draftId: null,
        issue: anIssue(2, { title: '0001 — A', body: 'b' }),
        title: '',
        archived: false,
        values: { Status: 'draft', Path: 'adr/a.md' },
      },
      {
        id: 'I_2',
        draftId: null,
        issue: anIssue(3, {
          state: 'CLOSED',
          labels: [],
          repository: 'ACME/.Rness',
        }),
        title: '',
        archived: false,
        values: { Path: 'adr/b.md' },
      },
      {
        id: 'I_3',
        draftId: 'D_3',
        title: '0003 — C',
        archived: false,
        values: { Path: 'adr/c.md' },
      },
      {
        id: 'I_4',
        draftId: null,
        issue: anIssue(4, { repository: 'acme/web' }),
        title: '',
        archived: false,
        values: { Path: 'adr/d.md' },
      },
      {
        id: 'I_5',
        draftId: null,
        issue: anIssue(5),
        title: '',
        archived: false,
        values: {},
      },
      {
        id: 'I_6',
        draftId: null,
        title: '',
        archived: false,
        values: { Path: 'adr/e.md' },
      },
    ],
  })
  const items = await g.provider.items(BOARD)
  assert.deepEqual(
    items.map((i) => [i.id, i.path, i.issue]),
    [
      [
        'I_1',
        'adr/a.md',
        { number: 2, open: true, labelled: true, body: 'b', labels: ['rness'] },
      ],
      [
        'I_2',
        'adr/b.md',
        { number: 3, open: false, labelled: false, body: '', labels: [] },
      ],
      ['I_3', 'adr/c.md', null],
      ['I_4', null, null],
      [
        'I_5',
        null,
        { number: 5, open: true, labelled: true, body: '', labels: ['rness'] },
      ],
      ['I_6', null, null],
    ]
  )
  assert.deepEqual(items[0], {
    id: 'I_1',
    path: 'adr/a.md',
    issue: {
      number: 2,
      open: true,
      labelled: true,
      body: 'b',
      labels: ['rness'],
    },
    title: '0001 — A',
    status: 'draft',
    type: null,
    collectionStatus: null,
    agent: null,
    session: null,
    sessions: null,
    values: { Status: 'draft', Path: 'adr/a.md' },
  })
})

test('items without bodies: the query selects none, and each issue says it was not read (null)', async (t) => {
  const g = await board(t, {
    items: [
      {
        id: 'I_1',
        draftId: null,
        issue: anIssue(2, { body: 'b' }),
        title: '',
        archived: false,
        values: { Path: 'adr/a.md' },
      },
    ],
  })
  const light = await g.provider.items(BOARD, { bodies: false })
  assert.deepEqual(light[0]?.issue, {
    number: 2,
    open: true,
    labelled: true,
    body: null,
    labels: ['rness'],
  })
  const full = await g.provider.items(BOARD)
  assert.equal(full[0]?.issue?.body, 'b')
  const queries = g.requests
    .map((r) => (r.body as { query?: string } | undefined)?.query ?? '')
    .filter((q) => q.includes('items(first'))
  assert.equal(queries.length, 2)
  assert.doesNotMatch(queries[0]!, /\bbody\b/)
  assert.match(queries[1]!, /\bbody\b/)
})

test('checkIssues: Issues on .rness pass; off, the refusal, and nothing is written', async (t) => {
  const on = await board(t)
  await on.provider.checkIssues('acme')
  const off = await board(t, { memory: { issues: false } })
  await assert.rejects(off.provider.checkIssues('acme'), {
    message:
      'the pulse needs Issues on acme/.rness: turn them on in its Settings',
  })
  assert.deepEqual(off.mutations, [])
  assert.ok(
    off.requests.every(
      (r) => !JSON.stringify(r.body ?? '').includes('mutation')
    )
  )
})

test('checkIssues: no .rness GitHub shows this login is said so', async (t) => {
  const g = await board(t, { memory: { exists: false } })
  await assert.rejects(g.provider.checkIssues('acme'), {
    message:
      'the pulse needs acme/.rness on GitHub: it is not there, or this login cannot see it',
  })
})

test('ensureLayout makes the label rness and links the board to acme/.rness, once', async (t) => {
  const g = await board(t, { memory: { label: false, linked: false } })
  const created = await g.provider.createBoard('acme')
  const added = await g.provider.ensureLayout(created, layout)
  assert.deepEqual(added.slice(-2), ['label rness', 'link acme/.rness'])
  assert.deepEqual(g.restLabels, [
    {
      name: 'rness',
      color: '5319e7',
      description: 'A document of .rness, on Agent Pulse',
    },
  ])
  assert.deepEqual(
    g.mutations.filter((m) => m.op === 'link').map((m) => m.variables),
    [{ projectId: 'P_1', repositoryId: 'R_1' }]
  )
  g.mutations.length = 0
  assert.deepEqual(await g.provider.ensureLayout(created, layout), [])
  assert.deepEqual(g.mutations, [], 'an unchanged board costs no write')
  assert.equal(g.restLabels.length, 1)
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
  body: 'header',
  status: 'draft',
  type: 'ADR',
  statusField: null,
  sessions: null,
  values: {},
  labels: [],
  unlabels: [],
}

test('apply create: an issue of .rness, labelled, the first line as body, added to the board, Path first, then the fields; its number returned', async (t) => {
  const g = await laidOut(t)
  const placed = await g.provider.apply(BOARD, { kind: 'create', want })
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    ['createIssue', 'addItem', 'set', 'set', 'set']
  )
  assert.deepEqual(g.mutations[0]!.variables, {
    repositoryId: 'R_1',
    title: '0001 — A',
    body: 'header',
    labelIds: ['L_1'],
  })
  const made = g.issues.at(-1)!
  assert.deepEqual(g.mutations[1]!.variables, {
    projectId: 'P_1',
    contentId: made.id,
  })
  assert.equal(
    g.mutations[2]!.variables['fieldId'],
    'F_Path',
    "Path first: without it the item would be the team's"
  )
  assert.deepEqual(placed, { id: g.items.at(-1)!.id, number: made.number })
})

test('apply create without a status sets no Status', async (t) => {
  const g = await laidOut(t)
  await g.provider.apply(BOARD, {
    kind: 'create',
    want: { ...want, status: null },
  })
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    ['createIssue', 'addItem', 'set', 'set']
  )
})

test('apply convert: the draft becomes an issue of .rness in place, labelled; its title and only the fields that differ written', async (t) => {
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
  const placed = await g.provider.apply(BOARD, {
    kind: 'convert',
    id: 'I_1',
    want,
  })
  const issue = g.items[0]!.issue!
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    ['convert', 'addLabels', 'updateIssue', 'set']
  )
  assert.deepEqual(g.mutations[0]!.variables, {
    itemId: 'I_1',
    repositoryId: 'R_1',
  })
  assert.deepEqual(g.mutations[1]!.variables, {
    id: issue.id,
    labelIds: ['L_1'],
  })
  assert.deepEqual(g.mutations[2]!.variables, {
    id: issue.id,
    title: '0001 — A',
  })
  assert.equal(g.mutations[3]!.variables['fieldId'], 'F_status')
  assert.deepEqual(placed, { id: 'I_1', number: issue.number })
})

test('apply update: a closed issue reopened, a lost label added, the title and the fields that differ written; then only what is left', async (t) => {
  const g = await laidOut(t, [
    {
      id: 'I_1',
      draftId: null,
      issue: anIssue(4, { title: 'old', state: 'CLOSED', labels: [] }),
      title: '',
      archived: false,
      values: { Path: 'adr/a.md', Collection: 'ADR', Status: 'accepted' },
    },
  ])
  await g.provider.items(BOARD)
  assert.equal(
    await g.provider.apply(BOARD, {
      kind: 'update',
      id: 'I_1',
      want,
      reopen: true,
    }),
    null
  )
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    ['reopenIssue', 'addLabels', 'updateIssue', 'set']
  )
  assert.deepEqual(g.mutations[0]!.variables, { id: 'ISSUE_4' })
  assert.deepEqual(g.mutations[2]!.variables, {
    id: 'ISSUE_4',
    title: '0001 — A',
  })
  assert.equal(g.mutations[3]!.variables['fieldId'], 'F_status')
  g.mutations.length = 0
  await g.provider.apply(BOARD, {
    kind: 'update',
    id: 'I_1',
    want: { ...want, status: null },
    reopen: false,
  })
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    ['clear'],
    'what the first apply wrote is known'
  )
})

test('apply close: an open issue closed as not planned, then its item archived; a closed one only archived', async (t) => {
  const g = await laidOut(t, [
    {
      id: 'I_1',
      draftId: null,
      issue: anIssue(4),
      title: '',
      archived: false,
      values: { Path: 'adr/a.md' },
    },
    {
      id: 'I_2',
      draftId: null,
      issue: anIssue(5, { state: 'CLOSED' }),
      title: '',
      archived: false,
      values: { Path: 'adr/b.md' },
    },
  ])
  await g.provider.items(BOARD)
  await g.provider.apply(BOARD, { kind: 'close', id: 'I_1' })
  await g.provider.apply(BOARD, { kind: 'close', id: 'I_2' })
  assert.deepEqual(
    g.mutations.map((m) => [m.op, m.variables]),
    [
      ['closeIssue', { id: 'ISSUE_4' }],
      ['archive', { projectId: 'P_1', itemId: 'I_1' }],
      ['archive', { projectId: 'P_1', itemId: 'I_2' }],
    ]
  )
  assert.match(g.mutations[0]!.query!, /stateReason: NOT_PLANNED/)
  assert.equal(g.issues.find((i) => i.number === 4)?.stateReason, 'NOT_PLANNED')
})

test('apply body writes the issue body only; archive and unchanged as before', async (t) => {
  const g = await laidOut(t, [
    {
      id: 'I_1',
      draftId: null,
      issue: anIssue(4),
      title: '',
      archived: false,
      values: { Path: 'adr/a.md' },
    },
  ])
  await g.provider.items(BOARD)
  assert.equal(
    await g.provider.apply(BOARD, { kind: 'body', id: 'I_1', body: 'B' }),
    null
  )
  assert.deepEqual(
    g.mutations.map((m) => [m.op, m.variables]),
    [['updateIssue', { id: 'ISSUE_4', body: 'B' }]]
  )
  g.mutations.length = 0
  await g.provider.apply(BOARD, { kind: 'unchanged', id: 'I_1' })
  assert.equal(g.mutations.length, 0)
  await g.provider.apply(BOARD, { kind: 'archive', id: 'I_1' })
  assert.deepEqual(
    g.mutations.map((m) => [m.op, m.variables]),
    [['archive', { projectId: 'P_1', itemId: 'I_1' }]]
  )
})

test('apply body on an item created in the same run: one request, no listing', async (t) => {
  const g = await laidOut(t)
  const placed = await g.provider.apply(BOARD, { kind: 'create', want })
  const before = g.requests.length
  await g.provider.apply(BOARD, { kind: 'body', id: placed!.id, body: 'B' })
  assert.equal(g.requests.length, before + 1)
  assert.equal(g.issues.at(-1)?.body, 'B')
})

test('a label is its name in any case: an issue labelled RNESS is labelled, and apply adds no label', async (t) => {
  const g = await laidOut(t, [
    {
      id: 'I_1',
      draftId: null,
      issue: anIssue(4, { title: '0001 — A', labels: ['RNESS'] }),
      title: '',
      archived: false,
      values: { Path: 'adr/a.md', Collection: 'ADR', Status: 'accepted' },
    },
  ])
  const [item] = await g.provider.items(BOARD)
  assert.equal(item?.issue?.labelled, true)
  await g.provider.apply(BOARD, {
    kind: 'update',
    id: 'I_1',
    want,
    reopen: false,
  })
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    ['set']
  )
})

test('mark works on issue items as on drafts: Agent and Session by item id', async (t) => {
  const g = await laidOut(t, [
    {
      id: 'I_1',
      draftId: null,
      issue: anIssue(4),
      title: '',
      archived: false,
      values: { Path: 'adr/a.md' },
    },
  ])
  await g.provider.mark(BOARD, ['I_1'], 'claude · 1a2b3c4d')
  assert.deepEqual(g.items[0]!.values, {
    Path: 'adr/a.md',
    Agent: 'working',
    'Working session': 'claude · 1a2b3c4d',
  })
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
      ['set', 'I_1', 'F_Working session'],
      ['set', 'I_2', 'F_Agent'],
      ['set', 'I_2', 'F_Working session'],
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
      ['clear', 'F_Working session'],
    ]
  )
})

test('anonymous: every board method needs a login', async () => {
  const provider = new GitHubOAuthProvider({ token: null })
  const refused = { message: 'the pulse needs a GitHub login: run rness login' }
  await assert.rejects(provider.checkIssues('acme'), refused)
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
  { id: 'F_Session', databaseId: 4, name: 'Working session', options: null },
  { id: 'F_Path', databaseId: 5, name: 'Path', options: null },
  { id: 'F_Sessions', databaseId: 6, name: 'Session history', options: null },
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
    declared: [],
    labels: [],
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
      {
        id: 'F_Session',
        databaseId: 4,
        name: 'Working session',
        options: null,
      },
      { id: 'F_Path', databaseId: 5, name: 'Path', options: null },
      {
        id: 'F_Sessions',
        databaseId: 6,
        name: 'Session history',
        options: null,
      },
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
    visibleFieldIds: [
      'F_title',
      'F_Collection',
      'F_status',
      'F_Working session',
    ],
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
  declared: [],
  labels: [],
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
    draftId: null,
    issue: anIssue(9, { title: w.title }),
    title: '',
    archived: false,
    values: {
      Path: w.path,
      Collection: 'ADR',
      Status: 'Proposed',
      'ADR status': 'Accepted',
    },
  })
  await g.provider.items(BOARD)
  await g.provider.apply(BOARD, {
    kind: 'update',
    id: 'I_9',
    want: w,
    reopen: false,
  })
  assert.deepEqual(
    g.mutations
      .filter((m) => m.op === 'set')
      .map((m) => m.variables['fieldId']),
    ['F_ADR status']
  )
})

// --- a collection's own project (spec 0025 §4) ------------------------------------

const MARKETING = {
  org: 'acme',
  number: 8,
  url: 'https://github.com/orgs/acme/projects/8',
}

const ownLayout: Layout = {
  statuses: ['Idea', 'Draft', 'Published'],
  fields: [],
  types: ['Marketing'],
  views: [{ name: 'Marketing', type: 'Marketing', field: null }],
  declared: [
    { name: 'Publish date', type: 'date', options: [] },
    { name: 'Reach', type: 'number', options: [] },
    { name: 'Kind', type: 'select', options: ['post', 'action'] },
    { name: 'Tone', type: 'select', options: [] },
  ],
  labels: ['linkedin', 'hn'],
}

/** Agent Pulse made, then the collection's project, laid out; mutations cleared. */
async function ownProject(
  t: TestContext,
  seed: Parameters<typeof board>[1] = {}
) {
  const g = await board(t, seed)
  await g.provider.createBoard('acme')
  const made = await g.provider.createBoard('acme', 'Marketing')
  assert.deepEqual(made, MARKETING)
  const lines = await g.provider.ensureLayout(made, ownLayout)
  g.mutations.length = 0
  return { g, lines }
}

test("a collection's project: titled after it; its declared fields made by type, a select with its options, none without; Calendar and the labels", async (t) => {
  const { g, lines } = await ownProject(t)
  const p = g.project(8)
  assert.equal(p.title, 'Marketing')
  const made = (name: string) => p.fields.find((f) => f.name === name)
  assert.equal(made('Publish date')?.dataType, 'DATE')
  assert.equal(made('Reach')?.dataType, 'NUMBER')
  assert.deepEqual(
    made('Kind')?.options?.map((o) => o.name),
    ['post', 'action']
  )
  assert.equal(
    made('Tone'),
    undefined,
    'a select with no option yet is not made'
  )
  assert.deepEqual(
    p.viewList.map((v) => [v.name, v.layout]),
    [
      ['All', 'TABLE_LAYOUT'],
      ['Marketing', 'BOARD_LAYOUT'],
      ['Calendar', 'ROADMAP_LAYOUT'],
      ['Working', 'TABLE_LAYOUT'],
    ]
  )
  assert.deepEqual(
    g.restLabels.map((l) => (l as { name: string }).name),
    ['linkedin', 'hn']
  )
  for (const line of [
    'field Publish date',
    'field Kind',
    'view Calendar',
    'label linkedin',
    'label hn',
  ])
    assert.ok(lines.includes(line), `${line} in ${lines.join(', ')}`)
  // Agent Pulse got none of it.
  assert.equal(
    g.project(7).fields.some((f) => f.name === 'Publish date'),
    false
  )
})

test("a collection's project laid out again: nothing made twice; a select gets the options it lacks, in the declared order", async (t) => {
  const { g } = await ownProject(t, { labels: ['linkedin'] })
  const again = await g.provider.ensureLayout(MARKETING, {
    ...ownLayout,
    declared: [
      { name: 'Publish date', type: 'date', options: [] },
      { name: 'Reach', type: 'number', options: [] },
      { name: 'Kind', type: 'select', options: ['post', 'launch', 'action'] },
    ],
  })
  assert.deepEqual(again, ['option launch'])
  assert.deepEqual(
    g
      .project(8)
      .fields.find((f) => f.name === 'Kind')
      ?.options?.map((o) => o.name),
    ['post', 'launch', 'action']
  )
  assert.deepEqual(g.restLabels.length, 1, 'hn only: linkedin was there')
})

test('a declared field of the name of one of another type: stops, naming it', async (t) => {
  const g = await board(t)
  await g.provider.createBoard('acme')
  const made = await g.provider.createBoard('acme', 'Marketing')
  g.project(8).fields.push({
    id: 'F_kind',
    databaseId: 555,
    name: 'Kind',
    options: null,
    dataType: 'TEXT',
  })
  await assert.rejects(
    () => g.provider.ensureLayout(made, ownLayout),
    new Error(
      "the project's field Kind is not a select field: rename it on the project, or in the collection's README"
    )
  )
})

test('Agent Pulse laid out: no label read, none made, no field of a collection', async (t) => {
  const g = await board(t)
  await g.provider.ensureLayout(await g.provider.createBoard('acme'), layout)
  const queries = g.requests.map(
    (r) => (r.body as { query?: string } | undefined)?.query ?? ''
  )
  assert.equal(
    queries.some((q) => q.includes('labelList:')),
    false
  )
  assert.deepEqual(g.restLabels, [])
})

const card = {
  path: 'marketing/linkedin/a.md',
  title: '2026-09-30 — First post',
  body: 'header',
  status: 'Draft',
  type: 'Marketing',
  statusField: null,
  sessions: null,
  values: {
    'Publish date': '2026-10-01',
    Reach: '120',
    Kind: 'post',
    Tone: null,
  },
  labels: ['linkedin'],
  unlabels: ['hn'],
}

test("apply create on a collection's project: the declared values, a date and a number as such, and its labels", async (t) => {
  const { g } = await ownProject(t)
  const placed = await g.provider.apply(MARKETING, {
    kind: 'create',
    want: card,
  })
  const item = g.project(8).items.find((i) => i.id === placed?.id)!
  assert.deepEqual(item.values, {
    Path: 'marketing/linkedin/a.md',
    Collection: 'Marketing',
    Status: 'Draft',
    'Publish date': '2026-10-01',
    Reach: '120',
    Kind: 'post',
  })
  const sets = g.mutations
    .filter((m) => m.op === 'set')
    .map((m) => m.variables['value'])
  assert.ok(sets.some((v) => JSON.stringify(v) === '{"date":"2026-10-01"}'))
  assert.ok(sets.some((v) => JSON.stringify(v) === '{"number":120}'))
  assert.deepEqual(item.issue?.labels, ['rness', 'linkedin'])
})

test("apply update on a collection's project: a label taken off, one added, a value cleared", async (t) => {
  const { g } = await ownProject(t, { labels: ['linkedin', 'hn'] })
  const placed = await g.provider.apply(MARKETING, {
    kind: 'create',
    want: { ...card, labels: ['hn'], unlabels: ['linkedin'] },
  })
  g.mutations.length = 0
  await g.provider.apply(MARKETING, {
    kind: 'update',
    id: placed!.id,
    want: { ...card, values: { ...card.values, Reach: null } },
    reopen: false,
  })
  const item = g.project(8).items.find((i) => i.id === placed?.id)!
  assert.deepEqual(item.issue?.labels, ['rness', 'linkedin'])
  assert.equal(item.values['Reach'], undefined)
  assert.deepEqual(
    g.mutations.map((m) => m.op).filter((op) => op !== 'set'),
    ['addLabels', 'removeLabels', 'clear']
  )
})

test('apply remove: the item leaves the board, its issue left open and labelled', async (t) => {
  const g = await laidOut(t, [
    {
      id: 'I_1',
      draftId: null,
      issue: anIssue(2),
      title: '',
      archived: false,
      values: { Path: 'marketing/a.md' },
    },
  ])
  await g.provider.items(BOARD)
  await g.provider.apply(BOARD, { kind: 'remove', id: 'I_1' })
  assert.deepEqual(
    g.mutations.map((m) => m.op),
    ['deleteItem']
  )
  assert.equal(g.items.length, 0)
  assert.equal(g.issues.find((i) => i.number === 2)?.state, 'OPEN')
})

test('describe: the README and the short description written when they differ, each alone; nothing when they match or are not given', async (t) => {
  const { g } = await ownProject(t, {
    projects: [],
  })
  assert.deepEqual(
    await g.provider.describe(MARKETING, {
      readme: '# Launch\n\nStrategy.\n',
      description: 'The launch.',
    }),
    ['readme', 'short description']
  )
  assert.equal(g.project(8).readme, '# Launch\n\nStrategy.')
  assert.equal(g.project(8).shortDescription, 'The launch.')
  g.mutations.length = 0
  assert.deepEqual(
    await g.provider.describe(MARKETING, {
      readme: '# Launch\n\nStrategy.\n\n',
      description: 'The launch.',
    }),
    []
  )
  assert.deepEqual(
    await g.provider.describe(MARKETING, {
      readme: null,
      description: 'Now.',
    }),
    ['short description']
  )
  assert.deepEqual(
    g.mutations.map((m) => m.variables),
    [{ projectId: 'P_2', shortDescription: 'Now.' }]
  )
  assert.equal(g.project(8).readme, '# Launch\n\nStrategy.')
})

test('postUpdates: each posted once, in order, marked with its path; a changed one updated; one left by hand untouched', async (t) => {
  const { g } = await ownProject(t)
  g.project(8).statusUpdates.push({
    id: 'SU_hand',
    body: 'By hand.',
    status: 'ON_TRACK',
    startDate: null,
    targetDate: null,
  })
  const updates = [
    {
      path: 'marketing/updates/2026-10-05.md',
      health: 'on-track' as const,
      startDate: '2026-10-01',
      targetDate: '2026-11-12',
      body: 'First week.\n',
    },
    {
      path: 'marketing/updates/2026-10-12.md',
      health: 'at-risk' as const,
      startDate: null,
      targetDate: null,
      body: 'Show HN moved.\n',
    },
  ]
  assert.deepEqual(await g.provider.postUpdates(MARKETING, updates), [
    'posted marketing/updates/2026-10-05.md',
    'posted marketing/updates/2026-10-12.md',
  ])
  const [hand, first, second] = g.project(8).statusUpdates
  assert.equal(hand?.body, 'By hand.')
  assert.deepEqual(first, {
    id: first?.id,
    body: 'First week.\n\n<!-- rness: marketing/updates/2026-10-05.md -->',
    status: 'ON_TRACK',
    startDate: '2026-10-01',
    targetDate: '2026-11-12',
  })
  assert.equal(second?.status, 'AT_RISK')
  assert.deepEqual(await g.provider.postUpdates(MARKETING, updates), [])
  assert.deepEqual(
    await g.provider.postUpdates(MARKETING, [
      { ...updates[1]!, health: 'off-track', body: 'Show HN cancelled.\n' },
    ]),
    ['updated marketing/updates/2026-10-12.md']
  )
  assert.equal(g.project(8).statusUpdates.length, 3)
  assert.equal(g.project(8).statusUpdates[2]?.status, 'OFF_TRACK')
})
