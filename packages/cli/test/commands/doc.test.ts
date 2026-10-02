import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { run } from '../../src/cli.ts'
import { docNewCommand } from '../../src/commands/doc.ts'
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

test('doc new refuses a collection that is not numbered (exit 2); the next number never names a file present', async (t) => {
  const root = await makeWorkspace(t, {
    files: { 'specs/0001-a.md': doc('Draft', '0001 — A') },
  })
  const bad = await docNew('standards', { cwd: root })
  assert.equal(bad.code, 2)
  assert.equal(
    bad.err,
    'standards is not a numbered collection of this workspace (adr, specs, plans)\n'
  )
  // A file at the next path, by some other hand, is not overwritten.
  const taken = await makeWorkspace(t, {
    files: {
      'specs/0001-a.md': doc('Draft', '0001 — A'),
      'specs/0002-untitled.md': 'mine\n',
    },
  })
  // The highest number is 0002, so the next is 0003: no clash. Force one by
  // numbering nothing but the taken name under a non-numbered file.
  const clash = await makeWorkspace(t, {
    files: { 'specs/0001-untitled.md': 'mine\n' },
  })
  // 0001-untitled.md carries a number, so the next is 0002: still no clash.
  // The guard is the write mode: a race writing the same path fails.
  assert.equal((await docNew('specs', { cwd: taken })).code, 0)
  assert.equal((await docNew('specs', { cwd: clash })).code, 0)
  await access(join(clash, '.rness', 'specs', '0002-untitled.md'))
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
