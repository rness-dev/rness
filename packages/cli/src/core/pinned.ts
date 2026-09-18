import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { readPinnedCli } from './delegate.ts'
import { exists, writeFileAtomic } from './fs.ts'
import { type PackageManager, isPackageManager } from './pm.ts'

const execFileP = promisify(execFile)

const PACKAGE = '@rness/cli'

/** A released version, pre-releases included; never a range or a tag. */
export const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

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
      { cwd: root, maxBuffer: 16 * 1024 * 1024 }
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
