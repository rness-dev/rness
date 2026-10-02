import { VERSION } from '../version.ts'
import { pluginFiles } from './claude-skills.ts'
import { PINNED_BIN } from './delegate.ts'
import type { PackageManager } from './pm.ts'

/**
 * A value a target guarantees in a JSON file it shares with the team (spec
 * 0011 §3.4): the list at `path` contains `contains` — a string, or an object
 * compared deeply (spec 0015 §2.3) — or the key at `path` is present, set to
 * `value` when missing, never replaced (spec 0014 §3). rness owns the value,
 * never the file. `label` names an object entry in messages.
 */
export type Guarantee =
  | { path: readonly string[]; contains: unknown; label?: string }
  | { path: readonly string[]; value: unknown }

/**
 * One file of a target: relative to the root of each clone, or to the
 * workspace root, once (spec 0015 §2.1). rness either guarantees values in
 * it — the team's file — or owns it whole, byte for byte (spec 0016 §3.2).
 */
export type TargetFile = {
  file: string
  at: 'clones' | 'root'
} & (
  | { guarantees: readonly Guarantee[] }
  | { content: string }
  /** A file a former rness wrote whole and this one no longer does: removed when present. */
  | { retired: true }
)

/** What a target's files depend on in one workspace (spec 0019 §5). */
export interface TargetContext {
  /** The manager `.rness` installs with. */
  packageManager: PackageManager
}

/** What rness compiles for one agent, in each repository of the workspace. */
export interface AgentTarget {
  /** As `agents` in rness.json names it. */
  name: string
  /** As the question offers it. */
  label: string
  /** Its files in a workspace. Their paths never depend on the context. */
  files: (ctx: TargetContext) => readonly TargetFile[]
}

export type HookEvent = 'session-start' | 'post-tool-use' | 'session-end'

/**
 * The line Claude Code runs for a hook (spec 0015 §2.2), `rness` being the
 * path of `.rness` from the project directory: the pinned copy when it is
 * installed; else, at session start, a line saying why the context is not
 * loaded — there is no rness to say it. Fixed across versions: the entry is
 * compared as a whole, so a changed line would be appended next to the old
 * one and run twice (§2.3). What the hook does changes in `rness hook`.
 */
export function hookLine(rness: string, event: HookEvent): string {
  const run = `f="$CLAUDE_PROJECT_DIR/${rness}/${PINNED_BIN}"; if [ -f "$f" ]; then node "$f" hook ${event};`
  if (event !== 'session-start') return `${run} fi`
  const missing = JSON.stringify({
    systemMessage: `rness: ${rness} is not installed, so the workspace context is not loaded. Clone the workspace, then install its dependencies in .rness.`,
  })
  return `${run} else echo '${missing}'; fi`
}

/** The three hook entries, for a project directory reaching `.rness` at `rness`. */
function hooks(rness: string): Guarantee[] {
  return [
    {
      path: ['hooks', 'SessionStart'],
      contains: {
        hooks: [
          {
            type: 'command',
            command: hookLine(rness, 'session-start'),
            timeout: 10,
          },
        ],
      },
      label: 'the rness session-start hook',
    },
    {
      path: ['hooks', 'PostToolUse'],
      contains: {
        matcher: 'Edit|Write',
        hooks: [
          {
            type: 'command',
            command: hookLine(rness, 'post-tool-use'),
            timeout: 10,
          },
        ],
      },
      label: 'the rness post-tool-use hook',
    },
    {
      path: ['hooks', 'SessionEnd'],
      contains: {
        hooks: [
          {
            type: 'command',
            command: hookLine(rness, 'session-end'),
            timeout: 10,
          },
        ],
      },
      label: 'the rness session-end hook',
    },
  ]
}

/**
 * The agents this version can compile for (spec 0011 §4, tier 1). Any other
 * agent that reads `AGENTS.md` works with the block alone.
 */
export const TARGETS: Readonly<Record<string, AgentTarget>> = {
  claude: {
    name: 'claude',
    label: 'Claude Code',
    files: (ctx) => [
      {
        file: '.claude/settings.json',
        at: 'clones',
        guarantees: [
          // Read the context repository from a repository without a prompt.
          // Resolved against the project directory, and applied once Claude
          // Code has trusted it (verified on 2.1.284, spec 0011 §7).
          {
            path: ['permissions', 'additionalDirectories'],
            contains: '../../.rness',
          },
          ...hooks('../../.rness'),
        ],
      },
      {
        file: '.mcp.json',
        at: 'clones',
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
      ...pluginFiles('../../.rness', 'clones', ctx),
      // A session opened at the workspace root reads this file, one opened
      // in a clone does not (spec 0011 §1): the hooks only, `.rness` inside.
      {
        file: '.claude/settings.json',
        at: 'root',
        guarantees: hooks('.rness'),
      },
      ...pluginFiles('.rness', 'root', ctx),
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
