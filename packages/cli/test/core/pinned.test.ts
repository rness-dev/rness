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
  pinDrift,
  readPin,
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
