import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createIssue,
  createLabel,
  issue,
  labels,
  link,
  listIssues,
  mergeRequest,
  note,
  projectOf,
  updateIssue,
} from '../../src/core/gitlab-issues.ts'
import type { Recorded, Reply } from '../helpers/fake-github.ts'
import { fakeGitlab } from '../helpers/fake-gitlab.ts'

// The issues of a GitLab project (spec 0037 §6; plan 0049 task 5), against
// a fake gitlab.com. A project is addressed by its path, encoded whole.

const O = { token: 'tok' }

const raw = (iid: number, extra: Record<string, unknown> = {}) => ({
  id: 1000 + iid,
  iid,
  title: `T${iid}`,
  description: `D${iid}`,
  labels: ['rness'],
  state: 'opened',
  ...extra,
})

const at = (r: Recorded): string => new URL(r.path, 'http://x').pathname

test("a project's id and whether it takes issues; null when GitLab knows none", async (t) => {
  let reply: Reply = { json: { id: 7, issues_access_level: 'enabled' } }
  const gl = await fakeGitlab(t, () => reply)
  assert.deepEqual(await projectOf('acme/rness', O), { id: 7, issues: true })
  assert.equal(at(gl.requests[0]!), '/api/v4/projects/acme%2Frness')
  reply = { json: { id: 7, issues_access_level: 'disabled' } }
  assert.deepEqual(await projectOf('acme/rness', O), { id: 7, issues: false })
  reply = { status: 404, json: { message: '404 Project Not Found' } }
  assert.equal(await projectOf('acme/rness', O), null)
})

test('an issue created with its labels, as one comma-separated field', async (t) => {
  const gl = await fakeGitlab(t, () => ({ status: 201, json: raw(3) }))
  assert.deepEqual(
    await createIssue(
      'acme/rness',
      { title: 'T3', description: 'D3', labels: ['rness', 'Status::Draft'] },
      O
    ),
    {
      iid: 3,
      title: 'T3',
      description: 'D3',
      labels: ['rness'],
      state: 'opened',
    }
  )
  assert.equal(gl.requests[0]?.method, 'POST')
  assert.equal(at(gl.requests[0]!), '/api/v4/projects/acme%2Frness/issues')
  assert.deepEqual(gl.requests[0]?.body, {
    title: 'T3',
    description: 'D3',
    labels: 'rness,Status::Draft',
  })
})

test('an update sends only what changes: labels added and removed in one call, a state event', async (t) => {
  const gl = await fakeGitlab(t, () => ({ json: raw(3, { state: 'closed' }) }))
  await updateIssue(
    'acme/rness',
    3,
    {
      addLabels: ['Status::Done'],
      removeLabels: ['Status::Draft', 'Status::Todo'],
      stateEvent: 'close',
    },
    O
  )
  assert.equal(gl.requests[0]?.method, 'PUT')
  assert.equal(at(gl.requests[0]!), '/api/v4/projects/acme%2Frness/issues/3')
  assert.deepEqual(gl.requests[0]?.body, {
    add_labels: 'Status::Done',
    remove_labels: 'Status::Draft,Status::Todo',
    state_event: 'close',
  })
  await updateIssue('acme/rness', 3, { title: 'New', description: 'Body' }, O)
  assert.deepEqual(gl.requests[1]?.body, { title: 'New', description: 'Body' })
})

test('an issue by its iid, or null; the issues of a label and a state, paged', async (t) => {
  const gl = await fakeGitlab(t, (r) => {
    if (at(r) === '/api/v4/projects/acme%2Fapi/issues/9')
      return { status: 404, json: {} }
    if (at(r) === '/api/v4/projects/acme%2Fapi/issues/3')
      return { json: raw(3) }
    const page = new URL(r.path, 'http://x').searchParams.get('page')
    return page === '1'
      ? { json: [raw(1)], headers: { 'x-next-page': '2' } }
      : { json: [raw(2)] }
  })
  assert.equal((await issue('acme/api', 3, O))?.iid, 3)
  assert.equal(await issue('acme/api', 9, O), null)
  const listed = await listIssues(
    'acme/api',
    { labels: ['rness:plan'], state: 'opened' },
    O
  )
  assert.deepEqual(
    listed.map((i) => i.iid),
    [1, 2]
  )
  const query = new URL(gl.requests.at(-1)!.path, 'http://x').searchParams
  assert.equal(query.get('labels'), 'rness:plan')
  assert.equal(query.get('state'), 'opened')
})

test("a project's labels, and a label made with its colour", async (t) => {
  const gl = await fakeGitlab(t, (r) =>
    r.method === 'POST'
      ? { status: 201, json: {} }
      : { json: [{ name: 'rness', color: '#5319e7', id: 1 }] }
  )
  assert.deepEqual(await labels('acme/rness', O), [
    { name: 'rness', color: '#5319e7' },
  ])
  await createLabel(
    'acme/rness',
    { name: 'rness:plan', color: '0e8a16', description: 'A plan' },
    O
  )
  assert.equal(at(gl.requests[1]!), '/api/v4/projects/acme%2Frness/labels')
  assert.deepEqual(gl.requests[1]?.body, {
    name: 'rness:plan',
    color: '#0e8a16',
    description: 'A plan',
  })
})

test("a note on an issue; a link relates_to another project's issue", async (t) => {
  const gl = await fakeGitlab(t, () => ({ status: 201, json: {} }))
  await note('acme/api', 4, 'Hello', O)
  assert.equal(
    at(gl.requests[0]!),
    '/api/v4/projects/acme%2Fapi/issues/4/notes'
  )
  assert.deepEqual(gl.requests[0]?.body, { body: 'Hello' })
  await link('acme/rness', 12, 'acme/api', 4, O)
  assert.equal(
    at(gl.requests[1]!),
    '/api/v4/projects/acme%2Frness/issues/12/links'
  )
  assert.deepEqual(gl.requests[1]?.body, {
    target_project_id: 'acme/api',
    target_issue_iid: 4,
    link_type: 'relates_to',
  })
})

test('the latest merge request of a branch, locked read as opened; none', async (t) => {
  let state = 'locked'
  const gl = await fakeGitlab(t, () => ({ json: [{ iid: 5, state }] }))
  assert.deepEqual(await mergeRequest('acme/api', 'feat/x', O), {
    iid: 5,
    state: 'opened',
  })
  const query = new URL(gl.requests[0]!.path, 'http://x').searchParams
  assert.equal(query.get('source_branch'), 'feat/x')
  assert.equal(query.get('order_by'), 'updated_at')
  state = 'merged'
  assert.deepEqual(await mergeRequest('acme/api', 'feat/x', O), {
    iid: 5,
    state: 'merged',
  })
  await fakeGitlab(t, () => ({ json: [] }))
  assert.equal(await mergeRequest('acme/api', 'feat/y', O), null)
})

test("a refused write names GitLab's own message", async (t) => {
  await fakeGitlab(t, () => ({
    status: 403,
    json: { message: '403 Forbidden' },
  }))
  await assert.rejects(note('acme/api', 4, 'x', O), {
    message:
      'GitLab API answered 403 for /projects/acme%2Fapi/issues/4/notes: 403 Forbidden',
  })
})
