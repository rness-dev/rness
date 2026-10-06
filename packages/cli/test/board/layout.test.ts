import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  collectionsOf,
  desiredOf,
  layoutOf,
  optionColor,
} from '../../src/board/layout.ts'
import { parseBoard } from '../../src/core/board-declaration.ts'
import { presetTemplate } from '../../src/core/presets.ts'
import type { StatusTab } from '../../src/core/status.ts'

const row = (id: string, status: string | null, path: string) => ({
  id,
  title: `Title ${id}`,
  status,
  path,
})
/** As `rness status` gives them: ADR, Specs and Plans always, then what it finds. */
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
  { name: 'plans', label: 'Plans', rows: [] },
  {
    name: 'marketing',
    label: 'Marketing',
    rows: [row('2026-10-02', 'scheduled', 'marketing/2026-10-02-post.md')],
  },
]

/** Agent Pulse as rness ships it (`agent-pulse/1`). */
const PULSE = parseBoard('pulse', {
  number: 4,
  ...presetTemplate('agent-pulse/1', { collection: 'pulse' }),
})
const pulse = (t: readonly StatusTab[]) => {
  const collections = collectionsOf(PULSE, t)
  const want = desiredOf(PULSE, collections, 'acme')
  return { collections, want, layout: layoutOf(PULSE, collections, want) }
}

test('Agent Pulse: Status takes the contract statuses in lifecycle order, then those found outside them, never ? or null', () => {
  assert.deepEqual(pulse(tabs).layout.statuses, [
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
    'accepted',
    'draft',
    'scheduled',
  ])
})

test('Agent Pulse: Collection takes the tab labels; one status field per collection; its views, a discovered collection after the declared ones', () => {
  const { layout } = pulse(tabs)
  assert.deepEqual(
    layout.fields.map((f) => [
      f.name,
      f.type === 'select' ? f.options : f.type,
    ]),
    [
      ['Collection', ['ADR', 'Specs', 'Plans', 'Marketing']],
      [
        'ADR status',
        ['Proposed', 'Accepted', 'Rejected', 'Superseded', 'accepted'],
      ],
      [
        'Specs status',
        [
          'Draft',
          'Proposed',
          'Approved',
          'Implemented',
          'Rejected',
          'Superseded',
          'accepted',
          'draft',
        ],
      ],
      [
        'Plans status',
        ['Draft', 'Ready', 'In progress', 'Blocked', 'Completed', 'Abandoned'],
      ],
      ['Marketing status', ['scheduled']],
      ['Agent', ['working']],
      ['Working session', 'text'],
      ['Session history', 'text'],
    ]
  )
  assert.deepEqual(layout.views, [
    {
      name: 'All',
      layout: 'table',
      filter: null,
      columns: null,
      fields: ['Title', 'Collection', 'Status', 'Working session'],
    },
    {
      name: 'ADR',
      layout: 'board',
      filter: 'collection:"ADR"',
      columns: 'ADR status',
      fields: null,
    },
    {
      name: 'Specs',
      layout: 'board',
      filter: 'collection:"Specs"',
      columns: 'Specs status',
      fields: null,
    },
    {
      name: 'Plans',
      layout: 'board',
      filter: 'collection:"Plans"',
      columns: 'Plans status',
      fields: null,
    },
    {
      name: 'Marketing',
      layout: 'board',
      filter: 'collection:"Marketing"',
      columns: 'Marketing status',
      fields: null,
    },
    {
      name: 'Working',
      layout: 'table',
      filter: 'agent:working',
      columns: null,
      fields: ['Title', 'Collection', 'Status', 'Working session'],
    },
  ])
  assert.deepEqual(layout.labels, [])
})

test('Agent Pulse: a collection another board holds is left out, its view too', () => {
  const collections = collectionsOf(PULSE, tabs, (c) => c === 'marketing')
  const layout = layoutOf(PULSE, collections, [])
  assert.deepEqual(
    collections.map((c) => c.name),
    ['adr', 'specs', 'plans']
  )
  assert.equal(
    layout.views.some((v) => v.name === 'Marketing'),
    false
  )
})

test('desiredOf: title, the first line of its body, status, its collection and history; ? is no status', () => {
  const [first, second] = pulse(tabs).want
  assert.deepEqual(first, {
    path: 'adr/0002-b.md',
    title: '0002 — Title 0002',
    body: '`adr/0002-b.md` · [on GitHub](https://github.com/acme/.rness/blob/main/adr/0002-b.md)',
    status: 'accepted',
    statusField: 'ADR status',
    values: { Collection: 'ADR', 'Session history': null },
    labels: [],
    unlabels: [],
  })
  assert.equal(second?.status, null, '? is no status')
})

test('desiredOf: Session history is each session a document records, its agent first when known, joined', () => {
  const [one] = pulse([
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
  ]).want
  assert.equal(one?.values['Session history'], 'Claude Opus 5.5 · s1, s2')
})

test('optionColor: as declared, else a status by its tone, a collection pink, a declared option its own', () => {
  const colors = PULSE.colors
  const status = (n: string) => optionColor(colors, 'status', n)
  assert.deepEqual(
    ['Draft', 'Approved', 'In progress', 'Blocked', 'Completed'].map(status),
    ['gray', 'purple', 'yellow', 'red', 'green']
  )
  assert.equal(status('published'), 'green')
  assert.equal(status('rejected'), 'gray')
  assert.equal(status('scheduled'), 'yellow')
  assert.deepEqual(
    ['ADR', 'Specs', 'Plans', 'Marketing'].map((n) =>
      optionColor(colors, 'collection', n)
    ),
    ['purple', 'blue', 'orange', 'pink']
  )
  assert.equal(optionColor(colors, 'declared', 'working'), 'green')
  assert.equal(optionColor(colors, 'declared', 'post'), null)
})

test('a directory whose documents carry no status: no status field, its board by Status', () => {
  const t: StatusTab[] = [
    ...tabs.slice(0, 3),
    { name: 'notes', label: 'Notes', rows: [row('n', null, 'notes/n.md')] },
  ]
  const { layout, want } = pulse(t)
  assert.equal(
    layout.fields.some((f) => f.name === 'Notes status'),
    false
  )
  assert.equal(layout.views.find((v) => v.name === 'Notes')?.columns, 'Status')
  assert.equal(want.at(-1)?.statusField, null)
})

test('a directory named like an Object.prototype member is a discovered one', () => {
  const { layout } = pulse([
    ...tabs.slice(0, 3),
    {
      name: 'constructor',
      label: 'Constructor',
      rows: [row('a', 'open', 'constructor/a.md')],
    },
  ])
  assert.ok(layout.fields.some((f) => f.name === 'Constructor status'))
  assert.ok(layout.views.some((v) => v.name === 'Constructor'))
})

// --- a collection's own board (spec 0025 §4, declared as spec 0031 §2.2) ------

const marketing: StatusTab = {
  name: 'marketing',
  label: 'Marketing',
  rows: [
    row('2026-09-30', 'Draft', 'marketing/linkedin/2026-09-30-first-post.md'),
    row('2026-09-30', 'Idea', 'marketing/hn/2026-09-30-show-hn.md'),
    row('2026-09-30', 'Paused', 'marketing/2026-09-30-loose.md'),
  ],
}
const TEMPLATE = presetTemplate('collection/1', { collection: 'marketing' })
const MARKETING = parseBoard('marketing', {
  number: 8,
  ...TEMPLATE,
  collections: {
    marketing: { statuses: ['Idea', 'Draft', 'Ready', 'Published'] },
  },
  fields: {
    ...(TEMPLATE['fields'] as Record<string, unknown>),
    'Publish date': { type: 'date', from: ['published_at', 'scheduled_at'] },
    Kind: { type: 'select', from: 'kind', options: ['post', 'action'] },
  },
  labels: 'directory',
})
const fronts = new Map<string, Record<string, unknown>>([
  [
    'marketing/linkedin/2026-09-30-first-post.md',
    { status: 'Draft', kind: 'post', scheduled_at: '2026-10-01T08:30+02:00' },
  ],
  ['marketing/hn/2026-09-30-show-hn.md', { status: 'Idea', kind: 'launch' }],
  ['marketing/2026-09-30-loose.md', { status: 'Paused' }],
])
const own = (directories: string[] = ['linkedin', 'hn']) => {
  const collections = collectionsOf(MARKETING, [marketing])
  const want = desiredOf(
    MARKETING,
    collections,
    'acme',
    fronts,
    new Map([['marketing', directories]])
  )
  return { want, layout: layoutOf(MARKETING, collections, want) }
}

test('own board: the declared statuses in order, each there, then those found; no second status field; a board by Status', () => {
  const { layout } = own()
  assert.deepEqual(layout.statuses, [
    'Idea',
    'Draft',
    'Ready',
    'Published',
    'Paused',
  ])
  assert.deepEqual(
    layout.views.map((v) => [v.name, v.columns]),
    [
      ['All', null],
      ['Marketing', 'Status'],
      ['Working', null],
    ]
  )
})

test('own board: the declared fields, a select with its options then the values found', () => {
  assert.deepEqual(
    own().layout.fields.map((f) => [
      f.name,
      f.type === 'select' ? f.options : f.type,
    ]),
    [
      ['Collection', ['Marketing']],
      ['Agent', ['working']],
      ['Working session', 'text'],
      ['Session history', 'text'],
      ['Publish date', 'date'],
      ['Kind', ['post', 'action', 'launch']],
    ]
  )
})

test("desiredOf, own board: no second status field; the declared values; the labels, and the collection's others to take off", () => {
  const { want, layout } = own()
  const [post, hn, loose] = want
  assert.equal(post?.statusField, null)
  assert.deepEqual(post?.values, {
    Collection: 'Marketing',
    'Session history': null,
    'Publish date': '2026-10-01',
    Kind: 'post',
  })
  assert.deepEqual(post?.labels, ['linkedin'])
  assert.deepEqual(post?.unlabels, ['hn'])
  assert.deepEqual(hn?.values, {
    Collection: 'Marketing',
    'Session history': null,
    'Publish date': null,
    Kind: 'launch',
  })
  assert.deepEqual(hn?.unlabels, ['linkedin'])
  assert.deepEqual(loose?.labels, [])
  assert.deepEqual(loose?.unlabels, ['linkedin', 'hn'])
  assert.deepEqual(layout.labels, ['linkedin', 'hn'])
})

test('desiredOf, own board: a subdirectory with no document left still has its label taken off', () => {
  const [post] = own(['linkedin', 'hn', 'reddit']).want
  assert.deepEqual(post?.unlabels, ['hn', 'reddit'])
})

test('a field may take the first of several sources: $status, then a front-matter key', () => {
  const board = parseBoard('marketing', {
    number: 8,
    collections: { marketing: { statuses: 'found' } },
    fields: { Phase: { type: 'text', from: ['phase', '$status'] } },
    views: [{ name: 'Board', layout: 'board' }],
  })
  const collections = collectionsOf(board, [marketing])
  const [post, hn] = desiredOf(
    board,
    collections,
    'acme',
    new Map([['marketing/hn/2026-09-30-show-hn.md', { phase: 'Scouting' }]])
  )
  assert.equal(post?.values['Phase'], 'Draft')
  assert.equal(hn?.values['Phase'], 'Scouting')
})
