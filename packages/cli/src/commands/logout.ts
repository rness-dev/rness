import { clearAuth, readAuth } from '../core/auth.ts'
import { httpsOrigin, revokeUrl } from '../core/hosts.ts'
import { removeGitSetup } from '../core/setup-git.ts'
import { status } from '../core/style.ts'
import { reportError } from '../report.ts'
import { chooseHost } from './login.ts'

export interface LogoutOptions {
  /** `--provider`: which login to forget; else the workspace's provider, else GitHub. */
  provider?: string
  /** Where to look for the workspace; the current directory by default. */
  cwd?: string
}

/**
 * `rness logout`: forget one host's stored login and undo `setup-git` for
 * that host (spec 0004 §2, §5; spec 0037 §3). The other hosts' are kept.
 */
export async function logoutCommand(opts: LogoutOptions = {}): Promise<number> {
  try {
    const chosen = await chooseHost(opts.provider, opts.cwd ?? process.cwd())
    if ('error' in chosen) {
      process.stderr.write(`${chosen.error}\n`)
      return chosen.code
    }
    const { host } = chosen
    const stored = await readAuth(host)
    await clearAuth(host)
    const undone = await removeGitSetup(host).catch(() => false)
    if (stored === null && !undone) {
      process.stdout.write('not logged in\n')
      return 0
    }
    if (stored !== null)
      process.stdout.write(
        `${status('logged out', `${stored.login} (${host.host})`)}\n`
      )
    if (undone)
      process.stdout.write(
        `${status('updated', `git: rness no longer answers for ${httpsOrigin(host)}`)}\n`
      )
    process.stdout.write(`revoke rness on ${host.label}: ${revokeUrl(host)}\n`)
    return 0
  } catch (e) {
    return reportError(e)
  }
}
