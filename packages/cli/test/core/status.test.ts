import assert from 'node:assert/strict'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { loadManifest } from '../../src/core/manifest.ts'
import { recordRefusals } from '../../src/core/refusals.ts'
import { policiesTab } from '../../src/core/status-policies.ts'
import {
  findTab,
  statusMarkdown,
  statusTabs,
  statusTone,
} from '../../src/core/status.ts'
import { git } from '../helpers/git.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const doc = (status: string | null, title: string) =>
  `${status === null ? '' : `---\nstatus: ${status}\n---\n\n`}# ${title}\n`

async function rness(t: TestContext, files: Record<string, string>) {
  const root = await makeWorkspace(t, { files })
  return join(root, '.rness')
}

test('ADR, Specs and Plans always, in that order, even empty', async (t) => {
  const tabs = await statusTabs(await rness(t, {}))
  assert.deepEqual(
    tabs.map((tab) => [tab.name, tab.label, tab.rows.length]),
    [
      ['adr', 'ADR', 0],
      ['specs', 'Specs', 0],
      ['plans', 'Plans', 0],
    ]
  )
})

test('rows: sessions from the front matter — { id, agent } or a bare id; the first entry of an id wins (spec 0022 §3)', async (t) => {
  const fm = (sessions: string) =>
    `---\nstatus: Draft\nsessions: ${sessions}\n---\n\n# 0001 — A\n`
  const dir = await rness(t, {
    'specs/0001-list.md': fm('[s1, s2, s1, "", 3]'),
    'specs/0002-string.md': fm('s1'),
    'specs/0003-none.md': doc('Draft', '0003 - C'),
    'specs/0004-empty.md': fm('[]'),
    'specs/0005-agents.md': fm(
      '[{ id: s1, agent: Claude Opus 5.5 }, s2, { id: s1, agent: other }, { agent: no id }, { id: s3, agent: "" }]'
    ),
  })
  const [, specs] = await statusTabs(dir)
  assert.deepEqual(
    specs?.rows.map((r) => [r.path, r.sessions]),
    [
      [
        'specs/0005-agents.md',
        [{ id: 's1', agent: 'Claude Opus 5.5' }, { id: 's2' }, { id: 's3' }],
      ],
      ['specs/0004-empty.md', undefined],
      ['specs/0003-none.md', undefined],
      ['specs/0002-string.md', undefined],
      ['specs/0001-list.md', [{ id: 's1' }, { id: 's2' }]],
    ]
  )
})

test('rows: id, title without its number, status; newest first; the template left out', async (t) => {
  const dir = await rness(t, {
    'plans/0005-old.md': doc('Draft', '0005 - Maintenance'),
    'plans/0023-new.md': doc('In progress', '0023 - Claude hooks'),
    'plans/0010-broken.md': '---\nstatus: [oops\n---\n# 0010 — Broken\n',
    'plans/0011-bare.md': doc(null, '0011 - No front matter'),
    'adr/0000-template.md': doc('Proposed', '0000 - Template'),
    'adr/notes.md': 'no heading here\n',
  })
  const [adr, , plans] = await statusTabs(dir)
  assert.deepEqual(plans?.rows, [
    {
      id: '0023',
      title: 'Claude hooks',
      status: 'In progress',
      path: 'plans/0023-new.md',
    },
    {
      id: '0011',
      title: 'No front matter',
      status: null,
      path: 'plans/0011-bare.md',
    },
    { id: '0010', title: 'Broken', status: null, path: 'plans/0010-broken.md' },
    {
      id: '0005',
      title: 'Maintenance',
      status: 'Draft',
      path: 'plans/0005-old.md',
    },
  ])
  assert.deepEqual(adr?.rows, [
    { id: 'notes', title: 'notes', status: null, path: 'adr/notes.md' },
  ])
})

test('a directory whose documents carry a status is a tab of its own; its other files are left out', async (t) => {
  const dir = await rness(t, {
    'marketing/blog/2026-09-30-launch.md': doc('published', 'Launch'),
    'marketing/social/2026-10-02-teaser.md': doc('draft', 'Teaser'),
    // `status:` in a code block is not front matter.
    'marketing/WORKFLOW.md': '# Workflow\n\n```yaml\nstatus: draft\n```\n',
    'docs/current.md': doc(null, 'Current behaviour'),
    'standards/style.md': doc('Accepted', 'Style'),
    'skills/x.md': doc('Accepted', 'A skill'),
    // A collection of the contract with a status, and still no discovered tab:
    // the Policies tab is built apart, and a board never takes it (see board.test.ts).
    'policy/no-force-push.md': doc('Disabled', 'No force push'),
    '.github/notes.md': doc('Accepted', 'Hidden'),
    'node_modules/pkg/README.md': doc('Accepted', 'A package'),
    'zines/0001-first.md': doc('Draft', '0001 - First'),
  })
  const tabs = await statusTabs(dir)
  assert.deepEqual(
    tabs.map((tab) => tab.label),
    ['ADR', 'Specs', 'Plans', 'Marketing', 'Zines']
  )
  assert.deepEqual(tabs[3]?.rows, [
    {
      id: '2026-10-02',
      title: 'Teaser',
      status: 'draft',
      path: 'marketing/social/2026-10-02-teaser.md',
    },
    {
      id: '2026-09-30',
      title: 'Launch',
      status: 'published',
      path: 'marketing/blog/2026-09-30-launch.md',
    },
  ])
})

test('tones: done, dropped, missing, and the rest active — whatever the case', () => {
  assert.equal(statusTone('Implemented'), 'done')
  assert.equal(statusTone('published'), 'done')
  assert.equal(statusTone('COMPLETED'), 'done')
  assert.equal(statusTone('Superseded'), 'dropped')
  assert.equal(statusTone('abandoned'), 'dropped')
  assert.equal(statusTone(null), 'missing')
  assert.equal(statusTone('In progress'), 'active')
  assert.equal(statusTone('review'), 'active')
})

test('a tab is found by name or label, whatever the case', async (t) => {
  const tabs = await statusTabs(await rness(t, {}))
  assert.equal(findTab(tabs, 'SPECS')?.name, 'specs')
  assert.equal(findTab(tabs, 'adr')?.label, 'ADR')
  assert.equal(findTab(tabs, 'nope'), undefined)
})

test('Markdown: a heading, a section and a table per tab, an empty one said so, pipes escaped', async (t) => {
  const dir = await rness(t, {
    'specs/0002-a.md': doc('Approved', '0002 - Pipes | in a title'),
    'specs/0001-b.md': doc(null, '0001 - No status'),
  })
  const tabs = await statusTabs(dir)
  assert.equal(
    statusMarkdown('acme', tabs),
    [
      'acme · status',
      '',
      '## ADR (0)',
      '',
      '_Nothing yet._',
      '',
      '## Specs (2)',
      '',
      '| Id | Title | Status |',
      '| --- | --- | --- |',
      '| 0002 | Pipes \\| in a title | Approved |',
      '| 0001 | No status | ? |',
      '',
      '## Plans (0)',
      '',
      '_Nothing yet._',
      '',
    ].join('\n')
  )
  assert.equal(
    statusMarkdown(
      'acme',
      tabs.filter((tab) => tab.name === 'specs')
    ),
    [
      'acme · status',
      '',
      '## Specs (2)',
      '',
      '| Id | Title | Status |',
      '| --- | --- | --- |',
      '| 0002 | Pipes \\| in a title | Approved |',
      '| 0001 | No status | ? |',
      '',
    ].join('\n')
  )
})

// --- the Policies tab (spec 0040 §6) -----------------------------------------

const policy = (status: string, title: string) =>
  `---\nstatus: ${status}\nrules:\n  - check: added-lines\n    deny: x\n    fix: Remove it.\n---\n\n# ${title}\n`
const NOW = Date.parse('2026-11-03T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const refusal = (
  policy: string,
  by: 'guard' | 'pre-commit' = 'pre-commit'
) => ({
  policy,
  check: 'added-lines' as const,
  by,
})

async function withClones(t: TestContext) {
  const root = await makeWorkspace(t, {
    scopes: { api: { url: 'u' }, web: { url: 'v' } },
    dirs: ['org/api', 'org/web'],
    files: {
      'policy/no-em-dash.md': policy('Enabled', 'No em dash'),
      'policy/api/no-todo.md': policy('Disabled', 'No todo'),
    },
  })
  for (const clone of ['api', 'web', '.rness'])
    await git(
      ['init', '-q', '-b', 'main'],
      join(root, clone === '.rness' ? clone : `org/${clone}`)
    )
  const ws = { root, rnessDir: join(root, '.rness') }
  return { ws, manifest: await loadManifest(ws.rnessDir), root }
}

test('Policies tab: every policy with its scope and status; the refusals of the last 7 days across the clones, grouped, with count and last time', async (t) => {
  const { ws, manifest, root } = await withClones(t)
  const api = join(root, 'org/api')
  const web = join(root, 'org/web')
  await recordRefusals(api, [refusal('no-em-dash')], NOW - 3 * DAY)
  await recordRefusals(
    api,
    [refusal('no-em-dash'), refusal('no-todo')],
    NOW - DAY
  )
  await recordRefusals(
    web,
    [refusal('no-em-dash', 'guard')],
    NOW - 2 * 60 * 60 * 1000
  )
  // Older than 7 days: not shown.
  await recordRefusals(
    web,
    [refusal('no-todo'), refusal('no-todo')],
    NOW - 8 * DAY
  )
  const tab = await policiesTab(ws, manifest, NOW)
  assert.equal(tab.name, 'policy')
  assert.equal(tab.label, 'Policies')
  assert.deepEqual(tab.rows, [
    {
      id: 'no-em-dash',
      title: 'global',
      status: 'Enabled',
      path: 'policy/no-em-dash.md',
    },
    {
      id: 'no-todo',
      title: 'api',
      status: 'Disabled',
      path: 'policy/api/no-todo.md',
    },
  ])
  assert.deepEqual(tab.notes, [
    'Refusals of the last 7 days',
    'no-em-dash: 3 refusals, last 2026-11-03 10:00 UTC',
    'no-todo: 1 refusal, last 2026-11-02 12:00 UTC',
  ])
  assert.equal(
    statusMarkdown('acme', [tab]),
    [
      'acme · status',
      '',
      '## Policies (2)',
      '',
      '| Id | Scope | Status |',
      '| --- | --- | --- |',
      '| no-em-dash | global | Enabled |',
      '| no-todo | api | Disabled |',
      '',
      'Refusals of the last 7 days',
      '',
      '- no-em-dash: 3 refusals, last 2026-11-03 10:00 UTC',
      '- no-todo: 1 refusal, last 2026-11-02 12:00 UTC',
      '',
    ].join('\n')
  )
})

test('Policies tab: no refusal, or no policy, says so in one line', async (t) => {
  const { ws, manifest } = await withClones(t)
  const tab = await policiesTab(ws, manifest, NOW)
  assert.deepEqual(tab.notes, ['No refusal in the last 7 days.'])
  assert.match(
    statusMarkdown('acme', [tab]),
    /\n\nNo refusal in the last 7 days\.\n$/
  )

  const bare = await makeWorkspace(t, {})
  const none = await policiesTab(
    { root: bare, rnessDir: join(bare, '.rness') },
    await loadManifest(join(bare, '.rness')),
    NOW
  )
  assert.deepEqual(none.rows, [])
  assert.match(
    statusMarkdown('acme', [none]),
    /## Policies \(0\)\n\n_Nothing yet\._\n\nNo refusal/
  )
})

test('Policies: Enabled reads as done, Disabled as dropped', () => {
  assert.equal(statusTone('Enabled'), 'done')
  assert.equal(statusTone('Disabled'), 'dropped')
})
