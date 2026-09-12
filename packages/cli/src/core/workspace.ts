import { access } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import type { Workspace } from './types.ts'

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Walk up from `startDir`; the first directory holding `.rness/rness.json` is the root. */
export async function findWorkspace(startDir: string): Promise<Workspace> {
  let dir = resolve(startDir)
  const { root: fsRoot } = parse(dir)
  while (true) {
    if (await exists(join(dir, '.rness', 'rness.json'))) {
      return { root: dir, rnessDir: join(dir, '.rness') }
    }
    // Inside the context repository itself (a standalone checkout, CI): this
    // directory is `.rness/`, its parent is the workspace root.
    if (await exists(join(dir, 'rness.json'))) {
      return { root: dirname(dir), rnessDir: dir }
    }
    if (dir === fsRoot) break
    dir = dirname(dir)
  }
  throw new Error(`no rness workspace found above ${startDir}`)
}
