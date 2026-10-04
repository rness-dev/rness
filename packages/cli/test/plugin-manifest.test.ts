import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { TARGETS } from '../src/core/agents.ts'

/**
 * The Agent Plugins manifest at the repository root (spec 0027 §5): the
 * agent-plugins.org form, where a scanner looks for it. The Claude Code
 * plugin keeps its own manifest under `.claude/skills/rness/.claude-plugin/`,
 * written by `rness sync`; this one describes the repository.
 */
const MANIFEST = new URL('../../../plugin.json', import.meta.url)

test('the root plugin.json is an Agent Plugins manifest naming rness', async () => {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as Record<
    string,
    unknown
  >
  assert.equal(
    manifest['$schema'],
    'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
  )
  assert.equal(manifest['name'], 'rness')
  assert.match(manifest['name'] as string, /^[a-z0-9]+([.-][a-z0-9]+)*$/)
  assert.equal(manifest['homepage'], 'https://rness.dev')
  assert.equal(manifest['repository'], 'https://github.com/rness-dev/rness')
  assert.equal(manifest['license'], 'MIT')
  assert.ok(
    typeof manifest['description'] === 'string' &&
      manifest['description'].length > 0
  )
})

test('the mod folder’s plugin.json is the one sync writes, so claude plugin test loads what ships', async () => {
  const written = TARGETS['claude']
    ?.files({ packageManager: 'npm' })
    .find(
      (f) =>
        f.at === 'root' &&
        f.file === '.claude/skills/rness/.claude-plugin/plugin.json'
    )
  assert.ok(written !== undefined && 'content' in written)
  assert.equal(
    await readFile(
      new URL('../mod/.claude-plugin/plugin.json', import.meta.url),
      'utf8'
    ),
    written.content
  )
})
