import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

import { readPinnedCli } from './delegate.ts'
import { exists, writeFileAtomic } from './fs.ts'
import {
  type PackageManager,
  installDependencies,
  isPackageManager,
} from './pm.ts'
import { warn } from './style.ts'
import { agentHintLines } from './transport.ts'
import { findWorkspace } from './workspace.ts'

const execFileP = promisify(execFile)

const PACKAGE = '@rness/cli'

/** A released version, pre-releases included; never a range or a tag. */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** Negative when `a` is the older version. A pre-release is older than its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string | null] => {
    const dash = v.indexOf('-')
    const core = dash === -1 ? v : v.slice(0, dash)
    return [core.split('.').map(Number), dash === -1 ? null : v.slice(dash + 1)]
  }
  const [coreA, preA] = split(a)
  const [coreB, preB] = split(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = (coreA[i] ?? 0) - (coreB[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (preA === preB) return 0
  if (preA === null) return 1
  if (preB === null) return -1
  return preA.localeCompare(preB, 'en', { numeric: true })
}

export interface Pin {
  /** What `package.json` says: an exact version in a workspace rness created. */
  spec: string
  field: 'devDependencies' | 'dependencies'
}

async function readPackageJson(
  rnessDir: string
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(rnessDir, 'package.json'), 'utf8')
    )
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The `@rness/cli` entry of `.rness/package.json` — the one place the version is written (spec 0006). */
export async function readPin(rnessDir: string): Promise<Pin | null> {
  const pkg = await readPackageJson(rnessDir)
  if (pkg === null) return null
  for (const field of ['devDependencies', 'dependencies'] as const) {
    const deps = pkg[field]
    if (deps === null || typeof deps !== 'object') continue
    const spec = (deps as Record<string, unknown>)[PACKAGE]
    if (typeof spec === 'string') return { spec, field }
  }
  return null
}

/**
 * Replace the pinned version in place: every other byte of `package.json` —
 * its indentation, its inline objects, its key order — is the user's.
 */
export async function writePin(
  rnessDir: string,
  from: string,
  to: string
): Promise<void> {
  const file = join(rnessDir, 'package.json')
  const text = await readFile(file, 'utf8')
  const entry = new RegExp(
    `("${PACKAGE}"\\s*:\\s*")${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(")`
  )
  if (!entry.test(text))
    throw new Error(`"${PACKAGE}": "${from}" not found in package.json`)
  await writeFileAtomic(file, text.replace(entry, `$1${to}$2`))
}

const LOCKFILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

/** The package manager a workspace installs with: `packageManager`, else its lockfile, else npm. */
export async function workspacePackageManager(
  rnessDir: string
): Promise<PackageManager> {
  const declared = (await readPackageJson(rnessDir))?.['packageManager']
  if (typeof declared === 'string') {
    const name = declared.split('@')[0] ?? ''
    if (isPackageManager(name)) return name
  }
  for (const [lockfile, pm] of LOCKFILES)
    if (await exists(join(rnessDir, lockfile))) return pm
  return 'npm'
}

/**
 * Whether the workspace carries a lockfile **this** manager can install from.
 * A frozen install is per-manager: `npm ci` needs `package-lock.json` and
 * fails outright next to a `pnpm-lock.yaml`, which is the common case when the
 * manager running `create` is not the one the workspace declares.
 */
export async function hasLockfile(
  rnessDir: string,
  pm: PackageManager
): Promise<boolean> {
  for (const [lockfile, owner] of LOCKFILES)
    if (owner === pm && (await exists(join(rnessDir, lockfile)))) return true
  return false
}

/**
 * An exact pin that is not the installed copy: someone pulled an upgrade and
 * did not reinstall, or never installed. Null when they agree, and when the
 * pin is a range — it says nothing precise about what should be installed.
 */
export async function pinDrift(
  rnessDir: string
): Promise<{ pin: string; installed: string | null } | null> {
  const pin = await readPin(rnessDir)
  if (pin === null || !EXACT_VERSION.test(pin.spec)) return null
  const installed = (await readPinnedCli(rnessDir))?.version ?? null
  return installed === pin.spec ? null : { pin: pin.spec, installed }
}

/**
 * The line the launcher prints when the workspace around `cwd` pins one
 * version and holds another (spec 0006 §4): the teammate who pulled an
 * upgrade and did not reinstall. Null outside a workspace, and without drift.
 */
export async function driftWarning(cwd: string): Promise<string | null> {
  let root: string
  let rnessDir: string
  try {
    const ws = await findWorkspace(cwd)
    root = ws.root
    rnessDir = ws.rnessDir
  } catch {
    return null
  }
  const drift = await pinDrift(rnessDir)
  if (drift === null) return null
  const pm = await workspacePackageManager(rnessDir)
  return warn(
    `${basename(root)}/.rness pins @rness/cli ${drift.pin} but ${drift.installed ?? 'nothing'} is installed — run ${pm} install in .rness`
  )
}

/** A delegated child is killed after this long without finishing (spec 0008 §5). */
export const CHILD_DEADLINE_MS = 120_000

/**
 * The environment of a delegated child. Its output is piped and the parent
 * owns the terminal, so a prompt from `ssh` or from git's credential helper is
 * invisible and blocks forever. `GIT_SSH_COMMAND` is composed, not replaced:
 * a user's own agent command (1Password, a named key) must survive.
 */
export function childEnv(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...env,
    GIT_SSH_COMMAND: `${env['GIT_SSH_COMMAND'] ?? 'ssh'} -o BatchMode=yes`,
    GIT_TERMINAL_PROMPT: '0',
  }
}

export interface InstallOutcome {
  installed: boolean
  pin: string
  /** Why it did not install; null when it did. */
  reason: string | null
}

export interface EnsureOptions {
  env?: NodeJS.ProcessEnv
  announce?: (pin: string) => void
  install?: (
    pm: PackageManager,
    dir: string,
    opts: { frozen: boolean }
  ) => Promise<void>
}

/**
 * Bring `.rness/node_modules` back to the pin (spec 0008 §4). The version was
 * decided by the pull request that moved the pin, so this asks nothing. Null
 * when there is no drift. A failure is reported, never thrown: the caller
 * falls back to the warning and runs the command anyway.
 */
export async function ensureInstalled(
  rnessDir: string,
  opts: EnsureOptions = {}
): Promise<InstallOutcome | null> {
  const drift = await pinDrift(rnessDir)
  if (drift === null) return null
  const env = opts.env ?? process.env
  if (env['RNESS_NO_INSTALL'] === '1')
    return { installed: false, pin: drift.pin, reason: 'RNESS_NO_INSTALL=1' }
  const pm = await workspacePackageManager(rnessDir)
  const frozen = await hasLockfile(rnessDir, pm)
  const install = opts.install ?? installDependencies
  opts.announce?.(drift.pin)
  try {
    await install(pm, rnessDir, { frozen })
    return { installed: true, pin: drift.pin, reason: null }
  } catch (e) {
    return {
      installed: false,
      pin: drift.pin,
      reason: e instanceof Error ? e.message : String(e),
    }
  }
}

export interface PinnedSyncResult {
  code: number
  stdout: string
  stderr: string
}

/** `sync --yes` through the installed copy, its output kept. Null when nothing is installed. */
export async function runPinnedSync(
  root: string
): Promise<PinnedSyncResult | null> {
  const installed = await readPinnedCli(join(root, '.rness'))
  if (installed === null) return null
  const pinned = join(installed.dir, ...installed.bin.split('/'))
  if (!(await exists(pinned)))
    return {
      code: 1,
      stdout: '',
      stderr: `@rness/cli in .rness is not installed correctly (missing ${installed.bin}); reinstall in .rness/\n`,
    }
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [pinned, 'sync', '--yes'],
      {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
        env: childEnv(),
        timeout: CHILD_DEADLINE_MS,
        killSignal: 'SIGKILL',
      }
    )
    return { code: 0, stdout, stderr }
  } catch (e) {
    const err = e as {
      code?: number
      killed?: boolean
      stdout?: string
      stderr?: string
    }
    const deadline =
      err.killed === true
        ? `rness sync in .rness did not finish within ${CHILD_DEADLINE_MS / 1000}s and was stopped\n`
        : ''
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: `${err.stderr ?? ''}${deadline}`,
    }
  }
}

/**
 * What a sync printed, in one line: `3 blocks: 2 updated, 1 unchanged`. The
 * lines that are not about a block (`not cloned: …`) are returned as they are.
 */
export function summariseSync(stdout: string): {
  summary: string
  others: string[]
} {
  const counts = new Map<string, number>()
  const others: string[] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const verb = /^(updated|unchanged|stale)\s/.exec(line)?.[1]
    if (verb === undefined) others.push(line)
    else counts.set(verb, (counts.get(verb) ?? 0) + 1)
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  const detail = [...counts].map(([verb, n]) => `${n} ${verb}`).join(', ')
  return {
    summary: `${total} block${total === 1 ? '' : 's'}${detail === '' ? '' : `: ${detail}`}`,
    others,
  }
}

/**
 * What the parent makes of a delegated sync (spec 0008 §2.1). A pinned copy
 * older than 0.5.0 clones catalogue repositories nobody picked and exits 1 when
 * one fails; it cannot be made to exit 0, so the blocks decide. One block line
 * on stdout means the sync did its job: what the child wrote to stderr is then
 * context, not the command's outcome.
 */
export function syncOutcome(
  result: PinnedSyncResult,
  opts: { sshWorks?: boolean } = {}
): { code: number; hints: string[]; errors: string[] } {
  const { others } = summariseSync(result.stdout)
  const wrote = /^(updated|unchanged|stale)\s/m.test(result.stdout)
  const stderr = result.stderr
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
  const hints = wrote ? [...others, ...stderr] : others
  if (
    opts.sshWorks === true &&
    /Permission denied \(publickey\)/.test(result.stderr)
  )
    hints.push(...agentHintLines())
  return {
    code: wrote ? 0 : result.code,
    hints,
    errors: wrote ? [] : stderr,
  }
}

/**
 * Run `sync --yes` through the copy installed in `.rness/`. With nothing
 * installed, `fallback` runs instead (`create --skip-install`); without a
 * fallback that is an error, never the caller's own code standing in for the
 * pinned copy (spec 0003 §2.2).
 */
export async function syncPinned(
  root: string,
  shown: string,
  fallback?: () => Promise<number>
): Promise<number> {
  const rnessDir = join(root, '.rness')
  const installed = await readPinnedCli(rnessDir)
  if (installed === null) {
    if (fallback !== undefined) return fallback()
    process.stderr.write(
      `@rness/cli is not installed in ${shown}/.rness; install in .rness/, then rness sync\n`
    )
    return 1
  }
  const pinned = join(installed.dir, ...installed.bin.split('/'))
  if (!(await exists(pinned))) {
    process.stderr.write(
      `@rness/cli in ${shown}/.rness is not installed correctly (missing ${installed.bin}); reinstall in .rness/\n`
    )
    return 1
  }
  try {
    const { stdout, stderr } = await execFileP(
      process.execPath,
      [pinned, 'sync', '--yes'],
      {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
        env: childEnv(),
        timeout: CHILD_DEADLINE_MS,
        killSignal: 'SIGKILL',
      }
    )
    process.stdout.write(stdout)
    if (stderr !== '') process.stderr.write(stderr)
    return 0
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    if (err.stdout !== undefined && err.stdout !== '')
      process.stdout.write(err.stdout)
    if (err.stderr !== undefined && err.stderr !== '')
      process.stderr.write(err.stderr)
    return typeof err.code === 'number' ? err.code : 1
  }
}
