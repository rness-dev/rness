import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { promisify } from 'node:util'

import {
  type ScaffoldFile,
  renderScaffold,
} from '../../src/core/scaffold-copy.ts'
import {
  buildScaffoldCommit,
  findScaffoldBase,
  isShallow,
  mergeScaffold,
} from '../../src/core/scaffold-git.ts'
import { scaffoldDir } from '../../src/core/scaffold.ts'

process.env['GIT_AUTHOR_NAME'] = 'rness-test'
process.env['GIT_AUTHOR_EMAIL'] = 'test@rness.invalid'
process.env['GIT_COMMITTER_NAME'] = 'rness-test'
process.env['GIT_COMMITTER_EMAIL'] = 'test@rness.invalid'

const run = promisify(execFile)
const git = async (dir: string, ...args: string[]) =>
  (await run('git', args, { cwd: dir })).stdout.trim()

const TOKENS = { version: '0.8.0', packageManager: 'npm@11.0.0' }

async function write(dir: string, files: ScaffoldFile[]) {
  for (const f of files) {
    const to = join(dir, ...f.path.split('/'))
    await mkdir(dirname(to), { recursive: true })
    await writeFile(to, f.content, { mode: f.executable ? 0o755 : 0o644 })
  }
}

/** A `.rness` repository as `create` leaves it: the scaffold, rness.json, one commit. */
async function created(
  t: TestContext,
  subject = 'chore: rness workspace context',
  trailer: string | null = 'Rness-Scaffold: 0.8.0'
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rness-sg-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, '.rness')
  await mkdir(dir)
  await git(dir, 'init', '-q', '-b', 'main')
  await write(dir, await renderScaffold(scaffoldDir(), TOKENS))
  await writeFile(join(dir, 'rness.json'), '{ "contract": 1 }\n')
  await git(dir, 'add', '-A')
  const message = trailer === null ? subject : `${subject}\n\n${trailer}`
  await git(dir, 'commit', '-q', '-m', message)
  return dir
}

/** The 0.8.0 scaffold with a change in one file, as a later version would ship it. */
async function nextScaffold(change: (f: ScaffoldFile) => ScaffoldFile) {
  const files = await renderScaffold(scaffoldDir(), {
    ...TOKENS,
    version: '0.9.0',
  })
  return files.map(change)
}

test('the base: a root create commit, with or without the trailer', async (t) => {
  const withTrailer = await created(t)
  const base = await findScaffoldBase(withTrailer)
  assert.equal(base?.version, '0.8.0')
  assert.equal(base?.commit, await git(withTrailer, 'rev-parse', 'HEAD'))

  const before = await created(t, 'chore: rness workspace context', null)
  assert.deepEqual(await findScaffoldBase(before), {
    commit: await git(before, 'rev-parse', 'HEAD'),
    version: null,
  })

  // A root commit that is not rness's never is: its files were not the scaffold.
  const baseline = await created(t, 'chore: baseline', null)
  assert.equal(await findScaffoldBase(baseline), null)
})

test('a scaffold commit carries its version, keeps the hook executable, and becomes the base', async (t) => {
  const dir = await created(t)
  const base = await findScaffoldBase(dir)
  assert.ok(base)
  const files = await nextScaffold((f) =>
    f.path === 'AGENTS.md' ? { ...f, content: `${f.content}\nNew line.\n` } : f
  )
  const commit = await buildScaffoldCommit(dir, base.commit, files, '0.9.0')
  assert.equal(
    await git(
      dir,
      'log',
      '-1',
      '--format=%s%n%(trailers:key=Rness-Scaffold,valueonly)',
      commit
    ),
    'chore: rness scaffold 0.9.0\n0.9.0'
  )
  assert.equal(await git(dir, 'rev-parse', `${commit}^`), base.commit)
  assert.match(
    await git(dir, 'ls-tree', commit, '.githooks/pre-commit'),
    /^100755 /
  )
  // rness.json is the team's: the scaffold commit keeps the base's.
  assert.equal(
    await git(dir, 'show', `${commit}:rness.json`),
    '{ "contract": 1 }'
  )
  assert.equal(
    await git(dir, 'status', '--porcelain'),
    '',
    'working tree untouched'
  )

  const merged = await mergeScaffold(dir, commit, base.commit)
  assert.deepEqual(merged.conflicts, [])
  assert.deepEqual(merged.changes, [
    ['updated', 'AGENTS.md'],
    ['updated', 'package.json'],
  ])
  assert.match(await readFile(join(dir, 'AGENTS.md'), 'utf8'), /New line\.\n$/)
  assert.match(
    await readFile(join(dir, 'package.json'), 'utf8'),
    /"@rness\/cli": "0\.9\.0"/
  )
  await git(dir, 'commit', '-q', '-m', 'merge the scaffold')
  assert.equal((await findScaffoldBase(dir))?.version, '0.9.0')
})

test("the team's edits are kept where the scaffold did not change; overlapping lines conflict", async (t) => {
  const dir = await created(t)
  const readme = join(dir, 'README.md')
  await writeFile(readme, `Team intro.\n\n${await readFile(readme, 'utf8')}`)
  await git(dir, 'commit', '-qam', 'docs: our intro')
  const base = await findScaffoldBase(dir)
  assert.ok(base)
  const files = await nextScaffold((f) =>
    f.path === 'README.md'
      ? { ...f, content: `${f.content}\nScaffold footer.\n` }
      : f
  )
  const merged = await mergeScaffold(
    dir,
    await buildScaffoldCommit(dir, base.commit, files, '0.9.0'),
    base.commit
  )
  assert.deepEqual(merged.conflicts, [])
  assert.ok(
    merged.changes.some(([s, p]) => s === 'merged' && p === 'README.md')
  )
  const text = await readFile(readme, 'utf8')
  assert.match(text, /^Team intro\./)
  assert.match(text, /Scaffold footer\.\n$/)

  const clash = await created(t)
  await writeFile(join(clash, 'WORKSPACE.md'), 'Ours entirely.\n')
  await git(clash, 'commit', '-qam', 'docs: ours')
  const clashBase = await findScaffoldBase(clash)
  assert.ok(clashBase)
  const conflicted = await mergeScaffold(
    clash,
    await buildScaffoldCommit(
      clash,
      clashBase.commit,
      await nextScaffold((f) =>
        f.path === 'WORKSPACE.md' ? { ...f, content: 'Theirs entirely.\n' } : f
      ),
      '0.9.0'
    ),
    clashBase.commit
  )
  assert.deepEqual(conflicted.conflicts, ['WORKSPACE.md'])
})

test('a squash-like commit (trailer in the body, another subject) is never the base', async (t) => {
  const dir = await created(t)
  const root = await git(dir, 'rev-parse', 'HEAD')
  await writeFile(join(dir, 'AGENTS.md'), 'squashed\n')
  await git(
    dir,
    'commit',
    '-qam',
    'Upgrade rness (#12)\n\n* chore: rness scaffold 0.9.0\n\nRness-Scaffold: 0.9.0'
  )
  assert.deepEqual(await findScaffoldBase(dir), {
    commit: root,
    version: '0.8.0',
  })
})

test('adoption: no base, unrelated histories — identical files pass, a differing one conflicts, a missing one is added', async (t) => {
  const dir = await created(t, 'chore: baseline', null)
  await rm(join(dir, '.github', 'workflows', 'validate.yml'))
  await writeFile(join(dir, 'CONVENTIONS.md'), 'Our conventions.\n')
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '-qm', 'ours')
  const files = await renderScaffold(scaffoldDir(), TOKENS)
  const commit = await buildScaffoldCommit(dir, null, files, '0.8.0')
  assert.equal(
    await git(dir, 'rev-list', '--parents', '-n', '1', commit),
    commit
  )
  const merged = await mergeScaffold(dir, commit, null)
  assert.deepEqual(merged.conflicts, ['CONVENTIONS.md'])
  assert.ok(
    merged.changes.some(
      ([s, p]) => s === 'added' && p === '.github/workflows/validate.yml'
    )
  )
})

test('isShallow tells a one-commit CI checkout', async (t) => {
  const dir = await created(t)
  assert.equal(await isShallow(dir), false)
  await git(dir, 'commit', '-q', '--allow-empty', '-m', 'second')
  const clone = join(dirname(dir), 'shallow')
  await run('git', ['clone', '-q', '--depth', '1', `file://${dir}`, clone])
  assert.equal(await isShallow(clone), true)
})
