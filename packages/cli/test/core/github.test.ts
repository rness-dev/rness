import assert from 'node:assert/strict'
import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { type TestContext, test } from 'node:test'

import { listRepositories } from '../../src/core/github.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

/** A local stand-in for api.github.com on 127.0.0.1, closed after the test. */
async function api(
  t: TestContext,
  handler: Handler
): Promise<{ base: string; requests: IncomingMessage[] }> {
  const requests: IncomingMessage[] = []
  const server = createServer((req, res) => {
    requests.push(req)
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise<void>((resolve) => {
        // Keep-alive sockets and a request left unanswered would keep close()
        // pending forever.
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, requests }
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

const repo = (name: string, extra: Partial<Record<string, boolean>> = {}) => ({
  name,
  private: false,
  archived: false,
  ...extra,
})

test('follows the Link header page by page', async (t) => {
  const { base, requests } = await api(t, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const page = url.searchParams.get('page')
    if (url.pathname !== '/orgs/Acme-Corp/repos') return json(res, 500, {})
    if (page === '1')
      return json(res, 200, [repo('web'), repo('api', { private: true })], {
        link: '<https://api.github.com/organizations/1/repos?page=2>; rel="next", <https://api.github.com/organizations/1/repos?page=3>; rel="last"',
      })
    if (page === '2')
      return json(res, 200, [repo('old', { archived: true })], {
        link: '<https://api.github.com/organizations/1/repos?page=3>; rel="next", <https://api.github.com/organizations/1/repos?page=1>; rel="first"',
      })
    return json(res, 200, [repo('docs')], {
      link: '<https://api.github.com/organizations/1/repos?page=2>; rel="prev"',
    })
  })
  const listing = await listRepositories('Acme-Corp', { apiBase: base })
  assert.deepEqual(listing, {
    repositories: [
      { name: 'web', private: false, archived: false },
      { name: 'api', private: true, archived: false },
      { name: 'old', private: false, archived: true },
      { name: 'docs', private: false, archived: false },
    ],
    owner: 'org',
    truncated: false,
  })
  assert.deepEqual(
    requests.map((r) => r.url),
    [1, 2, 3].map(
      (n) => `/orgs/Acme-Corp/repos?type=all&per_page=100&page=${n}`
    )
  )
  const headers = requests[0]?.headers ?? {}
  assert.equal(headers['accept'], 'application/vnd.github+json')
  assert.equal(headers['x-github-api-version'], '2022-11-28')
  assert.equal(headers['user-agent'], 'rness-cli')
  assert.equal(headers['authorization'], undefined, 'no token, no header')
})

test('sends the token as a Bearer authorization when given', async (t) => {
  const { base, requests } = await api(t, (_req, res) => json(res, 200, []))
  await listRepositories('acme', { apiBase: `${base}/`, token: 'ghp_secret' })
  assert.equal(requests[0]?.headers['authorization'], 'Bearer ghp_secret')
})

test('a 404 organization falls back to the personal account', async (t) => {
  const { base, requests } = await api(t, (req, res) => {
    if (req.url?.startsWith('/users/octo/repos'))
      return json(res, 200, [repo('dotfiles')])
    return json(res, 404, { message: 'Not Found' })
  })
  const listing = await listRepositories('octo', { apiBase: base })
  assert.equal(
    listing.owner,
    'user',
    'a personal account lists public repositories only'
  )
  assert.deepEqual(
    listing.repositories.map((r) => r.name),
    ['dotfiles']
  )
  assert.deepEqual(
    requests.map((r) => r.url),
    [
      '/orgs/octo/repos?type=all&per_page=100&page=1',
      '/users/octo/repos?type=owner&per_page=100&page=1',
    ]
  )
})

test('404 on both paths names the owner', async (t) => {
  const { base } = await api(t, (_req, res) =>
    json(res, 404, { message: 'Not Found' })
  )
  await assert.rejects(listRepositories('ghost', { apiBase: base }), {
    message:
      'GitHub has no organization or user named "ghost" (or it is not visible to you); add repositories later with rness add <repo>',
  })
})

test('a 404 after the first page is an error, not the personal-account fallback', async (t) => {
  const { base, requests } = await api(t, (req, res) => {
    if (req.url?.endsWith('&page=1'))
      return json(res, 200, [repo('web')], {
        link: '<https://api.github.com/organizations/1/repos?page=2>; rel="next"',
      })
    return json(res, 404, { message: 'Not Found' })
  })
  await assert.rejects(listRepositories('acme', { apiBase: base }), {
    message:
      'GitHub API answered 404 for /orgs/acme/repos; add repositories later with rness add <repo>',
  })
  assert.ok(requests.every((r) => r.url?.startsWith('/orgs/')))
})

test('the page cap stops a listing that always announces a next page', async (t) => {
  const { base, requests } = await api(t, (req, res) => {
    const page = new URL(req.url ?? '/', 'http://x').searchParams.get('page')
    json(res, 200, [repo(`r${page}`)], {
      link: '<https://api.github.com/organizations/1/repos?page=999>; rel="next"',
    })
  })
  const listing = await listRepositories('acme', { apiBase: base })
  assert.equal(requests.length, 50)
  assert.equal(listing.repositories.length, 50)
  assert.equal(listing.truncated, true)
})

test('401, a rate limit, and any other status are one-line errors', async (t) => {
  const { base: unauthorized } = await api(t, (_req, res) =>
    json(res, 401, { message: 'Bad credentials' })
  )
  await assert.rejects(
    listRepositories('acme', { apiBase: unauthorized, token: 'bad' }),
    (e: Error) => {
      assert.equal(e.message, 'GitHub rejected the token (401)')
      assert.notEqual(e.cause, undefined)
      return true
    }
  )

  const { base: limited } = await api(t, (_req, res) =>
    json(
      res,
      403,
      { message: 'API rate limit exceeded' },
      {
        'x-ratelimit-remaining': '0',
      }
    )
  )
  await assert.rejects(listRepositories('acme', { apiBase: limited }), {
    message:
      'GitHub API rate limit reached; set GITHUB_TOKEN or add repositories later with rness add',
  })

  const rateLimitMessage =
    'GitHub API rate limit reached; set GITHUB_TOKEN or add repositories later with rness add'
  const { base: tooMany } = await api(t, (_req, res) => json(res, 429, {}))
  await assert.rejects(listRepositories('acme', { apiBase: tooMany }), {
    message: rateLimitMessage,
  })
  const { base: secondary } = await api(t, (_req, res) =>
    json(res, 403, {}, { 'retry-after': '60', 'x-ratelimit-remaining': '42' })
  )
  await assert.rejects(listRepositories('acme', { apiBase: secondary }), {
    message: rateLimitMessage,
  })

  const { base: forbidden } = await api(t, (_req, res) =>
    json(res, 403, { message: 'Forbidden' }, { 'x-ratelimit-remaining': '42' })
  )
  await assert.rejects(listRepositories('acme', { apiBase: forbidden }), {
    message:
      'GitHub API answered 403 for /orgs/acme/repos; add repositories later with rness add <repo>',
  })

  const { base: broken } = await api(t, (_req, res) => json(res, 502, {}))
  await assert.rejects(listRepositories('acme', { apiBase: broken }), {
    message:
      'GitHub API answered 502 for /orgs/acme/repos; add repositories later with rness add <repo>',
  })
})

test('a request that never answers times out as unreachable', async (t) => {
  const { base } = await api(t, () => {
    // Never answers.
  })
  await assert.rejects(
    listRepositories('acme', { apiBase: base, timeoutMs: 200 }),
    (e: Error) => {
      assert.match(e.message, /^cannot reach the GitHub API: .+$/)
      assert.doesNotMatch(e.message, /\n/)
      assert.notEqual(e.cause, undefined)
      return true
    }
  )
})

test('a refused connection is unreachable, not a crash', async () => {
  // Nothing listens on port 1 of 127.0.0.1 without privileges.
  await assert.rejects(
    listRepositories('acme', {
      apiBase: 'http://127.0.0.1:1',
      timeoutMs: 2_000,
    }),
    /^Error: cannot reach the GitHub API: /
  )
})
