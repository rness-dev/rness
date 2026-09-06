// cli/test/core/contract.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { checkContract } from '../../src/core/contract.mjs'

const brokenDir = fileURLToPath(new URL('../fixtures/ws-broken/.rness', import.meta.url))
const scopedDir = fileURLToPath(new URL('../fixtures/ws-scoped/.rness', import.meta.url))

test('flags a spec with no front matter', async () => {
  const problems = await checkContract(brokenDir)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /specs\/bad\.md/)
})

test('a valid tree has no problems', async () => {
  assert.deepEqual(await checkContract(scopedDir), [])
})
