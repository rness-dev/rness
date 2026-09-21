import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  CATCH_UP_DONE,
  OWN_COMMANDS,
  catchUp,
} from '../../src/core/catch-up.ts'

const execFileP = promisify(execFile)
const indexPath = fileURLToPath(new URL('../../src/index.ts', import.meta.url))

/** A workspace whose `.rness` pins one version and holds another (or none). */
async function drifting(
  t: TestContext,
  pin: string,
  installed: string | null
): Promise<{ root: string; rnessDir: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rness-catchup-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const rnessDir = join(root, '.rness')
  await mkdir(join(rnessDir, 'standards'), { recursive: true })
  await writeFile(
    join(rnessDir, 'rness.json'),
    JSON.stringify({ contract: 1, repos: {}, scopes: {} })
  )
  await writeFile(
    join(rnessDir, 'package.json'),
    JSON.stringify({
      packageManager: 'pnpm@12.2.1',
      devDependencies: { '@rness/cli': pin },
    })
  )
  await writeFile(join(rnessDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  if (installed !== null) await installCli(rnessDir, installed)
  return { root, rnessDir }
}

async function installCli(rnessDir: string, version: string): Promise<void> {
  const pkg = join(rnessDir, 'node_modules', '@rness', 'cli')
  await mkdir(pkg, { recursive: true })
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@rness/cli', version, bin: 'dist/bin/rness.js' })
  )
}

test('a drift is installed, then the command is handed to the freshly installed bin', async (t) => {
  const { root, rnessDir } = await drifting(t, '9.9.10', '9.9.9')
  const env: NodeJS.ProcessEnv = {}
  const installs: unknown[] = []
  const spawns: unknown[] = []
  const stderr: string[] = []
  const code = await catchUp(['sync', '--check'], {
    cwd: root,
    env,
    stderr: (s) => stderr.push(s),
    install: async (pm, dir, opts) => {
      installs.push([pm, dir, opts])
      await installCli(rnessDir, '9.9.10')
    },
    spawn: (bin, argv, cwd) => {
      spawns.push([bin, argv, cwd])
      return 7
    },
  })
  assert.equal(code, 7, "the child's exit code is the command's")
  assert.deepEqual(installs, [['pnpm', rnessDir, { frozen: true }]])
  assert.deepEqual(spawns, [
    [
      join(
        rnessDir,
        'node_modules',
        '@rness',
        'cli',
        'dist',
        'bin',
        'rness.js'
      ),
      ['sync', '--check'],
      root,
    ],
  ])
  assert.deepEqual(stderr, ['installing @rness/cli 9.9.10 in .rness…\n'])
  assert.equal(env[CATCH_UP_DONE], '1')
})

test('no drift: nothing is installed, nothing is spawned, the caller carries on', async (t) => {
  const { root } = await drifting(t, '9.9.9', '9.9.9')
  const code = await catchUp(['validate'], {
    cwd: root,
    env: {},
    install: () => assert.fail('no install without a drift'),
    spawn: () => assert.fail('no hand-off without a drift'),
  })
  assert.equal(code, null)
})

test('a failed install is a warning; the caller runs the command anyway', async (t) => {
  const { root } = await drifting(t, '9.9.10', '9.9.9')
  const stderr: string[] = []
  const code = await catchUp(['validate'], {
    cwd: root,
    env: {},
    stderr: (s) => stderr.push(s),
    install: () => Promise.reject(new Error('registry unreachable')),
    spawn: () => assert.fail('no hand-off after a failed install'),
  })
  assert.equal(code, null)
  assert.match(
    stderr.join(''),
    /pins @rness\/cli 9\.9\.10 but 9\.9\.9 is installed/
  )
})

test('an install that leaves the drift open is never handed off: the child would install again', async (t) => {
  const { root } = await drifting(t, '9.9.10', '9.9.9')
  const code = await catchUp(['validate'], {
    cwd: root,
    env: {},
    stderr: () => {},
    install: () => Promise.resolve(),
    spawn: () => assert.fail('the drift is still open'),
  })
  assert.equal(code, null)
})

test('the launcher already tried: the delegated copy does not try again', async (t) => {
  const { root } = await drifting(t, '9.9.10', '9.9.9')
  const code = await catchUp(['validate'], {
    cwd: root,
    env: { [CATCH_UP_DONE]: '1' },
    install: () => assert.fail('one attempt per invocation'),
    spawn: () => assert.fail('one attempt per invocation'),
  })
  assert.equal(code, null)
})

test('commands that concern the machine, help flags, and RNESS_NO_DELEGATE never catch up', async (t) => {
  const { root } = await drifting(t, '9.9.10', '9.9.9')
  const never = {
    cwd: root,
    install: () => assert.fail('no install here'),
    spawn: () => assert.fail('no hand-off here'),
  }
  for (const command of OWN_COMMANDS)
    assert.equal(await catchUp([command], { ...never, env: {} }), null)
  assert.ok(OWN_COMMANDS.includes('git-credential'), 'runs on every git fetch')
  assert.equal(await catchUp([], { ...never, env: {} }), null)
  assert.equal(await catchUp(['--help'], { ...never, env: {} }), null)
  assert.equal(
    await catchUp(['validate'], { ...never, env: { RNESS_NO_DELEGATE: '1' } }),
    null
  )
})

test('outside a workspace there is nothing to catch up with', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-nows-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  assert.equal(await catchUp(['validate'], { cwd: dir, env: {} }), null)
})

// A launcher older than 0.5.1 knows nothing about drift: it imports the
// installed copy's `run` and calls it. That `run` is the seam — RNESS_NO_INSTALL
// keeps this test off the registry, and the warning proves the check ran.
test("the package's exported run() checks the drift itself, for launchers that never did", async (t) => {
  const { root } = await drifting(t, '9.9.10', '9.9.9')
  const env: NodeJS.ProcessEnv = { ...process.env, RNESS_NO_INSTALL: '1' }
  delete env['RNESS_NO_DELEGATE']
  delete env[CATCH_UP_DONE]
  const script = `const { run } = await import(${JSON.stringify(indexPath)}); process.exitCode = await run(['validate'])`
  const { stdout, stderr } = await execFileP(
    process.execPath,
    ['--input-type=module', '-e', script],
    { cwd: root, env }
  )
  assert.match(stdout, /context ok/)
  assert.match(
    stderr,
    /^warning: .*\.rness pins @rness\/cli 9\.9\.10 but 9\.9\.9 is installed/m
  )
})
