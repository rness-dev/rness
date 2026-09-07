// cli/test/commands/validate.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { validateCommand } from '../../src/commands/validate.mjs'

const brokenCwd = fileURLToPath(new URL('../fixtures/ws-broken', import.meta.url))
const scopedCwd = fileURLToPath(new URL('../fixtures/ws-scoped', import.meta.url))
const cycleCwd = fileURLToPath(new URL('../fixtures/ws-cycle', import.meta.url))

function capture() {
  const out = []
  const err = []
  const w = process.stdout.write.bind(process.stdout)
  const e = process.stderr.write.bind(process.stderr)
  // Only intercept string writes; forward Buffer writes so node --test's
  // process-isolation IPC on stdout is not swallowed (see context.test.mjs).
  process.stdout.write = (...args) =>
    typeof args[0] === 'string' ? (out.push(args[0]), true) : w(...args)
  process.stderr.write = (...args) =>
    typeof args[0] === 'string' ? (err.push(args[0]), true) : e(...args)
  return {
    restore: () => {
      process.stdout.write = w
      process.stderr.write = e
    },
    text: () => out.join(''),
    errText: () => err.join(''),
  }
}

test('returns 1 on a broken tree', async () => {
  assert.equal(await validateCommand(['--cwd', brokenCwd]), 1)
})

test('returns 0 on a valid tree', async () => {
  assert.equal(await validateCommand(['--cwd', scopedCwd]), 0)
})

test('reports an extends cycle instead of passing (I2)', async () => {
  const c = capture()
  const code = await validateCommand(['--cwd', cycleCwd])
  c.restore()
  assert.equal(code, 1)
  assert.match(c.errText(), /cycle/)
})

test('rejects an unknown flag with bad-usage exit 2 (I5)', async () => {
  const c = capture()
  const code = await validateCommand(['--bogus'])
  c.restore()
  assert.equal(code, 2)
})

test('rejects --cwd with no value with bad-usage exit 2 (I5)', async () => {
  const c = capture()
  const code = await validateCommand(['--cwd'])
  c.restore()
  assert.equal(code, 2)
})
