import { test } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../src/cli.mjs'

function capture() {
  const out = []
  const err = []
  const w = process.stdout.write.bind(process.stdout)
  const e = process.stderr.write.bind(process.stderr)
  // Only intercept string writes (the CLI's output); pass Buffer writes
  // through untouched so the test runner's process-isolation IPC on stdout
  // is not swallowed.
  process.stdout.write = (s) => (typeof s === 'string' ? (out.push(s), true) : w(s))
  process.stderr.write = (s) => (typeof s === 'string' ? (err.push(s), true) : e(s))
  return {
    restore: () => { process.stdout.write = w; process.stderr.write = e },
    out: () => out.join(''),
    err: () => err.join(''),
  }
}

test('--version prints a semver and exits 0', async () => {
  const c = capture()
  const code = await main(['--version'])
  c.restore()
  assert.equal(code, 0)
  assert.match(c.out(), /^\d+\.\d+\.\d+\s*$/)
})

test('--help prints usage and exits 0', async () => {
  const c = capture()
  const code = await main(['--help'])
  c.restore()
  assert.equal(code, 0)
  assert.match(c.out(), /Usage: rness/)
})

test('unknown command exits 2 with usage on stderr', async () => {
  const c = capture()
  const code = await main(['wat'])
  c.restore()
  assert.equal(code, 2)
  assert.match(c.err(), /Usage: rness/)
})
