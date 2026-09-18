import { clearAuth, readAuth } from '../core/auth.ts'
import { removeGitSetup } from '../core/setup-git.ts'
import { status } from '../core/style.ts'
import { reportError } from '../report.ts'
import { revokeUrl } from './login.ts'

/** `rness logout`: forget the stored login and undo `setup-git` (spec 0004 §2, §5). */
export async function logoutCommand(): Promise<number> {
  try {
    const stored = await readAuth()
    await clearAuth()
    const undone = await removeGitSetup().catch(() => false)
    if (stored === null && !undone) {
      process.stdout.write('not logged in\n')
      return 0
    }
    if (stored !== null)
      process.stdout.write(
        `${status('logged out', `${stored.login} (github.com)`)}\n`
      )
    if (undone)
      process.stdout.write(
        `${status('updated', 'git: rness no longer answers for https://github.com')}\n`
      )
    process.stdout.write(`revoke rness on GitHub: ${revokeUrl()}\n`)
    return 0
  } catch (e) {
    return reportError(e)
  }
}
