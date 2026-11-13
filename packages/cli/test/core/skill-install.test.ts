import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { type TestContext, test } from 'node:test'

import { loadManifest } from '../../src/core/manifest.ts'
import {
  type Consent,
  appliedSkills,
  readConsent,
  writeConsent,
} from '../../src/core/skill-consent.ts'
import {
  EXCLUDE_END,
  EXCLUDE_HEADER,
  type Projection,
  projectClone,
  projectRoot,
  readInstalled,
} from '../../src/core/skill-install.ts'
import { findWorkspace } from '../../src/core/workspace.ts'
import { commitRness, git } from '../helpers/git.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const TREE = 'f'.repeat(40)
const SKILL_MD = (name: string, extra = ''): string =>
  `---\nname: ${name}\ndescription: A skill\n${extra}---\nBody\n`

/**
 * acme: `brainstorming` (declared at the top, with an executable script),
 * `release` (written by the team at the top), `deploy` (declared for web);
 * clones org/web and org/api, every one a git repository, `.rness` too,
 * committed: a skill installs from the commit at its HEAD.
 */
async function skillsWs(
  t: TestContext,
  extra: Parameters<typeof makeWorkspace>[1] = {}
): Promise<string> {
  const root = await makeWorkspace(t, {
    org: 'acme',
    agents: ['claude'],
    skills: {
      brainstorming: { source: 'github:obra/superpowers', tree: TREE },
    },
    scopes: {
      web: {
        url: 'git@github.com:acme/web.git',
        skills: { deploy: { source: 'path:/d', tree: TREE } },
      },
      api: { url: 'git@github.com:acme/api.git' },
    },
    files: {
      'skills/brainstorming/SKILL.md': SKILL_MD('brainstorming'),
      'skills/brainstorming/scripts/run.sh': '#!/bin/sh\necho hi\n',
      'skills/release/SKILL.md': SKILL_MD('release'),
      'skills/scopes/web/deploy/SKILL.md': SKILL_MD('deploy'),
    },
    dirs: ['org/web', 'org/api'],
    ...extra,
  })
  await chmod(join(root, '.rness/skills/brainstorming/scripts/run.sh'), 0o755)
  for (const dir of ['.rness', 'org/web', 'org/api'])
    await git(['init', '-q', '-b', 'main'], join(root, dir))
  await commitRness(root)
  return root
}

/** Record `answer` for the applied skills whose committed copy is valid (all, or the ids given). */
async function answer(
  root: string,
  ids: string[] | null = null,
  given: 'accepted' | 'declined' = 'accepted'
): Promise<void> {
  const ws = await findWorkspace(root)
  const manifest = await loadManifest(ws.rnessDir)
  const consent: Consent = await readConsent(ws.rnessDir)
  for (const a of await appliedSkills(ws, manifest, consent))
    if (a.head !== null && (ids === null || ids.includes(a.id)))
      consent.skills[a.id] = { answer: given, date: '2026-11-13' }
  await writeConsent(ws.rnessDir, consent)
}

/** The projection into org/web, org/api (when present) and the root, as sync runs it. */
async function project(root: string): Promise<Record<string, Projection>> {
  const ws = await findWorkspace(root)
  const manifest = await loadManifest(ws.rnessDir)
  const applied = await appliedSkills(
    ws,
    manifest,
    await readConsent(ws.rnessDir)
  )
  const out: Record<string, Projection> = {}
  for (const repo of ['web', 'api'])
    if (await isThere(join(root, 'org', repo, '.git')))
      out[`org/${repo}`] = await projectClone(ws, manifest, applied, repo)
  out['root'] = await projectRoot(ws, manifest, applied)
  return out
}

const isThere = (p: string): Promise<boolean> =>
  lstat(p).then(
    () => true,
    () => false
  )

const recordOf = async (file: string) =>
  JSON.parse(await readFile(file, 'utf8')) as {
    version: number
    skills: Record<string, { tree: string; paths: string[] }>
  }

/** Every file under `dir` but a `.DS_Store`, with its executable bit and bytes: what a copy is compared on. */
async function filesOf(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const visit = async (abs: string, rel: string): Promise<void> => {
    for (const d of await readdir(abs, { withFileTypes: true })) {
      if (d.name === '.DS_Store') continue
      const path = rel === '' ? d.name : `${rel}/${d.name}`
      const child = join(abs, d.name)
      if (d.isDirectory()) await visit(child, path)
      else
        files.set(
          path,
          `${((await lstat(child)).mode & 0o100) !== 0 ? 'x' : '-'}:${await readFile(child, 'utf8')}`
        )
    }
  }
  await visit(dir, '')
  return files
}

/** The id of the tree `HEAD` of `.rness` holds at `path`. */
const committed = async (root: string, path: string): Promise<string> =>
  (await git(['rev-parse', `HEAD:${path}`], join(root, '.rness'))).trim()

const excludeOf = (root: string, repo: string): Promise<string> =>
  readFile(join(root, 'org', repo, '.git/info/exclude'), 'utf8')

const status = (root: string, repo: string): Promise<string> =>
  git(
    ['status', '--porcelain', '--untracked-files=all'],
    join(root, 'org', repo)
  )

test('installs the accepted skills in both directories of every clone they apply to, and the top-level ones at the root', async (t) => {
  const root = await skillsWs(t)
  await answer(root)
  const r = await project(root)
  assert.deepEqual(r['org/web']?.installed, [
    'brainstorming',
    'deploy',
    'release',
  ])
  assert.deepEqual(r['org/api']?.installed, ['brainstorming', 'release'])
  assert.deepEqual(r['root']?.installed, ['brainstorming', 'release'])
  for (const [repo, names] of [
    ['web', ['brainstorming', 'deploy', 'release']],
    ['api', ['brainstorming', 'release']],
  ] as const)
    for (const name of names)
      for (const dir of ['.claude/skills', '.agents/skills']) {
        const at = join(root, 'org', repo, dir, name)
        const from =
          name === 'deploy'
            ? join(root, '.rness/skills/scopes/web', name)
            : join(root, '.rness/skills', name)
        assert.deepEqual(await filesOf(at), await filesOf(from), at)
      }
  // A skill of web is not api's.
  assert.equal(
    await isThere(join(root, 'org/api/.agents/skills/deploy')),
    false
  )
  // Byte for byte, the executable bit kept, no marker inside.
  const script = join(
    root,
    'org/web/.agents/skills/brainstorming/scripts/run.sh'
  )
  assert.equal((await stat(script)).mode & 0o777, 0o755)
  assert.deepEqual(
    (await readdir(join(root, 'org/web/.claude/skills/brainstorming'))).sort(),
    ['SKILL.md', 'scripts']
  )
  // The root: top-level skills only, under .claude/skills only.
  assert.equal(
    await readFile(join(root, '.claude/skills/release/SKILL.md'), 'utf8'),
    SKILL_MD('release')
  )
  assert.equal(await isThere(join(root, '.claude/skills/deploy')), false)
  assert.equal(await isThere(join(root, '.agents')), false)
})

test('the copies are excluded from git, the lines under the header, the other lines of the file kept', async (t) => {
  const root = await skillsWs(t)
  const file = join(root, 'org/web/.git/info/exclude')
  const before = await readFile(file, 'utf8')
  await writeFile(file, `${before}/mine/\n`)
  await answer(root)
  await project(root)
  assert.equal(await status(root, 'web'), '')
  assert.equal(await status(root, 'api'), '')
  assert.equal(
    await excludeOf(root, 'web'),
    `${before}/mine/\n${EXCLUDE_HEADER}\n${[
      '/.agents/skills/brainstorming/',
      '/.agents/skills/deploy/',
      '/.agents/skills/release/',
      '/.claude/skills/brainstorming/',
      '/.claude/skills/deploy/',
      '/.claude/skills/release/',
    ].join('\n')}\n${EXCLUDE_END}\n`
  )
  // Idempotent: a second run writes and says nothing.
  const again = await project(root)
  assert.deepEqual(again['org/web'], {
    installed: [],
    updated: [],
    rewritten: [],
    removed: [],
    notes: [],
    problems: [],
  })
  assert.equal(
    (await excludeOf(root, 'web')).split(EXCLUDE_HEADER).length,
    2,
    'one header'
  )
})

test('each clone records what rness wrote, with the committed tree; the root in the git directory of .rness', async (t) => {
  const root = await skillsWs(t)
  await answer(root)
  await project(root)
  const deploy = await committed(root, 'skills/scopes/web/deploy')
  const web = await recordOf(join(root, 'org/web/.git/rness/skills.json'))
  assert.equal(web.version, 1)
  assert.deepEqual(web.skills['deploy'], {
    tree: deploy,
    paths: ['.claude/skills/deploy', '.agents/skills/deploy'],
  })
  assert.deepEqual(Object.keys(web.skills).sort(), [
    'brainstorming',
    'deploy',
    'release',
  ])
  const top = await recordOf(join(root, '.rness/.git/rness/root-skills.json'))
  assert.deepEqual(top.skills['release'], {
    tree: await committed(root, 'skills/release'),
    paths: ['.claude/skills/release'],
  })
  assert.deepEqual(
    await readInstalled(join(root, 'org/web/.git/rness/skills.json')),
    web
  )
})

test('agents without claude: .agents/skills only, nothing at the root', async (t) => {
  const root = await skillsWs(t, { agents: [] })
  await answer(root)
  const r = await project(root)
  assert.deepEqual(r['org/web']?.installed, [
    'brainstorming',
    'deploy',
    'release',
  ])
  assert.equal(
    await isThere(join(root, 'org/web/.agents/skills/deploy/SKILL.md')),
    true
  )
  assert.equal(await isThere(join(root, 'org/web/.claude')), false)
  assert.equal(await isThere(join(root, '.claude')), false)
  assert.deepEqual(r['root']?.installed, [])
  const web = await recordOf(join(root, 'org/web/.git/rness/skills.json'))
  assert.deepEqual(web.skills['deploy']?.paths, ['.agents/skills/deploy'])
})

test('claude dropped from agents: the .claude copies and the root ones are removed, the .agents ones kept', async (t) => {
  const root = await skillsWs(t)
  await answer(root)
  await project(root)
  const file = join(root, '.rness/rness.json')
  const json = JSON.parse(await readFile(file, 'utf8')) as Record<
    string,
    unknown
  >
  await writeFile(file, JSON.stringify({ ...json, agents: [] }, null, 2))
  const r = await project(root)
  assert.deepEqual(r['org/web']?.removed, [
    'brainstorming',
    'deploy',
    'release',
  ])
  assert.equal(
    await isThere(join(root, 'org/web/.claude/skills/deploy')),
    false
  )
  assert.equal(await isThere(join(root, 'org/web/.agents/skills/deploy')), true)
  assert.deepEqual(r['root']?.removed, ['brainstorming', 'release'])
  assert.equal(await isThere(join(root, '.claude/skills/release')), false)
  assert.doesNotMatch(await excludeOf(root, 'web'), /\.claude/)
  assert.equal(await status(root, 'web'), '')
})

test('a foreign directory of the same name is never touched and the skill is not installed in that clone', async (t) => {
  const root = await skillsWs(t)
  const mine = join(root, 'org/web/.claude/skills/deploy')
  await mkdir(mine, { recursive: true })
  await writeFile(join(mine, 'SKILL.md'), 'my own deploy\n')
  await answer(root)
  const r = await project(root)
  assert.deepEqual(r['org/web']?.notes, [
    'org/web: .claude/skills/deploy is not one rness wrote; team skill deploy not installed there',
  ])
  assert.deepEqual(r['org/web']?.problems, [])
  assert.equal(
    await readFile(join(mine, 'SKILL.md'), 'utf8'),
    'my own deploy\n'
  )
  assert.deepEqual(await readdir(mine), ['SKILL.md'])
  assert.equal(
    await isThere(join(root, 'org/web/.agents/skills/deploy')),
    false
  )
  assert.deepEqual(r['org/web']?.installed, ['brainstorming', 'release'])
  const web = await recordOf(join(root, 'org/web/.git/rness/skills.json'))
  assert.equal(web.skills['deploy'], undefined)
  assert.doesNotMatch(await excludeOf(root, 'web'), /deploy/)
})

test('a lost record: a directory matching the commit is adopted (recorded, excluded, not rewritten); one with other content is left alone', async (t) => {
  const root = await skillsWs(t)
  await answer(root)
  await project(root)
  const file = join(root, 'org/web/.git/rness/skills.json')
  const before = await recordOf(file)
  await rm(file)
  // brainstorming changed in the clone after the loss: no longer rness's bytes.
  const mine = join(root, 'org/web/.claude/skills/brainstorming')
  await writeFile(join(mine, 'SKILL.md'), 'my own brainstorming\n')
  await rm(join(root, 'org/web/.agents/skills/brainstorming'), {
    recursive: true,
  })
  const r = await project(root)
  const web = r['org/web']
  assert.deepEqual(web?.installed, [])
  assert.deepEqual(web?.rewritten, [])
  assert.deepEqual(web?.removed, [])
  assert.deepEqual(web?.problems, [])
  assert.ok(
    web?.notes.includes(
      'org/web: .claude/skills/brainstorming is not one rness wrote; team skill brainstorming not installed there'
    ),
    web?.notes.join('\n')
  )
  assert.equal(
    await readFile(join(mine, 'SKILL.md'), 'utf8'),
    'my own brainstorming\n'
  )
  const after = await recordOf(file)
  assert.deepEqual(after.skills['release'], before.skills['release'])
  assert.deepEqual(after.skills['deploy'], before.skills['deploy'])
  assert.equal(after.skills['brainstorming'], undefined)
  const exclude = await excludeOf(root, 'web')
  for (const p of ['release', 'deploy'])
    for (const d of ['.claude', '.agents'])
      assert.match(
        exclude,
        new RegExp(`^/${d.replace('.', '\\.')}/skills/${p}/$`, 'm')
      )
  assert.equal(
    await status(root, 'web'),
    '?? .claude/skills/brainstorming/SKILL.md\n?? .claude/skills/brainstorming/scripts/run.sh\n'
  )
})

test('a lost record and a new version committed since: the copy of an earlier commit is adopted at its tree, then updated', async (t) => {
  const root = await skillsWs(t)
  await answer(root, ['release'])
  await project(root)
  const from = await committed(root, 'skills/release')
  const file = join(root, 'org/web/.git/rness/skills.json')
  await rm(file)
  await writeFile(
    join(root, '.rness/skills/release/SKILL.md'),
    SKILL_MD('release', 'v: 2\n')
  )
  await commitRness(root, 'release v2')
  const to = await committed(root, 'skills/release')
  const r = await project(root)
  assert.deepEqual(r['org/web']?.removed, [])
  assert.deepEqual(r['org/web']?.updated, [
    { id: 'release', name: 'release', from, to, tools: null },
  ])
  assert.ok(
    r['org/web']?.notes.includes(
      `org/web: .claude/skills/release is team skill release as committed before (${from.slice(0, 7)}); recorded again`
    ),
    r['org/web']?.notes.join('\n')
  )
  assert.equal(
    await readFile(
      join(root, 'org/web/.claude/skills/release/SKILL.md'),
      'utf8'
    ),
    SKILL_MD('release', 'v: 2\n')
  )
  assert.equal((await recordOf(file)).skills['release']?.tree, to)
})

test('a lost record: a copy matching no commit of the skill stays foreign, and is said so', async (t) => {
  const root = await skillsWs(t)
  await answer(root, ['release'])
  await project(root)
  await rm(join(root, 'org/web/.git/rness/skills.json'))
  await writeFile(
    join(root, 'org/web/.claude/skills/release/SKILL.md'),
    'my own release\n'
  )
  const r = await project(root)
  assert.ok(
    r['org/web']?.notes.includes(
      'org/web: .claude/skills/release is not one rness wrote; team skill release not installed there'
    ),
    r['org/web']?.notes.join('\n')
  )
  assert.equal(
    await readFile(
      join(root, 'org/web/.claude/skills/release/SKILL.md'),
      'utf8'
    ),
    'my own release\n'
  )
})

test('a tracked path of the same name is never written, even once rness had installed it', async (t) => {
  const root = await skillsWs(t)
  await answer(root)
  await project(root)
  // The repository commits its own deploy over the installed copy.
  const web = join(root, 'org/web')
  const own = join(web, '.agents/skills/deploy')
  await rm(own, { recursive: true })
  await mkdir(own, { recursive: true })
  await writeFile(join(own, 'SKILL.md'), 'the repository deploy\n')
  await git(['add', '-f', '.agents/skills/deploy/SKILL.md'], web)
  await git(['commit', '-q', '-m', 'own deploy'], web)
  const r = await project(root)
  assert.deepEqual(r['org/web']?.notes, [
    "org/web: .agents/skills/deploy is the repository's own; team skill deploy not installed there",
  ])
  assert.equal(
    await readFile(join(own, 'SKILL.md'), 'utf8'),
    'the repository deploy\n'
  )
  // Not installed there: the other copy rness wrote goes, the record forgets both.
  assert.equal(await isThere(join(web, '.claude/skills/deploy')), false)
  assert.deepEqual(r['org/web']?.removed, ['deploy'])
  const rec = await recordOf(join(web, '.git/rness/skills.json'))
  assert.equal(rec.skills['deploy'], undefined)
  assert.doesNotMatch(await excludeOf(root, 'web'), /deploy/)
  assert.equal(await status(root, 'web'), '')
})

test('removal: a skill no longer declared, no longer applying, or declined loses its paths, exclude lines and record entry', async (t) => {
  const root = await skillsWs(t)
  await answer(root)
  await project(root)
  // release: deleted from .rness; deploy: now api's; brainstorming: declined.
  await rm(join(root, '.rness/skills/release'), { recursive: true })
  const file = join(root, '.rness/rness.json')
  const json = JSON.parse(await readFile(file, 'utf8')) as {
    scopes: Record<string, Record<string, unknown>>
  }
  const deploy = json.scopes['web']?.['skills']
  delete json.scopes['web']?.['skills']
  json.scopes['api'] = { ...json.scopes['api'], skills: deploy }
  await writeFile(file, JSON.stringify(json, null, 2))
  await rm(join(root, '.rness/skills/scopes/web/deploy'), { recursive: true })
  await mkdir(join(root, '.rness/skills/scopes/api/deploy'), {
    recursive: true,
  })
  await writeFile(
    join(root, '.rness/skills/scopes/api/deploy/SKILL.md'),
    SKILL_MD('deploy')
  )
  await commitRness(root, 'release gone, deploy moved to api')
  await answer(root, ['brainstorming'], 'declined')
  const r = await project(root)
  assert.deepEqual(r['org/web']?.removed, [
    'brainstorming',
    'deploy',
    'release',
  ])
  assert.deepEqual(r['root']?.removed, ['brainstorming', 'release'])
  for (const dir of ['.claude/skills', '.agents/skills'])
    assert.deepEqual(await readdir(join(root, 'org/web', dir)), [])
  assert.deepEqual(await readdir(join(root, '.claude/skills')), [])
  // api/deploy awaits an answer: nothing installed there.
  assert.equal(
    await isThere(join(root, 'org/api/.agents/skills/deploy')),
    false
  )
  const web = await recordOf(join(root, 'org/web/.git/rness/skills.json'))
  assert.deepEqual(web.skills, {})
  assert.doesNotMatch(
    await excludeOf(root, 'web'),
    /rness: team skills|skills\//
  )
  const top = await recordOf(join(root, '.rness/.git/rness/root-skills.json'))
  assert.deepEqual(top.skills, {})
})

test('a copy edited in a clone is rewritten from the commit', async (t) => {
  const root = await skillsWs(t)
  await answer(root)
  await project(root)
  const at = join(root, 'org/web/.claude/skills/deploy')
  await writeFile(join(at, 'SKILL.md'), 'edited\n')
  await writeFile(join(at, 'extra.md'), 'added\n')
  const r = await project(root)
  assert.deepEqual(r['org/web']?.rewritten, ['deploy'])
  assert.deepEqual(r['org/web']?.installed, [])
  assert.deepEqual(
    await filesOf(at),
    await filesOf(join(root, '.rness/skills/scopes/web/deploy'))
  )
})

test('a .DS_Store that Finder adds to an installed copy is no edit: nothing is rewritten', async (t) => {
  const root = await skillsWs(t)
  await answer(root)
  await project(root)
  const copy = join(root, 'org/web/.claude/skills/brainstorming')
  await writeFile(join(copy, '.DS_Store'), 'finder')
  await writeFile(join(copy, 'scripts/.DS_Store'), 'finder')
  const r = await project(root)
  assert.deepEqual(r['org/web']?.rewritten, [])
  assert.deepEqual(r['org/web']?.installed, [])
  assert.equal(await readFile(join(copy, '.DS_Store'), 'utf8'), 'finder')
})

test('a new version of an accepted skill, committed in .rness, replaces the copy with no new answer and is said; declined, it goes', async (t) => {
  const root = await skillsWs(t)
  await answer(root)
  await project(root)
  const from = await committed(root, 'skills/release')
  await writeFile(
    join(root, '.rness/skills/release/SKILL.md'),
    SKILL_MD('release', 'v: 2\n')
  )
  // Not committed yet: nothing moves.
  const draft = await project(root)
  assert.deepEqual(draft['org/web']?.updated, [])
  assert.deepEqual(draft['org/web']?.rewritten, [])
  await commitRness(root, 'release v2')
  const to = await committed(root, 'skills/release')
  const r = await project(root)
  for (const place of ['org/web', 'org/api', 'root'])
    assert.deepEqual(
      r[place]?.updated,
      [{ id: 'release', name: 'release', from, to, tools: null }],
      place
    )
  assert.deepEqual(r['org/web']?.rewritten, [])
  assert.deepEqual(r['org/web']?.installed, [])
  for (const at of [
    'org/web/.claude/skills/release',
    'org/api/.agents/skills/release',
    '.claude/skills/release',
  ])
    assert.equal(
      await readFile(join(root, at, 'SKILL.md'), 'utf8'),
      SKILL_MD('release', 'v: 2\n')
    )
  const web = await recordOf(join(root, 'org/web/.git/rness/skills.json'))
  assert.equal(web.skills['release']?.tree, to)
  await answer(root, ['release'], 'declined')
  const d = await project(root)
  assert.deepEqual(d['org/web']?.removed, ['release'])
  assert.equal(
    await isThere(join(root, 'org/web/.claude/skills/release')),
    false
  )
  assert.equal(await isThere(join(root, '.claude/skills/release')), false)
})

test('nothing accepted: nothing written, no record, no exclude line', async (t) => {
  const root = await skillsWs(t)
  const r = await project(root)
  assert.deepEqual(r['org/web']?.installed, [])
  assert.equal(await isThere(join(root, 'org/web/.claude')), false)
  assert.equal(
    await isThere(join(root, 'org/web/.git/rness/skills.json')),
    false
  )
  assert.doesNotMatch(await excludeOf(root, 'web'), /rness/)
  assert.equal(await isThere(join(root, '.claude')), false)
})

test('a symbolic link at .claude/skills of a clone is never written through', async (t) => {
  const root = await skillsWs(t)
  const elsewhere = await realpath(
    await mkdtemp(join(tmpdir(), 'rness-elsewhere-'))
  )
  t.after(() => rm(elsewhere, { recursive: true, force: true }))
  await mkdir(join(root, 'org/web/.claude'), { recursive: true })
  await symlink(elsewhere, join(root, 'org/web/.claude/skills'))
  await answer(root)
  const r = await project(root)
  assert.deepEqual(await readdir(elsewhere), [])
  assert.deepEqual(r['org/web']?.installed, [])
  assert.deepEqual(r['org/web']?.notes, [
    'org/web: .claude/skills is a symbolic link; rness writes no team skill through it',
  ])
  // The other clone is unaffected.
  assert.deepEqual(r['org/api']?.installed, ['brainstorming', 'release'])
})

test('a symbolic link at .claude of the root is never written through', async (t) => {
  const root = await skillsWs(t)
  const elsewhere = await realpath(
    await mkdtemp(join(tmpdir(), 'rness-elsewhere-'))
  )
  t.after(() => rm(elsewhere, { recursive: true, force: true }))
  await symlink(elsewhere, join(root, '.claude'))
  await answer(root)
  const r = await project(root)
  assert.deepEqual(await readdir(elsewhere), [])
  assert.deepEqual(r['root']?.notes, [
    'workspace root: .claude is a symbolic link; rness writes no team skill through it',
  ])
})

test('a record naming a path rness never writes is not acted on: the clone is left as it is', async (t) => {
  const root = await skillsWs(t)
  const outside = join(root, 'org/keep.txt')
  await writeFile(outside, 'keep\n')
  const file = join(root, 'org/web/.git/rness/skills.json')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      skills: { x: { tree: TREE, paths: ['../keep.txt'] } },
    })
  )
  assert.equal(await readInstalled(file), null)
  await answer(root)
  const r = await project(root)
  assert.equal(await readFile(outside, 'utf8'), 'keep\n')
  assert.deepEqual(r['org/web']?.installed, [])
  assert.match(
    r['org/web']?.notes[0] ?? '',
    /^org\/web: .*skills\.json is unreadable; team skills left as they are there$/
  )
})

test('a workspace whose root is the home directory gets no team skill at its root', async (t) => {
  const root = await skillsWs(t)
  const home = process.env['HOME']
  process.env['HOME'] = root
  t.after(() => {
    process.env['HOME'] = home
  })
  await answer(root)
  const r = await project(root)
  assert.equal(await isThere(join(root, '.claude')), false)
  assert.deepEqual(r['root']?.notes, [
    'workspace root: it is your home directory; rness never writes a team skill there',
  ])
})

/** Every file and directory under `dir`, relative, with a digest of its content and mode. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const seen = new Map<string, string>()
  const visit = async (abs: string): Promise<void> => {
    for (const d of await readdir(abs, { withFileTypes: true })) {
      const child = join(abs, d.name)
      const rel = relative(dir, child).split('\\').join('/')
      if (d.isDirectory()) {
        seen.set(rel, 'dir')
        await visit(child)
      } else {
        const st = await lstat(child)
        seen.set(
          rel,
          `${st.mode}:${
            d.isFile()
              ? createHash('sha256')
                  .update(await readFile(child))
                  .digest('hex')
              : 'other'
          }`
        )
      }
    }
  }
  await visit(dir)
  return seen
}

test('nothing is written outside the workspace, never under HOME, and inside it only the copies and their records', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'rness-home-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const was = process.env['HOME']
  process.env['HOME'] = home
  t.after(() => {
    process.env['HOME'] = was
  })
  const root = await skillsWs(t)
  await answer(root)
  const before = await snapshot(root)
  await project(root)
  await writeFile(
    join(root, 'org/web/.claude/skills/deploy/SKILL.md'),
    'edited\n'
  )
  await answer(root, ['brainstorming'], 'declined')
  await project(root)
  const after = await snapshot(root)
  const allowed = [
    /^org\/(web|api)\/\.(claude|agents)(\/skills(\/[a-z0-9-]+(\/.*)?)?)?$/,
    /^org\/(web|api)\/\.git\/(rness|info)(\/.*)?$/,
    /^\.claude(\/skills(\/[a-z0-9-]+(\/.*)?)?)?$/,
    /^\.rness\/\.git\/rness(\/.*)?$/,
  ]
  const touched = [...after]
    .filter(([p, v]) => before.get(p) !== v)
    .map(([p]) => p)
  assert.ok(touched.length > 0)
  for (const p of touched)
    assert.ok(
      allowed.some((re) => re.test(p)),
      `written outside the copies: ${p}`
    )
  assert.deepEqual(await readdir(home), [])
})

test('a name that applies twice in a clone is left as it is, said only once one of them was accepted', async (t) => {
  const root = await skillsWs(t, {
    skills: {
      brainstorming: { source: 'github:obra/superpowers', tree: TREE },
      deploy: { source: 'path:/top', tree: TREE },
    },
    files: {
      'skills/brainstorming/SKILL.md': SKILL_MD('brainstorming'),
      'skills/brainstorming/scripts/run.sh': '#!/bin/sh\necho hi\n',
      'skills/deploy/SKILL.md': SKILL_MD('deploy', 'top: 1\n'),
      'skills/scopes/web/deploy/SKILL.md': SKILL_MD('deploy'),
    },
  })
  const quiet = await project(root)
  assert.deepEqual(quiet['org/web']?.notes, [])
  await answer(root)
  const r = await project(root)
  assert.deepEqual(r['org/web']?.notes, [
    'org/web: team skill deploy applies here more than once (rness validate says where); left as it is',
  ])
  assert.equal(
    await isThere(join(root, 'org/web/.agents/skills/deploy')),
    false
  )
  // api has the top-level one only.
  assert.deepEqual(r['org/api']?.installed, ['brainstorming', 'deploy'])
})

test('a removal that fails is a problem, and the path stays in the record for the next run', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory modes')
  const root = await skillsWs(t)
  await answer(root)
  await project(root)
  await answer(root, ['brainstorming'], 'declined')
  const parent = join(root, 'org/web/.claude/skills')
  await chmod(parent, 0o555)
  let r: Record<string, Projection>
  try {
    r = await project(root)
  } finally {
    await chmod(parent, 0o755)
  }
  assert.equal(r['org/web']?.problems.length, 1)
  const rec = await recordOf(join(root, 'org/web/.git/rness/skills.json'))
  assert.deepEqual(rec.skills['brainstorming']?.paths, [
    '.claude/skills/brainstorming',
  ])
  assert.match(
    await excludeOf(root, 'web'),
    /^\/\.claude\/skills\/brainstorming\/$/m
  )
  const again = await project(root)
  assert.deepEqual(again['org/web']?.removed, ['brainstorming'])
  assert.equal(await isThere(join(parent, 'brainstorming')), false)
  const after = await recordOf(join(root, 'org/web/.git/rness/skills.json'))
  assert.equal(after.skills['brainstorming'], undefined)
})

test("a line the developer appends after rness's exclude block stays theirs, through every run and when the block goes", async (t) => {
  const root = await skillsWs(t)
  await answer(root)
  await project(root)
  const web = join(root, 'org/web')
  const file = join(web, '.git/info/exclude')
  const mine = join(web, '.claude/skills/mine')
  await mkdir(mine, { recursive: true })
  await writeFile(join(mine, 'SKILL.md'), SKILL_MD('mine'))
  await writeFile(
    file,
    `${await readFile(file, 'utf8')}/.claude/skills/mine/\n`
  )
  assert.equal(await status(root, 'web'), '')
  // The block changes twice: the developer's line is kept each time.
  await answer(root, ['release'], 'declined')
  await project(root)
  assert.match(await excludeOf(root, 'web'), /^\/\.claude\/skills\/mine\/$/m)
  assert.doesNotMatch(await excludeOf(root, 'web'), /release/)
  assert.equal(await status(root, 'web'), '')
  await answer(root, null, 'declined')
  await project(root)
  const text = await excludeOf(root, 'web')
  assert.match(text, /^\/\.claude\/skills\/mine\/$/m)
  assert.equal(text.includes(EXCLUDE_HEADER), false)
  assert.equal(text.includes(EXCLUDE_END), false)
  assert.doesNotMatch(text, /deploy|brainstorming/)
  assert.equal(await status(root, 'web'), '')
  assert.equal(await isThere(join(mine, 'SKILL.md')), true)
})

test("a block whose end line was removed by hand: only the lines the record named are rness's", async (t) => {
  const root = await skillsWs(t)
  await answer(root)
  await project(root)
  const file = join(root, 'org/web/.git/info/exclude')
  const text = (await readFile(file, 'utf8')).replace(`${EXCLUDE_END}\n`, '')
  await writeFile(file, `${text}/.claude/skills/mine/\n`)
  await answer(root, ['release'], 'declined')
  await project(root)
  const after = await excludeOf(root, 'web')
  assert.match(after, /^\/\.claude\/skills\/mine\/$/m)
  assert.doesNotMatch(after, /release/)
  assert.equal(after.split(EXCLUDE_END).length, 2, 'one end line')
})

test('a crafted tree reaching the writer is refused there too: nothing written outside the copy, no .git planted (ruling R34)', async (t) => {
  const root = await skillsWs(t)
  const ws = await findWorkspace(root)
  const manifest = await loadManifest(ws.rnessDir)
  const applied = await appliedSkills(ws, manifest, { version: 1, skills: {} })
  const release = applied.find((a) => a.id === 'release')
  const head = release?.head
  assert.ok(release !== undefined && head !== null && head !== undefined)
  for (const path of [
    '../evil.md',
    '../../escape.md',
    '.git/config',
    'a/GIT~1/x',
  ]) {
    // As if the checks of the tree had been bypassed: the writer checks again.
    const crafted = {
      ...release,
      state: 'installed' as const,
      head: {
        ...head,
        files: [
          ...head.files,
          { ...(head.files[0] as (typeof head.files)[0]), path },
        ],
      },
    }
    const p = await projectClone(ws, manifest, [crafted], 'api')
    assert.match(p.problems.join('\n'), /^org\/api: refusing "/m, path)
    assert.deepEqual(p.installed, [], path)
  }
  for (const at of [
    'org/api/.agents/skills/evil.md',
    'org/api/.agents/escape.md',
    'org/api/.claude/skills/evil.md',
    'org/api/.claude/escape.md',
    'org/api/.agents/skills/release',
  ])
    assert.equal(await isThere(join(root, at)), false, at)
})
