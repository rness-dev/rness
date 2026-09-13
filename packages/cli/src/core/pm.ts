import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
export const PACKAGE_MANAGERS: readonly PackageManager[] = [
  'npm',
  'pnpm',
  'yarn',
  'bun',
]

export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value)
}

/** The manager that launched us (`npm_config_user_agent`: `pnpm/12.2.1 npm/? node/…`), else npm. */
export function detectPackageManager(
  userAgent: string = process.env['npm_config_user_agent'] ?? ''
): PackageManager {
  const name = userAgent.split('/')[0] ?? ''
  return isPackageManager(name) ? name : 'npm'
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? 'unknown error'
  )
}

export async function packageManagerVersion(
  pm: PackageManager
): Promise<string> {
  try {
    const { stdout } = await execFileP(pm, ['--version'])
    return stdout.trim()
  } catch (e) {
    throw new Error(`${pm} is not available on PATH`, { cause: e })
  }
}

/** `<pm> install` in `dir`; output is swallowed, failure is one line. */
export async function installDependencies(
  pm: PackageManager,
  dir: string
): Promise<void> {
  try {
    await execFileP(pm, ['install'], { cwd: dir, maxBuffer: 16 * 1024 * 1024 })
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new Error(
      `${pm} install failed in ${dir}: ${firstLine(err.stderr ?? err.message)}`,
      { cause: e }
    )
  }
}
