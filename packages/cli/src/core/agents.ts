import { VERSION } from '../version.ts'

/**
 * A value a target guarantees in a JSON file it shares with the team (spec
 * 0011 §3.4): the list at `path` contains `contains`, or the key at `path`
 * is present — set to `value` when missing, never replaced (spec 0014 §3).
 * rness owns the value, never the file.
 */
export type Guarantee =
  | { path: readonly string[]; contains: string }
  | { path: readonly string[]; value: unknown }

/** One file of a target, relative to the repository root, and what it guarantees there. */
export interface TargetFile {
  file: string
  guarantees: readonly Guarantee[]
}

/** What rness compiles for one agent, in each repository of the workspace. */
export interface AgentTarget {
  /** As `agents` in rness.json names it. */
  name: string
  /** As the question offers it. */
  label: string
  files: readonly TargetFile[]
}

/**
 * The agents this version can compile for (spec 0011 §4, tier 1). Any other
 * agent that reads `AGENTS.md` works with the block alone.
 */
export const TARGETS: Readonly<Record<string, AgentTarget>> = {
  claude: {
    name: 'claude',
    label: 'Claude Code',
    files: [
      {
        file: '.claude/settings.json',
        guarantees: [
          // Read the context repository from a repository without a prompt.
          // Resolved against the project directory, and applied once Claude
          // Code has trusted it (verified on 2.1.284, spec 0011 §7).
          {
            path: ['permissions', 'additionalDirectories'],
            contains: '../../.rness',
          },
        ],
      },
      {
        file: '.mcp.json',
        guarantees: [
          // The pinned copy, by a path relative to the repository — the
          // directory Claude Code starts the server in (spec 0014 §6). Not
          // pre-approved in settings: each developer approves it once, since
          // a repository approving its own command would run any change to
          // it unasked (spec 0014 §3, 0.9.1).
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
  },
}

export const SUPPORTED_AGENTS: readonly string[] = Object.keys(TARGETS)

/** The names this version has no target for, in their order. */
export function unsupportedAgents(names: readonly string[]): string[] {
  return names.filter((n) => !Object.hasOwn(TARGETS, n))
}

export function unsupportedMessage(name: string): string {
  return `rness.json: agent "${name}" is not supported by @rness/cli ${VERSION} (supported: ${SUPPORTED_AGENTS.join(', ')})`
}
