import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { run } from '../../src/cli.ts'
import { capture } from '../helpers/capture.ts'

const scopedCwd = fileURLToPath(new URL('../fixtures/ws-scoped/org/web', import.meta.url))
const cycleCwd = fileURLToPath(new URL('../fixtures/ws-cycle', import.meta.url))
const badJsonCwd = fileURLToPath(new URL('../fixtures/ws-badjson', import.meta.url))

interface Emitted {
  scope: string | null
  collections: Array<{ name: string; files: Array<{ rel: string }> }>
}

test('--json emits the resolved scope and collections', async () => {
  const c = capture()
  const code = await run(['context', '--scope', 'web', '--json', '--cwd', scopedCwd])
  c.restore()
  assert.equal(code, 0)
  const parsed = JSON.parse(c.out()) as Emitted
  assert.equal(parsed.scope, 'web')
  const standards = parsed.collections.find((x) => x.name === 'standards')
  assert.deepEqual(standards?.files.map((f) => f.rel), ['web/seo.md', 'platform/deploy.md', 'global.md'])
})

test('resolves scope from --cwd when --scope is absent', async () => {
  const c = capture()
  const code = await run(['context', '--json', '--cwd', scopedCwd])
  c.restore()
  assert.equal(code, 0)
  assert.equal((JSON.parse(c.out()) as Emitted).scope, 'web')
})

test('markdown output carries provenance markers', async () => {
  const c = capture()
  const code = await run(['context', '--scope', 'web', '--cwd', scopedCwd])
  c.restore()
  assert.equal(code, 0)
  assert.match(c.out(), /## standards/)
  assert.match(c.out(), /<!-- rness: standards\/web\/seo\.md -->/)
})

test('unknown --scope returns 1 with a message on stderr', async () => {
  const c = capture()
  const code = await run(['context', '--scope', 'ghost', '--cwd', scopedCwd])
  c.restore()
  assert.equal(code, 1)
  assert.match(c.err(), /unknown scope/)
})

test('an extends cycle is a handled error, not a stack trace', async () => {
  const c = capture()
  const code = await run(['context', '--scope', 'alpha', '--cwd', cycleCwd])
  c.restore()
  assert.equal(code, 1)
  assert.match(c.err(), /cycle/)
  assert.doesNotMatch(c.err(), /at .*\.ts:\d+/)
})

test('a malformed rness.json is a handled error', async () => {
  const c = capture()
  const code = await run(['context', '--cwd', badJsonCwd])
  c.restore()
  assert.equal(code, 1)
  assert.match(c.err(), /rness\.json:/)
})

test('RNESS_DEBUG=1 prints the stack instead of the message', async () => {
  const previous = process.env['RNESS_DEBUG']
  process.env['RNESS_DEBUG'] = '1'
  try {
    const c = capture()
    const code = await run(['context', '--cwd', badJsonCwd])
    c.restore()
    assert.equal(code, 1)
    assert.match(c.err(), /^Error: rness\.json:[^\n]*\n\s+at /)
  } finally {
    if (previous === undefined) delete process.env['RNESS_DEBUG']
    else process.env['RNESS_DEBUG'] = previous
  }
})

test('RNESS_DEBUG=0 prints the plain message, no stack', async () => {
  const previous = process.env['RNESS_DEBUG']
  process.env['RNESS_DEBUG'] = '0'
  try {
    const c = capture()
    const code = await run(['context', '--cwd', badJsonCwd])
    c.restore()
    assert.equal(code, 1)
    assert.match(c.err(), /^rness\.json:/)
    assert.doesNotMatch(c.err(), /\n    at /)
  } finally {
    if (previous === undefined) delete process.env['RNESS_DEBUG']
    else process.env['RNESS_DEBUG'] = previous
  }
})

test('outside any workspace is a handled error', async () => {
  const c = capture()
  const code = await run(['context', '--cwd', '/'])
  c.restore()
  assert.equal(code, 1)
  assert.match(c.err(), /no rness workspace/)
})

test('a prototype-chain name is not a real scope', async () => {
  const c = capture()
  const code = await run(['context', '--scope', 'constructor', '--cwd', scopedCwd])
  c.restore()
  assert.equal(code, 1)
  assert.match(c.err(), /unknown scope/)
})

test('an unknown flag is bad usage, exit 2', async () => {
  const c = capture()
  const code = await run(['context', '--bogus', '--cwd', scopedCwd])
  c.restore()
  assert.equal(code, 2)
  assert.match(c.err(), /unknown option '--bogus'/)
})

test('--scope as the final arg with no value is bad usage, exit 2', async () => {
  const c = capture()
  const code = await run(['context', '--cwd', scopedCwd, '--scope'])
  c.restore()
  assert.equal(code, 2)
  assert.match(c.err(), /argument missing/)
})
