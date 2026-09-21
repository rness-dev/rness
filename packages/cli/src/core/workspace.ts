import { readdir } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'

import { exists } from './fs.ts'
import { isWorkspaceClone } from './manifest.ts'
import type { Workspace } from './types.ts'

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

/** The repositories cloned under `<root>/org`, by name (spec 0009 §3). */
export async function clonesIn(root: string): Promise<Set<string>> {
  try {
    const entries = await readdir(join(root, 'org'), { withFileTypes: true })
    return new Set(
      entries
        .filter((e) => e.isDirectory() && isWorkspaceClone(e.name))
        .map((e) => e.name)
    )
  } catch {
    return new Set()
  }
}
