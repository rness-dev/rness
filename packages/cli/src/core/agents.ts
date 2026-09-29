import { VERSION } from '../version.ts'

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
} & ({ guarantees: readonly Guarantee[] } | { content: string })

/** What rness compiles for one agent, in each repository of the workspace. */
export interface AgentTarget {
  /** As `agents` in rness.json names it. */
  name: string
  /** As the question offers it. */
  label: string
  files: readonly TargetFile[]
}

/** The pinned copy's launcher, inside `.rness`. */
const PINNED_BIN = 'node_modules/@rness/cli/dist/bin/rness.js'

export type HookEvent = 'session-start' | 'post-tool-use'

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
  if (event === 'post-tool-use') return `${run} fi`
  const missing = JSON.stringify({
    systemMessage: `rness: ${rness} is not installed, so the workspace context is not loaded. Clone the workspace, then install its dependencies in .rness.`,
  })
  return `${run} else echo '${missing}'; fi`
}

/** The two hook entries, for a project directory reaching `.rness` at `rness`. */
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
  ]
}

/** The Claude Code plugin rness writes, whole: `/rness:status` (spec 0016 §3). */
const PLUGIN = '.claude/skills/rness'

const PLUGIN_JSON = `${JSON.stringify(
  {
    name: 'rness',
    description: 'The rness workspace in Claude Code: /rness:status.',
  },
  null,
  2
)}\n`

/**
 * The `status` skill, `rness` being the path of `.rness` from the project
 * directory. One fixed command — the arguments never reach a shell — named
 * exactly in `allowed-tools`, so it runs without a prompt. Nothing in it
 * depends on the version: an upgrade rewrites nothing.
 */
function statusSkill(rness: string): string {
  const command = `node "\${CLAUDE_PROJECT_DIR}/${rness}/${PINNED_BIN}" status --cwd "\${CLAUDE_PROJECT_DIR}"`
  return `---
name: status
description: The status of every decision, specification, plan and other tracked document of the rness workspace, one table per directory. Read-only.
argument-hint: '[tab]'
disable-model-invocation: true
allowed-tools: Bash(${command})
---

!\`${command}\`

Show the output above to the user as it is: the heading and the tables,
nothing added, nothing summarised, no other tool. Arguments: \`$ARGUMENTS\`.
When they name a tab, show only that tab's section. If the output says the
module cannot be found, say instead that ${rness} is not installed next to
this repository.

End with this line: _For the view with tabs and scrolling: Ctrl+Z, then
\`npx @rness/cli status\` (q to close), then \`fg\`._
`
}

function plugin(rness: string, at: TargetFile['at']): TargetFile[] {
  return [
    { file: `${PLUGIN}/.claude-plugin/plugin.json`, at, content: PLUGIN_JSON },
    {
      file: `${PLUGIN}/skills/status/SKILL.md`,
      at,
      content: statusSkill(rness),
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
    files: [
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
      ...plugin('../../.rness', 'clones'),
      // A session opened at the workspace root reads this file, one opened
      // in a clone does not (spec 0011 §1): the hooks only, `.rness` inside.
      {
        file: '.claude/settings.json',
        at: 'root',
        guarantees: hooks('.rness'),
      },
      ...plugin('.rness', 'root'),
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
