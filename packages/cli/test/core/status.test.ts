import assert from 'node:assert/strict'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import {
  findTab,
  statusMarkdown,
  statusTabs,
  statusTone,
} from '../../src/core/status.ts'
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

test('rows: id, title without its number, status; newest first; the template left out', async (t) => {
  const dir = await rness(t, {
    'plans/0005-old.md': doc('Draft', '0005 — Maintenance'),
    'plans/0023-new.md': doc('In progress', '0023 — Claude hooks'),
    'plans/0010-broken.md': '---\nstatus: [oops\n---\n# 0010 — Broken\n',
    'plans/0011-bare.md': doc(null, '0011 — No front matter'),
    'adr/0000-template.md': doc('Proposed', '0000 — Template'),
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
    '.github/notes.md': doc('Accepted', 'Hidden'),
    'node_modules/pkg/README.md': doc('Accepted', 'A package'),
    'zines/0001-first.md': doc('Draft', '0001 — First'),
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
    'specs/0002-a.md': doc('Approved', '0002 — Pipes | in a title'),
    'specs/0001-b.md': doc(null, '0001 — No status'),
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
