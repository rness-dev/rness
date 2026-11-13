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
  checkSkillCopies,
  checkSkillDir,
  copySkill,
  diffSkillFiles,
  fetchSkill,
  hashSkillDir,
  plainText,
  skillConflicts,
  skillFileDigests,
  skillSourceUrl,
  skillsForClone,
  skillsForScope,
  teamSkills,
} from '../../src/core/skills.ts'
import { git } from '../helpers/git.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const HASH = `sha256-${'A'.repeat(43)}=`
const decl = (source = 'github:o/r') => ({ source, hash: HASH })

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

test('hashSkillDir: sha256 base64, deterministic, content, path and mode all count', async (t) => {
  const a = await skillDir(t, 'demo', { 'run.sh': '#!/bin/sh\n' })
  const h = await hashSkillDir(a)
  assert.match(h, /^sha256-[A-Za-z0-9+/]{43}=$/)
  assert.equal(await hashSkillDir(a), h)
  await chmod(join(a, 'run.sh'), 0o755)
  const exec = await hashSkillDir(a)
  assert.notEqual(exec, h)
  await writeFile(join(a, 'run.sh'), '#!/bin/sh\necho\n')
  assert.notEqual(await hashSkillDir(a), exec)
  const b = await skillDir(t, 'demo', { 'other.sh': '#!/bin/sh\n' })
  const c = await skillDir(t, 'demo', { 'run.sh': '#!/bin/sh\n' })
  assert.notEqual(await hashSkillDir(b), await hashSkillDir(c))
})

test('hashSkillDir: the exact encoding, byte-ordered paths, a root .git ignored', async (t) => {
  const { createHash } = await import('node:crypto')
  const dir = await skillDir(t, 'demo', {
    'b.txt': 'bb',
    'B/x': 'x',
    '.git/HEAD': 'ref',
  })
  const md = SKILL_MD('demo')
  const want = createHash('sha256')
  for (const [p, body] of [
    ['B/x', 'x'],
    ['SKILL.md', md],
    ['b.txt', 'bb'],
  ] as const)
    want.update(`${p}\0-\0${Buffer.byteLength(body)}\0` + body)
  assert.equal(await hashSkillDir(dir), `sha256-${want.digest('base64')}`)
})

test('checkSkillDir: a good skill passes and reports its size', async (t) => {
  const dir = await skillDir(t)
  const c = await checkSkillDir(dir, 'demo')
  assert.equal(c.bytes, Buffer.byteLength(SKILL_MD('demo')))
})

test('checkSkillDir: each refusal of §4 names the skill and the reason', async (t) => {
  const refused = async (dir: string, name: string, re: RegExp) =>
    assert.rejects(checkSkillDir(dir, name), (e: Error) => {
      assert.match(e.message, re)
      assert.match(e.message, new RegExp(`skill "${name}"`))
      return true
    })
  const none = join(await tmp(t), 'demo')
  await mkdir(none)
  await refused(none, 'demo', /no SKILL\.md/)
  await refused(
    await skillDir(t, 'other'),
    'demo',
    /name "other" is not the directory's name "demo"/
  )
  const nodesc = join(await tmp(t), 'demo')
  await put(nodesc, { 'SKILL.md': '---\nname: demo\n---\n' })
  await refused(nodesc, 'demo', /no description/)
  const nofm = join(await tmp(t), 'demo')
  await put(nofm, { 'SKILL.md': '# hi\n' })
  await refused(nofm, 'demo', /front matter/)
  const upper = join(await tmp(t), 'Demo')
  await put(upper, { 'SKILL.md': SKILL_MD('Demo') })
  await refused(upper, 'Demo', /lowercase letters, digits and hyphens/)
  const long = 'a'.repeat(65)
  await refused(await skillDir(t, long), long, /at most 64 characters/)
  await refused(
    await skillDir(t, 'rness'),
    'rness',
    /collides with the rness plugin/
  )
  const link = await skillDir(t)
  await symlink('SKILL.md', join(link, 'alias.md'))
  await refused(link, 'demo', /"alias\.md" is a symbolic link/)
  const big = await skillDir(t, 'demo', { 'big.bin': 'x'.repeat(1048576) })
  await refused(big, 'demo', /is \d+ bytes, above the limit of 1048576 bytes/)
})

test('checkSkillDir: exactly 1 MB passes', async (t) => {
  const dir = join(await tmp(t), 'demo')
  const md = SKILL_MD('demo')
  await put(dir, {
    'SKILL.md': md,
    'pad.bin': 'x'.repeat(1048576 - Buffer.byteLength(md)),
  })
  assert.equal((await checkSkillDir(dir, 'demo')).bytes, 1048576)
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
  assert.equal(c.hash, await hashSkillDir(c.dir))
  assert.equal(c.bytes, (await checkSkillDir(c.dir, 'demo')).bytes)
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

test('copySkill --name: only the name line changes, the hash is taken after, the old name is no copy', async (t) => {
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
  assert.equal(c.hash, await hashSkillDir(c.dir))
  assert.notEqual(c.hash, await hashSkillDir(src))
  assert.equal(await readFile(join(src, 'SKILL.md'), 'utf8'), md)
  await assert.rejects(
    copySkill(rnessDir, f, { scope: null, name: 'Bad Name' }),
    /lowercase letters, digits and hyphens/
  )
})

test('skillFileDigests and diffSkillFiles: added, changed (mode too), removed', async (t) => {
  const a = await skillDir(t, 'demo', {
    'k.txt': 'k',
    'gone.txt': 'g',
    'run.sh': 'r',
  })
  const before = await skillFileDigests(a)
  await rm(join(a, 'gone.txt'))
  await writeFile(join(a, 'k.txt'), 'changed')
  await chmod(join(a, 'run.sh'), 0o755)
  await writeFile(join(a, 'new.txt'), 'n')
  const d = diffSkillFiles(before, await skillFileDigests(a))
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
  const { problems } = await checkSkillCopies(rnessDir, manifest)
  assert.deepEqual(problems, [
    'skill "lnk": skills/lnk is a symbolic link; only regular files and directories are allowed',
  ])
  // A skills "directory" that is a file is no ENOENT: it is not hidden.
  const root2 = await makeWorkspace(t, { files: { skills: 'x' } })
  const dir2 = join(root2, '.rness')
  await assert.rejects(teamSkills(dir2, await loadManifest(dir2)), /ENOTDIR/)
})

test('checkSkillCopies: a declared copy that is missing, a refusal, a hash mismatch reported', async (t) => {
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
  const r = await checkSkillCopies(rnessDir, manifest)
  assert.deepEqual(r.problems, [
    'skill "gone" is declared but its copy skills/gone is missing: run rness skill update gone',
    'skill "mine": SKILL.md name "other" is not the directory\'s name "mine"',
    'skill "bad": SKILL.md has no description',
  ])
  assert.deepEqual(r.reported, [
    'skill "good" differs from its source: run rness skill update, or remove its source to make it the team\'s own',
  ])
})

test('checkSkillCopies: a copy at its hash is silent', async (t) => {
  const dir = await skillDir(t, 'good')
  const hash = await hashSkillDir(dir)
  const root = await makeWorkspace(t, {
    skills: { good: { source: 'github:o/r', hash } },
    files: { 'skills/good/SKILL.md': SKILL_MD('good') },
  })
  const rnessDir = join(root, '.rness')
  const r = await checkSkillCopies(rnessDir, await loadManifest(rnessDir))
  assert.deepEqual(r, { problems: [], reported: [] })
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
  assert.deepEqual(await checkSkillCopies(rnessDir, manifest), {
    problems: [
      'skills: skills/scopes is a symbolic link; only regular files and directories are allowed',
    ],
    reported: [],
  })
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

test('checkSkillDir: a control character in a description, allowed-tools or file name is refused; a multi-line description is not', async (t) => {
  const withMd = async (md: string) => {
    const dir = await skillDir(t, 'demo')
    await writeFile(join(dir, 'SKILL.md'), md)
    return dir
  }
  const md = (extra: string) => `---\nname: demo\n${extra}---\nBody\n`
  await assert.rejects(
    checkSkillDir(
      await withMd(
        md('description: "ok\\e[2Kfake"\n').replace('\\e', '\\u001b')
      ),
      'demo'
    ),
    /demo.*description holds a control character/
  )
  await assert.rejects(
    checkSkillDir(
      await withMd(md('description: x\nallowed-tools: "a\\u0007b"\n')),
      'demo'
    ),
    /allowed-tools holds a control character/
  )
  await assert.rejects(
    checkSkillDir(await withMd(md('description: "a\\u0085b"\n')), 'demo'),
    /description holds a control character/
  )
  await checkSkillDir(
    await withMd(md('description: |\n  line one\n  line\ttwo\n')),
    'demo'
  )
  const named = await skillDir(t, 'demo', { 'bad\u001b[2Kname.md': 'x' })
  await assert.rejects(
    checkSkillDir(named, 'demo'),
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
  assert.equal(allowedToolsText([]), '')
  assert.equal(allowedToolsText(3), '3')
})
