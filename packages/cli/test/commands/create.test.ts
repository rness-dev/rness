import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { run } from '../../src/cli.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { VERSION } from '../../src/version.ts'
import { capture } from '../helpers/capture.ts'
import { makeRemoteOrg } from '../helpers/remote-org.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

process.env['GIT_AUTHOR_NAME'] = 'rness-test'
process.env['GIT_AUTHOR_EMAIL'] = 'test@rness.invalid'
process.env['GIT_COMMITTER_NAME'] = 'rness-test'
process.env['GIT_COMMITTER_EMAIL'] = 'test@rness.invalid'

const execFileP = promisify(execFile)

async function scratch(
  t: Parameters<typeof makeWorkspace>[0]
): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-create-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  // A repository above the temp workspace: proves create's git init/commit/clone
  // never walk up into a parent repository (a plan-0003 lesson).
  await execFileP('git', ['init', '-q'], { cwd: dir })
  return dir
}

async function create(args: string[]) {
  const c = capture()
  const code = await run(['create', ...args])
  c.restore()
  return { code, out: c.out(), err: c.err() }
}

/**
 * An executable `<name>` first on `PATH` for the rest of the test, restored
 * afterwards. Tests run one at a time inside a file, so the mutation is
 * contained.
 */
async function fakeBin(
  t: Parameters<typeof makeWorkspace>[0],
  name: string,
  script: string[]
): Promise<void> {
  const binDir = await mkdtemp(join(tmpdir(), 'rness-bin-'))
  t.after(() => rm(binDir, { recursive: true, force: true }))
  const file = join(binDir, name)
  await writeFile(file, [...script, ''].join('\n'))
  await chmod(file, 0o755)
  const originalPath = process.env['PATH']
  process.env['PATH'] = `${binDir}:${originalPath ?? ''}`
  t.after(() => {
    if (originalPath === undefined) delete process.env['PATH']
    else process.env['PATH'] = originalPath
  })
}

test('new: scaffolds .rness with org and tokens, commits it, adds --repos, writes the blocks', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  const r = await create([
    'acme',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--host',
    remote.host,
    '--repos',
    'api',
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 0, r.err)
  const root = join(cwd, 'acme')
  assert.match(
    r.out,
    /^created {2}acme\/\.rness \(new workspace\)\nskipped {2}install \(--skip-install\)\ncloned {3}org\/api\ndeclared scope api \(org\/api\)\ncommitted acme\/\.rness\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n/
  )
  assert.match(r.out, /Next:\n[\s\S]*acme\/\.rness/)
  const m = await loadManifest(join(root, '.rness'))
  assert.equal(m.org, 'acme')
  assert.deepEqual(Object.keys(m.repos), ['api'])
  const pkg = JSON.parse(
    await readFile(join(root, '.rness', 'package.json'), 'utf8')
  ) as { devDependencies: Record<string, string>; packageManager: string }
  assert.equal(pkg.devDependencies['@rness/cli'], VERSION)
  assert.match(pkg.packageManager, /^npm@\d+\.\d+\.\d+/)
  await access(join(root, '.rness', '.gitignore'))
  const { stdout } = await execFileP('git', ['log', '--oneline', 'main'], {
    cwd: join(root, '.rness'),
  })
  assert.equal(
    stdout.trim(),
    stdout.trim().split('\n')[0],
    'exactly one commit'
  )
  assert.match(stdout, /chore: rness workspace context/)
  const { stdout: committed } = await execFileP(
    'git',
    ['show', 'main:rness.json'],
    { cwd: join(root, '.rness') }
  )
  assert.match(
    committed,
    /"api"/,
    'the --repos addition is part of the one commit, not left uncommitted'
  )
  await access(join(root, 'AGENTS.md'))
  await access(join(root, 'CLAUDE.md'))
  await access(join(root, 'org', 'api', 'AGENTS.md'))
})

test('join: clones the organisation .rness and syncs its repositories', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const apiUrl = await remote.addRepo('api', { 'README.md': '# api\n' })
  const manifest = {
    contract: 1,
    org: 'acme',
    repos: { api: { url: apiUrl } },
    scopes: { api: { path: 'org/api' } },
  }
  const contextUrl = await remote.addRepo('.rness', {
    'rness.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'standards/coding.md': '# Coding\n',
  })
  const cwd = await scratch(t)
  const r = await create([
    'acme',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--host',
    remote.host,
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^cloned {3}acme\/\.rness \(joined acme\)\nskipped {2}install \(--skip-install\)\ncloned {3}org\/api\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n$/
  )
  const root = join(cwd, 'acme')
  const { stdout } = await execFileP('git', ['remote', 'get-url', 'origin'], {
    cwd: join(root, '.rness'),
  })
  assert.equal(stdout.trim(), contextUrl)
  assert.match(
    await readFile(join(root, 'org', 'api', 'AGENTS.md'), 'utf8'),
    /standards\/coding\.md/
  )
})

test('join: --repos adds repositories the organisation has not declared yet', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  await remote.addRepo('.rness', {
    'rness.json': `${JSON.stringify({ contract: 1, org: 'acme', repos: {}, scopes: {} }, null, 2)}\n`,
    'standards/coding.md': '# Coding\n',
  })
  const cwd = await scratch(t)
  const r = await create([
    'acme',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--host',
    remote.host,
    '--repos',
    'api',
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^cloned {3}acme\/\.rness \(joined acme\)\nskipped {2}install \(--skip-install\)\ncloned {3}org\/api\ndeclared scope api \(org\/api\)\nupdated {2}AGENTS\.md\nupdated {2}org\/api\/AGENTS\.md\n$/
  )
  const root = join(cwd, 'acme')
  const m = await loadManifest(join(root, '.rness'))
  assert.deepEqual(m.repos, { api: { url: `${remote.host}acme/api.git` } })
  assert.deepEqual(m.scopes['api'], { path: 'org/api', extends: [] })
  await access(join(root, 'org', 'api', 'AGENTS.md'))
})

test('join: a pinned @rness/cli without its bin is an error, not a fallback', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('.rness', {
    'rness.json': `${JSON.stringify({ contract: 1, org: 'acme', repos: {}, scopes: {} }, null, 2)}\n`,
  })
  const cwd = await scratch(t)
  // An install that leaves the package's manifest but not its `dist/`: a
  // half-unpacked or hand-edited `node_modules`.
  await fakeBin(t, 'bun', [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    '  echo "1.0.0"',
    '  exit 0',
    'fi',
    'if [ "$1" = "install" ]; then',
    '  mkdir -p node_modules/@rness/cli',
    '  echo \'{"version":"0.3.0","bin":{"rness":"dist/bin/rness.js"}}\' > node_modules/@rness/cli/package.json',
    '  exit 0',
    'fi',
    'exit 0',
  ])
  const r = await create([
    'acme',
    '--yes',
    '--pm',
    'bun',
    '--host',
    remote.host,
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /^@rness\/cli in acme\/\.rness is not installed correctly \(missing dist\/bin\/rness\.js\); reinstall in \.rness\/\n$/
  )
})

test('guards: inside a workspace, non-empty target, --template, bad org, no TTY', async (t) => {
  const { host } = await makeRemoteOrg(t, 'acme')
  const inside = await makeWorkspace(t, { org: 'acme' })
  const r1 = await create([
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    host,
    '--cwd',
    inside,
  ])
  assert.equal(r1.code, 1)
  assert.match(r1.err, /already inside an rness workspace/)

  // The target is checked too: a `--dir` pointing into a workspace would nest
  // a second `.rness` under the first, however innocent the current directory.
  const outside = await scratch(t)
  const r1b = await create([
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    host,
    '--dir',
    join(inside, 'nested'),
    '--cwd',
    outside,
  ])
  assert.equal(r1b.code, 1)
  assert.match(r1b.err, /already inside an rness workspace/)
  await assert.rejects(access(join(inside, 'nested')))

  const cwd = await scratch(t)
  await mkdir(join(cwd, 'acme'))
  await writeFile(join(cwd, 'acme', 'stuff.txt'), 'x')
  const r2 = await create([
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    host,
    '--cwd',
    cwd,
  ])
  assert.equal(r2.code, 1)
  assert.match(r2.err, /acme is not empty/)

  const r3 = await create([
    'acme',
    '--yes',
    '--template',
    'saas',
    '--cwd',
    await scratch(t),
  ])
  assert.equal(r3.code, 2)
  assert.match(r3.err, /--template is reserved/)

  const r4 = await create(['Acme Inc', '--yes', '--cwd', await scratch(t)])
  assert.equal(r4.code, 2)
  assert.match(r4.err, /organisation name/)

  const r5 = await create([
    'acme',
    '--skip-install',
    '--host',
    host,
    '--cwd',
    await scratch(t),
  ])
  assert.equal(r5.code, 2)
  assert.match(r5.err, /pass --yes/)

  const r6 = await create([
    'acme',
    '--yes',
    '--pm',
    'cargo',
    '--cwd',
    await scratch(t),
  ])
  assert.equal(r6.code, 2)
  assert.match(r6.err, /--pm must be one of npm, pnpm, yarn, bun/)
})

test('a failed install after the scaffold copy is rolled back, not left dirty', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const cwd = await scratch(t)

  // A fake `bun` on PATH: `--version` succeeds (create needs it for the
  // package.json token before install ever runs), `install` fails offline
  // and deterministically, like a real registry outage would.
  await fakeBin(t, 'bun', [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    '  echo "1.0.0"',
    '  exit 0',
    'fi',
    'if [ "$1" = "install" ]; then',
    '  echo "bun install failed: network unreachable" 1>&2',
    '  exit 1',
    'fi',
    'exit 0',
  ])

  const r = await create([
    'acme',
    '--yes',
    '--pm',
    'bun',
    '--host',
    remote.host,
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 1)
  assert.match(r.err, /bun install failed/)
  assert.match(r.err, /removed acme\/\.rness/)
  assert.ok(
    r.err.indexOf('bun install failed') < r.err.indexOf('removed acme/.rness'),
    'the cause (the install failure) is reported before the consequence (the rollback)'
  )
  await assert.rejects(access(join(cwd, 'acme', '.rness')))
  await assert.rejects(
    access(join(cwd, 'acme')),
    'the target directory this call created goes too, so the retry is not refused as non-empty'
  )

  // `--dir .`: the target is the directory the command runs in. The rollback
  // must not pull the ground from under the user's shell.
  const here = join(cwd, 'here')
  await mkdir(here)
  const inPlace = await create([
    'acme',
    '--yes',
    '--pm',
    'bun',
    '--host',
    remote.host,
    '--dir',
    '.',
    '--cwd',
    here,
  ])
  assert.equal(inPlace.code, 1)
  assert.match(inPlace.err, /removed \.\/\.rness after the failure/)
  await assert.rejects(access(join(here, '.rness')))
  await access(here)
})

test('a successful install is reported and the workspace is complete', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  const cwd = await scratch(t)
  await fakeBin(t, 'bun', [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    '  echo "1.0.0"',
    '  exit 0',
    'fi',
    'if [ "$1" = "install" ]; then',
    '  mkdir -p node_modules',
    '  : > node_modules/.installed',
    '  exit 0',
    'fi',
    'exit 0',
  ])
  const r = await create([
    'acme',
    '--yes',
    '--pm',
    'bun',
    '--host',
    remote.host,
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^created {2}acme\/\.rness \(new workspace\)\n/)
  assert.match(r.out, /installed dependencies with bun\n/)
  await access(join(cwd, 'acme', '.rness', 'node_modules', '.installed'))
  await access(join(cwd, 'acme', 'AGENTS.md'))
})

test('a probe that cannot access the remote exits 1 and creates nothing', async (t) => {
  const cwd = await scratch(t)
  // After scratch(): its `git init` must run before the fake git shadows the
  // real one.
  await fakeBin(t, 'git', [
    '#!/bin/sh',
    'echo "fatal: could not read Username for \'https://github.com\': terminal prompts disabled" 1>&2',
    'exit 128',
  ])
  const r = await create([
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    'https://github.com/',
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 1)
  assert.match(r.err, /cannot access https:\/\/github\.com\/acme\/\.rness\.git/)
  await assert.rejects(access(join(cwd, 'acme')))
})

test('a repository that fails is reported and skipped; the workspace is still finished', async (t) => {
  const remote = await makeRemoteOrg(t, 'acme')
  await remote.addRepo('api', { 'README.md': '# api\n' })
  const cwd = await scratch(t)
  const r = await create([
    'acme',
    '--yes',
    '--skip-install',
    '--pm',
    'npm',
    '--host',
    remote.host,
    '--repos',
    'api,ghost',
    '--cwd',
    cwd,
  ])
  assert.equal(r.code, 1)
  assert.match(r.err, /^ghost: git clone failed: /m)
  const root = join(cwd, 'acme')
  assert.match(r.out, /cloned {3}org\/api\ndeclared scope api \(org\/api\)\n/)
  assert.match(r.out, /committed acme\/\.rness\n/)
  assert.match(r.out, /updated {2}org\/api\/AGENTS\.md\n/)
  assert.match(
    r.out,
    /Next:\n {2}cd acme\/\.rness\n {2}rness add ghost {3}# failed: git clone failed: /
  )
  assert.deepEqual(
    Object.keys((await loadManifest(join(root, '.rness'))).repos),
    ['api']
  )
  const { stdout: committed } = await execFileP(
    'git',
    ['show', 'main:rness.json'],
    { cwd: join(root, '.rness') }
  )
  assert.match(committed, /"api"/)
  await access(join(root, 'AGENTS.md'))
  await access(join(root, 'org', 'api', 'AGENTS.md'))

  // The install was skipped, so nothing installed `.rness/node_modules`; a
  // real run has it and takes the "already holds" branch below.
  await mkdir(join(root, '.rness', 'node_modules'))
  const again = await create([
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    remote.host,
    '--cwd',
    cwd,
  ])
  assert.equal(again.code, 1)
  assert.match(again.err, /already holds an rness workspace/)
})

test('re-running create points at rness add, or at the install a failed join left undone', async (t) => {
  const { host } = await makeRemoteOrg(t, 'acme')
  const cwd = await scratch(t)
  const first = await create([
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    host,
    '--cwd',
    cwd,
  ])
  assert.equal(first.code, 0, first.err)

  // What a join whose install failed leaves behind: a context clone with no
  // dependencies. `rness add` would only fail again — the install is the fix.
  const notInstalled = await create([
    'acme',
    '--yes',
    '--skip-install',
    '--pm',
    'pnpm',
    '--host',
    host,
    '--cwd',
    cwd,
  ])
  assert.equal(notInstalled.code, 1)
  assert.match(
    notInstalled.err,
    /^acme holds an rness workspace whose dependencies are not installed; cd acme\/\.rness && pnpm install, then rness sync\n$/
  )

  await mkdir(join(cwd, 'acme', '.rness', 'node_modules'))
  const again = await create([
    'acme',
    '--yes',
    '--skip-install',
    '--host',
    host,
    '--cwd',
    cwd,
  ])
  assert.equal(again.code, 1)
  assert.match(again.err, /already holds an rness workspace/)
})
