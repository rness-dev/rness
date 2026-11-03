import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  type AddedLinesFile,
  checkAddedLines,
  checkCommitMessage,
  checkPush,
  refusalText,
} from '../../src/core/policy-check.ts'
import type { Policy, PolicyRule } from '../../src/core/policy.ts'

const policy = (
  name: string,
  rules: PolicyRule[],
  standard: string | null = null
): Policy => ({
  name,
  rel: `policy/${name}.md`,
  scope: null,
  title: name,
  status: 'Enabled',
  standard,
  rules,
  body: '',
})

const TRAILERS = policy('no-agent-trailers', [
  {
    check: 'commit-message',
    deny: '^(co-authored-by|claude-session):.*(claude|anthropic)',
    fix: "Remove the agent's Co-Authored-By trailer, then commit again.",
  },
])
const NO_DASH_MSG = policy('no-em-dash', [
  { check: 'commit-message', deny: '\\u2014', fix: 'Use a hyphen.' },
  { check: 'added-lines', deny: '\\u2014', fix: 'Use a hyphen.' },
])
const FORCE = policy('no-force-push', [
  { check: 'push', deny: 'non-fast-forward', fix: 'Push a fast-forward.' },
])

const DASH = '\u2014'
const ZERO = '0'.repeat(40)
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

test('commit-message: the trailer in any case is refused with its line', () => {
  for (const t of [
    'Co-Authored-By: Claude <x@y>',
    'co-authored-by: claude <x@y>',
    'CLAUDE-SESSION: https://claude.ai/x',
  ]) {
    const f = checkCommitMessage(`feat: x\n\n${t}\n`, [TRAILERS])
    assert.equal(f.length, 1)
    assert.equal(f[0]?.where, 'commit message, line 3')
    assert.equal(f[0]?.line, t)
  }
  assert.deepEqual(checkCommitMessage('feat: x\n\nbody\n', [TRAILERS]), [])
})

test('commit-message: lines after the scissors line are dropped', () => {
  const msg = `feat: x\n# ------------------------ >8 ------------------------\nCo-Authored-By: Claude\n`
  assert.deepEqual(checkCommitMessage(msg, [TRAILERS]), [])
  const other = `feat: x\n; ------------------------ >8 ------------------------\nCo-Authored-By: Claude\n`
  assert.deepEqual(checkCommitMessage(other, [TRAILERS]), [])
})

test('commit-message: a comment line before the scissors is checked', () => {
  const f = checkCommitMessage(`feat: x\n# a ${DASH} b\n`, [NO_DASH_MSG])
  assert.equal(f.length, 1)
  assert.equal(f[0]?.where, 'commit message, line 2')
})

test('commit-message: ignores rules of other checks', () => {
  const f = checkCommitMessage(`a ${DASH} b`, [NO_DASH_MSG])
  assert.equal(f.length, 1)
  assert.equal(f[0]?.rule.check, 'commit-message')
})

const file = (
  path: string,
  after: string,
  added: [number, string][]
): AddedLinesFile => ({
  path,
  after,
  added: added.map(([line, text]) => ({ line, text })),
})

test('added-lines: an added em dash is refused, with path:line', () => {
  const after = `ok\nbad ${DASH} line\n`
  const f = checkAddedLines(
    [file('src/a.ts', after, [[2, `bad ${DASH} line`]])],
    () => [NO_DASH_MSG]
  )
  assert.equal(f.length, 1)
  assert.equal(f[0]?.where, 'src/a.ts:2')
})

test('added-lines: an unchanged line passes', () => {
  const after = `old ${DASH} line\nnew\n`
  assert.deepEqual(
    checkAddedLines([file('a.md', after, [[2, 'new']])], () => [NO_DASH_MSG]),
    []
  )
})

test('added-lines: a line inside a rness block passes, outside it is refused', () => {
  const after = [
    `before ${DASH}`,
    '<!-- BEGIN rness -->',
    `inside ${DASH}`,
    '<!-- END rness -->',
    `after ${DASH}`,
  ].join('\n')
  const f = checkAddedLines(
    [
      file('AGENTS.md', after, [
        [1, `before ${DASH}`],
        [3, `inside ${DASH}`],
        [5, `after ${DASH}`],
      ]),
    ],
    () => [NO_DASH_MSG]
  )
  assert.deepEqual(
    f.map((x) => x.where),
    ['AGENTS.md:1', 'AGENTS.md:5']
  )
})

test('added-lines: a file under .claude/skills/rness/ passes', () => {
  const after = `x ${DASH}\n`
  assert.deepEqual(
    checkAddedLines(
      [
        file('org/rness/.claude/skills/rness/hooks/r.tsx', after, [
          [1, `x ${DASH}`],
        ]),
      ],
      () => [NO_DASH_MSG]
    ),
    []
  )
})

test('added-lines: each file takes its own policies', () => {
  const after = `x ${DASH}\n`
  const f = checkAddedLines(
    [
      file('a/x.ts', after, [[1, `x ${DASH}`]]),
      file('b/x.ts', after, [[1, `x ${DASH}`]]),
    ],
    (p) => (p.startsWith('a/') ? [NO_DASH_MSG] : [])
  )
  assert.deepEqual(
    f.map((x) => x.where),
    ['a/x.ts:1']
  )
})

const up = (remoteOid: string, localOid: string, ref = 'refs/heads/main') => ({
  ref,
  remoteOid,
  localOid,
})

test('push: a non-ancestor is refused, an ancestor passes', () => {
  assert.equal(
    checkPush([up(A, B)], () => 'not-ancestor', [FORCE])[0]?.where,
    'refs/heads/main'
  )
  assert.deepEqual(
    checkPush([up(A, B)], () => 'ancestor', [FORCE]),
    []
  )
})

test('push: a new branch and a deletion pass without asking', () => {
  const never = (): never => {
    throw new Error('asked')
  }
  assert.deepEqual(checkPush([up(ZERO, B)], never, [FORCE]), [])
  assert.deepEqual(checkPush([up(A, ZERO)], never, [FORCE]), [])
})

test('push: a remote object missing is refused with a fetch-first fix', () => {
  const f = checkPush([up(A, B)], () => 'missing', [FORCE])
  assert.equal(f.length, 1)
  assert.match(f[0]?.fix ?? '', /^Fetch first/)
  assert.match(refusalText(f, 'push'), /fix: Fetch first, then push again\./)
})

test('refusalText: the exact format of spec 0040 section 5', () => {
  const f = checkCommitMessage(
    'feat: x\n\n\n\n\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
    [TRAILERS]
  )
  assert.equal(
    refusalText(f, 'commit'),
    [
      'rness: policy no-agent-trailers refused this commit',
      '  commit message, line 7: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
      "  fix: Remove the agent's Co-Authored-By trailer, then commit again.",
      '  policy: .rness/policy/no-agent-trailers.md',
    ].join('\n')
  )
})

test('refusalText: actions, the standard, and a 130-character line cut', () => {
  const p = policy(
    'no-em-dash',
    [{ check: 'added-lines', deny: '\\u2014', fix: 'Use a hyphen.' }],
    'standards/documentation.md'
  )
  const long = DASH + 'x'.repeat(129)
  const f = checkAddedLines([file('a.md', long, [[1, long]])], () => [p])
  const text = refusalText(f, 'edit')
  const lines = text.split('\n')
  assert.equal(lines[0], 'rness: policy no-em-dash refused this edit')
  assert.equal(lines[1], `  a.md:1: ${long.slice(0, 120)}`)
  assert.equal(lines[1]?.length, '  a.md:1: '.length + 120)
  assert.equal(lines[3], '  standard: .rness/standards/documentation.md')
  assert.equal(lines[4], '  policy: .rness/policy/no-em-dash.md')
  assert.match(refusalText(f, 'push'), /refused this push/)
})

test('refusalText: two policies fail in one message, grouped', () => {
  const msg = `feat ${DASH}\nCo-Authored-By: Claude`
  const f = checkCommitMessage(msg, [TRAILERS, NO_DASH_MSG])
  const text = refusalText(f, 'commit')
  assert.equal(
    text,
    [
      'rness: policy no-em-dash refused this commit',
      `  commit message, line 1: feat ${DASH}`,
      '  fix: Use a hyphen.',
      '  policy: .rness/policy/no-em-dash.md',
      'rness: policy no-agent-trailers refused this commit',
      '  commit message, line 2: Co-Authored-By: Claude',
      "  fix: Remove the agent's Co-Authored-By trailer, then commit again.",
      '  policy: .rness/policy/no-agent-trailers.md',
    ].join('\n')
  )
  assert.equal(refusalText([], 'commit'), '')
})
