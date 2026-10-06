import assert from 'node:assert/strict'
import { test } from 'node:test'

import { issueBody } from '../../src/pulse/body.ts'
import type { Desired } from '../../src/pulse/layout.ts'
import {
  type BoardItem,
  type ItemIssue,
  issuedAfter,
  planBodies,
  planSync,
  stillOpened,
  unwantedPaths,
} from '../../src/pulse/plan.ts'

const want = (path: string, over: Partial<Desired> = {}): Desired => ({
  path,
  title: `T ${path}`,
  body: path,
  status: 'draft',
  statusField: null,
  values: { Collection: 'Specs' },
  labels: [],
  unlabels: [],
  ...over,
})
const open = (number: number, over: Partial<ItemIssue> = {}): ItemIssue => ({
  number,
  open: true,
  labelled: true,
  body: '',
  labels: ['rness'],
  ...over,
})
/** rness's item: an open, labelled issue numbered after its id (`i5` → #5); `issue: null` is a 0.12.0 draft. */
const have = (
  id: string,
  path: string | null,
  over: Partial<BoardItem> = {}
): BoardItem => ({
  id,
  path,
  issue: open(Number(id.replace(/\D/g, '')) || 1),
  title: path === null ? 'by hand' : `T ${path}`,
  status: 'draft',
  collectionStatus: null,
  type: 'Specs',
  agent: null,
  session: null,
  sessions: null,
  values: { Collection: 'Specs' },
  ...over,
})

test('a document without an item gets one: create', () => {
  const w = want('a.md')
  assert.deepEqual(planSync([w], []), [{ kind: 'create', want: w }])
})

test('an open, labelled issue whose fields match: unchanged', () => {
  assert.deepEqual(planSync([want('a.md')], [have('i1', 'a.md')]), [
    { kind: 'unchanged', id: 'i1' },
  ])
})

test('another title, status or collection, or a card moved by hand: update', () => {
  for (const over of [
    { title: 'new' },
    { status: 'done' },
    { values: { Collection: 'ADR' } },
    { status: null },
  ]) {
    const w = want('a.md', over)
    assert.deepEqual(planSync([w], [have('i1', 'a.md')]), [
      { kind: 'update', id: 'i1', want: w, reopen: false },
    ])
  }
  const w = want('a.md')
  assert.deepEqual(planSync([w], [have('i1', 'a.md', { status: 'done' })]), [
    { kind: 'update', id: 'i1', want: w, reopen: false },
  ])
})

test('an issue closed while its document exists is reopened; one that lost its label gets it back', () => {
  const w = want('a.md')
  assert.deepEqual(
    planSync([w], [have('i1', 'a.md', { issue: open(1, { open: false }) })]),
    [{ kind: 'update', id: 'i1', want: w, reopen: true }]
  )
  assert.deepEqual(
    planSync(
      [w],
      [have('i1', 'a.md', { issue: open(1, { labelled: false }) })]
    ),
    [{ kind: 'update', id: 'i1', want: w, reopen: false }]
  )
})

test('a draft of 0.12.0 with its path is converted, whatever its fields', () => {
  const w = want('a.md')
  assert.deepEqual(planSync([w], [have('i1', 'a.md', { issue: null })]), [
    { kind: 'convert', id: 'i1', want: w },
  ])
})

test("a document gone — in this clone's git, no longer in its tree: its issue closed, a draft of it archived", () => {
  assert.deepEqual(
    planSync(
      [],
      [have('i1', 'gone.md'), have('d2', 'old.md', { issue: null })],
      new Set(['gone.md', 'old.md'])
    ),
    [
      { kind: 'close', id: 'i1' },
      { kind: 'archive', id: 'd2' },
    ]
  )
})

test("a path this clone's git has never seen is not judged: its item unchanged, issue or draft", () => {
  const items = [
    have('i1', 'theirs.md'),
    have('d2', 'draft.md', { issue: null }),
    have('i3', 'gone.md'),
  ]
  assert.deepEqual(planSync([], items, new Set(['gone.md'])), [
    { kind: 'unchanged', id: 'i1' },
    { kind: 'unchanged', id: 'd2' },
    { kind: 'close', id: 'i3' },
  ])
  assert.deepEqual(
    planSync([], items),
    [
      { kind: 'unchanged', id: 'i1' },
      { kind: 'unchanged', id: 'd2' },
      { kind: 'unchanged', id: 'i3' },
    ],
    'told nothing, it closes nothing'
  )
})

test("a path git never saw is gone only on an issue this clone recorded opening, with that path; another clone's, another path's, or a draft is left — one git saw is gone whatever the record", () => {
  const items = [
    have('i1', 'renamed.md'),
    have('i2', 'theirs.md'),
    have('i3', 'moved.md'),
    have('d4', 'draft.md', { issue: null }),
    have('i5', 'gone.md'),
  ]
  const opened = new Map([
    [1, 'renamed.md'],
    [3, 'elsewhere.md'],
  ])
  assert.deepEqual(planSync([], items, new Set(['gone.md']), opened), [
    { kind: 'close', id: 'i1' },
    { kind: 'unchanged', id: 'i2' },
    { kind: 'unchanged', id: 'i3' },
    { kind: 'unchanged', id: 'd4' },
    { kind: 'close', id: 'i5' },
  ])
})

test('the record after a sync: each issue created added; forgotten, one whose path git has seen, one this sync closed, one no longer on the board', () => {
  const listed = [
    have('i1', 'kept.md'),
    have('i2', 'committed.md'),
    have('i3', 'closed.md'),
  ]
  const opened = new Map([
    [1, 'kept.md'],
    [2, 'committed.md'],
    [3, 'closed.md'],
    [4, 'archived-by-hand.md'],
  ])
  assert.deepEqual(
    [
      ...stillOpened(
        opened,
        listed,
        new Set(['committed.md']),
        new Set(['i3']),
        new Map([['new.md', { id: 'i7', number: 7 }]])
      ),
    ],
    [
      [1, 'kept.md'],
      [7, 'new.md'],
    ]
  )
})

test('the paths git is asked about: on the board, not wanted — once each; not a wanted one, nor an item without a path', () => {
  assert.deepEqual(
    unwantedPaths(
      [want('a.md')],
      [
        have('i1', 'a.md'),
        have('i2', 'b.md'),
        have('i3', 'b.md'),
        have('d4', 'c.md', { issue: null }),
        have('i5', null),
      ]
    ),
    ['b.md', 'c.md']
  )
})

test("an item without a path is the team's: left alone, and its document gets its own issue", () => {
  assert.deepEqual(planSync([], [have('i1', null)]), [])
  assert.deepEqual(
    planSync([want('a.md')], [have('i1', null, { title: 'T a.md' })]),
    [{ kind: 'create', want: want('a.md') }]
  )
})

test('a renamed document: a new issue, the old one closed', () => {
  const w = want('new.md')
  assert.deepEqual(planSync([w], [have('i1', 'old.md')], new Set(['old.md'])), [
    { kind: 'create', want: w },
    { kind: 'close', id: 'i1' },
  ])
})

test('several items on one path: an open issue before a closed one, the lowest number first, a draft last; the others closed or archived', () => {
  const items = [
    have('d1', 'a.md', { issue: null }),
    have('i7', 'a.md', { issue: open(7, { open: false }) }),
    have('i5', 'a.md'),
    have('i3', 'a.md', { issue: open(3, { open: false }) }),
    have('i9', 'a.md'),
  ]
  assert.deepEqual(planSync([want('a.md')], items), [
    { kind: 'unchanged', id: 'i5' },
    { kind: 'close', id: 'i9' },
    { kind: 'close', id: 'i3' },
    { kind: 'close', id: 'i7' },
    { kind: 'archive', id: 'd1' },
  ])
})

test('a draft a 0.12.0 CLI made on a migrated board: archived, the issue kept', () => {
  assert.deepEqual(
    planSync(
      [want('a.md')],
      [have('i4', 'a.md'), have('d1', 'a.md', { issue: null })]
    ),
    [
      { kind: 'unchanged', id: 'i4' },
      { kind: 'archive', id: 'd1' },
    ]
  )
})

test('Session history is compared: a document that records a new session updates its item', () => {
  const values = (sessions: string) => ({
    Collection: 'Specs',
    'Session history': sessions,
  })
  const w = want('a.md', { values: values('s1, s2') })
  assert.deepEqual(
    planSync([w], [have('i1', 'a.md', { values: values('s1') })]),
    [{ kind: 'update', id: 'i1', want: w, reopen: false }]
  )
  assert.deepEqual(
    planSync([w], [have('i1', 'a.md', { values: values('s1, s2') })]),
    [{ kind: 'unchanged', id: 'i1' }]
  )
})

test("a collection's own status field is compared when the collection has one", () => {
  const w = want('a.md', { statusField: 'Specs status' })
  assert.deepEqual(planSync([w], [have('i1', 'a.md')]), [
    { kind: 'update', id: 'i1', want: w, reopen: false },
  ])
  assert.deepEqual(
    planSync(
      [w],
      [
        have('i1', 'a.md', {
          values: { Collection: 'Specs', 'Specs status': 'draft' },
        }),
      ]
    ),
    [{ kind: 'unchanged', id: 'i1' }]
  )
})

/** An issue of .rness on the board without Path: open and labelled unless said otherwise. */
const stray = (id: string, over: Partial<ItemIssue>): BoardItem =>
  have(id, null, { issue: open(Number(id.replace(/\D/g, '')), over) })

test("an issue a sync left without Path — labelled, its body's first line a wanted document's — is adopted: an update writes its Path", () => {
  const w = want('a.md')
  assert.deepEqual(
    planSync([w], [{ ...stray('i4', { body: 'a.md' }), title: 'T a.md' }]),
    [{ kind: 'update', id: 'i4', want: w, reopen: false }],
    'its fields match: its Path alone is missing'
  )
  assert.deepEqual(
    planSync([w], [stray('i4', { body: 'a.md\r\n\r\nText.', open: false })]),
    [{ kind: 'update', id: 'i4', want: w, reopen: true }]
  )
})

test("an issue without Path stays the team's: unlabelled, another first line, a document not wanted, or a document that has its item", () => {
  const w = want('a.md')
  for (const item of [
    stray('i4', { body: 'a.md', labelled: false }),
    stray('i4', { body: 'See a.md' }),
    stray('i4', { body: 'a.mdx\n\nText.' }),
    stray('i4', { body: 'b.md' }),
  ])
    assert.deepEqual(planSync([w], [item]), [{ kind: 'create', want: w }])
  assert.deepEqual(planSync([], [stray('i4', { body: 'a.md' })]), [])
  assert.deepEqual(
    planSync([w], [have('i1', 'a.md'), stray('i4', { body: 'a.md' })]),
    [{ kind: 'unchanged', id: 'i1' }],
    'adopted instead of a second issue only'
  )
})

test('several such issues for one document: the best adopted (open, then the lowest number), the others left alone', () => {
  const w = want('a.md')
  assert.deepEqual(
    planSync(
      [w],
      [
        stray('i3', { body: 'a.md', open: false }),
        stray('i7', { body: 'a.md' }),
        stray('i5', { body: 'a.md' }),
      ]
    ),
    [{ kind: 'update', id: 'i5', want: w, reopen: false }]
  )
})

test("after pass 1, an adopted issue is its document's", () => {
  const listed = [stray('i4', { body: 'a.md' })]
  const steps = planSync([want('a.md')], listed)
  assert.deepEqual(
    [...issuedAfter(steps, listed, new Map())],
    [['a.md', { id: 'i4', number: 4, body: 'a.md' }]]
  )
})

test("after pass 1, each document's issue: as listed, or as pass 1 placed it", () => {
  const listed = [
    have('i1', 'a.md', { issue: open(1, { body: 'A' }) }),
    have('d2', 'b.md', { issue: null }),
    have('i9', 'gone.md'),
  ]
  const steps = planSync(
    [want('a.md'), want('b.md'), want('c.md')],
    listed,
    new Set(['gone.md'])
  )
  const issued = issuedAfter(
    steps,
    listed,
    new Map([
      ['b.md', { id: 'd2', number: 2 }],
      ['c.md', { id: 'i3', number: 3 }],
    ])
  )
  assert.deepEqual(
    [...issued],
    [
      ['a.md', { id: 'i1', number: 1, body: 'A' }],
      ['b.md', { id: 'd2', number: 2, body: null }],
      ['c.md', { id: 'i3', number: 3, body: null }],
    ]
  )
})

const bodyOf = (text: string): string =>
  issueBody({
    path: 'a.md',
    text,
    org: 'acme',
    numbers: new Map(),
    files: new Set(),
  })

test("pass 2: a body is written when the issue's does not carry its digest", () => {
  const now = bodyOf('# A\n\nText.\n')
  const issued = (body: string | null) =>
    new Map([['a.md', { id: 'i1', number: 1, body }]])
  const bodies = new Map([['a.md', now]])
  const write = [{ kind: 'body', id: 'i1', body: now }]
  assert.deepEqual(planBodies(bodies, issued(now)), [], 'the same: nothing')
  assert.deepEqual(
    planBodies(bodies, issued(null)),
    write,
    'created or converted in pass 1'
  )
  assert.deepEqual(
    planBodies(bodies, issued(bodyOf('# A\n\nOld.\n'))),
    write,
    'the document changed'
  )
  assert.deepEqual(
    planBodies(bodies, issued(now.replace('Text.', 'Edited.'))),
    write,
    'edited by hand, its digest line kept'
  )
  assert.deepEqual(
    planBodies(bodies, issued('a.md\n\nhttps://…')),
    write,
    "0.12.0's body, no digest"
  )
  assert.deepEqual(
    planBodies(new Map([['x.md', now]]), issued(null)),
    [],
    'a document without an issue'
  )
})

// --- a collection's own project (spec 0025 §3, §4) --------------------------------

test("a declared field's value is compared: another, or none, updates the item", () => {
  const w = want('m/a.md', {
    values: { 'Publish date': '2026-10-13', Kind: 'post' },
  })
  assert.deepEqual(
    planSync(
      [w],
      [
        have('i1', 'm/a.md', {
          values: { 'Publish date': '2026-10-13', Kind: 'post' },
        }),
      ]
    ),
    [{ kind: 'unchanged', id: 'i1' }]
  )
  for (const values of [
    { 'Publish date': '2026-10-14', Kind: 'post' },
    { Kind: 'post' },
  ])
    assert.equal(
      planSync([w], [have('i1', 'm/a.md', { values })])[0]?.kind,
      'update'
    )
  // A value gone from the document clears the item's.
  const cleared = want('m/a.md', { values: { Kind: null } })
  assert.equal(
    planSync([cleared], [have('i1', 'm/a.md', { values: { Kind: 'post' } })])[0]
      ?.kind,
    'update'
  )
  assert.equal(
    planSync([cleared], [have('i1', 'm/a.md')])[0]?.kind,
    'unchanged'
  )
})

test("labels are compared: one missing, or one the collection took off, updates; any other label is the team's", () => {
  const w = want('m/linkedin/a.md', { labels: ['linkedin'], unlabels: ['hn'] })
  const withLabels = (labels: string[]) =>
    have('i1', 'm/linkedin/a.md', { issue: open(1, { labels }) })
  assert.equal(
    planSync([w], [withLabels(['rness', 'linkedin'])])[0]?.kind,
    'unchanged'
  )
  assert.equal(
    planSync([w], [withLabels(['rness', 'LinkedIn', 'urgent'])])[0]?.kind,
    'unchanged',
    'case aside, and a label by hand'
  )
  assert.equal(planSync([w], [withLabels(['rness'])])[0]?.kind, 'update')
  assert.equal(
    planSync([w], [withLabels(['rness', 'linkedin', 'hn'])])[0]?.kind,
    'update'
  )
})

test('an item of a collection with its own project is taken off Agent Pulse: remove, its issue left as it is', () => {
  const elsewhere = (path: string) => path.startsWith('marketing/')
  assert.deepEqual(
    planSync(
      [want('specs/a.md')],
      [
        have('i1', 'specs/a.md'),
        have('i2', 'marketing/x.md'),
        have('i3', null),
      ],
      new Set(['marketing/x.md']),
      new Map(),
      elsewhere
    ),
    [
      { kind: 'unchanged', id: 'i1' },
      { kind: 'remove', id: 'i2' },
    ]
  )
})
