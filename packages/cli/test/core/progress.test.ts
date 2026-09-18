import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import { step } from '../../src/core/progress.ts'

function stream(isTTY: boolean) {
  const chunks: string[] = []
  const s = Object.assign(new PassThrough(), {
    isTTY,
    getColorDepth: () => 8,
  }) as unknown as NodeJS.WriteStream
  s.on('data', (c: Buffer) => chunks.push(c.toString()))
  return { s, written: () => chunks.join('') }
}

test('off a terminal a step writes nothing: the output is what it always was', async () => {
  const out = stream(false)
  const value = await step(
    { label: 'cloning  org/api', animate: true, stream: out.s },
    async () => 42
  )
  assert.equal(value, 42)
  assert.equal(out.written(), '')
})

test('on a terminal the label is shown, then erased — also when the work throws', async (t) => {
  const saved = { CI: process.env['CI'], TERM: process.env['TERM'] }
  delete process.env['CI']
  process.env['TERM'] = 'xterm-256color'
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  const clear = `\r${String.fromCharCode(27)}[2K`
  for (const animate of [true, false]) {
    const out = stream(true)
    await step(
      { label: 'cloning  org/api', animate, stream: out.s },
      async () => undefined
    )
    assert.ok(out.written().includes('cloning  org/api'))
    assert.ok(out.written().endsWith(clear), 'the line is erased')
  }
  const out = stream(true)
  await assert.rejects(
    step({ label: 'installing', animate: true, stream: out.s }, async () => {
      throw new Error('boom')
    }),
    /boom/
  )
  assert.ok(out.written().endsWith(clear))

  process.env['CI'] = 'true'
  const ci = stream(true)
  await step({ label: 'x', animate: true, stream: ci.s }, async () => undefined)
  assert.equal(ci.written(), '', 'CI is not a place for transient lines')
})
