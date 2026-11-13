import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { fetchRef } from '../../src/core/git.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import {
  allowedToolsText,
  blockSkills,
  checkSkillCopies,
  copySkill,
  diffSkillFiles,
  fetchSkill,
  fileDigests,
  isGitName,
  pathProblem,
  plainText,
  quoted,
  readSkillMd,
  skillConflicts,
  skillSourceUrl,
  skillsAtHead,
  skillsForClone,
  skillsForScope,
  teamSkills,
} from '../../src/core/skills.ts'
import type { Manifest } from '../../src/core/types.ts'
import { git } from '../helpers/git.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const TREE = 'f'.repeat(40)
const decl = (source = 'github:o/r') => ({ source, tree: TREE })

/** top: a (declared), b (written); web: c; web/ui part: d; ui extends api: e. */
async function build(t: Parameters<typeof makeWorkspace>[0]) {
  const root = await makeWorkspace(t, {
    skills: { a: decl() },
    scopes: {
      web: {
        url: 'u1',
        skills: { c: decl() },
        scopes: {
          ui: { path: 'packages/ui', skills: { d: decl() } },
        },
      },
      api: { url: 'u2', skills: { e: decl() } },
      app: { url: 'u3', extends: ['api'] },
    },
    files: {
      'skills/README.md': 'x',
      'skills/b/SKILL.md': '---\nname: b\n---\n',
      'skills/scopes/web/w/SKILL.md': 'x',
      'skills/scopes/.gitkeep': '',
      'skills/scopes/web/README.md': 'x',
    },
  })
  const rnessDir = join(root, '.rness')
  return { rnessDir, manifest: await loadManifest(rnessDir) }
}

const names = (s: { name: string }[]) => s.map((x) => x.name).sort()

test('teamSkills: declared entries and written directories, files and scopes dir skipped', async (t) => {
  const { rnessDir, manifest } = await build(t)
  const all = await teamSkills(rnessDir, manifest)
  assert.deepEqual(
    all.map((s) => [s.name, s.scope, s.entry === null]),
    [
      ['a', null, false],
      ['b', null, true],
      ['c', 'web', false],
      ['w', 'web', true],
      ['d', 'ui', false],
      ['e', 'api', false],
    ]
  )
  assert.equal(all[0]?.dir, join(rnessDir, 'skills', 'a'))
  assert.equal(all[3]?.dir, join(rnessDir, 'skills', 'scopes', 'web', 'w'))
  assert.equal(all[4]?.dir, join(rnessDir, 'skills', 'scopes', 'ui', 'd'))
})

test('teamSkills: a declaration also present as a directory is the declaration, once', async (t) => {
  const root = await makeWorkspace(t, {
    skills: { a: decl() },
    files: { 'skills/a/SKILL.md': 'x' },
  })
  const rnessDir = join(root, '.rness')
  const all = await teamSkills(rnessDir, await loadManifest(rnessDir))
  assert.equal(all.length, 1)
  assert.notEqual(all[0]?.entry, null)
})

test('teamSkills: no skills directory is no skill', async (t) => {
  const root = await makeWorkspace(t, {})
  const rnessDir = join(root, '.rness')
  assert.deepEqual(await teamSkills(rnessDir, await loadManifest(rnessDir)), [])
})

test('skillsForScope: the top, the scope and what it extends; a part inherits its parent', async (t) => {
  const { rnessDir, manifest } = await build(t)
  const all = await teamSkills(rnessDir, manifest)
  assert.deepEqual(names(skillsForScope(manifest, all, null)), ['a', 'b'])
  assert.deepEqual(names(skillsForScope(manifest, all, 'web')), [
    'a',
    'b',
    'c',
    'w',
  ])
  assert.deepEqual(names(skillsForScope(manifest, all, 'ui')), [
    'a',
    'b',
    'c',
    'd',
    'w',
  ])
  assert.deepEqual(names(skillsForScope(manifest, all, 'app')), ['a', 'b', 'e'])
})

test('skillsForClone: the repository scope and every part under it, once each', async (t) => {
  const { rnessDir, manifest } = await build(t)
  const all = await teamSkills(rnessDir, manifest)
  const web = skillsForClone(manifest, all, 'web')
  assert.deepEqual(names(web), ['a', 'b', 'c', 'd', 'w'])
  assert.deepEqual(names(skillsForClone(manifest, all, 'api')), ['a', 'b', 'e'])
  assert.deepEqual(names(skillsForClone(manifest, all, 'app')), ['a', 'b', 'e'])
})

test('skillConflicts: top and scope, two applying scopes, declared and written; none otherwise', async (t) => {
  const root = await makeWorkspace(t, {
    skills: { x: decl(), y: decl() },
    scopes: {
      web: {
        url: 'u1',
        skills: { x: decl(), z: decl() },
        scopes: { ui: { path: 'ui', skills: { z: decl() } } },
      },
      api: { url: 'u2', skills: { z: decl(), y2: decl() } },
    },
    files: { 'skills/scopes/web/y/SKILL.md': 'x' },
  })
  const rnessDir = join(root, '.rness')
  const manifest = await loadManifest(rnessDir)
  const lines = skillConflicts(
    rnessDir,
    manifest,
    await teamSkills(rnessDir, manifest)
  )
  assert.deepEqual(lines.sort(), [
    'skill "x" is declared at the top and in scope "web"',
    'skill "y" is declared at the top and written by the team at skills/scopes/web/y',
    'skill "z" is declared in scope "web" and in scope "ui"',
  ])
})

test('skillConflicts: the same name in two scopes that never meet in a clone is fine', async (t) => {
  const root = await makeWorkspace(t, {
    scopes: {
      web: { url: 'u1', skills: { z: decl() } },
      api: { url: 'u2', skills: { z: decl() } },
    },
  })
  const rnessDir = join(root, '.rness')
  const manifest = await loadManifest(rnessDir)
  assert.deepEqual(
    skillConflicts(rnessDir, manifest, await teamSkills(rnessDir, manifest)),
    []
  )
})

test('skillConflicts: a scope that extends another gets both, so a shared name clashes', async (t) => {
  const root = await makeWorkspace(t, {
    scopes: {
      api: { url: 'u2', skills: { z: decl() } },
      app: { url: 'u3', extends: ['api'], skills: { z: decl() } },
    },
  })
  const rnessDir = join(root, '.rness')
  const manifest = await loadManifest(rnessDir)
  assert.deepEqual(
    skillConflicts(rnessDir, manifest, await teamSkills(rnessDir, manifest)),
    ['skill "z" is declared in scope "api" and in scope "app"']
  )
})

// ---- content: hash, checks, fetch, copy (spec 0041 §3, §4, §9) ----

const SKILL_MD = (name: string, extra = 'description: Does a thing.\n') =>
  `---\nname: ${name}\n${extra}---\n# ${name}\n`

async function tmp(t: TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-skill-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function put(base: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(base, rel)), { recursive: true })
    await writeFile(join(base, rel), content)
  }
}

async function skillDir(
  t: TestContext,
  name = 'demo',
  files: Record<string, string> = {}
): Promise<string> {
  const dir = join(await tmp(t), name)
  await put(dir, { 'SKILL.md': SKILL_MD(name), ...files })
  return dir
}

/**
 * No global git configuration: a test's skill is new to `.rness`, and the
 * developer's own excludes file would leave its untracked files out of the
 * tree (a committed file stays, R37).
 */
function noGlobalGit(t: TestContext): void {
  const was = process.env['GIT_CONFIG_GLOBAL']
  process.env['GIT_CONFIG_GLOBAL'] = '/dev/null'
  t.after(() => {
    if (was === undefined) delete process.env['GIT_CONFIG_GLOBAL']
    else process.env['GIT_CONFIG_GLOBAL'] = was
  })
}

const NO_SCOPES = { version: 2, scopes: {} } as unknown as Manifest

/**
 * What `validate` says of a skill written by the team as `files` under
 * `.rness/skills/<name>/` (a `.rness` with no repository: its tree is the
 * one git would give it): the checks of spec 0041 §4, on that tree.
 */
async function problemsOf(
  t: TestContext,
  name: string,
  files: Record<string, string>,
  prepare: (dir: string) => Promise<void> = async () => {}
): Promise<string[]> {
  noGlobalGit(t)
  const rnessDir = await tmp(t)
  const dir = join(rnessDir, 'skills', name)
  await put(dir, files)
  await prepare(dir)
  return (await checkSkillCopies(rnessDir, NO_SCOPES, { trees: true })).problems
}

test('the checks of §4 on the tree: a good skill passes', async (t) => {
  assert.deepEqual(
    await problemsOf(t, 'demo', { 'SKILL.md': SKILL_MD('demo') }),
    []
  )
})

test('the checks of §4 on the tree: each refusal names the skill and the reason', async (t) => {
  const refused = async (
    name: string,
    files: Record<string, string>,
    re: RegExp,
    prepare?: (dir: string) => Promise<void>
  ) => {
    const problems = await problemsOf(t, name, files, prepare)
    assert.equal(problems.length, 1, problems.join('\n'))
    assert.match(problems[0] ?? '', re)
    assert.match(problems[0] ?? '', new RegExp(`skill "${name}"`))
  }
  await refused('demo', { 'a.txt': 'x' }, /no SKILL\.md/)
  await refused(
    'demo',
    { 'SKILL.md': SKILL_MD('other') },
    /name "other" is not the directory's name "demo"/
  )
  await refused(
    'demo',
    { 'SKILL.md': '---\nname: demo\n---\n' },
    /no description/
  )
  await refused('demo', { 'SKILL.md': '# hi\n' }, /front matter/)
  await refused(
    'Demo',
    { 'SKILL.md': SKILL_MD('Demo') },
    /lowercase letters, digits and hyphens/
  )
  const long = 'a'.repeat(65)
  await refused(long, { 'SKILL.md': SKILL_MD(long) }, /at most 64 characters/)
  await refused(
    'rness',
    { 'SKILL.md': SKILL_MD('rness') },
    /collides with the rness plugin/
  )
  await refused(
    'demo',
    { 'SKILL.md': SKILL_MD('demo') },
    /"alias\.md" is a symbolic link/,
    (dir) => symlink('SKILL.md', join(dir, 'alias.md'))
  )
  await refused(
    'demo',
    { 'SKILL.md': SKILL_MD('demo'), 'big.bin': 'x'.repeat(1048576) },
    /is \d+ bytes, above the limit of 1048576 bytes/
  )
})

test('the checks of §4 on the tree: exactly 1 MB passes', async (t) => {
  const md = SKILL_MD('demo')
  assert.deepEqual(
    await problemsOf(t, 'demo', {
      'SKILL.md': md,
      'pad.bin': 'x'.repeat(1048576 - Buffer.byteLength(md)),
    }),
    []
  )
})

test('the checks of §4 on the tree: what git leaves out is no part of the skill, a SKILL.md it ignores included', async (t) => {
  // The skill's own .gitignore: the large file and the link it names count for nothing.
  assert.deepEqual(
    await problemsOf(
      t,
      'demo',
      {
        'SKILL.md': SKILL_MD('demo'),
        '.gitignore': 'cache/\nlink\n',
        'cache/big.bin': 'x'.repeat(2 * 1048576),
      },
      (dir) => symlink('/etc', join(dir, 'link'))
    ),
    []
  )
  assert.match(
    (
      await problemsOf(t, 'demo', {
        'SKILL.md': SKILL_MD('demo'),
        '.gitignore': 'SKILL.md\n',
      })
    ).join('\n'),
    /skill "demo": no SKILL\.md at the root of its directory/
  )
})

test('skillSourceUrl: github maps to https, git as given, path none', () => {
  assert.equal(
    skillSourceUrl('github:obra/superpowers'),
    'https://github.com/obra/superpowers.git'
  )
  assert.equal(skillSourceUrl('git:ssh://h/r.git'), 'ssh://h/r.git')
  assert.equal(skillSourceUrl('path:../x'), null)
  assert.throws(
    () => skillSourceUrl('github:no-slash'),
    /github:<owner>\/<repo>/
  )
})

/** A repository: skill in `skills/demo`, a tag, an annotated tag, a branch, and a later commit. */
async function fixtureRepo(t: TestContext) {
  const work = await tmp(t)
  await put(work, {
    'skills/demo/SKILL.md': SKILL_MD('demo'),
    'skills/demo/run.sh': '#!/bin/sh\n',
  })
  await chmod(join(work, 'skills/demo/run.sh'), 0o755)
  await git(['init', '-q', '-b', 'main'], work)
  await git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], work)
  await git(['add', '-A'], work)
  await git(['commit', '-q', '-m', 'one'], work)
  const first = (await git(['rev-parse', 'HEAD'], work)).trim()
  await git(['tag', 'light'], work)
  await git(['tag', '-a', 'annot', '-m', 'annotated'], work)
  await git(['branch', 'topic'], work)
  await put(work, { 'skills/demo/extra.md': 'later' })
  await git(['add', '-A'], work)
  await git(['commit', '-q', '-m', 'two'], work)
  const second = (await git(['rev-parse', 'HEAD'], work)).trim()
  await put(work, { 'skills/demo/third.md': 'third' })
  await git(['add', '-A'], work)
  await git(['commit', '-q', '-m', 'three'], work)
  const third = (await git(['rev-parse', 'HEAD'], work)).trim()
  return { work, url: pathToFileURL(work).href, first, second, third }
}

test('fetchRef: a lightweight tag, an annotated tag, a branch, a full SHA that is no tip, HEAD', async (t) => {
  const { url, first, second, third } = await fixtureRepo(t)
  const at = async (ref: string | null) => {
    const dir = await tmp(t)
    return { commit: await fetchRef(url, ref, dir), dir }
  }
  assert.equal((await at('light')).commit, first)
  assert.equal((await at('annot')).commit, first)
  assert.equal((await at('topic')).commit, first)
  // `second` is no tip of any branch or tag: only reachable from main.
  const sha = await at(second)
  assert.equal(sha.commit, second)
  await assert.rejects(stat(join(sha.dir, 'skills/demo/third.md')))
  assert.equal(
    (await stat(join(sha.dir, 'skills/demo/extra.md'))).isFile(),
    true
  )
  const head = await at(null)
  assert.equal(head.commit, third)
  assert.equal(
    (await stat(join(head.dir, 'skills/demo/run.sh'))).mode & 0o100,
    0o100
  )
})

test("fetchRef: a short SHA is refused with the 40 characters wording, an unknown ref with git's error", async (t) => {
  const { url, first } = await fixtureRepo(t)
  await assert.rejects(
    fetchRef(url, first.slice(0, 7), await tmp(t)),
    /a commit ref needs its 40 hexadecimal characters/
  )
  await assert.rejects(
    fetchRef(url, 'nope', await tmp(t)),
    /couldn't find remote ref nope/
  )
  await assert.rejects(
    fetchRef(url, '--upload-pack=x', await tmp(t)),
    /suspicious/
  )
})

test('fetchSkill: a repository subdirectory at a tag, with its commit and a name from the path', async (t) => {
  const { url, first } = await fixtureRepo(t)
  const f = await fetchSkill(await tmp(t), `git:${url}`, {
    path: 'skills/demo',
    ref: 'light',
    credentials: null,
  })
  try {
    assert.equal(f.commit, first)
    assert.equal(f.name, 'demo')
    assert.equal(
      await readFile(join(f.dir, 'SKILL.md'), 'utf8'),
      SKILL_MD('demo')
    )
  } finally {
    await f.release()
  }
  await assert.rejects(stat(f.dir))
})

test('fetchSkill: a path leaving the checkout is refused', async (t) => {
  const { url } = await fixtureRepo(t)
  await assert.rejects(
    fetchSkill(await tmp(t), `git:${url}`, { path: '../x', credentials: null }),
    /leaves the repository/
  )
  await assert.rejects(
    fetchSkill(await tmp(t), `git:${url}`, {
      path: 'nothing',
      credentials: null,
    }),
    /no directory "nothing"/
  )
})

test('fetchSkill: a path: source is read in place, relative to .rness or absolute', async (t) => {
  const base = await tmp(t)
  const rnessDir = join(base, '.rness')
  await put(base, { 'vendor/demo/SKILL.md': SKILL_MD('demo') })
  await mkdir(rnessDir)
  const rel = await fetchSkill(rnessDir, 'path:../vendor/demo', {
    credentials: null,
  })
  assert.equal(rel.dir, join(base, 'vendor/demo'))
  assert.equal(rel.commit, null)
  assert.equal(rel.name, 'demo')
  const abs = await fetchSkill(rnessDir, `path:${join(base, 'vendor/demo')}`, {
    credentials: null,
  })
  assert.equal(abs.dir, rel.dir)
  await rel.release()
  assert.equal((await stat(rel.dir)).isDirectory(), true)
  await assert.rejects(
    fetchSkill(rnessDir, 'path:../missing', { credentials: null }),
    /no directory/
  )
})

test('copySkill: into skills/<name>, executable bit kept, modes 755/644, no .git, replaced whole', async (t) => {
  const { url } = await fixtureRepo(t)
  const rnessDir = join(await tmp(t), '.rness')
  await mkdir(rnessDir)
  const f = await fetchSkill(rnessDir, `git:${url}`, {
    path: 'skills/demo',
    credentials: null,
  })
  const c = await copySkill(rnessDir, f, { scope: null })
  await f.release()
  assert.equal(c.dir, join(rnessDir, 'skills', 'demo'))
  assert.equal(c.name, 'demo')
  assert.equal((await stat(join(c.dir, 'run.sh'))).mode & 0o777, 0o755)
  assert.equal((await stat(join(c.dir, 'SKILL.md'))).mode & 0o777, 0o644)
  assert.match(c.copy.tree, /^[0-9a-f]{40}$/)
  assert.deepEqual(
    c.copy.files.map((f) => [f.path, f.executable]),
    [
      ['SKILL.md', false],
      ['extra.md', false],
      ['run.sh', true],
      ['third.md', false],
    ]
  )
  assert.equal(
    c.copy.bytes,
    c.copy.files.reduce((n, f) => n + f.size, 0)
  )
  assert.deepEqual(c.before, new Map())
  // A second copy replaces the first, leaving no leftover and no stale file.
  await writeFile(join(c.dir, 'stale.md'), 'old')
  const f2 = await fetchSkill(rnessDir, `git:${url}`, {
    path: 'skills/demo',
    credentials: null,
  })
  await copySkill(rnessDir, f2, { scope: 'web' })
  await copySkill(rnessDir, f2, { scope: null })
  await f2.release()
  await assert.rejects(stat(join(c.dir, 'stale.md')))
  assert.deepEqual(await readdir(join(rnessDir, 'skills')), ['demo', 'scopes'])
  assert.deepEqual(await readdir(join(rnessDir, 'skills/scopes/web')), ['demo'])
})

// Decision 8: git decides what a copy holds, and its tree is the fingerprint.

test('copySkill: what git ignores in .rness is no part of the tree; the declared tree is the one a clone of .rness commits', async (t) => {
  noGlobalGit(t)
  const base = await tmp(t)
  const rnessDir = join(base, '.rness')
  await mkdir(rnessDir)
  await writeFile(
    join(rnessDir, '.gitignore'),
    await readFile(
      new URL('../../scaffold/_gitignore', import.meta.url),
      'utf8'
    )
  )
  await git(['init', '-q', '-b', 'main'], rnessDir)
  await put(join(base, 'ops/deploy'), {
    'SKILL.md': SKILL_MD('deploy'),
    '.DS_Store': 'finder junk',
    'refs/.DS_Store': 'finder junk',
    'refs/guide.md': 'guide',
    'node_modules/left-pad/index.js': 'x',
    'node_modules/left-pad/package.json': '{}',
  })
  const fetched = await fetchSkill(rnessDir, 'path:../ops/deploy', {
    credentials: null,
  })
  const copied = await copySkill(rnessDir, fetched, { scope: null })
  assert.deepEqual(
    copied.copy.files.map((f) => f.path),
    ['SKILL.md', 'refs/guide.md']
  )
  await git(['add', '-A'], rnessDir)
  await git(['commit', '-q', '-m', 'skill'], rnessDir)
  const mate = join(base, 'mate')
  await git(['clone', '-q', rnessDir, mate], base)
  assert.equal(
    (await git(['rev-parse', 'HEAD:skills/deploy'], mate)).trim(),
    copied.copy.tree
  )
  // Finder opening a copy later changes nothing git takes.
  await writeFile(join(copied.dir, '.DS_Store'), 'later')
  const again = await checkSkillCopies(
    rnessDir,
    {
      version: 2,
      scopes: {},
      skills: {
        deploy: { source: 'path:../ops/deploy', tree: copied.copy.tree },
      },
    } as unknown as Manifest,
    { trees: true }
  )
  assert.deepEqual(again, { problems: [], reported: [] })
})

test('copySkill: the tree changes with a byte or an executable bit, and is the same for the same files', async (t) => {
  noGlobalGit(t)
  const rnessDir = join(await tmp(t), '.rness')
  await mkdir(rnessDir)
  const src = await skillDir(t, 'demo', { 'run.sh': '#!/bin/sh\n' })
  const copy = async () =>
    (
      await copySkill(
        rnessDir,
        await fetchSkill(rnessDir, `path:${src}`, { credentials: null }),
        { scope: null }
      )
    ).copy.tree
  const first = await copy()
  assert.equal(await copy(), first)
  await chmod(join(src, 'run.sh'), 0o755)
  const exec = await copy()
  assert.notEqual(exec, first)
  await writeFile(join(src, 'run.sh'), '#!/bin/sh\necho\n')
  assert.notEqual(await copy(), exec)
})

test('copySkill: a .rness that is no git repository: the rules of its working tree decide, and nothing else', async (t) => {
  noGlobalGit(t)
  const rnessDir = join(await tmp(t), '.rness')
  await mkdir(rnessDir)
  const src = await skillDir(t, 'demo', {
    'node_modules/a.js': 'x',
    '.gitignore': 'node_modules/\n',
  })
  const fetched = await fetchSkill(rnessDir, `path:${src}`, {
    credentials: null,
  })
  const copied = await copySkill(rnessDir, fetched, { scope: null })
  assert.deepEqual(
    copied.copy.files.map((f) => f.path),
    ['.gitignore', 'SKILL.md']
  )
  // The copy on disk holds the source whole; git leaves the rest out.
  assert.equal(
    (await stat(join(copied.dir, 'node_modules/a.js'))).isFile(),
    true
  )
})

test('copySkill: a .git below the root, in any form, refuses the skill before anything is written to .rness (ruling R35)', async (t) => {
  noGlobalGit(t)
  const rnessDir = join(await tmp(t), '.rness')
  await mkdir(rnessDir)
  const copy = async (src: string) =>
    copySkill(
      rnessDir,
      await fetchSkill(rnessDir, `path:${src}`, { credentials: null }),
      { scope: null }
    )
  // A repository with a commit, one without, a .git directory or file that
  // is no repository, and the names a file system takes for `.git`.
  const nested = await skillDir(t, 'demo', { 'vendor/README.md': 'v' })
  await git(['init', '-q', '-b', 'main'], join(nested, 'vendor'))
  await git(['add', '-A'], join(nested, 'vendor'))
  await git(['commit', '-q', '-m', 'v'], join(nested, 'vendor'))
  const empty = await skillDir(t, 'demo', { 'vendor/README.md': 'v' })
  await git(['init', '-q', '-b', 'main'], join(empty, 'vendor'))
  for (const [src, named] of [
    [nested, 'vendor/.git'],
    [empty, 'vendor/.git'],
    [
      await skillDir(t, 'demo', { 'vendor/.git/config': '[core]\n' }),
      'vendor/.git',
    ],
    [await skillDir(t, 'demo', { 'sub/.git': 'gitdir: ../x\n' }), 'sub/.git'],
    [await skillDir(t, 'demo', { 'a/.GIT/config': 'x' }), 'a/.GIT'],
    [await skillDir(t, 'demo', { 'a/GIT~1/config': 'x' }), 'a/GIT~1'],
    [await skillDir(t, 'demo', { 'a/.git /config': 'x' }), 'a/.git '],
  ] as const) {
    await assert.rejects(copy(src), (e: Error) => {
      assert.equal(
        e.message,
        `skill "demo": "${named}" is a .git below the skill's root; a skill holds no repository`
      )
      return true
    })
    // Nothing written: not even the level's directory.
    await assert.rejects(stat(join(rnessDir, 'skills')))
  }
  // The source's own repository, at its root, is not copied at all.
  const own = await skillDir(t, 'own')
  await git(['init', '-q', '-b', 'main'], own)
  const c = await copy(own)
  await assert.rejects(stat(join(c.dir, '.git')))
})

test('the checks of §4 on the tree: a nested repository in a copy is refused as a gitlink (the second layer)', async (t) => {
  const problems = await problemsOf(
    t,
    'demo',
    { 'SKILL.md': SKILL_MD('demo'), 'vendor/README.md': 'v' },
    async (dir) => {
      await git(['init', '-q', '-b', 'main'], join(dir, 'vendor'))
      await git(['add', '-A'], join(dir, 'vendor'))
      await git(['commit', '-q', '-m', 'v'], join(dir, 'vendor'))
    }
  )
  assert.deepEqual(problems, [
    'skill "demo": "vendor" is a nested repository; a skill holds no repository',
  ])
})

test('isGitName and pathProblem: what a crafted tree may name and no copy may hold (ruling R34)', () => {
  for (const name of [
    '.git',
    '.GIT',
    '.Git',
    '.git.',
    '.git ',
    '.git. .',
    'git~1',
    'GIT~12',
    '.g\u200cit',
    '.git\ufeff',
  ])
    assert.equal(isGitName(name), true, JSON.stringify(name))
  for (const name of [
    'git',
    '.gitignore',
    '.github',
    'a.git',
    'git~',
    '.git-x',
  ])
    assert.equal(isGitName(name), false, name)
  for (const path of [
    'SKILL.md',
    'refs/guide.md',
    '.gitignore',
    'a..b',
    '..x',
    'x..',
  ])
    assert.equal(pathProblem(path), null, path)
  for (const [path, problem] of [
    ['..', /empty, "\." or "\.\." part/],
    ['../evil.md', /empty, "\." or "\.\." part/],
    ['a/../b', /empty, "\." or "\.\." part/],
    ['./a', /empty, "\." or "\.\." part/],
    ['a//b', /empty, "\." or "\.\." part/],
    ['a/', /empty, "\." or "\.\." part/],
    ['.git/config', /names a \.git/],
    ['a/.GIT/hooks/x', /names a \.git/],
    ['a/git~1/x', /names a \.git/],
    ['a\\b', /backslash/],
    ['c:/x', /colon/],
    ['a\u001bb', /control character/],
    ['a\u202eb', /zero-width or bidirectional/],
  ] as const)
    assert.match(pathProblem(path) ?? '', problem, path)
})

test("copySkill: a repository root takes the name of its SKILL.md, not the repository's", async (t) => {
  const work = await tmp(t)
  const repo = join(work, 'some-repo-name')
  await put(repo, { 'SKILL.md': SKILL_MD('brainstorming') })
  await git(['init', '-q', '-b', 'main'], repo)
  await git(['add', '-A'], repo)
  await git(['commit', '-q', '-m', 'x'], repo)
  const rnessDir = join(work, '.rness')
  await mkdir(rnessDir)
  const url = `git:${pathToFileURL(repo).href}`
  const f = await fetchSkill(rnessDir, url, { credentials: null })
  assert.equal(f.name, 'brainstorming')
  const c = await copySkill(rnessDir, f, { scope: null })
  assert.equal(c.dir, join(rnessDir, 'skills', 'brainstorming'))
  const r = await copySkill(rnessDir, f, { scope: null, name: 'brain' })
  assert.equal(r.dir, join(rnessDir, 'skills', 'brain'))
  await f.release()
})

test('fetchSkill: a subdirectory whose SKILL.md name is not its directory is refused at the copy', async (t) => {
  const work = await tmp(t)
  const repo = join(work, 'r')
  await put(repo, { 'sub/SKILL.md': SKILL_MD('other') })
  await git(['init', '-q', '-b', 'main'], repo)
  await git(['add', '-A'], repo)
  await git(['commit', '-q', '-m', 'x'], repo)
  const rnessDir = join(work, '.rness')
  await mkdir(rnessDir)
  const f = await fetchSkill(rnessDir, `git:${pathToFileURL(repo).href}`, {
    path: 'sub',
    credentials: null,
  })
  assert.equal(f.name, 'sub')
  await assert.rejects(
    copySkill(rnessDir, f, { scope: null }),
    /not the directory's name "sub"/
  )
  await f.release()
})

test('copySkill: a refused source writes nothing', async (t) => {
  const base = await tmp(t)
  const rnessDir = join(base, '.rness')
  await mkdir(rnessDir)
  const src = join(base, 'demo')
  await put(src, { 'SKILL.md': SKILL_MD('other') })
  const f = await fetchSkill(rnessDir, `path:${src}`, { credentials: null })
  await assert.rejects(
    copySkill(rnessDir, f, { scope: null }),
    /not the directory's name/
  )
  await assert.rejects(stat(join(rnessDir, 'skills')))
})

test('copySkill --name: only the name line changes, the tree is taken after, the old name is no copy', async (t) => {
  const base = await tmp(t)
  const rnessDir = join(base, '.rness')
  await mkdir(rnessDir)
  const src = join(base, 'demo')
  const md =
    '---\r\nname: demo\r\ndescription: keeps the name\r\n---\r\nname: demo\r\n'
  await put(src, { 'SKILL.md': md, 'a.txt': 'a' })
  const f = await fetchSkill(rnessDir, `path:${src}`, { credentials: null })
  const c = await copySkill(rnessDir, f, { scope: 'web', name: 'renamed' })
  assert.equal(c.name, 'renamed')
  assert.equal(c.dir, join(rnessDir, 'skills/scopes/web/renamed'))
  assert.equal(
    await readFile(join(c.dir, 'SKILL.md'), 'utf8'),
    md.replace('name: demo\r\ndescription', 'name: renamed\r\ndescription')
  )
  const plain = await copySkill(rnessDir, f, { scope: null })
  assert.notEqual(c.copy.tree, plain.copy.tree)
  assert.equal(await readFile(join(src, 'SKILL.md'), 'utf8'), md)
  await assert.rejects(
    copySkill(rnessDir, f, { scope: null, name: 'Bad Name' }),
    /lowercase letters, digits and hyphens/
  )
})

test('copySkill over a copy, and diffSkillFiles: added, changed (mode too), removed', async (t) => {
  const rnessDir = join(await tmp(t), '.rness')
  await mkdir(rnessDir)
  const a = await skillDir(t, 'demo', {
    'k.txt': 'k',
    'gone.txt': 'g',
    'run.sh': 'r',
  })
  const copy = async () =>
    copySkill(
      rnessDir,
      await fetchSkill(rnessDir, `path:${a}`, { credentials: null }),
      { scope: null }
    )
  const first = await copy()
  await rm(join(a, 'gone.txt'))
  await writeFile(join(a, 'k.txt'), 'changed')
  await chmod(join(a, 'run.sh'), 0o755)
  await writeFile(join(a, 'new.txt'), 'n')
  const second = await copy()
  assert.deepEqual(second.before, fileDigests(first.copy.files))
  const d = diffSkillFiles(second.before, fileDigests(second.copy.files))
  assert.deepEqual(d, {
    added: ['new.txt'],
    changed: ['k.txt', 'run.sh'],
    removed: ['gone.txt'],
  })
})

test('teamSkills: a symbolic link under skills/ is a skill entry the checks refuse; other errors are not swallowed', async (t) => {
  const root = await makeWorkspace(t, {})
  const rnessDir = join(root, '.rness')
  await mkdir(join(rnessDir, 'skills'))
  await symlink('/tmp', join(rnessDir, 'skills', 'lnk'))
  const manifest = await loadManifest(rnessDir)
  const all = await teamSkills(rnessDir, manifest)
  assert.deepEqual(
    all.map((s) => s.name),
    ['lnk']
  )
  for (const trees of [true, false])
    assert.deepEqual(
      (await checkSkillCopies(rnessDir, manifest, { trees })).problems,
      [
        'skill "lnk": skills/lnk is a symbolic link; only regular files and directories are allowed',
      ]
    )
  // A skills "directory" that is a file is no ENOENT: it is not hidden.
  const root2 = await makeWorkspace(t, { files: { skills: 'x' } })
  const dir2 = join(root2, '.rness')
  await assert.rejects(teamSkills(dir2, await loadManifest(dir2)), /ENOTDIR/)
})

test('checkSkillCopies: a declared copy that is missing, a refusal, a tree mismatch reported', async (t) => {
  const good = SKILL_MD('good')
  const root = await makeWorkspace(t, {
    skills: { good: decl(), gone: decl() },
    scopes: { web: { url: 'u', skills: { bad: decl() } } },
    files: {
      'skills/good/SKILL.md': good,
      'skills/scopes/web/bad/SKILL.md': '---\nname: bad\n---\n',
      'skills/mine/SKILL.md': SKILL_MD('other'),
    },
  })
  const rnessDir = join(root, '.rness')
  const manifest = await loadManifest(rnessDir)
  const r = await checkSkillCopies(rnessDir, manifest, { trees: true })
  assert.deepEqual(r.problems, [
    'skill "gone" is declared but its copy skills/gone is missing: run rness skill update gone',
    'skill "mine": SKILL.md name "other" is not the directory\'s name "mine"',
    'skill "bad": SKILL.md has no description',
  ])
  assert.deepEqual(r.reported, [
    'skill "good" differs from its source: run rness skill update, or remove its source to make it the team\'s own',
  ])
})

test('checkSkillCopies: a copy at its tree is silent', async (t) => {
  const root = await makeWorkspace(t, {
    skills: { good: decl() },
    files: { 'skills/good/SKILL.md': SKILL_MD('good') },
  })
  const rnessDir = join(root, '.rness')
  await git(['init', '-q', '-b', 'main'], rnessDir)
  await git(['add', '-A'], rnessDir)
  await git(['commit', '-q', '-m', 'good'], rnessDir)
  const tree = (await git(['rev-parse', 'HEAD:skills/good'], rnessDir)).trim()
  const manifest = await loadManifest(rnessDir)
  const declared = {
    ...manifest,
    skills: { good: { source: 'github:o/r', tree } },
  }
  assert.deepEqual(
    await checkSkillCopies(rnessDir, declared, { trees: true }),
    { problems: [], reported: [] }
  )
  // At HEAD, the same tree, checked.
  const head = (
    await skillsAtHead(rnessDir, [
      { name: 'good', dir: join(rnessDir, 'skills/good') },
    ])
  ).get(join(rnessDir, 'skills/good'))
  assert.equal(head instanceof Error || head === null ? null : head?.tree, tree)
})

test('checkSkillCopies without trees (the safety net of every turn): SKILL.md alone, no tree built', async (t) => {
  const root = await makeWorkspace(t, {
    skills: { good: decl() },
    files: {
      'skills/good/SKILL.md': SKILL_MD('good'),
      'skills/big/SKILL.md': SKILL_MD('big'),
      'skills/big/big.bin': 'x'.repeat(2 * 1048576),
      'skills/bad/SKILL.md': '---\nname: bad\n---\n',
    },
  })
  const rnessDir = join(root, '.rness')
  const manifest = await loadManifest(rnessDir)
  // No tree: the size of a copy and a declared tree are validate's to say.
  assert.deepEqual(
    await checkSkillCopies(rnessDir, manifest, { trees: false }),
    {
      problems: ['skill "bad": SKILL.md has no description'],
      reported: [],
    }
  )
  const full = await checkSkillCopies(rnessDir, manifest, { trees: true })
  assert.deepEqual(full.problems, [
    'skill "bad": SKILL.md has no description',
    'skill "big": its content is 2097203 bytes, above the limit of 1048576 bytes (1 MB)',
  ])
  assert.equal(full.reported.length, 1)
})

test('copySkill: a top-level skill named scopes is refused and the scoped tree is kept', async (t) => {
  const base = await tmp(t)
  const rnessDir = join(base, '.rness')
  const src = join(base, 'scopes')
  await put(src, { 'SKILL.md': SKILL_MD('scopes') })
  await put(rnessDir, { 'skills/scopes/web/keep/SKILL.md': 'x' })
  const f = await fetchSkill(rnessDir, `path:${src}`, { credentials: null })
  await assert.rejects(
    copySkill(rnessDir, f, { scope: null }),
    /"scopes" is the directory of the scoped skills/
  )
  await stat(join(rnessDir, 'skills/scopes/web/keep/SKILL.md'))
  const ok = await copySkill(rnessDir, f, { scope: 'web' })
  assert.equal(ok.dir, join(rnessDir, 'skills/scopes/web/scopes'))
})

test('copySkill: a symbolic link at skills, skills/scopes or a scope directory is refused, nothing written through it', async (t) => {
  const base = await tmp(t)
  const rnessDir = join(base, '.rness')
  const outside = join(base, 'outside')
  const src = join(base, 'demo')
  await put(src, { 'SKILL.md': SKILL_MD('demo') })
  await mkdir(outside)
  await mkdir(join(rnessDir, 'skills', 'scopes'), { recursive: true })
  await symlink(outside, join(rnessDir, 'skills', 'scopes', 'web'))
  const f = await fetchSkill(rnessDir, `path:${src}`, { credentials: null })
  await assert.rejects(
    copySkill(rnessDir, f, { scope: 'web' }),
    /skills\/scopes\/web is a symbolic link/
  )
  await rm(join(rnessDir, 'skills', 'scopes'), { recursive: true })
  await symlink(outside, join(rnessDir, 'skills', 'scopes'))
  await assert.rejects(
    copySkill(rnessDir, f, { scope: 'web' }),
    /skills\/scopes is a symbolic link/
  )
  await rm(join(rnessDir, 'skills'), { recursive: true })
  await symlink(outside, join(rnessDir, 'skills'))
  await assert.rejects(
    copySkill(rnessDir, f, { scope: null }),
    /skills is a symbolic link/
  )
  assert.deepEqual(await readdir(outside), [])
})

test('checkSkillCopies: a symbolic link at skills/scopes or a scope directory is refused, not read through', async (t) => {
  const root = await makeWorkspace(t, {
    scopes: { web: { url: 'u' } },
    files: { 'skills/mine/SKILL.md': SKILL_MD('mine') },
  })
  const rnessDir = join(root, '.rness')
  const outside = join(root, 'outside')
  await put(outside, { 'evil/SKILL.md': 'x' })
  await symlink(outside, join(rnessDir, 'skills', 'scopes'))
  const manifest = await loadManifest(rnessDir)
  assert.deepEqual(
    await checkSkillCopies(rnessDir, manifest, { trees: true }),
    {
      problems: [
        'skills: skills/scopes is a symbolic link; only regular files and directories are allowed',
      ],
      reported: [],
    }
  )
  assert.deepEqual(
    (await teamSkills(rnessDir, manifest)).map((s) => s.name),
    ['mine']
  )
})

test('copySkill --name: a quoted name with a comment keeps its quotes and comment, other bytes untouched', async (t) => {
  const base = await tmp(t)
  const rnessDir = join(base, '.rness')
  await mkdir(rnessDir)
  const src = join(base, 'demo')
  const head = Buffer.from('---\nname: "demo"  # c\ndescription: d\n---\n')
  const tail = Buffer.from([0xff, 0xfe, 0x0a])
  await mkdir(src)
  await writeFile(join(src, 'SKILL.md'), Buffer.concat([head, tail]))
  const f = await fetchSkill(rnessDir, `path:${src}`, { credentials: null })
  const c = await copySkill(rnessDir, f, { scope: null, name: 'new-name' })
  assert.deepEqual(
    await readFile(join(c.dir, 'SKILL.md')),
    Buffer.concat([
      Buffer.from('---\nname: "new-name"  # c\ndescription: d\n---\n'),
      tail,
    ])
  )
})

test('fetchRef: credentials never follow a redirect to another host', async (t) => {
  const { createServer } = await import('node:http')
  const hits: string[] = []
  const target = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
  const port = (target.address() as { port: number }).port
  const redirector = createServer((req, res) => {
    res.statusCode = 302
    res.setHeader('location', `http://127.0.0.1:${port}${req.url}`)
    res.end()
  })
  await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r))
  t.after(() => {
    target.close()
    redirector.close()
  })
  const url = `http://127.0.0.1:${(redirector.address() as { port: number }).port}/r.git`
  const creds = { username: 'u', password: 'p' }
  await assert.rejects(fetchRef(url, null, await tmp(t), creds))
  assert.deepEqual(hits, [])
  await assert.rejects(fetchRef(url, null, await tmp(t), null))
  assert.notDeepEqual(hits, [])
})

test('the checks of §4: a control character in a description, allowed-tools or file name is refused; a multi-line description is not', async (t) => {
  const withMd = async (md: string) => {
    const dir = await skillDir(t, 'demo')
    await writeFile(join(dir, 'SKILL.md'), md)
    return dir
  }
  const md = (extra: string) => `---\nname: demo\n${extra}---\nBody\n`
  await assert.rejects(
    readSkillMd(
      await withMd(
        md('description: "ok\\e[2Kfake"\n').replace('\\e', '\\u001b')
      ),
      'demo'
    ),
    /demo.*description holds a control character/
  )
  await assert.rejects(
    readSkillMd(
      await withMd(md('description: x\nallowed-tools: "a\\u0007b"\n')),
      'demo'
    ),
    /allowed-tools holds a control character/
  )
  await assert.rejects(
    readSkillMd(await withMd(md('description: "a\\u0085b"\n')), 'demo'),
    /description holds a control character/
  )
  await readSkillMd(
    await withMd(md('description: |\n  line one\n  line\ttwo\n')),
    'demo'
  )
  assert.match(
    (
      await problemsOf(t, 'demo', {
        'SKILL.md': SKILL_MD('demo'),
        'bad\u001b[2Kname.md': 'x',
      })
    ).join('\n'),
    /file name .* holds a control character/
  )
})

test('plainText replaces control characters; allowedToolsText shows absent as null and others as they are', () => {
  assert.equal(plainText('a\u001b[2Kb\u0085c'), 'a?[2Kb?c')
  assert.equal(plainText('one\ttwo\r\nthree'), 'one two  three')
  assert.equal(allowedToolsText(undefined), null)
  assert.equal(allowedToolsText('Read, Grep'), 'Read, Grep')
  assert.equal(allowedToolsText(['Read', 'Grep']), 'Read, Grep')
  assert.equal(allowedToolsText({ a: 1 }), '{"a":1}')
  // An empty list is shown as declared, never as nothing (final review 7).
  assert.equal(allowedToolsText([]), '[]')
  assert.equal(allowedToolsText(3), '3')
})

// Ruling R21: a value from a skill, a fetched tree or the manifest is escaped
// where a message is made.
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/

test('quoted escapes quotes, C0, DEL and C1 characters', () => {
  assert.equal(quoted('a"b'), '"a\\"b"')
  assert.equal(quoted('\u001b[2K\u007f\u0085'), '"\\u001b[2K\\u007f\\u0085"')
  assert.equal(quoted('plain'), '"plain"')
})

// Bidirectional controls and zero-width characters reorder or hide text on a
// terminal: replaced on display, escaped in messages, refused in a file name
// (final review 13).
const INVISIBLE = [
  '\u200b',
  '\u200d',
  '\u200f',
  '\u202a',
  '\u202e',
  '\u2066',
  '\u2069',
  '\ufeff',
]
const RAW_INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/

test('plainText and quoted neutralise bidirectional controls and zero-width characters', () => {
  for (const c of INVISIBLE) {
    assert.equal(plainText(`a${c}b`), 'a?b')
    const q = quoted(`a${c}b`)
    assert.doesNotMatch(q, RAW_INVISIBLE)
    assert.equal(q, `"a\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}b"`)
  }
  // Their neighbours are left alone.
  assert.equal(plainText('a\u200a\u2010\u2065b'), 'a\u200a\u2010\u2065b')
})

test('the checks of §4: a bidirectional or zero-width character in a file name or the name is refused, escaped', async (t) => {
  for (const c of ['\u202e', '\u200b', '\ufeff', '\u2066']) {
    const [problem = ''] = await problemsOf(t, 'demo', {
      'SKILL.md': SKILL_MD('demo'),
      [`evil${c}dm.md`]: 'x',
    })
    assert.doesNotMatch(problem, RAW_INVISIBLE)
    assert.match(problem, /file name "evil\\u[0-9a-f]{4}dm\.md" holds/)
  }
  const dir = await skillDir(t, 'demo')
  await writeFile(
    join(dir, 'SKILL.md'),
    '---\nname: "de\u202emo"\ndescription: d\n---\nB\n'
  )
  await assert.rejects(readSkillMd(dir, 'demo'), (e: Error) => {
    assert.doesNotMatch(e.message, RAW_INVISIBLE)
    assert.match(e.message, /SKILL\.md name "de\\u202emo" is not/)
    return true
  })
})

test('a fetched tree holding a file named with ESC is refused without a raw ESC', async (t) => {
  const src = await skillDir(t, 'demo', { 'bad\u001b[2Kname.md': 'x' })
  const rnessDir = await tmp(t)
  const fetched = await fetchSkill(rnessDir, `path:${src}`, {
    credentials: null,
  })
  await assert.rejects(
    copySkill(rnessDir, fetched, { scope: null }),
    (e: Error) => {
      assert.doesNotMatch(e.message, RAW_CONTROL)
      assert.match(e.message, /bad\\u001b\[2Kname\.md/)
      return true
    }
  )
})

test('a SKILL.md name holding ESC, not the directory name, is refused without a raw ESC', async (t) => {
  const dir = await skillDir(t, 'demo')
  await writeFile(
    join(dir, 'SKILL.md'),
    '---\nname: "x\\u001b[2Ky\\u0085"\ndescription: d\n---\nB\n'
  )
  await assert.rejects(readSkillMd(dir, 'demo'), (e: Error) => {
    assert.doesNotMatch(e.message, RAW_CONTROL)
    assert.match(e.message, /SKILL\.md name "x\\u001b\[2Ky\\u0085" is not/)
    return true
  })
})

test('a source and a path with control characters are escaped in the refusals', async (t) => {
  const rnessDir = await tmp(t)
  await assert.rejects(
    fetchSkill(rnessDir, 'path:nope\u001b[2K', { credentials: null }),
    (e: Error) => !RAW_CONTROL.test(e.message)
  )
  assert.throws(
    () => skillSourceUrl('bad\u001b[2K'),
    (e: Error) => !RAW_CONTROL.test(e.message)
  )
  await assert.rejects(
    fetchSkill(rnessDir, 'git:/nonexistent\u001b[2Krepo', {
      credentials: null,
    }),
    (e: Error) => !RAW_CONTROL.test(e.message)
  )
})

test('checkSkillCopies: a copy named with ESC is reported without a raw ESC', async (t) => {
  const rnessDir = await tmp(t)
  await put(rnessDir, {
    'skills/a\u001b[2Kb/SKILL.md': SKILL_MD('ab'),
    'skills/ok/bad\u001b[2K.md': 'x',
    'skills/ok/SKILL.md': SKILL_MD('ok'),
  })
  const { problems, reported } = await checkSkillCopies(rnessDir, NO_SCOPES, {
    trees: true,
  })
  assert.equal(problems.length, 2)
  for (const line of [...problems, ...reported])
    assert.doesNotMatch(line, RAW_CONTROL)
})

test('blockSkills: a SKILL.md that is a link, a skill directory that is a link, or a SKILL.md above 1 MB is never read nor listed (ruling R35)', async (t) => {
  const root = await makeWorkspace(t, {
    files: {
      'skills/plain/SKILL.md': SKILL_MD('plain'),
      'skills/linked-md/x.md': 'x',
      'skills/huge/SKILL.md': `${SKILL_MD('huge')}${'x'.repeat(1048576)}`,
    },
  })
  const rnessDir = join(root, '.rness')
  const outside = await tmp(t)
  await put(outside, {
    'SKILL.md': SKILL_MD('linked-md'),
    'dir/SKILL.md': SKILL_MD('linked-dir'),
  })
  await symlink(
    join(outside, 'SKILL.md'),
    join(rnessDir, 'skills/linked-md/SKILL.md')
  )
  await symlink(join(outside, 'dir'), join(rnessDir, 'skills/linked-dir'))
  const manifest = await loadManifest(rnessDir)
  assert.deepEqual(await blockSkills(rnessDir, manifest, null), [
    { name: 'plain', description: 'Does a thing.', written: true },
  ])
  // The per-turn safety net says why, without reading through the links.
  assert.deepEqual(
    (await checkSkillCopies(rnessDir, manifest, { trees: false })).problems,
    [
      `skill "huge": SKILL.md is ${Buffer.byteLength(SKILL_MD('huge')) + 1048576} bytes, above the limit of 1048576 bytes (1 MB)`,
      'skill "linked-dir": skills/linked-dir is a symbolic link; only regular files and directories are allowed',
      'skill "linked-md": "SKILL.md" is a symbolic link; only regular files and directories are allowed',
    ]
  )
})

test('blockSkills: name and one-line plain description of each valid skill that applies to the scope', async (t) => {
  const md = (name: string, description: string) =>
    `---\nname: ${name}\ndescription: "${description}"\n---\nBody\n`
  const root = await makeWorkspace(t, {
    skills: { a: decl() },
    scopes: {
      web: { url: 'u1', skills: { c: decl() } },
      api: { url: 'u2', skills: { z: decl() } },
    },
    files: {
      'skills/a/SKILL.md': md('a', 'Does a.'),
      'skills/b/SKILL.md': md('b', 'Line one\\ttwo'),
      'skills/bad/SKILL.md': '---\nname: bad\n---\n',
      'skills/scopes/web/c/SKILL.md': md('c', 'Does c.'),
      'skills/scopes/api/z/SKILL.md': md('z', 'Does z.'),
    },
  })
  const rnessDir = join(root, '.rness')
  const manifest = await loadManifest(rnessDir)
  assert.deepEqual(await blockSkills(rnessDir, manifest, 'web'), [
    { name: 'a', description: 'Does a.' },
    { name: 'b', description: 'Line one two', written: true },
    { name: 'c', description: 'Does c.' },
  ])
  assert.deepEqual(
    (await blockSkills(rnessDir, manifest, null)).map((s) => s.name),
    ['a', 'b']
  )
})

// ---- Rework fix round 1 ----

/** `.rness` as a committed repository holding team skill `good`, declared at the tree HEAD gives it. */
async function committedGood(t: TestContext) {
  const root = await makeWorkspace(t, {
    files: { 'skills/good/SKILL.md': SKILL_MD('good') },
  })
  const rnessDir = join(root, '.rness')
  await git(['init', '-q', '-b', 'main'], rnessDir)
  await git(['add', '-A'], rnessDir)
  await git(['commit', '-q', '-m', 'good'], rnessDir)
  const tree = (await git(['rev-parse', 'HEAD:skills/good'], rnessDir)).trim()
  const manifest = {
    ...(await loadManifest(rnessDir)),
    skills: { good: { source: 'github:o/r', tree } },
  }
  return { rnessDir, manifest, tree }
}

test("a git variable of the caller's environment (GIT_OBJECT_DIRECTORY) never reaches the git calls on .rness's trees", async (t) => {
  const { rnessDir, manifest, tree } = await committedGood(t)
  const elsewhere = await tmp(t)
  const was = process.env['GIT_OBJECT_DIRECTORY']
  process.env['GIT_OBJECT_DIRECTORY'] = elsewhere
  t.after(() => {
    if (was === undefined) delete process.env['GIT_OBJECT_DIRECTORY']
    else process.env['GIT_OBJECT_DIRECTORY'] = was
  })
  const at = join(rnessDir, 'skills/good')
  const head = (await skillsAtHead(rnessDir, [{ name: 'good', dir: at }])).get(
    at
  )
  assert.equal(head instanceof Error || head === null ? head : head?.tree, tree)
  assert.deepEqual(
    await checkSkillCopies(rnessDir, manifest, { trees: true }),
    { problems: [], reported: [] }
  )
  assert.deepEqual(await readdir(elsewhere), [])
})

test('a .rness git refuses to open is reported, never taken for no repository (no temporary database then)', async (t) => {
  const { rnessDir, manifest } = await committedGood(t)
  await git(['config', 'core.repositoryformatversion', '99'], rnessDir)
  await assert.rejects(
    checkSkillCopies(rnessDir, manifest, { trees: true }),
    // git's own words depend on the locale: the command and the version.
    /git rev-parse failed: .*99/
  )
})

test("fetchSkill: a repository root whose SKILL.md is a link is never read through it for the skill's name", async (t) => {
  const work = await tmp(t)
  const outside = join(work, 'outside.md')
  await writeFile(outside, SKILL_MD('stolen'))
  const repo = join(work, 'linked-root')
  await mkdir(repo)
  await symlink(outside, join(repo, 'SKILL.md'))
  await git(['init', '-q', '-b', 'main'], repo)
  await git(['add', '-A'], repo)
  await git(['commit', '-q', '-m', 'x'], repo)
  const rnessDir = join(work, '.rness')
  await mkdir(rnessDir)
  const f = await fetchSkill(rnessDir, `git:${pathToFileURL(repo).href}`, {
    credentials: null,
  })
  try {
    assert.equal(f.name, 'linked-root')
    await assert.rejects(
      copySkill(rnessDir, f, { scope: null }),
      /"SKILL\.md" is a symbolic link/
    )
  } finally {
    await f.release()
  }
})

test("reserved names: a skill the team wrote cannot take one of rness's own (status, adr, spec, plan); a declared one can", async (t) => {
  const root = await makeWorkspace(t, {
    skills: { plan: decl() },
    files: {
      'skills/plan/SKILL.md': SKILL_MD('plan'),
      'skills/status/SKILL.md': SKILL_MD('status'),
      'skills/adr/SKILL.md': SKILL_MD('adr'),
      'skills/spec/SKILL.md': SKILL_MD('spec'),
      'skills/release/SKILL.md': SKILL_MD('release'),
      'skills/done/SKILL.md': SKILL_MD('done'),
    },
  })
  const rnessDir = join(root, '.rness')
  const manifest = await loadManifest(rnessDir)
  for (const trees of [true, false]) {
    const { problems } = await checkSkillCopies(rnessDir, manifest, { trees })
    assert.deepEqual(
      problems.filter((p) => !p.includes('differs')).sort(),
      ['adr', 'done', 'spec', 'status'].map(
        (n) =>
          `skill "${n}": "${n}" is a name rness reserves for its plugin; a team skill is installed there as /rness:${n}`
      ),
      `trees: ${trees}`
    )
  }
  // Not listed in the blocks either.
  assert.deepEqual(
    (await blockSkills(rnessDir, manifest, null)).map((s) => s.name),
    ['plan', 'release']
  )
})
