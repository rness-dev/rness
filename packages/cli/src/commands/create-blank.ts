import { mkdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

import {
  buildContext,
  commitContext,
  targetProblem,
} from '../core/new-workspace.ts'
import type { PackageManager } from '../core/pm.ts'
import { syncBlocks } from '../core/sync-blocks.ts'
import type { Prompts } from '../core/terminal.ts'
import type { Ui } from '../core/ui.ts'
import { syncCommand } from './sync.ts'

/**
 * A blank workspace's directory name: one path segment of letters, digits,
 * `.`, `_` and `-`, not `.` or `..`, no leading `-`. Case is kept: it names a
 * local directory, not a GitHub account.
 */
export const WORKSPACE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._][A-Za-z0-9._-]*$/

export function workspaceNameError(name: string): string {
  return `workspace name "${name}" may only contain letters, digits, '.', '_' and '-', not starting with '-'`
}

/**
 * `rness create --blank`: a workspace with no GitHub organization
 * (spec 0012) — `.rness/` scaffolded with a `rness.json` without `org`, an
 * empty `org/`, the root `AGENTS.md` and `CLAUDE.md`. No login, SSH test,
 * probe or listing: the install of `.rness/` is the only network access.
 * Every prompt comes before the first write.
 */
export async function createBlank(input: {
  /** Already checked against `WORKSPACE_NAME`; prompted for when absent. */
  name: string | undefined
  cwd: string
  pm: PackageManager
  /** A wizard in a terminal: questions may be asked. */
  interactive: boolean
  /** `--yes`, or a terminal: allowed to write. */
  mayWrite: boolean
  skipInstall: boolean
  ui: Ui
  prompts: () => Promise<Prompts>
}): Promise<number> {
  const { cwd, pm, ui } = input
  let name = input.name
  let prompted = false
  if (name === undefined) {
    if (!input.interactive) {
      process.stderr.write(
        'rness create --blank needs a <name> without a prompt\n'
      )
      return 2
    }
    const p = await input.prompts()
    const answer = await p.text({
      message: 'What should the workspace be called?',
      placeholder: 'my-workspace',
      validate: (value) => {
        const v = value?.trim() ?? ''
        return WORKSPACE_NAME.test(v) ? undefined : workspaceNameError(v)
      },
    })
    if (p.isCancel(answer) || typeof answer !== 'string') {
      ui.cancelled()
      return 0
    }
    name = answer.trim()
    prompted = true
  }

  const root = resolve(cwd, name)
  const shown = relative(cwd, root) || '.'
  const problem = await targetProblem(cwd, root, pm)
  if (problem !== null) {
    process.stderr.write(`${problem}\n`)
    return 1
  }
  if (!input.mayWrite) {
    process.stderr.write(
      'rness create writes files; pass --yes to run without a prompt\n'
    )
    return 2
  }
  if (input.interactive && !prompted) {
    const p = await input.prompts()
    const ok = await p.confirm({
      message: `Create blank workspace ${name} in ./${shown}?`,
    })
    if (p.isCancel(ok) || ok !== true) {
      ui.cancelled()
      return 0
    }
  }

  const built = await buildContext({
    ui,
    root,
    shown,
    manifest: { contract: 1, org: null, repos: {}, scopes: {} },
    pm,
    skipInstall: input.skipInstall,
    kind: 'blank workspace',
  })
  if (!built) return 1
  await mkdir(join(root, 'org'), { recursive: true })
  await commitContext({ ui, rnessDir: join(root, '.rness'), shown })
  const code = await syncBlocks(ui, root, shown, () =>
    syncCommand({ yes: true, cwd: root })
  )
  if (code !== 0) return code

  // No organization to publish to: say how to bring repositories in, and how
  // the workspace becomes an organization's once there is one.
  const next = [
    `cd ${shown}`,
    '# bring a repository in: <owner>/<repo> on GitHub, or any git URL',
    'rness add <owner>/<repo>',
    '# to share it: set "org" in .rness/rness.json, then push .rness to github.com/<org>/.rness',
  ]
  if (ui.session) {
    ui.note('Next steps', next)
    ui.outro(`Workspace ${name} is ready in ${shown}/`)
  } else
    process.stdout.write(
      [
        '',
        `Workspace \`${name}\` is ready in ${shown}/.`,
        '',
        'Next:',
        ...next.map((line) => `  ${line}`),
        '',
      ].join('\n')
    )
  return 0
}
