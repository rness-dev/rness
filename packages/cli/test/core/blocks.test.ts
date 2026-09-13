import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { run } from '../../src/cli.ts'
import { checkBlocks } from '../../src/core/blocks.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { capture } from '../helpers/capture.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

async function synced(t: Parameters<typeof makeWorkspace>[0]) {
  const root = await makeWorkspace(t, {
    org: 'acme',
    scopes: { web: { path: 'org/web' }, api: { path: 'org/api' } },
    files: {
      'standards/web/seo.md': '# SEO\n',
      'standards/coding.md': '# Coding\n',
    },
    dirs: ['org/web'],
  })
  const c = capture()
  assert.equal(await run(['sync', '--yes', '--cwd', root]), 0)
  c.restore()
  return root
}

async function check(root: string) {
  const manifest = await loadManifest(join(root, '.rness'))
  return checkBlocks({
    root,
    rnessDir: join(root, '.rness'),
    manifest,
    org: 'acme',
  })
}

const ABSENT_API = 'org/api/AGENTS.md: directory not present, block not checked'

test('a freshly synced workspace has no problems; an absent scope directory is only noted', async (t) => {
  assert.deepEqual(await check(await synced(t)), {
    problems: [],
    warnings: [ABSENT_API],
  })
})

test('editing a standard makes the block stale; a missing block is only a warning', async (t) => {
  const root = await synced(t)
  await writeFile(
    join(root, '.rness', 'standards', 'web', 'seo.md'),
    '# SEO\n\nChanged.\n'
  )
  const stale = await check(root)
  assert.deepEqual(stale.problems, [
    'org/web/AGENTS.md: stale rness block (run rness sync)',
  ])
  const { rm } = await import('node:fs/promises')
  await rm(join(root, 'AGENTS.md'))
  const missing = await check(root)
  assert.deepEqual(missing.warnings, [
    'AGENTS.md: no rness block yet (run rness sync)',
    ABSENT_API,
  ])
})

test('a hand edit inside the block body is stale even though the header still matches', async (t) => {
  const root = await synced(t)
  const file = join(root, 'org', 'web', 'AGENTS.md')
  const text = await readFile(file, 'utf8')
  await writeFile(file, text.replace('standalone clone', 'standalone copy'))
  assert.notEqual(
    await readFile(file, 'utf8'),
    text,
    'the edit landed inside the block body'
  )
  const edited = await check(root)
  assert.deepEqual(edited.problems, [
    'org/web/AGENTS.md: stale rness block (run rness sync)',
  ])
})

test('a malformed block is a problem; no org/ means nothing to check', async (t) => {
  const root = await synced(t)
  const file = join(root, 'org', 'web', 'AGENTS.md')
  await writeFile(
    file,
    (await readFile(file, 'utf8')).replace('<!-- END rness -->', '')
  )
  const bad = await check(root)
  assert.equal(bad.problems.length, 1)
  assert.match(
    bad.problems[0] ?? '',
    /^org\/web\/AGENTS\.md: expected exactly one/
  )
  const bare = await makeWorkspace(t, {
    org: 'acme',
    scopes: { web: { path: 'org/web' } },
  })
  const manifest = await loadManifest(join(bare, '.rness'))
  assert.deepEqual(
    await checkBlocks({
      root: bare,
      rnessDir: join(bare, '.rness'),
      manifest,
      org: 'acme',
    }),
    { problems: [], warnings: [] }
  )
})
