import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  JournalRefused,
  addSubIssue,
  comment,
  createJournalIssue,
  issueOf,
  journalIssue,
  journalMarker,
  pullRequestFor,
} from '../../src/core/github-journal.ts'
import { fakeGithub } from '../helpers/fake-github.ts'
import { data, gql, serve } from '../helpers/github-graphql.ts'

const PLAN = 'plans/0021-x.md'

const openIssues = (nodes: { id: string; number: number; body: string }[]) =>
  data({
    repository: {
      issues: {
        nodes: nodes.map((n) => ({ ...n, title: `#${n.number}` })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  })

test('journalIssue: the open one labelled rness:plan whose last line names the plan; a hand-edited marker, or another plan, is none', async (t) => {
  const { requests, o } = await serve(t, {
    'issues(first': () =>
      openIssues([
        {
          id: 'I_1',
          number: 1,
          body: `Notes.\n\n<!-- rness journal plans/0020-y.md -->`,
        },
        {
          id: 'I_2',
          number: 2,
          body: `Notes.\n\n<!-- rness journal ${PLAN} --> edited`,
        },
        { id: 'I_3', number: 3, body: `Notes.\n\n${journalMarker(PLAN)}\n` },
      ]),
  })
  assert.deepEqual(await journalIssue('acme', 'api', PLAN, o), {
    id: 'I_3',
    number: 3,
    repository: 'acme/api',
  })
  assert.deepEqual(gql(requests[0]!).variables['label'], 'rness:plan')
  assert.equal(await journalIssue('acme', 'api', 'plans/0099-z.md', o), null)
})

test('createJournalIssue: the label made when missing, the issue with its marker as last line', async (t) => {
  const labels: unknown[] = []
  let created: Record<string, unknown> = {}
  const gh = await fakeGithub(t, (r) => {
    if (r.path === '/repos/acme/api/labels') {
      labels.push(r.body)
      return { status: 201, json: { node_id: 'L_plan', name: 'rness:plan' } }
    }
    const { query, variables } = gql(r)
    if (query.includes('hasIssuesEnabled'))
      return data({
        repository: { id: 'R_api', hasIssuesEnabled: true, label: null },
      })
    if (query.includes('createIssue(')) {
      created = variables
      return data({ createIssue: { issue: { id: 'I_9', number: 9 } } })
    }
    return { status: 500, json: { message: `unexpected ${query}` } }
  })
  const o = { token: 'tok', apiBase: gh.base }
  assert.deepEqual(
    await createJournalIssue(
      'acme',
      'api',
      PLAN,
      { title: 'Implement X', body: 'Plan [`plans/0021-x.md`](…)' },
      o
    ),
    { id: 'I_9', number: 9, repository: 'acme/api' }
  )
  assert.deepEqual(labels, [
    {
      name: 'rness:plan',
      color: '0e8a16',
      description: 'An implementation of a plan of .rness',
    },
  ])
  assert.equal(created['repositoryId'], 'R_api')
  assert.deepEqual(created['labelIds'], ['L_plan'])
  assert.equal(
    created['body'],
    `Plan [\`plans/0021-x.md\`](…)\n\n${journalMarker(PLAN)}\n`
  )
})

test('createJournalIssue: a repository with its Issues off, or one this login cannot see, is refused as such', async (t) => {
  let issues = false
  let found = true
  const { o } = await serve(t, {
    hasIssuesEnabled: () =>
      found
        ? data({
            repository: { id: 'R_api', hasIssuesEnabled: issues, label: null },
          })
        : {
            json: {
              data: { repository: null },
              errors: [{ type: 'NOT_FOUND', message: 'Could not resolve' }],
            },
          },
  })
  const make = () =>
    createJournalIssue('acme', 'api', PLAN, { title: 'T', body: 'B' }, o)
  await assert.rejects(make, (e: unknown) => {
    assert.ok(e instanceof JournalRefused)
    assert.equal(e.why, 'issues')
    return true
  })
  found = false
  issues = true
  await assert.rejects(
    make,
    (e: unknown) => e instanceof JournalRefused && e.why === 'missing'
  )
})

test('addSubIssue, comment, issueOf, pullRequestFor: what each sends and reads', async (t) => {
  const { requests, o } = await serve(t, {
    'addSubIssue(': () => data({ addSubIssue: { issue: { id: 'P' } } }),
    'addComment(': () =>
      data({ addComment: { commentEdge: { node: { id: 'C' } } } }),
    'issue(number': (v) =>
      data({
        repository: {
          issue:
            v['number'] === 12
              ? { id: 'I_12', number: 12, state: 'OPEN' }
              : null,
        },
      }),
    'pullRequests(headRefName': (v) =>
      data({
        repository: {
          pullRequests: {
            nodes:
              v['branch'] === 'feat/x' ? [{ number: 91, state: 'OPEN' }] : [],
          },
        },
      }),
  })
  await addSubIssue('I_12', 'I_9', o)
  assert.deepEqual(gql(requests[0]!).variables, {
    issueId: 'I_12',
    subIssueId: 'I_9',
  })
  await comment('I_9', '**Approach** · …', o)
  assert.deepEqual(gql(requests[1]!).variables, {
    subjectId: 'I_9',
    body: '**Approach** · …',
  })
  assert.deepEqual(await issueOf('acme', '.rness', 12, o), {
    id: 'I_12',
    number: 12,
    open: true,
  })
  assert.equal(await issueOf('acme', '.rness', 13, o), null)
  assert.deepEqual(await pullRequestFor('acme', 'api', 'feat/x', o), {
    number: 91,
    state: 'OPEN',
  })
  assert.equal(await pullRequestFor('acme', 'api', 'main', o), null)
})
