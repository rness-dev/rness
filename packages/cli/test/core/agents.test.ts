import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SUPPORTED_AGENTS,
  TARGETS,
  unsupportedAgents,
  unsupportedMessage,
} from '../../src/core/agents.ts'
import { VERSION } from '../../src/version.ts'

test('Claude Code is the one target: read access to .rness, and the rness MCP server', () => {
  assert.deepEqual(SUPPORTED_AGENTS, ['claude'])
  assert.deepEqual(TARGETS['claude'], {
    name: 'claude',
    label: 'Claude Code',
    files: [
      {
        file: '.claude/settings.json',
        guarantees: [
          {
            path: ['permissions', 'additionalDirectories'],
            contains: '../../.rness',
          },
        ],
      },
      {
        file: '.mcp.json',
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
    ],
  })
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
