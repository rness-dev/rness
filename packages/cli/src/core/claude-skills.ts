import type { TargetContext, TargetFile } from './agents.ts'
import { PINNED_BIN } from './delegate.ts'
import { type PackageManager, localRunner } from './pm.ts'

/** The Claude Code plugin rness writes, whole (spec 0016 §3, 0019 §2). */
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
 * depends on the version; only its last line depends on the workspace's
 * package manager (spec 0019 §5), so an upgrade rewrites it only when that
 * text changes.
 */
function statusSkill(rness: string, pm: PackageManager): string {
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

End with this line: _For the view with tabs and scrolling: here, Ctrl+Z,
then \`npx @rness/cli status\` (q to close), then \`fg\`; or in another
terminal, from the workspace's \`.rness/\`: \`${localRunner(pm)} rness status\`._
`
}

/** The plugin's files, for a project directory reaching `.rness` at `rness`. */
export function pluginFiles(
  rness: string,
  at: TargetFile['at'],
  ctx: TargetContext
): TargetFile[] {
  return [
    { file: `${PLUGIN}/.claude-plugin/plugin.json`, at, content: PLUGIN_JSON },
    {
      file: `${PLUGIN}/skills/status/SKILL.md`,
      at,
      content: statusSkill(rness, ctx.packageManager),
    },
  ]
}
