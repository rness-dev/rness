import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { StatusTab } from '../../src/core/status.ts'
import { desiredOf, layoutOf } from '../../src/pulse/layout.ts'

const row = (id: string, status: string | null, path: string) => ({
  id,
  title: `Title ${id}`,
  status,
  path,
})
const tabs: StatusTab[] = [
  {
    name: 'adr',
    label: 'ADR',
    rows: [
      row('0002', 'accepted', 'adr/0002-b.md'),
      row('0001', '?', 'adr/0001-a.md'),
    ],
  },
  {
    name: 'specs',
    label: 'Specs',
    rows: [
      row('0017', 'accepted', 'specs/0017-x.md'),
      row('0016', 'draft', 'specs/0016-y.md'),
    ],
  },
  {
    name: 'marketing',
    label: 'Marketing',
    rows: [row('2026-10-02', null, 'marketing/2026-10-02-post.md')],
  },
]

test('layoutOf: statuses in tab order, deduplicated, never ? or null', () => {
  assert.deepEqual(layoutOf(tabs).statuses, ['accepted', 'draft'])
})

test('layoutOf: types are the tab labels, one view per tab', () => {
  const layout = layoutOf(tabs)
  assert.deepEqual(layout.types, ['ADR', 'Specs', 'Marketing'])
  assert.deepEqual(layout.views, [
    { name: 'ADR', type: 'ADR' },
    { name: 'Specs', type: 'Specs' },
    { name: 'Marketing', type: 'Marketing' },
  ])
})

test('desiredOf: title, body with path and link, status, type', () => {
  const [first, second, , , third] = desiredOf(tabs, 'acme')
  assert.deepEqual(first, {
    path: 'adr/0002-b.md',
    title: '0002 — Title 0002',
    body: 'adr/0002-b.md\n\nhttps://github.com/acme/.rness/blob/main/adr/0002-b.md',
    status: 'accepted',
    type: 'ADR',
  })
  assert.equal(second?.status, null, '? is no status')
  assert.equal(third?.status, null)
  assert.equal(third?.type, 'Marketing')
})
