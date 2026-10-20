import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { ResolvedToken } from '../../src/core/auth.ts'
import { GitLabOAuthProvider } from '../../src/core/gitlab-oauth-provider.ts'
import { type Recorded, type Reply } from '../helpers/fake-github.ts'
import { fakeGitlab } from '../helpers/fake-gitlab.ts'

// The GitLab adapter's reads (spec 0037 §4, §5.1, §5.4; plan 0049 task 3).

const LOGIN: ResolvedToken = { token: 'tok', source: 'login', login: 'cedric' }

const project = (
  fullPath: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  path: fullPath.split('/').at(-1),
  path_with_namespace: fullPath,
  visibility: 'private',
  archived: false,
  marked_for_deletion_on: null,
  ...extra,
})

const pathOf = (r: Recorded): string => new URL(r.path, 'http://x').pathname

/** Routes by path; anything else is a 404. */
function routes(table: Record<string, Reply>): (r: Recorded) => Reply {
  return (r) => table[pathOf(r)] ?? { status: 404, json: { message: '404' } }
}

test("a group's projects: the path as the name, the subgroup and internal as hints, a duplicate left out and said, archived, scheduled and rness excluded", async (t) => {
  await fakeGitlab(
    t,
    routes({
      '/api/v4/groups/acme/projects': {
        json: [
          project('acme/api'),
          project('acme/legacy/api'),
          project('acme/platform/Mobile'),
          project('acme/web', { visibility: 'internal' }),
          project('acme/site', { visibility: 'public' }),
          project('acme/rness'),
          project('acme/old', { archived: true }),
          project('acme/gone', { marked_for_deletion_on: '2026-10-26' }),
        ],
      },
    })
  )
  const provider = new GitLabOAuthProvider({ token: LOGIN })
  assert.deepEqual(await provider.listRepositories('acme'), {
    repositories: [
      { name: 'api', private: true, archived: false, path: 'acme/api' },
      {
        name: 'Mobile',
        private: true,
        archived: false,
        path: 'acme/platform/Mobile',
        hint: 'platform/Mobile',
      },
      {
        name: 'web',
        private: true,
        archived: false,
        path: 'acme/web',
        hint: 'internal',
      },
      { name: 'site', private: false, archived: false, path: 'acme/site' },
    ],
    owner: 'org',
    truncated: false,
    notes: ['api and legacy/api share the name api: legacy/api is left out'],
  })
})

test("not a group: the user's own namespace, someone else's, or nobody", async (t) => {
  await fakeGitlab(
    t,
    routes({
      '/api/v4/users/cedric/projects': { json: [project('cedric/notes')] },
      '/api/v4/users/bob/projects': {
        json: [project('bob/tools', { visibility: 'public' })],
      },
    })
  )
  const provider = new GitLabOAuthProvider({ token: LOGIN })
  const own = await provider.listRepositories('cedric')
  assert.equal(own.owner, 'self')
  assert.deepEqual(
    own.repositories.map((r) => r.path),
    ['cedric/notes']
  )
  assert.equal((await provider.listRepositories('bob')).owner, 'user')
  await assert.rejects(provider.listRepositories('nobody'), {
    message:
      'GitLab has no group or user named "nobody" (or it is not visible to you); add repositories later with rness add <repo>',
  })
})

test('the organizations are the top-level groups, approved, with nothing to grant; none anonymously', async (t) => {
  await fakeGitlab(
    t,
    routes({
      '/api/v4/groups': { json: [{ path: 'acme', full_name: 'Acme' }] },
    })
  )
  assert.deepEqual(
    await new GitLabOAuthProvider({ token: LOGIN }).listOrganizations(),
    [{ login: 'acme', approved: true, canGrant: null }]
  )
  const anonymous = new GitLabOAuthProvider({ token: null })
  assert.deepEqual(await anonymous.listOrganizations(), [])
  assert.equal(anonymous.authenticated, false)
  assert.equal(anonymous.approvalUrl(), null)
})

test('access: member at any level, a stranger, unknown otherwise or anonymously', async (t) => {
  let membership: Reply = { json: { access_level: 30 } }
  const gl = await fakeGitlab(t, (r) =>
    pathOf(r) === '/api/v4/user'
      ? { json: { id: 42, username: 'cedric' } }
      : membership
  )
  const provider = new GitLabOAuthProvider({ token: LOGIN })
  assert.equal(await provider.organizationAccess('acme'), 'member')
  // The role reads the same answer: one call per group.
  assert.equal(await provider.organizationRole('acme'), 'Developer')
  assert.equal(
    gl.requests.filter((r) => r.path === '/api/v4/groups/acme/members/all/42')
      .length,
    1
  )
  membership = { status: 404, json: {} }
  const stranger = new GitLabOAuthProvider({ token: LOGIN })
  assert.equal(await stranger.organizationAccess('acme'), 'not-member')
  assert.equal(await stranger.organizationRole('acme'), null)
  membership = { status: 500, json: {} }
  assert.equal(
    await new GitLabOAuthProvider({ token: LOGIN }).organizationAccess('acme'),
    'unknown'
  )
  assert.equal(
    await new GitLabOAuthProvider({ token: null }).organizationAccess('acme'),
    'unknown'
  )
})

test('rness is created private, named _rness, in the group by its id, or in the user namespace; refused anonymously or for a stranger', async (t) => {
  const gl = await fakeGitlab(t, (r) =>
    pathOf(r) === '/api/v4/groups/acme'
      ? { json: { id: 7 } }
      : pathOf(r) === '/api/v4/projects'
        ? { status: 201, json: {} }
        : { status: 404, json: {} }
  )
  const provider = new GitLabOAuthProvider({ token: LOGIN })
  assert.deepEqual(await provider.createRepository('acme', 'rness'), {
    kind: 'created',
  })
  assert.deepEqual(gl.requests.at(-1)?.body, {
    name: '_rness',
    path: 'rness',
    namespace_id: 7,
    visibility: 'private',
  })
  assert.deepEqual(await provider.createRepository('cedric', 'rness'), {
    kind: 'created',
  })
  assert.deepEqual(gl.requests.at(-1)?.body, {
    name: '_rness',
    path: 'rness',
    visibility: 'private',
  })
  assert.deepEqual(await provider.createRepository('bob', 'rness'), {
    kind: 'refused',
    reason: 'GitLab has no group bob (or it is not visible to you)',
  })
  assert.deepEqual(
    await new GitLabOAuthProvider({ token: null }).createRepository(
      'acme',
      'rness'
    ),
    { kind: 'refused', reason: 'not logged in' }
  )
})

test("git over HTTPS: oauth2 and the token for gitlab.com's HTTPS URLs only", () => {
  const provider = new GitLabOAuthProvider({ token: LOGIN })
  assert.deepEqual(provider.credentialsFor('https://gitlab.com/acme/api.git'), {
    username: 'oauth2',
    password: 'tok',
  })
  assert.equal(provider.credentialsFor('https://github.com/acme/api.git'), null)
  assert.equal(provider.credentialsFor('git@gitlab.com:acme/api.git'), null)
  assert.equal(
    new GitLabOAuthProvider({ token: null }).credentialsFor(
      'https://gitlab.com/acme/api.git'
    ),
    null
  )
})

test('the scopes come from GitLab; none anonymously', async (t) => {
  await fakeGitlab(
    t,
    routes({
      '/oauth/token/info': { json: { scope: ['api', 'write_repository'] } },
    })
  )
  assert.deepEqual(await new GitLabOAuthProvider({ token: LOGIN }).scopes(), [
    'api',
    'write_repository',
  ])
  assert.equal(await new GitLabOAuthProvider({ token: null }).scopes(), null)
})

test('the identity: the stored login, else asked; null anonymously', async (t) => {
  await fakeGitlab(
    t,
    routes({ '/api/v4/user': { json: { id: 9, username: 'from-env' } } })
  )
  assert.deepEqual(await new GitLabOAuthProvider({ token: LOGIN }).identity(), {
    login: 'cedric',
  })
  assert.deepEqual(
    await new GitLabOAuthProvider({
      token: { token: 'pat', source: 'GITLAB_TOKEN', login: null },
    }).identity(),
    { login: 'from-env' }
  )
  assert.equal(await new GitLabOAuthProvider({ token: null }).identity(), null)
})
