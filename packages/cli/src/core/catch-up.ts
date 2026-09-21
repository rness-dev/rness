import { spawnSync } from 'node:child_process'

import { pinnedBinPath } from './delegate.ts'
import {
  type EnsureOptions,
  driftWarning,
  ensureInstalled,
  pinDrift,
} from './pinned.ts'
import { findWorkspace } from './workspace.ts'

/**
 * `create` makes a workspace and `upgrade` replaces the pinned copy: both are
 * served by the copy the user invoked (spec 0006 §3). The login concerns the
 * machine, not a workspace — and git runs `git-credential` from inside a
 * clone, on every fetch: no delegation, no install and no warning there.
 */
export const OWN_COMMANDS: readonly string[] = [
  'create',
  'upgrade',
  'update',
  'login',
  'logout',
  'git-credential',
]

/**
 * Set in the environment once an invocation has looked at the drift. Two
 * copies can look in one invocation — the launcher, then the installed copy it
 * delegates to — and they are different modules, in one process or in a child:
 * the environment is the only state they share. Private, not a user setting.
 */
export const CATCH_UP_DONE = 'RNESS_CATCH_UP_DONE'

export interface CatchUpDeps {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stderr?: (text: string) => void
  install?: EnsureOptions['install']
  /** Run the installed bin with the user's arguments; its exit code. */
  spawn?: (bin: string, argv: string[], cwd: string) => number
}

/**
 * Close the gap between the pin and what is installed, then hand the command
 * to the freshly installed copy (spec 0008 §4). Returns that copy's exit code,
 * or null when the caller should run the command itself: no workspace, no
 * drift, nothing to do for this command, or an install that did not close the
 * drift (reported as a warning).
 *
 * It runs in two places. The launcher calls it before delegating. The
 * package's exported `run` calls it too, because a launcher older than 0.5.1
 * never does: it imports the installed copy's `run` and knows nothing about
 * drift. Everything on this path is imported statically — after the install,
 * the tree this module was loaded from may be gone.
 */
export async function catchUp(
  argv: string[],
  deps: CatchUpDeps = {}
): Promise<number | null> {
  const env = deps.env ?? process.env
  const cwd = deps.cwd ?? process.cwd()
  const command = argv[0]
  if (
    command === undefined ||
    command.startsWith('-') ||
    OWN_COMMANDS.includes(command) ||
    env['RNESS_NO_DELEGATE'] === '1' ||
    env[CATCH_UP_DONE] === '1'
  )
    return null
  const ws = await findWorkspace(cwd).catch(() => null)
  if (ws === null) return null
  env[CATCH_UP_DONE] = '1'

  const stderr = deps.stderr ?? ((text) => void process.stderr.write(text))
  // The version was decided by the pull request that moved the pin, so
  // catching up asks nothing.
  const outcome = await ensureInstalled(ws.rnessDir, {
    env,
    announce: (pin) => stderr(`installing @rness/cli ${pin} in .rness…\n`),
    ...(deps.install === undefined ? {} : { install: deps.install }),
  })
  if (outcome === null) return null
  if (!outcome.installed) {
    const warning = await driftWarning(cwd)
    if (warning !== null) stderr(`${warning}\n`)
    return null
  }
  // Only hand off when the install actually closed the drift: a child that
  // would install again on every run must never be spawned.
  if ((await pinDrift(ws.rnessDir)) !== null) return null
  const bin = await pinnedBinPath(ws.rnessDir)
  if (bin === null) return null
  // The pinned tree was just rebuilt: importing out of it in this process is
  // fragile, so the freshly installed copy runs as its own process.
  const spawn =
    deps.spawn ??
    ((file, args, dir) =>
      spawnSync(process.execPath, [file, ...args], {
        cwd: dir,
        env,
        stdio: 'inherit',
      }).status ?? 1)
  return spawn(bin, argv, cwd)
}
