import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

// Making rness git's credential helper for github.com (spec 0004 §5): what
// `gh auth setup-git` does for gh. Two values under one key — an empty one,
// which clears the helpers inherited from the system (osxkeychain would
// otherwise answer first), then rness, by absolute path so git finds it
// whatever PATH it runs with.

const KEY = 'credential.https://github.com.helper'

export function helperValue(node: string, bin: string): string {
  return `!'${node}' '${bin}' git-credential`
}

// The shape `helperValue` writes — not gh's `!gh auth git-credential`, nor
// anyone else's helper that happens to end the same way.
const isOurs = (value: string): boolean =>
  /^!'[^']+' '[^']*rness[^']*' git-credential$/.test(value)

async function config(args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', ['config', '--global', ...args])
  return stdout
}

async function values(): Promise<string[]> {
  try {
    const out = await config(['--get-all', KEY])
    return out.replace(/\n$/, '').split('\n')
  } catch {
    return [] // the key is not set
  }
}

/** A copy run through npx lives in a cache that is cleared: not a path to give git. */
export function isStableInstall(bin: string): boolean {
  return !/[\\/]_npx[\\/]/.test(bin)
}

/** Register rness for github.com. False when it already was. */
export async function setupGit(node: string, bin: string): Promise<boolean> {
  const ours = helperValue(node, bin)
  if ((await values()).includes(ours)) return false
  // A stale rness entry (another install path) goes first.
  await removeGitSetup()
  await config(['--add', KEY, ''])
  await config(['--add', KEY, ours])
  return true
}

/**
 * Remove exactly what `setupGit` wrote: rness's entry and the empty one in
 * front of it. A helper someone else registered is left as it was. False
 * when there was nothing of rness's.
 */
export async function removeGitSetup(): Promise<boolean> {
  const current = await values()
  if (!current.some(isOurs)) return false
  const kept = current.filter(
    (value, i) =>
      !isOurs(value) && !(value === '' && isOurs(current[i + 1] ?? ''))
  )
  await config(['--unset-all', KEY])
  for (const value of kept) await config(['--add', KEY, value])
  return true
}
