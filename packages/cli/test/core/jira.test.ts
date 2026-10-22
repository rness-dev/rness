import assert from 'node:assert/strict'
import { test } from 'node:test'

import { TokenRefused } from '../../src/core/bitbucket.ts'
import type { RateWait } from '../../src/core/github.ts'
import {
  createSpace,
  keyFree,
  listSpaces,
  myself,
} from '../../src/core/jira.ts'
import type { Recorded } from '../helpers/fake-github.ts'
import { fakeJira } from '../helpers/fake-jira.ts'

// The Jira Cloud REST client's spaces (spec 0039 §4; plan 0053 task 4),
// against a fake site that answers as task 1 saw rness-dev.atlassian.net.

const SITE = { site: 'acme.atlassian.net', email: 'me@acme.io', token: 'tok' }

const pathOf = (r: Recorded): string => new URL(r.path, 'http://x').pathname
const queryOf = (r: Recorded): URLSearchParams =>
  new URL(r.path, 'http://x').searchParams

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

test('the spaces the user can edit: paged by startAt until isLast, by key with their name', async (t) => {
  const jira = await fakeJira(t, (r) =>
    queryOf(r).get('startAt') === '0'
      ? {
          json: {
            values: [{ key: 'OPS', name: 'Operations' }],
            startAt: 0,
            isLast: false,
          },
        }
      : {
          json: {
            values: [{ key: 'KAN', name: 'Kanban' }],
            startAt: 1,
            isLast: true,
          },
        }
  )
  assert.deepEqual(await listSpaces(SITE), [
    { key: 'KAN', name: 'Kanban' },
    { key: 'OPS', name: 'Operations' },
  ])
  const first = jira.requests[0]
  assert.equal(
    first === undefined ? '' : pathOf(first),
    '/rest/api/3/project/search'
  )
  assert.equal(first === undefined ? '' : queryOf(first).get('action'), 'edit')
  assert.equal(
    first?.headers['authorization'],
    `Basic ${Buffer.from('me@acme.io:tok').toString('base64')}`
  )
  assert.equal(
    jira.requests[1] === undefined
      ? ''
      : queryOf(jira.requests[1]).get('startAt'),
    '1'
  )
})

test('a key is free when projectvalidate names no error on projectKey', async (t) => {
  let errors: Record<string, string> = {}
  const jira = await fakeJira(t, () => ({
    json: { errorMessages: [], errors },
  }))
  assert.equal(await keyFree('RNESS', SITE), true)
  assert.equal(
    jira.requests[0]?.path,
    '/rest/api/3/projectvalidate/key?key=RNESS'
  )
  // The site answers in its own language: the field decides, not the words.
  errors = { projectKey: "Le projet 'rness-dev' utilise cette clé de projet." }
  assert.equal(await keyFree('RNESS', SITE), false)
})

test('a space created team-managed Kanban, led by the user; taken; refused in its words', async (t) => {
  let reply: { status: number; json: unknown } = {
    status: 201,
    json: { id: 10002, key: 'RNESS' },
  }
  const jira = await fakeJira(t, () => reply)
  assert.deepEqual(await createSpace('RNESS', 'acc-1', SITE), {
    kind: 'created',
  })
  assert.equal(jira.requests[0]?.method, 'POST')
  assert.equal(jira.requests[0]?.path, '/rest/api/3/project')
  assert.deepEqual(jira.requests[0]?.body, {
    key: 'RNESS',
    name: 'rness',
    leadAccountId: 'acc-1',
    projectTypeKey: 'software',
    projectTemplateKey:
      'com.pyxis.greenhopper.jira:gh-simplified-agility-kanban',
  })

  reply = {
    status: 400,
    json: { errorMessages: [], errors: { projectKey: 'déjà utilisée' } },
  }
  assert.deepEqual(await createSpace('RNESS', 'acc-1', SITE), {
    kind: 'exists',
  })

  reply = {
    status: 403,
    json: {
      errorMessages: ['You must have global administrator rights.'],
      errors: {},
    },
  }
  assert.deepEqual(await createSpace('RNESS', 'acc-1', SITE), {
    kind: 'refused',
    reason: 'You must have global administrator rights. (403)',
  })
})

test('errors: a refused token, another status in its words', async (t) => {
  let reply: { status: number; json: unknown } = { status: 401, json: {} }
  await fakeJira(t, () => reply)
  await assert.rejects(listSpaces(SITE), TokenRefused)
  await assert.rejects(myself(SITE), {
    message: 'acme.atlassian.net refused this email and token (401)',
  })
  reply = { status: 500, json: { errorMessages: ['Boom'], errors: {} } }
  await assert.rejects(listSpaces(SITE), {
    message:
      'acme.atlassian.net answered 500 for /rest/api/3/project/search: Boom',
  })
})

test('a 429 is waited out by its Retry-After, then asked again', async (t) => {
  let calls = 0
  await fakeJira(t, () =>
    calls++ === 0
      ? { status: 429, json: {}, headers: { 'retry-after': '2' } }
      : { json: { values: [], isLast: true } }
  )
  const wait = recordingWait()
  assert.deepEqual(await listSpaces({ ...SITE, wait }), [])
  assert.deepEqual(wait.slept, [2000])
})

test('an unreachable site is one line', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed', { cause: new Error('ENOTFOUND') })
  })
  await assert.rejects(listSpaces(SITE), {
    message: 'cannot reach acme.atlassian.net: ENOTFOUND',
  })
})
