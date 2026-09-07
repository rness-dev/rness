import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  const { symlink } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'rness-bin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const link = join(dir, 'rness')
  await symlink(cliPath, link)
  const { stdout } = await execFileP(process.execPath, [link, '--version'])
  assert.match(stdout, /^\d+\.\d+\.\d+\s*$/)
})

test('piped stdout is not truncated at the 64 KiB pipe buffer (C1)', async (t) => {
  const ws = await mkdtemp(join(tmpdir(), 'rness-pipe-'))
  t.after(() => rm(ws, { recursive: true, force: true }))
  const rnessDir = join(ws, '.rness')
  await mkdir(join(rnessDir, 'standards'), { recursive: true })
  await writeFile(
    join(rnessDir, 'rness.json'),
    JSON.stringify({ contract: 1, repos: {}, scopes: { web: { path: 'org/web' } } }),
  )
  // ~100 KB of markdown at the collection root (global -> included for any scope).
  const big = `# Big\n\n${'lorem ipsum dolor sit amet '.repeat(4000)}\n`
  await writeFile(join(rnessDir, 'standards', 'big.md'), big)
  assert.ok(Buffer.byteLength(big) > 65536)

  // Path 1: stdout captured through a pipe (execFile), the way jq/wc/$(...) see it.
  const { stdout: piped } = await execFileP(
    process.execPath,
    [cliPath, 'context', '--scope', 'web', '--json'],
    { cwd: ws, maxBuffer: 64 * 1024 * 1024 },
  )

  // Path 2: stdout redirected to a file.
  const outPath = join(ws, 'out.json')
  const fd = openSync(outPath, 'w')
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'context', '--scope', 'web', '--json'], {
      cwd: ws,
      stdio: ['ignore', fd, 'inherit'],
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
  })
  closeSync(fd)
  const redirected = await readFile(outPath)

  // The pipe output must be complete: valid JSON, larger than the pipe buffer,
  // and byte-identical in length to the file-redirect output.
  assert.doesNotThrow(() => JSON.parse(piped), 'piped --json output is valid JSON')
  assert.ok(
    Buffer.byteLength(piped) > 65536,
    `piped output clamped to ${Buffer.byteLength(piped)} bytes`,
  )
  assert.notEqual(Buffer.byteLength(piped), 65536)
  assert.equal(Buffer.byteLength(piped), redirected.length)
})
