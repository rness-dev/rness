import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { StatusTab } from '../../src/core/status.ts'
import type { CollectionShape } from '../../src/pulse/collection.ts'
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

test('layoutOf: the contract statuses, then those found outside them, deduplicated, never ? or null', () => {
  assert.deepEqual(layoutOf(tabs).statuses, [
    'Draft',
    'Proposed',
    'Approved',
    'Accepted',
    'Implemented',
    'Rejected',
    'Superseded',
    'accepted',
    'draft',
  ])
})

test('layoutOf: types are the tab labels, one view per tab', () => {
  const layout = layoutOf(tabs)
  assert.deepEqual(layout.types, ['ADR', 'Specs', 'Marketing'])
  assert.deepEqual(layout.views, [
    { name: 'ADR', type: 'ADR', field: 'ADR status' },
    { name: 'Specs', type: 'Specs', field: 'Specs status' },
    { name: 'Marketing', type: 'Marketing', field: null },
  ])
})

test('desiredOf: title, the first line of its body, status, type', () => {
  const [first, second, , , third] = desiredOf(tabs, 'acme')
  assert.deepEqual(first, {
    path: 'adr/0002-b.md',
    title: '0002 — Title 0002',
    body: '`adr/0002-b.md` · [on GitHub](https://github.com/acme/.rness/blob/main/adr/0002-b.md)',
    status: 'accepted',
    statusField: 'ADR status',
    type: 'ADR',
    sessions: null,
    values: {},
    labels: [],
    unlabels: [],
  })
  assert.equal(second?.status, null, '? is no status')
  assert.equal(third?.status, null)
  assert.equal(third?.type, 'Marketing')
})

test('desiredOf: Session history is each session a document records, its agent first when known, joined; null when none', () => {
  const [one] = desiredOf(
    [
      {
        name: 'plans',
        label: 'Plans',
        rows: [
          {
            id: '0029',
            title: 'P',
            status: 'Completed',
            path: 'plans/0029-p.md',
            sessions: [{ id: 's1', agent: 'Claude Opus 5.5' }, { id: 's2' }],
          },
        ],
      },
    ],
    'acme'
  )
  assert.equal(one?.sessions, 'Claude Opus 5.5 · s1, s2')
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
    'Blocked',
    'Accepted',
    'Implemented',
    'Completed',
    'Rejected',
    'Superseded',
    'Abandoned',
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
      'red',
      'yellow',
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

test('layoutOf: a contract collection has every status of its contract, the others found last; a directory only what it carries', () => {
  const t: StatusTab[] = [
    {
      name: 'plans',
      label: 'Plans',
      rows: [
        row('1', 'In progress', 'plans/1.md'),
        row('2', 'Weird', 'plans/2.md'),
      ],
    },
    { name: 'adr', label: 'ADR', rows: [] },
    {
      name: 'marketing',
      label: 'Marketing',
      rows: [row('a', 'scheduled', 'marketing/a.md')],
    },
    { name: 'notes', label: 'Notes', rows: [row('n', null, 'notes/n.md')] },
  ]
  const layout = layoutOf(t)
  assert.deepEqual(layout.fields, [
    {
      name: 'Plans status',
      statuses: [
        'Draft',
        'Ready',
        'In progress',
        'Blocked',
        'Completed',
        'Abandoned',
        'Weird',
      ],
    },
    {
      name: 'ADR status',
      statuses: ['Proposed', 'Accepted', 'Rejected', 'Superseded'],
    },
    { name: 'Marketing status', statuses: ['scheduled'] },
  ])
  assert.deepEqual(layout.views, [
    { name: 'Plans', type: 'Plans', field: 'Plans status' },
    { name: 'ADR', type: 'ADR', field: 'ADR status' },
    { name: 'Marketing', type: 'Marketing', field: 'Marketing status' },
    { name: 'Notes', type: 'Notes', field: null },
  ])
  assert.deepEqual(layout.statuses, [
    'Draft',
    'Proposed',
    'Ready',
    'In progress',
    'Blocked',
    'Accepted',
    'Completed',
    'Rejected',
    'Superseded',
    'Abandoned',
    'Weird',
    'scheduled',
  ])
  assert.deepEqual(
    desiredOf(t, 'acme').map((d) => d.statusField),
    ['Plans status', 'Plans status', 'Marketing status', null]
  )
})

test('layoutOf: a directory named like an Object.prototype member is a discovered one', () => {
  const t: StatusTab[] = [
    {
      name: 'constructor',
      label: 'Constructor',
      rows: [row('a', 'open', 'constructor/a.md')],
    },
    { name: 'toString', label: 'ToString', rows: [] },
  ]
  const layout = layoutOf(t)
  assert.deepEqual(layout.fields, [
    { name: 'Constructor status', statuses: ['open'] },
  ])
  assert.deepEqual(layout.statuses, ['open'])
  assert.deepEqual(
    layout.views.map((v) => v.field),
    ['Constructor status', null]
  )
})

// --- a collection's own project (spec 0025 §4) ----------------------------------

const marketing: StatusTab = {
  name: 'marketing',
  label: 'Marketing',
  rows: [
    row('2026-09-30', 'Draft', 'marketing/linkedin/2026-09-30-first-post.md'),
    row('2026-09-30', 'Idea', 'marketing/hn/2026-09-30-show-hn.md'),
    row('2026-09-30', 'Paused', 'marketing/2026-09-30-loose.md'),
  ],
}
const shape: CollectionShape = {
  readme: '# The launch\n',
  description: 'The launch.',
  statuses: ['Idea', 'Draft', 'Ready', 'Published'],
  fields: [
    {
      name: 'Publish date',
      type: 'date',
      from: ['published_at', 'scheduled_at'],
      options: [],
    },
    {
      name: 'Kind',
      type: 'select',
      from: ['kind'],
      options: ['post', 'action'],
    },
  ],
  labels: { kind: 'directory' },
}
const fronts = new Map<string, Record<string, unknown>>([
  [
    'marketing/linkedin/2026-09-30-first-post.md',
    { status: 'Draft', kind: 'post', scheduled_at: '2026-10-01T08:30+02:00' },
  ],
  ['marketing/hn/2026-09-30-show-hn.md', { status: 'Idea', kind: 'launch' }],
  ['marketing/2026-09-30-loose.md', { status: 'Paused' }],
])

test('layoutOf, own project: the declared statuses in order, each there, then those found; no second status field; a board by Status', () => {
  const want = desiredOf([marketing], 'acme', { shape, fronts })
  const layout = layoutOf([marketing], { shape, want })
  assert.deepEqual(layout.statuses, [
    'Idea',
    'Draft',
    'Ready',
    'Published',
    'Paused',
  ])
  assert.deepEqual(layout.fields, [])
  assert.deepEqual(layout.views, [
    { name: 'Marketing', type: 'Marketing', field: null },
  ])
})

test('layoutOf, own project: the declared fields, a select with its options then the values found', () => {
  const want = desiredOf([marketing], 'acme', { shape, fronts })
  assert.deepEqual(layoutOf([marketing], { shape, want }).declared, [
    { name: 'Publish date', type: 'date', options: [] },
    { name: 'Kind', type: 'select', options: ['post', 'action', 'launch'] },
  ])
})

test('layoutOf, Agent Pulse: nothing declared, whatever a collection says', () => {
  assert.deepEqual(layoutOf(tabs).declared, [])
  assert.deepEqual(layoutOf(tabs).labels, [])
})

test("desiredOf, own project: no second status field; the declared values; the labels, and the collection's others to take off", () => {
  const [post, hn, loose] = desiredOf([marketing], 'acme', { shape, fronts })
  assert.equal(post?.statusField, null)
  assert.deepEqual(post?.values, { 'Publish date': '2026-10-01', Kind: 'post' })
  assert.deepEqual(post?.labels, ['linkedin'])
  assert.deepEqual(post?.unlabels, ['hn'])
  assert.deepEqual(hn?.values, { 'Publish date': null, Kind: 'launch' })
  assert.deepEqual(hn?.labels, ['hn'])
  assert.deepEqual(hn?.unlabels, ['linkedin'])
  assert.deepEqual(loose?.labels, [])
  assert.deepEqual(loose?.unlabels, ['linkedin', 'hn'])
  const want = desiredOf([marketing], 'acme', { shape, fronts })
  assert.deepEqual(layoutOf([marketing], { shape, want }).labels, [
    'linkedin',
    'hn',
  ])
})

test('desiredOf, own project: a subdirectory with no document left still has its label taken off', () => {
  const [post] = desiredOf([marketing], 'acme', {
    shape,
    fronts,
    directories: ['linkedin', 'hn', 'reddit'],
  })
  assert.deepEqual(post?.unlabels, ['hn', 'reddit'])
})
