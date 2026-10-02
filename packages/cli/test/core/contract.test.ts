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
  const find = (prefix: string) =>
    problems.find((p) => p.startsWith(prefix)) ?? ''
  assert.equal(problems.length, 4, problems.join('\n'))
  assert.match(find('specs/bad.md'), /missing a front-matter block/)
  assert.match(find('plans/invalid-yaml.md'), /invalid front matter/)
  assert.match(find('skills/bad.md'), /invalid front matter/)
  assert.match(
    find('standards/web/placed.md'),
    /front matter "scopes" is not supported/
  )
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
