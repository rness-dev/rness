import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  addDraft,
  archive,
  createField,
  createProject,
  createView,
  editDraft,
  fields,
  findProject,
  graphql,
  listItems,
  orgId,
  setOptions,
  setValue,
  views,
} from '../../src/core/github-projects.ts'
import {
  type Recorded,
  type Reply,
  fakeGithub,
} from '../helpers/fake-github.ts'

interface Gql {
  query: string
  variables: Record<string, unknown>
}

const gql = (r: Recorded): Gql => r.body as Gql
const data = (d: unknown): Reply => ({ json: { data: d } })

async function serve(
  t: Parameters<typeof fakeGithub>[0],
  answers: Record<string, (v: Record<string, unknown>) => Reply>
) {
  const github = await fakeGithub(t, (r) => {
    const { query, variables } = gql(r)
    for (const [needle, answer] of Object.entries(answers))
      if (query.includes(needle)) return answer(variables)
    return { status: 500, json: { message: `unexpected ${query}` } }
  })
  return { ...github, o: { token: 'tok', apiBase: github.base } }
}

test('graphql posts query and variables to /graphql with the token', async (t) => {
  const { requests, o } = await serve(t, { hello: () => data({ x: 1 }) })
  const out = await graphql<{ x: number }>('query { hello }', { a: 1 }, o)
  assert.deepEqual(out, { x: 1 })
  assert.equal(requests[0]?.method, 'POST')
  assert.equal(requests[0]?.path, '/graphql')
  assert.equal(requests[0]?.headers['authorization'], 'Bearer tok')
  assert.deepEqual(requests[0]?.body, {
    query: 'query { hello }',
    variables: { a: 1 },
  })
})

test('a GraphQL errors array becomes Error(errors[0].message)', async (t) => {
  const { o } = await serve(t, {
    hello: () => ({
      json: { errors: [{ message: 'Nope' }, { message: 'b' }] },
    }),
  })
  await assert.rejects(graphql('query { hello }', {}, o), { message: 'Nope' })
})

test('a non-ok HTTP answer is the github.ts error', async (t) => {
  const { o } = await serve(t, {
    hello: () => ({ status: 401, json: { message: 'Bad credentials' } }),
  })
  await assert.rejects(graphql('query { hello }', {}, o), /rejected the token/)
})

test('orgId reads the organization node id', async (t) => {
  const { requests, o } = await serve(t, {
    organization: () => data({ organization: { id: 'O_1' } }),
  })
  assert.equal(await orgId('acme', o), 'O_1')
  assert.deepEqual(gql(requests[0]!).variables, { login: 'acme' })
})

test('createProject sends createProjectV2 and parses the project', async (t) => {
  const { requests, o } = await serve(t, {
    createProjectV2: () =>
      data({
        createProjectV2: { projectV2: { id: 'P_1', number: 4, url: 'u' } },
      }),
  })
  assert.deepEqual(await createProject('O_1', 'Pulse', o), {
    id: 'P_1',
    number: 4,
    url: 'u',
  })
  assert.deepEqual(gql(requests[0]!).variables, {
    ownerId: 'O_1',
    title: 'Pulse',
  })
})

test('findProject returns the project or null', async (t) => {
  let found = true
  const { requests, o } = await serve(t, {
    projectV2: () =>
      data({
        organization: { projectV2: found ? { id: 'P_1', url: 'u' } : null },
      }),
  })
  assert.deepEqual(await findProject('acme', 4, o), { id: 'P_1', url: 'u' })
  assert.deepEqual(gql(requests[0]!).variables, { login: 'acme', number: 4 })
  found = false
  assert.equal(await findProject('acme', 4, o), null)
})

test('findProject treats a NOT_FOUND error as null', async (t) => {
  const { o } = await serve(t, {
    projectV2: () => ({
      json: {
        data: { organization: null },
        errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }],
      },
    }),
  })
  assert.equal(await findProject('acme', 4, o), null)
})

test('fields lists names and single-select options', async (t) => {
  const { o } = await serve(t, {
    fields: () =>
      data({
        node: {
          fields: {
            nodes: [
              { id: 'F1', name: 'Title' },
              {
                id: 'F2',
                name: 'Status',
                options: [{ id: 'A', name: 'Todo' }],
              },
              {},
            ],
          },
        },
      }),
  })
  assert.deepEqual(await fields('P_1', o), [
    { id: 'F1', name: 'Title', options: null },
    { id: 'F2', name: 'Status', options: [{ id: 'A', name: 'Todo' }] },
  ])
})

test('createField TEXT sends the dataType', async (t) => {
  const { requests, o } = await serve(t, {
    createProjectV2Field: () =>
      data({
        createProjectV2Field: { projectV2Field: { id: 'F9', name: 'Ref' } },
      }),
  })
  assert.deepEqual(await createField('P_1', 'Ref', 'TEXT', o), {
    id: 'F9',
    name: 'Ref',
    options: null,
  })
  assert.deepEqual(gql(requests[0]!).variables, {
    projectId: 'P_1',
    name: 'Ref',
    dataType: 'TEXT',
  })
})

test('createField single-select sends gray options with a description', async (t) => {
  const { requests, o } = await serve(t, {
    createProjectV2Field: () =>
      data({
        createProjectV2Field: {
          projectV2Field: {
            id: 'F9',
            name: 'Status',
            options: [{ id: 'A', name: 'Todo' }],
          },
        },
      }),
  })
  const field = await createField('P_1', 'Status', { options: ['Todo'] }, o)
  assert.deepEqual(field.options, [{ id: 'A', name: 'Todo' }])
  assert.deepEqual(gql(requests[0]!).variables, {
    projectId: 'P_1',
    name: 'Status',
    dataType: 'SINGLE_SELECT',
    options: [{ name: 'Todo', color: 'GRAY', description: '' }],
  })
})

test('setOptions resends the ids of the options it keeps', async (t) => {
  const { requests, o } = await serve(t, {
    updateProjectV2Field: () =>
      data({
        updateProjectV2Field: {
          projectV2Field: {
            id: 'F2',
            name: 'Status',
            options: [
              { id: 'A', name: 'Todo' },
              { id: 'C', name: 'Done' },
            ],
          },
        },
      }),
  })
  const field = {
    id: 'F2',
    name: 'Status',
    options: [
      { id: 'A', name: 'Todo' },
      { id: 'B', name: 'Old' },
    ],
  }
  const out = await setOptions(field, ['Todo', 'Done'], o)
  assert.equal(out.options?.length, 2)
  assert.deepEqual(gql(requests[0]!).variables, {
    fieldId: 'F2',
    options: [
      { id: 'A', name: 'Todo', color: 'GRAY', description: '' },
      { name: 'Done', color: 'GRAY', description: '' },
    ],
  })
})

test('listItems follows endCursor over two pages', async (t) => {
  const item = (id: string, archived = false) => ({
    id,
    isArchived: archived,
    content: { id: `D_${id}`, title: `t${id}` },
    fieldValues: {
      nodes: [
        { text: 'x', field: { name: 'Ref' } },
        { name: 'Todo', field: { name: 'Status' } },
        {},
      ],
    },
  })
  const { requests, o } = await serve(t, {
    items: (v) =>
      v['cursor'] == null
        ? data({
            node: {
              items: {
                nodes: [item('1')],
                pageInfo: { hasNextPage: true, endCursor: 'c1' },
              },
            },
          })
        : data({
            node: {
              items: {
                nodes: [
                  item('2', true),
                  {
                    id: '3',
                    isArchived: false,
                    content: {},
                    fieldValues: { nodes: [] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
  })
  const items = await listItems('P_1', o)
  assert.equal(requests.length, 2)
  assert.equal(gql(requests[1]!).variables['cursor'], 'c1')
  assert.deepEqual(items[0], {
    id: '1',
    draftId: 'D_1',
    title: 't1',
    archived: false,
    values: { Ref: 'x', Status: 'Todo' },
  })
  assert.equal(items[1]?.archived, true)
  assert.deepEqual(items[2], {
    id: '3',
    draftId: null,
    title: '',
    archived: false,
    values: {},
  })
})

test('addDraft returns the item id', async (t) => {
  const { requests, o } = await serve(t, {
    addProjectV2DraftIssue: () =>
      data({ addProjectV2DraftIssue: { projectItem: { id: 'I1' } } }),
  })
  assert.equal(await addDraft('P_1', 'T', 'B', o), 'I1')
  assert.deepEqual(gql(requests[0]!).variables, {
    projectId: 'P_1',
    title: 'T',
    body: 'B',
  })
})

test('editDraft, setValue and archive send their mutations', async (t) => {
  const { requests, o } = await serve(t, {
    updateProjectV2DraftIssue: () => data({}),
    updateProjectV2ItemFieldValue: () => data({}),
    clearProjectV2ItemFieldValue: () => data({}),
    archiveProjectV2Item: () => data({}),
  })
  await editDraft('D1', 'T', 'B', o)
  await setValue('P', 'I', 'F', { text: 'x' }, o)
  await setValue('P', 'I', 'F', { optionId: 'A' }, o)
  await setValue('P', 'I', 'F', null, o)
  await archive('P', 'I', o)
  const sent = requests.map(gql)
  assert.deepEqual(sent[0]?.variables, {
    draftIssueId: 'D1',
    title: 'T',
    body: 'B',
  })
  assert.deepEqual(sent[1]?.variables, {
    projectId: 'P',
    itemId: 'I',
    fieldId: 'F',
    value: { text: 'x' },
  })
  assert.deepEqual(sent[2]?.variables['value'], { singleSelectOptionId: 'A' })
  assert.match(sent[3]!.query, /clearProjectV2ItemFieldValue/)
  assert.deepEqual(sent[3]?.variables, {
    projectId: 'P',
    itemId: 'I',
    fieldId: 'F',
  })
  assert.deepEqual(sent[4]?.variables, { projectId: 'P', itemId: 'I' })
})

test('createView POSTs the documented REST body', async (t) => {
  const github = await fakeGithub(t, () => ({ status: 201, json: {} }))
  const o = { token: 'tok', apiBase: github.base }
  await createView(
    'acme',
    4,
    { name: 'Board', layout: 'board', filter: 'is:open', groupBy: '123' },
    o
  )
  const r = github.requests[0]!
  assert.equal(r.method, 'POST')
  assert.equal(r.path, '/orgs/acme/projectsV2/4/views')
  assert.deepEqual(r.body, {
    name: 'Board',
    layout: 'board',
    filter: 'is:open',
    vertical_group_by: [123],
  })
})

test('createView omits the grouping when there is none, and refuses a non-numeric one', async (t) => {
  const github = await fakeGithub(t, () => ({ status: 201, json: {} }))
  const o = { token: 'tok', apiBase: github.base }
  await createView('acme', 4, { name: 'T', layout: 'table', filter: '' }, o)
  assert.deepEqual(github.requests[0]?.body, {
    name: 'T',
    layout: 'table',
    filter: '',
  })
  await assert.rejects(
    createView(
      'acme',
      4,
      { name: 'B', layout: 'board', filter: '', groupBy: 'PVTSSF_x' },
      o
    ),
    /numeric/
  )
})

test('createView surfaces a refused request', async (t) => {
  const github = await fakeGithub(t, () => ({ status: 422, json: {} }))
  await assert.rejects(
    createView(
      'acme',
      4,
      { name: 'T', layout: 'table', filter: '' },
      { token: 'tok', apiBase: github.base }
    ),
    /422/
  )
})

test('views lists view names through GraphQL', async (t) => {
  const { o } = await serve(t, {
    views: () =>
      data({
        organization: {
          projectV2: { views: { nodes: [{ name: 'A' }, { name: 'B' }] } },
        },
      }),
  })
  assert.deepEqual(await views('acme', 4, o), ['A', 'B'])
})
