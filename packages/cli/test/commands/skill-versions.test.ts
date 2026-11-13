import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
import {
  skillDeclineCommand,
  skillInstallCommand,
} from '../../src/commands/skill.ts'
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

/** `git <args>` in `cwd` with `input` on its standard input: the plumbing a crafted commit is made with. */
const plumbing = (args: string[], cwd: string, input = ''): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=rness-test',
      '-c',
      'user.email=test@rness.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, input }
  )
    .toString()
    .trim()

/**
 * A commit at HEAD of `.rness` whose `skills/release` holds `extra`, a
 * tree entry git's own tools would never write (`git mktree` takes it):
 * what a malicious commit in `.rness` could carry.
 */
function craftRelease(root: string, name: string, inside: string): void {
  const r = join(root, '.rness')
  const blob = (text: string) =>
    plumbing(['hash-object', '-w', '--stdin'], r, text)
  const mktree = (lines: string[]) =>
    plumbing(['mktree'], r, lines.map((l) => `${l}\n`).join(''))
  const md = blob(SKILL_MD('release', 'allowed-tools: Read\n'))
  const inner = mktree([`100644 blob ${blob('evil\n')}\t${inside}`])
  const release = mktree([
    `100644 blob ${md}\tSKILL.md`,
    `040000 tree ${inner}\t${name}`,
  ])
  const skills = mktree([`040000 tree ${release}\trelease`])
  const top = plumbing(['ls-tree', 'HEAD'], r)
    .split('\n')
    .map((l) => (l.endsWith('\tskills') ? `040000 tree ${skills}\tskills` : l))
  const commit = plumbing(
    ['commit-tree', mktree(top), '-p', 'HEAD', '-m', 'crafted'],
    r
  )
  plumbing(['update-ref', 'HEAD', commit], r)
}

test('a crafted commit whose skill tree holds "..": refused, nothing written outside the copy (ruling R34)', async (t) => {
  const root = await teamWs(t)
  assert.equal((await install(root, 'release')).code, 0)
  craftRelease(root, '..', 'evil.md')
  const s = await sync(root)
  assert.equal(s.code, 0, s.err)
  for (const at of [
    'org/web/.claude/skills/evil.md',
    'org/web/.agents/skills/evil.md',
    '.claude/skills/evil.md',
  ])
    assert.equal(await there(join(root, at)), false, at)
  // The copy installed before is left as it is.
  assert.equal(
    await installed(root),
    SKILL_MD('release', 'allowed-tools: Read\n')
  )
  const i = await install(root, 'release')
  assert.equal(i.code, 1)
  assert.match(
    i.out,
    /^skipped +release: skill "release": file name "\.\." holds an empty, "\." or "\.\." part; run rness validate$/m
  )
  for (const at of ['org/web/.claude/skills/evil.md', '.claude/skills/evil.md'])
    assert.equal(await there(join(root, at)), false, at)
})

test('a crafted commit whose skill tree holds ".git" (or ".GIT", "git~1"): refused, no repository planted in a clone (ruling R34)', async (t) => {
  const root = await teamWs(t)
  assert.equal((await install(root, 'release')).code, 0)
  for (const name of ['.git', '.GIT', 'git~1']) {
    craftRelease(root, name, 'config')
    const i = await install(root, 'release')
    assert.equal(i.code, 1, name)
    assert.match(
      i.out,
      new RegExp(
        `^skipped +release: skill "release": file name "${name.replace('.', '\\.')}" names a \\.git`,
        'm'
      ),
      name
    )
    for (const at of [
      `org/web/.claude/skills/release/${name}`,
      `org/web/.agents/skills/release/${name}`,
      `.claude/skills/release/${name}`,
    ])
      assert.equal(await there(join(root, at)), false, at)
  }
})

// ---- Rework fix round 1 (rulings R36 to R38) ----

/** `rness skill decline <names>`, on 2026-11-13. */
async function decline(root: string, ...names: string[]) {
  const c = capture()
  try {
    const code = await skillDeclineCommand(
      names,
      { cwd: root },
      { now: () => Date.parse('2026-11-13T10:00:00Z') }
    )
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

test('a bare install with nothing pending delivers the new version of an accepted skill and says it (R38)', async (t) => {
  const root = await teamWs(t)
  assert.equal((await install(root, 'release')).code, 0)
  await writeFile(
    join(root, '.rness/skills/release/SKILL.md'),
    SKILL_MD('release', 'allowed-tools: Read\nversion: 2\n')
  )
  await commitRness(root, 'release v2')
  const r = await install(root)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^skills +no team skill awaits your consent$/m)
  assert.match(r.out, /^updated +release \([0-9a-f]{7} -> [0-9a-f]{7}\)$/m)
  assert.equal(
    await installed(root),
    SKILL_MD('release', 'allowed-tools: Read\nversion: 2\n')
  )
})

test('skill decline: an installed skill is recorded declined, removed from every place, never proposed again; install <name> brings it back (R36)', async (t) => {
  const root = await teamWs(t)
  assert.equal((await install(root, 'release')).code, 0)
  const d = await decline(root, 'release')
  assert.equal(d.code, 0, d.err)
  assert.match(
    d.out,
    /^declined +release {3}removed \(org\/web, workspace root\)$/m
  )
  for (const at of [
    'org/web/.claude/skills/release',
    'org/web/.agents/skills/release',
    '.claude/skills/release',
  ])
    assert.equal(await there(join(root, at)), false, at)
  const record = JSON.parse(
    await readFile(join(root, '.rness/.git/rness/skills.json'), 'utf8')
  )
  assert.deepEqual(record.skills.release, {
    answer: 'declined',
    date: '2026-11-13',
  })
  assert.doesNotMatch((await sync(root)).out, PENDING)
  const again = await answer(root, 'install')
  assert.deepEqual(again.asked, [])
  const back = await install(root, 'release')
  assert.equal(back.code, 0, back.err)
  assert.equal(
    await installed(root),
    SKILL_MD('release', 'allowed-tools: Read\n')
  )
})

/** acme with claude: `deploy` written by the team for web and for api, both cloned, `.rness` committed. */
async function twoDeploysWs(t: TestContext): Promise<string> {
  noGlobalGit(t)
  const root = await makeWorkspace(t, {
    org: 'acme',
    agents: ['claude'],
    scopes: {
      web: { url: 'https://github.com/acme/web.git' },
      api: { url: 'https://github.com/acme/api.git' },
    },
    files: {
      'skills/scopes/web/deploy/SKILL.md': SKILL_MD('deploy', 'x: web\n'),
      'skills/scopes/api/deploy/SKILL.md': SKILL_MD('deploy', 'x: api\n'),
    },
    dirs: ['org/web', 'org/api'],
  })
  for (const dir of ['.rness', 'org/web', 'org/api'])
    await git(['init', '-q', '-b', 'main'], join(root, dir))
  await commitRness(root, 'skills')
  assert.equal((await sync(root)).code, 0)
  return root
}

test('skill decline: a name two skills share is refused naming their ids; an id declines that one only (R36)', async (t) => {
  const root = await twoDeploysWs(t)
  assert.equal((await install(root, 'web/deploy', 'api/deploy')).code, 0)
  // Through the command line: the command is registered.
  const bare = await cli(['skill', 'decline', 'deploy', '--cwd', root])
  assert.equal(bare.code, 1)
  assert.match(
    bare.err,
    /skill "deploy" names more than one team skill: name one by its id, web\/deploy or api\/deploy/
  )
  const one = await decline(root, 'web/deploy')
  assert.equal(one.code, 0, one.err)
  assert.match(one.out, /^declined +web\/deploy {3}removed \(org\/web\)$/m)
  assert.equal(await there(join(root, 'org/web/.agents/skills/deploy')), false)
  assert.equal(await there(join(root, 'org/api/.agents/skills/deploy')), true)
})

test('an updated line names a skill by its id when its name applies more than once (R27)', async (t) => {
  const root = await twoDeploysWs(t)
  assert.equal((await install(root, 'web/deploy', 'api/deploy')).code, 0)
  await writeFile(
    join(root, '.rness/skills/scopes/web/deploy/SKILL.md'),
    SKILL_MD('deploy', 'x: web v2\n')
  )
  await commitRness(root, 'web deploy v2')
  const r = await sync(root)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^updated +web\/deploy \([0-9a-f]{7} -> [0-9a-f]{7}\)$/m)
  assert.doesNotMatch(r.out, /^updated +deploy /m)
})

test('commit .rness first is said for a skill accepted or awaiting an answer, never for a declined one', async (t) => {
  const root = await teamWs(t)
  await put(join(root, '.rness/skills/lint'), { 'SKILL.md': SKILL_MD('lint') })
  assert.match((await sync(root)).out, /^lint: commit \.rness first$/m)
  const d = await decline(root, 'lint')
  assert.equal(d.code, 0, d.err)
  assert.doesNotMatch((await sync(root)).out, /commit \.rness first/)
})

test('a .DS_Store the tree holds is part of the copy: no rewrite on every sync', async (t) => {
  const root = await teamWs(t)
  await writeFile(join(root, '.rness/skills/release/.DS_Store'), 'committed')
  await git(['add', '-f', 'skills/release/.DS_Store'], join(root, '.rness'))
  await commitRness(root, 'a .DS_Store committed')
  assert.equal((await install(root, 'release')).code, 0)
  assert.equal(
    await readFile(
      join(root, 'org/web/.claude/skills/release/.DS_Store'),
      'utf8'
    ),
    'committed'
  )
  const again = await sync(root)
  assert.equal(again.code, 0, again.err)
  assert.doesNotMatch(again.out, /^(rewrote|installed|updated +release)/m)
})
