import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { main } from '../src/cli.mjs'

const execFileP = promisify(execFile)
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

function capture() {
  const out = []
  const err = []
  const w = process.stdout.write.bind(process.stdout)
  const e = process.stderr.write.bind(process.stderr)
  // Only intercept string writes (the CLI's output); forward everything else
  // (Buffer writes, encoding/callback args) untouched so the test runner's
  // process-isolation IPC on stdout is not swallowed.
  process.stdout.write = (...args) => (typeof args[0] === 'string' ? (out.push(args[0]), true) : w(...args))
  process.stderr.write = (...args) => (typeof args[0] === 'string' ? (err.push(args[0]), true) : e(...args))
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

test('runs when executed directly as a script', async () => {
  const { stdout } = await execFileP(process.execPath, [cliPath, '--version'])
  assert.match(stdout, /^\d+\.\d+\.\d+\s*$/)
})

test('runs when invoked through a bin symlink', async (t) => {
  const { mkdtemp, symlink } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'rness-bin-'))
  const link = join(dir, 'rness')
  await symlink(cliPath, link)
  const { stdout } = await execFileP(process.execPath, [link, '--version'])
  assert.match(stdout, /^\d+\.\d+\.\d+\s*$/)
})
