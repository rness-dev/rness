import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadManifest } from '../../src/core/manifest.ts'
import {
  skillConflicts,
  skillsForClone,
  skillsForScope,
  teamSkills,
} from '../../src/core/skills.ts'
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
