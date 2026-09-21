import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import {
  EXACT_VERSION,
  childEnv,
  ensureInstalled,
  hasLockfile,
  pinDrift,
  readPin,
  syncOutcome,
  workspacePackageManager,
  writePin,
} from '../../src/core/pinned.ts'

// Hand-formatted on purpose: writePin must keep every byte it does not own.
const PACKAGE_JSON = `{
  "name": "rness-context",
  "private": true,
  "packageManager": "pnpm@12.2.1",
  "engines": { "node": ">=24" },
  "devDependencies": {
    "@rness/cli": "0.4.0",
    "other": "0.4.0"
  }
}
`

async function rnessDir(t: TestContext, packageJson: string | null) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-pinned-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  if (packageJson !== null)
    await writeFile(join(dir, 'package.json'), packageJson)
  return dir
}

async function install(dir: string, version: string): Promise<void> {
  const pkg = join(dir, 'node_modules', '@rness', 'cli')
  await mkdir(pkg, { recursive: true })
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@rness/cli', version })
  )
}

test('readPin finds @rness/cli in devDependencies, then dependencies; null when absent', async (t) => {
  assert.deepEqual(await readPin(await rnessDir(t, PACKAGE_JSON)), {
    spec: '0.4.0',
    field: 'devDependencies',
  })
  assert.deepEqual(
    await readPin(
      await rnessDir(t, '{ "dependencies": { "@rness/cli": "^0.4.0" } }')
    ),
    { spec: '^0.4.0', field: 'dependencies' }
  )
  assert.equal(await readPin(await rnessDir(t, '{ "name": "x" }')), null)
  assert.equal(await readPin(await rnessDir(t, null)), null)
})

test('writePin replaces the version in place and keeps every other byte', async (t) => {
  const dir = await rnessDir(t, PACKAGE_JSON)
  await writePin(dir, '0.4.0', '0.5.0')
  assert.equal(
    await readFile(join(dir, 'package.json'), 'utf8'),
    PACKAGE_JSON.replace('"@rness/cli": "0.4.0"', '"@rness/cli": "0.5.0"')
  )
  await assert.rejects(
    writePin(dir, '0.4.0', '0.6.0'),
    /"@rness\/cli": "0\.4\.0" not found in package\.json/
  )
})

test('the package manager is the one package.json names, then the lockfile, then npm', async (t) => {
  assert.equal(
    await workspacePackageManager(await rnessDir(t, PACKAGE_JSON)),
    'pnpm'
  )
  for (const [lock, pm] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
  ] as const) {
    const dir = await rnessDir(t, '{ "name": "x" }')
    await writeFile(join(dir, lock), '')
    assert.equal(await workspacePackageManager(dir), pm, lock)
  }
  assert.equal(
    await workspacePackageManager(await rnessDir(t, '{ "name": "x" }')),
    'npm'
  )
  assert.equal(
    await workspacePackageManager(
      await rnessDir(t, '{ "packageManager": "rush@5.0.0" }')
    ),
    'npm',
    'an unknown manager is not trusted'
  )
})

test('pinDrift: an exact pin that is not the installed copy', async (t) => {
  const same = await rnessDir(t, PACKAGE_JSON)
  await install(same, '0.4.0')
  assert.equal(await pinDrift(same), null)

  const behind = await rnessDir(
    t,
    PACKAGE_JSON.replace('"@rness/cli": "0.4.0"', '"@rness/cli": "0.5.0"')
  )
  await install(behind, '0.4.0')
  assert.deepEqual(await pinDrift(behind), { pin: '0.5.0', installed: '0.4.0' })

  assert.deepEqual(await pinDrift(await rnessDir(t, PACKAGE_JSON)), {
    pin: '0.4.0',
    installed: null,
  })

  // A range says nothing precise about what should be installed.
  const range = await rnessDir(
    t,
    '{ "devDependencies": { "@rness/cli": "^0.4.0" } }'
  )
  assert.equal(await pinDrift(range), null)
  assert.equal(await pinDrift(await rnessDir(t, null)), null)
})

test('EXACT_VERSION accepts releases and pre-releases only', () => {
  for (const ok of ['0.5.0', '1.2.3', '1.2.3-rc.1', '10.20.30-beta.2'])
    assert.ok(EXACT_VERSION.test(ok), ok)
  for (const bad of ['^0.5.0', '1.x', 'latest', '1.2', 'v1.2.3', '1.2.3 '])
    assert.ok(!EXACT_VERSION.test(bad), bad)
})

test('childEnv forbids every prompt a delegated child could raise', () => {
  const env = childEnv({ PATH: '/usr/bin' })
  assert.equal(env['GIT_SSH_COMMAND'], 'ssh -o BatchMode=yes')
  assert.equal(env['GIT_TERMINAL_PROMPT'], '0')
  assert.equal(env['PATH'], '/usr/bin')
})

test('childEnv composes an ssh command the user already set', () => {
  const env = childEnv({ GIT_SSH_COMMAND: '/opt/1p/ssh -i ~/.ssh/work' })
  assert.equal(
    env['GIT_SSH_COMMAND'],
    '/opt/1p/ssh -i ~/.ssh/work -o BatchMode=yes'
  )
})

test('syncOutcome: blocks written, a failed clone is only a hint', () => {
  const outcome = syncOutcome({
    code: 1,
    stdout: 'updated  AGENTS.md\nnot cloned: web (rness add web)\n',
    stderr: 'org/web: git clone failed: Permission denied (publickey).\n',
  })
  assert.equal(outcome.code, 0)
  assert.deepEqual(outcome.errors, [])
  assert.deepEqual(outcome.hints, [
    'not cloned: web (rness add web)',
    'org/web: git clone failed: Permission denied (publickey).',
  ])
})

test('syncOutcome: nothing written keeps the failure', () => {
  const outcome = syncOutcome({
    code: 1,
    stdout: '',
    stderr: 'rness.json is malformed\n',
  })
  assert.equal(outcome.code, 1)
  assert.deepEqual(outcome.errors, ['rness.json is malformed'])
  assert.deepEqual(outcome.hints, [])
})

test('syncOutcome: a clean run stays clean', () => {
  const outcome = syncOutcome({
    code: 0,
    stdout: 'unchanged AGENTS.md\n',
    stderr: '',
  })
  assert.equal(outcome.code, 0)
  assert.deepEqual(outcome.hints, [])
  assert.deepEqual(outcome.errors, [])
})

test('syncOutcome: publickey failure points at the agent when ssh works', () => {
  const outcome = syncOutcome(
    {
      code: 1,
      stdout: 'updated  AGENTS.md\n',
      stderr: 'org/web: git clone failed: Permission denied (publickey).\n',
    },
    { sshWorks: true }
  )
  assert.equal(outcome.code, 0)
  assert.ok(outcome.hints.some((l) => l.includes('ssh-add')))
})

test('syncOutcome: no agent hint when the parent never proved ssh works', () => {
  const outcome = syncOutcome({
    code: 1,
    stdout: 'updated  AGENTS.md\n',
    stderr: 'org/web: git clone failed: Permission denied (publickey).\n',
  })
  assert.ok(!outcome.hints.some((l) => l.includes('ssh-add')))
})

test('hasLockfile answers for one manager, not for any lockfile', async (t) => {
  const bare = await rnessDir(t, PACKAGE_JSON)
  assert.equal(await hasLockfile(bare, 'pnpm'), false)
  const locked = await rnessDir(t, PACKAGE_JSON)
  await writeFile(join(locked, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  assert.equal(await hasLockfile(locked, 'pnpm'), true)
  // `npm ci` next to a pnpm lockfile fails outright: it is not frozen-capable
  // here, whatever other manager left a lockfile behind.
  assert.equal(await hasLockfile(locked, 'npm'), false)
})

const DRIFTING = PACKAGE_JSON.replace(
  '"@rness/cli": "0.4.0"',
  '"@rness/cli": "0.5.1"'
)

async function installedCli(dir: string, version: string): Promise<void> {
  const pkg = join(dir, 'node_modules', '@rness', 'cli')
  await mkdir(pkg, { recursive: true })
  await writeFile(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@rness/cli', version, bin: 'dist/bin/rness.js' })
  )
}

test('ensureInstalled: nothing to do when the pin is installed', async (t) => {
  const dir = await rnessDir(t, PACKAGE_JSON)
  await installedCli(dir, '0.4.0')
  assert.equal(await ensureInstalled(dir, { env: {} }), null)
})

test('ensureInstalled: drift installs frozen and announces the pin', async (t) => {
  const dir = await rnessDir(t, DRIFTING)
  await installedCli(dir, '0.5.0')
  await writeFile(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  const calls: unknown[] = []
  const announced: string[] = []
  const outcome = await ensureInstalled(dir, {
    env: {},
    announce: (pin) => announced.push(pin),
    install: (pm, d, o) => {
      calls.push([pm, d, o])
      return Promise.resolve()
    },
  })
  assert.deepEqual(outcome, { installed: true, pin: '0.5.1', reason: null })
  assert.deepEqual(announced, ['0.5.1'])
  assert.deepEqual(calls, [['pnpm', dir, { frozen: true }]])
})

test('ensureInstalled: RNESS_NO_INSTALL=1 installs nothing', async (t) => {
  const dir = await rnessDir(t, DRIFTING)
  await installedCli(dir, '0.5.0')
  let called = false
  const outcome = await ensureInstalled(dir, {
    env: { RNESS_NO_INSTALL: '1' },
    install: () => {
      called = true
      return Promise.resolve()
    },
  })
  assert.equal(called, false)
  assert.equal(outcome?.installed, false)
  assert.equal(outcome?.reason, 'RNESS_NO_INSTALL=1')
})

test('ensureInstalled: a failed install reports why and does not throw', async (t) => {
  const dir = await rnessDir(t, DRIFTING)
  await installedCli(dir, '0.5.0')
  const outcome = await ensureInstalled(dir, {
    env: {},
    install: () =>
      Promise.reject(new Error('pnpm ci failed in .rness: offline')),
  })
  assert.equal(outcome?.installed, false)
  assert.match(outcome?.reason ?? '', /offline/)
})
