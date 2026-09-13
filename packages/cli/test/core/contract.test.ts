import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkContract } from '../../src/core/contract.ts'

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
