import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { promisify } from 'node:util'

import { type UpgradeDeps, upgradeCommand } from '../../src/commands/upgrade.ts'
import { renderScaffold } from '../../src/core/scaffold-copy.ts'
import { scaffoldDir } from '../../src/core/scaffold.ts'
import type { Prompts, Terminal } from '../../src/core/terminal.ts'
import { capture } from '../helpers/capture.ts'

process.env['GIT_AUTHOR_NAME'] = 'rness-test'
process.env['GIT_AUTHOR_EMAIL'] = 'test@rness.invalid'
process.env['GIT_COMMITTER_NAME'] = 'rness-test'
process.env['GIT_COMMITTER_EMAIL'] = 'test@rness.invalid'

const execFileP = promisify(execFile)
const git = async (dir: string, ...args: string[]) =>
  (await execFileP('git', args, { cwd: dir })).stdout.trim()

const PM = 'npm@11.0.0'

/** package.json as the scaffold renders it for `pin`. */
async function scaffoldPackage(pin: string): Promise<string> {
  const files = await renderScaffold(scaffoldDir(), {
    version: pin,
    packageManager: PM,
  })
  return files.find((f) => f.path === 'package.json')?.content ?? ''
}

/**
 * `npm` first on PATH: `view` answers FAKE_NPM_LATEST (or fails), `install`
 * materialises the pinned @rness/cli — a bin that prints what it was asked —
 * or fails as npm does when FAKE_NPM_FAIL is set; `pack` builds a tarball of
 * FAKE_NPM_SCAFFOLD as the package's scaffold.
 */
async function fakeNpm(
  t: TestContext,
  env: { latest?: string; fail?: boolean; scaffold?: string }
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
      '  pack)',
      '    dest="$4"; stage=$(mktemp -d)',
      '    mkdir -p "$stage/package" && cp -R "$FAKE_NPM_SCAFFOLD" "$stage/package/scaffold"',
      '    tar -czf "$dest/rness-cli.tgz" -C "$stage" package && echo rness-cli.tgz ;;',
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
    FAKE_NPM_SCAFFOLD: process.env['FAKE_NPM_SCAFFOLD'],
  }
  process.env['PATH'] = `${binDir}:${saved.PATH ?? ''}`
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  set('FAKE_NPM_LATEST', env.latest)
  set('FAKE_NPM_FAIL', env.fail === true ? '1' : undefined)
  set('FAKE_NPM_SCAFFOLD', env.scaffold)
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) set(key, value)
  })
}

/**
 * A workspace as `create` leaves it: `.rness` a repository whose one commit
 * holds the scaffold rendered for `pin` — the base of the next merge. The
 * subject and trailer can be changed to model older or hand-made ones.
 */
async function workspace(
  t: TestContext,
  spec: {
    pin: string
    installed?: string
    subject?: string
    trailer?: string | null
  }
): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rness-up-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const rnessDir = join(root, '.rness')
  await mkdir(join(root, 'org'), { recursive: true })
  await mkdir(rnessDir, { recursive: true })
  for (const f of await renderScaffold(scaffoldDir(), {
    version: spec.pin,
    packageManager: PM,
  })) {
    const to = join(rnessDir, ...f.path.split('/'))
    await mkdir(dirname(to), { recursive: true })
    await writeFile(to, f.content, { mode: f.executable ? 0o755 : 0o644 })
  }
  await writeFile(
    join(rnessDir, 'rness.json'),
    JSON.stringify({ contract: 1, org: 'acme', repos: {}, scopes: {} })
  )
  await git(rnessDir, 'init', '-q', '-b', 'main')
  await git(rnessDir, 'add', '-A')
  const trailer =
    spec.trailer === undefined ? `Rness-Scaffold: ${spec.pin}` : spec.trailer
  const subject = spec.subject ?? 'chore: rness workspace context'
  await git(
    rnessDir,
    'commit',
    '-q',
    '-m',
    trailer === null ? subject : `${subject}\n\n${trailer}`
  )
  if (spec.installed !== undefined) {
    const pkg = join(rnessDir, 'node_modules', '@rness', 'cli')
    await mkdir(join(pkg, 'dist', 'bin'), { recursive: true })
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: '@rness/cli',
        version: spec.installed,
        bin: { rness: 'dist/bin/rness.js' },
      })
    )
    await writeFile(
      join(pkg, 'dist', 'bin', 'rness.js'),
      `console.log('PINNED ${spec.installed} ' + process.argv.slice(2).join(' '))\n`
    )
  }
  return root
}

/** A copy of the scaffold with one file changed, as a later version would ship it. */
async function changedScaffold(
  t: TestContext,
  path: string,
  change: (text: string) => string
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rness-next-scaffold-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await cp(scaffoldDir(), dir, { recursive: true })
  const file = join(dir, ...path.split('/'))
  await writeFile(file, change(await readFile(file, 'utf8')))
  return dir
}

const NO_TTY: Terminal = {
  isTty: () => false,
  prompts: async () => {
    throw new Error('no prompt without a terminal')
  },
}

/** The scaffold of every target is the one in these sources, unless a test says otherwise. */
const SAME_SCAFFOLD: UpgradeDeps = {
  scaffoldFor: async () => ({ dir: scaffoldDir() }),
}

async function upgrade(
  version: string | undefined,
  opts: Parameters<typeof upgradeCommand>[1],
  terminal: Terminal = NO_TTY,
  deps: UpgradeDeps = SAME_SCAFFOLD
) {
  const c = capture()
  try {
    const code = await upgradeCommand(version, opts, terminal, deps)
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

const read = (root: string, ...rel: string[]) =>
  readFile(join(root, '.rness', ...rel), 'utf8')

test('upgrade merges the target scaffold, pins, installs, syncs through the new copy, and commits', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const label = `${basename(root)}/.rness`
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 0, r.err)
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.5.0'))
  assert.equal(
    r.out,
    [
      `upgrade  @rness/cli 0.4.0 → 0.5.0 in ${label} (npm)`,
      'notes    https://github.com/rness-dev/rness/tree/main/packages/cli#readme',
      'merging  the @rness/cli 0.5.0 scaffold',
      'updated  package.json',
      'installed dependencies with npm',
      'PINNED 0.5.0 sync --yes',
      `committed ${label} — chore: rness 0.5.0`,
      '',
      `upgraded ${label} to @rness/cli 0.5.0`,
      '',
      'Next:',
      '  git -C .rness push',
      '  # teammates: git pull — the next rness command installs it',
      '',
    ].join('\n')
  )
  // One commit records the merge, and the next base is 0.5.0.
  assert.equal(await git(join(root, '.rness'), 'status', '--porcelain'), '')
  assert.match(
    await git(join(root, '.rness'), 'log', '--topo-order', '--format=%s'),
    /^chore: rness 0\.5\.0\nchore: rness scaffold 0\.5\.0\nchore: rness workspace context$/
  )
})

test("a scaffold change reaches an untouched file; the team's edit of another stays", async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  await writeFile(
    join(rnessDir, 'README.md'),
    `Team intro.\n\n${await read(root, 'README.md')}`
  )
  await git(rnessDir, 'commit', '-qam', 'docs: our intro')
  const next = await changedScaffold(
    t,
    'WORKSPACE.md',
    (s) => `${s}\nNew in 0.5.0.\n`
  )
  const r = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, {
    scaffoldFor: async () => ({ dir: next }),
  })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^updated {2}WORKSPACE\.md$/m)
  assert.match(await read(root, 'WORKSPACE.md'), /New in 0\.5\.0\.\n$/)
  assert.match(await read(root, 'README.md'), /^Team intro\./)
})

test('overlapping edits conflict: nothing is installed; once resolved, a second run goes on', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  await writeFile(join(rnessDir, 'WORKSPACE.md'), 'Ours entirely.\n')
  await git(rnessDir, 'commit', '-qam', 'docs: ours')
  const next = await changedScaffold(
    t,
    'WORKSPACE.md',
    () => 'Theirs entirely.\n'
  )
  const deps: UpgradeDeps = { scaffoldFor: async () => ({ dir: next }) }

  const r = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, deps)
  assert.equal(r.code, 1)
  assert.match(r.err, /conflict WORKSPACE\.md/)
  assert.match(r.err, /git checkout --ours <file> keeps yours/)
  assert.doesNotMatch(r.out, /PINNED/)

  await git(rnessDir, 'checkout', '--ours', 'WORKSPACE.md')
  await git(rnessDir, 'add', '-A')
  await git(rnessDir, 'commit', '-q', '--no-edit')
  const again = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, deps)
  assert.equal(again.code, 0, again.err)
  assert.doesNotMatch(again.out, /merging/)
  assert.match(again.out, /^PINNED 0\.5\.0 sync --yes$/m)
  assert.equal(await read(root, 'WORKSPACE.md'), 'Ours entirely.\n')
})

test('adoption: no scaffold commit — identical files pass, a differing one conflicts once, a missing one is added', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, {
    pin: '0.5.0',
    installed: '0.5.0',
    subject: 'chore: baseline',
    trailer: null,
  })
  const rnessDir = join(root, '.rness')
  await rm(join(rnessDir, '.github', 'workflows', 'validate.yml'))
  await writeFile(join(rnessDir, 'CONVENTIONS.md'), 'Our conventions.\n')
  await git(rnessDir, 'add', '-A')
  await git(rnessDir, 'commit', '-qm', 'ours')
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 1)
  assert.match(
    r.out,
    /^adopting the @rness\/cli 0\.5\.0 scaffold \(no scaffold commit in .*\.rness yet\)$/m
  )
  assert.match(r.out, /^added {4}\.github\/workflows\/validate\.yml$/m)
  assert.match(r.err, /^.*conflict CONVENTIONS\.md$/m)
  assert.doesNotMatch(r.err, /README\.md/)
})

test('only the scaffold is behind (the pin moved by pull request): merged, synced, committed, nothing installed', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.5.0' })
  const rnessDir = join(root, '.rness')
  // What the Dependabot pull request does: the pin, nothing else.
  await writeFile(
    join(rnessDir, 'package.json'),
    await scaffoldPackage('0.5.0')
  )
  await git(
    rnessDir,
    'commit',
    '-qam',
    'chore(deps-dev): bump @rness/cli from 0.4.0 to 0.5.0'
  )
  const next = await changedScaffold(
    t,
    'WORKSPACE.md',
    (s) => `${s}\nNew in 0.5.0.\n`
  )
  const r = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, {
    scaffoldFor: async () => ({ dir: next }),
  })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^scaffold @rness\/cli 0\.5\.0 — merging it into /m)
  assert.match(r.out, /^updated {2}WORKSPACE\.md$/m)
  assert.doesNotMatch(r.out, /^installed|package\.json/m)
  // The sync runs all the same: a release may add to the agent files.
  assert.match(r.out, /^PINNED 0\.5\.0 sync --yes$/m)
  assert.match(r.out, /^committed .*\.rness — chore: rness 0\.5\.0$/m)
  // The merge commit: the pull request's history, and the scaffold's.
  assert.equal(
    await git(rnessDir, 'log', '-1', '--format=%s'),
    'chore: rness 0.5.0'
  )
  assert.equal(
    (await git(rnessDir, 'log', '-1', '--format=%P')).split(' ').length,
    2
  )
  assert.equal(await git(rnessDir, 'status', '--porcelain'), '')
})

test('already at the target, scaffold included: nothing runs; a pin ahead of the installed copy is installed', async (t) => {
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
  assert.doesNotMatch(r2.out, /merging/)
  assert.match(r2.out, /^PINNED 0\.5\.0 sync --yes$/m)
})

test('a dirty .rness, or one that is not a repository, is refused before anything', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  await writeFile(join(root, '.rness', 'notes.md'), 'wip\n')
  const dirty = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(dirty.code, 1)
  assert.match(
    dirty.err,
    /\.rness has uncommitted changes; commit or stash them, then rness upgrade\n$/
  )
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.4.0'))

  await rm(join(root, '.rness', '.git'), { recursive: true, force: true })
  const plain = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(plain.code, 1)
  assert.match(plain.err, /\.rness is not a git repository\n$/)
})

test('a failed install keeps the merge staged and says how to undo it', async (t) => {
  await fakeNpm(t, { latest: '0.5.0', fail: true })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /npm install failed in .*: npm error notarget No matching version found for @rness\/cli\./
  )
  assert.match(r.err, /undo it with: git -C \.rness merge --abort/)
  await git(join(root, '.rness'), 'merge', '--abort')
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.4.0'))
})

test('npm pack is the source when neither the running nor the installed copy is the target', async (t) => {
  const next = await changedScaffold(
    t,
    'WORKSPACE.md',
    (s) => `${s}\nFrom the registry.\n`
  )
  // Never the running version, whatever it is.
  await fakeNpm(t, { latest: '99.0.0', scaffold: next })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const r = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, {})
  assert.equal(r.code, 0, r.err)
  assert.match(await read(root, 'WORKSPACE.md'), /From the registry\.\n$/)
  assert.equal(
    await read(root, 'package.json'),
    await scaffoldPackage('99.0.0')
  )
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
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.4.0'))
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
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.6.0'))
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
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.4.0'))
  assert.equal(await git(join(root, '.rness'), 'status', '--porcelain'), '')
  const yes = await upgrade(undefined, { cwd: root }, terminal(true))
  assert.equal(yes.code, 0, yes.err)
  assert.deepEqual(asked, [
    'Upgrade @rness/cli to 0.5.0?',
    'Upgrade @rness/cli to 0.5.0?',
  ])
})

test('a global older than the pin merges the scaffold of the copy installed in .rness', async (t) => {
  // The running copy (these sources) is not 0.5.0; the installed one is.
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.5.0' })
  const rnessDir = join(root, '.rness')
  await writeFile(
    join(rnessDir, 'package.json'),
    await scaffoldPackage('0.5.0')
  )
  await git(
    rnessDir,
    'commit',
    '-qam',
    'chore(deps-dev): bump @rness/cli from 0.4.0 to 0.5.0'
  )
  const installed = join(rnessDir, 'node_modules', '@rness', 'cli', 'scaffold')
  await cp(scaffoldDir(), installed, { recursive: true })
  await writeFile(
    join(installed, 'WORKSPACE.md'),
    `${await readFile(join(installed, 'WORKSPACE.md'), 'utf8')}\nFrom the installed copy.\n`
  )
  const r = await upgrade(undefined, { yes: true, cwd: root }, NO_TTY, {})
  assert.equal(r.code, 0, r.err)
  assert.match(await read(root, 'WORKSPACE.md'), /From the installed copy\.\n$/)
  assert.doesNotMatch(r.out, /^installed/m, 'nothing to install')
  assert.match(r.out, /^PINNED 0\.5\.0 sync --yes$/m)
})

test('adoption adds no .gitkeep to a directory that already holds files', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, {
    pin: '0.5.0',
    installed: '0.5.0',
    subject: 'chore: baseline',
    trailer: null,
  })
  const rnessDir = join(root, '.rness')
  await rm(join(rnessDir, 'specs', '.gitkeep'))
  await writeFile(join(rnessDir, 'specs', '0001-first.md'), '# First\n')
  await rm(join(rnessDir, 'plans'), { recursive: true })
  await git(rnessDir, 'add', '-A')
  await git(rnessDir, 'commit', '-qm', 'ours')
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.doesNotMatch(r.out, /specs\/\.gitkeep/)
  assert.match(r.out, /^added {4}plans\/\.gitkeep$/m)
})

test('a hook refusing the commit: exit 1, everything staged, what the hook said and the commit to make', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  // Inside .git: a hook that is no file of the tree.
  const hooks = join(rnessDir, '.git', 'test-hooks')
  await mkdir(hooks)
  await writeFile(
    join(hooks, 'pre-commit'),
    '#!/bin/sh\necho "org/api/.mcp.json: mcpServers.rness is missing (run rness sync)" >&2\nexit 1\n',
    { mode: 0o755 }
  )
  await git(rnessDir, 'config', 'core.hooksPath', hooks)
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /^org\/api\/\.mcp\.json: mcpServers\.rness is missing \(run rness sync\)$/m
  )
  assert.match(r.err, /the commit of .*\.rness was refused/)
  assert.match(r.out, /^ {2}git -C \.rness commit -m "chore: rness 0\.5\.0"$/m)
  assert.doesNotMatch(r.out, /git -C \.rness push/)
  // The merge waits, everything staged.
  await git(rnessDir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD')
  assert.equal(await git(rnessDir, 'diff', '--name-only'), '')
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.5.0'))
})

test('a merge in progress in .rness is refused before anything', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  await git(rnessDir, 'checkout', '-q', '-b', 'side')
  await git(rnessDir, 'commit', '-q', '--allow-empty', '-m', 'side')
  await git(rnessDir, 'checkout', '-q', 'main')
  await git(rnessDir, 'merge', '-q', '--no-commit', '--no-ff', 'side')
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /\.rness has a merge in progress; commit it, or abort it with git -C \.rness merge --abort, then rness upgrade\n$/
  )
  assert.equal(await read(root, 'package.json'), await scaffoldPackage('0.4.0'))
})

test('next steps name, per repository, the files sync writes that changed — nothing else', async (t) => {
  await fakeNpm(t, { latest: '0.5.0' })
  const root = await workspace(t, { pin: '0.4.0', installed: '0.4.0' })
  const rnessDir = join(root, '.rness')
  await writeFile(
    join(rnessDir, 'rness.json'),
    JSON.stringify({
      contract: 1,
      org: 'acme',
      agents: ['claude'],
      repos: {
        api: { url: 'https://github.com/acme/api.git' },
        web: { url: 'https://github.com/acme/web.git' },
      },
      scopes: {},
    })
  )
  await git(rnessDir, 'commit', '-qam', 'chore: two repositories')
  for (const repo of ['api', 'web']) {
    const dir = join(root, 'org', repo)
    await mkdir(dir, { recursive: true })
    await git(dir, 'init', '-q', '-b', 'main')
    await git(dir, 'commit', '-q', '--allow-empty', '-m', 'init')
  }
  // What a sync writes (the fake pinned copy writes nothing), and a
  // developer's own file, which is none of upgrade's business.
  const api = join(root, 'org', 'api')
  await writeFile(join(api, 'AGENTS.md'), 'block\n')
  await writeFile(join(api, '.mcp.json'), '{}\n')
  await writeFile(join(api, 'notes.md'), 'mine\n')
  const r = await upgrade(undefined, { yes: true, cwd: root })
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^ {2}git -C org\/api add \.mcp\.json AGENTS\.md && git -C org\/api commit -m "chore: rness 0\.5\.0"$/m
  )
  assert.doesNotMatch(r.out, /org\/web|notes\.md/)
})
