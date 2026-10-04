import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'

import { writtenFilesCommand } from '../../src/commands/written-files.ts'
import { writtenFiles } from '../../src/core/agent-targets.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { capture } from '../helpers/capture.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

async function run(cwd: string) {
  const c = capture()
  try {
    const code = await writtenFilesCommand({ cwd })
    return { code, out: c.out(), err: c.err() }
  } finally {
    c.restore()
  }
}

test('written-files: the files this copy’s sync writes in a clone, as JSON, from anywhere in the workspace', async (t) => {
  const root = await makeWorkspace(t, {
    org: 'acme',
    agents: ['claude'],
    dirs: ['org/api'],
  })
  const expected = writtenFiles(await loadManifest(join(root, '.rness')))
  assert.ok(expected.includes('.claude/skills/rness/skills/done/SKILL.md'))
  assert.ok(expected.includes('.claude/skills/rness/hooks/register.tsx'))
  for (const cwd of [root, join(root, 'org', 'api')]) {
    const r = await run(cwd)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out), expected)
  }
})

test('written-files outside a workspace: exit 1, the reason on stderr, nothing on stdout', async (t) => {
  const root = await makeWorkspace(t, {})
  const r = await run(join(root, '..'))
  assert.equal(r.code, 1)
  assert.equal(r.out, '')
  assert.notEqual(r.err, '')
})
