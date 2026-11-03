import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { gitPath } from '../../src/core/git.ts'
import type { PolicyFailure } from '../../src/core/policy-check.ts'
import type { Policy } from '../../src/core/policy.ts'
import {
  REFUSALS_FILE,
  pruneRefusals,
  readRefusals,
  recordRefusals,
  refusalsOf,
} from '../../src/core/refusals.ts'
import { git } from '../helpers/git.ts'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-03T12:00:00.000Z')

async function repo(t: TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-refusals-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await git(['init', '-q', '-b', 'main'], dir)
  return dir
}

async function recordFile(dir: string): Promise<string> {
  const file = await gitPath(dir, REFUSALS_FILE)
  assert.ok(file !== null)
  return file
}

test('a refusal is one JSON line in the git directory, read back as written', async (t) => {
  const dir = await repo(t)
  assert.equal(
    await recordRefusals(
      dir,
      [
        { policy: 'no-em-dash', check: 'added-lines', by: 'pre-commit' },
        {
          policy: 'no-agent-trailers',
          check: 'commit-message',
          by: 'guard',
          session: 'abc',
        },
      ],
      NOW
    ),
    true
  )
  const file = await recordFile(dir)
  assert.equal(file, join(dir, '.git', 'rness', 'refusals.jsonl'))
  assert.equal(
    await readFile(file, 'utf8'),
    '{"time":"2026-11-03T12:00:00.000Z","policy":"no-em-dash","check":"added-lines","by":"pre-commit"}\n' +
      '{"time":"2026-11-03T12:00:00.000Z","policy":"no-agent-trailers","check":"commit-message","by":"guard","session":"abc"}\n'
  )
  assert.deepEqual(await readRefusals(dir), [
    {
      time: '2026-11-03T12:00:00.000Z',
      policy: 'no-em-dash',
      check: 'added-lines',
      by: 'pre-commit',
    },
    {
      time: '2026-11-03T12:00:00.000Z',
      policy: 'no-agent-trailers',
      check: 'commit-message',
      by: 'guard',
      session: 'abc',
    },
  ])
})

test('records append; nothing is written for no entry', async (t) => {
  const dir = await repo(t)
  assert.equal(await recordRefusals(dir, [], NOW), true)
  assert.deepEqual(await readRefusals(dir), [])
  for (const at of [NOW - DAY, NOW])
    await recordRefusals(
      dir,
      [{ policy: 'p', check: 'push', by: 'pre-push' }],
      at
    )
  assert.deepEqual(
    (await readRefusals(dir)).map((r) => r.time),
    ['2026-11-02T12:00:00.000Z', '2026-11-03T12:00:00.000Z']
  )
})

test('a window: since and until, both inclusive, in milliseconds', async (t) => {
  const dir = await repo(t)
  for (const days of [10, 5, 1])
    await recordRefusals(
      dir,
      [{ policy: `p${days}`, check: 'push', by: 'pre-push' }],
      NOW - days * DAY
    )
  const names = async (window: { since?: number; until?: number }) =>
    (await readRefusals(dir, window)).map((r) => r.policy)
  assert.deepEqual(await names({ since: NOW - 5 * DAY }), ['p5', 'p1'])
  assert.deepEqual(await names({ until: NOW - 5 * DAY }), ['p10', 'p5'])
  assert.deepEqual(
    await names({ since: NOW - 7 * DAY, until: NOW - 2 * DAY }),
    ['p5']
  )
})

test('a line that is not a record is skipped, never thrown', async (t) => {
  const dir = await repo(t)
  await recordRefusals(dir, [{ policy: 'ok', check: 'push', by: 'pre-push' }])
  const file = await recordFile(dir)
  const good = await readFile(file, 'utf8')
  await writeFile(
    file,
    [
      'not json',
      '{"time":"yesterday","policy":"x","check":"push","by":"pre-push"}',
      '{"time":"2026-11-03T12:00:00.000Z","policy":"x","check":"lint","by":"pre-push"}',
      '{"time":"2026-11-03T12:00:00.000Z","policy":"x","check":"push","by":"ci"}',
      '{"time":"2026-11-03T12:00:00.000Z","policy":"","check":"push","by":"pre-push"}',
      '[1]',
      '',
    ].join('\n') + good
  )
  assert.deepEqual(
    (await readRefusals(dir)).map((r) => r.policy),
    ['ok']
  )
})

test('pruning keeps the last days and says how many went', async (t) => {
  const dir = await repo(t)
  for (const days of [40, 31, 29, 0])
    await recordRefusals(
      dir,
      [{ policy: `p${days}`, check: 'push', by: 'pre-push' }],
      NOW - days * DAY
    )
  assert.equal(await pruneRefusals(dir, 30, NOW), 2)
  assert.deepEqual(
    (await readRefusals(dir)).map((r) => r.policy),
    ['p29', 'p0']
  )
  assert.equal(await pruneRefusals(dir, 30, NOW), 0)
})

test('outside a repository: nothing recorded, nothing read, nothing thrown', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-norepo-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  assert.equal(
    await recordRefusals(dir, [{ policy: 'p', check: 'push', by: 'pre-push' }]),
    false
  )
  assert.deepEqual(await readRefusals(dir), [])
  assert.equal(await pruneRefusals(dir, 30), 0)
  assert.equal(
    await recordRefusals(join(dir, 'missing'), [
      { policy: 'p', check: 'push', by: 'pre-push' },
    ]),
    false
  )
})

const policy = (name: string): Policy => ({
  name,
  rel: `policy/${name}.md`,
  scope: null,
  title: name,
  status: 'Enabled',
  standard: null,
  rules: [],
  body: '',
})

test('refusalsOf: one entry per policy and check that refused, the session when known', () => {
  const dash = policy('no-em-dash')
  const trailers = policy('no-agent-trailers')
  const failure = (p: Policy, where: string): PolicyFailure => ({
    policy: p,
    rule: { check: 'added-lines', deny: 'x', fix: 'y' },
    where,
    line: 'x',
  })
  assert.deepEqual(
    refusalsOf(
      [failure(dash, 'a:1'), failure(dash, 'a:2'), failure(trailers, 'b:1')],
      'pre-commit'
    ),
    [
      { policy: 'no-em-dash', check: 'added-lines', by: 'pre-commit' },
      { policy: 'no-agent-trailers', check: 'added-lines', by: 'pre-commit' },
    ]
  )
  assert.deepEqual(
    refusalsOf([failure(dash, 'a:1')], 'guard', 'abc')[0]?.session,
    'abc'
  )
  assert.deepEqual(refusalsOf([], 'guard'), [])
})
