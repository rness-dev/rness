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

/**
 * The rness CLI run through `pm`, without a global install: what the next
 * steps of `create` are written with, so they work on the machine that ran it.
 * Inside a workspace the fetched copy hands over to the pinned one. Yarn 1 has
 * no `dlx`, and an unknown yarn may be one: npx comes with Node.
 */
export function rnessRunner(
  pm: PackageManager,
  version: string | null
): string {
  if (pm === 'pnpm') return 'pnpm dlx @rness/cli'
  if (pm === 'bun') return 'bunx @rness/cli'
  if (pm === 'yarn' && Number(version?.split('.')[0]) >= 2)
    return 'yarn dlx @rness/cli'
  return 'npx @rness/cli'
}

/** `rnessRunner` for the installed `pm`; only yarn needs its version asked. */
export async function rnessRunnerFor(pm: PackageManager): Promise<string> {
  const version =
    pm === 'yarn' ? await packageManagerVersion(pm).catch(() => null) : null
  return rnessRunner(pm, version)
}

const BARE_NPM_CODE = /^npm (error|ERR!) code \S+$/

/**
 * The line of a failed install worth showing. npm leads with its error code
 * (`npm error code ETARGET`) and says what is wrong on the next line
 * (`…No matching version found for @rness/cli@0.4.0.`): that one is kept. The
 * code is shown only when nothing follows it.
 */
export function installErrorLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
  return lines.find((l) => !BARE_NPM_CODE.test(l)) ?? firstLine(stderr)
}

const FROZEN: Record<PackageManager, readonly string[]> = {
  npm: ['ci'],
  pnpm: ['install', '--frozen-lockfile'],
  yarn: ['install', '--immutable'],
  bun: ['install', '--frozen-lockfile'],
}

/** The install that refuses to touch a committed lockfile (spec 0008 §4). */
export function frozenArgs(pm: PackageManager): string[] {
  return [...FROZEN[pm]]
}

/** `<pm> install` in `dir`; output is swallowed, failure is one line. */
export async function installDependencies(
  pm: PackageManager,
  dir: string,
  opts: { frozen?: boolean } = {}
): Promise<void> {
  const args = opts.frozen === true ? frozenArgs(pm) : ['install']
  try {
    await execFileP(pm, args, { cwd: dir, maxBuffer: 16 * 1024 * 1024 })
  } catch (e) {
    const err = e as { stderr?: string; message: string }
    throw new Error(
      `${pm} ${args.join(' ')} failed in ${dir}: ${installErrorLine(err.stderr ?? err.message)}`,
      { cause: e }
    )
  }
}
