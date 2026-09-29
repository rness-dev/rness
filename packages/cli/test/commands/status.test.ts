import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { type TestContext, test } from 'node:test'

import { run } from '../../src/cli.ts'
import { statusCommand } from '../../src/commands/status.ts'
import { capture } from '../helpers/capture.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const doc = (status: string, title: string) =>
  `---\nstatus: ${status}\n---\n\n# ${title}\n`

async function workspace(t: TestContext) {
  return makeWorkspace(t, {
    org: 'acme',
    files: {
      'adr/0001-org.md': doc('Accepted', '0001 — A workspace is an org'),
      'specs/0002-b.md': doc('Approved', '0002 — Second'),
      'specs/0001-a.md': doc('Implemented', '0001 — First'),
    },
  })
}

test('off a terminal: Markdown, every tab or the one named', async (t) => {
  const root = await workspace(t)
  const c = capture()
  const code = await run(['status', '--cwd', root])
  c.restore()
  assert.equal(code, 0, c.err())
  assert.match(c.out(), /^acme · status\n\n## ADR \(1\)\n/)
  assert.match(c.out(), /\n\| 0002 \| Second \| Approved \|\n/)
  assert.match(c.out(), /\n## Plans \(0\)\n\n_Nothing yet\._\n$/)

  const one = capture()
  assert.equal(await run(['status', 'SPECS', '--cwd', root]), 0)
  one.restore()
  assert.match(one.out(), /^acme · status\n\n## Specs \(2\)\n/)
  assert.doesNotMatch(one.out(), /ADR/)
})

test('an unknown tab is a usage error naming the tabs', async (t) => {
  const root = await workspace(t)
  const c = capture()
  const code = await run(['status', 'kanban', '--cwd', root])
  c.restore()
  assert.equal(code, 2)
  assert.equal(c.err(), 'unknown tab "kanban" (tabs: adr, specs, plans)\n')
})

/** A terminal the view can take: keys in, screens out, its raw mode recorded. */
function fakeTerminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    raw: [] as boolean[],
    setRawMode(on: boolean) {
      input.raw.push(on)
      return input
    },
  })
  let written = ''
  const output = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 60,
    rows: 10,
    write(chunk: string) {
      written += chunk
      return true
    },
  })
  return {
    terminal: {
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    },
    input,
    output,
    written: () => written,
  }
}

/** Wait for `cond`, the view's reads and redraws being asynchronous. */
async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 2000
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Plain text: the active tab between brackets instead of reverse video. */
function noColor(t: TestContext): void {
  process.env['NO_COLOR'] = '1'
  t.after(() => {
    delete process.env['NO_COLOR']
  })
}

const screens = (out: string) => out.split('\x1b[H').length - 1

test('in a terminal: the alternate screen, a tab per arrow, a redraw on resize, q restores the screen', async (t) => {
  noColor(t)
  const root = await workspace(t)
  const fake = fakeTerminal()
  const done = statusCommand(undefined, { cwd: root }, fake.terminal)
  // Once drawn: one tab right, a resize, then close.
  await until(() => screens(fake.written()) === 1)
  fake.input.write('\x1b[C')
  await until(() => screens(fake.written()) === 2)
  fake.output.columns = 40
  fake.output.emit('resize')
  fake.input.write('q')
  assert.equal(await done, 0)

  const out = fake.written()
  assert.ok(
    out.startsWith('\x1b[?1049h\x1b[?25l'),
    'enters the alternate screen'
  )
  assert.ok(out.endsWith('\x1b[?25h\x1b[?1049l'), 'leaves it last')
  const drawn = out.split('\x1b[H').slice(1)
  assert.equal(
    drawn.length,
    3,
    'drawn, then after the arrow, then after the resize'
  )
  assert.match(drawn[0] ?? '', /\[ADR \(1\)\]/)
  assert.match(drawn[1] ?? '', /\[Specs \(2\)\]/)
  assert.match(drawn[1] ?? '', /0002 {2}Second/)
  assert.deepEqual(fake.input.raw, [true, false])
})

test('in a terminal, a tab named opens the view on it', async (t) => {
  noColor(t)
  const root = await workspace(t)
  const fake = fakeTerminal()
  const done = statusCommand('plans', { cwd: root }, fake.terminal)
  await until(() => screens(fake.written()) === 1)
  fake.input.write('\x03') // Ctrl+C closes too
  assert.equal(await done, 0)
  assert.match(fake.written(), /\[Plans \(0\)\]/)
  assert.match(fake.written(), /Nothing here yet\./)
})
