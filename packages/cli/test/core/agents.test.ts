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

const hooks = (start: string, edit: string) => [
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
]

test('Claude Code is the one target: read access to .rness, the rness MCP server, the hooks', () => {
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
          ...hooks(CLONE_START, CLONE_EDIT),
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
      {
        file: '.claude/settings.json',
        at: 'root',
        guarantees: hooks(ROOT_START, ROOT_EDIT),
      },
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
  // The edit hook says nothing and succeeds.
  assert.equal(
    execFileSync('sh', ['-c', CLONE_EDIT], {
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
