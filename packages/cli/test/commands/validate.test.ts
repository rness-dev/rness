import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { run } from '../../src/cli.ts'
import { capture } from '../helpers/capture.ts'

const brokenCwd = fileURLToPath(new URL('../fixtures/ws-broken', import.meta.url))
const scopedCwd = fileURLToPath(new URL('../fixtures/ws-scoped', import.meta.url))
const cycleCwd = fileURLToPath(new URL('../fixtures/ws-cycle', import.meta.url))

test('returns 1 on a broken tree and lists every problem', async () => {
  const c = capture()
  const code = await run(['validate', '--cwd', brokenCwd])
  c.restore()
  assert.equal(code, 1)
  assert.match(c.err(), /specs\/bad\.md/)
  assert.match(c.err(), /plans\/invalid-yaml\.md/)
})

test('returns 0 and prints "context ok" on a valid tree', async () => {
  const c = capture()
  const code = await run(['validate', '--cwd', scopedCwd])
  c.restore()
  assert.equal(code, 0)
  assert.equal(c.out().trim(), 'context ok')
})

test('reports an extends cycle instead of passing', async () => {
  const c = capture()
  const code = await run(['validate', '--cwd', cycleCwd])
  c.restore()
  assert.equal(code, 1)
  assert.match(c.err(), /cycle/)
})

test('rejects an unknown flag with bad-usage exit 2', async () => {
  const c = capture()
  const code = await run(['validate', '--bogus'])
  c.restore()
  assert.equal(code, 2)
})

test('rejects --cwd with no value with bad-usage exit 2', async () => {
  const c = capture()
  const code = await run(['validate', '--cwd'])
  c.restore()
  assert.equal(code, 2)
})
