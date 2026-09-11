import { test } from 'node:test'
import assert from 'node:assert/strict'
import { run } from '../src/cli.ts'
import { VERSION } from '../src/version.ts'
import { capture } from './helpers/capture.ts'

test('--version prints the package version and exits 0', async () => {
  const c = capture()
  const code = await run(['--version'])
  c.restore()
  assert.equal(code, 0)
  assert.equal(c.out().trim(), VERSION)
})

test('--help prints usage and exits 0', async () => {
  const c = capture()
  const code = await run(['--help'])
  c.restore()
  assert.equal(code, 0)
  assert.match(c.out(), /Usage: rness/)
  assert.match(c.out(), /context/)
  assert.match(c.out(), /validate/)
})

test('no arguments prints usage and exits 0', async () => {
  const c = capture()
  const code = await run([])
  c.restore()
  assert.equal(code, 0)
  assert.match(c.out(), /Usage: rness/)
})

test('unknown command exits 2 with usage on stderr', async () => {
  const c = capture()
  const code = await run(['wat'])
  c.restore()
  assert.equal(code, 2)
  assert.match(c.err(), /unknown command 'wat'/)
  assert.match(c.err(), /Usage: rness/)
})

test('a name inherited from Object.prototype is not a command', async () => {
  const c = capture()
  const code = await run(['constructor'])
  c.restore()
  assert.equal(code, 2)
  assert.match(c.err(), /unknown command/)
})

test('the internal --cwd option is hidden from help', async () => {
  const c = capture()
  const code = await run(['context', '--help'])
  c.restore()
  assert.equal(code, 0)
  assert.doesNotMatch(c.out(), /--cwd/)
  assert.match(c.out(), /--scope <name>/)
})

test('help with an unknown command name is bad usage, exit 2', async () => {
  const c = capture()
  const code = await run(['help', 'wat'])
  c.restore()
  assert.equal(code, 2)
  assert.match(c.err(), /Usage: rness/)
})

test('a lone -- is bad usage, exit 2', async () => {
  const c = capture()
  const code = await run(['--'])
  c.restore()
  assert.equal(code, 2)
})
