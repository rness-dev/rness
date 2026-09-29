import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'

import {
  agentTargets,
  leftoverTargets,
  writtenFiles,
} from '../../src/core/agent-targets.ts'
import { hookLine } from '../../src/core/agents.ts'
import { loadManifest } from '../../src/core/manifest.ts'
import { makeWorkspace } from '../helpers/workspace.ts'

const SETTINGS = '.claude/settings.json'

/** The `hooks` key the Claude target guarantees, `.rness` reached at `rness`. */
const hooksFor = (rness: string) => ({
  SessionStart: [
    {
      hooks: [
        {
          type: 'command',
          command: hookLine(rness, 'session-start'),
          timeout: 10,
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: 'Edit|Write',
      hooks: [
        {
          type: 'command',
          command: hookLine(rness, 'post-tool-use'),
          timeout: 10,
        },
      ],
    },
  ],
})

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

test('claude declared: the workspace root gets its hooks, each cloned repository its settings and .mcp.json; a missing clone is skipped', async (t) => {
  const { root, manifest } = await workspace(t, ['claude'])
  assert.deepEqual(await agentTargets(root, manifest, { check: false }), [
    { label: SETTINGS, status: 'updated', detail: null },
    { label: `org/api/${SETTINGS}`, status: 'updated', detail: null },
    { label: 'org/api/.mcp.json', status: 'updated', detail: null },
  ])
  assert.deepEqual(JSON.parse(await readFile(join(root, SETTINGS), 'utf8')), {
    hooks: hooksFor('.rness'),
  })
  assert.deepEqual(
    JSON.parse(await readFile(join(root, 'org', 'api', SETTINGS), 'utf8')),
    {
      permissions: { additionalDirectories: ['../../.rness'] },
      hooks: hooksFor('../../.rness'),
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
    { label: SETTINGS, status: 'unchanged', detail: null },
    { label: `org/api/${SETTINGS}`, status: 'unchanged', detail: null },
    { label: 'org/api/.mcp.json', status: 'unchanged', detail: null },
  ])
})

test("the team's own hooks stay; rness's are appended after them", async (t) => {
  const { root, manifest } = await workspace(t, ['claude'])
  const team = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
    },
  }
  await mkdir(join(root, 'org', 'api', '.claude'))
  await writeFile(
    join(root, 'org', 'api', SETTINGS),
    `${JSON.stringify(team, null, 2)}\n`
  )
  await agentTargets(root, manifest, { check: false })
  const hooks = JSON.parse(
    await readFile(join(root, 'org', 'api', SETTINGS), 'utf8')
  ).hooks
  assert.deepEqual(hooks.SessionStart, [
    team.hooks.SessionStart[0],
    ...hooksFor('../../.rness').SessionStart,
  ])
  assert.deepEqual(hooks.PostToolUse, hooksFor('../../.rness').PostToolUse)
})

test('the workspace root file is in no repository: never among the written files of a clone', async (t) => {
  const { manifest } = await workspace(t, ['claude'])
  assert.deepEqual(writtenFiles(manifest), [
    'AGENTS.md',
    'CLAUDE.md',
    SETTINGS,
    '.mcp.json',
  ])
})

test('check writes nothing and says what is missing; an unreadable file is reported and kept', async (t) => {
  const { root, manifest } = await workspace(t, ['claude'])
  assert.deepEqual(await agentTargets(root, manifest, { check: true }), [
    {
      label: SETTINGS,
      status: 'stale',
      detail:
        'hooks.SessionStart lacks the rness session-start hook; hooks.PostToolUse lacks the rness post-tool-use hook',
    },
    {
      label: `org/api/${SETTINGS}`,
      status: 'stale',
      detail:
        'permissions.additionalDirectories lacks ../../.rness; hooks.SessionStart lacks the rness session-start hook; hooks.PostToolUse lacks the rness post-tool-use hook',
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
    assert.deepEqual((await agentTargets(root, manifest, { check }))[1], {
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
    { label: SETTINGS, status: 'unchanged', detail: null },
    { label: `org/api/${SETTINGS}`, status: 'unchanged', detail: null },
    {
      label: 'org/api/.mcp.json',
      status: 'stale',
      detail: 'mcpServers.rness is missing',
    },
  ])
})

test('a settings file written by 0.9.0 keeps its enabledMcpjsonServers: rness neither needs nor removes it', async (t) => {
  const { root, manifest } = await workspace(t, ['claude'])
  await agentTargets(root, manifest, { check: false })
  const written = `${JSON.stringify(
    {
      permissions: { additionalDirectories: ['../../.rness'] },
      enabledMcpjsonServers: ['rness'],
      hooks: hooksFor('../../.rness'),
    },
    null,
    2
  )}\n`
  await writeFile(join(root, 'org', 'api', SETTINGS), written)
  for (const check of [true, false])
    assert.deepEqual((await agentTargets(root, manifest, { check }))[1], {
      label: `org/api/${SETTINGS}`,
      status: 'unchanged',
      detail: null,
    })
  assert.equal(
    await readFile(join(root, 'org', 'api', SETTINGS), 'utf8'),
    written
  )
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
    SETTINGS,
    `org/api/${SETTINGS}`,
    'org/api/.mcp.json',
  ])
  // Never asked: nothing to say about files someone wrote by hand.
  assert.deepEqual(
    await leftoverTargets(root, { ...manifest, agents: null }),
    []
  )
})
