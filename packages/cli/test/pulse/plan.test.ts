import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Desired } from '../../src/pulse/layout.ts'
import { type BoardItem, planSync } from '../../src/pulse/plan.ts'

const want = (path: string, over: Partial<Desired> = {}): Desired => ({
  path,
  title: `T ${path}`,
  body: path,
  status: 'draft',
  type: 'Specs',
  ...over,
})
const have = (
  id: string,
  path: string | null,
  over: Partial<BoardItem> = {}
): BoardItem => ({
  id,
  path,
  title: path === null ? 'by hand' : `T ${path}`,
  status: 'draft',
  type: 'Specs',
  agent: null,
  session: null,
  ...over,
})

test('a missing path is created', () => {
  const w = want('a.md')
  assert.deepEqual(planSync([w], []), [{ kind: 'create', want: w }])
})

test('same path and fields: unchanged', () => {
  assert.deepEqual(planSync([want('a.md')], [have('i1', 'a.md')]), [
    { kind: 'unchanged', id: 'i1' },
  ])
})

test('another title, status or type: update', () => {
  for (const over of [
    { title: 'new' },
    { status: 'done' },
    { type: 'ADR' },
    { status: null },
  ]) {
    const w = want('a.md', over)
    assert.deepEqual(planSync([w], [have('i1', 'a.md')]), [
      { kind: 'update', id: 'i1', want: w },
    ])
  }
})

test('an item moved by hand to another status goes back: update', () => {
  const w = want('a.md')
  assert.deepEqual(planSync([w], [have('i1', 'a.md', { status: 'done' })]), [
    { kind: 'update', id: 'i1', want: w },
  ])
})

test('an item whose document is gone is archived', () => {
  assert.deepEqual(planSync([], [have('i1', 'gone.md')]), [
    { kind: 'archive', id: 'i1' },
  ])
})

test('an item without a path (made by hand) is left alone', () => {
  assert.deepEqual(planSync([], [have('i1', null)]), [])
})

test('a renamed document is one create and one archive', () => {
  const w = want('new.md')
  assert.deepEqual(planSync([w], [have('i1', 'old.md')]), [
    { kind: 'create', want: w },
    { kind: 'archive', id: 'i1' },
  ])
})

test('a second item on the same path is archived', () => {
  assert.deepEqual(
    planSync([want('a.md')], [have('i1', 'a.md'), have('i2', 'a.md')]),
    [
      { kind: 'unchanged', id: 'i1' },
      { kind: 'archive', id: 'i2' },
    ]
  )
})
