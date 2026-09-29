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

const SERVER: Guarantee = {
  path: ['mcpServers', 'rness'],
  value: { command: 'node', args: ['x.js', 'mcp'] },
}

test("a key guarantee sets the key when it is missing, and never replaces the team's", () => {
  const created = ensureGuarantees(null, [SERVER])
  assert.ok(created.kind === 'created')
  assert.deepEqual(JSON.parse(created.text), {
    mcpServers: { rness: { command: 'node', args: ['x.js', 'mcp'] } },
  })
  const theirs = '{ "mcpServers": { "db": { "command": "db-mcp" } } }\n'
  const merged = ensureGuarantees(theirs, [SERVER])
  assert.ok(merged.kind === 'updated')
  assert.deepEqual(Object.keys(JSON.parse(merged.text).mcpServers), [
    'db',
    'rness',
  ])
  const custom =
    '{ "mcpServers": { "rness": { "command": "rness", "args": ["mcp"] } } }'
  assert.deepEqual(ensureGuarantees(custom, [SERVER]), {
    kind: 'unchanged',
    text: custom,
  })
  assert.deepEqual(missingGuarantees(custom, [SERVER]), [])
  assert.deepEqual(missingGuarantees(theirs, [SERVER]), [SERVER])
  assert.equal(describeGuarantee(SERVER), 'mcpServers.rness is missing')
  assert.deepEqual(ensureGuarantees('{ "mcpServers": [] }', [SERVER]), {
    kind: 'invalid',
    reason: 'mcpServers is not an object',
  })
})

const HOOK: Guarantee = {
  path: ['hooks', 'SessionStart'],
  contains: {
    hooks: [{ type: 'command', command: 'rness-hook', timeout: 10 }],
  },
  label: 'the rness session-start hook',
}

test("an object entry is appended after the team's own hooks, compared deeply", () => {
  const team = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'team-hook' }] }],
    },
  }
  const r = ensureGuarantees(`${JSON.stringify(team, null, 2)}\n`, [HOOK])
  assert.ok(r.kind === 'updated')
  assert.deepEqual(JSON.parse(r.text).hooks.SessionStart, [
    { hooks: [{ type: 'command', command: 'team-hook' }] },
    { hooks: [{ type: 'command', command: 'rness-hook', timeout: 10 }] },
  ])
  // Key order inside the entry does not matter; the entry is there.
  const reordered = JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ timeout: 10, command: 'rness-hook', type: 'command' }] },
      ],
    },
  })
  assert.deepEqual(ensureGuarantees(reordered, [HOOK]), {
    kind: 'unchanged',
    text: reordered,
  })
})

test('an edited copy of the entry does not count: it is missing', () => {
  const edited = JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'rness-hook', timeout: 30 }] },
      ],
    },
  })
  assert.deepEqual(missingGuarantees(edited, [HOOK]), [HOOK])
  const r = ensureGuarantees(edited, [HOOK])
  assert.ok(r.kind === 'updated')
  assert.equal(JSON.parse(r.text).hooks.SessionStart.length, 2)
})

test('an object entry is described by its label, a string entry by its value', () => {
  assert.equal(
    describeGuarantee(HOOK),
    'hooks.SessionStart lacks the rness session-start hook'
  )
  assert.equal(
    describeGuarantee(DIRS),
    'permissions.additionalDirectories lacks ../../.rness'
  )
})
