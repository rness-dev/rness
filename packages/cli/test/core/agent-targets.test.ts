import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
const PLUGIN_JSON = '.claude/skills/rness/.claude-plugin/plugin.json'
const SKILL = '.claude/skills/rness/skills/status/SKILL.md'
/** The lifecycle skills (spec 0019 §2), after the status skill. */
const LIFECYCLE = ['adr', 'spec', 'plan'].map(
  (name) => `.claude/skills/rness/skills/${name}/SKILL.md`
)
/** Written up to 0.17; removed when found, silent when absent (spec 0028 §8). */
const RETIRED = '.claude/skills/rness/skills/done/SKILL.md'

/** Every file the Claude target writes here, in the order it walks them. */
const LABELS = [
  SETTINGS,
  PLUGIN_JSON,
  SKILL,
  ...LIFECYCLE,
  `org/api/${SETTINGS}`,
  'org/api/.mcp.json',
  `org/api/${PLUGIN_JSON}`,
  `org/api/${SKILL}`,
  ...LIFECYCLE.map((f) => `org/api/${f}`),
]
const all = (status: 'updated' | 'unchanged') =>
  LABELS.map((label) => ({ label, status, detail: null }))

async function outcome(
  root: string,
  manifest: Awaited<ReturnType<typeof loadManifest>>,
  label: string,
  check: boolean
) {
  return (await agentTargets(root, manifest, { check })).find(
    (o) => o.label === label
  )
}

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
  PreToolUse: [
    {
      matcher: 'Edit|Write',
      hooks: [
        {
          type: 'command',
          command: hookLine(rness, 'pre-tool-use'),
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
  SessionEnd: [
    {
      hooks: [
        {
          type: 'command',
          command: hookLine(rness, 'session-end'),
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

test('claude declared: the workspace root gets its hooks and the plugin, each cloned repository its settings, .mcp.json and the plugin; a missing clone is skipped', async (t) => {
  const { root, manifest } = await workspace(t, ['claude'])
  assert.deepEqual(
    await agentTargets(root, manifest, { check: false }),
    all('updated')
  )
  assert.match(
    await readFile(join(root, 'org', 'api', ...SKILL.split('/')), 'utf8'),
    /^!`node "\$\{CLAUDE_PROJECT_DIR\}\/\.\.\/\.\.\/\.rness\/node_modules\//m
  )
  assert.match(
    await readFile(join(root, ...SKILL.split('/')), 'utf8'),
    /^!`node "\$\{CLAUDE_PROJECT_DIR\}\/\.rness\/node_modules\//m
  )
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
  assert.deepEqual(
    await agentTargets(root, manifest, { check: false }),
    all('unchanged')
  )
})

test('a file of the plugin edited by hand differs; sync writes it back', async (t) => {
  const { root, manifest } = await workspace(t, ['claude'])
  await agentTargets(root, manifest, { check: false })
  const file = join(root, 'org', 'api', ...SKILL.split('/'))
  const written = await readFile(file, 'utf8')
  await writeFile(file, `${written}\nAlso run the tests.\n`)
  assert.deepEqual(await outcome(root, manifest, `org/api/${SKILL}`, true), {
    label: `org/api/${SKILL}`,
    status: 'stale',
    detail: 'differs from what rness writes',
  })
  assert.equal(
    (await outcome(root, manifest, `org/api/${SKILL}`, false))?.status,
    'updated'
  )
  assert.equal(await readFile(file, 'utf8'), written)
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
  assert.deepEqual(hooks.PreToolUse, hooksFor('../../.rness').PreToolUse)
  assert.deepEqual(hooks.PostToolUse, hooksFor('../../.rness').PostToolUse)
  assert.deepEqual(hooks.SessionEnd, hooksFor('../../.rness').SessionEnd)
})

test('the status skill names the workspace’s manager; a changed manager leaves it stale, and sync rewrites it', async (t) => {
  const { root, manifest } = await workspace(t, ['claude'])
  const pkg = join(root, '.rness', 'package.json')
  await writeFile(pkg, '{ "packageManager": "pnpm@12.5.1" }\n')
  await agentTargets(root, manifest, { check: false })
  const file = join(root, 'org', 'api', ...SKILL.split('/'))
  assert.match(await readFile(file, 'utf8'), /`pnpm rness status`\._\n$/)
  await writeFile(pkg, '{ "packageManager": "npm@11.6.0" }\n')
  assert.deepEqual(
    (await agentTargets(root, manifest, { check: true }))
      .filter((o) => o.status !== 'unchanged')
      .map((o) => o.label),
    [SKILL, `org/api/${SKILL}`]
  )
  await agentTargets(root, manifest, { check: false })
  assert.match(await readFile(file, 'utf8'), /`npx rness status`\._\n$/)
})

test('the workspace root file is in no repository: never among the written files of a clone', async (t) => {
  const { manifest } = await workspace(t, ['claude'])
  assert.deepEqual(writtenFiles(manifest), [
    'AGENTS.md',
    'CLAUDE.md',
    SETTINGS,
    '.mcp.json',
    PLUGIN_JSON,
    SKILL,
    ...LIFECYCLE,
    // Named so that its deletion is committed with the rest (plan 0037).
    RETIRED,
  ])
})

test('a retired skill file is removed where it is found, named under check, silent when absent (spec 0028 §8)', async (t) => {
  const { root, manifest } = await workspace(t, ['claude'])
  await agentTargets(root, manifest, { check: false })
  // 0.17 wrote it at the workspace root and in every clone.
  const atRoot = join(root, ...RETIRED.split('/'))
  const stale = join(root, 'org', 'api', ...RETIRED.split('/'))
  for (const file of [atRoot, stale]) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, '---\nname: done\n---\n')
  }
  const retired = (outcomes: { label: string }[]) =>
    outcomes.filter((o) => o.label.endsWith('done/SKILL.md'))
  const gone = 'no longer written by rness; remove it'
  assert.deepEqual(
    retired(await agentTargets(root, manifest, { check: true })),
    [
      { label: RETIRED, status: 'stale', detail: gone },
      { label: `org/api/${RETIRED}`, status: 'stale', detail: gone },
    ]
  )
  await access(atRoot)
  await access(stale)
  assert.deepEqual(
    retired(await agentTargets(root, manifest, { check: false })),
    [
      { label: RETIRED, status: 'removed', detail: null },
      { label: `org/api/${RETIRED}`, status: 'removed', detail: null },
    ]
  )
  await assert.rejects(access(atRoot))
  await assert.rejects(access(stale))
  await assert.rejects(access(dirname(stale)), 'its directory went with it')
  assert.deepEqual(
    retired(await agentTargets(root, manifest, { check: false })),
    []
  )
})

test('check writes nothing and says what is missing; an unreadable file is reported and kept', async (t) => {
  const { root, manifest } = await workspace(t, ['claude'])
  assert.deepEqual(await agentTargets(root, manifest, { check: true }), [
    {
      label: SETTINGS,
      status: 'stale',
      detail:
        'hooks.SessionStart lacks the rness session-start hook; hooks.PreToolUse lacks the rness pre-tool-use hook; hooks.PostToolUse lacks the rness post-tool-use hook; hooks.SessionEnd lacks the rness session-end hook',
    },
    { label: PLUGIN_JSON, status: 'stale', detail: 'missing' },
    { label: SKILL, status: 'stale', detail: 'missing' },
    ...LIFECYCLE.map((label) => ({
      label,
      status: 'stale',
      detail: 'missing',
    })),
    {
      label: `org/api/${SETTINGS}`,
      status: 'stale',
      detail:
        'permissions.additionalDirectories lacks ../../.rness; hooks.SessionStart lacks the rness session-start hook; hooks.PreToolUse lacks the rness pre-tool-use hook; hooks.PostToolUse lacks the rness post-tool-use hook; hooks.SessionEnd lacks the rness session-end hook',
    },
    {
      label: 'org/api/.mcp.json',
      status: 'stale',
      detail: 'mcpServers.rness is missing',
    },
    { label: `org/api/${PLUGIN_JSON}`, status: 'stale', detail: 'missing' },
    { label: `org/api/${SKILL}`, status: 'stale', detail: 'missing' },
    ...LIFECYCLE.map((f) => ({
      label: `org/api/${f}`,
      status: 'stale',
      detail: 'missing',
    })),
  ])
  await mkdir(join(root, 'org', 'api', '.claude'))
  await writeFile(join(root, 'org', 'api', SETTINGS), '{ oops')
  for (const check of [true, false])
    assert.deepEqual(
      await outcome(root, manifest, `org/api/${SETTINGS}`, check),
      {
        label: `org/api/${SETTINGS}`,
        status: 'invalid',
        detail: 'not valid JSON',
      }
    )
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
  assert.deepEqual(
    await agentTargets(root, manifest, { check: true }),
    all('unchanged').map((o) =>
      o.label === 'org/api/.mcp.json'
        ? { ...o, status: 'stale', detail: 'mcpServers.rness is missing' }
        : o
    )
  )
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
    assert.deepEqual(
      await outcome(root, manifest, `org/api/${SETTINGS}`, check),
      { label: `org/api/${SETTINGS}`, status: 'unchanged', detail: null }
    )
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
  assert.deepEqual(
    await leftoverTargets(root, { ...manifest, agents: [] }),
    LABELS
  )
  // Never asked: nothing to say about files someone wrote by hand.
  assert.deepEqual(
    await leftoverTargets(root, { ...manifest, agents: null }),
    []
  )
})

test('no org/ — a standalone checkout of .rness, as in its CI: nothing at the root either', async (t) => {
  const root = await makeWorkspace(t, { org: 'acme', agents: ['claude'] })
  const manifest = await loadManifest(join(root, '.rness'))
  for (const check of [true, false])
    assert.deepEqual(await agentTargets(root, manifest, { check }), [])
  await assert.rejects(readFile(join(root, SETTINGS), 'utf8'))
})
