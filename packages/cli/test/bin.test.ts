import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

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
    JSON.stringify({
      contract: 1,
      repos: {},
      scopes: { web: { path: 'org/web' } },
    })
  )
}

test('runs when executed directly as a script', async () => {
  const { stdout } = await execFileP(process.execPath, [binPath, '--version'], {
    env: noDelegate,
  })
  assert.equal(stdout.trim(), VERSION)
})

test('runs when invoked through a bin symlink', async (t) => {
  const dir = await tmp('rness-bin-')
  t.after(() => rm(dir, { recursive: true, force: true }))
  const link = join(dir, 'rness')
  await symlink(binPath, link)
  const { stdout } = await execFileP(process.execPath, [link, '--version'], {
    env: noDelegate,
  })
  assert.equal(stdout.trim(), VERSION)
})

test('exit code 2 on bad usage, 1 outside a workspace', async () => {
  await assert.rejects(
    execFileP(process.execPath, [binPath, 'wat'], { env: noDelegate }),
    (e: { code?: number }) => e.code === 2
  )
  await assert.rejects(
    execFileP(process.execPath, [binPath, 'validate'], {
      cwd: '/',
      env: noDelegate,
    }),
    (e: { code?: number; stderr?: string }) =>
      e.code === 1 && /no rness workspace/.test(e.stderr ?? '')
  )
})

test('delegates to the workspace-pinned @rness/cli when versions differ', async (t) => {
  const root = await tmp('rness-pinned-')
  t.after(() => rm(root, { recursive: true, force: true }))
  await workspace(root)
  const pkg = join(root, '.rness', 'node_modules', '@rness', 'cli')
  await mkdir(join(pkg, 'dist'), { recursive: true })
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@rness/cli', version: '9.9.9', type: 'module' })
  )
  await writeFile(
    join(pkg, 'dist', 'index.js'),
    'export async function run(argv) { process.stdout.write(`DELEGATED 9.9.9 ${argv.join(" ")}\\n`); return 7 }\n'
  )
  const cwd = join(root, 'org', 'web')
  await mkdir(cwd, { recursive: true })

  const delegated = (await execFileP(
    process.execPath,
    [binPath, 'validate', '--json'],
    { cwd }
  ).catch((e: { code: number; stdout: string }) => e)) as {
    code: number
    stdout: string
  }
  assert.equal(delegated.code, 7)
  assert.equal(delegated.stdout.trim(), 'DELEGATED 9.9.9 validate --json')

  const bypassed = await execFileP(process.execPath, [binPath, 'validate'], {
    cwd,
    env: { ...process.env, RNESS_NO_DELEGATE: '1' },
  })
  assert.equal(bypassed.stdout.trim(), 'context ok')

  const notOne = (await execFileP(process.execPath, [binPath, 'validate'], {
    cwd,
    env: { ...process.env, RNESS_NO_DELEGATE: '0' },
  }).catch((e: { code: number; stdout: string }) => e)) as {
    code: number
    stdout: string
  }
  assert.equal(notOne.code, 7, 'RNESS_NO_DELEGATE=0 still delegates')
  assert.match(notOne.stdout, /^DELEGATED 9\.9\.9/)

  const traced = await execFileP(process.execPath, [binPath, 'validate'], {
    cwd,
    env: { ...process.env, RNESS_DEBUG: '1' },
  }).catch((e: { code: number; stdout: string; stderr: string }) => e)
  assert.match(
    traced.stderr,
    /^rness: delegating to @rness\/cli 9\.9\.9 \(.*dist\/index\.js\)\n/
  )

  const create = (await execFileP(
    process.execPath,
    [binPath, 'create', '--org', 'acme'],
    { cwd }
  ).catch((e: { code: number; stdout: string; stderr: string }) => e)) as {
    code: number
    stdout: string
    stderr: string
  }
  assert.equal(
    create.code,
    1,
    'create never delegates; it runs the local command, which refuses (cwd is already inside a workspace)'
  )
  assert.match(create.stderr, /already inside an rness workspace/)
  assert.doesNotMatch(create.stdout, /DELEGATED/)
})

test('a pinned package.json without dist/index.js fails loudly, not silently', async (t) => {
  const root = await tmp('rness-broken-')
  t.after(() => rm(root, { recursive: true, force: true }))
  await workspace(root)
  const pkg = join(root, '.rness', 'node_modules', '@rness', 'cli')
  await mkdir(pkg, { recursive: true })
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@rness/cli', version: '9.9.9', type: 'module' })
  )
  const cwd = join(root, 'org', 'web')
  await mkdir(cwd, { recursive: true })

  const failure = (await execFileP(process.execPath, [binPath, 'validate'], {
    cwd,
  }).catch((e: { code: number; stderr: string }) => e)) as {
    code: number
    stderr: string
  }
  assert.equal(failure.code, 1)
  assert.match(failure.stderr, /not installed correctly/)
})

test('a delegate run() that resolves to a non-number exits 1, not 0', async (t) => {
  const root = await tmp('rness-nonnum-')
  t.after(() => rm(root, { recursive: true, force: true }))
  await workspace(root)
  const pkg = join(root, '.rness', 'node_modules', '@rness', 'cli')
  await mkdir(join(pkg, 'dist'), { recursive: true })
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@rness/cli', version: '9.9.9', type: 'module' })
  )
  await writeFile(
    join(pkg, 'dist', 'index.js'),
    "export async function run() { return 'seven' }\n"
  )
  const cwd = join(root, 'org', 'web')
  await mkdir(cwd, { recursive: true })

  await assert.rejects(
    execFileP(process.execPath, [binPath, 'validate'], { cwd }),
    (e: { code?: number }) => e.code === 1
  )
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
    { cwd: ws, env: noDelegate, maxBuffer: 64 * 1024 * 1024 }
  )

  const outPath = join(ws, 'out.json')
  const fd = openSync(outPath, 'w')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [binPath, 'context', '--scope', 'web', '--json'],
      {
        cwd: ws,
        env: noDelegate,
        stdio: ['ignore', fd, 'inherit'],
      }
    )
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`exit ${code}`))
    )
  })
  closeSync(fd)
  const redirected = await readFile(outPath)

  assert.doesNotThrow(
    () => JSON.parse(piped),
    'piped --json output is valid JSON'
  )
  assert.ok(
    Buffer.byteLength(piped) > 65536,
    `piped output clamped to ${Buffer.byteLength(piped)} bytes`
  )
  assert.equal(Buffer.byteLength(piped), redirected.length)
})

test('a reader closing the pipe early (`rness context | head`) ends quietly with exit 0', async (t) => {
  const ws = await tmp('rness-epipe-')
  t.after(() => rm(ws, { recursive: true, force: true }))
  await workspace(ws)
  // Larger than the pipe buffer, so the CLI is still writing when the reader leaves.
  await writeFile(
    join(ws, '.rness', 'standards', 'big.md'),
    `# Big\n\n${'lorem ipsum dolor sit amet '.repeat(4000)}\n`
  )

  const result = await new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [binPath, 'context', '--scope', 'web', '--json'],
        {
          cwd: ws,
          env: noDelegate,
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      )
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      // Close the read end before the CLI writes anything: every write then hits
      // a pipe with no reader — what `head` leaves behind once it has its lines.
      child.stdout?.destroy()
      child.on('error', reject)
      child.on('exit', (code) => resolve({ code, stderr }))
    }
  )

  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
})

test('upgrade is served by the invoked copy, never by the pinned one; other commands warn about a drifted pin', async (t) => {
  const root = await tmp('rness-drift-')
  t.after(() => rm(root, { recursive: true, force: true }))
  await workspace(root)
  await writeFile(
    join(root, '.rness', 'package.json'),
    JSON.stringify({
      packageManager: 'pnpm@12.2.1',
      devDependencies: { '@rness/cli': '9.9.10' },
    })
  )
  const pkg = join(root, '.rness', 'node_modules', '@rness', 'cli')
  await mkdir(join(pkg, 'dist'), { recursive: true })
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@rness/cli', version: '9.9.9', type: 'module' })
  )
  await writeFile(
    join(pkg, 'dist', 'index.js'),
    'export async function run(argv) { process.stdout.write(`DELEGATED ${argv.join(" ")}\\n`); return 0 }\n'
  )
  const env = { ...process.env }
  delete env['RNESS_NO_DELEGATE']

  // `upgrade --help` (and its alias) come from this source tree.
  for (const name of ['upgrade', 'update']) {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [binPath, name, '--help'],
      { cwd: root, env }
    )
    assert.match(stdout, /Usage: rness upgrade\|update \[options\] \[version\]/)
    assert.doesNotMatch(stdout, /DELEGATED/)
    assert.equal(stderr, '', 'no drift warning on upgrade')
  }

  // Any other command is delegated, after one warning on stderr.
  const { stdout, stderr } = await execFileP(
    process.execPath,
    [binPath, 'validate'],
    { cwd: root, env }
  )
  assert.equal(stdout, 'DELEGATED validate\n')
  assert.equal(
    stderr,
    `warning: ${root.split('/').at(-1)}/.rness pins @rness/cli 9.9.10 but 9.9.9 is installed — run pnpm install in .rness\n`
  )
})

test('colour and the banner need a terminal (or FORCE_COLOR); a piped help is plain', async () => {
  const ESC = String.fromCharCode(27)
  const plainEnv: NodeJS.ProcessEnv = { ...noDelegate }
  delete plainEnv['FORCE_COLOR']
  const forced = { ...noDelegate, FORCE_COLOR: '1' }
  const help = (args: string[], env: NodeJS.ProcessEnv) =>
    execFileP(process.execPath, [binPath, ...args], { env }).then(
      (r) => r.stdout
    )

  for (const args of [[], ['--help'], ['sync', '--help']]) {
    const plain = await help(args, plainEnv)
    assert.ok(!plain.includes(ESC), `no escape sequence: ${args.join(' ')}`)
    assert.ok(!plain.includes('█'), `no banner: ${args.join(' ')}`)
    assert.match(plain, /^Usage: rness/)
  }

  for (const args of [[], ['--help']]) {
    const painted = await help(args, forced)
    assert.ok(painted.includes(ESC))
    assert.match(painted, /█▀█ █▄ █ █▀▀ █▀▀ █▀▀/)
    assert.ok(painted.includes(`rness v${VERSION}`))
  }
  const sub = await help(['sync', '--help'], forced)
  assert.ok(sub.includes(ESC), 'a sub-command help is painted')
  assert.ok(!sub.includes('█'), 'and has no banner')
})

test('login, logout and git-credential concern the machine: never delegated, and silent about a drifted pin', async (t) => {
  const root = await tmp('rness-machine-')
  t.after(() => rm(root, { recursive: true, force: true }))
  await workspace(root)
  await writeFile(
    join(root, '.rness', 'package.json'),
    JSON.stringify({ devDependencies: { '@rness/cli': '9.9.10' } })
  )
  const pkg = join(root, '.rness', 'node_modules', '@rness', 'cli')
  await mkdir(join(pkg, 'dist'), { recursive: true })
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@rness/cli', version: '9.9.9', type: 'module' })
  )
  await writeFile(
    join(pkg, 'dist', 'index.js'),
    'export async function run() { process.stdout.write("DELEGATED\\n"); return 0 }\n'
  )
  const config = await tmp('rness-machine-config-')
  t.after(() => rm(config, { recursive: true, force: true }))
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: config }
  delete env['RNESS_NO_DELEGATE']
  delete env['GITHUB_TOKEN']
  delete env['GH_TOKEN']
  // git runs the helper from inside a clone, on every fetch.
  const cwd = join(root, 'org', 'web')
  await mkdir(cwd, { recursive: true })

  const child = spawn(process.execPath, [binPath, 'git-credential', 'get'], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString()))
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()))
  child.stdin.end('protocol=https\nhost=github.com\n\n')
  const code = await new Promise<number | null>((r) => child.on('close', r))
  assert.equal(code, 0)
  assert.equal(stdout, '', 'not logged in: git is told nothing')
  assert.equal(stderr, '', 'no drift warning, no delegation')

  for (const name of ['login', 'logout']) {
    const help = await execFileP(process.execPath, [binPath, name, '--help'], {
      cwd,
      env,
    })
    assert.match(help.stdout, new RegExp(`^Usage: rness ${name}`))
    assert.equal(help.stderr, '')
  }
})
