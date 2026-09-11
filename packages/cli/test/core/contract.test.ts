import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { checkContract } from '../../src/core/contract.ts'

const brokenDir = fileURLToPath(new URL('../fixtures/ws-broken/.rness', import.meta.url))
const scopedDir = fileURLToPath(new URL('../fixtures/ws-scoped/.rness', import.meta.url))

test('flags a spec with no front matter and a plan with invalid front matter', async () => {
  const problems = await checkContract(brokenDir)
  assert.equal(problems.length, 2)
  assert.match(problems.find((p) => p.startsWith('plans/')) ?? '', /plans\/invalid-yaml\.md: invalid front matter/)
  assert.match(problems.find((p) => p.startsWith('specs/')) ?? '', /specs\/bad\.md: missing a front-matter block/)
})

test('a valid tree has no problems', async () => {
  assert.deepEqual(await checkContract(scopedDir), [])
})
