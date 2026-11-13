import assert from 'node:assert/strict'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { run } from '../../src/cli.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { capture } from '../helpers/capture.ts'
import { commitRness, git } from '../helpers/git.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

// Spec 0041 decision 8: a skill's fingerprint is the id git gives the tree of
// its copy in `.rness`, and the checks of §4 run on that tree.

const SKILL_MD = (name: string, extra = ''): string =>
  `---\nname: ${name}\ndescription: A skill\n${extra}---\nBody\n`

const TREE = /^[0-9a-f]{40}$/

async function put(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, ...rel.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
}

/** No global git configuration: a developer's excludes file must not decide what a tree holds. */
function noGlobalGit(t: TestContext): void {
  const was = process.env['GIT_CONFIG_GLOBAL']
  process.env['GIT_CONFIG_GLOBAL'] = '/dev/null'
  t.after(() => {
    if (was === undefined) delete process.env['GIT_CONFIG_GLOBAL']
    else process.env['GIT_CONFIG_GLOBAL'] = was
  })
}

/** A workspace whose `.rness` is a git repository with one commit, the scaffold's `.gitignore` in it. */
async function rnessRepo(
  t: TestContext,
  init: string[] = ['init', '-q', '-b', 'main']
): Promise<string> {
  noGlobalGit(t)
  const root = await makeWorkspace(t, {
    org: 'acme',
    scopes: { web: { url: 'git@github.com:acme/web.git' } },
  })
  const rnessDir = join(root, '.rness')
  await writeFile(
    join(rnessDir, '.gitignore'),
    await readFile(
      new URL('../../scaffold/_gitignore', import.meta.url),
      'utf8'
    )
  )
  await git(init, rnessDir)
  await commitRness(root, 'init')
  return root
}

async function cli(args: string[]) {
  const c = capture()
  try {
    const code = await run(args)
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

const there = (p: string): Promise<boolean> =>
  lstat(p).then(
    () => true,
    () => false
  )

const treeOf = async (root: string, name: string): Promise<string> =>
  (await loadManifest(join(root, '.rness'))).skills?.[name]?.tree ?? ''

test("add: a path: skill carrying its own .gitignore is declared at the tree a fresh clone of .rness commits; validate there reports nothing (the final review's reproduction)", async (t) => {
  const root = await rnessRepo(t)
  await put(join(root, 'ops/deploy'), {
    'SKILL.md': SKILL_MD('deploy'),
    '.gitignore': '*.log\n',
    'debug.log': 'local noise\n',
    'run.sh': '#!/bin/sh\necho deploy\n',
  })
  await chmod(join(root, 'ops/deploy/run.sh'), 0o755)
  const r = await cli(['skill', 'add', 'path:../ops/deploy', '--cwd', root])
  assert.equal(r.code, 0, r.err)
  const tree = await treeOf(root, 'deploy')
  assert.match(tree, TREE)
  assert.match(
    r.out,
    new RegExp(
      `^declared +\\.rness/rness\\.json {2}skills\\.deploy \\(tree ${tree.slice(0, 7)}\\)$`,
      'm'
    )
  )
  // The copy holds what the source holds; git leaves debug.log out.
  assert.equal(await there(join(root, '.rness/skills/deploy/debug.log')), true)
  await commitRness(root, 'skill deploy')

  const mate = join(root, 'mate')
  await mkdir(mate)
  await git(['clone', '-q', join(root, '.rness'), '.rness'], mate)
  assert.equal(
    (
      await git(['rev-parse', 'HEAD:skills/deploy'], join(mate, '.rness'))
    ).trim(),
    tree
  )
  const v = await cli(['validate', '--cwd', mate])
  assert.equal(v.code, 0, v.err)
  assert.doesNotMatch(v.err, /skill "/)
  // And where it was added, once committed: nothing either.
  const here = await cli(['validate', '--cwd', root])
  assert.doesNotMatch(here.err, /skill "/)
})

test("add: what the skill's own .gitignore leaves out counts for nothing, a large file included", async (t) => {
  const root = await rnessRepo(t)
  await put(join(root, 'ops/big'), {
    'SKILL.md': SKILL_MD('big'),
    '.gitignore': 'cache/\n',
    'cache/blob.bin': 'x'.repeat(2 * 1024 * 1024),
  })
  const r = await cli(['skill', 'add', 'path:../ops/big', '--cwd', root])
  assert.equal(r.code, 0, r.err)
  assert.match(
    r.out,
    /^added +skill big \(path:\.\.\/ops\/big, 2 files, 1 KB\)$/m
  )
})

test('add refuses a copy whose tree holds a symbolic link, a nested repository, or more than 1 MB; the copy is removed and rness.json unchanged', async (t) => {
  const root = await rnessRepo(t)
  const manifest = await readFile(join(root, '.rness/rness.json'), 'utf8')
  // A symbolic link, copied as one (never followed).
  await put(join(root, 'ops/linked'), { 'SKILL.md': SKILL_MD('linked') })
  await symlink('SKILL.md', join(root, 'ops/linked/alias.md'))
  // A nested repository with a commit: a gitlink in the tree.
  await put(join(root, 'ops/nested'), {
    'SKILL.md': SKILL_MD('nested'),
    'vendor/README.md': 'vendored\n',
  })
  await git(['init', '-q', '-b', 'main'], join(root, 'ops/nested/vendor'))
  await git(['add', '-A'], join(root, 'ops/nested/vendor'))
  await git(['commit', '-q', '-m', 'v'], join(root, 'ops/nested/vendor'))
  // 1 MB + 1 byte of what git holds.
  const md = SKILL_MD('heavy')
  await put(join(root, 'ops/heavy'), {
    'SKILL.md': md,
    'pad.bin': 'x'.repeat(1024 * 1024 + 1 - Buffer.byteLength(md)),
  })
  for (const [name, why] of [
    [
      'linked',
      /skill "linked": "alias\.md" is a symbolic link; only regular files and directories are allowed/,
    ],
    [
      'nested',
      /skill "nested": "vendor" is a nested repository; a skill holds no repository/,
    ],
    [
      'heavy',
      /skill "heavy": its content is 1048577 bytes, above the limit of 1048576 bytes \(1 MB\)/,
    ],
  ] as const) {
    const r = await cli(['skill', 'add', `path:../ops/${name}`, '--cwd', root])
    assert.equal(r.code, 1, `${name}: ${r.out}`)
    assert.match(r.err, why)
    assert.equal(await there(join(root, '.rness/skills', name)), false, name)
  }
  assert.equal(
    await readFile(join(root, '.rness/rness.json'), 'utf8'),
    manifest
  )
})

test('update refused from the tree restores the previous copy and leaves rness.json as it was', async (t) => {
  const root = await rnessRepo(t)
  await put(join(root, 'ops/deploy'), { 'SKILL.md': SKILL_MD('deploy') })
  assert.equal(
    (await cli(['skill', 'add', 'path:../ops/deploy', '--cwd', root])).code,
    0
  )
  const manifest = await readFile(join(root, '.rness/rness.json'), 'utf8')
  await symlink('SKILL.md', join(root, 'ops/deploy/alias.md'))
  const r = await cli(['skill', 'update', 'deploy', '--cwd', root])
  assert.equal(r.code, 1)
  assert.match(r.err, /"alias\.md" is a symbolic link/)
  assert.equal(
    await readFile(join(root, '.rness/skills/deploy/SKILL.md'), 'utf8'),
    SKILL_MD('deploy')
  )
  assert.equal(await there(join(root, '.rness/skills/deploy/alias.md')), false)
  assert.equal(
    await readFile(join(root, '.rness/rness.json'), 'utf8'),
    manifest
  )
})

test("validate inside the .rness pre-commit: the commit's index stays byte for byte as it was", async (t) => {
  const root = await rnessRepo(t)
  await put(join(root, 'ops/deploy'), { 'SKILL.md': SKILL_MD('deploy') })
  assert.equal(
    (await cli(['skill', 'add', 'path:../ops/deploy', '--cwd', root])).code,
    0
  )
  await commitRness(root, 'skill')
  // A commit in progress: an edit staged, its index differing from HEAD.
  const rnessDir = join(root, '.rness')
  await writeFile(join(rnessDir, 'skills/deploy/notes.md'), 'staged\n')
  await git(['add', 'skills/deploy/notes.md'], rnessDir)
  const index = join(rnessDir, '.git/index')
  const before = await readFile(index)
  const was = process.env['GIT_INDEX_FILE']
  process.env['GIT_INDEX_FILE'] = index
  let v: Awaited<ReturnType<typeof cli>>
  try {
    v = await cli(['validate', '--cwd', root])
  } finally {
    if (was === undefined) delete process.env['GIT_INDEX_FILE']
    else process.env['GIT_INDEX_FILE'] = was
  }
  // The tree was taken (the copy now differs from its source) ...
  assert.match(v.err, /skill "deploy" differs from its source/)
  // ... in an index of its own.
  assert.deepEqual(await readFile(index), before)
  assert.equal(
    (await git(['diff', '--cached', '--name-only'], rnessDir)).trim(),
    'skills/deploy/notes.md'
  )
})

test('a sha256 .rness: the tree is 64 hexadecimal characters, HEAD names the same, validate reports nothing', async (t) => {
  const root = await rnessRepo(t, [
    'init',
    '-q',
    '-b',
    'main',
    '--object-format=sha256',
  ])
  await put(join(root, 'ops/deploy'), { 'SKILL.md': SKILL_MD('deploy') })
  const r = await cli(['skill', 'add', 'path:../ops/deploy', '--cwd', root])
  assert.equal(r.code, 0, r.err)
  const tree = await treeOf(root, 'deploy')
  assert.match(tree, /^[0-9a-f]{64}$/)
  await commitRness(root, 'skill')
  assert.equal(
    (
      await git(['rev-parse', 'HEAD:skills/deploy'], join(root, '.rness'))
    ).trim(),
    tree
  )
  const v = await cli(['validate', '--cwd', root])
  assert.doesNotMatch(v.err, /skill "/)
})

test('a .rness that is no git repository yet: the tree is the one git will give it, and validate checks it', async (t) => {
  noGlobalGit(t)
  const plain = await makeWorkspace(t, { org: 'acme' })
  const repo = await rnessRepo(t)
  for (const root of [plain, repo])
    await put(join(root, 'ops/deploy'), {
      'SKILL.md': SKILL_MD('deploy'),
      'run.sh': 'echo\n',
    })
  for (const root of [plain, repo])
    assert.equal(
      (await cli(['skill', 'add', 'path:../ops/deploy', '--cwd', root])).code,
      0
    )
  assert.equal(await treeOf(plain, 'deploy'), await treeOf(repo, 'deploy'))
  await symlink('SKILL.md', join(plain, '.rness/skills/deploy/alias.md'))
  const v = await cli(['validate', '--cwd', plain])
  assert.equal(v.code, 1)
  assert.match(v.err, /skill "deploy": "alias\.md" is a symbolic link/)
})
