import assert from 'node:assert/strict'
import { test } from 'node:test'

import { GitHubOAuthProvider } from '../../src/core/github-oauth-provider.ts'
import { type Recorded, fakeGithub } from '../helpers/fake-github.ts'

const TOKEN = { token: 'ghu_secret', source: 'login', login: 'octo' } as const
const repo = (name: string, isPrivate = false) => ({
  name,
  private: isPrivate,
  archived: false,
})

test('anonymous: no identity, no organizations, no credentials, public listing', async (t) => {
  const gh = await fakeGithub(t, () => ({ json: [repo('web')] }))
  const provider = new GitHubOAuthProvider({ token: null, apiBase: gh.base })
  assert.equal(provider.authenticated, false)
  assert.equal(await provider.identity(), null)
  assert.deepEqual(await provider.listOrganizations(), [])
  assert.equal(await provider.organizationAccess('acme'), 'unknown')
  assert.equal(provider.credentialsFor('https://github.com/acme/api.git'), null)
  const listing = await provider.listRepositories('acme')
  assert.deepEqual(listing.repositories, [repo('web')])
  assert.equal(gh.requests.length, 1, 'nothing but the listing was asked')
  assert.equal(gh.requests[0]?.headers['authorization'], undefined)
})

test('credentials are for https://github.com/ only, as x-access-token', () => {
  const provider = new GitHubOAuthProvider({ token: TOKEN })
  assert.deepEqual(provider.credentialsFor('https://github.com/acme/api.git'), {
    username: 'x-access-token',
    password: 'ghu_secret',
  })
  for (const url of [
    'git@github.com:acme/api.git',
    'https://gitlab.com/acme/api.git',
    'https://github.com.evil.example/acme/api.git',
    'file:///tmp/acme/api.git',
  ])
    assert.equal(provider.credentialsFor(url), null, url)
})

test('a stored login knows its name; an environment token asks GitHub once', async (t) => {
  const gh = await fakeGithub(t, () => ({ json: { login: 'from-api' } }))
  const stored = new GitHubOAuthProvider({ token: TOKEN, apiBase: gh.base })
  assert.deepEqual(await stored.identity(), { login: 'octo' })
  assert.equal(gh.requests.length, 0)

  const env = new GitHubOAuthProvider({
    token: { token: 'ghp_env', source: 'GITHUB_TOKEN', login: null },
    apiBase: gh.base,
  })
  assert.deepEqual(await env.identity(), { login: 'from-api' })
  assert.deepEqual(await env.identity(), { login: 'from-api' })
  assert.equal(gh.requests.length, 1)
  assert.equal(gh.requests[0]?.headers['authorization'], 'Bearer ghp_env')
})

test('organizations, and access: member, not a member, hidden by an OAuth restriction', async (t) => {
  const route = (r: Recorded) => {
    if (r.path.startsWith('/user/orgs'))
      return { json: [{ login: 'acme' }, { login: 'Other-Org' }] }
    if (r.path === '/user/memberships/orgs/acme')
      return { json: { state: 'active' } }
    if (r.path === '/user/memberships/orgs/stranger')
      return { status: 404, json: { message: 'Not Found' } }
    if (r.path === '/user/memberships/orgs/locked')
      return {
        status: 403,
        json: {
          message:
            'Although you appear to have the correct authorization credentials, the `locked` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.',
        },
      }
    return { status: 500, json: {} }
  }
  const gh = await fakeGithub(t, route)
  const provider = new GitHubOAuthProvider({ token: TOKEN, apiBase: gh.base })
  assert.deepEqual(await provider.listOrganizations(), [
    { login: 'acme' },
    { login: 'Other-Org' },
  ])
  assert.equal(await provider.organizationAccess('acme'), 'member')
  assert.equal(await provider.organizationAccess('stranger'), 'not-member')
  assert.equal(await provider.organizationAccess('locked'), 'restricted')
  assert.equal(await provider.organizationAccess('broken'), 'unknown')
})

test("a personal account: the logged-in user's own is listed with its private repositories", async (t) => {
  const route = (r: Recorded) => {
    if (r.path.startsWith('/orgs/'))
      return { status: 404, json: { message: 'Not Found' } }
    if (r.path.startsWith('/user/repos'))
      return { json: [repo('notes', true), repo('site')] }
    if (r.path.startsWith('/users/')) return { json: [repo('public-only')] }
    return { status: 500, json: {} }
  }
  const gh = await fakeGithub(t, route)
  const provider = new GitHubOAuthProvider({ token: TOKEN, apiBase: gh.base })

  const own = await provider.listRepositories('Octo')
  assert.equal(own.owner, 'self')
  assert.deepEqual(own.repositories, [repo('notes', true), repo('site')])
  assert.match(gh.requests[1]?.path ?? '', /^\/user\/repos\?affiliation=owner&/)

  const other = await provider.listRepositories('someone-else')
  assert.equal(other.owner, 'user')
  assert.deepEqual(other.repositories, [repo('public-only')])
})
