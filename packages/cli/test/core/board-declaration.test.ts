import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseBoard } from '../../src/core/board-declaration.ts'

/** Spec 0031 §2.2's example: a collection's board, declared whole. */
const MARKETING = {
  number: 5,
  title: 'Marketing',
  description: 'The launch, from 1 October.',
  readme: 'marketing/README.md',
  updates: 'marketing/updates',
  collections: {
    marketing: { label: 'Marketing', statuses: ['Idea', 'Draft', 'Published'] },
  },
  colors: { Idea: 'gray', Draft: 'blue', Published: 'green' },
  fields: {
    Collection: { type: 'select', from: '$collection' },
    'Publish date': { type: 'date', from: ['published_at', 'scheduled_at'] },
    Kind: { type: 'select', from: 'kind', options: ['post', 'action'] },
    Reach: { type: 'number', from: 'reach' },
  },
  labels: 'directory',
  views: [
    { name: 'Board', layout: 'board', collection: 'marketing' },
    {
      name: 'Table',
      layout: 'table',
      fields: ['Title', 'Status', 'Kind', 'Publish date', 'Reach'],
    },
    { name: 'Calendar', layout: 'roadmap', date: 'Publish date' },
  ],
}

const refused = (value: unknown, message: string, name = 'marketing') =>
  assert.throws(() => parseBoard(name, value), { message })

const with_ = (over: Record<string, unknown>) => ({ ...MARKETING, ...over })

test('a declaration whole: every key read, `from` as a list, the source kept as written', () => {
  const b = parseBoard('marketing', MARKETING)
  assert.equal(b.number, 5)
  assert.equal(b.title, 'Marketing')
  assert.equal(b.readme, 'marketing/README.md')
  assert.equal(b.updates, 'marketing/updates')
  assert.deepEqual(b.collections, {
    marketing: {
      label: 'Marketing',
      statuses: ['Idea', 'Draft', 'Published'],
      field: null,
    },
  })
  assert.deepEqual(b.fields['Kind'], {
    type: 'select',
    from: ['kind'],
    options: ['post', 'action'],
  })
  assert.deepEqual(b.labels, { kind: 'directory' })
  assert.deepEqual(b.views[2], {
    name: 'Calendar',
    layout: 'roadmap',
    collection: null,
    filter: null,
    columns: null,
    fields: null,
    date: 'Publish date',
  })
  assert.equal(b.preset, null)
  assert.deepEqual(b.source, MARKETING)
})

test('defaults: a collection labelled after its directory; "all"; a front-matter key for labels; a preset', () => {
  const b = parseBoard('pulse', {
    number: 4,
    preset: 'agent-pulse/1',
    collections: 'all',
    labels: 'channel',
    views: [{ name: 'All', layout: 'table' }],
  })
  assert.equal(b.collections, 'all')
  assert.deepEqual(b.labels, { kind: 'key', key: 'channel' })
  assert.equal(b.preset, 'agent-pulse/1')
  const c = parseBoard('research', {
    number: 6,
    collections: { research: { statuses: 'found' } },
    views: [{ name: 'Research', layout: 'board' }],
  })
  assert.deepEqual(c.collections, {
    research: { label: 'Research', statuses: 'found', field: null },
  })
})

test('the board and its number', () => {
  refused(
    7,
    '"projects.marketing" must be an object, as { "number": 5, "collections": …, "views": … }'
  )
  refused(
    with_({ number: 0 }),
    '"projects.marketing.number" must be a project number'
  )
  refused(
    with_({ number: 'five' }),
    '"projects.marketing.number" must be a project number'
  )
  refused(
    with_({ preset: 'agent pulse' }),
    '"projects.marketing.preset" must name a preset and its revision, as agent-pulse/1'
  )
})

test('an unknown key, at any level, named in full', () => {
  refused(
    with_({ sort: 'Title' }),
    '"projects.marketing.sort" is not a key of a board'
  )
  refused(
    with_({
      collections: { marketing: { label: 'M', statuses: 'found', color: 1 } },
    }),
    '"projects.marketing.collections.marketing.color" is not a key of a collection'
  )
  refused(
    with_({
      fields: { Reach: { type: 'number', from: 'reach', unit: 'k' } },
    }),
    '"projects.marketing.fields.Reach.unit" is not a key of a field'
  )
  refused(
    with_({ views: [{ name: 'B', layout: 'board', sort: 'Title' }] }),
    '"projects.marketing.views[0].sort" is not a key of a view'
  )
})

test('collections', () => {
  refused(
    with_({ collections: {} }),
    '"projects.marketing.collections" must name at least one collection, or be "all"'
  )
  refused(
    with_({ collections: { marketing: { statuses: 'contract' } } }),
    '"projects.marketing.collections.marketing.statuses" is "contract" only for adr, specs and plans'
  )
  refused(
    with_({
      collections: {
        plans: {
          statuses: ['Draft', 'Ready', 'In progress', 'Blocked', 'Completed'],
        },
      },
      views: [{ name: 'Plans', layout: 'board' }],
    }),
    '"projects.marketing.collections.plans.statuses" must hold every status of the contract: Abandoned is missing'
  )
  refused(
    with_({ collections: { marketing: { statuses: 'some' } } }),
    '"projects.marketing.collections.marketing.statuses" must be "contract", "found" or a list of statuses'
  )
  refused(
    with_({ collections: { '.git': { statuses: 'found' } } }),
    '"projects.marketing.collections..git" must name a directory of .rness'
  )
  // Reordered, every status there: taken.
  const b = parseBoard(
    'marketing',
    with_({
      collections: {
        plans: {
          statuses: [
            'Ready',
            'Draft',
            'In progress',
            'Blocked',
            'Completed',
            'Abandoned',
          ],
          field: 'Plans status',
        },
      },
      views: [{ name: 'Plans', layout: 'board', columns: 'Plans status' }],
    })
  )
  assert.equal(
    (b.collections as Record<string, { field: string }>)['plans']?.field,
    'Plans status'
  )
})

test('fields', () => {
  for (const name of ['Path', 'Status', 'Title', 'Sub-issues progress'])
    refused(
      with_({ fields: { [name]: { type: 'text', from: 'x' } } }),
      `"projects.marketing.fields.${name}" is a field of rness or of GitHub: name it otherwise`
    )
  refused(
    with_({ fields: { Owner: { type: 'person', from: 'owner' } } }),
    '"projects.marketing.fields.Owner.type" must be one of text, date, select, number'
  )
  refused(
    with_({ fields: { Owner: { type: 'text', from: '$owner' } } }),
    '"projects.marketing.fields.Owner.from" names $owner, which rness does not know: $collection, $status, $agent, $session, $sessions or $id'
  )
  refused(
    with_({ fields: { Owner: { type: 'text' } } }),
    '"projects.marketing.fields.Owner.from" must be a front-matter key, a $ source, or a list of them'
  )
  refused(
    with_({
      fields: { Agent: { type: 'select', from: '$agent', options: ['busy'] } },
    }),
    '"projects.marketing.fields.Agent" is a select from $agent: it needs the option working'
  )
  refused(
    with_({ fields: { Agent: { type: 'text', from: '$agent' } } }),
    '"projects.marketing.fields.Agent" is a select from $agent: it needs the option working'
  )
  refused(
    with_({
      collections: {
        marketing: { statuses: 'found', field: 'Kind' },
      },
    }),
    '"projects.marketing.collections.marketing.field" names Kind, which fields declares too'
  )
})

test('views', () => {
  refused(
    with_({ views: [] }),
    '"projects.marketing.views" must list at least one view'
  )
  refused(
    with_({
      views: [
        { name: 'B', layout: 'board' },
        { name: 'B', layout: 'table' },
      ],
    }),
    '"projects.marketing.views[1].name" is B again: a view\'s name is unique on its board'
  )
  refused(
    with_({ views: [{ name: 'B', layout: 'list' }] }),
    '"projects.marketing.views[0].layout" must be board, table or roadmap'
  )
  refused(
    with_({ views: [{ name: 'T', layout: 'table', columns: 'Status' }] }),
    '"projects.marketing.views[0].columns" is a key of a board view only'
  )
  refused(
    with_({ views: [{ name: 'B', layout: 'board', date: 'Publish date' }] }),
    '"projects.marketing.views[0].date" is a key of a roadmap view only'
  )
  refused(
    with_({ views: [{ name: 'B', layout: 'board', fields: ['Title'] }] }),
    '"projects.marketing.views[0].fields" is a key of a table view only'
  )
  refused(
    with_({ views: [{ name: 'B', layout: 'board', columns: 'Reach' }] }),
    '"projects.marketing.views[0].columns" must name a single-select field: Status, a collection\'s field or a declared select'
  )
  refused(
    with_({ views: [{ name: 'T', layout: 'table', fields: ['Owner'] }] }),
    '"projects.marketing.views[0].fields" names Owner, which is no field of this board'
  )
  refused(
    with_({ views: [{ name: 'C', layout: 'roadmap' }] }),
    '"projects.marketing.views[0].date" must name a date field'
  )
  refused(
    with_({ views: [{ name: 'C', layout: 'roadmap', date: 'Kind' }] }),
    '"projects.marketing.views[0].date" must name a date field'
  )
  refused(
    with_({ views: [{ name: 'B', layout: 'board', collection: 'adr' }] }),
    '"projects.marketing.views[0].collection" names adr, which is not on this board'
  )
  refused(
    with_({
      fields: {},
      views: [{ name: 'B', layout: 'board', collection: 'marketing' }],
    }),
    '"projects.marketing.views[0].collection" needs a select field from $collection to filter by'
  )
})

test('colours', () => {
  refused(
    with_({ colors: { Idea: 'teal' } }),
    '"projects.marketing.colors.Idea" must be one of gray, blue, green, yellow, orange, red, pink, purple'
  )
})

test('labels', () => {
  refused(
    with_({ labels: '' }),
    '"projects.marketing.labels" must be directory or a front-matter key'
  )
})

test("readme and updates: a path within .rness, never out of it — rness.json is the organization's, the file a developer's", () => {
  for (const [key, example] of [
    ['readme', 'marketing/README.md'],
    ['updates', 'marketing/updates'],
  ] as const)
    for (const path of [
      '../../.ssh/id_rsa',
      '/etc/passwd',
      'marketing/../../.ssh/id_rsa',
      '.git/config',
      '~/.ssh/id_rsa',
    ])
      refused(
        with_({ [key]: path }),
        `"projects.marketing.${key}" must be a path within .rness, as ${example}`
      )
})

// --- hooks (spec 0032 §1, §3) -------------------------------------------------

const AGENT = {
  Agent: { type: 'select', from: '$agent', options: ['working'] },
  'Working session': { type: 'text', from: '$session' },
}
const hooked = (hooks: unknown, fields: Record<string, unknown> = AGENT) =>
  with_({ fields: { ...MARKETING.fields, ...fields }, hooks })

test('hooks: each action at its event, a name or an object, the defaults filled', () => {
  const b = parseBoard(
    'marketing',
    hooked({
      'session-start': ['mark-in-progress'],
      edit: [{ action: 'mark' }],
      'session-end': ['clear-marks'],
    })
  )
  assert.deepEqual(b.hooks, {
    'session-start': [
      {
        action: 'mark-in-progress',
        collections: ['plans'],
        statuses: ['In progress'],
      },
    ],
    edit: [{ action: 'mark' }],
    'session-end': [{ action: 'clear-marks' }],
  })
  const c = parseBoard(
    'marketing',
    hooked({
      'session-start': [
        {
          action: 'mark-in-progress',
          collections: ['marketing'],
          statuses: ['Draft', 'Scheduled'],
        },
      ],
    })
  )
  assert.deepEqual(c.hooks['session-start'], [
    {
      action: 'mark-in-progress',
      collections: ['marketing'],
      statuses: ['Draft', 'Scheduled'],
    },
  ])
  assert.deepEqual(parseBoard('marketing', MARKETING).hooks, {})
})

test('hooks: every refusal by its full key', () => {
  refused(
    hooked({ start: ['mark'] }),
    '"projects.marketing.hooks.start" is not an event: session-start, edit or session-end'
  )
  refused(
    hooked({ edit: 'mark' }),
    '"projects.marketing.hooks.edit" must list actions'
  )
  refused(
    hooked({ edit: ['notify'] }),
    '"projects.marketing.hooks.edit[0]" names notify, which is no action: mark, mark-in-progress, clear-marks, journal or journal-summary'
  )
  refused(
    hooked({ 'session-end': ['mark'] }),
    '"projects.marketing.hooks.session-end[0]": mark is an action of edit, not of session-end'
  )
  refused(
    hooked({ edit: [{ action: 'mark', run: './notify.sh' }] }),
    '"projects.marketing.hooks.edit[0].run" is not a parameter of mark'
  )
  refused(
    hooked({ edit: ['mark', 'mark'] }),
    '"projects.marketing.hooks.edit[1]": mark is there already'
  )
  refused(
    hooked({ edit: ['mark'] }, {}),
    '"projects.marketing.hooks.edit[0]": mark needs a select field from $agent with the option working'
  )
  refused(
    hooked({
      'session-start': [{ action: 'mark-in-progress', statuses: [] }],
    }),
    '"projects.marketing.hooks.session-start[0].statuses" must list statuses'
  )
})

test('hooks: journal at session start, to the plan or the repository, a limit; journal-summary at session end', () => {
  const plans = {
    collections: { plans: { statuses: 'contract' } },
    views: [{ name: 'Plans', layout: 'board' }],
  }
  const b = parseBoard('pulse', {
    ...with_(plans),
    hooks: {
      'session-start': [{ action: 'journal', to: 'repo' }],
      'session-end': ['journal-summary'],
    },
  })
  assert.deepEqual(b.hooks, {
    'session-start': [{ action: 'journal', to: 'repo', limit: 5 }],
    'session-end': [{ action: 'journal-summary' }],
  })
  const three = parseBoard('pulse', {
    ...with_(plans),
    hooks: { 'session-start': [{ action: 'journal', to: 'plan', limit: 3 }] },
  })
  assert.deepEqual(three.hooks['session-start'], [
    { action: 'journal', to: 'plan', limit: 3 },
  ])
})

test('hooks: journal and journal-summary refused by their full key', () => {
  const plans = {
    collections: { plans: { statuses: 'contract' } },
    views: [{ name: 'Plans', layout: 'board' }],
  }
  refused(
    with_({ ...plans, hooks: { 'session-start': ['journal'] } }),
    '"projects.marketing.hooks.session-start[0].to" must be plan or repo'
  )
  refused(
    with_({
      ...plans,
      hooks: { 'session-start': [{ action: 'journal', to: 'repo', limit: 0 }] },
    }),
    '"projects.marketing.hooks.session-start[0].limit" must be a number of notes, 1 or more'
  )
  refused(
    with_({ hooks: { 'session-start': [{ action: 'journal', to: 'plan' }] } }),
    '"projects.marketing.hooks.session-start[0]": journal needs the plans on its board'
  )
  refused(
    with_({ ...plans, hooks: { 'session-end': ['journal-summary'] } }),
    '"projects.marketing.hooks.session-end[0]": journal-summary needs journal at session-start on its board'
  )
})
