// cli/test/commands/context.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { contextCommand } from '../../src/commands/context.mjs'

const scopedCwd = fileURLToPath(new URL('../fixtures/ws-scoped/org/web', import.meta.url))

function capture() {
  const out = []
  const w = process.stdout.write.bind(process.stdout)
  // Only intercept string writes (the command's output); forward everything
  // else (Buffer writes) so the test runner's process-isolation IPC on stdout
  // is not swallowed. See cli/test/cli.test.mjs for the same guard.
  process.stdout.write = (...args) =>
    typeof args[0] === 'string' ? (out.push(args[0]), true) : w(...args)
  return { restore: () => (process.stdout.write = w), text: () => out.join('') }
}

test('--json emits the resolved scope and collections', async () => {
  const c = capture()
  const code = await contextCommand(['--scope', 'web', '--json', '--cwd', scopedCwd])
  c.restore()
  assert.equal(code, 0)
  const parsed = JSON.parse(c.text())
  assert.equal(parsed.scope, 'web')
  const standards = parsed.collections.find((x) => x.name === 'standards')
  assert.deepEqual(standards.files.map((f) => f.rel), ['web/seo.md', 'platform/deploy.md', 'global.md'])
})

test('markdown output carries provenance markers', async () => {
  const c = capture()
  const code = await contextCommand(['--scope', 'web', '--cwd', scopedCwd])
  c.restore()
  assert.equal(code, 0)
  assert.match(c.text(), /## standards/)
  assert.match(c.text(), /<!-- rness: standards\/web\/seo\.md -->/)
})

test('unknown --scope returns 1', async () => {
  const code = await contextCommand(['--scope', 'ghost', '--cwd', scopedCwd])
  assert.equal(code, 1)
})
