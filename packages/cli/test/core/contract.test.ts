import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkContract } from '../../src/core/contract.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const brokenDir = fileURLToPath(
  new URL('../fixtures/ws-broken/.rness', import.meta.url)
)
const scopedDir = fileURLToPath(
  new URL('../fixtures/ws-scoped/.rness', import.meta.url)
)

test('reports every problem of the broken tree, in every collection', async () => {
  const problems = await checkContract(brokenDir)
  const has = (prefix: string, re: RegExp) =>
    assert.ok(
      problems.some((p) => p.startsWith(prefix) && re.test(p)),
      problems.join('\n')
    )
  assert.equal(problems.length, 7, problems.join('\n'))
  has('specs/bad.md', /missing a front-matter block/)
  has('plans/invalid-yaml.md', /invalid front matter/)
  has('skills/bad.md', /invalid front matter/)
  has('standards/web/placed.md', /front matter "scopes" is not supported/)
  for (const where of ['adr/ok.md', 'specs/bad.md', 'plans/invalid-yaml.md'])
    has(where, /not numbered/)
})

test('standards and skills need no front matter and no status', async () => {
  assert.deepEqual(await checkContract(scopedDir), [])
})

const doc = (status: string, title: string) =>
  `---\ndate: 2026-10-02\nstatus: ${status}\nrepo: x\n---\n\n# ${title}\n`

test('two documents with one number in a collection are each named after the other; across collections a number is free', async (t) => {
  const root = await makeWorkspace(t, {
    files: {
      'specs/0029-a.md': doc('Draft', '0029 — A'),
      'specs/0029-b.md': doc('Draft', '0029 — B'),
      'specs/0030-c.md': doc('Draft', '0030 — C'),
      'plans/0029-d.md': doc('Draft', '0029 — D'),
      'adr/0000-template.md': doc('Proposed', '0000 — Template'),
      'adr/0000-zero.md': doc('Proposed', '0000 — Zero'),
    },
  })
  assert.deepEqual(await checkContract(join(root, '.rness')), [
    'specs/0029-a.md: the number 0029 is also that of specs/0029-b.md',
    'specs/0029-b.md: the number 0029 is also that of specs/0029-a.md',
  ])
})

test('a document of adr, specs or plans without a number is named, with the next number; a dated name is not a number', async (t) => {
  const root = await makeWorkspace(t, {
    files: {
      'plans/0001-a.md': doc('Completed', '0001 — A'),
      'plans/web/2026-10-02-copy-fix.md': doc('In progress', 'Copy fix'),
      'plans/2026-10-03-other.md': doc('Draft', 'Other'),
      'specs/notes.md': doc('Draft', 'Notes'),
      'adr/0000-template.md': doc('Proposed', '0000 — Template'),
      'standards/style.md': '# Style\n',
    },
  })
  // Two dated plans of one year are no clash on a number 2026.
  assert.deepEqual(await checkContract(join(root, '.rness')), [
    'specs/notes.md: not numbered; name it 0001-<slug>.md, the next number of specs',
    'plans/2026-10-03-other.md: not numbered; name it 0002-<slug>.md, the next number of plans',
    'plans/web/2026-10-02-copy-fix.md: not numbered; name it 0002-<slug>.md, the next number of plans',
  ])
})
