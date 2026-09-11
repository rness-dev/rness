import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises'
import { openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VERSION } from '../src/version.ts'

const execFileP = promisify(execFile)
const binPath = fileURLToPath(new URL('../src/bin/rness.ts', import.meta.url))
// Every test but the delegation one must exercise *this* source tree, even
// once this workspace's .rness/package.json pins a published @rness/cli.
const noDelegate = { ...process.env, RNESS_NO_DELEGATE: '1' }

async function tmp(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

async function workspace(root: string): Promise<void> {
  await mkdir(join(root, '.rness', 'standards'), { recursive: true })
  await writeFile(
    join(root, '.rness', 'rness.json'),
    JSON.stringify({ contract: 1, repos: {}, scopes: { web: { path: 'org/web' } } }),
  )
}

test('runs when executed directly as a script', async () => {
  const { stdout } = await execFileP(process.execPath, [binPath, '--version'], { env: noDelegate })
  assert.equal(stdout.trim(), VERSION)
})

test('runs when invoked through a bin symlink', async (t) => {
  const dir = await tmp('rness-bin-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const link = join(dir, 'rness')
  await symlink(binPath, link)
  const { stdout } = await execFileP(process.execPath, [link, '--version'], { env: noDelegate })
  assert.equal(stdout.trim(), VERSION)
})

test('exit code 2 on bad usage, 1 outside a workspace', async () => {
  await assert.rejects(execFileP(process.execPath, [binPath, 'wat'], { env: noDelegate }), (e: { code?: number }) => e.code === 2)
  await assert.rejects(
    execFileP(process.execPath, [binPath, 'validate'], { cwd: '/', env: noDelegate }),
    (e: { code?: number; stderr?: string }) => e.code === 1 && /no rness workspace/.test(e.stderr ?? ''),
  )
})

test('delegates to the workspace-pinned @rness/cli when versions differ', async (t) => {
  const root = await tmp('rness-pinned-')
  t.after(() => rm(root, { recursive: true, force: true }))
  await workspace(root)
  const pkg = join(root, '.rness', 'node_modules', '@rness', 'cli')
  await mkdir(join(pkg, 'dist'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@rness/cli', version: '9.9.9', type: 'module' }))
  await writeFile(
    join(pkg, 'dist', 'index.js'),
    'export async function run(argv) { process.stdout.write(`DELEGATED 9.9.9 ${argv.join(" ")}\\n`); return 7 }\n',
  )
  const cwd = join(root, 'org', 'web')
  await mkdir(cwd, { recursive: true })

  const delegated = (await execFileP(process.execPath, [binPath, 'validate', '--json'], { cwd }).catch(
    (e: { code: number; stdout: string }) => e,
  )) as { code: number; stdout: string }
  assert.equal(delegated.code, 7)
  assert.equal(delegated.stdout.trim(), 'DELEGATED 9.9.9 validate --json')

  const bypassed = await execFileP(process.execPath, [binPath, 'validate'], { cwd, env: { ...process.env, RNESS_NO_DELEGATE: '1' } })
  assert.equal(bypassed.stdout.trim(), 'context ok')

  const create = (await execFileP(process.execPath, [binPath, 'create', 'acme'], { cwd }).catch(
    (e: { code: number; stdout: string; stderr: string }) => e,
  )) as { code: number; stdout: string; stderr: string }
  assert.equal(create.code, 2, 'create never delegates; 0.2.0 has no create command so it is bad usage')
  assert.doesNotMatch(create.stdout, /DELEGATED/)
})

test('piped stdout is not truncated at the 64 KiB pipe buffer', async (t) => {
  const ws = await tmp('rness-pipe-')
  t.after(() => rm(ws, { recursive: true, force: true }))
  await workspace(ws)
  const big = `# Big\n\n${'lorem ipsum dolor sit amet '.repeat(4000)}\n`
  await writeFile(join(ws, '.rness', 'standards', 'big.md'), big)
  assert.ok(Buffer.byteLength(big) > 65536)

  const { stdout: piped } = await execFileP(
    process.execPath,
    [binPath, 'context', '--scope', 'web', '--json'],
    { cwd: ws, env: noDelegate, maxBuffer: 64 * 1024 * 1024 },
  )

  const outPath = join(ws, 'out.json')
  const fd = openSync(outPath, 'w')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, 'context', '--scope', 'web', '--json'], {
      cwd: ws,
      env: noDelegate,
      stdio: ['ignore', fd, 'inherit'],
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
  })
  closeSync(fd)
  const redirected = await readFile(outPath)

  assert.doesNotThrow(() => JSON.parse(piped), 'piped --json output is valid JSON')
  assert.ok(Buffer.byteLength(piped) > 65536, `piped output clamped to ${Buffer.byteLength(piped)} bytes`)
  assert.equal(Buffer.byteLength(piped), redirected.length)
})
