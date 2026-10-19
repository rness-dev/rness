import { readdir } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'

import { exists } from './fs.ts'
import { EXCLUDED_NAMES, contextRepo, isWorkspaceClone } from './manifest.ts'
import type { ProviderName, Workspace } from './types.ts'

/** Walk up from `startDir`: a directory holding `.rness/rness.json` is the root. Only when none exists anywhere above does a directory that itself holds `rness.json` count — a standalone checkout of the context repository (CI): that directory is `.rness/`, its parent the root. */
export async function findWorkspace(startDir: string): Promise<Workspace> {
  const start = resolve(startDir)
  const { root: fsRoot } = parse(start)
  const ancestors: string[] = []
  for (let dir = start; ; dir = dirname(dir)) {
    ancestors.push(dir)
    if (dir === fsRoot) break
  }
  for (const dir of ancestors) {
    if (await exists(join(dir, '.rness', 'rness.json')))
      return { root: dir, rnessDir: join(dir, '.rness') }
  }
  for (const dir of ancestors) {
    if (await exists(join(dir, 'rness.json')))
      return { root: dirname(dir), rnessDir: dir }
  }
  throw new Error(`no rness workspace found above ${startDir}`)
}

/**
 * The entry of `<root>/org` that holds repository `name`: the name itself,
 * else the one entry that differs from it only by case (`org/dApp` for
 * `dapp`), else null. Read with `readdir`, since `exists('org/dapp')` is
 * true for `org/dApp` where the file system ignores case (macOS, Windows)
 * and false on Linux. Two or more such entries, possible on Linux only, are
 * refused: which one is the clone is the user's call.
 */
export async function entryFor(
  root: string,
  name: string
): Promise<string | null> {
  let entries: string[]
  try {
    entries = await readdir(join(root, 'org'))
  } catch {
    return null
  }
  if (entries.includes(name)) return name
  const variants = entries.filter((e) => e.toLowerCase() === name).sort()
  if (variants.length > 1)
    throw new Error(
      `${variants.map((v) => `org/${v}`).join(' and ')} both differ from org/${name} only by case: keep one, then run rness add again`
    )
  return variants[0] ?? null
}

/**
 * The directories under `<root>/org`: the clones, by name (spec 0009 §3), and
 * the others, sorted, an excluded name left out: names `rness.json` cannot
 * hold (`org/dApp`, `org/-rf`), which `sync` names rather than skipping them
 * silently.
 */
export async function orgDirs(
  root: string,
  /** On GitLab, `org/rness` is the context project's name, left out as `.rness` is. */
  provider: ProviderName | null = null
): Promise<{ clones: Set<string>; unread: string[] }> {
  let dirs: string[]
  try {
    const entries = await readdir(join(root, 'org'), { withFileTypes: true })
    dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return { clones: new Set(), unread: [] }
  }
  return {
    clones: new Set(dirs.filter((d) => isWorkspaceClone(d, provider))),
    unread: dirs
      .filter(
        (d) =>
          !isWorkspaceClone(d, provider) &&
          !EXCLUDED_NAMES.has(d.toLowerCase()) &&
          d.toLowerCase() !== contextRepo(provider)
      )
      .sort(),
  }
}

/** The repositories cloned under `<root>/org`, by name (spec 0009 §3). */
export async function clonesIn(
  root: string,
  provider: ProviderName | null = null
): Promise<Set<string>> {
  return (await orgDirs(root, provider)).clones
}
