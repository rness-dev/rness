import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as jw from '../../src/core/jira-workflow.ts'
import type { Recorded, Reply } from '../helpers/fake-github.ts'
import { fakeJira } from '../helpers/fake-jira.ts'

// A space's statuses, workflow and board (spec 0039 §7.2; plan 0053 task
// 6), as task 1 saw rness-dev.atlassian.net answer on 2026-10-21 and 23.

const SITE = { site: 'acme.atlassian.net', email: 'me@acme.io', token: 'tok' }
const pathOf = (r: Recorded): string => new URL(r.path, 'http://x').pathname
const queryOf = (r: Recorded): URLSearchParams =>
  new URL(r.path, 'http://x').searchParams

function routes(table: Record<string, Reply>): (r: Recorded) => Reply {
  return (r) => table[`${r.method} ${pathOf(r)}`] ?? { status: 404, json: {} }
}

const TEMPLATE = [
  { id: '10008', name: 'To Do', statusCategory: 'TODO' },
  { id: '10009', name: 'In Progress', statusCategory: 'IN_PROGRESS' },
  { id: '10011', name: 'In Review', statusCategory: 'IN_PROGRESS' },
  { id: '10010', name: 'Done', statusCategory: 'DONE' },
]

test("a space's statuses by id, untranslated name and category; made with PROJECT scope; renamed with their category", async (t) => {
  const jira = await fakeJira(
    t,
    routes({
      'GET /rest/api/3/statuses/search': {
        json: { values: TEMPLATE, isLast: true },
      },
      'POST /rest/api/3/statuses': {
        json: [
          { id: '10012', name: 'Draft' },
          { id: '10014', name: 'Gone' },
        ],
      },
      'PUT /rest/api/3/statuses': { status: 204, json: {} },
    })
  )
  assert.deepEqual(await jw.spaceStatuses('10002', SITE), [
    { id: '10008', name: 'To Do', category: 'TODO' },
    { id: '10009', name: 'In Progress', category: 'IN_PROGRESS' },
    { id: '10011', name: 'In Review', category: 'IN_PROGRESS' },
    { id: '10010', name: 'Done', category: 'DONE' },
  ])
  assert.equal(
    jira.requests[0] === undefined
      ? ''
      : queryOf(jira.requests[0]).get('projectId'),
    '10002'
  )
  assert.deepEqual(
    await jw.createStatuses(
      '10002',
      [
        { name: 'Draft', category: 'TODO' },
        { name: 'Gone', category: 'DONE' },
      ],
      SITE
    ),
    [
      { id: '10012', name: 'Draft', category: 'TODO' },
      { id: '10014', name: 'Gone', category: 'DONE' },
    ]
  )
  assert.deepEqual(jira.requests[1]?.body, {
    scope: { type: 'PROJECT', project: { id: '10002' } },
    statuses: [
      { name: 'Draft', statusCategory: 'TODO', description: '' },
      { name: 'Gone', statusCategory: 'DONE', description: '' },
    ],
  })
  await jw.renameStatuses(
    [{ id: '10008', name: 'Draft', category: 'TODO' }],
    SITE
  )
  assert.deepEqual(jira.requests[2]?.body, {
    statuses: [
      { id: '10008', name: 'Draft', statusCategory: 'TODO', description: '' },
    ],
  })
})

test('the workflow read, then updated: each status already there sent with its id, a GLOBAL transition to each one missing, ids above the highest', async (t) => {
  const read = {
    statuses: [
      {
        id: '10008',
        statusReference: '10008',
        name: 'To Do',
        statusCategory: 'TODO',
        description: '',
      },
      {
        id: '10012',
        statusReference: '10012',
        name: 'Draft',
        statusCategory: 'TODO',
        description: '',
      },
    ],
    workflows: [
      {
        id: 'wf-1',
        version: { versionNumber: 3, id: 'v-3' },
        statuses: [{ statusReference: '10008', properties: {} }],
        transitions: [
          {
            id: '1',
            name: 'Create',
            type: 'INITIAL',
            toStatusReference: '10008',
          },
          {
            id: '11',
            name: 'To Do',
            type: 'GLOBAL',
            toStatusReference: '10008',
          },
        ],
      },
    ],
  }
  const jira = await fakeJira(
    t,
    routes({
      'POST /rest/api/3/workflows': { json: read },
      'POST /rest/api/3/workflows/update': { json: { workflows: [{}] } },
    })
  )
  const added = await jw.addGlobalTransitions(
    '10002',
    '10012',
    ['10008', '10012'],
    SITE
  )
  assert.deepEqual(added, ['10012'])
  assert.deepEqual(jira.requests[0]?.body, {
    projectAndIssueTypes: [{ projectId: '10002', issueTypeId: '10012' }],
  })
  const update = jira.requests[1]?.body as {
    statuses: unknown[]
    workflows: {
      version: unknown
      statuses: unknown[]
      transitions: unknown[]
    }[]
  }
  assert.deepEqual(update.statuses, read.statuses)
  assert.deepEqual(update.workflows[0]?.version, {
    versionNumber: 3,
    id: 'v-3',
  })
  assert.deepEqual(update.workflows[0]?.statuses, [
    { statusReference: '10008', properties: {} },
    { statusReference: '10012', properties: {} },
  ])
  assert.deepEqual(update.workflows[0]?.transitions.at(-1), {
    id: '21',
    name: 'Draft',
    type: 'GLOBAL',
    toStatusReference: '10012',
    links: [],
    actions: [],
    validators: [],
    triggers: [],
    properties: {},
  })

  // Nothing missing: nothing sent.
  const none = await jw.addGlobalTransitions('10002', '10012', ['10008'], SITE)
  assert.deepEqual(none, [])
  assert.equal(
    jira.requests.filter((r) => pathOf(r).endsWith('/update')).length,
    1
  )
})

test("a refused workflow update is said in Jira's words", async (t) => {
  await fakeJira(t, (r) =>
    pathOf(r).endsWith('/update')
      ? {
          status: 400,
          json: { errorMessages: ['A space policy blocks new statuses.'] },
        }
      : {
          json: {
            statuses: [],
            workflows: [
              {
                id: 'w',
                version: { versionNumber: 0, id: 'v' },
                statuses: [],
                transitions: [],
              },
            ],
          },
        }
  )
  await assert.rejects(jw.addGlobalTransitions('10002', '1', ['10012'], SITE), {
    message:
      'acme.atlassian.net answered 400 for /rest/api/3/workflows/update: A space policy blocks new statuses.',
  })
})

test("the space's board, its columns' statuses, its Backlog read and switched", async (t) => {
  let backlog = 'ENABLED'
  const jira = await fakeJira(t, (r) => {
    const path = pathOf(r)
    if (path === '/rest/agile/1.0/board')
      return {
        json: { values: [{ id: 3, name: 'RNESS board', type: 'simple' }] },
      }
    if (path === '/rest/agile/1.0/board/3/configuration')
      return {
        json: {
          columnConfig: {
            columns: [
              { name: 'Ready', statuses: [{ id: '10008' }] },
              { name: 'Accepted', statuses: [{ id: '10013' }] },
            ],
          },
        },
      }
    if (path === '/rest/agile/1.0/board/3/features') {
      if (r.method === 'PUT')
        backlog = (r.body as { enabling: boolean }).enabling
          ? 'ENABLED'
          : 'DISABLED'
      return {
        json: {
          features: [
            { feature: 'jsw.agility.backlog', state: backlog },
            { feature: 'jsw.agility.sprints', state: 'DISABLED' },
          ],
        },
      }
    }
    return { status: 404, json: {} }
  })
  assert.deepEqual(await jw.spaceBoard('RNESS', SITE), {
    id: 3,
    name: 'RNESS board',
  })
  assert.equal(
    jira.requests[0] === undefined
      ? ''
      : queryOf(jira.requests[0]).get('projectKeyOrId'),
    'RNESS'
  )
  assert.deepEqual(await jw.columns(3, SITE), [
    { name: 'Ready', statuses: ['10008'] },
    { name: 'Accepted', statuses: ['10013'] },
  ])
  assert.equal(await jw.backlogOn(3, SITE), true)
  await jw.setBacklog(3, false, SITE)
  assert.deepEqual(jira.requests.at(-1)?.body, {
    boardId: 3,
    feature: 'jsw.agility.backlog',
    enabling: false,
  })
  assert.equal(await jw.backlogOn(3, SITE), false)
})

test('a space with no board is null', async (t) => {
  await fakeJira(t, () => ({ json: { values: [] } }))
  assert.equal(await jw.spaceBoard('RNESS', SITE), null)
})

test('the statuses a GLOBAL transition leads to, read off the workflow', async (t) => {
  await fakeJira(t, () => ({
    json: {
      workflows: [
        {
          transitions: [
            { id: '1', type: 'INITIAL', toStatusReference: '10008' },
            { id: '11', type: 'GLOBAL', toStatusReference: '10008' },
            { id: '21', type: 'GLOBAL', toStatusReference: '10012' },
          ],
        },
      ],
    },
  }))
  assert.deepEqual(
    [...(await jw.workflowStatuses('10002', '10012', SITE)).global],
    ['10008', '10012']
  )
})
