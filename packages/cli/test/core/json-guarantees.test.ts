import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Guarantee } from '../../src/core/agents.ts'
import {
  describeGuarantee,
  ensureGuarantees,
  missingGuarantees,
} from '../../src/core/json-guarantees.ts'

const DIRS: Guarantee = {
  path: ['permissions', 'additionalDirectories'],
  contains: '../../.rness',
}

test('a missing file is created with the guaranteed values only', () => {
  assert.deepEqual(ensureGuarantees(null, [DIRS]), {
    kind: 'created',
    text: '{\n  "permissions": {\n    "additionalDirectories": [\n      "../../.rness"\n    ]\n  }\n}\n',
  })
})

test("the team's settings stay; the value is added where it belongs", () => {
  const team =
    '{\n  "model": "opus",\n  "permissions": {\n    "allow": ["Bash(pnpm test)"]\n  }\n}\n'
  const r = ensureGuarantees(team, [DIRS])
  assert.ok(r.kind === 'updated')
  assert.deepEqual(JSON.parse(r.text), {
    model: 'opus',
    permissions: {
      allow: ['Bash(pnpm test)'],
      additionalDirectories: ['../../.rness'],
    },
  })
  assert.deepEqual(Object.keys(JSON.parse(r.text)), ['model', 'permissions'])
})

test('an entry is appended to a list that exists; a present one changes nothing', () => {
  const r = ensureGuarantees(
    '{ "permissions": { "additionalDirectories": ["../shared"] } }\n',
    [DIRS]
  )
  assert.ok(r.kind === 'updated')
  assert.deepEqual(JSON.parse(r.text).permissions.additionalDirectories, [
    '../shared',
    '../../.rness',
  ])
  const same = '{"permissions":{"additionalDirectories":["../../.rness"]}}'
  assert.deepEqual(ensureGuarantees(same, [DIRS]), {
    kind: 'unchanged',
    text: same,
  })
})

test('the file keeps its indentation, line endings and final newline', () => {
  const tabs = ensureGuarantees('{\n\t"model": "opus"\n}\n', [DIRS])
  assert.ok(tabs.kind === 'updated')
  assert.match(tabs.text, /^\{\n\t"model": "opus",\n\t"permissions": \{\n\t\t"/)
  const four = ensureGuarantees('{\n    "model": "opus"\n}', [DIRS])
  assert.ok(four.kind === 'updated')
  assert.match(four.text, /^\{\n {4}"model"/)
  assert.ok(!four.text.endsWith('\n'), 'no final newline added')
  const crlf = ensureGuarantees('{\r\n  "model": "opus"\r\n}\r\n', [DIRS])
  assert.ok(crlf.kind === 'updated')
  assert.ok(crlf.text.includes('\r\n  "permissions": {\r\n'))
  assert.ok(!/[^\r]\n/.test(crlf.text), 'every newline is CRLF')
})

test('a file that is not JSON, or a value of another type, is never rewritten', () => {
  assert.deepEqual(ensureGuarantees('{ "model": ', [DIRS]), {
    kind: 'invalid',
    reason: 'not valid JSON',
  })
  assert.deepEqual(ensureGuarantees('[]', [DIRS]), {
    kind: 'invalid',
    reason: 'not a JSON object',
  })
  assert.deepEqual(
    ensureGuarantees(
      '{ "permissions": { "additionalDirectories": "../../.rness" } }',
      [DIRS]
    ),
    {
      kind: 'invalid',
      reason: 'permissions.additionalDirectories is not a list',
    }
  )
  assert.deepEqual(ensureGuarantees('{ "permissions": true }', [DIRS]), {
    kind: 'invalid',
    reason: 'permissions is not an object',
  })
})

test('missingGuarantees says what ensure would add, and nothing when all is there', () => {
  assert.deepEqual(missingGuarantees(null, [DIRS]), [DIRS])
  assert.deepEqual(missingGuarantees('{}', [DIRS]), [DIRS])
  assert.deepEqual(
    missingGuarantees(
      '{"permissions":{"additionalDirectories":["../../.rness"]}}',
      [DIRS]
    ),
    []
  )
  assert.deepEqual(missingGuarantees('nope', [DIRS]), {
    invalid: 'not valid JSON',
  })
  assert.equal(
    describeGuarantee(DIRS),
    'permissions.additionalDirectories lacks ../../.rness'
  )
})
