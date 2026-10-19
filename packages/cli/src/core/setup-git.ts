import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { HOSTS, type HostSpec, httpsOrigin } from './hosts.ts'

const execFileP = promisify(execFile)

// Making rness git's credential helper for a host (spec 0004 §5, spec 0037
// §3): what `gh auth setup-git` does for gh. Two values under the host's key:
// an empty one, which clears the helpers inherited from the system
// (osxkeychain would otherwise answer first), then rness, by absolute path so
// git finds it whatever PATH it runs with. One block per host.

const keyOf = (host: HostSpec): string =>
  `credential.${httpsOrigin(host)}.helper`

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

async function values(key: string): Promise<string[]> {
  try {
    const out = await config(['--get-all', key])
    return out.replace(/\n$/, '').split('\n')
  } catch {
    return [] // the key is not set
  }
}

/** A copy run through npx lives in a cache that is cleared: not a path to give git. */
export function isStableInstall(bin: string): boolean {
  return !/[\\/]_npx[\\/]/.test(bin)
}

/** Register rness for `host`. False when it already was. */
export async function setupGit(
  node: string,
  bin: string,
  host: HostSpec = HOSTS.github
): Promise<boolean> {
  const key = keyOf(host)
  const ours = helperValue(node, bin)
  if ((await values(key)).includes(ours)) return false
  // A stale rness entry (another install path) goes first.
  await removeGitSetup(host)
  await config(['--add', key, ''])
  await config(['--add', key, ours])
  return true
}

/**
 * Remove exactly what `setupGit` wrote: rness's entry and the empty one in
 * front of it. A helper someone else registered is left as it was. False
 * when there was nothing of rness's.
 */
export async function removeGitSetup(
  host: HostSpec = HOSTS.github
): Promise<boolean> {
  const key = keyOf(host)
  const current = await values(key)
  if (!current.some(isOurs)) return false
  const kept = current.filter(
    (value, i) =>
      !isOurs(value) && !(value === '' && isOurs(current[i + 1] ?? ''))
  )
  await config(['--unset-all', key])
  for (const value of kept) await config(['--add', key, value])
  return true
}
