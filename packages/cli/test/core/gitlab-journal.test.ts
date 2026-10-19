import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ResolvedToken } from '../../src/core/auth.ts'
import { JournalRefused, journalMarker } from '../../src/core/github-journal.ts'
import { GitLabOAuthProvider } from '../../src/core/gitlab-oauth-provider.ts'
import type { Recorded, Reply } from '../helpers/fake-github.ts'
import { fakeGitlab } from '../helpers/fake-gitlab.ts'

// The agent journal on GitLab (spec 0037 §6, spec 0030 §8; plan 0049 task
// 5): an implementation issue labelled rness:plan, found by its last line;
// an issue link where GitHub has a sub-issue; notes; merge requests.

const LOGIN: ResolvedToken = { token: 'tok', source: 'login', login: 'cedric' }
const at = (r: Recorded): string => new URL(r.path, 'http://x').pathname
const MARKER = journalMarker('plans/0049-x.md')

const provider = (): GitLabOAuthProvider =>
  new GitLabOAuthProvider({ token: LOGIN })

test('the open implementation issue is found by its last line, in a subgroup project too', async (t) => {
  const gl = await fakeGitlab(t, () => ({
    json: [
      {
        iid: 1,
        description: 'Other\n\n<!-- rness journal plans/0001-y.md -->',
      },
      { iid: 2, description: `Body\n\n${MARKER}\n` },
    ],
  }))
  assert.deepEqual(
    await provider().journalIssue('acme/platform', 'mobile', 'plans/0049-x.md'),
    {
      id: 'acme/platform/mobile#2',
      number: 2,
      repository: 'acme/platform/mobile',
    }
  )
  const q = new URL(gl.requests[0]!.path, 'http://x')
  assert.equal(q.pathname, '/api/v4/projects/acme%2Fplatform%2Fmobile/issues')
  assert.equal(q.searchParams.get('labels'), 'rness:plan')
  assert.equal(q.searchParams.get('state'), 'opened')
})

test('a new implementation issue: the label made when missing, the marker last; refused without issues or project', async (t) => {
  let project: Reply = { json: { id: 7, issues_access_level: 'enabled' } }
  const gl = await fakeGitlab(t, (r) => {
    if (at(r) === '/api/v4/projects/acme%2Fapi') return project
    if (at(r).endsWith('/labels'))
      return r.method === 'POST'
        ? { status: 201, json: { id: 9 } }
        : { json: [] }
    return { status: 201, json: { iid: 4, state: 'opened' } }
  })
  assert.deepEqual(
    await provider().createJournalIssue('acme', 'api', 'plans/0049-x.md', {
      title: 'Implement 0049',
      body: 'Plan …',
    }),
    { id: 'acme/api#4', number: 4, repository: 'acme/api' }
  )
  const label = gl.requests.find(
    (r) => r.method === 'POST' && at(r).endsWith('/labels')
  )
  assert.equal((label?.body as { name: string }).name, 'rness:plan')
  const made = gl.requests.at(-1)?.body as Record<string, string>
  assert.equal(made['labels'], 'rness:plan')
  assert.equal(made['description'], `Plan …\n\n${MARKER}\n`)

  project = { json: { id: 7, issues_access_level: 'disabled' } }
  await assert.rejects(
    provider().createJournalIssue('acme', 'api', 'plans/0049-x.md', {
      title: 't',
      body: 'b',
    }),
    (e: unknown) => e instanceof JournalRefused && e.why === 'issues'
  )
  project = { status: 404, json: {} }
  await assert.rejects(
    provider().createJournalIssue('acme', 'api', 'plans/0049-x.md', {
      title: 't',
      body: 'b',
    }),
    (e: unknown) =>
      e instanceof JournalRefused &&
      e.why === 'missing' &&
      e.message === 'acme/api is not on GitLab, or this login cannot see it'
  )
})

test('an issue by number, open or not; the link from the plan issue; a note; a merge request', async (t) => {
  const gl = await fakeGitlab(t, (r) => {
    if (at(r) === '/api/v4/projects/acme%2Frness/issues/12')
      return { json: { iid: 12, state: 'closed' } }
    if (at(r).endsWith('/merge_requests'))
      return { json: [{ iid: 5, state: 'merged' }] }
    return { status: 201, json: {} }
  })
  const p = provider()
  assert.deepEqual(await p.issueOf('acme', 'rness', 12), {
    id: 'acme/rness#12',
    number: 12,
    open: false,
  })
  await p.addSubIssue('acme/rness#12', 'acme/platform/mobile#4')
  const linked = gl.requests.at(-1)!
  assert.equal(at(linked), '/api/v4/projects/acme%2Frness/issues/12/links')
  assert.deepEqual(linked.body, {
    target_project_id: 'acme/platform/mobile',
    target_issue_iid: 4,
    link_type: 'relates_to',
  })
  await p.comment('acme/platform/mobile#4', 'A note')
  assert.equal(
    at(gl.requests.at(-1)!),
    '/api/v4/projects/acme%2Fplatform%2Fmobile/issues/4/notes'
  )
  assert.deepEqual(await p.pullRequestFor('acme', 'api', 'feat/x'), {
    number: 5,
    state: 'merged',
  })
})

test('checkIssues: the context project rness must exist and take issues', async (t) => {
  let project: Reply = { json: { id: 7, issues_access_level: 'enabled' } }
  await fakeGitlab(t, () => project)
  await provider().checkIssues('acme')
  project = { json: { id: 7, issues_access_level: 'disabled' } }
  await assert.rejects(provider().checkIssues('acme'), {
    message:
      'the boards need Issues on acme/rness: turn them on in its Settings > General > Visibility, project features, permissions',
  })
  project = { status: 404, json: {} }
  await assert.rejects(provider().checkIssues('acme'), {
    message: 'acme/rness is not on GitLab (or not visible to you)',
  })
})
