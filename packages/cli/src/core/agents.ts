import { VERSION } from '../version.ts'

/**
 * A value a target guarantees in a JSON file it shares with the team: the
 * list at `path` contains `contains` (spec 0011 §3.4). rness owns the value,
 * never the file.
 */
export interface Guarantee {
  path: readonly string[]
  contains: string
}

/** What rness compiles for one agent, in each repository of the workspace. */
export interface AgentTarget {
  /** As `agents` in rness.json names it. */
  name: string
  /** As the question offers it. */
  label: string
  /** Relative to the repository root. */
  file: string
  guarantees: readonly Guarantee[]
}

/**
 * The agents this version can compile for (spec 0011 §4, tier 1). Any other
 * agent that reads `AGENTS.md` works with the block alone.
 */
export const TARGETS: Readonly<Record<string, AgentTarget>> = {
  claude: {
    name: 'claude',
    label: 'Claude Code',
    file: '.claude/settings.json',
    // Read the context repository from a repository without a prompt. The
    // path is resolved against the project directory, and only once Claude
    // Code has trusted it (verified on 2.1.284, spec 0011 §7).
    guarantees: [
      {
        path: ['permissions', 'additionalDirectories'],
        contains: '../../.rness',
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
