import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { AdfDocument } from '../../src/board/adf.ts'
import { JournalRefused } from '../../src/core/github-journal.ts'
import * as jj from '../../src/core/jira-journal.ts'
import type { Recorded, Reply } from '../helpers/fake-github.ts'
import { fakeJira } from '../helpers/fake-jira.ts'

// The agent journal in a Jira space (spec 0039 §6, spec 0030 §8; plan
// 0053 task 5): Bitbucket has no issues, so the implementation issue of
// every repository lives in the workspace's space, found by its marker.

const SITE = { site: 'acme.atlassian.net', email: 'me@acme.io', token: 'tok' }
const pathOf = (r: Recorded): string => new URL(r.path, 'http://x').pathname
const queryOf = (r: Recorded): URLSearchParams =>
  new URL(r.path, 'http://x').searchParams

const doc = (...lines: string[]): AdfDocument => ({
  version: 1,
  type: 'doc',
  content: lines.map((text) => ({
    type: 'paragraph',
    content: [{ type: 'text', text }],
  })),
})

function routes(table: Record<string, Reply>): (r: Recorded) => Reply {
  return (r) => table[`${r.method} ${pathOf(r)}`] ?? { status: 404, json: {} }
}

test("the marker names the repository and the plan: every repository's issue is in one space", () => {
  assert.equal(
    jj.jiraJournalMarker('acme/api', 'plans/0053-x.md'),
    'rness journal acme/api plans/0053-x.md'
  )
})

test('the open implementation issue, found by label and by the last line of its description', async (t) => {
  const jira = await fakeJira(t, () => ({
    json: {
      issues: [
        {
          key: 'RNESS-7',
          fields: {
            description: doc(
              'Plan …',
              'rness journal acme/web plans/0053-x.md'
            ),
          },
        },
        {
          key: 'RNESS-9',
          fields: {
            description: doc(
              'Plan …',
              'rness journal acme/api plans/0053-x.md'
            ),
          },
        },
      ],
      isLast: true,
    },
  }))
  assert.deepEqual(
    await jj.journalIssue('RNESS', 'acme/api', 'plans/0053-x.md', SITE),
    { id: 'RNESS-9', number: 9, repository: 'RNESS', reference: 'RNESS-9' }
  )
  const asked = jira.requests[0]
  assert.equal(
    asked === undefined ? '' : queryOf(asked).get('jql'),
    'project = "RNESS" AND labels = "rness-plan" AND statusCategory != Done'
  )
  assert.equal(
    await jj.journalIssue('RNESS', 'acme/cli', 'plans/0053-x.md', SITE),
    null
  )
})

test('a new implementation issue: a Task labelled rness-plan, its body in ADF, the marker its last paragraph', async (t) => {
  const jira = await fakeJira(
    t,
    routes({
      'GET /rest/api/3/project/RNESS': { json: { id: '10002', key: 'RNESS' } },
      'GET /rest/api/3/mypermissions': {
        json: { permissions: { CREATE_ISSUES: { havePermission: true } } },
      },
      'GET /rest/api/3/issue/createmeta/RNESS/issuetypes': {
        json: { issueTypes: [{ id: '10012', hierarchyLevel: 0 }] },
      },
      'POST /rest/api/3/issue': { status: 201, json: { key: 'RNESS-14' } },
    })
  )
  assert.deepEqual(
    await jj.createJournalIssue(
      'RNESS',
      'acme/api',
      'plans/0053-x.md',
      {
        title: 'Implement 0053 - X',
        body: 'Plan [`plans/0053-x.md`](https://x.io)',
      },
      SITE
    ),
    { id: 'RNESS-14', number: 14, repository: 'RNESS', reference: 'RNESS-14' }
  )
  const created = jira.requests.find((r) => r.method === 'POST')
  const fields = (created?.body as { fields: Record<string, unknown> }).fields
  assert.deepEqual(fields['labels'], ['rness-plan'])
  assert.equal(fields['summary'], 'Implement 0053 - X')
  assert.deepEqual(fields['issuetype'], { id: '10012' })
  const description = fields['description'] as AdfDocument
  assert.deepEqual(description.content.at(-1), {
    type: 'paragraph',
    content: [{ type: 'text', text: 'rness journal acme/api plans/0053-x.md' }],
  })
})

test('refused: a space not there, or a permission missing', async (t) => {
  let permission = true
  await fakeJira(t, (r) =>
    pathOf(r) === '/rest/api/3/project/NOPE'
      ? { status: 404, json: {} }
      : pathOf(r) === '/rest/api/3/project/RNESS'
        ? { json: { id: '1', key: 'RNESS' } }
        : {
            json: {
              permissions: { CREATE_ISSUES: { havePermission: permission } },
            },
          }
  )
  const issue = { title: 't', body: 'b' }
  await assert.rejects(
    jj.createJournalIssue('NOPE', 'acme/api', 'plans/x.md', issue, SITE),
    (e: unknown) => {
      assert.ok(e instanceof JournalRefused)
      assert.equal(e.why, 'missing')
      assert.equal(
        e.message,
        'space NOPE not found on acme.atlassian.net (or not visible to you)'
      )
      return true
    }
  )
  permission = false
  await assert.rejects(
    jj.createJournalIssue('RNESS', 'acme/api', 'plans/x.md', issue, SITE),
    (e: unknown) => {
      assert.ok(e instanceof JournalRefused)
      assert.equal(e.why, 'issues')
      assert.equal(
        e.message,
        'RNESS on acme.atlassian.net: this login lacks CREATE_ISSUES'
      )
      return true
    }
  )
})

test("an issue of the space by number; a Relates link; a comment's Markdown in ADF", async (t) => {
  const jira = await fakeJira(
    t,
    routes({
      'GET /rest/api/3/issue/RNESS-3': {
        json: {
          key: 'RNESS-3',
          fields: { status: { statusCategory: { key: 'indeterminate' } } },
        },
      },
      'POST /rest/api/3/issueLink': { status: 201, json: {} },
      'POST /rest/api/3/issue/RNESS-3/comment': { status: 201, json: {} },
    })
  )
  assert.deepEqual(await jj.issueOf('RNESS', 3, SITE), {
    id: 'RNESS-3',
    number: 3,
    open: true,
  })
  assert.equal(await jj.issueOf('RNESS', 4, SITE), null)
  await jj.addSubIssue('RNESS-3', 'RNESS-14', SITE)
  await jj.comment('RNESS-3', '**Note**\n\nText', SITE)
  const posted = jira.requests.find((r) => pathOf(r).endsWith('/comment'))
  assert.deepEqual((posted?.body as { body: AdfDocument }).body.content[0], {
    type: 'paragraph',
    content: [{ type: 'text', text: 'Note', marks: [{ type: 'strong' }] }],
  })
})
