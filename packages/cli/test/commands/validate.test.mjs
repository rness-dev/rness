// cli/test/commands/validate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { validateCommand } from '../../src/commands/validate.mjs'

const brokenCwd = fileURLToPath(new URL('../fixtures/ws-broken', import.meta.url))
const scopedCwd = fileURLToPath(new URL('../fixtures/ws-scoped', import.meta.url))

test('returns 1 on a broken tree', async () => {
  assert.equal(await validateCommand(['--cwd', brokenCwd]), 1)
})

test('returns 0 on a valid tree', async () => {
  assert.equal(await validateCommand(['--cwd', scopedCwd]), 0)
})
