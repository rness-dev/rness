import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { run } from '../../src/cli.ts'
import { docNewCommand, writeDocument } from '../../src/commands/doc.ts'
import { checkContract } from '../../src/core/contract.ts'
import { capture } from '../helpers/capture.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const doc = (status: string, title: string) =>
  `---\ndate: 2026-10-02\nstatus: ${status}\nrepo: x\n---\n\n# ${title}\n`
const TODAY = /\d{4}-\d{2}-\d{2}/

async function docNew(
  collection: string,
  opts: { title?: string; cwd: string }
) {
  const c = capture()
  try {
    const code = await docNewCommand(collection, opts)
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

test('doc new: the next number of the collection, the slug of the title, the front matter and the sections of a specification', async (t) => {
  const root = await makeWorkspace(t, {
    files: {
      'specs/0001-a.md': doc('Draft', '0001 — A'),
      'specs/0007-b.md': doc('Implemented', '0007 — B'),
      'plans/0012-c.md': doc('Draft', '0012 — C'),
    },
  })
  const r = await docNew('specs', {
    title: 'The create wizard: asks where first!',
    cwd: root,
  })
  assert.equal(r.code, 0, r.err)
  const file = join(
    root,
    '.rness',
    'specs',
    '0008-the-create-wizard-asks-where-first.md'
  )
  assert.equal(r.out, `${file}\n`)
  const text = await readFile(file, 'utf8')
  assert.match(
    text,
    new RegExp(
      `^---\\ndate: ${TODAY.source}\\nstatus: Draft\\nrepo: ''\\nupdated: ${TODAY.source}\\n---\\n\\n# 0008 — The create wizard: asks where first!\\n\\n---\\n\\n## Summary\\n\\n## Scope\\n\\n## Out of scope\\n\\n## Alternatives considered\\n\\n## To verify\\n\\n## Tests\\n$`
    )
  )
  assert.deepEqual(await checkContract(join(root, '.rness')), [])
  // The next call takes the number after.
  const again = await docNew('specs', { cwd: root })
  assert.equal(again.code, 0, again.err)
  assert.equal(
    again.out,
    `${join(root, '.rness', 'specs', '0009-untitled.md')}\n`
  )
  assert.match(
    await readFile(join(root, '.rness', 'specs', '0009-untitled.md'), 'utf8'),
    /\n# 0009 — Untitled\n/
  )
})

test('doc new adr: Proposed, no updated, the sections of the workspace template, else of the shipped one; plans: Draft, decided-here and tasks', async (t) => {
  const template =
    '---\ndate: YYYY-MM-DD\nstatus: Proposed\nrepo: x\n---\n\n# NNNN — Title\n\n---\n\n## Context\n\nSay why.\n\n## Decision\n\n## Alternatives Considered\n\n- **A** — why not\n\n## Consequences\n\n---\n\nNever rewritten.\n'
  const root = await makeWorkspace(t, {
    files: { 'adr/0000-template.md': template },
  })
  const adr = await docNew('adr', { title: 'SQLite for the cache', cwd: root })
  assert.equal(adr.code, 0, adr.err)
  const text = await readFile(
    join(root, '.rness', 'adr', '0001-sqlite-for-the-cache.md'),
    'utf8'
  )
  assert.match(
    text,
    new RegExp(
      `^---\\ndate: ${TODAY.source}\\nstatus: Proposed\\nrepo: ''\\n---\\n\\n# 0001 — SQLite for the cache\\n\\n---\\n\\n## Context\\n\\n## Decision\\n\\n## Alternatives Considered\\n\\n## Consequences\\n$`
    )
  )
  const plan = await docNew('plans', { title: 'Ship it', cwd: root })
  assert.equal(plan.code, 0, plan.err)
  assert.match(
    await readFile(join(root, '.rness', 'plans', '0001-ship-it.md'), 'utf8'),
    /^---\ndate: .*\nstatus: Draft\nrepo: ''\nupdated: .*\n---\n\n# 0001 — Ship it\n\n## Decided here, where the specification leaves it open\n\n## Tasks\n$/
  )
  assert.deepEqual(await checkContract(join(root, '.rness')), [])

  // No template in the workspace: the shipped scaffold's sections.
  const bare = await makeWorkspace(t, {})
  const shipped = await docNew('adr', { title: 'Bare', cwd: bare })
  assert.equal(shipped.code, 0, shipped.err)
  assert.match(
    await readFile(join(bare, '.rness', 'adr', '0001-bare.md'), 'utf8'),
    /## Context\n\n## Decision\n\n## Alternatives Considered\n\n## Consequences\n$/
  )
})

test('doc new refuses a collection that is not numbered (exit 2)', async (t) => {
  const root = await makeWorkspace(t, {
    files: { 'specs/0001-a.md': doc('Draft', '0001 — A') },
  })
  const bad = await docNew('standards', { cwd: root })
  assert.equal(bad.code, 2)
  assert.equal(
    bad.err,
    'standards is not a numbered collection of this workspace (adr, specs, plans)\n'
  )
})

test('a document is never written over a file: the second of two allocations at once is refused', async (t) => {
  // Two sessions that allocate at once both read the same next number; the
  // write decides, and the second one writes nothing.
  const root = await makeWorkspace(t, {
    files: { 'specs/0001-untitled.md': 'mine\n' },
  })
  const file = join(root, '.rness', 'specs', '0001-untitled.md')
  const c = capture()
  let code: number
  try {
    code = await writeDocument(file, 'theirs\n')
  } finally {
    c.restore()
  }
  assert.equal(code, 1)
  assert.equal(c.out(), '')
  assert.equal(c.err(), `${file} exists; nothing written\n`)
  assert.equal(await readFile(file, 'utf8'), 'mine\n')
})

test('doc new: a dated file name is not a number', async (t) => {
  const root = await makeWorkspace(t, {
    files: {
      'plans/web/2026-10-02-copy-fix.md': doc('Completed', 'Copy fix'),
    },
  })
  const r = await docNew('plans', { cwd: root })
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, `${join(root, '.rness', 'plans', '0001-untitled.md')}\n`)
  // A title that starts like a month and a day keeps its number.
  const digits = await docNew('plans', { title: '10-02 review', cwd: root })
  assert.equal(
    digits.out,
    `${join(root, '.rness', 'plans', '0002-10-02-review.md')}\n`
  )
  const next = await docNew('plans', { cwd: root })
  assert.equal(
    next.out,
    `${join(root, '.rness', 'plans', '0003-untitled.md')}\n`
  )
  assert.deepEqual(await checkContract(join(root, '.rness')), [
    'plans/web/2026-10-02-copy-fix.md: not numbered; name it 0004-<slug>.md, the next number of plans',
  ])
})

test('rness doc new through the command line, and outside a workspace', async (t) => {
  const root = await makeWorkspace(t, {})
  const c = capture()
  try {
    const code = await run([
      'doc',
      'new',
      'specs',
      '--title',
      'From the CLI',
      '--cwd',
      root,
    ])
    assert.equal(code, 0, c.err())
    assert.equal(
      c.out(),
      `${join(root, '.rness', 'specs', '0001-from-the-cli.md')}\n`
    )
  } finally {
    c.restore()
  }
  const outside = await docNew('specs', { cwd: '/' })
  assert.equal(outside.code, 1)
  assert.match(outside.err, /\S/)
})
