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
  skillInstallCommand,
  skillListCommand,
  skillRemoveCommand,
  skillUpdateCommand,
} from '../../src/commands/skill.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import {
  appliedSkills,
  pendingCount,
  readConsent,
} from '../../src/core/skill-consent.ts'
import {
  skillConflicts,
  skillConflictsByName,
  teamSkills,
} from '../../src/core/skills.ts'
import { findWorkspace } from '../../src/core/workspace.ts'
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

test('add: a failed write of rness.json removes the copy, reports the error, exit 1', async (t) => {
  const { url } = await fixtureRepo(t)
  const root = await ws(t, { files: { 'skills/README.md': 'x' } })
  const before = await readFile(join(root, '.rness/rness.json'), 'utf8')
  // A read-only .rness: the copy goes into the writable skills/, the
  // manifest (written through a temporary file beside it) cannot be.
  await chmod(join(root, '.rness'), 0o555)
  let r: Awaited<ReturnType<typeof say>>
  try {
    r = await say(() =>
      skillAddCommand(
        `git:${url}`,
        { cwd: root, path: 'skills/demo', ref: 'v1' },
        deps()
      )
    )
  } finally {
    await chmod(join(root, '.rness'), 0o755)
  }
  assert.equal(r.code, 1)
  assert.match(r.err, /error|EACCES|permission/i)
  assert.equal(await exists(join(root, '.rness/skills/demo')), false)
  assert.equal(await readFile(join(root, '.rness/rness.json'), 'utf8'), before)
})

test('skillConflictsByName: names each conflict, and skillConflicts keeps its lines', async (t) => {
  const hash = `sha256-${'A'.repeat(43)}=`
  const root = await ws(t, {
    skills: { demo: { source: 'github:o/r', hash } },
    files: { 'skills/scopes/api/demo/SKILL.md': SKILL_MD('demo') },
  })
  const rnessDir = join(root, '.rness')
  const manifest = await manifestOf(root)
  const all = await teamSkills(rnessDir, manifest)
  const line =
    'skill "demo" is declared at the top and written by the team at skills/scopes/api/demo'
  assert.deepEqual(skillConflictsByName(rnessDir, manifest, all), [
    { name: 'demo', line },
  ])
  assert.deepEqual(skillConflicts(rnessDir, manifest, all), [line])
})

/** A well-formed declared hash: consent reads the copy, never this. */
const HASH = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

// ---- consent: rness skill install and list (spec 0041 §5) ----

const CANCELLED = Symbol('cancelled')

/** A scripted terminal: the answers to the `select`, what was asked, and a TTY or not. */
function consentTerminal(answers: (string | symbol)[], tty = true) {
  const asked: { message: string; values: unknown[] }[] = []
  const prompts = {
    select: (opts: {
      message: string
      options: { value: unknown }[]
    }): Promise<unknown> => {
      asked.push({
        message: opts.message,
        values: opts.options.map((o) => o.value),
      })
      const next = answers.shift()
      if (next === undefined) throw new Error('no scripted answer')
      return Promise.resolve(next)
    },
    isCancel: (v: unknown) => v === CANCELLED,
  }
  return {
    asked,
    left: () => answers.length,
    terminal: {
      isTty: () => tty,
      prompts: () => Promise.resolve(prompts as never),
    },
  }
}

const TODAY = '2026-11-13'

/** A workspace whose `.rness` is a git repository (the record lives in its git directory), one clone `org/web`. */
async function consentWs(
  t: TestContext,
  spec: Parameters<typeof makeWorkspace>[1] = {}
): Promise<string> {
  const root = await makeWorkspace(t, {
    org: 'acme',
    scopes: { web: { url: 'git@github.com:acme/web.git' } },
    dirs: ['org/web'],
    ...spec,
  })
  await git(['init', '-q', '-b', 'main'], join(root, '.rness'))
  return root
}

const recordOf = async (root: string) =>
  JSON.parse(
    await readFile(join(root, '.rness/.git/rness/skills.json'), 'utf8')
  ) as {
    version: number
    skills: Record<string, { hash: string; answer: string; date: string }>
  }

const DECLARED = {
  brainstorming: {
    source: 'github:obra/superpowers',
    ref: 'v7.0.0',
    hash: HASH,
  },
}

/** `brainstorming` (declared, 2 files) and `release` (written by the team). */
const twoSkills = {
  skills: DECLARED,
  files: {
    'skills/brainstorming/SKILL.md': SKILL_MD(
      'brainstorming',
      'allowed-tools: Read, Grep\n'
    ),
    'skills/brainstorming/notes.md': 'x'.repeat(2000),
    'skills/release/SKILL.md': SKILL_MD('release'),
  },
}

const install = (
  root: string,
  names: string[],
  term: ReturnType<typeof consentTerminal>,
  extra: { yes?: boolean } = {}
) =>
  say(() =>
    skillInstallCommand(
      names,
      { cwd: root, ...extra },
      { terminal: term.terminal, now: () => Date.parse(`${TODAY}T10:00:00Z`) }
    )
  )

test('install: lists the pending skills, y records accepted with hash and date', async (t) => {
  const root = await consentWs(t, twoSkills)
  const term = consentTerminal(['install'])
  const r = await install(root, [], term)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^skills +2 team skills for acme:$/m)
  assert.match(
    r.out,
    /brainstorming +github:obra\/superpowers@v7\.0\.0 +3 KB +allowed-tools: Read, Grep$/m
  )
  assert.match(
    r.out,
    /release +written by the team \(\.rness\/skills\/release\) +1 KB +allowed-tools: none$/m
  )
  assert.match(r.out, /^accepted +brainstorming, release$/m)
  assert.deepEqual(
    term.asked[0]?.values,
    ['install', 'decline', 'details'],
    'install first, decline the default'
  )
  const rec = await recordOf(root)
  assert.equal(rec.version, 1)
  assert.deepEqual(Object.keys(rec.skills).sort(), ['brainstorming', 'release'])
  assert.equal(rec.skills['release']?.answer, 'accepted')
  assert.equal(rec.skills['release']?.date, TODAY)
  assert.match(rec.skills['release']?.hash ?? '', /^sha256-/)
  // never committed: nothing in the worktree
  assert.equal(await exists(join(root, '.rness/skills.json')), false)
})

test('install: N declines, the record says declined, a bare install does not propose it again', async (t) => {
  const root = await consentWs(t, twoSkills)
  const r = await install(root, [], consentTerminal(['decline']))
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^declined +brainstorming, release {3}\(rness skill install <name> installs one later\)$/m
  )
  assert.equal((await recordOf(root)).skills['release']?.answer, 'declined')
  const again = consentTerminal([])
  const r2 = await install(root, [], again)
  assert.equal(r2.code, 0, r2.err)
  assert.match(r2.out, /^skills +no team skill awaits your consent$/m)
  assert.equal(again.asked.length, 0)
})

test('install: a copy edited, or a team skill rewritten, is pending again; a declined one too', async (t) => {
  const root = await consentWs(t, twoSkills)
  await install(root, [], consentTerminal(['install']))
  await writeFile(join(root, '.rness/skills/release/more.md'), 'new')
  await writeFile(join(root, '.rness/skills/brainstorming/notes.md'), 'edited')
  const term = consentTerminal(['decline'])
  const r = await install(root, [], term)
  assert.match(r.out, /^skills +2 team skills for acme:$/m)
  // declined at this hash, edited again: pending once more
  await writeFile(join(root, '.rness/skills/release/more.md'), 'newer')
  const again = consentTerminal(['install'])
  const r2 = await install(root, [], again)
  assert.match(r2.out, /^skills +1 team skill for acme:$/m)
  assert.match(r2.out, /^accepted +release$/m)
})

test('install: a ref moved with the same content is not pending', async (t) => {
  const root = await consentWs(t, twoSkills)
  await install(root, [], consentTerminal(['install']))
  const file = join(root, '.rness/rness.json')
  const m = JSON.parse(await readFile(file, 'utf8'))
  m.skills.brainstorming.ref = 'v8.0.0'
  m.skills.brainstorming.commit = 'a'.repeat(40)
  await writeFile(file, JSON.stringify(m))
  const r = await install(root, [], consentTerminal([]))
  assert.match(r.out, /^skills +no team skill awaits your consent$/m)
})

test('install --yes: accepts without asking, even without a terminal', async (t) => {
  const root = await consentWs(t, twoSkills)
  const term = consentTerminal([], false)
  const r = await install(root, [], term, { yes: true })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^accepted +brainstorming, release$/m)
  assert.equal(term.asked.length, 0)
  assert.equal((await recordOf(root)).skills['brainstorming']?.date, TODAY)
})

test('install: no terminal and no --yes lists, records nothing, exits 1', async (t) => {
  const root = await consentWs(t, twoSkills)
  const r = await install(root, [], consentTerminal([], false))
  assert.equal(r.code, 1)
  assert.match(r.out, /^skills +2 team skills for acme:$/m)
  assert.match(
    r.err,
    /answer in a terminal, or run (rness|.* rness(\/cli)?.*) skill install --yes/
  )
  assert.equal(await exists(join(root, '.rness/.git/rness/skills.json')), false)
})

test('install: cancelling the question records nothing, exits 1', async (t) => {
  const root = await consentWs(t, twoSkills)
  const r = await install(root, [], consentTerminal([CANCELLED]))
  assert.equal(r.code, 1)
  assert.equal(await exists(join(root, '.rness/.git/rness/skills.json')), false)
})

test('install: details prints the description and the files, then asks again', async (t) => {
  const root = await consentWs(t, twoSkills)
  const term = consentTerminal(['details', 'install'])
  const r = await install(root, [], term)
  assert.equal(r.code, 0, r.err)
  assert.equal(term.asked.length, 2)
  assert.match(r.out, /A skill/)
  assert.match(r.out, /notes\.md/)
  assert.match(r.out, /SKILL\.md/)
  assert.match(r.out, /^accepted +brainstorming, release$/m)
})

test('install: names pick some, an unknown name is refused naming the known ones', async (t) => {
  const root = await consentWs(t, twoSkills)
  const r = await install(root, ['release'], consentTerminal(['install']))
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^skills +1 team skill for acme:$/m)
  assert.deepEqual(Object.keys((await recordOf(root)).skills), ['release'])
  const bad = await install(root, ['nope'], consentTerminal([]))
  assert.equal(bad.code, 1)
  assert.match(bad.err, /unknown skill "nope"; known skills: .*brainstorming/)
})

test('install: a named skill declined before is asked again; an installed one is already installed', async (t) => {
  const root = await consentWs(t, twoSkills)
  await install(root, [], consentTerminal(['decline']))
  const r = await install(root, ['release'], consentTerminal(['install']))
  assert.match(r.out, /^accepted +release$/m)
  const done = consentTerminal([])
  const r2 = await install(root, ['release'], done)
  assert.equal(r2.code, 0, r2.err)
  assert.match(r2.out, /^skills +release: already installed$/m)
  assert.equal(done.asked.length, 0)
})

test('install: nothing declared says so', async (t) => {
  const root = await consentWs(t)
  const r = await install(root, [], consentTerminal([]))
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^skills +no team skill awaits your consent$/m)
})

test('install: a skill of a repository whose clone is absent does not apply', async (t) => {
  const root = await consentWs(t, {
    scopes: {
      web: { url: 'git@github.com:acme/web.git' },
      api: {
        url: 'git@github.com:acme/api.git',
        skills: { deploy: { source: 'path:/x', hash: HASH } },
      },
    },
    files: { 'skills/scopes/api/deploy/SKILL.md': SKILL_MD('deploy') },
  })
  const r = await install(root, [], consentTerminal([]))
  assert.match(r.out, /^skills +no team skill awaits your consent$/m)
})

test('install: two sibling repositories each with their own deploy keep two record ids', async (t) => {
  const root = await consentWs(t, {
    scopes: {
      web: {
        url: 'git@github.com:acme/web.git',
        skills: { deploy: { source: 'path:/w', hash: HASH } },
      },
      api: {
        url: 'git@github.com:acme/api.git',
        skills: { deploy: { source: 'path:/a', hash: HASH } },
      },
    },
    dirs: ['org/web', 'org/api'],
    files: {
      'skills/scopes/web/deploy/SKILL.md': SKILL_MD('deploy', 'x: web\n'),
      'skills/scopes/api/deploy/SKILL.md': SKILL_MD('deploy', 'x: api\n'),
    },
  })
  const r = await install(root, ['deploy'], consentTerminal(['install']))
  assert.equal(r.code, 0, r.err)
  const rec = await recordOf(root)
  assert.deepEqual(Object.keys(rec.skills).sort(), ['api/deploy', 'web/deploy'])
  assert.notEqual(
    rec.skills['api/deploy']?.hash,
    rec.skills['web/deploy']?.hash
  )
})

test('install: .rness that is no git repository is refused naming it', async (t) => {
  const root = await makeWorkspace(t, { ...twoSkills })
  const r = await install(root, [], consentTerminal(['install']))
  assert.equal(r.code, 1)
  assert.match(r.err, /\.rness/)
})

test('install: an unreadable record reads as empty and is said once', async (t) => {
  const root = await consentWs(t, twoSkills)
  await mkdir(join(root, '.rness/.git/rness'), { recursive: true })
  await writeFile(join(root, '.rness/.git/rness/skills.json'), '{not json')
  const r = await install(root, [], consentTerminal(['install']))
  assert.equal(r.code, 0, r.err)
  assert.equal(r.err.match(/unreadable/g)?.length, 1)
  assert.equal((await recordOf(root)).skills['release']?.answer, 'accepted')
})

test('list: one line per skill with where it applies and its state', async (t) => {
  const root = await consentWs(t, {
    scopes: {
      web: {
        url: 'git@github.com:acme/web.git',
        skills: { deploy: { source: 'path:/w', hash: HASH } },
      },
    },
    skills: DECLARED,
    files: {
      'skills/brainstorming/SKILL.md': SKILL_MD('brainstorming'),
      'skills/release/SKILL.md': SKILL_MD('release'),
      'skills/lint/SKILL.md': SKILL_MD('lint'),
      'skills/scopes/web/deploy/SKILL.md': SKILL_MD('deploy'),
    },
  })
  await install(root, ['brainstorming'], consentTerminal(['install']))
  await install(root, ['release'], consentTerminal(['decline']))
  await install(root, ['lint'], consentTerminal(['install']))
  await writeFile(join(root, '.rness/skills/lint/extra.md'), 'changed')
  const c = consentTerminal([])
  const r = await say(() =>
    skillListCommand({ cwd: root }, { terminal: c.terminal })
  )
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^brainstorming +all +github:obra\/superpowers@v7\.0\.0 +installed$/m
  )
  assert.match(r.out, /^release +all +written by the team +declined$/m)
  assert.match(
    r.out,
    /^lint +all +written by the team +changed since accepted$/m
  )
  assert.match(r.out, /^deploy +web +path:\/w +pending$/m)
})

test('list: no skills says so, exit 0', async (t) => {
  const root = await consentWs(t)
  const r = await say(() =>
    skillListCommand({ cwd: root }, { terminal: consentTerminal([]).terminal })
  )
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^skills +no team skill in rness\.json or \.rness\/skills$/m
  )
})

test('install and list are in the skill group of the command line', async (t) => {
  const root = await consentWs(t)
  const c = capture()
  let code: number
  try {
    code = await run(['skill', 'list', '--cwd', root])
  } finally {
    c.restore()
  }
  assert.equal(code, 0)
  assert.match(c.out(), /no team skill/)
})

/** Three declared skills: `good`, `gone` (copy deleted) and `broken` (SKILL.md without a description). */
const threeSkills = {
  skills: {
    good: { source: 'path:/g', hash: HASH },
    gone: { source: 'path:/x', hash: HASH },
    broken: { source: 'path:/b', hash: HASH },
  },
  files: {
    'skills/good/SKILL.md': SKILL_MD('good'),
    'skills/broken/SKILL.md': '---\nname: broken\n---\nBody\n',
  },
}

test('invalid copies: list shows all three, install --yes accepts the valid one and skips the others, pendingCount counts one', async (t) => {
  const root = await consentWs(t, threeSkills)
  const c = consentTerminal([], false)
  const l = await say(() =>
    skillListCommand({ cwd: root }, { terminal: c.terminal })
  )
  assert.equal(l.code, 0, l.err)
  assert.match(l.out, /^good +all +path:\/g +pending$/m)
  assert.match(
    l.out,
    /^gone +all +path:\/x +invalid: skill "gone": its copy is missing$/m
  )
  assert.match(
    l.out,
    /^broken +all +path:\/b +invalid: skill "broken": SKILL\.md has no description$/m
  )
  const wsp = await findWorkspace(root)
  const manifest = await manifestOf(root)
  const applied = await appliedSkills(
    wsp,
    manifest,
    await readConsent(wsp.rnessDir)
  )
  assert.equal(pendingCount(applied), 1)
  assert.equal(applied.find((a) => a.skill.name === 'gone')?.hash, null)
  const r = await install(root, [], consentTerminal([], false), { yes: true })
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^skipped +gone: skill "gone": its copy is missing; run rness validate$/m
  )
  assert.match(
    r.out,
    /^skipped +broken: .*no description; run rness validate$/m
  )
  assert.match(r.out, /^accepted +good$/m)
  assert.deepEqual(Object.keys((await recordOf(root)).skills), ['good'])
})

test('invalid copies: a named invalid skill alone exits 1, recording nothing', async (t) => {
  const root = await consentWs(t, threeSkills)
  const r = await install(root, ['gone'], consentTerminal([], false), {
    yes: true,
  })
  assert.equal(r.code, 1)
  assert.match(r.out, /^skipped +gone:/m)
  assert.equal(await exists(join(root, '.rness/.git/rness/skills.json')), false)
})

test('install shows allowed-tools as JSON when it is not a string or a list, none when absent', async (t) => {
  const root = await consentWs(t, {
    skills: {
      a: { source: 'path:/a', hash: HASH },
      b: { source: 'path:/b', hash: HASH },
    },
    files: {
      'skills/a/SKILL.md': SKILL_MD('a', 'allowed-tools:\n  Bash: 1\n'),
      'skills/b/SKILL.md': SKILL_MD('b'),
    },
  })
  const r = await install(root, [], consentTerminal([], false), { yes: true })
  assert.match(r.out, /^ *a +path:\/a +1 KB +allowed-tools: \{"Bash":1\}$/m)
  assert.match(r.out, /^ *b +path:\/b +1 KB +allowed-tools: none$/m)
})

test('install: values from a copy made before the check are sanitized on display', async (t) => {
  const root = await consentWs(t, {
    skills: { a: { source: 'path:/a', hash: HASH } },
    files: {
      'skills/a/SKILL.md': SKILL_MD('a'),
    },
  })
  // A copy that predates the check: a description with an escape sequence.
  await writeFile(
    join(root, '.rness/skills/a/SKILL.md'),
    '---\nname: a\ndescription: "x"\n---\nBody\n'
  )
  await writeFile(join(root, '.rness/skills/a/bad\u001b[2Kname.md'), 'x')
  const r = await install(root, [], consentTerminal(['details', 'decline']))
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out.includes('\u001b'), false)
})

// ---- install: the answers made true in the clones (spec 0041 §6) ----

test('install: a skill accepted is installed in the clones and at the root; its new version declined, it is removed', async (t) => {
  const root = await consentWs(t, { ...twoSkills, agents: ['claude'] })
  await git(['init', '-q', '-b', 'main'], join(root, 'org/web'))
  const r = await install(root, [], consentTerminal(['install']))
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^installed brainstorming, release {3}\(org\/web, workspace root\)$/m
  )
  for (const p of [
    'org/web/.claude/skills/release/SKILL.md',
    'org/web/.agents/skills/brainstorming/notes.md',
    '.claude/skills/brainstorming/SKILL.md',
  ])
    assert.equal(await exists(join(root, p)), true, p)

  await writeFile(
    join(root, '.rness/skills/release/SKILL.md'),
    SKILL_MD('release', 'v: 2\n')
  )
  const d = await install(root, [], consentTerminal(['decline']))
  assert.equal(d.code, 0, d.err)
  assert.match(d.out, /^removed +release {3}\(org\/web, workspace root\)$/m)
  assert.equal(
    await exists(join(root, 'org/web/.claude/skills/release')),
    false
  )
  assert.equal(await exists(join(root, '.claude/skills/release')), false)
  assert.equal(
    await exists(join(root, 'org/web/.claude/skills/brainstorming')),
    true
  )
})

test('install: after an unreadable record, only the skills just answered are written and nothing is removed', async (t) => {
  const root = await consentWs(t, { ...twoSkills, agents: ['claude'] })
  await git(['init', '-q', '-b', 'main'], join(root, 'org/web'))
  const a = await install(root, ['release'], consentTerminal([], false), {
    yes: true,
  })
  assert.equal(a.code, 0, a.err)
  const recordFile = join(root, 'org/web/.git/rness/skills.json')
  const before = await readFile(recordFile, 'utf8')
  await writeFile(join(root, '.rness/.git/rness/skills.json'), '{not json')
  const b = await install(root, ['brainstorming'], consentTerminal([], false), {
    yes: true,
  })
  assert.equal(b.code, 0, b.err)
  assert.match(b.err, /unreadable/)
  assert.match(
    b.out,
    /^installed brainstorming {3}\(org\/web, workspace root\)$/m
  )
  assert.doesNotMatch(b.out, /^removed/m)
  for (const p of [
    'org/web/.claude/skills/release/SKILL.md',
    'org/web/.agents/skills/release/SKILL.md',
    '.claude/skills/release/SKILL.md',
    'org/web/.agents/skills/brainstorming/SKILL.md',
  ])
    assert.equal(await exists(join(root, p)), true, p)
  const after = JSON.parse(await readFile(recordFile, 'utf8')) as {
    skills: Record<string, unknown>
  }
  assert.deepEqual(
    after.skills['release'],
    (JSON.parse(before) as { skills: Record<string, unknown> }).skills[
      'release'
    ]
  )
})

test('add: a git source holding a control character prints no raw control character', async (t) => {
  const root = await ws(t)
  const r = await say(() =>
    skillAddCommand(
      'git:/nonexistent\u001b[2K\u0085repo',
      { cwd: root },
      deps()
    )
  )
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.out + r.err, RAW_CONTROL)
})

// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/

test('add and update: a control character in the source, --path or --ref is refused before any fetch', async (t) => {
  const root = await ws(t)
  for (const [source, extra] of [
    ['git:file:///x\u001by', {}],
    ['github:o/r', { path: 'a\u009bb' }],
    ['github:o/r', { ref: 'v1\u001b[2K' }],
  ] as const) {
    const r = await say(() =>
      skillAddCommand(source, { cwd: root, ...extra }, deps())
    )
    assert.equal(r.code, 1)
    assert.match(r.err, /holds a control character/)
    assert.match(r.err, /\\u001b|\\u009b/)
    assert.doesNotMatch(r.out + r.err, RAW_CONTROL)
  }
  const r = await say(() =>
    skillUpdateCommand(['demo'], { cwd: root, ref: 'v\u009b' }, deps())
  )
  assert.equal(r.code, 1)
  assert.match(r.err, /--ref "v\\u009b" holds a control character/)
  assert.equal((await manifestOf(root)).skills, undefined)
})
