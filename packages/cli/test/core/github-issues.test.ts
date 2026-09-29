import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  addLabels,
  closeIssue,
  createIssue,
  createLabel,
  reopenIssue,
  repository,
  updateIssue,
} from '../../src/core/github-issues.ts'
import { fakeGithub } from '../helpers/fake-github.ts'
import { data, gql, serve } from '../helpers/github-graphql.ts'

test('repository reads its id, its Issues switch and one label', async (t) => {
  let label: { id: string } | null = { id: 'L_1' }
  const { requests, o } = await serve(t, {
    'repository(owner': () =>
      data({ repository: { id: 'R_1', hasIssuesEnabled: true, label } }),
  })
  assert.deepEqual(await repository('acme', '.rness', 'rness', o), {
    id: 'R_1',
    issues: true,
    labelId: 'L_1',
  })
  assert.deepEqual(gql(requests[0]!).variables, {
    owner: 'acme',
    name: '.rness',
    label: 'rness',
  })
  label = null
  assert.equal((await repository('acme', '.rness', 'rness', o))?.labelId, null)
})

test('repository: an unknown one (NOT_FOUND) is null', async (t) => {
  const { o } = await serve(t, {
    'repository(owner': () => ({
      json: {
        data: { repository: null },
        errors: [
          { type: 'NOT_FOUND', message: 'Could not resolve to a Repository' },
        ],
      },
    }),
  })
  assert.equal(await repository('acme', '.rness', 'rness', o), null)
})

test('createLabel POSTs to the repository and returns the node id', async (t) => {
  const gh = await fakeGithub(t, () => ({
    status: 201,
    json: { node_id: 'L_9', name: 'rness' },
  }))
  const id = await createLabel(
    'acme',
    '.rness',
    {
      name: 'rness',
      color: '5319e7',
      description: 'A document of .rness, on Agent Pulse',
    },
    { token: 't', apiBase: gh.base }
  )
  assert.equal(id, 'L_9')
  assert.equal(gh.requests[0]?.method, 'POST')
  assert.equal(gh.requests[0]?.path, '/repos/acme/.rness/labels')
  assert.deepEqual(gh.requests[0]?.body, {
    name: 'rness',
    color: '5319e7',
    description: 'A document of .rness, on Agent Pulse',
  })
})

test('createIssue sends the repository, title, body and labels, and parses id and number', async (t) => {
  const { requests, o } = await serve(t, {
    'createIssue(': () =>
      data({ createIssue: { issue: { id: 'I_1', number: 12 } } }),
  })
  assert.deepEqual(
    await createIssue('R_1', { title: 'T', body: 'B', labelIds: ['L_1'] }, o),
    { id: 'I_1', number: 12 }
  )
  assert.match(gql(requests[0]!).query, /mutation[\s\S]*createIssue\(/)
  assert.deepEqual(gql(requests[0]!).variables, {
    repositoryId: 'R_1',
    title: 'T',
    body: 'B',
    labelIds: ['L_1'],
  })
})

test('updateIssue sends only what changes; close is NOT_PLANNED; reopen and addLabels', async (t) => {
  const { requests, o } = await serve(t, {
    'updateIssue(': () => data({}),
    'closeIssue(': () => data({}),
    'reopenIssue(': () => data({}),
    'addLabelsToLabelable(': () => data({}),
  })
  await updateIssue('I_1', { body: 'B' }, o)
  await updateIssue('I_1', { title: 'T' }, o)
  await closeIssue('I_1', o)
  await reopenIssue('I_1', o)
  await addLabels('I_1', ['L_1'], o)
  const sent = requests.map(gql)
  assert.deepEqual(sent[0]?.variables, { id: 'I_1', body: 'B' })
  assert.deepEqual(sent[1]?.variables, { id: 'I_1', title: 'T' })
  assert.match(
    sent[2]!.query,
    /closeIssue\(input: \{ issueId: \$id, stateReason: NOT_PLANNED \}\)/
  )
  assert.deepEqual(sent[2]?.variables, { id: 'I_1' })
  assert.match(sent[3]!.query, /reopenIssue\(/)
  assert.deepEqual(sent[4]?.variables, { id: 'I_1', labelIds: ['L_1'] })
})
