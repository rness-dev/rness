import assert from 'node:assert/strict'
import { test } from 'node:test'

import { graphql } from '../../src/core/github-projects.ts'
import {
  RATE_LIMIT_OUTLASTED,
  RateLimitError,
  type RateWait,
  WAIT_BUDGET_MS,
  postJson,
  rateDelay,
} from '../../src/core/github.ts'
import { openProvider } from '../../src/core/providers.ts'
import { fakeGithub, withEnv } from '../helpers/fake-github.ts'

/** A wait that sleeps nothing and records what it was asked. */
const recorder = (now = 1_000_000) => {
  const slept: number[] = []
  const wait: RateWait = {
    left: WAIT_BUDGET_MS,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms)
    },
  }
  return { wait, slept }
}

const page = (
  status: number,
  headers: Record<string, string> = {},
  body: unknown = {}
) => ({ status, headers: new Headers(headers), body })

test('rateDelay: retry-after first, then the reset of a spent primary limit, else a minute; not a rate limit: null', () => {
  assert.equal(rateDelay(page(403, { 'retry-after': '30' }), 0), 30_000)
  assert.equal(rateDelay(page(429, { 'retry-after': '5' }), 0), 5_000)
  assert.equal(
    rateDelay(
      page(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1100' }),
      1_000_000
    ),
    100_000
  )
  assert.equal(
    rateDelay(
      page(403, {}, { message: 'You have exceeded a secondary rate limit.' }),
      0
    ),
    60_000
  )
  assert.equal(rateDelay(page(429), 0), 60_000)
  assert.equal(rateDelay(page(200), 0, true), 60_000, "GraphQL's RATE_LIMITED")
  assert.equal(
    rateDelay(page(403, {}, { message: 'Must have admin rights' }), 0),
    null
  )
  assert.equal(rateDelay(page(200), 0), null)
  assert.equal(rateDelay(page(404, { 'retry-after': '3' }), 0), null)
})

test('a secondary rate limit is waited on as Retry-After says, then the same request is sent again', async (t) => {
  let calls = 0
  const gh = await fakeGithub(t, () =>
    ++calls === 1
      ? {
          status: 403,
          json: { message: 'You have exceeded a secondary rate limit' },
          headers: { 'retry-after': '7' },
        }
      : { json: { data: { ok: true } } }
  )
  const { wait, slept } = recorder()
  const out = await graphql<{ ok: boolean }>(
    'query { ok }',
    {},
    { token: 't', apiBase: gh.base, wait }
  )
  assert.deepEqual(out, { ok: true })
  assert.deepEqual(slept, [7_000])
  assert.equal(gh.requests.length, 2)
  assert.deepEqual(gh.requests[1]?.body, gh.requests[0]?.body)
  assert.equal(wait.left, WAIT_BUDGET_MS - 7_000)
})

test("GraphQL's RATE_LIMITED, an answer of 200, is waited on too: a minute without Retry-After", async (t) => {
  let calls = 0
  const gh = await fakeGithub(t, () =>
    ++calls === 1
      ? {
          json: {
            errors: [
              { type: 'RATE_LIMITED', message: 'API rate limit exceeded' },
            ],
          },
        }
      : { json: { data: { ok: true } } }
  )
  const { wait, slept } = recorder()
  await graphql('query { ok }', {}, { token: 't', apiBase: gh.base, wait })
  assert.deepEqual(slept, [60_000])
})

test('a wait longer than the budget left is not waited: it fails at once, the budget untouched', async (t) => {
  const gh = await fakeGithub(t, () => ({
    status: 403,
    json: { message: 'secondary rate limit' },
    headers: { 'retry-after': '601' },
  }))
  const { wait, slept } = recorder()
  await assert.rejects(
    graphql('query { ok }', {}, { token: 't', apiBase: gh.base, wait }),
    (e: unknown) =>
      e instanceof RateLimitError && e.message === RATE_LIMIT_OUTLASTED
  )
  assert.deepEqual(slept, [])
  assert.equal(wait.left, WAIT_BUDGET_MS)
  assert.equal(gh.requests.length, 1)
})

test('the budget is shared by every request: 10 minutes in all', async (t) => {
  const gh = await fakeGithub(t, () => ({
    status: 429,
    json: {},
    headers: { 'retry-after': '240' },
  }))
  const { wait, slept } = recorder()
  await assert.rejects(
    postJson('/graphql', {}, { token: 't', apiBase: gh.base, wait }, true),
    RateLimitError
  )
  assert.deepEqual(slept, [240_000, 240_000])
  assert.equal(wait.left, 120_000)
})

test('retry-after: 0 still waits a second, charged to the budget', async (t) => {
  let calls = 0
  const gh = await fakeGithub(t, () =>
    ++calls === 1
      ? { status: 429, json: {}, headers: { 'retry-after': '0' } }
      : { json: { data: {} } }
  )
  const { wait, slept } = recorder()
  await graphql('query { ok }', {}, { token: 't', apiBase: gh.base, wait })
  assert.deepEqual(slept, [1_000])
})

test('a refusal that is no rate limit is not retried', async (t) => {
  const gh = await fakeGithub(t, () => ({
    status: 403,
    json: { message: 'Must have admin rights' },
  }))
  const { wait, slept } = recorder()
  await assert.rejects(
    graphql('query { ok }', {}, { token: 't', apiBase: gh.base, wait }),
    { message: 'Must have admin rights' }
  )
  assert.deepEqual(slept, [])
})

test('the wait given to openProvider reaches every board call', async (t) => {
  withEnv(t, { GITHUB_TOKEN: 'tok', GH_TOKEN: undefined })
  let calls = 0
  const gh = await fakeGithub(t, () =>
    ++calls === 1
      ? { status: 429, json: {}, headers: { 'retry-after': '2' } }
      : {
          json: {
            data: { organization: { projectV2: { id: 'P_1', url: 'u' } } },
          },
        }
  )
  const { wait, slept } = recorder()
  const provider = await openProvider(null, { apiBase: gh.base, wait })
  assert.deepEqual(await provider.board('acme', 7), {
    org: 'acme',
    number: 7,
    url: 'u',
  })
  assert.deepEqual(slept, [2_000])
})
