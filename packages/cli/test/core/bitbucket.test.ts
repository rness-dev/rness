import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  TokenRefused,
  createRepository,
  listRepositories,
  listWorkspaces,
  pullRequestFor,
  workspacePermission,
} from '../../src/core/bitbucket.ts'
import { MAX_PAGES, type RateWait } from '../../src/core/github.ts'
import { fakeBitbucket } from '../helpers/fake-bitbucket.ts'
import type { Recorded } from '../helpers/fake-github.ts'

// The Bitbucket Cloud REST client (spec 0039 §4, §5; plan 0053 task 3),
// against a fake api.bitbucket.org that answers as task 1 saw the real one.

const pathOf = (r: Recorded): string => new URL(r.path, 'http://x').pathname
const queryOf = (r: Recorded): URLSearchParams =>
  new URL(r.path, 'http://x').searchParams

/** A repository as `GET /2.0/repositories/<workspace>` lists it. */
const repo = (
  slug: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  slug,
  name: slug,
  is_private: true,
  project: { key: 'CLI', name: 'CLI' },
  links: {
    clone: [
      {
        name: 'https',
        href: `https://smarttdev@bitbucket.org/acme/${slug}.git`,
      },
      { name: 'ssh', href: `git@bitbucket.org:acme/${slug}.git` },
    ],
  },
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

test('workspaces: paged by next, sorted by slug, each named by its own call', async (t) => {
  const bb = await fakeBitbucket(t, (r) => {
    const path = pathOf(r)
    if (path === '/2.0/user/workspaces')
      return queryOf(r).get('page') === '2'
        ? { json: { values: [{ workspace: { slug: 'acme' } }] } }
        : {
            json: {
              values: [{ workspace: { slug: 'smartt' } }],
              next: `${bb.base}/2.0/user/workspaces?pagelen=100&page=2`,
            },
          }
    if (path === '/2.0/workspaces/acme') return { json: { name: 'Acme' } }
    if (path === '/2.0/workspaces/smartt') return { status: 404, json: {} }
    return { status: 500, json: {} }
  })
  assert.deepEqual(await listWorkspaces({ token: 'tok' }), [
    { slug: 'acme', name: 'Acme' },
    { slug: 'smartt', name: null },
  ])
  assert.equal(bb.requests[0]?.path, '/2.0/user/workspaces?pagelen=100')
  assert.equal(bb.requests[0]?.headers['authorization'], 'Bearer tok')
})

test('paging follows next on the API only, and stops at MAX_PAGES saying it was cut', async (t) => {
  const bb = await fakeBitbucket(t, (r) => {
    const page = Number(queryOf(r).get('page') ?? '1')
    return {
      json: {
        values: [repo(`r${page}`)],
        next: `${bb.base}/2.0/repositories/acme?pagelen=100&page=${page + 1}`,
      },
    }
  })
  const listed = await listRepositories('acme', { token: 'tok' })
  assert.equal(listed?.repositories.length, MAX_PAGES)
  assert.equal(listed?.truncated, true)

  // A next page on another host is never asked with the token.
  const other = await fakeBitbucket(t, () => ({
    json: {
      values: [repo('api')],
      next: 'https://elsewhere.example/2.0/repositories/acme?page=2',
    },
  }))
  const cut = await listRepositories('acme', { token: 'tok' })
  assert.deepEqual(
    cut?.repositories.map((r) => r.slug),
    ['api']
  )
  assert.equal(cut?.truncated, true)
  assert.equal(other.requests.length, 1)
})

test('a 429 is waited out by its Retry-After, else a minute, then asked again', async (t) => {
  let calls = 0
  await fakeBitbucket(t, () => {
    calls++
    if (calls === 1)
      return { status: 429, json: {}, headers: { 'retry-after': '3' } }
    if (calls === 2) return { status: 429, json: {} }
    return { json: { permission: 'owner' } }
  })
  const wait = recordingWait()
  assert.equal(
    await workspacePermission('acme', { token: 'tok', wait }),
    'owner'
  )
  assert.deepEqual(wait.slept, [3000, 60_000])
})

test("a workspace's permission: Bitbucket's word; 403 or 404 not a member", async (t) => {
  let reply: { status: number; json: unknown } = {
    status: 200,
    json: { permission: 'owner', workspace: { slug: 'acme', name: 'Acme' } },
  }
  const bb = await fakeBitbucket(t, () => reply)
  assert.equal(await workspacePermission('acme', { token: 'tok' }), 'owner')
  assert.equal(bb.requests[0]?.path, '/2.0/user/workspaces/acme/permission')
  for (const status of [403, 404]) {
    reply = {
      status,
      json: {
        type: 'error',
        error: { message: 'You do not have access to view this workspace.' },
      },
    }
    assert.equal(await workspacePermission('other', { token: 'tok' }), null)
  }
  reply = { status: 500, json: {} }
  await assert.rejects(workspacePermission('acme', { token: 'tok' }), {
    message: 'Bitbucket API answered 500 for /user/workspaces/acme/permission',
  })
})

test("a workspace's repositories: the slug, private or not, the project's name; sorted; an unknown workspace is null", async (t) => {
  let status = 200
  const bb = await fakeBitbucket(t, () =>
    status === 200
      ? {
          json: {
            values: [
              repo('web', { is_private: false, project: { name: 'Platform' } }),
              repo('.rness'),
              repo('api'),
              repo('tools', { project: null }),
            ],
          },
        }
      : { status, json: {} }
  )
  assert.deepEqual(await listRepositories('acme', { token: 'tok' }), {
    repositories: [
      { slug: '.rness', private: true, project: 'CLI' },
      { slug: 'api', private: true, project: 'CLI' },
      { slug: 'tools', private: true, project: null },
      { slug: 'web', private: false, project: 'Platform' },
    ],
    truncated: false,
  })
  assert.equal(bb.requests[0]?.path, '/2.0/repositories/acme?pagelen=100')

  // Anonymous: no Authorization, the public repositories only.
  await listRepositories('acme', {})
  assert.equal(bb.requests.at(-1)?.headers['authorization'], undefined)

  status = 404
  assert.equal(await listRepositories('nobody', { token: 'tok' }), null)
})

test('a repository created private, with no project; 200 or 201 created; taken; refused in its words', async (t) => {
  let reply: { status: number; json: unknown } = { status: 200, json: {} }
  const bb = await fakeBitbucket(t, () => reply)
  assert.deepEqual(await createRepository('acme', '.rness', { token: 'tok' }), {
    kind: 'created',
  })
  assert.equal(bb.requests[0]?.method, 'POST')
  assert.equal(bb.requests[0]?.path, '/2.0/repositories/acme/.rness')
  assert.deepEqual(bb.requests[0]?.body, { scm: 'git', is_private: true })

  reply = { status: 201, json: {} }
  assert.deepEqual(await createRepository('acme', '.rness', { token: 'tok' }), {
    kind: 'created',
  })

  reply = {
    status: 400,
    json: {
      type: 'error',
      error: { message: 'Repository with this Slug and Owner already exists.' },
    },
  }
  assert.deepEqual(await createRepository('acme', '.rness', { token: 'tok' }), {
    kind: 'exists',
  })

  reply = {
    status: 403,
    json: {
      type: 'error',
      error: { message: 'You do not have permission to create a repository.' },
    },
  }
  assert.deepEqual(await createRepository('acme', '.rness', { token: 'tok' }), {
    kind: 'refused',
    reason: 'You do not have permission to create a repository. (403)',
  })
})

test("a branch's latest pull request, whatever its state; none is null", async (t) => {
  let values: unknown[] = [
    { id: 3, state: 'DECLINED' },
    { id: 7, state: 'MERGED' },
    { id: 5, state: 'OPEN' },
  ]
  const bb = await fakeBitbucket(t, () => ({ json: { values } }))
  assert.deepEqual(
    await pullRequestFor('acme', 'api', 'feat/x', { token: 'tok' }),
    { number: 7, state: 'MERGED' }
  )
  const asked = bb.requests[0]
  assert.equal(
    asked === undefined ? '' : pathOf(asked),
    '/2.0/repositories/acme/api/pullrequests'
  )
  const q = asked === undefined ? new URLSearchParams() : queryOf(asked)
  assert.equal(q.get('q'), 'source.branch.name="feat/x"')
  assert.deepEqual(q.getAll('state'), [
    'OPEN',
    'MERGED',
    'DECLINED',
    'SUPERSEDED',
  ])
  values = []
  assert.equal(
    await pullRequestFor('acme', 'api', 'feat/x', { token: 'tok' }),
    null
  )
})

test('errors are one line: a refused token, a missing scope named, another status, an unreachable host', async (t) => {
  let reply: { status: number; json: unknown } = { status: 401, json: {} }
  await fakeBitbucket(t, () => reply)
  await assert.rejects(listWorkspaces({ token: 'tok' }), TokenRefused)

  reply = {
    status: 403,
    json: {
      type: 'error',
      error: {
        message: 'Your credentials lack one or more required privilege scopes.',
        detail: {
          required: ['read:repository:bitbucket'],
          granted: ['read:user:bitbucket'],
        },
      },
    },
  }
  await assert.rejects(listRepositories('acme', { token: 'tok' }), {
    message:
      'Bitbucket API answered 403 for /repositories/acme: Your credentials lack one or more required privilege scopes. (missing read:repository:bitbucket)',
  })

  reply = { status: 500, json: {} }
  await assert.rejects(listRepositories('acme', { token: 'tok' }), {
    message: 'Bitbucket API answered 500 for /repositories/acme',
  })
  await assert.rejects(
    listRepositories('acme', { token: 'tok', apiBase: 'http://127.0.0.1:1' }),
    /^Error: cannot reach the Bitbucket API: /
  )
})
