import { access } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import type { Workspace } from './types.ts'

async function exists(p: string): Promise<boolean> {
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
    if (dir === fsRoot) break
    dir = dirname(dir)
  }
  throw new Error(`no rness workspace found above ${startDir}`)
}
