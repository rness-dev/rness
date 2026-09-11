import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findWorkspace } from './workspace.ts'

export interface Delegate {
  /** Absolute path of the pinned copy's `dist/index.js`. */
  entry: string
  version: string
}

/**
 * The `@rness/cli` pinned in `<workspace>/.rness/package.json` (installed under
 * `.rness/node_modules`), when it exists and is not the running version. The
 * pinned copy is the only one that should ever act on a workspace.
 */
export async function findDelegate(cwd: string, ownVersion: string): Promise<Delegate | null> {
  let rnessDir: string
  try {
    rnessDir = (await findWorkspace(cwd)).rnessDir
  } catch {
    return null
  }
  const pkgDir = join(rnessDir, 'node_modules', '@rness', 'cli')
  let version: unknown
  try {
    version = (JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as { version?: unknown }).version
  } catch {
    return null
  }
  if (typeof version !== 'string' || version === ownVersion) return null
  return { entry: join(pkgDir, 'dist', 'index.js'), version }
}
