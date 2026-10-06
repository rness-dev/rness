import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseBoard } from '../../src/core/board-declaration.ts'
import {
  type Presets,
  migrateBoards,
  withoutDeclarations,
} from '../../src/core/board-migration.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { presetTemplate } from '../../src/core/presets.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const README = `---
description: The launch.
statuses: [Idea, Draft, Published]
fields:
  Kind: { type: select, from: kind, options: [post, launch] }
labels: directory
owner: cedric
---

# The launch
`
const DOC = '---\nstatus: Idea\n---\n# A\n'

const rnessOf = (root: string) => join(root, '.rness')

test('a board declared by its number is written whole, from its preset', async (t) => {
  const root = await makeWorkspace(t, { org: 'acme', boards: { pulse: 4 } })
  const m = await migrateBoards(
    rnessOf(root),
    await loadManifest(rnessOf(root))
  )
  assert.equal(m.changed, true)
  const pulse = m.boards?.['pulse']
  assert.ok(typeof pulse === 'object')
  assert.equal(pulse.number, 4)
  assert.equal(pulse.preset, 'agent-pulse/1')
  assert.deepEqual(m.lines, [
    ['wrote', 'pulse whole in .rness/rness.json, from agent-pulse/1'],
  ])
})

test('the former projects is renamed boards, its boards as they were; a preset not created yet left as written (spec 0033 §3)', async (t) => {
  const board = {
    number: 5,
    preset: 'agent-pulse/1',
    ...presetTemplate('agent-pulse/1', { collection: 'pulse' }),
  }
  const root = await makeWorkspace(t, {
    org: 'acme',
    projects: { pulse: board, marketing: 'collection' },
  })
  const manifest = await loadManifest(rnessOf(root))
  const m = await migrateBoards(rnessOf(root), manifest)
  assert.equal(m.changed, true)
  assert.deepEqual(m.lines, [
    ['renamed', 'projects to boards in .rness/rness.json'],
  ])
  assert.equal(m.boards?.['marketing'], 'collection')
  const pulse = m.boards?.['pulse']
  assert.ok(typeof pulse === 'object')
  assert.deepEqual(pulse.source, board)
})

test('boards as declared: nothing to rename, nothing changed', async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    boards: { marketing: 'collection' },
    files: { 'marketing/a.md': DOC },
  })
  const m = await migrateBoards(
    rnessOf(root),
    await loadManifest(rnessOf(root))
  )
  assert.equal(m.changed, false)
  assert.deepEqual(m.lines, [])
})

test("a collection's number: its README's declarations in its board, taken out of the README, its other keys kept", async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    boards: { marketing: 8 },
    files: { 'marketing/README.md': README, 'marketing/a.md': DOC },
  })
  const m = await migrateBoards(
    rnessOf(root),
    await loadManifest(rnessOf(root))
  )
  const board = m.boards?.['marketing']
  assert.ok(typeof board === 'object')
  assert.equal(board.description, 'The launch.')
  assert.deepEqual(board.collections, {
    marketing: {
      label: 'Marketing',
      statuses: ['Idea', 'Draft', 'Published'],
      field: null,
    },
  })
  assert.deepEqual(board.fields['Kind']?.options, ['post', 'launch'])
  assert.deepEqual(board.labels, { kind: 'directory' })
  assert.equal(
    m.readmes.get('marketing/README.md'),
    '---\nowner: cedric\n---\n\n# The launch\n'
  )
  assert.deepEqual(m.lines.at(-1), [
    'moved',
    'description, statuses, fields, labels of marketing/README.md into rness.json',
  ])
})

/** A collection's board written whole, as a team declares it. */
const marketingBoard = (over: Record<string, unknown> = {}) => ({
  number: 8,
  ...presetTemplate('collection/1', { collection: 'marketing' }),
  ...over,
})

test("a board declared whole whose collection's README declares the same: the README cleaned, the board as it is", async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    files: {
      'marketing/README.md': '---\ndescription: The launch.\n---\n# L\n',
      'marketing/a.md': DOC,
    },
  })
  const manifest = await loadManifest(rnessOf(root))
  manifest.boards = {
    marketing: parseBoard(
      'marketing',
      marketingBoard({ description: 'The launch.' })
    ),
  }
  const m = await migrateBoards(rnessOf(root), manifest)
  assert.equal(m.readmes.get('marketing/README.md'), '# L\n')
  const board = m.boards?.['marketing']
  assert.ok(typeof board === 'object')
  assert.equal(board.description, 'The launch.')
})

test('a README declaring a value the board declares otherwise: refused, naming both, nothing moved', async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    files: { 'marketing/README.md': README, 'marketing/a.md': DOC },
  })
  const manifest = await loadManifest(rnessOf(root))
  manifest.boards = {
    marketing: parseBoard(
      'marketing',
      marketingBoard({ description: 'Another.' })
    ),
  }
  const m = await migrateBoards(rnessOf(root), manifest)
  assert.equal(m.readmes.size, 0)
  assert.deepEqual(m.lines, [
    [
      'refused',
      'marketing/README.md declares description otherwise than boards.marketing: keep one, in rness.json',
    ],
  ])
})

test('a README declaring what the board lacks: moved into the board', async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    files: { 'marketing/README.md': README, 'marketing/a.md': DOC },
  })
  const manifest = await loadManifest(rnessOf(root))
  manifest.boards = {
    marketing: parseBoard('marketing', marketingBoard()),
  }
  const m = await migrateBoards(rnessOf(root), manifest)
  const board = m.boards?.['marketing']
  assert.ok(typeof board === 'object')
  assert.equal(board.description, 'The launch.')
  assert.deepEqual(board.fields['Kind']?.from, ['kind'])
  assert.ok(m.readmes.has('marketing/README.md'))
})

/** Revision 2 of agent-pulse, as a later rness might bring it: Blocked purple, a view more. */
const LATER: Presets = {
  knows: (ref) =>
    ['agent-pulse/1', 'agent-pulse/2', 'collection/1'].includes(ref),
  current: (name) => (name === 'agent-pulse' ? 'agent-pulse/2' : `${name}/1`),
  template: (ref, vars) => {
    if (ref !== 'agent-pulse/2') return presetTemplate(ref, vars)
    const one = presetTemplate('agent-pulse/1', vars)
    return {
      ...one,
      colors: {
        ...(one['colors'] as Record<string, string>),
        Blocked: 'purple',
        Draft: 'blue',
      },
      views: [
        ...(one['views'] as unknown[]),
        { name: 'Blocked', layout: 'table', filter: 'status:Blocked' },
      ],
    }
  },
}

test('a newer revision of the preset: merged value by value, the record moved, what the team changed kept and named; merged again, nothing', async (t) => {
  const root = await makeWorkspace(t, { org: 'acme' })
  const manifest = await loadManifest(rnessOf(root))
  const one = presetTemplate('agent-pulse/1', { collection: 'pulse' })
  manifest.boards = {
    pulse: parseBoard('pulse', {
      number: 4,
      preset: 'agent-pulse/1',
      ...one,
      colors: { ...(one['colors'] as object), Draft: 'orange' },
    }),
  }
  const m = await migrateBoards(rnessOf(root), manifest, LATER)
  const board = m.boards?.['pulse']
  assert.ok(typeof board === 'object')
  assert.equal(board.preset, 'agent-pulse/2')
  assert.equal(board.colors['Blocked'], 'purple', 'untouched: the new one')
  assert.equal(board.colors['Draft'], 'orange', "the team's kept")
  assert.ok(board.views.some((v) => v.name === 'Blocked'))
  assert.deepEqual(m.lines, [
    ['merged', 'pulse to agent-pulse/2'],
    [
      'kept',
      'boards.pulse.colors.Draft: kept orange, agent-pulse/2 gives blue',
    ],
  ])
  // As read back from rness.json, by a rness that has revision 2.
  const back = Object.fromEntries(
    Object.entries(m.boards ?? {}).map(([n, b]) => [
      n,
      typeof b === 'object' ? parseBoard(n, b.source, LATER.knows) : b,
    ])
  )
  const again = await migrateBoards(
    rnessOf(root),
    { ...manifest, boards: back },
    LATER
  )
  assert.equal(again.changed, false)
  assert.deepEqual(again.lines, [])
})

test('a board without preset is never merged', async (t) => {
  const root = await makeWorkspace(t, { org: 'acme' })
  const manifest = await loadManifest(rnessOf(root))
  const one = presetTemplate('agent-pulse/1', { collection: 'pulse' })
  manifest.boards = { pulse: parseBoard('pulse', { number: 4, ...one }) }
  const m = await migrateBoards(rnessOf(root), manifest, LATER)
  assert.equal(m.changed, false)
})

test('withoutDeclarations: the front matter left empty goes whole; one without it is untouched', () => {
  assert.equal(
    withoutDeclarations('---\nstatuses: [A]\nlabels: directory\n---\n\n# T\n'),
    '# T\n'
  )
  assert.equal(withoutDeclarations('# T\n'), '# T\n')
})
