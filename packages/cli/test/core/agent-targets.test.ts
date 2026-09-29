import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import { agentTargets, leftoverTargets } from '../../src/core/agent-targets.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const SETTINGS = '.claude/settings.json'

async function workspace(t: TestContext, agents?: string[]) {
  const root = await makeWorkspace(t, {
    org: 'acme',
    ...(agents === undefined ? {} : { agents }),
    repos: {
      api: { url: 'https://github.com/acme/api.git' },
      web: { url: 'https://github.com/acme/web.git' },
    },
    dirs: ['org/api'],
  })
  const manifest = await loadManifest(join(root, '.rness'))
  return { root, manifest }
}

test('claude declared: each cloned repository gets its settings and .mcp.json; a missing clone is skipped', async (t) => {
  const { root, manifest } = await workspace(t, ['claude'])
  assert.deepEqual(await agentTargets(root, manifest, { check: false }), [
    { label: `org/api/${SETTINGS}`, status: 'updated', detail: null },
    { label: 'org/api/.mcp.json', status: 'updated', detail: null },
  ])
  assert.deepEqual(
    JSON.parse(await readFile(join(root, 'org', 'api', SETTINGS), 'utf8')),
    {
      permissions: { additionalDirectories: ['../../.rness'] },
      enabledMcpjsonServers: ['rness'],
    }
  )
  assert.deepEqual(
    JSON.parse(await readFile(join(root, 'org', 'api', '.mcp.json'), 'utf8')),
    {
      mcpServers: {
        rness: {
          command: 'node',
          args: [
            '../../.rness/node_modules/@rness/cli/dist/bin/rness.js',
            'mcp',
          ],
        },
      },
    }
  )
  assert.deepEqual(await agentTargets(root, manifest, { check: false }), [
    { label: `org/api/${SETTINGS}`, status: 'unchanged', detail: null },
    { label: 'org/api/.mcp.json', status: 'unchanged', detail: null },
  ])
})

test('check writes nothing and says what is missing; an unreadable file is reported and kept', async (t) => {
  const { root, manifest } = await workspace(t, ['claude'])
  assert.deepEqual(await agentTargets(root, manifest, { check: true }), [
    {
      label: `org/api/${SETTINGS}`,
      status: 'stale',
      detail:
        'permissions.additionalDirectories lacks ../../.rness; enabledMcpjsonServers lacks rness',
    },
    {
      label: 'org/api/.mcp.json',
      status: 'stale',
      detail: 'mcpServers.rness is missing',
    },
  ])
  await mkdir(join(root, 'org', 'api', '.claude'))
  await writeFile(join(root, 'org', 'api', SETTINGS), '{ oops')
  for (const check of [true, false])
    assert.deepEqual((await agentTargets(root, manifest, { check }))[0], {
      label: `org/api/${SETTINGS}`,
      status: 'invalid',
      detail: 'not valid JSON',
    })
  assert.equal(
    await readFile(join(root, 'org', 'api', SETTINGS), 'utf8'),
    '{ oops'
  )
})

test('check: complete settings, .mcp.json without rness — only .mcp.json is stale', async (t) => {
  const { root, manifest } = await workspace(t, ['claude'])
  await agentTargets(root, manifest, { check: false })
  await writeFile(
    join(root, 'org', 'api', '.mcp.json'),
    '{ "mcpServers": { "db": { "command": "db-mcp" } } }\n'
  )
  assert.deepEqual(await agentTargets(root, manifest, { check: true }), [
    { label: `org/api/${SETTINGS}`, status: 'unchanged', detail: null },
    {
      label: 'org/api/.mcp.json',
      status: 'stale',
      detail: 'mcpServers.rness is missing',
    },
  ])
})

test('no agents, or none declared: nothing is written', async (t) => {
  for (const agents of [undefined, []]) {
    const { root, manifest } = await workspace(t, agents)
    assert.deepEqual(await agentTargets(root, manifest, { check: false }), [])
  }
})

test('leftovers: a file still carrying the values of an agent no longer declared', async (t) => {
  const { root, manifest } = await workspace(t, ['claude'])
  await agentTargets(root, manifest, { check: false })
  assert.deepEqual(await leftoverTargets(root, manifest), [])
  assert.deepEqual(await leftoverTargets(root, { ...manifest, agents: [] }), [
    `org/api/${SETTINGS}`,
    'org/api/.mcp.json',
  ])
  // Never asked: nothing to say about files someone wrote by hand.
  assert.deepEqual(
    await leftoverTargets(root, { ...manifest, agents: null }),
    []
  )
})
