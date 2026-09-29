import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SUPPORTED_AGENTS,
  TARGETS,
  unsupportedAgents,
  unsupportedMessage,
} from '../../src/core/agents.ts'
import { VERSION } from '../../src/version.ts'

// The exact lines Claude Code runs. Never change them: a changed entry is
// appended next to the old one, and the hook runs twice (spec 0015 §2.3).
const CLONE_START =
  'f="$CLAUDE_PROJECT_DIR/../../.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook session-start; else echo \'{"systemMessage":"rness: ../../.rness is not installed, so the workspace context is not loaded. Clone the workspace, then install its dependencies in .rness."}\'; fi'
const CLONE_EDIT =
  'f="$CLAUDE_PROJECT_DIR/../../.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook post-tool-use; fi'
const ROOT_START =
  'f="$CLAUDE_PROJECT_DIR/.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook session-start; else echo \'{"systemMessage":"rness: .rness is not installed, so the workspace context is not loaded. Clone the workspace, then install its dependencies in .rness."}\'; fi'
const ROOT_EDIT =
  'f="$CLAUDE_PROJECT_DIR/.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook post-tool-use; fi'

const CLONE_END =
  'f="$CLAUDE_PROJECT_DIR/../../.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook session-end; fi'
const ROOT_END =
  'f="$CLAUDE_PROJECT_DIR/.rness/node_modules/@rness/cli/dist/bin/rness.js"; if [ -f "$f" ]; then node "$f" hook session-end; fi'

const hooks = (start: string, edit: string, end: string) => [
  {
    path: ['hooks', 'SessionStart'],
    contains: { hooks: [{ type: 'command', command: start, timeout: 10 }] },
    label: 'the rness session-start hook',
  },
  {
    path: ['hooks', 'PostToolUse'],
    contains: {
      matcher: 'Edit|Write',
      hooks: [{ type: 'command', command: edit, timeout: 10 }],
    },
    label: 'the rness post-tool-use hook',
  },
  {
    path: ['hooks', 'SessionEnd'],
    contains: { hooks: [{ type: 'command', command: end, timeout: 10 }] },
    label: 'the rness session-end hook',
  },
]

// The plugin rness owns whole (spec 0016 §3). Nothing version-specific: an
// upgrade must rewrite neither file.
const PLUGIN_JSON = `{
  "name": "rness",
  "description": "The rness workspace in Claude Code: /rness:status."
}
`
const skill = (rness: string) => `---
name: status
description: The status of every decision, specification, plan and other tracked document of the rness workspace, one table per directory. Read-only.
argument-hint: '[tab]'
disable-model-invocation: true
allowed-tools: Bash(node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status --cwd "\${CLAUDE_PROJECT_DIR}")
---

!\`node "\${CLAUDE_PROJECT_DIR}/${rness}/node_modules/@rness/cli/dist/bin/rness.js" status --cwd "\${CLAUDE_PROJECT_DIR}"\`

Show the output above to the user as it is: the heading and the tables,
nothing added, nothing summarised, no other tool. Arguments: \`$ARGUMENTS\`.
When they name a tab, show only that tab's section. If the output says the
module cannot be found, say instead that ${rness} is not installed next to
this repository.

End with this line: _For the view with tabs and scrolling: Ctrl+Z, then
\`npx @rness/cli status\` (q to close), then \`fg\`._
`
const plugin = (rness: string, at: 'clones' | 'root') => [
  {
    file: '.claude/skills/rness/.claude-plugin/plugin.json',
    at,
    content: PLUGIN_JSON,
  },
  {
    file: '.claude/skills/rness/skills/status/SKILL.md',
    at,
    content: skill(rness),
  },
]

test('Claude Code is the one target: read access to .rness, the rness MCP server, the hooks, the plugin', () => {
  assert.deepEqual(SUPPORTED_AGENTS, ['claude'])
  assert.deepEqual(TARGETS['claude'], {
    name: 'claude',
    label: 'Claude Code',
    files: [
      {
        file: '.claude/settings.json',
        at: 'clones',
        guarantees: [
          {
            path: ['permissions', 'additionalDirectories'],
            contains: '../../.rness',
          },
          ...hooks(CLONE_START, CLONE_EDIT, CLONE_END),
        ],
      },
      {
        file: '.mcp.json',
        at: 'clones',
        guarantees: [
          {
            path: ['mcpServers', 'rness'],
            value: {
              command: 'node',
              args: [
                '../../.rness/node_modules/@rness/cli/dist/bin/rness.js',
                'mcp',
              ],
            },
          },
        ],
      },
      ...plugin('../../.rness', 'clones'),
      {
        file: '.claude/settings.json',
        at: 'root',
        guarantees: hooks(ROOT_START, ROOT_EDIT, ROOT_END),
      },
      ...plugin('.rness', 'root'),
    ],
  })
})

test('the session-start line is valid sh, and its fallback is one JSON object', async () => {
  const { execFileSync } = await import('node:child_process')
  // No copy installed at a made-up project directory: the fallback speaks.
  const out = execFileSync('sh', ['-c', CLONE_START], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: '/nonexistent/org/web' },
    encoding: 'utf8',
  })
  assert.deepEqual(JSON.parse(out), {
    systemMessage:
      'rness: ../../.rness is not installed, so the workspace context is not loaded. Clone the workspace, then install its dependencies in .rness.',
  })
  // The edit and end hooks say nothing and succeed.
  for (const line of [CLONE_EDIT, CLONE_END])
    assert.equal(
      execFileSync('sh', ['-c', line], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: '/nonexistent/org/web' },
        encoding: 'utf8',
      }),
      ''
    )
})

test('unsupportedAgents keeps the names this version has no target for', () => {
  assert.deepEqual(unsupportedAgents(['claude', 'codex', 'cursor']), [
    'codex',
    'cursor',
  ])
  assert.deepEqual(unsupportedAgents([]), [])
  // A name on the prototype chain is not a target.
  assert.deepEqual(unsupportedAgents(['constructor']), ['constructor'])
  assert.equal(
    unsupportedMessage('codex'),
    `rness.json: agent "codex" is not supported by @rness/cli ${VERSION} (supported: claude)`
  )
})
