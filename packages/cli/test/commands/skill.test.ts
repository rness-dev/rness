import assert from 'node:assert/strict'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { run } from '../../src/cli.ts'
import {
  skillAddCommand,
  skillRemoveCommand,
  skillUpdateCommand,
} from '../../src/commands/skill.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { capture } from '../helpers/capture.ts'
import { git } from '../helpers/git.ts'
import { fakeProvider } from '../helpers/provider.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const SKILL_MD = (name: string, extra = ''): string =>
  `---\nname: ${name}\ndescription: A skill\n${extra}---\nBody\n`

async function put(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, ...rel.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
}

async function tmp(t: TestContext): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'rness-skill-t-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/**
 * A repository: `skills/demo` and a root skill `rootskill`, tagged v1; then
 * v2 changes demo (one file changed, one added, one removed).
 */
async function fixtureRepo(t: TestContext) {
  const work = await tmp(t)
  await put(work, {
    'SKILL.md': SKILL_MD('rootskill'),
    'skills/demo/SKILL.md': SKILL_MD('demo'),
    'skills/demo/gone.md': 'gone',
    'skills/demo/same.md': 'same',
    'skills/demo/edit.md': 'v1',
  })
  await git(['init', '-q', '-b', 'main'], work)
  await git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], work)
  await git(['add', '-A'], work)
  await git(['commit', '-q', '-m', 'one'], work)
  const v1 = (await git(['rev-parse', 'HEAD'], work)).trim()
  await git(['tag', 'v1'], work)
  await rm(join(work, 'skills/demo/gone.md'))
  await put(work, {
    'skills/demo/edit.md': 'v2',
    'skills/demo/added.md': 'new',
  })
  await git(['add', '-A'], work)
  await git(['commit', '-q', '-m', 'two'], work)
  await git(['tag', 'v2'], work)
  return { work, url: pathToFileURL(work).href, v1 }
}

const deps = () => ({ provider: fakeProvider({}).provider })

/** What a command printed, and its code. */
async function say(
  work: () => Promise<number>
): Promise<{ code: number; out: string; err: string }> {
  const c = capture()
  try {
    const code = await work()
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

const ws = (t: TestContext, spec: Parameters<typeof makeWorkspace>[1] = {}) =>
  makeWorkspace(t, {
    scopes: {
      web: {
        url: 'git@github.com:acme/web.git',
        scopes: { ui: { path: 'packages/ui' } },
      },
      api: { url: 'git@github.com:acme/api.git' },
    },
    ...spec,
  })

const manifestOf = (root: string) => loadManifest(join(root, '.rness'))
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false
  )

test('add: a git source at a tag with --path, the three lines, the entry, nothing committed', async (t) => {
  const { url } = await fixtureRepo(t)
  const root = await ws(t)
  const r = await say(() =>
    skillAddCommand(
      `git:${url}`,
      { cwd: root, path: 'skills/demo', ref: 'v1' },
      deps()
    )
  )
  assert.equal(r.code, 0, r.err)
  const lines = r.out.trimEnd().split('\n')
  assert.match(
    lines[0] ?? '',
    new RegExp(
      `^added +skill demo \\(git:${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@v1, 4 files, 1 KB\\)$`
    )
  )
  assert.match(
    lines[1] ?? '',
    /^wrote +\.rness\/skills\/demo\/ {3}review it in the pull request$/
  )
  assert.match(
    lines[2] ?? '',
    /^declared +\.rness\/rness\.json {2}skills\.demo$/
  )
  assert.equal(
    await readFile(join(root, '.rness/skills/demo/edit.md'), 'utf8'),
    'v1'
  )
  const entry = (await manifestOf(root)).skills?.['demo']
  assert.equal(entry?.source, `git:${url}`)
  assert.equal(entry?.path, 'skills/demo')
  assert.equal(entry?.ref, 'v1')
  assert.match(entry?.commit ?? '', /^[0-9a-f]{40}$/)
  assert.match(entry?.hash ?? '', /^sha256-/)
  assert.equal(await exists(join(root, '.rness/.git')), false)
})

test('add: a repository-root skill without --ref names the commit, in KB rounded up', async (t) => {
  const { url } = await fixtureRepo(t)
  const root = await ws(t)
  const r = await say(() =>
    skillAddCommand(`git:${url}`, { cwd: root }, deps())
  )
  assert.equal(r.code, 0, r.err)
  const commit = (await manifestOf(root)).skills?.['rootskill']?.commit ?? ''
  assert.match(
    r.out,
    new RegExp(`skill rootskill \\(git:.*@${commit.slice(0, 7)}, `)
  )
  assert.match(r.out, /\.rness\/skills\/rootskill\//)
})

test('add: a path: source, no version in the line, no commit or ref in the entry', async (t) => {
  const src = await tmp(t)
  await put(src, { 'mine/SKILL.md': SKILL_MD('mine') })
  const root = await ws(t)
  const r = await say(() =>
    skillAddCommand(`path:${join(src, 'mine')}`, { cwd: root }, deps())
  )
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /skill mine \(path:.*mine, 1 file, 1 KB\)/)
  const entry = (await manifestOf(root)).skills?.['mine']
  assert.equal(entry?.commit, undefined)
  assert.equal(entry?.ref, undefined)
})

test('add: --name renames the copy and the declaration', async (t) => {
  const { url } = await fixtureRepo(t)
  const root = await ws(t)
  const r = await say(() =>
    skillAddCommand(
      `git:${url}`,
      { cwd: root, path: 'skills/demo', name: 'other' },
      deps()
    )
  )
  assert.equal(r.code, 0, r.err)
  assert.match(
    await readFile(join(root, '.rness/skills/other/SKILL.md'), 'utf8'),
    /^---\nname: other\n/
  )
  assert.ok((await manifestOf(root)).skills?.['other'])
  assert.equal(await exists(join(root, '.rness/skills/demo')), false)
})

test('add: --scope for a repository and for a part, with the key paths', async (t) => {
  const { url } = await fixtureRepo(t)
  const root = await ws(t)
  const web = await say(() =>
    skillAddCommand(
      `git:${url}`,
      { cwd: root, path: 'skills/demo', scope: 'web' },
      deps()
    )
  )
  assert.equal(web.code, 0, web.err)
  assert.match(web.out, /wrote +\.rness\/skills\/scopes\/web\/demo\//)
  assert.match(
    web.out,
    /declared +\.rness\/rness\.json {2}scopes\.web\.skills\.demo\n/
  )
  const part = await say(() =>
    skillAddCommand(`git:${url}`, { cwd: root, scope: 'ui', ref: 'v1' }, deps())
  )
  assert.equal(part.code, 0, part.err)
  assert.match(
    part.out,
    /declared +\.rness\/rness\.json {2}scopes\.web\.scopes\.ui\.skills\.rootskill\n/
  )
  const m = await manifestOf(root)
  assert.ok(m.scopes['web']?.skills?.['demo'])
  assert.ok(m.scopes['ui']?.skills?.['rootskill'])
  assert.ok(
    await exists(join(root, '.rness/skills/scopes/ui/rootskill/SKILL.md'))
  )
})

test('add: a github: source asks credentials for its https URL (fetch redirected to the fixture)', async (t) => {
  const { work } = await fixtureRepo(t)
  const root = await ws(t)
  const fake = fakeProvider({})
  process.env['GIT_CONFIG_COUNT'] = '1'
  process.env['GIT_CONFIG_KEY_0'] = `url.${pathToFileURL(work).href}.insteadOf`
  process.env['GIT_CONFIG_VALUE_0'] = 'https://github.com/obra/superpowers.git'
  t.after(() => {
    delete process.env['GIT_CONFIG_COUNT']
    delete process.env['GIT_CONFIG_KEY_0']
    delete process.env['GIT_CONFIG_VALUE_0']
  })
  const r = await say(() =>
    skillAddCommand(
      'github:obra/superpowers',
      { cwd: root, path: 'skills/demo', ref: 'v2' },
      { provider: fake.provider }
    )
  )
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(fake.asked, ['https://github.com/obra/superpowers.git'])
  assert.match(r.out, /skill demo \(github:obra\/superpowers@v2, /)
})

test('add: a path: source asks no credentials', async (t) => {
  const src = await tmp(t)
  await put(src, { 'mine/SKILL.md': SKILL_MD('mine') })
  const root = await ws(t)
  const fake = fakeProvider({})
  await say(() =>
    skillAddCommand(
      `path:${join(src, 'mine')}`,
      { cwd: root },
      {
        provider: fake.provider,
      }
    )
  )
  assert.deepEqual(fake.asked, [])
})

test('add refuses: an unknown scope, naming the known ones', async (t) => {
  const root = await ws(t)
  const r = await say(() =>
    skillAddCommand('path:/nowhere', { cwd: root, scope: 'nope' }, deps())
  )
  assert.equal(r.code, 1)
  assert.match(r.err, /unknown scope "nope"; known scopes: web, ui, api/)
})

test('add refuses: a path: source with --path or --ref', async (t) => {
  const root = await ws(t)
  for (const extra of [{ path: 'x' }, { ref: 'v1' }]) {
    const r = await say(() =>
      skillAddCommand('path:/nowhere', { cwd: root, ...extra }, deps())
    )
    assert.equal(r.code, 1)
    assert.match(
      r.err,
      /a path: source is the skill's directory itself; --path and --ref apply to a repository source/
    )
  }
})

test('add refuses: a name already declared at that level, a directory the team wrote, a clash in one clone; writes nothing', async (t) => {
  const { url } = await fixtureRepo(t)
  const hash = `sha256-${'A'.repeat(43)}=`
  const root = await ws(t, {
    skills: { demo: { source: 'github:o/r', hash } },
    scopes: {
      web: {
        url: 'git@github.com:acme/web.git',
        skills: { rootskill: { source: 'github:o/r', hash } },
        scopes: { ui: { path: 'packages/ui' } },
      },
      api: { url: 'git@github.com:acme/api.git' },
    },
    files: { 'skills/scopes/api/demo/SKILL.md': SKILL_MD('demo') },
  })
  const before = await readFile(join(root, '.rness/rness.json'), 'utf8')
  const declared = await say(() =>
    skillAddCommand(`git:${url}`, { cwd: root, path: 'skills/demo' }, deps())
  )
  assert.equal(declared.code, 1)
  assert.match(
    declared.err,
    /skill "demo" is already declared at skills\.demo: run rness skill update demo/
  )
  const team = await say(() =>
    skillAddCommand(
      `git:${url}`,
      { cwd: root, path: 'skills/demo', scope: 'api' },
      deps()
    )
  )
  assert.equal(team.code, 1)
  assert.match(
    team.err,
    /\.rness\/skills\/scopes\/api\/demo\/ already exists, a skill written by the team/
  )
  // `rootskill` at the part `ui` while `web` declares it: one clone, twice.
  const clash = await say(() =>
    skillAddCommand(`git:${url}`, { cwd: root, scope: 'ui' }, deps())
  )
  assert.equal(clash.code, 1)
  assert.match(
    clash.err,
    /skill "rootskill" is declared in scope "web" and in scope "ui"/
  )
  assert.equal(await readFile(join(root, '.rness/rness.json'), 'utf8'), before)
  assert.equal(await exists(join(root, '.rness/skills/rootskill')), false)
  assert.equal(await exists(join(root, '.rness/skills/scopes/ui')), false)
})

/** A workspace with `demo` added from the fixture at v1 (top) and the fixture. */
async function withDemo(t: TestContext, spec: Parameters<typeof ws>[1] = {}) {
  const fx = await fixtureRepo(t)
  const root = await ws(t, spec)
  const r = await say(() =>
    skillAddCommand(
      `git:${fx.url}`,
      { cwd: root, path: 'skills/demo', ref: 'v1' },
      deps()
    )
  )
  assert.equal(r.code, 0, r.err)
  return { ...fx, root }
}

test('update --ref: counts, and ref, commit and hash rewritten', async (t) => {
  const { root, url } = await withDemo(t)
  const old = (await manifestOf(root)).skills?.['demo']
  const r = await say(() =>
    skillUpdateCommand(['demo'], { cwd: root, ref: 'v2' }, deps())
  )
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    new RegExp(
      `^updated +skill demo \\(git:${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@v2: 1 added, 1 changed, 1 removed\\)\n$`
    )
  )
  const entry = (await manifestOf(root)).skills?.['demo']
  assert.equal(entry?.ref, 'v2')
  assert.notEqual(entry?.commit, old?.commit)
  assert.notEqual(entry?.hash, old?.hash)
  assert.equal(await exists(join(root, '.rness/skills/demo/gone.md')), false)
  assert.equal(
    await readFile(join(root, '.rness/skills/demo/edit.md'), 'utf8'),
    'v2'
  )
})

test('update: nothing new is unchanged; no names updates every declared skill', async (t) => {
  const { root } = await withDemo(t)
  const r = await say(() => skillUpdateCommand([], { cwd: root }, deps()))
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^unchanged +skill demo \(git:.*@v1\)\n$/)
})

test('update: a renamed skill keeps its name', async (t) => {
  const fx = await fixtureRepo(t)
  const root = await ws(t)
  await say(() =>
    skillAddCommand(
      `git:${fx.url}`,
      { cwd: root, path: 'skills/demo', ref: 'v1', name: 'other' },
      deps()
    )
  )
  const r = await say(() =>
    skillUpdateCommand(['other'], { cwd: root, ref: 'v2' }, deps())
  )
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /updated +skill other \(/)
  assert.match(
    await readFile(join(root, '.rness/skills/other/SKILL.md'), 'utf8'),
    /^---\nname: other\n/
  )
  assert.equal(await exists(join(root, '.rness/skills/demo')), false)
})

test('update: a path: source absent here says so and exits 1, the others are updated', async (t) => {
  const { root } = await withDemo(t)
  const gone = await tmp(t)
  await put(gone, { 'ghost/SKILL.md': SKILL_MD('ghost') })
  await say(() =>
    skillAddCommand(`path:${join(gone, 'ghost')}`, { cwd: root }, deps())
  )
  await rm(join(gone, 'ghost'), { recursive: true })
  const r = await say(() => skillUpdateCommand([], { cwd: root }, deps()))
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /skill "ghost": path:.*ghost is not on this machine; only the machine that has it can update it \(declared at \.rness\/rness\.json skills\.ghost\)/
  )
  assert.match(r.out, /unchanged +skill demo/)
})

test('update refuses: --ref with two names or none, a team-written skill, an unknown scope', async (t) => {
  const { root } = await withDemo(t, {
    files: { 'skills/release/SKILL.md': SKILL_MD('release') },
  })
  const two = await say(() =>
    skillUpdateCommand(['demo', 'x'], { cwd: root, ref: 'v2' }, deps())
  )
  assert.equal(two.code, 1)
  assert.match(two.err, /--ref needs exactly one skill name/)
  const team = await say(() =>
    skillUpdateCommand(['release'], { cwd: root }, deps())
  )
  assert.equal(team.code, 1)
  assert.match(
    team.err,
    /skill "release": written by the team: nothing to update/
  )
  const scope = await say(() =>
    skillUpdateCommand([], { cwd: root, scope: 'nope' }, deps())
  )
  assert.match(scope.err, /unknown scope "nope"/)
})

test('update: a name declared twice needs --scope, listing the places', async (t) => {
  const { url } = await fixtureRepo(t)
  const root = await ws(t)
  for (const scope of ['web', 'api'])
    await say(() =>
      skillAddCommand(
        `git:${url}`,
        { cwd: root, path: 'skills/demo', ref: 'v1', scope },
        deps()
      )
    )
  const r = await say(() => skillUpdateCommand(['demo'], { cwd: root }, deps()))
  assert.equal(r.code, 1)
  assert.match(
    r.err,
    /declared in more than one place \(scopes\.web\.skills\.demo, scopes\.api\.skills\.demo\): pass --scope/
  )
  const ok = await say(() =>
    skillUpdateCommand(['demo'], { cwd: root, scope: 'api', ref: 'v2' }, deps())
  )
  assert.equal(ok.code, 0, ok.err)
  assert.equal(
    (await manifestOf(root)).scopes['api']?.skills?.['demo']?.ref,
    'v2'
  )
  assert.equal(
    (await manifestOf(root)).scopes['web']?.skills?.['demo']?.ref,
    'v1'
  )
})

test('remove: the entry and the copy go, with the three lines', async (t) => {
  const { root } = await withDemo(t)
  const r = await say(() => skillRemoveCommand('demo', { cwd: root }, deps()))
  assert.equal(r.code, 0, r.err)
  const lines = r.out.trimEnd().split('\n')
  assert.match(lines[0] ?? '', /^removed +skill demo$/)
  assert.match(lines[1] ?? '', /^deleted +\.rness\/skills\/demo\/$/)
  assert.match(
    lines[2] ?? '',
    /^undeclared +\.rness\/rness\.json {2}skills\.demo$/
  )
  assert.equal((await manifestOf(root)).skills, undefined)
  assert.equal(await exists(join(root, '.rness/skills/demo')), false)
})

test('remove: in a scope; a team-written skill is refused', async (t) => {
  const { root, url } = await withDemo(t, {
    files: { 'skills/release/SKILL.md': SKILL_MD('release') },
  })
  await say(() =>
    skillAddCommand(
      `git:${url}`,
      { cwd: root, path: 'skills/demo', scope: 'api', name: 'second' },
      deps()
    )
  )
  const r = await say(() =>
    skillRemoveCommand('second', { cwd: root, scope: 'api' }, deps())
  )
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /undeclared +\.rness\/rness\.json {2}scopes\.api\.skills\.second/
  )
  assert.equal((await manifestOf(root)).scopes['api']?.skills, undefined)
  const team = await say(() =>
    skillRemoveCommand('release', { cwd: root }, deps())
  )
  assert.equal(team.code, 1)
  assert.match(team.err, /written by the team.*delete it in a pull request/)
  assert.ok(await exists(join(root, '.rness/skills/release/SKILL.md')))
})

test('the skill commands are registered and take the hidden --cwd', async (t) => {
  const src = await tmp(t)
  await put(src, { 'mine/SKILL.md': SKILL_MD('mine') })
  await chmod(join(src, 'mine'), 0o755)
  const root = await ws(t)
  const added = await say(() =>
    run(['skill', 'add', `path:${join(src, 'mine')}`, '--cwd', root])
  )
  assert.equal(added.code, 0, added.err)
  const removed = await say(() =>
    run(['skill', 'remove', 'mine', '--cwd', root])
  )
  assert.equal(removed.code, 0, removed.err)
})
