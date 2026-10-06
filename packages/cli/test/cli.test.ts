import assert from 'node:assert/strict'
import { test } from 'node:test'

import { run } from '../src/cli.ts'
import { VERSION } from '../src/version.ts'
import { capture } from './helpers/capture.ts'
import { makeWorkspace } from './helpers/workspace.ts'

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

test('hook --help names its four events', async () => {
  const c = capture()
  const code = await run(['hook', '--help'])
  c.restore()
  assert.equal(code, 0)
  assert.match(
    c.out(),
    /^ {2}event\s+session-start, pre-tool-use, post-tool-use or session-end$/m
  )
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

test('the help lists board and note, not pulse; board has push, neither create nor eject (spec 0033 §1)', async () => {
  const c = capture()
  assert.equal(await run(['--help']), 0)
  c.restore()
  assert.match(c.out(), /^ {2}board\b/m)
  assert.match(c.out(), /^ {2}note\b/m)
  assert.doesNotMatch(c.out(), /pulse/)
  const b = capture()
  assert.equal(await run(['board', '--help']), 0)
  b.restore()
  assert.match(b.out(), /^ {2}push\b/m)
  assert.doesNotMatch(b.out(), /^ {2}(create|eject|run|sync)\b/m)
})

test('rness pulse <command> runs its new command, said once on stderr; mark exits 0 and does nothing (spec 0033 §2)', async (t) => {
  const cwd = await makeWorkspace(t, { boards: { pulse: 'agent-pulse' } })
  const as = async (args: string[]) => {
    const c = capture()
    const code = await run([...args, '--cwd', cwd])
    c.restore()
    return { code, out: c.out(), err: c.err() }
  }
  const now = await as(['board', 'push'])
  const was = await as(['pulse', 'sync'])
  assert.equal(now.code, 1)
  assert.equal(was.code, now.code)
  assert.equal(was.out, now.out)
  assert.equal(was.err, `rness pulse sync is now rness board push\n${now.err}`)
  const note = await as(['pulse', 'note', 'Kept the header.'])
  const newNote = await as(['note', 'Kept the header.'])
  assert.equal(note.code, newNote.code)
  assert.equal(note.err, `rness pulse note is now rness note\n${newNote.err}`)
  const mark = await as(['pulse', 'mark', '--session', 's', '--path', 'a.md'])
  assert.deepEqual(mark, { code: 0, out: '', err: '' })
})
