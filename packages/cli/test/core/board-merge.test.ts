import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergeBoard } from '../../src/core/board-merge.ts'

/** A preset's revision as a board holds it: a few keys of each kind. */
const REVISION_1 = {
  title: 'Agent Pulse',
  colors: { Blocked: 'red', Draft: 'gray' },
  fields: { Agent: { type: 'select', from: '$agent', options: ['working'] } },
  views: [
    { name: 'All', layout: 'table', fields: ['Title', 'Status'] },
    { name: 'Working', layout: 'table', filter: 'agent:working' },
  ],
}
const merge = (
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>
) => mergeBoard('pulse', REVISION_1, ours, theirs, 'agent-pulse/2')

test('a value the team never changed takes the new revision; one it changed is kept', () => {
  const { board, kept } = merge(
    { ...REVISION_1, colors: { Blocked: 'red', Draft: 'blue' } },
    { ...REVISION_1, colors: { Blocked: 'purple', Draft: 'yellow' } }
  )
  assert.deepEqual(board['colors'], { Blocked: 'purple', Draft: 'blue' })
  assert.deepEqual(kept, [
    'projects.pulse.colors.Draft: kept blue, agent-pulse/2 gives yellow',
  ])
})

test('both changed alike: no conflict; the revision unchanged: the team keeps its own, unsaid', () => {
  const { board, kept } = merge(
    { ...REVISION_1, title: 'Pulse' },
    { ...REVISION_1, title: 'Pulse' }
  )
  assert.equal(board['title'], 'Pulse')
  assert.deepEqual(kept, [])
  const again = merge({ ...REVISION_1, title: 'Ours' }, REVISION_1)
  assert.equal(again.board['title'], 'Ours')
  assert.deepEqual(again.kept, [])
})

test('a key the revision adds is added; one it removes goes when the team never touched it, stays when it did', () => {
  const { board } = merge(
    { ...REVISION_1, colors: { Blocked: 'red', Draft: 'gray' } },
    { ...REVISION_1, colors: { Blocked: 'red' }, description: 'The board.' }
  )
  assert.deepEqual(board['colors'], { Blocked: 'red' })
  assert.equal(board['description'], 'The board.')
  const kept = merge(
    { ...REVISION_1, colors: { Blocked: 'red', Draft: 'blue' } },
    { ...REVISION_1, colors: { Blocked: 'red' } }
  )
  assert.deepEqual(kept.board['colors'], { Blocked: 'red', Draft: 'blue' })
  assert.deepEqual(kept.kept, [
    'projects.pulse.colors.Draft: kept blue, agent-pulse/2 removes it',
  ])
})

test("views merge by name: one added is added, one removed goes when untouched, the team's edits and its own views kept", () => {
  const ours = {
    ...REVISION_1,
    views: [
      { name: 'All', layout: 'table', fields: ['Title', 'Status', 'Owner'] },
      { name: 'Working', layout: 'table', filter: 'agent:working' },
      { name: 'Ours', layout: 'board' },
    ],
  }
  const theirs = {
    ...REVISION_1,
    views: [
      { name: 'All', layout: 'table', fields: ['Title', 'Status', 'Labels'] },
      { name: 'Calendar', layout: 'roadmap', date: 'Due' },
    ],
  }
  const { board, kept } = merge(ours, theirs)
  assert.deepEqual(board['views'], [
    { name: 'All', layout: 'table', fields: ['Title', 'Status', 'Owner'] },
    { name: 'Ours', layout: 'board' },
    { name: 'Calendar', layout: 'roadmap', date: 'Due' },
  ])
  assert.deepEqual(kept, [
    'projects.pulse.views.All.fields: kept ["Title","Status","Owner"], agent-pulse/2 gives ["Title","Status","Labels"]',
  ])
})

test('a list is one value: replaced when it equals the base, kept otherwise', () => {
  const theirs = {
    ...REVISION_1,
    fields: {
      Agent: { type: 'select', from: '$agent', options: ['working', 'idle'] },
    },
  }
  assert.deepEqual(merge(REVISION_1, theirs).board['fields'], theirs.fields)
  const ours = {
    ...REVISION_1,
    fields: {
      Agent: { type: 'select', from: '$agent', options: ['working', 'busy'] },
    },
  }
  assert.deepEqual(merge(ours, theirs).board['fields'], ours.fields)
})

test('the board keeps its number and records the new revision', () => {
  const { board } = merge(
    { number: 4, preset: 'agent-pulse/1', ...REVISION_1 },
    REVISION_1
  )
  assert.equal(board['number'], 4)
  assert.equal(board['preset'], 'agent-pulse/2')
})
