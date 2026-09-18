import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { upgradeCommand } from '../../src/commands/upgrade.ts'
import type { Prompts, Terminal } from '../../src/core/terminal.ts'
import { capture } from '../helpers/capture.ts'

const NEW_WORKFLOW_RUN = `npx --yes "@rness/cli@$(node -p "require('./package.json').devDependencies['@rness/cli']")" validate`

const packageJson = (pin: string) => `{
  "name": "rness-context",
  "private": true,
  "packageManager": "npm@11.0.0",
  "engines": { "node": ">=24" },
  "devDependencies": {
    "@rness/cli": "${pin}"
  }
}
`

const workflow = (run: string) =>
  `jobs:\n  validate:\n    steps:\n      - run: ${run}\n`

/**
 * `npm` first on PATH: `view` answers FAKE_NPM_LATEST (or fails), `install`
 * materialises the pinned @rness/cli — a bin that prints what it was asked —
 * or fails as npm does when FAKE_NPM_FAIL is set.
 */
async function fakeNpm(
  t: TestContext,
  env: { latest?: string; fail?: boolean }
): Promise<void> {
  const binDir = await mkdtemp(join(tmpdir(), 'rness-npm-'))
  t.after(() => rm(binDir, { recursive: true, force: true }))
  const file = join(binDir, 'npm')
  await writeFile(
    file,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  view)',
      '    [ -n "$FAKE_NPM_LATEST" ] || { echo "npm error code ENOTFOUND" >&2; exit 1; }',
      '    echo "$FAKE_NPM_LATEST" ;;',
      '  install)',
      '    if [ -n "$FAKE_NPM_FAIL" ]; then',
      '      echo "npm error code ETARGET" >&2',
      '      echo "npm error notarget No matching version found for @rness/cli." >&2',
      '      exit 1',
      '    fi',
      `    v=$("${process.execPath}" -p "require('./package.json').devDependencies['@rness/cli']")`,
      '    mkdir -p node_modules/@rness/cli/dist/bin',
      '    echo "{\\"name\\":\\"@rness/cli\\",\\"version\\":\\"$v\\",\\"bin\\":{\\"rness\\":\\"dist/bin/rness.js\\"}}" > node_modules/@rness/cli/package.json',
      "    echo \"console.log('PINNED $v ' + process.argv.slice(2).join(' '))\" > node_modules/@rness/cli/dist/bin/rness.js ;;",
      'esac',
      '',
    ].join('\n')
  )
  await chmod(file, 0o755)
  const saved = {
    PATH: process.env['PATH'],
    FAKE_NPM_LATEST: process.env['FAKE_NPM_LATEST'],
    FAKE_NPM_FAIL: process.env['FAKE_NPM_FAIL'],
  }
  process.env['PATH'] = `${binDir}:${saved.PATH ?? ''}`
  if (env.latest === undefined) delete process.env['FAKE_NPM_LATEST']
  else process.env['FAKE_NPM_LATEST'] = env.latest
  if (env.fail === true) process.env['FAKE_NPM_FAIL'] = '1'
  else delete process.env['FAKE_NPM_FAIL']
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

async function workspace(
  t: TestContext,
  spec: { pin: string; installed?: string; workflows?: Record<string, string> }
): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rness-up-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const rnessDir = join(root, '.rness')
  await mkdir(join(root, 'org'), { recursive: true })
  await mkdir(rnessDir, { recursive: true })
  await writeFile(
    join(rnessDir, 'rness.json'),
    JSON.stringify({ contract: 1, org: 'acme', repos: {}, scopes: {} })
  )
  await writeFile(join(rnessDir, 'package.json'), packageJson(spec.pin))
  if (spec.installed !== undefined) {
    const pkg = join(rnessDir, 'node_modules', '@rness', 'cli')
    await mkdir(pkg, { recursive: true })
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@rness/cli', version: spec.installed })
    )
  }
  for (const [name, content] of Object.entries(spec.workflows ?? {})) {
    await mkdir(join(rnessDir, '.github', 'workflows'), { recursive: true })
    await writeFile(join(rnessDir, '.github', 'workflows', name), content)
  }
  return root
}

const NO_TTY: Terminal = {
  isTty: () => false,
  prompts: async () => {
    throw new Error('no prompt without a terminal')
  },
}

async function upgrade(
  version: string | undefined,
  opts: Parameters<typeof upgradeCommand>[1],
  terminal: Terminal = NO_TTY
) {
  const c = capture()
  try {
    const code = await upgradeCommand(version, opts, terminal)
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

const read = (root: string, ...rel: string[]) =>
  readFile(join(root, '.rness', ...rel), 'utf8')

test('upgrade pins the latest version in place, installs, and syncs through the new copy', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const label = `${basename(root)}/.rness`
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 0, r.err)
  assert.equal(await read(root, 'package.json'), packageJson('0.5.0'))
  assert.equal(
    r.out,
    [
      `upgrade  @rness/cli 0.4.0 → 0.5.0 in ${label} (npm)`,
      'notes    https://github.com/rness-dev/rness/tree/main/packages/cli#readme',
      'installed dependencies with npm',
      'PINNED 0.5.0 sync --yes',
      '',
      `upgraded ${label} to @rness/cli 0.5.0`,
      '',
      'Next:',
      '  git -C .rness add -A && git -C .rness commit -m "chore: rness 0.5.0"',
      '  # teammates: git pull, then npm install in .rness',
      '',
    ].join('\n')
  )
})

test("the scaffold's old workflow line is migrated; a foreign workflow naming the old version is reported", async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const foreign = workflow('npx @rness/cli@0.4.0 sync --check')
  const root = await workspace(t, {
    pin: '0.4.0',
    installed: '0.4.0',
    workflows: {
      'validate.yml': workflow('npx --yes @rness/cli@0.4.0 validate'),
      'other.yml': foreign,
    },
  })
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 0, r.err)
  assert.equal(
    await read(root, '.github', 'workflows', 'validate.yml'),
    workflow(NEW_WORKFLOW_RUN)
  )
  assert.equal(await read(root, '.github', 'workflows', 'other.yml'), foreign)
  assert.match(
    r.out,
    /^updated {2}\.github\/workflows\/validate\.yml \(it now reads the version from package\.json\)$/m
  )
  assert.match(
    r.err,
    /^warning: \.github\/workflows\/other\.yml names @rness\/cli@0\.4\.0; update it by hand$/m
  )
})

test('a failed install restores package.json and the workflow', async (t) => {
  await fakeNpm(t, { latest: '0.5.0', fail: true })
  const old = workflow('npx --yes @rness/cli@0.4.0 validate')
  const root = await workspace(t, {
    pin: '0.4.0',
    installed: '0.4.0',
    workflows: { 'validate.yml': old },
  })
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /npm install failed in .*: npm error notarget No matching version found for @rness\/cli\.\nrestored .*\.rness\/package\.json/
  )
  assert.equal(await read(root, 'package.json'), packageJson('0.4.0'))
  assert.equal(await read(root, '.github', 'workflows', 'validate.yml'), old)
})

test('already at the target: nothing runs; a pin ahead of the installed copy is repaired by installing', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const done = await workspace(t, { pin: '0.5.0', installed: '0.5.0' })
  const r = await upgrade(undefined, { yes: true, cwd: done })
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out, 'already at 0.5.0\n')

  const drifted = await workspace(t, { pin: '0.5.0', installed: '0.4.0' })
  const r2 = await upgrade(undefined, { yes: true, cwd: drifted })
  assert.equal(r2.code, 0, r2.err)
  assert.match(
    r2.out,
    /^install {2}@rness\/cli 0\.5\.0 in .*\.rness \(npm\) — 0\.4\.0 is installed\n/
  )
  assert.match(r2.out, /^PINNED 0\.5\.0 sync --yes$/m)
  assert.equal(await read(drifted, 'package.json'), packageJson('0.5.0'))
})

test('usage and refusals', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })

  const range = await upgrade('1.x', { yes: true, cwd: root })
  assert.equal(range.code, 2)
  assert.equal(
    range.err,
    'version "1.x" is not an exact version (for example 0.5.0)\n'
  )

  const noTty = await upgrade(undefined, { cwd: root })
  assert.equal(noTty.code, 2)
  assert.match(noTty.err, /pass --yes to run without a prompt/)

  const outside = await upgrade(undefined, { yes: true, cwd: '/' })
  assert.equal(outside.code, 1)
  assert.match(outside.err, /no rness workspace/)
  assert.equal(await read(root, 'package.json'), packageJson('0.4.0'))
})

test('the registry is asked only when no version is named; unreachable, it says what to type', async (t) => {
  await fakeNpm(t, {})
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 1)
  assert.equal(
    r.err,
    'cannot reach the registry; name the version: rness upgrade <version>\n'
  )
  const named = await upgrade('0.6.0', { yes: true, cwd: root })
  assert.equal(named.code, 0, named.err)
  assert.equal(await read(root, 'package.json'), packageJson('0.6.0'))
})

test('a lower version is a downgrade only when it is named', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const ahead = await workspace(t, {
    pin: '0.6.0-rc.1',
    installed: '0.6.0-rc.1',
  })
  const r = await upgrade(undefined, { yes: true, cwd: ahead })
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /pins @rness\/cli 0\.6\.0-rc\.1, newer than the latest release 0\.5\.0; to downgrade: rness upgrade 0\.5\.0\n$/
  )
  const named = await upgrade('0.5.0', { yes: true, cwd: ahead })
  assert.equal(named.code, 0, named.err)
  assert.match(
    named.out,
    /^upgrade {2}@rness\/cli 0\.6\.0-rc\.1 → 0\.5\.0 .* — downgrading\n/
  )
})

test('in a terminal one confirmation; declining writes nothing', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const asked: string[] = []
  const terminal = (answer: boolean): Terminal => ({
    isTty: () => true,
    prompts: async () =>
      ({
        async confirm(o: { message: string }) {
          asked.push(o.message)
          return answer
        },
        isCancel: () => false,
      }) as unknown as Prompts,
  })
  const no = await upgrade(undefined, { cwd: root }, terminal(false))
  assert.equal(no.code, 1)
  assert.equal(no.err, 'cancelled\n')
  assert.equal(await read(root, 'package.json'), packageJson('0.4.0'))
  const yes = await upgrade(undefined, { cwd: root }, terminal(true))
  assert.equal(yes.code, 0, yes.err)
  assert.deepEqual(asked, [
    'Upgrade @rness/cli to 0.5.0?',
    'Upgrade @rness/cli to 0.5.0?',
  ])
})
