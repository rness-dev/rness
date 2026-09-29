import assert from 'node:assert/strict'
import { type TestContext, test } from 'node:test'

import { GitHubOAuthProvider } from '../../src/core/github-oauth-provider.ts'
import type { Layout } from '../../src/pulse/layout.ts'
import type { Recorded, Reply } from '../helpers/fake-github.ts'
import { fakeGithub } from '../helpers/fake-github.ts'
import { asked, data, gql } from '../helpers/github-graphql.ts'

const TOKEN = { token: 'ghu_secret', source: 'login', login: 'octo' } as const
const layout: Layout = {
  statuses: ['draft', 'accepted'],
  types: ['ADR', 'Marketing'],
  views: [
    { name: 'ADR', type: 'ADR' },
    { name: 'Marketing', type: 'Marketing' },
  ],
}

interface FField {
  id: string
  databaseId: number
  name: string
  options: { id: string; name: string }[] | null
}
interface FItem {
  id: string
  draftId: string
  title: string
  archived: boolean
  values: Record<string, string>
}

/** A GitHub project that remembers what it was told. */
async function board(
  t: TestContext,
  seed: { fields?: FField[]; views?: string[]; items?: FItem[] } = {}
) {
  let next = 100
  const fields: FField[] = seed.fields ?? [
    {
      id: 'F_status',
      databaseId: 1,
      name: 'Status',
      options: [{ id: 'o_todo', name: 'Todo' }],
    },
  ]
  const views: string[] = seed.views ?? []
  const items: FItem[] = seed.items ?? []
  const restViews: unknown[] = []
  const mutations: { op: string; variables: Record<string, unknown> }[] = []

  const optionsOf = (list: { name: string; id?: string }[]) =>
    list.map((o) => ({ id: o.id ?? `o_${next++}`, name: o.name }))
  const answers: [string, (v: Record<string, unknown>, q: string) => Reply][] =
    [
      [
        'createProjectV2Field',
        (v, q) => {
          mutations.push({ op: 'createField', variables: v })
          const single = v['dataType'] === 'SINGLE_SELECT'
          const f: FField = {
            id: `F_${String(v['name'])}`,
            databaseId: next++,
            name: String(v['name']),
            options: single
              ? optionsOf(v['options'] as { name: string }[])
              : null,
          }
          fields.push(f)
          return data({
            createProjectV2Field: { projectV2Field: asked(q, { ...f }) },
          })
        },
      ],
      [
        'updateProjectV2Field',
        (v, q) => {
          mutations.push({ op: 'setOptions', variables: v })
          const f = fields.find((x) => x.id === v['fieldId'])!
          f.options = optionsOf(v['options'] as { id?: string; name: string }[])
          return data({
            updateProjectV2Field: { projectV2Field: asked(q, { ...f }) },
          })
        },
      ],
      [
        'createProjectV2(',
        (v) => {
          mutations.push({ op: 'createProject', variables: v })
          return data({
            createProjectV2: {
              projectV2: {
                id: 'P_1',
                number: 7,
                url: 'https://github.com/orgs/acme/projects/7',
              },
            },
          })
        },
      ],
      [
        'addProjectV2DraftIssue',
        (v) => {
          mutations.push({ op: 'addDraft', variables: v })
          const id = `I_${next++}`
          items.push({
            id,
            draftId: `D_${id}`,
            title: String(v['title']),
            archived: false,
            values: {},
          })
          return data({ addProjectV2DraftIssue: { projectItem: { id } } })
        },
      ],
      [
        'updateProjectV2DraftIssue',
        (v) => {
          mutations.push({ op: 'editDraft', variables: v })
          return data({
            updateProjectV2DraftIssue: { draftIssue: { id: 'x' } },
          })
        },
      ],
      [
        'clearProjectV2ItemFieldValue',
        (v) => {
          mutations.push({ op: 'clear', variables: v })
          return data({
            clearProjectV2ItemFieldValue: { projectV2Item: { id: 'x' } },
          })
        },
      ],
      [
        'updateProjectV2ItemFieldValue',
        (v) => {
          mutations.push({ op: 'set', variables: v })
          return data({
            updateProjectV2ItemFieldValue: { projectV2Item: { id: 'x' } },
          })
        },
      ],
      [
        'archiveProjectV2Item',
        (v) => {
          mutations.push({ op: 'archive', variables: v })
          return data({ archiveProjectV2Item: { item: { id: 'x' } } })
        },
      ],
      [
        'organization(login: $login) { id }',
        () => data({ organization: { id: 'O_1' } }),
      ],
      [
        'projectV2(number: $number) { id url }',
        () =>
          data({
            organization: {
              projectV2: {
                id: 'P_1',
                url: 'https://github.com/orgs/acme/projects/7',
              },
            },
          }),
      ],
      [
        'views(first',
        () =>
          data({
            organization: {
              projectV2: { views: { nodes: views.map((name) => ({ name })) } },
            },
          }),
      ],
      [
        'fields(first',
        (_v, q) =>
          data({
            node: {
              fields: {
                nodes: fields.map((f) => asked(q, { ...f })),
              },
            },
          }),
      ],
      [
        'items(first',
        () =>
          data({
            node: {
              items: {
                nodes: items.map((i) => ({
                  id: i.id,
                  isArchived: i.archived,
                  content: { id: i.draftId, title: i.title },
                  fieldValues: {
                    nodes: Object.entries(i.values).map(([name, value]) => ({
                      ...(fields.find((f) => f.name === name)?.options
                        ? { name: value }
                        : { text: value }),
                      field: { name },
                    })),
                  },
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
      ],
    ]
  const gh = await fakeGithub(t, (r: Recorded) => {
    if (r.path !== '/graphql') {
      assert.equal(r.method, 'POST')
      assert.equal(r.path, '/orgs/acme/projectsV2/7/views')
      restViews.push(r.body)
      const name = (r.body as { name: string }).name
      views.push(name)
      return { json: {} }
    }
    const { query, variables } = gql(r)
    const found = answers.find(([needle]) => query.includes(needle))
    return found === undefined
      ? { status: 500, json: { message: `unexpected ${query}` } }
      : found[1](variables, query)
  })
  const provider = new GitHubOAuthProvider({ token: TOKEN, apiBase: gh.base })
  return {
    provider,
    fields,
    views,
    items,
    restViews,
    mutations,
    requests: gh.requests,
  }
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
