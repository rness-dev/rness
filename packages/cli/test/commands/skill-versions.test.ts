import assert from 'node:assert/strict'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { run } from '../../src/cli.ts'
import { skillInstallCommand } from '../../src/commands/skill.ts'
import { capture } from '../helpers/capture.ts'
import { commitRness, git } from '../helpers/git.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

// Spec 0041 decisions 8 and 9: consent is asked once per skill; what is
// installed is the copy committed at HEAD of `.rness`, its new versions
// installed by `sync` without a question, and said.

const SKILL_MD = (name: string, extra = ''): string =>
  `---\nname: ${name}\ndescription: A skill\n${extra}---\nBody\n`

async function put(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, ...rel.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
}

function noGlobalGit(t: TestContext): void {
  const was = process.env['GIT_CONFIG_GLOBAL']
  process.env['GIT_CONFIG_GLOBAL'] = '/dev/null'
  t.after(() => {
    if (was === undefined) delete process.env['GIT_CONFIG_GLOBAL']
    else process.env['GIT_CONFIG_GLOBAL'] = was
  })
}

/** HOME in a directory of its own for the test, checked empty at its end by the caller. */
async function ownHome(t: TestContext): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'rness-home-')))
  const was = process.env['HOME']
  process.env['HOME'] = home
  t.after(async () => {
    process.env['HOME'] = was
    await rm(home, { recursive: true, force: true })
  })
  return home
}

/** acme with claude: `release` written by the team at the top, `.rness` committed; org/web cloned. */
async function teamWs(t: TestContext): Promise<string> {
  noGlobalGit(t)
  const root = await makeWorkspace(t, {
    org: 'acme',
    agents: ['claude'],
    scopes: { web: { url: 'https://github.com/acme/web.git' } },
    files: {
      '.gitignore': 'node_modules/\n.DS_Store\n',
      'skills/release/SKILL.md': SKILL_MD('release', 'allowed-tools: Read\n'),
      'skills/release/run.sh': '#!/bin/sh\necho release\n',
    },
    dirs: ['org/web'],
  })
  await chmod(join(root, '.rness/skills/release/run.sh'), 0o755)
  for (const dir of ['.rness', 'org/web'])
    await git(['init', '-q', '-b', 'main'], join(root, dir))
  await commitRness(root, 'skills')
  // The blocks, the plugin and the hooks written once: what a later sync
  // says is then about the team skills only.
  assert.equal((await sync(root)).code, 0)
  return root
}

async function cli(
  args: string[]
): Promise<{ code: number; out: string; err: string }> {
  const c = capture()
  try {
    const code = await run(args)
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

function sync(root: string) {
  return cli(['sync', '--yes', '--cwd', root])
}
function install(root: string, ...names: string[]) {
  return cli(['skill', 'install', ...names, '--yes', '--cwd', root])
}

/** `skill install` answering the question with `answer`, on a terminal. */
async function answer(root: string, answer: 'install' | 'decline') {
  const asked: string[] = []
  const c = capture()
  try {
    const code = await skillInstallCommand(
      [],
      { cwd: root },
      {
        terminal: {
          isTty: () => true,
          prompts: () =>
            Promise.resolve({
              select: (o: { message: string }) => {
                asked.push(o.message)
                return Promise.resolve(answer)
              },
              isCancel: () => false,
            } as never),
        } as never,
        now: () => Date.parse('2026-11-13T10:00:00Z'),
      }
    )
    return { code, out: c.out(), err: c.err(), asked }
  } finally {
    c.restore()
  }
}

const installed = (root: string, at = 'org/web/.claude/skills/release') =>
  readFile(join(root, at, 'SKILL.md'), 'utf8')

const there = (p: string): Promise<boolean> =>
  lstat(p).then(
    () => true,
    () => false
  )

const PENDING = /team skills? awaits? your consent/

test('an accepted skill updated in .rness (a new commit) is installed by sync -y, said with its trees, and asked about no more', async (t) => {
  const root = await teamWs(t)
  assert.equal((await install(root, 'release')).code, 0)
  const from = (
    await git(['rev-parse', 'HEAD:skills/release'], join(root, '.rness'))
  ).trim()
  await writeFile(
    join(root, '.rness/skills/release/SKILL.md'),
    SKILL_MD('release', 'allowed-tools: Read\nversion: 2\n')
  )
  await commitRness(root, 'release v2')
  const to = (
    await git(['rev-parse', 'HEAD:skills/release'], join(root, '.rness'))
  ).trim()
  const r = await sync(root)
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    new RegExp(
      `^updated +release \\(${from.slice(0, 7)} -> ${to.slice(0, 7)}\\)$`,
      'm'
    )
  )
  assert.doesNotMatch(r.out, PENDING)
  for (const at of [
    'org/web/.claude/skills/release',
    'org/web/.agents/skills/release',
    '.claude/skills/release',
  ])
    assert.equal(
      await installed(root, at),
      SKILL_MD('release', 'allowed-tools: Read\nversion: 2\n'),
      at
    )
  // No question: nothing awaits the developer.
  const again = await answer(root, 'decline')
  assert.deepEqual(again.asked, [])
  assert.match(again.out, /^skills +no team skill awaits your consent$/m)
  // Once installed, the next sync says nothing of it.
  assert.doesNotMatch((await sync(root)).out, /release/)
})

test('a new version asking for other tools says so on its updated line', async (t) => {
  const root = await teamWs(t)
  assert.equal((await install(root, 'release')).code, 0)
  await writeFile(
    join(root, '.rness/skills/release/SKILL.md'),
    SKILL_MD('release', 'allowed-tools: Read, Bash\n')
  )
  await commitRness(root, 'release asks Bash')
  const r = await sync(root)
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^updated +release \([0-9a-f]{7} -> [0-9a-f]{7}\), allowed-tools: Read -> Read, Bash$/m
  )
})

test('a declined skill stays declined whatever its version: not proposed, not installed', async (t) => {
  const root = await teamWs(t)
  const d = await answer(root, 'decline')
  assert.equal(d.code, 0, d.err)
  assert.match(d.out, /^declined +release/m)
  await writeFile(
    join(root, '.rness/skills/release/SKILL.md'),
    SKILL_MD('release', 'version: 2\n')
  )
  await commitRness(root, 'release v2')
  const s = await sync(root)
  assert.equal(s.code, 0, s.err)
  assert.doesNotMatch(s.out, PENDING)
  assert.equal(await there(join(root, 'org/web/.agents/skills/release')), false)
  const again = await answer(root, 'install')
  assert.deepEqual(again.asked, [])
  assert.match(again.out, /^skills +no team skill awaits your consent$/m)
  // Named, it is asked again and installed.
  const named = await install(root, 'release')
  assert.equal(named.code, 0, named.err)
  assert.equal(
    await installed(root, 'org/web/.agents/skills/release'),
    SKILL_MD('release', 'version: 2\n')
  )
})

test('a skill not committed in .rness is not installed, one line says to commit; an uncommitted edit never reaches a clone', async (t) => {
  const root = await teamWs(t)
  assert.equal((await install(root, 'release')).code, 0)
  await put(join(root, '.rness/skills/lint'), { 'SKILL.md': SKILL_MD('lint') })
  await writeFile(
    join(root, '.rness/skills/release/SKILL.md'),
    SKILL_MD('release', 'draft: true\n')
  )
  const r = await sync(root)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^lint: commit \.rness first$/m)
  assert.doesNotMatch(r.out, PENDING)
  assert.doesNotMatch(r.out, /^updated +release/m)
  assert.equal(await there(join(root, 'org/web/.agents/skills/lint')), false)
  assert.equal(
    await installed(root),
    SKILL_MD('release', 'allowed-tools: Read\n')
  )
  const i = await install(root, 'lint')
  assert.equal(i.code, 1)
  assert.match(i.out, /^skipped +lint: commit \.rness first$/m)
  assert.equal(await there(join(root, 'org/web/.agents/skills/lint')), false)
  // Committed, it is pending.
  await commitRness(root, 'lint')
  assert.match(
    (await sync(root)).out,
    /^skills +1 team skill awaits your consent/m
  )
})

test('an installed copy edited, extended or made executable is rewritten from the commit', async (t) => {
  const root = await teamWs(t)
  assert.equal((await install(root, 'release')).code, 0)
  const copy = join(root, 'org/web/.claude/skills/release')
  for (const edit of [
    () => writeFile(join(copy, 'SKILL.md'), 'edited\n'),
    () => writeFile(join(copy, 'extra.md'), 'added\n'),
    () => chmod(join(copy, 'SKILL.md'), 0o755),
    () => chmod(join(copy, 'run.sh'), 0o644),
  ]) {
    await edit()
    const r = await sync(root)
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /^rewrote {2}org\/web team skill \(release\)$/m)
    assert.deepEqual((await readdir(copy)).sort(), ['SKILL.md', 'run.sh'])
    assert.equal((await stat(join(copy, 'SKILL.md'))).mode & 0o777, 0o644)
    assert.equal((await stat(join(copy, 'run.sh'))).mode & 0o777, 0o755)
  }
  // A .DS_Store Finder adds is no edit.
  await writeFile(join(copy, '.DS_Store'), 'finder')
  assert.doesNotMatch((await sync(root)).out, /rewrote/)
})

test("a clone of .rness with core.autocrlf=true: the copies are installed from git's objects, and nothing differs", async (t) => {
  const team = await teamWs(t)
  const root = await makeWorkspace(t, {
    org: 'acme',
    agents: ['claude'],
    scopes: { web: { url: 'https://github.com/acme/web.git' } },
    dirs: ['org/web'],
  })
  await rm(join(root, '.rness'), { recursive: true })
  await git(
    ['clone', '-q', '-c', 'core.autocrlf=true', join(team, '.rness'), '.rness'],
    root
  )
  await git(['init', '-q', '-b', 'main'], join(root, 'org/web'))
  // The working copy of .rness has CRLF line ends: the case under test.
  assert.match(
    await readFile(join(root, '.rness/skills/release/SKILL.md'), 'utf8'),
    /\r\n/
  )
  const v = await cli(['validate', '--cwd', root])
  assert.doesNotMatch(v.err, /skill "/)
  assert.equal((await sync(root)).code, 0)
  assert.equal((await install(root, 'release')).code, 0)
  assert.equal(
    await installed(root),
    SKILL_MD('release', 'allowed-tools: Read\n')
  )
  const again = await sync(root)
  assert.equal(again.code, 0, again.err)
  assert.doesNotMatch(again.out, /^(rewrote|installed|updated +release)/m)
})

test('a lost record: a copy whose files match the commit blob for blob is adopted, never rewritten', async (t) => {
  const root = await teamWs(t)
  assert.equal((await install(root, 'release')).code, 0)
  const web = join(root, 'org/web')
  const file = join(web, '.git/rness/skills.json')
  const before = JSON.parse(await readFile(file, 'utf8'))
  await rm(file)
  const r = await sync(root)
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.out, /^(removed|rewrote|installed|updated +release)/m)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), before)
  assert.match(before.skills.release.tree, /^[0-9a-f]{40}$/)
  assert.equal(
    await git(
      [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        '.claude/skills/release',
        '.agents',
      ],
      web
    ),
    ''
  )
})

test('install and sync write nothing under HOME', async (t) => {
  const home = await ownHome(t)
  const root = await teamWs(t)
  assert.equal((await install(root, 'release')).code, 0)
  await writeFile(
    join(root, '.rness/skills/release/SKILL.md'),
    SKILL_MD('release', 'version: 2\n')
  )
  await commitRness(root, 'v2')
  assert.equal((await sync(root)).code, 0)
  assert.deepEqual(await readdir(home), [])
})
