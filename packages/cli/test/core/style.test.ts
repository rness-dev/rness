import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { type TestContext, test } from 'node:test'

import { banner, paint, status, toneOf, unicode } from '../../src/core/style.ts'

const ESC = `${String.fromCharCode(27)}[`

/** A stream that says it is a terminal, with `depth` bits of colour. */
function terminal(depth: 8 | 24): NodeJS.WriteStream {
  return Object.assign(new PassThrough(), {
    isTTY: true,
    getColorDepth: () => depth,
    hasColors: (count = 16) => count <= 2 ** depth,
  }) as unknown as NodeJS.WriteStream
}
const pipe = new PassThrough() as unknown as NodeJS.WriteStream

function withEnv(t: TestContext, key: string, value: string): void {
  const original = process.env[key]
  process.env[key] = value
  t.after(() => {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  })
}

test('plain for a stream that is not a terminal; painted for one that is', () => {
  assert.equal(paint('done', 'created', pipe), 'created')
  const painted = paint('done', 'created', terminal(8))
  assert.ok(painted.startsWith(ESC), JSON.stringify(painted))
  assert.ok(painted.includes('created'))
})

test('NO_COLOR silences a terminal; FORCE_COLOR paints a pipe', (t) => {
  withEnv(t, 'NO_COLOR', '1')
  assert.equal(paint('done', 'created', terminal(24)), 'created')
  delete process.env['NO_COLOR']
  withEnv(t, 'FORCE_COLOR', '1')
  assert.ok(paint('done', 'created', pipe).startsWith(ESC))
})

test('the status column keeps the spacing every line had before it was painted', () => {
  assert.equal(status('created', 'acme/.rness', pipe), 'created  acme/.rness')
  assert.equal(status('cloned', 'org/api', pipe), 'cloned   org/api')
  assert.equal(status('found', 'acme/.rness', pipe), 'found    acme/.rness')
  assert.equal(status('unchanged', 'AGENTS.md', pipe), 'unchanged AGENTS.md')
  assert.equal(
    status('not found', 'acme/.rness', pipe),
    'not found acme/.rness'
  )
  assert.equal(status('declared', 'scope api', pipe), 'declared scope api')
  // Only the verb is painted: the rest stays readable on any background.
  const line = status('cloned', 'org/api', terminal(8))
  assert.ok(line.endsWith('   org/api'), JSON.stringify(line))
})

test('tones: what changed, what did not, progress, staleness', () => {
  for (const verb of ['created', 'cloned', 'updated', 'upgraded', 'installed'])
    assert.equal(toneOf(verb), 'done', verb)
  for (const verb of ['unchanged', 'skipped', 'not cloned'])
    assert.equal(toneOf(verb), 'idle', verb)
  for (const verb of ['listing', 'checking', 'using', 'found', 'not found'])
    assert.equal(toneOf(verb), 'info', verb)
  assert.equal(toneOf('stale'), 'warn')
  assert.equal(toneOf('anything else'), 'info')
})

test('the banner: nothing off a terminal, a gradient only in true colour', () => {
  assert.equal(banner('0.5.0', pipe), '')
  const plain = banner('0.5.0', terminal(8))
  assert.match(plain, /█▀█ █▄ █ █▀▀ █▀▀ █▀▀/)
  assert.match(plain, /rness v0\.5\.0/)
  assert.ok(!plain.includes(`${ESC}38;2;`), 'no 24-bit escape at 8 bits')
  assert.ok(banner('0.5.0', terminal(24)).includes(`${ESC}38;2;`))
})

test('unicode: everywhere but the Linux console (and a legacy Windows one)', (t) => {
  if (process.platform === 'win32') return
  withEnv(t, 'TERM', 'xterm-256color')
  assert.equal(unicode(), true)
  process.env['TERM'] = 'linux'
  assert.equal(unicode(), false)
})
