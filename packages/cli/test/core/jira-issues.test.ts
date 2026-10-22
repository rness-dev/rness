import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AdfDocument } from '../../src/board/adf.ts'
import * as ji from '../../src/core/jira-issues.ts'
import type { Recorded, Reply } from '../helpers/fake-github.ts'
import { fakeJira } from '../helpers/fake-jira.ts'

// The issues of a Jira space (spec 0039 §6; plan 0053 task 5), against a
// fake site answering as task 1 saw rness-dev.atlassian.net answer.

const SITE = { site: 'acme.atlassian.net', email: 'me@acme.io', token: 'tok' }
const DOC: AdfDocument = {
  version: 1,
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
}

const pathOf = (r: Recorded): string => new URL(r.path, 'http://x').pathname
const queryOf = (r: Recorded): URLSearchParams =>
  new URL(r.path, 'http://x').searchParams

/** Routes by method and path; anything else is a 404. */
function routes(table: Record<string, Reply>): (r: Recorded) => Reply {
  return (r) => table[`${r.method} ${pathOf(r)}`] ?? { status: 404, json: {} }
}

test('the space: found by key, or null; the permissions it lacks, by name', async (t) => {
  await fakeJira(
    t,
    routes({
      'GET /rest/api/3/project/RNESS': { json: { id: '10002', key: 'RNESS' } },
      'GET /rest/api/3/mypermissions': {
        json: {
          permissions: {
            CREATE_ISSUES: { havePermission: true },
            EDIT_ISSUES: { havePermission: false },
            TRANSITION_ISSUES: { havePermission: true },
          },
        },
      },
    })
  )
  assert.deepEqual(await ji.space('RNESS', SITE), { id: '10002', key: 'RNESS' })
  assert.equal(await ji.space('NOPE', SITE), null)
  assert.deepEqual(
    await ji.missingPermissions(
      'RNESS',
      ['CREATE_ISSUES', 'EDIT_ISSUES', 'TRANSITION_ISSUES'],
      SITE
    ),
    ['EDIT_ISSUES']
  )
})

test('the Task type: its untranslated name, else the first of level 0, never a translated name', async (t) => {
  let types: unknown[] = [
    { id: '10010', name: 'Epic', hierarchyLevel: 1 },
    { id: '10011', name: 'Sous-tâche', hierarchyLevel: -1, subtask: true },
    { id: '10013', name: 'Story', hierarchyLevel: 0 },
    { id: '10012', name: 'Tâche', hierarchyLevel: 0 },
  ]
  const jira = await fakeJira(t, () => ({ json: { issueTypes: types } }))
  assert.equal(await ji.taskType('RNESS', SITE), '10012')
  assert.equal(
    jira.requests[0]?.path,
    '/rest/api/3/issue/createmeta/RNESS/issuetypes'
  )
  types = [
    { id: '10013', name: 'Story', hierarchyLevel: 0 },
    { id: '10020', name: 'Tâche', untranslatedName: 'Task', hierarchyLevel: 0 },
  ]
  assert.equal(await ji.taskType('RNESS', SITE), '10020')
  types = [{ id: '10010', name: 'Epic', hierarchyLevel: 1 }]
  await assert.rejects(ji.taskType('RNESS', SITE), {
    message: 'RNESS has no issue type of level 0 on acme.atlassian.net',
  })
})

test('an issue: created with its type, ADF description and labels; updated in one call; read back', async (t) => {
  const jira = await fakeJira(
    t,
    routes({
      'POST /rest/api/3/issue': {
        status: 201,
        json: { id: '1', key: 'RNESS-12' },
      },
      'PUT /rest/api/3/issue/RNESS-12': { status: 204, json: {} },
      'GET /rest/api/3/issue/RNESS-12': {
        json: {
          key: 'RNESS-12',
          fields: {
            summary: 'A card',
            labels: ['rness'],
            status: { id: '10012', statusCategory: { key: 'new' } },
            description: DOC,
          },
        },
      },
    })
  )
  assert.deepEqual(
    await ji.createIssue(
      'RNESS',
      '10012',
      {
        summary: 'A card',
        description: DOC,
        labels: ['rness', 'collection-adr'],
      },
      SITE
    ),
    { key: 'RNESS-12', number: 12 }
  )
  assert.deepEqual(jira.requests[0]?.body, {
    fields: {
      project: { key: 'RNESS' },
      issuetype: { id: '10012' },
      summary: 'A card',
      description: DOC,
      labels: ['rness', 'collection-adr'],
    },
  })
  await ji.updateIssue(
    'RNESS-12',
    { summary: 'B', description: DOC, add: ['x'], remove: ['y'] },
    SITE
  )
  assert.deepEqual(jira.requests[1]?.body, {
    fields: { summary: 'B', description: DOC },
    update: { labels: [{ add: 'x' }, { remove: 'y' }] },
  })
  assert.deepEqual(await ji.issue('RNESS-12', SITE), {
    key: 'RNESS-12',
    number: 12,
    summary: 'A card',
    labels: ['rness'],
    statusId: '10012',
    done: false,
    description: DOC,
    properties: {},
  })
  assert.equal(await ji.issue('RNESS-99', SITE), null)
})

test('a status by its transition: the transitions by target id, then the one posted', async (t) => {
  const jira = await fakeJira(
    t,
    routes({
      'GET /rest/api/3/issue/RNESS-1/transitions': {
        json: {
          transitions: [
            { id: '11', name: 'A faire', to: { id: '10008' } },
            { id: '51', name: 'Draft', to: { id: '10012' } },
          ],
        },
      },
      'POST /rest/api/3/issue/RNESS-1/transitions': { status: 204, json: {} },
    })
  )
  assert.deepEqual(await ji.transitions('RNESS-1', SITE), [
    { id: '11', to: '10008' },
    { id: '51', to: '10012' },
  ])
  await ji.transition('RNESS-1', '51', SITE)
  assert.deepEqual(jira.requests[1]?.body, { transition: { id: '51' } })
})

test('the property rness: written whole, read back; none is null', async (t) => {
  const jira = await fakeJira(
    t,
    routes({
      'PUT /rest/api/3/issue/RNESS-1/properties/rness': {
        status: 201,
        json: {},
      },
      'GET /rest/api/3/issue/RNESS-1/properties/rness': {
        json: { key: 'rness', value: { digest: '1a2b3c4d5e6f' } },
      },
    })
  )
  await ji.setProperty('RNESS-1', 'rness', { digest: '1a2b3c4d5e6f' }, SITE)
  assert.deepEqual(jira.requests[0]?.body, { digest: '1a2b3c4d5e6f' })
  assert.deepEqual(await ji.property('RNESS-1', 'rness', SITE), {
    digest: '1a2b3c4d5e6f',
  })
  assert.equal(await ji.property('RNESS-2', 'rness', SITE), null)
})

test('a search by JQL, paged by nextPageToken', async (t) => {
  const jira = await fakeJira(t, (r) =>
    queryOf(r).get('nextPageToken') === null
      ? {
          json: {
            issues: [{ key: 'RNESS-1', fields: {} }],
            nextPageToken: 'p2',
          },
        }
      : { json: { issues: [{ key: 'RNESS-2', fields: {} }], isLast: true } }
  )
  const found = await ji.search('project = RNESS', ['summary'], SITE)
  assert.deepEqual(
    found.map((i) => i.key),
    ['RNESS-1', 'RNESS-2']
  )
  const first = jira.requests[0]
  assert.equal(
    first === undefined ? '' : pathOf(first),
    '/rest/api/3/search/jql'
  )
  assert.equal(
    first === undefined ? '' : queryOf(first).get('jql'),
    'project = RNESS'
  )
  assert.equal(
    first === undefined ? '' : queryOf(first).get('fields'),
    'summary'
  )
  assert.equal(
    jira.requests[1] === undefined
      ? ''
      : queryOf(jira.requests[1]).get('nextPageToken'),
    'p2'
  )
})

test('a comment in ADF; two issues linked by Relates', async (t) => {
  const jira = await fakeJira(
    t,
    routes({
      'POST /rest/api/3/issue/RNESS-1/comment': { status: 201, json: {} },
      'POST /rest/api/3/issueLink': { status: 201, json: {} },
    })
  )
  await ji.comment('RNESS-1', DOC, SITE)
  assert.deepEqual(jira.requests[0]?.body, { body: DOC })
  await ji.relate('RNESS-1', 'RNESS-2', SITE)
  assert.deepEqual(jira.requests[1]?.body, {
    type: { name: 'Relates' },
    inwardIssue: { key: 'RNESS-1' },
    outwardIssue: { key: 'RNESS-2' },
  })
})

test('a refused write is one line in Jira words', async (t) => {
  await fakeJira(t, () => ({
    status: 400,
    json: { errorMessages: [], errors: { labels: 'bad label' } },
  }))
  await assert.rejects(
    ji.createIssue(
      'RNESS',
      '1',
      { summary: 's', description: DOC, labels: ['a b'] },
      SITE
    ),
    {
      message:
        'acme.atlassian.net answered 400 for /rest/api/3/issue: bad label',
    }
  )
})
