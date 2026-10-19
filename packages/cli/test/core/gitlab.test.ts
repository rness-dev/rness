import assert from 'node:assert/strict'
import { test } from 'node:test'

import { MAX_PAGES, type RateWait } from '../../src/core/github.ts'
import {
  createProject,
  getUser,
  groupId,
  groupMembership,
  listGroupProjects,
  listTopLevelGroups,
  listUserProjects,
  tokenScopes,
} from '../../src/core/gitlab.ts'
import { fakeGitlab } from '../helpers/fake-gitlab.ts'

// The GitLab REST client (spec 0037 §1, §4, §5; plan 0049 task 3), against
// a fake gitlab.com that answers as task 1 saw the real one answer.

const project = (
  fullPath: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  path: fullPath.split('/').at(-1),
  path_with_namespace: fullPath,
  name: fullPath.split('/').at(-1),
  visibility: 'private',
  archived: false,
  marked_for_deletion_on: null,
  ...extra,
})

/** A wait that records what it was asked and never sleeps. */
function recordingWait(): RateWait & { slept: number[] } {
  const slept: number[] = []
  return {
    left: 600_000,
    now: () => 0,
    sleep: async (ms) => {
      slept.push(ms)
    },
    slept,
  }
}

test("a group's projects: subgroups in, shared out, archived out, sorted by path, paged by x-next-page", async (t) => {
  const gl = await fakeGitlab(t, (r) => {
    const page = new URL(r.path, 'http://x').searchParams.get('page')
    return page === '1'
      ? {
          json: [project('acme/api'), project('acme/platform/mobile')],
          headers: { 'x-next-page': '2' },
        }
      : {
          json: [
            project('acme/web', {
              visibility: 'internal',
              marked_for_deletion_on: '2026-10-26',
            }),
          ],
          headers: { 'x-next-page': '' },
        }
  })
  const listed = await listGroupProjects('acme', { token: 'tok' })
  assert.deepEqual(listed, {
    projects: [
      {
        path: 'api',
        fullPath: 'acme/api',
        visibility: 'private',
        archived: false,
        scheduledForDeletion: false,
      },
      {
        path: 'mobile',
        fullPath: 'acme/platform/mobile',
        visibility: 'private',
        archived: false,
        scheduledForDeletion: false,
      },
      {
        path: 'web',
        fullPath: 'acme/web',
        visibility: 'internal',
        archived: false,
        scheduledForDeletion: true,
      },
    ],
    truncated: false,
  })
  const first = new URL(gl.requests[0]?.path ?? '', 'http://x')
  assert.equal(first.pathname, '/api/v4/groups/acme/projects')
  assert.deepEqual(Object.fromEntries(first.searchParams), {
    include_subgroups: 'true',
    with_shared: 'false',
    archived: 'false',
    order_by: 'path',
    sort: 'asc',
    per_page: '100',
    page: '1',
  })
  assert.equal(gl.requests[0]?.headers.authorization, 'Bearer tok')
  assert.equal(gl.requests.length, 2)
})

test('a group path is encoded whole; anonymous asks with no Authorization; an unknown group is null', async (t) => {
  const gl = await fakeGitlab(t, () => ({
    status: 404,
    json: { message: '404 Group Not Found' },
  }))
  assert.equal(await listGroupProjects('acme.io', {}), null)
  assert.ok(gl.requests[0]?.path.startsWith('/api/v4/groups/acme.io/projects?'))
  assert.equal(gl.requests[0]?.headers.authorization, undefined)
})

test('paging stops at MAX_PAGES and says it was cut', async (t) => {
  await fakeGitlab(t, (r) => {
    const page = new URL(r.path, 'http://x').searchParams.get('page')
    return {
      json: [project(`acme/p${page}`)],
      headers: { 'x-next-page': String(Number(page) + 1) },
    }
  })
  const listed = await listGroupProjects('acme', { token: 'tok' })
  assert.equal(listed?.projects.length, MAX_PAGES)
  assert.equal(listed?.truncated, true)
})

test('a 429 is waited out by its Retry-After, then asked again', async (t) => {
  let calls = 0
  await fakeGitlab(t, () => {
    calls++
    return calls === 1
      ? { status: 429, json: {}, headers: { 'retry-after': '3' } }
      : { json: [{ path: 'acme', full_name: 'Acme' }] }
  })
  const wait = recordingWait()
  assert.deepEqual(await listTopLevelGroups({ token: 'tok', wait }), [
    { path: 'acme', name: 'Acme' },
  ])
  assert.deepEqual(wait.slept, [3000])
})

test('the top-level groups the user belongs to, at Guest and above', async (t) => {
  const gl = await fakeGitlab(t, () => ({
    json: [
      { path: 'acme', full_name: 'Acme' },
      { path: 'smartt', full_name: 'Smartt' },
    ],
  }))
  assert.deepEqual(await listTopLevelGroups({ token: 'tok' }), [
    { path: 'acme', name: 'Acme' },
    { path: 'smartt', name: 'Smartt' },
  ])
  const url = new URL(gl.requests[0]?.path ?? '', 'http://x')
  assert.equal(url.pathname, '/api/v4/groups')
  assert.equal(url.searchParams.get('min_access_level'), '10')
  assert.equal(url.searchParams.get('top_level_only'), 'true')
})

test("a user's own projects, and an unknown user", async (t) => {
  const gl = await fakeGitlab(t, (r) =>
    r.path.startsWith('/api/v4/users/cedric/')
      ? { json: [project('cedric/notes')] }
      : { status: 404, json: { message: '404 User Not Found' } }
  )
  assert.deepEqual(await listUserProjects('cedric', { token: 'tok' }), {
    projects: [
      {
        path: 'notes',
        fullPath: 'cedric/notes',
        visibility: 'private',
        archived: false,
        scheduledForDeletion: false,
      },
    ],
    truncated: false,
  })
  const url = new URL(gl.requests[0]?.path ?? '', 'http://x')
  assert.equal(url.pathname, '/api/v4/users/cedric/projects')
  assert.equal(url.searchParams.get('owned'), 'true')
  assert.equal(await listUserProjects('nobody', { token: 'tok' }), null)
})

test('the user: username and id; a rejected token in one line', async (t) => {
  let status = 200
  await fakeGitlab(t, () => ({
    status,
    json: status === 200 ? { id: 42, username: 'cedric' } : {},
  }))
  assert.deepEqual(await getUser({ token: 'tok' }), {
    login: 'cedric',
    id: 42,
  })
  status = 401
  await assert.rejects(getUser({ token: 'bad' }), {
    message: 'GitLab rejected the token (401)',
  })
})

test("membership: a member's access level, 404 a stranger, anything else unknown", async (t) => {
  let status = 200
  const gl = await fakeGitlab(t, () => ({
    status,
    json: status === 200 ? { id: 42, access_level: 50 } : {},
  }))
  assert.deepEqual(await groupMembership('acme', 42, { token: 'tok' }), {
    accessLevel: 50,
  })
  assert.equal(gl.requests[0]?.path, '/api/v4/groups/acme/members/all/42')
  status = 404
  assert.equal(
    await groupMembership('acme', 42, { token: 'tok' }),
    'not-member'
  )
  status = 500
  assert.equal(await groupMembership('acme', 42, { token: 'tok' }), 'unknown')
})

test("a group's id, or null", async (t) => {
  let status = 200
  await fakeGitlab(t, () => ({ status, json: { id: 7, path: 'acme' } }))
  assert.equal(await groupId('acme', { token: 'tok' }), 7)
  status = 404
  assert.equal(await groupId('acme', { token: 'tok' }), null)
})

test('a project created private, in a group or in the user namespace; taken; refused', async (t) => {
  let reply: { status: number; json: unknown } = { status: 201, json: {} }
  const gl = await fakeGitlab(t, () => reply)
  assert.deepEqual(await createProject('rness', 7, { token: 'tok' }), {
    kind: 'created',
  })
  assert.equal(gl.requests[0]?.method, 'POST')
  assert.equal(gl.requests[0]?.path, '/api/v4/projects')
  assert.deepEqual(gl.requests[0]?.body, {
    name: 'rness',
    path: 'rness',
    namespace_id: 7,
    visibility: 'private',
  })
  await createProject('rness', null, { token: 'tok' })
  assert.deepEqual(gl.requests[1]?.body, {
    name: 'rness',
    path: 'rness',
    visibility: 'private',
  })
  reply = {
    status: 400,
    json: {
      message: {
        name: ['has already been taken'],
        path: ['has already been taken'],
      },
    },
  }
  assert.deepEqual(await createProject('rness', 7, { token: 'tok' }), {
    kind: 'exists',
  })
  reply = { status: 403, json: { message: '403 Forbidden' } }
  assert.deepEqual(await createProject('rness', 7, { token: 'tok' }), {
    kind: 'refused',
    reason: '403 Forbidden (403)',
  })
})

test("the token's scopes: an OAuth token's, else a personal access token's, else none", async (t) => {
  let oauth = 200
  let pat = 200
  const gl = await fakeGitlab(t, (r) =>
    r.path === '/oauth/token/info'
      ? { status: oauth, json: { scope: ['api', 'write_repository'] } }
      : { status: pat, json: { scopes: ['api'] } }
  )
  assert.deepEqual(await tokenScopes({ token: 'tok' }), [
    'api',
    'write_repository',
  ])
  oauth = 401
  assert.deepEqual(await tokenScopes({ token: 'tok' }), ['api'])
  assert.equal(gl.requests.at(-1)?.path, '/api/v4/personal_access_tokens/self')
  pat = 404
  assert.equal(await tokenScopes({ token: 'tok' }), null)
  pat = 401
  await assert.rejects(tokenScopes({ token: 'tok' }), {
    message: 'GitLab rejected the token (401)',
  })
})

test('errors are one line: another status, an unreachable host', async (t) => {
  await fakeGitlab(t, () => ({ status: 500, json: {} }))
  await assert.rejects(listTopLevelGroups({ token: 'tok' }), {
    message: 'GitLab API answered 500 for /groups',
  })
  await assert.rejects(
    listTopLevelGroups({ token: 'tok', apiBase: 'http://127.0.0.1:1/api/v4' }),
    /^Error: cannot reach the GitLab API: /
  )
})
