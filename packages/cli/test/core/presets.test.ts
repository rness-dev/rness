import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseBoard } from '../../src/core/board-declaration.ts'
import { presetSource } from '../../src/core/preset-board.ts'
import {
  currentPreset,
  isPresetRevision,
  presetTemplate,
} from '../../src/core/presets.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const README = `---
description: The launch, from 1 October.
statuses: [Idea, Draft, Published]
fields:
  Publish date: { type: date, from: [published_at, scheduled_at] }
  Kind: { type: select, from: kind, options: [post, launch] }
labels: directory
---

# The launch
`

test('the presets: agent-pulse and collection, revision 1, each a board once given a number', () => {
  assert.equal(currentPreset('agent-pulse'), 'agent-pulse/1')
  assert.equal(currentPreset('collection'), 'collection/1')
  for (const [ref, name] of [
    ['agent-pulse/1', 'pulse'],
    ['collection/1', 'research'],
  ] as const) {
    const board = parseBoard(name, {
      number: 4,
      ...presetTemplate(ref, { collection: name }),
    })
    assert.ok(board.views.length > 0)
  }
  assert.equal(isPresetRevision('agent-pulse/1'), true)
  assert.equal(isPresetRevision('agent-pulse/2'), false)
  assert.equal(isPresetRevision('kanban/1'), false)
})

test('a collection template: its directory, its label capitalised', () => {
  const t = presetTemplate('collection/1', { collection: 'research' })
  assert.equal(t['title'], 'Research')
  assert.deepEqual(t['collections'], {
    research: { label: 'Research', statuses: 'found' },
  })
  assert.deepEqual(
    (t['views'] as { name: string }[]).map((v) => v.name),
    ['All', 'Research', 'Working']
  )
})

test('Agent Pulse as written for a workspace: its number, its preset, the preset whole', async (t) => {
  const root = await makeWorkspace(t, { org: 'acme' })
  const source = await presetSource('pulse', join(root, '.rness'), 4)
  assert.deepEqual(Object.keys(source).slice(0, 3), [
    'number',
    'preset',
    'title',
  ])
  assert.equal(source['number'], 4)
  assert.equal(source['preset'], 'agent-pulse/1')
  assert.equal(source['collections'], 'all')
})

test("a collection's board takes what its README declares: description, statuses, fields, labels; its README and updates; a Calendar for a date field", async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    files: {
      'marketing/README.md': README,
      'marketing/updates/2026-10-05.md': '---\nhealth: on-track\n---\nGo.\n',
      'marketing/a.md': '---\nstatus: Idea\n---\n# A\n',
    },
  })
  const source = await presetSource('marketing', join(root, '.rness'), 8)
  assert.equal(source['preset'], 'collection/1')
  assert.equal(source['description'], 'The launch, from 1 October.')
  assert.equal(source['readme'], 'marketing/README.md')
  assert.equal(source['updates'], 'marketing/updates')
  assert.deepEqual(source['collections'], {
    marketing: { label: 'Marketing', statuses: ['Idea', 'Draft', 'Published'] },
  })
  assert.deepEqual(Object.keys(source['fields'] as Record<string, unknown>), [
    'Collection',
    'Agent',
    'Working session',
    'Session history',
    'Publish date',
    'Kind',
  ])
  assert.equal(source['labels'], 'directory')
  assert.deepEqual(
    (source['views'] as { name: string }[]).map((v) => v.name),
    ['All', 'Marketing', 'Calendar', 'Working']
  )
  assert.deepEqual((source['views'] as unknown[])[2], {
    name: 'Calendar',
    layout: 'roadmap',
    collection: 'marketing',
    date: 'Publish date',
  })
  parseBoard('marketing', source)
})

test('a collection without README or updates: the preset alone', async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    files: { 'research/a.md': '---\nstatus: Open\n---\n# A\n' },
  })
  const source = await presetSource('research', join(root, '.rness'), 9)
  assert.equal(source['readme'], undefined)
  assert.equal(source['updates'], undefined)
  assert.equal(source['description'], undefined)
  assert.deepEqual(
    (source['views'] as { name: string }[]).map((v) => v.name),
    ['All', 'Research', 'Working']
  )
})

test('a board naming a revision this rness does not have is refused', () => {
  assert.throws(
    () =>
      parseBoard('pulse', {
        number: 4,
        ...presetTemplate('agent-pulse/1', { collection: 'pulse' }),
        preset: 'agent-pulse/9',
      }),
    {
      message:
        '"boards.pulse.preset" names agent-pulse/9, which this rness does not have',
    }
  )
})
