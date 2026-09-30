import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type TestContext, test } from 'node:test'

import {
  type CollectionShape,
  readShape,
  readUpdates,
  valuesOf,
} from '../../src/pulse/collection.ts'

async function rness(
  t: TestContext,
  files: Record<string, string>
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rness-collection-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, ...path.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text)
  }
  return root
}

const NONE: CollectionShape = {
  readme: null,
  description: null,
  statuses: null,
  fields: [],
  labels: null,
}

test('a collection without README.md declares nothing', async (t) => {
  const dir = await rness(t, { 'marketing/x/a.md': '---\nstatus: Idea\n---\n' })
  assert.deepEqual(await readShape(dir, 'marketing'), NONE)
})

test('README.md: its body is the project README; its front matter the rest', async (t) => {
  const dir = await rness(t, {
    'marketing/README.md': `---
description: The launch, from 1 October.
statuses: [Idea, Draft, Published]
fields:
  Publish date: { type: date, from: [published_at, scheduled_at] }
  Kind: { type: select, from: kind, options: [post, action] }
  Reach: { type: number, from: reach }
  Note: { type: text, from: note }
labels: directory
---

# The launch

Strategy.
`,
  })
  assert.deepEqual(await readShape(dir, 'marketing'), {
    readme: '# The launch\n\nStrategy.\n',
    description: 'The launch, from 1 October.',
    statuses: ['Idea', 'Draft', 'Published'],
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
      { name: 'Reach', type: 'number', from: ['reach'], options: [] },
      { name: 'Note', type: 'text', from: ['note'], options: [] },
    ],
    labels: { kind: 'directory' },
  })
})

test('README.md without front matter: the project README, nothing declared', async (t) => {
  const dir = await rness(t, { 'research/README.md': '# Research\n' })
  assert.deepEqual(await readShape(dir, 'research'), {
    ...NONE,
    readme: '# Research\n',
  })
})

test('labels: a front-matter key', async (t) => {
  const dir = await rness(t, {
    'marketing/README.md': '---\nlabels: channel\n---\n',
  })
  assert.deepEqual((await readShape(dir, 'marketing')).labels, {
    kind: 'key',
    key: 'channel',
  })
})

test('a declaration rness cannot read stops with one line naming the key', async (t) => {
  for (const [front, message] of [
    ['description: 3', '"description" must be text'],
    ['statuses: Idea', '"statuses" must be a list of names'],
    ['statuses: [Idea, Idea]', '"statuses" must be a list of names'],
    ['fields: [a]', '"fields" must map names to { type, from }'],
    [
      'fields:\n  Kind: { type: colour, from: kind }',
      '"fields.Kind.type" must be one of text, date, select, number',
    ],
    [
      'fields:\n  Kind: { type: select }',
      '"fields.Kind.from" must be a front-matter key or a list of them',
    ],
    [
      'fields:\n  Status: { type: select, from: status }',
      '"fields.Status" is a field of rness: name it otherwise',
    ],
    [
      'fields:\n  Kind: { type: select, from: kind, options: post }',
      '"fields.Kind.options" must be a list of names',
    ],
    ['labels: [a, b]', '"labels" must be directory or a front-matter key'],
  ] as const) {
    const dir = await rness(t, {
      'marketing/README.md': `---\n${front}\n---\n`,
    })
    await assert.rejects(
      () => readShape(dir, 'marketing'),
      new Error(`marketing/README.md: ${message}`)
    )
  }
})

test('valuesOf: each field from its first key present, as its type reads', () => {
  const shape: CollectionShape = {
    ...NONE,
    fields: [
      {
        name: 'Publish date',
        type: 'date',
        from: ['published_at', 'scheduled_at'],
        options: [],
      },
      { name: 'Kind', type: 'select', from: ['kind'], options: [] },
      { name: 'Reach', type: 'number', from: ['reach'], options: [] },
      { name: 'Note', type: 'text', from: ['note'], options: [] },
    ],
  }
  assert.deepEqual(
    valuesOf(
      shape,
      {
        scheduled_at: '2026-10-13T15:00+02:00',
        kind: 'post',
        reach: 120,
        note: ['a', 'b'],
      },
      'linkedin/2026-09-30-first-post.md'
    ).values,
    {
      'Publish date': '2026-10-13',
      Kind: 'post',
      Reach: '120',
      Note: 'a, b',
    }
  )
  assert.deepEqual(
    valuesOf(
      shape,
      {
        published_at: '2026-10-14',
        scheduled_at: '2026-10-13',
        reach: 'many',
      },
      'a.md'
    ).values,
    { 'Publish date': '2026-10-14', Kind: null, Reach: null, Note: null }
  )
  // Not a date: no value rather than a wrong one.
  assert.equal(
    valuesOf(shape, { scheduled_at: 'next week' }, 'a.md').values[
      'Publish date'
    ],
    null
  )
})

test('valuesOf: labels from the directory, or from a key', () => {
  const byDirectory: CollectionShape = {
    ...NONE,
    labels: { kind: 'directory' },
  }
  assert.deepEqual(valuesOf(byDirectory, {}, 'linkedin/a.md').labels, [
    'linkedin',
  ])
  assert.deepEqual(valuesOf(byDirectory, {}, 'a.md').labels, [])
  assert.deepEqual(valuesOf(byDirectory, {}, 'hn/deep/a.md').labels, ['hn'])
  const byKey: CollectionShape = {
    ...NONE,
    labels: { kind: 'key', key: 'channel' },
  }
  assert.deepEqual(valuesOf(byKey, { channel: 'x' }, 'a.md').labels, ['x'])
  assert.deepEqual(
    valuesOf(byKey, { channel: ['x', 'linkedin', 'x'] }, 'a.md').labels,
    ['x', 'linkedin']
  )
  assert.deepEqual(valuesOf(byKey, {}, 'a.md').labels, [])
})

test('readUpdates: updates/ in the order of the names, health and dates read', async (t) => {
  const dir = await rness(t, {
    'marketing/updates/2026-10-12.md': `---
health: at-risk
---
Show HN moved.
`,
    'marketing/updates/2026-10-05.md': `---
health: on-track
start_date: 2026-10-01
target_date: 2026-11-12
---
First week.
`,
    'marketing/2026-09-30-card.md': '---\nstatus: Idea\n---\n',
  })
  assert.deepEqual(await readUpdates(dir, 'marketing'), [
    {
      path: 'marketing/updates/2026-10-05.md',
      health: 'on-track',
      startDate: '2026-10-01',
      targetDate: '2026-11-12',
      body: 'First week.\n',
    },
    {
      path: 'marketing/updates/2026-10-12.md',
      health: 'at-risk',
      startDate: null,
      targetDate: null,
      body: 'Show HN moved.\n',
    },
  ])
})

test('readUpdates: none without updates/; a file without health stops with its path', async (t) => {
  const none = await rness(t, { 'marketing/a.md': '---\nstatus: Idea\n---\n' })
  assert.deepEqual(await readUpdates(none, 'marketing'), [])
  const bad = await rness(t, {
    'marketing/updates/2026-10-05.md': '---\nstatus: on-track\n---\nText\n',
  })
  await assert.rejects(
    () => readUpdates(bad, 'marketing'),
    new Error(
      'marketing/updates/2026-10-05.md: "health" must be one of on-track, at-risk, off-track, complete, inactive'
    )
  )
})
