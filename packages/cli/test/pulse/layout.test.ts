import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { StatusTab } from '../../src/core/status.ts'
import { desiredOf, layoutOf, optionColor } from '../../src/pulse/layout.ts'

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

test('layoutOf: unknown statuses in the order found, deduplicated, never ? or null', () => {
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

test('layoutOf: the contract statuses in lifecycle order, then the others in the order found', () => {
  const t: StatusTab[] = [
    {
      name: 'adr',
      label: 'ADR',
      rows: [
        row('2', 'Accepted', 'adr/2.md'),
        row('1', 'Proposed', 'adr/1.md'),
        row('0', 'Superseded', 'adr/0.md'),
      ],
    },
    {
      name: 'specs',
      label: 'Specs',
      rows: [
        row('3', 'Approved', 'specs/3.md'),
        row('4', 'Implemented', 'specs/4.md'),
        row('5', 'Draft', 'specs/5.md'),
      ],
    },
    {
      name: 'plans',
      label: 'Plans',
      rows: [
        row('6', 'Ready', 'plans/6.md'),
        row('7', 'Completed', 'plans/7.md'),
        row('8', 'In progress', 'plans/8.md'),
      ],
    },
    {
      name: 'marketing',
      label: 'Marketing',
      rows: [
        row('a', 'scheduled', 'marketing/a.md'),
        row('b', 'published', 'marketing/b.md'),
        row('c', 'scheduled', 'marketing/c.md'),
      ],
    },
  ]
  assert.deepEqual(layoutOf(t).statuses, [
    'Draft',
    'Proposed',
    'Ready',
    'Approved',
    'In progress',
    'Accepted',
    'Implemented',
    'Completed',
    'Superseded',
    'scheduled',
    'published',
  ])
})

test('optionColor: the contract statuses, a discovered status by its tone, collections and the working marker', () => {
  const status = (n: string) => optionColor('Status', n)
  assert.deepEqual(
    [
      'Draft',
      'Proposed',
      'Ready',
      'Approved',
      'In progress',
      'Blocked',
      'Accepted',
      'Implemented',
      'Completed',
      'Rejected',
      'Superseded',
      'Abandoned',
    ].map(status),
    [
      'gray',
      'blue',
      'blue',
      'purple',
      'yellow',
      'red',
      'green',
      'green',
      'green',
      'gray',
      'gray',
      'gray',
    ]
  )
  assert.equal(status('published'), 'green')
  assert.equal(status('rejected'), 'gray')
  assert.equal(status('scheduled'), 'yellow')
  assert.deepEqual(
    ['ADR', 'Specs', 'Plans', 'Marketing'].map((n) =>
      optionColor('Collection', n)
    ),
    ['purple', 'blue', 'orange', 'pink']
  )
  assert.equal(optionColor('Agent', 'working'), 'green')
})
