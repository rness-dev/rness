import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  addItem,
  archive,
  convertDraft,
  createField,
  createProject,
  createView,
  fields,
  findProject,
  graphql,
  linkRepository,
  linkedRepositories,
  listItems,
  orgId,
  setOptions,
  setValue,
  views,
} from '../../src/core/github-projects.ts'
import { fakeGithub } from '../helpers/fake-github.ts'
import { asked, data, gql, serve } from '../helpers/github-graphql.ts'

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
  const { requests, o } = await serve(t, {
    fields: (_v, q) =>
      data({
        node: {
          fields: {
            nodes: [
              asked(q, { id: 'PVTF_1', databaseId: 11, name: 'Title' }),
              asked(q, {
                id: 'PVTSSF_2',
                databaseId: 22,
                name: 'Status',
                options: [{ id: 'A', name: 'Todo' }],
              }),
              {},
            ],
          },
        },
      }),
  })
  const listed = await fields('P_1', o)
  assert.match(gql(requests[0]!).query, /\bdatabaseId\b/)
  assert.deepEqual(listed, [
    { id: 'PVTF_1', databaseId: 11, name: 'Title', options: null },
    {
      id: 'PVTSSF_2',
      databaseId: 22,
      name: 'Status',
      options: [{ id: 'A', name: 'Todo' }],
    },
  ])
})

test('createField TEXT sends the dataType', async (t) => {
  const { requests, o } = await serve(t, {
    createProjectV2Field: (_v, q) =>
      data({
        createProjectV2Field: {
          projectV2Field: asked(q, {
            id: 'PVTF_9',
            databaseId: 99,
            name: 'Ref',
          }),
        },
      }),
  })
  const created = await createField('P_1', 'Ref', 'TEXT', o)
  assert.match(gql(requests[0]!).query, /\bdatabaseId\b/)
  assert.deepEqual(created, {
    id: 'PVTF_9',
    databaseId: 99,
    name: 'Ref',
    options: null,
  })
  assert.match(gql(requests[0]!).query, /mutation[\s\S]*createProjectV2Field\(/)
  assert.deepEqual(gql(requests[0]!).variables, {
    projectId: 'P_1',
    name: 'Ref',
    dataType: 'TEXT',
  })
})

test('a field without a database id is an error, not 0', async (t) => {
  const { o } = await serve(t, {
    fields: () =>
      data({ node: { fields: { nodes: [{ id: 'PVTF_1', name: 'Title' }] } } }),
  })
  await assert.rejects(fields('P_1', o), /field "Title" without a database id/)
})

test('createField single-select sends gray options with a description', async (t) => {
  const { requests, o } = await serve(t, {
    createProjectV2Field: (_v, q) =>
      data({
        createProjectV2Field: {
          projectV2Field: asked(q, {
            id: 'PVTSSF_9',
            databaseId: 99,
            name: 'Status',
            options: [{ id: 'A', name: 'Todo' }],
          }),
        },
      }),
  })
  const field = await createField(
    'P_1',
    'Status',
    { options: [{ name: 'Todo', color: 'GRAY' }] },
    o
  )
  assert.match(gql(requests[0]!).query, /\bdatabaseId\b/)
  assert.match(gql(requests[0]!).query, /singleSelectOptions/)
  assert.equal(field.databaseId, 99)
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
    updateProjectV2Field: (_v, q) =>
      data({
        updateProjectV2Field: {
          projectV2Field: asked(q, {
            id: 'F2',
            databaseId: 22,
            name: 'Status',
            options: [
              { id: 'A', name: 'Todo' },
              { id: 'C', name: 'Done' },
            ],
          }),
        },
      }),
  })
  const field = {
    id: 'F2',
    databaseId: 22,
    name: 'Status',
    options: [
      { id: 'A', name: 'Todo' },
      { id: 'B', name: 'Old' },
    ],
  }
  const out = await setOptions(
    field,
    [
      { name: 'Todo', color: 'GRAY' },
      { name: 'Done', color: 'GRAY' },
    ],
    o
  )
  assert.match(gql(requests[0]!).query, /\bdatabaseId\b/)
  assert.match(gql(requests[0]!).query, /mutation[\s\S]*updateProjectV2Field\(/)
  assert.equal(out.options?.length, 2)
  assert.equal(out.databaseId, 22)
  assert.deepEqual(gql(requests[0]!).variables, {
    fieldId: 'F2',
    options: [
      { id: 'A', name: 'Todo', color: 'GRAY', description: '' },
      { name: 'Done', color: 'GRAY', description: '' },
    ],
  })
})

test('listItems follows endCursor over two pages, and reads an issue: its repository, number, state, body, labels and author', async (t) => {
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
  const issue = {
    id: '4',
    isArchived: false,
    content: {
      id: 'ISSUE_9',
      number: 9,
      title: 'An issue',
      state: 'CLOSED',
      body: 'text',
      author: { login: 'Octo' },
      repository: { nameWithOwner: 'acme/.rness' },
      labels: { nodes: [{ name: 'rness' }, { name: 'bug' }] },
    },
    fieldValues: { nodes: [] },
  }
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
                  issue,
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
  })
  const items = await listItems('P_1', o)
  assert.equal(requests.length, 2)
  assert.equal(gql(requests[1]!).variables['cursor'], 'c1')
  assert.match(gql(requests[0]!).query, /fieldValues\(first: 50\)/)
  assert.match(gql(requests[0]!).query, /\.\.\. on Issue \{/)
  assert.match(gql(requests[0]!).query, /author \{\s+login\s+\}/)
  assert.deepEqual(items[0], {
    id: '1',
    draftId: 'D_1',
    issue: null,
    title: 't1',
    archived: false,
    values: { Ref: 'x', Status: 'Todo' },
  })
  assert.equal(items[1]?.archived, true)
  assert.deepEqual(items[2], {
    id: '3',
    draftId: null,
    issue: null,
    title: '',
    archived: false,
    values: {},
  })
  assert.deepEqual(items[3], {
    id: '4',
    draftId: null,
    issue: {
      id: 'ISSUE_9',
      number: 9,
      open: false,
      repository: 'acme/.rness',
      body: 'text',
      labels: ['rness', 'bug'],
      author: 'Octo',
    },
    title: 'An issue',
    archived: false,
    values: {},
  })
})

test('addItem adds an issue to the project and returns the item id', async (t) => {
  const { requests, o } = await serve(t, {
    addProjectV2ItemById: () =>
      data({ addProjectV2ItemById: { item: { id: 'PVTI_1' } } }),
  })
  assert.equal(await addItem('P_1', 'ISSUE_1', o), 'PVTI_1')
  assert.deepEqual(gql(requests[0]!).variables, {
    projectId: 'P_1',
    contentId: 'ISSUE_1',
  })
})

test('convertDraft makes the draft an issue of the repository; no issue in the answer is an error', async (t) => {
  let content: unknown = { id: 'ISSUE_4', number: 4 }
  const { requests, o } = await serve(t, {
    convertProjectV2DraftIssueItemToIssue: () =>
      data({
        convertProjectV2DraftIssueItemToIssue: { item: { id: 'I_1', content } },
      }),
  })
  assert.deepEqual(await convertDraft('I_1', 'R_1', o), {
    id: 'ISSUE_4',
    number: 4,
  })
  assert.deepEqual(gql(requests[0]!).variables, {
    itemId: 'I_1',
    repositoryId: 'R_1',
  })
  content = null
  await assert.rejects(convertDraft('I_1', 'R_1', o), /without an issue/)
})

test('linkedRepositories lists owner/name; linkRepository links one', async (t) => {
  const { requests, o } = await serve(t, {
    'repositories(first': () =>
      data({
        node: { repositories: { nodes: [{ nameWithOwner: 'acme/.rness' }] } },
      }),
    linkProjectV2ToRepository: () =>
      data({ linkProjectV2ToRepository: { repository: { id: 'R_1' } } }),
  })
  assert.deepEqual(await linkedRepositories('P_1', o), ['acme/.rness'])
  await linkRepository('P_1', 'R_1', o)
  assert.deepEqual(gql(requests[1]!).variables, {
    projectId: 'P_1',
    repositoryId: 'R_1',
  })
})

test('setValue and archive send their mutations', async (t) => {
  const { requests, o } = await serve(t, {
    updateProjectV2ItemFieldValue: () => data({}),
    clearProjectV2ItemFieldValue: () => data({}),
    archiveProjectV2Item: () => data({}),
  })
  await setValue('P', 'I', 'F', { text: 'x' }, o)
  await setValue('P', 'I', 'F', { optionId: 'A' }, o)
  await setValue('P', 'I', 'F', null, o)
  await archive('P', 'I', o)
  const sent = requests.map(gql)
  const names = [
    'updateProjectV2ItemFieldValue',
    'updateProjectV2ItemFieldValue',
    'clearProjectV2ItemFieldValue',
    'archiveProjectV2Item',
  ]
  sent.forEach((r, i) =>
    assert.match(r.query, new RegExp(`mutation[\\s\\S]*${names[i]}\\(`))
  )
  assert.deepEqual(sent[0]?.variables, {
    projectId: 'P',
    itemId: 'I',
    fieldId: 'F',
    value: { text: 'x' },
  })
  assert.deepEqual(sent[1]?.variables['value'], { singleSelectOptionId: 'A' })
  assert.deepEqual(sent[2]?.variables, {
    projectId: 'P',
    itemId: 'I',
    fieldId: 'F',
  })
  assert.deepEqual(sent[3]?.variables, { projectId: 'P', itemId: 'I' })
})

test('createView POSTs the documented REST body', async (t) => {
  const github = await fakeGithub(t, () => ({ status: 201, json: {} }))
  const o = { token: 'tok', apiBase: github.base }
  await createView(
    'acme',
    4,
    { name: 'Board', layout: 'board', filter: 'is:open', groupBy: 123 },
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

test('createView omits the grouping when there is none', async (t) => {
  const github = await fakeGithub(t, () => ({ status: 201, json: {} }))
  const o = { token: 'tok', apiBase: github.base }
  await createView('acme', 4, { name: 'T', layout: 'table', filter: '' }, o)
  assert.deepEqual(github.requests[0]?.body, {
    name: 'T',
    layout: 'table',
    filter: '',
  })
})

test('createView sends the visible fields as visible_fields', async (t) => {
  const github = await fakeGithub(t, () => ({ status: 201, json: {} }))
  const o = { token: 'tok', apiBase: github.base }
  await createView(
    'acme',
    4,
    { name: 'T', layout: 'table', filter: '', visibleFields: [3, 1, 2] },
    o
  )
  assert.deepEqual(github.requests[0]?.body, {
    name: 'T',
    layout: 'table',
    filter: '',
    visible_fields: [3, 1, 2],
  })
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

test('views lists the views of a project, with the field a board is columned by', async (t) => {
  const { o } = await serve(t, {
    views: () =>
      data({
        node: {
          views: {
            nodes: [
              {
                id: 'V_1',
                name: 'A',
                layout: 'BOARD_LAYOUT',
                verticalGroupByFields: { nodes: [{ name: 'Status' }] },
              },
              {
                id: 'V_2',
                name: 'B',
                layout: 'TABLE_LAYOUT',
                verticalGroupByFields: { nodes: [] },
              },
            ],
          },
        },
      }),
  })
  assert.deepEqual(await views('P_1', o), [
    { id: 'V_1', name: 'A', layout: 'BOARD_LAYOUT', columnField: 'Status' },
    { id: 'V_2', name: 'B', layout: 'TABLE_LAYOUT', columnField: null },
  ])
})
